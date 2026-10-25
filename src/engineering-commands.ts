import type { Command } from "commander";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import catalog from "./projects-contract.json" with { type: "json" };
import { makeClient, type CommandRuntime, type GlobalOptions } from "./commands.js";
import { PROJECT_OPERATIONS, readProjectPayload, validateProjectInput } from "./project-payload.js";
import { pageLimit, writeAgentResponse } from "./agent-command-helpers.js";
import { CliError, ExitCode } from "./errors.js";
import { waitProjectEvents } from "./project-events.js";
import { collectPackage, normalizePackagePath, sha256 } from "./package-files.js";
import { transferPackage } from "./package-commands.js";
import { writeJson } from "./output.js";
import type { InteractionResponse } from "./api-client.js";

type Options = GlobalOptions & {
  file?: string;
  stdin?: boolean;
  etag?: string;
  idempotencyKey?: string;
  correlationId?: string;
  timeout?: string;
  [key: string]: unknown;
};
type Field = { type?: string; minimum?: number; maximum?: number };
const definitions = catalog.schemas.$defs as unknown as Record<
  string,
  { properties: Record<string, Field> }
>;
const names: Record<string, string[]> = {
  revise: ["revision"],
  manifest_get: ["manifest"],
  revisions_list: ["revisions"],
  targets_list: ["resources", "list"],
  participant_set: ["participants", "set"],
  participant_remove: ["participants", "remove"],
  acceptance_request: ["request-review"],
  acceptance_get: ["acceptance", "get"],
  evidence_get: ["get"],
  evidence_update: ["reconcile"],
  evidence_archive: ["archive"],
  requirement_get: ["requirements", "get"],
  requirement_update: ["requirements", "update"],
  requirement_archive: ["requirements", "archive"],
  claim_get: ["claims", "get"],
  claim_update: ["claims", "update"],
  claim_archive: ["claims", "archive"],
  verification_request: ["request-verification"],
  verification_get: ["read-results"],
};

