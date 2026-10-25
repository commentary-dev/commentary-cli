import { mkdir, readFile, writeFile, rename, unlink, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import chokidar from "chokidar";
import open from "open";
import type { Command } from "commander";
import { makeClient, type CommandRuntime, type GlobalOptions } from "./commands.js";
import type { CommentaryApiClient, InteractionResponse } from "./api-client.js";
import { readProjectPayload, validateProjectInput } from "./project-payload.js";
import {
  collectPackage,
  PACKAGE_LIMITS,
  sha256,
  normalizePackagePath,
  rejectPackageCredentials,
} from "./package-files.js";
import { CliError, ExitCode } from "./errors.js";
import { writeAgentResponse } from "./agent-command-helpers.js";
import { writeJson, writeText } from "./output.js";
import { waitProjectEvents } from "./project-events.js";
import { addPackageApiCommands } from "./package-api-commands.js";

type Options = GlobalOptions & {
  manifest?: string | undefined;
  package?: string | undefined;
  etag?: string | undefined;
  idempotencyKey?: string | undefined;
  dryRun?: boolean | undefined;
  open?: boolean | undefined;
  timeout?: string | undefined;
  cursor?: string | undefined;
};
type Metadata = {
  formatVersion: 1;
  packageId?: string;
  revisionId?: string;
  etag?: string | undefined;
  files: { path: string; sha256: string }[];
  pending?: { intent: string; key: string; uploadId?: string };
};
function data(response: { body: Record<string, unknown> }) {
  return response.body.data as Record<string, unknown>;
}
function withPackageUrl(
  response: InteractionResponse<Record<string, unknown>>,
  baseUrl: string,
  packageId: string,
) {
  const value = data(response);
  const revision =
    typeof value.revisionId === "string"
      ? value.revisionId
      : typeof value.backingDraftRevisionId === "string"
        ? value.backingDraftRevisionId
        : undefined;
  const url = new URL(`/review/package/${encodeURIComponent(packageId)}`, baseUrl);
  if (revision) url.searchParams.set("version", `draft-id:${revision}`);
  return { ...response, body: { ...response.body, canonicalReviewUrl: url.href } };
}
async function metadataFile(root: string) {
  const directory = path.join(root, ".commentary");
  const info = await lstat(directory).catch(() => null);
  if (info?.isSymbolicLink() || (info && !info.isDirectory()))
    throw new CliError("Package metadata directory must be a regular directory.", ExitCode.Safety);
  await mkdir(directory, { recursive: true });
  return path.join(directory, "package.json");
}
async function readMetadata(file: string): Promise<Metadata> {
  const info = await lstat(file).catch(() => null);
  if (!info) return { formatVersion: 1, files: [] };
  if (!info.isFile() || info.size > 2 * 1024 * 1024)
    throw new CliError("Invalid package metadata file.", ExitCode.Safety);
  let value: Metadata;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as Metadata;
  } catch {
    throw new CliError("Invalid package metadata JSON.", ExitCode.Validation);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.formatVersion !== 1 ||
    !Array.isArray(value.files) ||
    value.files.length > PACKAGE_LIMITS.files ||
    Object.keys(value).some(
      (key) =>
        !["formatVersion", "packageId", "revisionId", "etag", "files", "pending"].includes(key),
    )
  )
    throw new CliError("Invalid package metadata contract.", ExitCode.Safety);
  for (const file of value.files)
    if (
      Object.keys(file).some((key) => !["path", "sha256"].includes(key)) ||
      normalizePackagePath(file.path) !== file.path ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new CliError("Invalid acknowledged package hash.", ExitCode.Safety);
  for (const key of ["packageId", "revisionId", "etag"] as const)
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" || value[key]!.length > 512 || /[\r\n]/u.test(value[key]!))
    )
      throw new CliError("Invalid package identifier.", ExitCode.Safety);
  if (
    value.pending !== undefined &&
    (!value.pending ||
      typeof value.pending !== "object" ||
      Array.isArray(value.pending) ||
      Object.keys(value.pending).some((key) => !["intent", "key", "uploadId"].includes(key)) ||
      !/^[a-f0-9]{64}$/u.test(value.pending.intent) ||
      typeof value.pending.key !== "string" ||
      value.pending.key.length > 200 ||
      (value.pending.uploadId !== undefined &&
        (typeof value.pending.uploadId !== "string" || value.pending.uploadId.length > 512)))
  )
    throw new CliError("Invalid pending transfer metadata.", ExitCode.Safety);
  return value;
}
async function saveMetadata(file: string, metadata: Metadata) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}
export async function transferPackage(
  client: CommentaryApiClient,
  collected: Awaited<ReturnType<typeof collectPackage>>,
  workspaceId: string,
  key: string,
  pending: { uploadId?: string },
  save: () => Promise<void>,
  packageId?: string,
  signal?: AbortSignal,
) {
  const request = (operationId: string, params: Record<string, string>, body?: unknown) =>
    client.projectOperation(operationId, {
      params,
      ...(body !== undefined ? { body } : {}),
      idempotencyKey: sha256(`${key}:${operationId}`),
      signal,
    });
  let status: Record<string, unknown>;
  if (pending.uploadId)
    status = data(await request("getPackageUpload", { uploadId: pending.uploadId }));
  else {
    status = data(
      await request(
        "preparePackageUpload",
        {},
        {
          workspaceId,
          ...(packageId ? { packageId } : {}),
          bytes: collected.bytes,
          sha256: collected.sha256,
          manifest: {
            files: collected.files.map(({ path, bytes, sha256, mime }) => ({
              path,
              bytes,
              sha256,
              mime,
            })),
          },
        },
      ),
    );
    if (typeof status.id !== "string")
      throw new CliError("Server returned an invalid upload identity.", ExitCode.Api);
    pending.uploadId = status.id;
    await save();
  }
  const uploadId = pending.uploadId!;
  if (status.sha256 !== collected.sha256 || status.bytes !== collected.bytes)
    throw new CliError("Resumable upload does not match this directory.", ExitCode.StaleRevision);
  if (status.state === "completed" || status.state === "complete") return uploadId;
  if (status.state !== "uploading")
    throw new CliError(
      `Transfer is ${String(status.state)}; resumable state was preserved.`,
      ExitCode.StaleRevision,
    );
  // Only one bounded chunk is duplicated in memory; source bytes were frozen during collection.
  const received = new Map(
    ((status.receivedChunks ?? []) as { offset: number; bytes: number; sha256: string }[]).map(
      (chunk) => [chunk.offset, chunk],
    ),
  );
  let offset = 0;
  let pieces: Buffer[] = [];
  let buffered = 0;
  async function flush() {
    const content = Buffer.concat(pieces, buffered);
    const digest = sha256(content);
    const existing = received.get(offset);
    if (existing && (existing.bytes !== content.length || existing.sha256 !== digest))
      throw new CliError("Received chunk differs from frozen input.", ExitCode.StaleRevision);
    if (!existing)
      await request(
        "transferPackageChunk",
        { uploadId },
        { offset, sha256: digest, contentBase64: content.toString("base64") },
      );
    offset += content.length;
    pieces = [];
    buffered = 0;
  }
  for (const file of collected.files) {
    let start = 0;
    while (start < file.content.length) {
      const count = Math.min(PACKAGE_LIMITS.chunk - buffered, file.content.length - start);
      pieces.push(file.content.subarray(start, start + count));
      buffered += count;
      start += count;
      if (buffered === PACKAGE_LIMITS.chunk) await flush();
    }
  }
  if (buffered) await flush();
  await request("finalizePackageUpload", { uploadId }, {});
  return uploadId;
}
async function publish(
  runtime: CommandRuntime,
  options: Options,
  directory: string,
  sync: boolean,
) {
  const collected = await collectPackage(path.resolve(runtime.cwd, directory));
  const embedded = collected.files.find((file) =>
    /^commentary\.package\.(?:json|yaml)$/u.test(file.path),
  );
  const manifest =
    options.manifest || embedded
      ? await readProjectPayload(runtime, {
          file: options.manifest ?? path.join(collected.root, embedded!.path),
        })
      : undefined;
  if (manifest) {
    validateProjectInput("publishReviewPackageInput", {
      workspaceId: options.workspace ?? "dry-run",
      manifest,
    });
    if (manifest.trustTier && manifest.trustTier !== "static")
      throw new CliError(
        "Executable bundles use the isolated renderer publication contract.",
        ExitCode.Safety,
      );
    for (const descriptor of [
      ...((manifest.pages ?? []) as Record<string, unknown>[]),
      ...((manifest.assets ?? []) as Record<string, unknown>[]),
    ]) {
      const file = collected.files.find((file) => file.path === descriptor.path);
      if (
        !file ||
        ["bytes", "sha256", "mime"].some(
          (key) =>
            descriptor[key] !== undefined &&
            descriptor[key] !== file[key as "bytes" | "sha256" | "mime"],
        )
      )
        throw new CliError("Manifest descriptors must match collected files.", ExitCode.Validation);
    }
  }
  if (options.dryRun) {
    writeJson(runtime.stdout, {
      ok: true,
      dryRun: true,
      files: collected.files.map(({ path, bytes, sha256, mime }) => ({
        path,
        bytes,
        sha256,
        mime,
      })),
      bytes: collected.bytes,
      sha256: collected.sha256,
      ...(manifest ? { manifest } : {}),
    });
    return;
  }
  if (!options.workspace)
    throw new CliError("Pass an explicit --workspace for package publication.", ExitCode.Usage);
  const file = await metadataFile(collected.root);
  const lock = `${file}.lock`;
  try {
    await writeFile(lock, "package publication\n", { flag: "wx", mode: 0o600 });
  } catch {
    throw new CliError(
      "Another package publication holds the metadata lock. Inspect a stale lock before removing it.",
      ExitCode.StaleRevision,
    );
  }
  try {
    const metadata = await readMetadata(file);
    const packageId = options.package ?? (sync ? metadata.packageId : undefined);
    if (sync && !packageId)
      throw new CliError(
        "No package identity; publish the directory first or pass --package.",
        ExitCode.Usage,
      );
    if (metadata.packageId && packageId && metadata.packageId !== packageId)
      throw new CliError("Explicit package differs from acknowledged metadata.", ExitCode.Safety);
    const etag = options.etag ?? (sync ? metadata.etag : undefined);
    if (sync && (!etag || !/^"[^"\r\n]+"$/u.test(etag)))
      throw new CliError("Sync requires the exact previous package ETag.", ExitCode.Usage);
    const deletePaths = sync
      ? metadata.files
          .filter((old) => !collected.files.some((file) => file.path === old.path))
          .map((file) => file.path)
      : [];
    const intent = sha256(
      JSON.stringify({
        digest: collected.sha256,
        descriptors: collected.files.map(({ path, bytes, sha256, mime }) => ({
          path,
          bytes,
          sha256,
          mime,
        })),
        manifest,
        packageId,
        etag,
        deletePaths,
        workspaceId: options.workspace,
      }),
    );
    if (
      sync &&
      !metadata.pending &&
      metadata.files.length === collected.files.length &&
      metadata.files.every((old) =>
        collected.files.some((file) => old.path === file.path && old.sha256 === file.sha256),
      ) &&
      !manifest
    ) {
      writeAgentResponse(
        runtime,
        options,
        await (
          await makeClient(runtime, options)
        ).projectOperation("getReviewPackage", {
          params: { packageId: packageId! },
          signal: runtime.signal,
        }),
      );
      return;
    }
    const key =
      options.idempotencyKey ?? metadata.pending?.key ?? (sync ? randomUUID() : undefined);
    if (key) rejectPackageCredentials(key, "publication retry key");
    if (!key || !/^[\x21-\x7e][\x20-\x7e]{0,199}$/u.test(key))
      throw new CliError("Pass --idempotency-key; retain it for an exact retry.", ExitCode.Usage);
    if (metadata.pending && (metadata.pending.intent !== intent || metadata.pending.key !== key))
      throw new CliError(
        "Pending publication differs. Restore its directory/manifest and retry before beginning a new intent.",
        ExitCode.StaleRevision,
      );
    metadata.pending ??= { intent, key };
    await saveMetadata(file, metadata);
    const client = await makeClient(runtime, options);
    const uploadId = await transferPackage(
      client,
      collected,
      options.workspace,
      key,
      metadata.pending,
      () => saveMetadata(file, metadata),
      packageId,
      runtime.signal,
    );
    const response = await client.projectOperation(
      sync ? "publishPackageRevision" : "publishReviewPackage",
      {
        params: packageId ? { packageId } : {},
        body: {
          uploadId,
          ...(manifest ? { manifest } : {}),
          ...(sync ? { deletePaths } : { workspaceId: options.workspace }),
        },
        etag,
        idempotencyKey: key,
        signal: runtime.signal,
      },
    );
    const published = data(response);
    if (
      typeof published.id !== "string" ||
      !published.id ||
      typeof published.revisionId !== "string" ||
      !published.revisionId ||
      !response.etag
    )
      throw new CliError(
        "Publication receipt lacks exact package/revision identity or ETag; retry safely.",
        ExitCode.Api,
      );
    await saveMetadata(file, {
      formatVersion: 1,
      packageId: published.id,
      ...(typeof published.revisionId === "string" ? { revisionId: published.revisionId } : {}),
      etag: response.etag,
      files: collected.files.map(({ path, sha256 }) => ({ path, sha256 })),
    });
    writeAgentResponse(runtime, options, {
      ...response,
      body: {
        ...response.body,
        canonicalReviewUrl: new URL(
          `/review/package/${encodeURIComponent(published.id)}?version=${encodeURIComponent(`draft-id:${String(published.revisionId)}`)}`,
          client.baseUrl,
        ).href,
      },
    });
    if (options.open !== false && runtime.isTty && !options.json) {
      const url = new URL(`/review/package/${encodeURIComponent(published.id)}`, client.baseUrl);
      if (url.origin === new URL(client.baseUrl).origin) await open(url.href);
    }
  } finally {
    await unlink(lock);
  }
}
export function addPackageCommands(program: Command, runtime: CommandRuntime) {
  const root = program
    .command("package")
    .description("Publish and review complete static walkthrough directories.");
  for (const name of ["validate", "publish", "sync", "watch"]) {
    root
      .command(name)
      .argument("<directory>")
      .option("--manifest <file>", "Explicit portable manifest JSON/YAML.")
      .option("--package <id>", "Explicit package identity for sync.")
      .option("--etag <etag>", "Exact acknowledged package ETag.")
      .option("--idempotency-key <key>", "Stable exact publication retry key.")
      .option("--dry-run", "Validate and hash only.")
      .option("--no-open", "Do not open a browser.")
      .action(async function (this: Command, directory: string) {
        const options = this.optsWithGlobals<Options>();
        if (name !== "watch")
          return publish(
            runtime,
            { ...options, dryRun: name === "validate" || options.dryRun },
            directory,
            name === "sync",
          );
        if (options.dryRun) return publish(runtime, options, directory, true);
        const controller = new AbortController();
        const interrupted = () => controller.abort();
        runtime.signal?.addEventListener("abort", interrupted, { once: true });
        if (runtime.signal?.aborted) controller.abort();
        process.once("SIGINT", interrupted);
        const watchRuntime = { ...runtime, signal: controller.signal };
        const watcher = chokidar.watch(path.resolve(runtime.cwd, directory), {
          ignoreInitial: true,
          followSymlinks: false,
          ignored: (file: string) =>
            /(?:^|[\\/])(?:\.commentary|\.git|node_modules)(?:[\\/]|$)/u.test(file),
        });
        let dirty = true;
        let changedAt = Date.now();
        watcher.on("all", () => {
          dirty = true;
          changedAt = Date.now();
        });
        try {
          while (!controller.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (!dirty || Date.now() - changedAt < 250) continue;
            dirty = false;
            try {
              await publish(
                watchRuntime,
                { ...options, etag: undefined, idempotencyKey: undefined, open: false },
                directory,
                true,
              );
            } catch (error) {
              if (controller.signal.aborted) break;
              writeText(runtime.stderr, error instanceof Error ? error.message : String(error));
            }
          }
          throw new CliError(
            "Package watch interrupted; acknowledged state retained.",
            ExitCode.Interrupted,
          );
        } finally {
          await watcher.close();
          process.removeListener("SIGINT", interrupted);
          runtime.signal?.removeEventListener("abort", interrupted);
        }
      });
  }
  for (const [name, operation, args] of [
    ["get", "getReviewPackage", ["packageId"]],
    ["revisions", "listPackageRevisions", ["packageId"]],
    ["manifest", "getPackageManifest", ["packageId", "revisionId"]],
    ["comments", "listPackageComments", ["packageId"]],
    ["activity", "listPackageActivity", ["packageId"]],
    ["feedback", "listPackageFeedback", ["packageId"]],
  ] as const) {
    const command = root
      .command(name)
      .option("--revision-id <id>", "Exact package comment revision.")
      .option("--path <path>", "Exact package semantic page for comments.")
      .option("--limit <count>", "Bounded page size.", "25")
      .option("--cursor <cursor>", "Continuation.")
      .option("--timeout <milliseconds>", "Total bounded event wait budget.");
    for (const key of args) command.argument(`<${key}>`);
    command.action(async function (this: Command, ...values: string[]) {
      const options = this.optsWithGlobals<
        Options & { limit: string; revisionId?: string; path?: string }
      >();
      const params = Object.fromEntries(args.map((key, index) => [key, values[index]!]));
      const query = {
        ...(name === "get" || name === "manifest"
          ? {}
          : {
              limit: Number(options.limit),
              ...(options.cursor ? { cursor: options.cursor } : {}),
            }),
        ...(name === "comments"
          ? {
              path: options.path,
              ...(options.revisionId ? { revisionId: options.revisionId } : {}),
            }
          : {}),
      };
      validateProjectInput(`${operation}Input`, { ...params, ...query });
      const client = await makeClient(runtime, options);
      const response =
        options.timeout && ["activity", "feedback"].includes(name)
          ? await waitProjectEvents(
              client,
              operation,
              { params, query },
              {
                timeoutMs: Number(options.timeout),
                signal: runtime.signal,
                resyncOperationId: "getReviewPackage",
              },
            )
          : await client.projectOperation(operation, { params, query, signal: runtime.signal });
      writeAgentResponse(
        runtime,
        options,
        withPackageUrl(response, client.baseUrl, params.packageId!),
      );
    });
  }
  root
    .command("upload")
    .command("status")
    .argument("<uploadId>")
    .action(async function (this: Command, uploadId: string) {
      const options = this.optsWithGlobals<Options>();
      writeAgentResponse(
        runtime,
        options,
        await (
          await makeClient(runtime, options)
        ).projectOperation("getPackageUpload", { params: { uploadId }, signal: runtime.signal }),
      );
    });
  addPackageApiCommands(root, runtime);
}