export function addEngineeringCommands(program: Command, runtime: CommandRuntime) {
  const families = new Map([
    [
      "project_review_session",
      program
        .command("review-session")
        .description("Compose immutable review manifests and request exact human Decisions."),
    ],
    [
      "codebase_review",
      program
        .command("source-snapshot")
        .description("Publish and inspect authorized exact source provenance."),
    ],
    [
      "project_evidence",
      program
        .command("evidence")
        .description("Caller reports and independent verification receipts remain distinct."),
    ],
  ]);
  for (const operation of PROJECT_OPERATIONS) {
    const root = families.get(operation.family);
    if (!root || operation.status !== "implemented") continue;
    const words = names[operation.action] ?? operation.action.split("_");
    let parent = root;
    for (const word of words.slice(0, -1))
      parent = parent.commands.find((command) => command.name() === word) ?? parent.command(word);
    const command = parent
      .command(words.at(-1)!)
      .description(`${operation.operationId}; scopes: ${operation.scopes.join(", ")}.`);
    if (operation.operationId === "getProjectReviewSession") command.alias("status");
    if (operation.operationId === "publishSourceSnapshot") command.alias("reference");
    const params = [...operation.path.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!);
    for (const param of params) command.argument(`<${param}>`);
    const properties = definitions[operation.inputSchema]!.properties;
    const fields = Object.keys(properties).filter((key) => !params.includes(key));
    const payload = operation.method !== "GET" && fields.length > 0;
    command.option("--correlation-id <id>", "Request correlation ID.");
    if (operation.ifMatch)
      command.requiredOption("--etag <etag>", "Exact strong ETag from the prior read.");
    if (operation.idempotencyKey)
      command.requiredOption("--idempotency-key <key>", "Reuse for an exact retry only.");
    if (payload)
      command
        .option("--file <path>", "JSON/core YAML request.")
        .option("--stdin", "Read request from standard input.");
    if (operation.method === "GET")
      for (const key of fields.filter((key) => key !== "workspaceId"))
        command.option(
          `--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} <value>`,
          `Server ${key} query${properties[key]!.type === "object" ? " as a JSON object" : ""}.`,
          key === "limit" ? "25" : undefined,
        );
    const event = ["activity", "feedback"].includes(operation.action);
    if (event)
      command.option(
        "--timeout <seconds>",
        "Bounded wait (1 to 3600 seconds); durable cursor is returned.",
      );
    command.action(async function (this: Command, ...args: unknown[]) {
      const options = this.optsWithGlobals<Options>();
      validateHeaders(options);
      const routeParams = Object.fromEntries(
        params.map((param, index) => [param, String(args[index])]),
      );
      const body = payload ? await readProjectPayload(runtime, options) : {};
      for (const key of params)
        if (Object.hasOwn(body, key))
          throw new CliError(`Pass ${key} only as the explicit identifier.`, ExitCode.Usage);
      const values: Record<string, unknown> = {};
      const query: Record<string, string | number | boolean> = {};
      if (operation.method === "GET") {
        for (const key of fields) {
          const raw = key === "workspaceId" ? options.workspace : options[key];
          if (raw === undefined) continue;
          const field = properties[key]!;
          const value = queryValue(key, String(raw), field);
          values[key] = value;
          query[key] =
            typeof value === "object"
              ? JSON.stringify(value)
              : (value as string | number | boolean);
        }
      } else if (fields.includes("workspaceId") && options.workspace) {
        if (body.workspaceId && body.workspaceId !== options.workspace)
          throw new CliError("Payload workspaceId differs from --workspace.", ExitCode.Safety);
        body.workspaceId = options.workspace;
      }
      validateProjectInput(operation.inputSchema, { ...body, ...values, ...routeParams });
      const client = await makeClient(runtime, options);
      const input = {
        params: routeParams,
        query,
        ...(operation.method !== "GET" ? { body } : {}),
        etag: options.etag,
        idempotencyKey: options.idempotencyKey,
        correlationId: options.correlationId,
        signal: runtime.signal,
      };
      try {
        let response;
        if (event) {
          const timeoutMs = options.timeout === undefined ? 0 : seconds(options.timeout);
          const controller = new AbortController();
          const interrupted = () => controller.abort();
          runtime.signal?.addEventListener("abort", interrupted, { once: true });
          if (runtime.signal?.aborted) controller.abort();
          process.once("SIGINT", interrupted);
          try {
            response = await waitProjectEvents(client, operation.operationId, input, {
              timeoutMs,
              signal: controller.signal,
              resyncOperationId: "getProjectReviewSession",
            });
          } finally {
            process.removeListener("SIGINT", interrupted);
            runtime.signal?.removeEventListener("abort", interrupted);
          }
        } else response = await client.projectOperation(operation.operationId, input);
        writeAgentResponse(
          runtime,
          options,
          reviewUrlResponse(
            response,
            client.baseUrl,
            operation.family,
            routeParams,
            options.workspace,
          ),
        );
      } catch (error) {
        if (
          error instanceof CliError &&
          (error.code === "capability_unsupported" ||
            (!error.code && error.message.includes("404")))
        )
          throw new CliError(
            "Server does not support this engineering capability; select a compatible endpoint.",
            ExitCode.Validation,
            { code: "capability_unsupported" },
          );
        throw error;
      }
    });
  }
  addResourceCommands(families.get("project_review_session")!, runtime);
  addSourceDirectoryCommand(families.get("codebase_review")!, runtime);
}

function validateHeaders(options: Options) {
  if (
    options.idempotencyKey &&
    /(?:comm_pat_|github_pat_|gh[pousr]_|npm_)[A-Za-z0-9_-]{12,}/u.test(options.idempotencyKey)
  )
    throw new CliError("Retry identities must not contain credentials.", ExitCode.Safety);
  if (options.etag && !/^"[^"\r\n]+"$/u.test(options.etag))
    throw new CliError("--etag must be an exact strong quoted ETag.", ExitCode.Usage);
  if (options.idempotencyKey && !/^[\x21-\x7e][\x20-\x7e]{0,199}$/u.test(options.idempotencyKey))
    throw new CliError(
      "--idempotency-key must contain 1 to 200 printable ASCII characters.",
      ExitCode.Usage,
    );
}
function seconds(value: string) {
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 3600)
    throw new CliError("--timeout must be 1 to 3600 seconds.", ExitCode.Usage);
  return Number(value) * 1000;
}
function queryValue(key: string, raw: string, field: Field): unknown {
  if (key === "limit") return pageLimit(raw, field.maximum);
  if (field.type === "integer") {
    if (
      !/^\d+$/u.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < (field.minimum ?? 0) ||
      Number(raw) > (field.maximum ?? Number.MAX_SAFE_INTEGER)
    )
      throw new CliError(`--${key} is outside the server integer bounds.`, ExitCode.Usage);
    return Number(raw);
  }
  if (field.type === "boolean") {
    if (!["true", "false"].includes(raw))
      throw new CliError(`--${key} must be true or false.`, ExitCode.Usage);
    return raw === "true";
  }
  if (field.type === "object") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new CliError(`--${key} must be a JSON object.`, ExitCode.Usage);
    }
  }
  return raw;
}

function addResourceCommands(root: Command, runtime: CommandRuntime) {
  const resources = root.commands.find((command) => command.name() === "resources")!;
  for (const action of ["link", "unlink"]) {
    resources
      .command(action)
      .argument("<sessionId>")
      .description(
        "Create an immutable manifest revision from one exact target; no source access is granted.",
      )
      .option("--file <path>", "Object containing exactly one exact target.")
      .option("--stdin", "Read target object from standard input.")
      .requiredOption("--etag <etag>", "Exact Session ETag.")
      .requiredOption("--idempotency-key <key>", "Exact retry identity.")
      .option("--correlation-id <id>", "Request correlation ID.")
      .action(async function (this: Command, sessionId: string) {
        const options = this.optsWithGlobals<Options>();
        validateHeaders(options);
        const payload = await readProjectPayload(runtime, options);
        if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "target"))
          throw new CliError(
            "Resource change requires exactly {target: <exact target>}.",
            ExitCode.Validation,
          );
        validateProjectInput("ExactTarget", payload.target);
        const client = await makeClient(runtime, options);
        const current = await client.projectOperation("getProjectReviewSession", {
          params: { sessionId },
        });
        if (current.etag !== options.etag)
          throw new CliError(
            "Session changed; refetch and explicitly reconcile the target manifest.",
            ExitCode.StaleRevision,
            { code: "precondition_failed" },
          );
        const session = current.body.data as {
          manifest: { targets: Record<string, unknown>[] };
          manifestSha256: string;
        };
        if (
          createHash("sha256").update(canonicalJson(session.manifest)).digest("hex") !==
          session.manifestSha256
        )
          throw new CliError(
            "The complete Session manifest is unavailable. Use an explicit revision request after reconciling current resource access.",
            ExitCode.Safety,
            { code: "source_access_revoked" },
          );
        const target = payload.target as Record<string, unknown>;
        const identity = (value: Record<string, unknown>) => {
          const resource = value.resource as { type: string; id: string };
          return JSON.stringify([resource.type, resource.id, value.revisionId, value.sha256]);
        };
        const exists = session.manifest.targets.some(
          (value) => identity(value) === identity(target),
        );
        if ((action === "link" && exists) || (action === "unlink" && !exists))
          throw new CliError(
            `Exact target is ${exists ? "already linked" : "not linked"}.`,
            ExitCode.Validation,
          );
        const targets =
          action === "link"
            ? [...session.manifest.targets, target]
            : session.manifest.targets.filter((value) => identity(value) !== identity(target));
        validateProjectInput("reviseProjectReviewSessionInput", { sessionId, targets });
        const response = await client.projectOperation("reviseProjectReviewSession", {
          params: { sessionId },
          body: { targets },
          etag: options.etag,
          idempotencyKey: options.idempotencyKey,
          correlationId: options.correlationId,
        });
        writeAgentResponse(
          runtime,
          options,
          reviewUrlResponse(
            response,
            client.baseUrl,
            "project_review_session",
            { sessionId },
            options.workspace,
          ),
        );
      });
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

type SourceMetadata = {
  formatVersion: 1;
  files: { path: string; sha256: string }[];
  pending?: { intent: string; key: string; uploadId?: string };
  snapshotId?: string;
};
function addSourceDirectoryCommand(root: Command, runtime: CommandRuntime) {
  root
    .command("publish-directory")
    .argument("<directory>")
    .description(
      "Freeze bounded local source bytes, resume their transfer, and publish an uploaded-provenance snapshot.",
    )
    .option(
      "--file <path>",
      "Source request JSON/YAML with uploaded reference and repository Resource.",
    )
    .option("--stdin", "Read the source request object.")
    .requiredOption("--idempotency-key <key>", "Reuse for exact retries only.")
    .option("--correlation-id <id>", "Request correlation ID.")
    .option("--dry-run", "Collect and validate without upload or local metadata writes.")
    .option("--no-open", "Keep publication non-interactive.")
    .action(async function (this: Command, directory: string) {
      const options = this.optsWithGlobals<Options>();
      validateHeaders(options);
      const body = await readProjectPayload(runtime, options);
      if (body.workspaceId && options.workspace && body.workspaceId !== options.workspace)
        throw new CliError("Payload workspaceId differs from --workspace.", ExitCode.Safety);
      if (options.workspace) body.workspaceId = options.workspace;
      const reference = body.reference as Record<string, unknown> | undefined;
      if (!reference || reference.provider !== "uploaded" || reference.uploadId !== undefined)
        throw new CliError(
          "Local publication requires an uploaded reference without an existing uploadId.",
          ExitCode.Validation,
        );
      validateProjectInput("publishSourceSnapshotInput", body);
      const collected = await collectPackage(path.resolve(runtime.cwd, directory), "source");
      const files = collected.files.map((file) => ({ path: file.path, sha256: file.sha256 }));
      const intent = sha256(
        canonicalJson({ body, files, bytes: collected.bytes, sha256: collected.sha256 }),
      );
      if (options.dryRun) {
        if (!options.quiet)
          writeJson(runtime.stdout, {
            ok: true,
            data: {
              dryRun: true,
              provenance: "uploaded",
              files,
              bytes: collected.bytes,
              sha256: collected.sha256,
            },
          });
        return;
      }
      const directoryPath = path.join(collected.root, ".commentary");
      const directoryInfo = await lstat(directoryPath).catch(() => null);
      if (directoryInfo && (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()))
        throw new CliError(
          "Source metadata directory must be a regular directory.",
          ExitCode.Safety,
        );
      await mkdir(directoryPath, { recursive: true });
      const confirmedDirectory = await lstat(directoryPath);
      if (
        !confirmedDirectory.isDirectory() ||
        confirmedDirectory.isSymbolicLink() ||
        path.relative(collected.root, await realpath(directoryPath)) !== ".commentary"
      )
        throw new CliError(
          "Source metadata directory changed; retry after checking its location.",
          ExitCode.Safety,
        );
      const filename = path.join(directoryPath, "source-snapshot.json");
      const lock = `${filename}.lock`;
      try {
        await writeFile(lock, "source publication\n", { flag: "wx", mode: 0o600 });
      } catch {
        throw new CliError(
          "Another source publication holds the metadata lock. Inspect a stale lock before removing it.",
          ExitCode.StaleRevision,
        );
      }
      try {
        const info = await lstat(filename).catch(() => null);
        let metadata: SourceMetadata = { formatVersion: 1, files: [] };
        if (info) {
          if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
            throw new CliError("Invalid source metadata file.", ExitCode.Safety);
          try {
            const parsed: unknown = JSON.parse(await readFile(filename, "utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw new CliError("Invalid source metadata contract.", ExitCode.Safety);
            metadata = parsed as SourceMetadata;
          } catch {
            throw new CliError("Invalid source metadata JSON.", ExitCode.Validation);
          }
          if (
            metadata.formatVersion !== 1 ||
            !Array.isArray(metadata.files) ||
            metadata.files.length > 5000 ||
            Object.keys(metadata).some(
              (key) => !["formatVersion", "files", "pending", "snapshotId"].includes(key),
            ) ||
            metadata.files.some(
              (file) =>
                !file ||
                Object.keys(file).some((key) => !["path", "sha256"].includes(key)) ||
                typeof file.path !== "string" ||
                normalizePackagePath(file.path) !== file.path ||
                !/^[a-f0-9]{64}$/u.test(file.sha256),
            ) ||
            (metadata.snapshotId !== undefined &&
              (typeof metadata.snapshotId !== "string" ||
                !/^[\w:.-]{1,512}$/u.test(metadata.snapshotId))) ||
            (metadata.pending !== undefined &&
              (!metadata.pending ||
                typeof metadata.pending !== "object" ||
                Array.isArray(metadata.pending) ||
                Object.keys(metadata.pending).some(
                  (key) => !["intent", "key", "uploadId"].includes(key),
                ) ||
                !/^[a-f0-9]{64}$/u.test(metadata.pending.intent) ||
                typeof metadata.pending.key !== "string" ||
                !/^[\x21-\x7e][\x20-\x7e]{0,199}$/u.test(metadata.pending.key) ||
                /(?:comm_pat_|github_pat_|gh[pousr]_|npm_)[A-Za-z0-9_-]{12,}/u.test(
                  metadata.pending.key,
                ) ||
                (metadata.pending.uploadId !== undefined &&
                  (typeof metadata.pending.uploadId !== "string" ||
                    !/^[\w:.-]{1,512}$/u.test(metadata.pending.uploadId)))))
          )
            throw new CliError("Invalid source metadata contract.", ExitCode.Safety);
        }
        if (
          metadata.pending &&
          (metadata.pending.intent !== intent || metadata.pending.key !== options.idempotencyKey)
        )
          throw new CliError(
            "Source transfer changed; preserve the pending state and explicitly retry the original input/key.",
            ExitCode.StaleRevision,
          );
        metadata.pending ??= { intent, key: options.idempotencyKey! };
        const save = async () => {
          const temporary = `${filename}.${randomUUID()}.tmp`;
          await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
            flag: "wx",
            mode: 0o600,
          });
          await rename(temporary, filename);
        };
        await save();
        const client = await makeClient(runtime, options);
        reference.uploadId = await transferPackage(
          client,
          collected,
          String(body.workspaceId),
          options.idempotencyKey!,
          metadata.pending,
          save,
          undefined,
          runtime.signal,
        );
        const response = await client.projectOperation("publishSourceSnapshot", {
          body,
          idempotencyKey: options.idempotencyKey,
          correlationId: options.correlationId,
          signal: runtime.signal,
        });
        const snapshot = response.body.data as { id: string };
        if (typeof snapshot.id !== "string" || !/^[\w:.-]{1,512}$/u.test(snapshot.id))
          throw new CliError(
            "Server returned an invalid snapshot identity; transfer state was preserved.",
            ExitCode.Api,
          );
        metadata = { formatVersion: 1, snapshotId: snapshot.id, files };
        await save();
        writeAgentResponse(
          runtime,
          options,
          reviewUrlResponse(
            response,
            client.baseUrl,
            "codebase_review",
            { snapshotId: snapshot.id },
            options.workspace,
          ),
        );
      } finally {
        await unlink(lock);
      }
    });
}

function reviewUrlResponse(
  response: InteractionResponse<Record<string, unknown>>,
  baseUrl: string,
  family: string,
  params: Record<string, string>,
  workspace?: string,
) {
  const withUrl = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (typeof record.canonicalUrl === "string") return record;
    let relative: string | undefined;
    if (family === "project_review_session") {
      const manifest = record.manifest as { revisionId?: unknown } | undefined;
      const id =
        params.sessionId ??
        (manifest && typeof record.id === "string"
          ? record.id
          : typeof record.sessionId === "string"
            ? record.sessionId
            : undefined);
      if (id) {
        const revision = manifest?.revisionId ?? (record.sessionId ? record.revisionId : undefined);
        relative = `/review/project/${encodeURIComponent(id)}${typeof revision === "string" ? `?${new URLSearchParams({ sessionRevision: revision })}` : ""}`;
      }
    } else if (family === "codebase_review") {
      const id =
        params.snapshotId ??
        (typeof record.id === "string" && (record.reference || record.provenance)
          ? record.id
          : undefined);
      if (id) relative = `/review/source/${encodeURIComponent(id)}`;
    } else if (family === "project_evidence") {
      const context = record.context as { type?: string; id?: string } | undefined;
      if (typeof context?.id === "string") {
        if (context.type === "project_review_session")
          relative = `/review/project/${encodeURIComponent(context.id)}`;
        if (context.type === "project" && workspace)
          relative = `/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(context.id)}/evidence`;
      }
    }
    return {
      ...record,
      ...(Array.isArray(record.items) ? { items: record.items.map(withUrl) } : {}),
      ...(relative ? { canonicalUrl: new URL(relative, baseUrl).href } : {}),
    };
  };
  return { ...response, body: { ...response.body, data: withUrl(response.body.data) } };
}
