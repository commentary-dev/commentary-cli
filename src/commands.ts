import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import open from "open";
import { CommentaryApiClient } from "./api-client.js";
import { CLIENT_ID, CLIENT_NAME, REQUIRED_SCOPES, SESSION_FILE } from "./constants.js";
import { normalizeBaseUrl, removeStoredToken, resolveToken, setStoredToken } from "./config.js";
import { normalizeReviewPath } from "./content.js";
import { CliError, ExitCode } from "./errors.js";
import { collectFiles, readTrackedFiles, toTrackedFiles } from "./files.js";
import { contentHash } from "./hash.js";
import {
  formatCommentsMarkdown,
  formatCommentsText,
  formatReviewCreated,
  formatRevision,
  formatWaitCommentMarkdown,
  formatWaitCommentText,
  publicSessionJson,
  writeJson,
  writeText,
  type Writer,
} from "./output.js";
import {
  findSessionFile,
  loadSessionMetadata,
  saveSessionMetadata,
  sessionRoot,
} from "./session.js";
import type { CollectedFile } from "./files.js";
import type {
  DraftReviewLiveEvent,
  DraftReviewRevision,
  RequestedContentType,
  SessionMetadata,
  TrackedFile,
} from "./types.js";

export type CommandRuntime = {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  fetchImpl?: typeof fetch | undefined;
  isTty?: boolean | undefined;
};

export type GlobalOptions = {
  baseUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
  verbose?: boolean | undefined;
  quiet?: boolean | undefined;
  noColor?: boolean | undefined;
  sessionFile?: string | undefined;
};

function nowIso() {
  return new Date().toISOString();
}

async function makeClient(runtime: CommandRuntime, options: GlobalOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token = await resolveToken({ baseUrl, token: options.token });
  return new CommentaryApiClient({ baseUrl, token, fetchImpl: runtime.fetchImpl });
}

function apiFilesFromRevision(revision: DraftReviewRevision | null) {
  return revision?.files.map((file) => ({
    fileId: file.fileId,
    path: file.path,
    contentHash: file.contentHash,
    sizeBytes: file.sizeBytes,
    contentType: file.contentType,
  }));
}

function changedFiles(current: CollectedFile[], tracked: TrackedFile[]) {
  const trackedByPath = new Map(tracked.map((file) => [file.path, file]));
  return current.filter((file) => {
    const previous = trackedByPath.get(file.path);
    return (
      !previous ||
      previous.contentHash !== file.contentHash ||
      previous.contentType !== file.contentType
    );
  });
}

async function loadSession(runtime: CommandRuntime, options: GlobalOptions) {
  return loadSessionMetadata(runtime.cwd, options.sessionFile);
}

function shouldOpen(runtime: CommandRuntime, noOpen?: boolean) {
  return !noOpen && runtime.isTty !== false && !process.env.CI;
}

function placeholderSessionMetadata(input: {
  sessionId: string;
  baseUrl: string;
}): SessionMetadata {
  return {
    version: 1,
    reviewSessionId: input.sessionId,
    reviewUrl: `${input.baseUrl}/review/draft/${encodeURIComponent(input.sessionId)}`,
    baseUrl: input.baseUrl,
    rootPath: ".",
    trackedFiles: [],
    source: [],
    createdAt: "",
    lastSyncedAt: "",
    lastKnownRevision: null,
  };
}

async function openOrPrint(runtime: CommandRuntime, url: string, noOpen?: boolean) {
  if (!shouldOpen(runtime, noOpen)) {
    writeText(runtime.stdout, url);
    return;
  }
  try {
    await open(url);
  } catch {
    writeText(runtime.stdout, url);
  }
}

function parseDurationMs(value: string | undefined, defaultMs: number) {
  const raw = value?.trim();
  if (!raw) {
    return defaultMs;
  }
  if (raw === "0") {
    return 0;
  }
  const match = raw.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    throw new CliError(
      "Duration must be a number with optional ms, s, m, or h suffix.",
      ExitCode.Usage,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "ms";
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return amount * multiplier;
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function payloadString(event: DraftReviewLiveEvent, key: string) {
  const value = event.payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveAgentAlias(alias?: string | undefined) {
  const value = alias?.trim() || process.env.COMMENTARY_AGENT_ALIAS?.trim();
  return value || undefined;
}

function isWaitCommentMatch(input: {
  event: DraftReviewLiveEvent;
  includeReplies?: boolean | undefined;
  filePath?: string | undefined;
}) {
  const allowed =
    input.event.type === "comment.created" ||
    (input.includeReplies !== false && input.event.type === "reply.created");
  if (!allowed) {
    return false;
  }
  if (!input.filePath) {
    return true;
  }
  return (
    (input.event.thread?.filePath ?? payloadString(input.event, "filePath")) === input.filePath
  );
}

export async function loginCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & { token?: string | undefined; noOpen?: boolean | undefined },
) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (options.token?.trim()) {
    await setStoredToken(baseUrl, { accessToken: options.token.trim() });
    if (options.json) {
      writeJson(runtime.stdout, { ok: true, baseUrl });
    } else {
      writeText(runtime.stdout, `Stored Commentary token for ${baseUrl}.`);
    }
    return;
  }

  const client = new CommentaryApiClient({ baseUrl, fetchImpl: runtime.fetchImpl });
  const resource = `${baseUrl}/api`;
  const device = await client.requestDeviceCode({
    clientId: CLIENT_ID,
    clientName: CLIENT_NAME,
    scope: REQUIRED_SCOPES.join(" "),
    resource,
  });
  if (options.json) {
    writeJson(runtime.stdout, {
      verificationUri: device.verification_uri,
      verificationUriComplete: device.verification_uri_complete,
      userCode: device.user_code,
      expiresIn: device.expires_in,
    });
  } else {
    writeText(
      runtime.stdout,
      [
        "Connect Commentary",
        "",
        `Open: ${device.verification_uri_complete}`,
        `Code: ${device.user_code}`,
        "",
        "Waiting for approval...",
      ].join("\n"),
    );
  }
  if (shouldOpen(runtime, options.noOpen)) {
    await open(device.verification_uri_complete).catch(() => undefined);
  }

  const startedAt = Date.now();
  const intervalMs = Math.max(1, device.interval) * 1000;
  while (Date.now() - startedAt < device.expires_in * 1000) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      const token = await client.exchangeDeviceCode({ deviceCode: device.device_code, resource });
      await setStoredToken(baseUrl, {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      });
      if (!options.json) {
        writeText(runtime.stdout, `Logged in to ${baseUrl}.`);
      }
      return;
    } catch (error) {
      if (error instanceof CliError && error.message === "authorization_pending") {
        continue;
      }
      throw error;
    }
  }
  throw new CliError("Device authorization expired.", ExitCode.Auth);
}

export async function logoutCommand(runtime: CommandRuntime, options: GlobalOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  await removeStoredToken(baseUrl);
  if (options.json) {
    writeJson(runtime.stdout, { ok: true, baseUrl });
  } else {
    writeText(runtime.stdout, `Removed Commentary token for ${baseUrl}.`);
  }
}

export async function whoamiCommand(runtime: CommandRuntime, options: GlobalOptions) {
  const client = await makeClient(runtime, options);
  const result = await client.listDraftReviews();
  const payload = {
    ok: true,
    baseUrl: client.baseUrl,
    token: "valid",
    accessibleDraftReviews: result.draftReviews.length,
  };
  if (options.json) {
    writeJson(runtime.stdout, payload);
  } else {
    writeText(
      runtime.stdout,
      `Authenticated for ${client.baseUrl}. Accessible draft reviews: ${result.draftReviews.length}`,
    );
  }
}

export async function reviewCommand(
  runtime: CommandRuntime,
  paths: string[],
  options: GlobalOptions & {
    title?: string;
    description?: string;
    contentType?: RequestedContentType;
    watch?: boolean;
    noOpen?: boolean;
    include?: string[];
    exclude?: string[];
    root?: string;
  },
) {
  const root = path.resolve(runtime.cwd, options.root ?? ".");
  const files = await collectFiles(paths, {
    root,
    include: options.include,
    exclude: options.exclude,
    requestedContentType: options.contentType ?? "auto",
  });
  const title =
    options.title?.trim() ||
    (files.length === 1
      ? path.basename(files[0]!.path, path.extname(files[0]!.path))
      : path.basename(root)) ||
    "Commentary review";
  const client = await makeClient(runtime, options);
  const result = await client.createDraftReview({
    title,
    description: options.description ?? null,
    files,
  });
  const sessionFilePath = await findSessionFile(root, options.sessionFile ?? SESSION_FILE);
  const now = nowIso();
  const metadata: SessionMetadata = {
    version: 1,
    reviewSessionId: result.sessionId,
    reviewUrl: result.reviewUrl,
    baseUrl: client.baseUrl,
    rootPath: path.relative(path.dirname(sessionFilePath), root) || ".",
    trackedFiles: toTrackedFiles(files, apiFilesFromRevision(result.draftReview.latestRevision)),
    source: ["review", ...paths],
    createdAt: now,
    lastSyncedAt: now,
    lastKnownRevision: result.draftReview.latestRevision?.revisionNumber ?? null,
  };
  await saveSessionMetadata(sessionFilePath, metadata);

  if (options.json) {
    writeJson(runtime.stdout, {
      ok: true,
      draftReview: result.draftReview,
      sessionFilePath,
      session: publicSessionJson(metadata),
    });
  } else {
    writeText(
      runtime.stdout,
      formatReviewCreated({
        draftReview: result.draftReview,
        sessionFilePath,
        fileCount: files.length,
      }),
    );
  }
  if (!options.noOpen) {
    await openOrPrint(runtime, result.reviewUrl, options.noOpen);
  }
  if (options.watch) {
    await watchCommand(runtime, { ...options, sessionFile: sessionFilePath });
  }
}

export async function syncCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & {
    message?: string;
    all?: boolean;
    dryRun?: boolean;
  },
) {
  const loaded = await loadSession(runtime, options);
  const root = sessionRoot(loaded.filePath, loaded.metadata);
  const current = await readTrackedFiles(root, loaded.metadata.trackedFiles);
  const changed = changedFiles(current, loaded.metadata.trackedFiles);
  if (options.dryRun) {
    const payload = {
      ok: true,
      changedFiles: changed.map((file) => file.path),
      fileCount: current.length,
    };
    if (options.json) {
      writeJson(runtime.stdout, payload);
    } else {
      writeText(
        runtime.stdout,
        payload.changedFiles.length ? payload.changedFiles.join("\n") : "No local changes.",
      );
    }
    return;
  }
  if (!options.all && changed.length === 0) {
    const revision = {
      id: "",
      revisionNumber: loaded.metadata.lastKnownRevision ?? 0,
      files: [],
    };
    if (options.json) {
      writeJson(runtime.stdout, {
        ok: true,
        noOp: true,
        session: publicSessionJson(loaded.metadata),
      });
    } else {
      writeText(
        runtime.stdout,
        formatRevision({ metadata: loaded.metadata, revision, uploaded: 0, noOp: true }),
      );
    }
    return;
  }

  const client = await makeClient(runtime, { ...options, baseUrl: loaded.metadata.baseUrl });
  const result = await client.createRevision({
    sessionId: loaded.metadata.reviewSessionId,
    summary: options.message ?? null,
    files: current,
  });
  const nextMetadata: SessionMetadata = {
    ...loaded.metadata,
    trackedFiles: toTrackedFiles(current, apiFilesFromRevision(result.revision)),
    lastSyncedAt: nowIso(),
    lastKnownRevision: result.revision.revisionNumber,
  };
  await saveSessionMetadata(loaded.filePath, nextMetadata);

  if (options.json) {
    writeJson(runtime.stdout, {
      ok: true,
      revision: result.revision,
      noOp: Boolean(result.noOp),
      session: publicSessionJson(nextMetadata),
    });
  } else {
    writeText(
      runtime.stdout,
      formatRevision({
        metadata: nextMetadata,
        revision: result.revision,
        uploaded: current.length,
        noOp: result.noOp,
      }),
    );
  }
}

export async function watchCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & {
    debounce?: number;
    message?: string;
  },
) {
  const loaded = await loadSession(runtime, options);
  const root = sessionRoot(loaded.filePath, loaded.metadata);
  const debounceMs = Number(options.debounce ?? 1500);
  let timer: NodeJS.Timeout | null = null;
  let syncing = false;
  const watcher = chokidar.watch(
    loaded.metadata.trackedFiles.map((file) => path.resolve(root, file.path)),
    {
      ignoreInitial: true,
      ignored:
        /(^|[/\\])(\.git|node_modules|dist|build|\.next|\.commentary)([/\\]|$)|(~$|\.tmp$|\.swp$)/,
    },
  );

  const runSync = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      if (syncing) {
        return;
      }
      syncing = true;
      syncCommand(runtime, { ...options, message: options.message ?? "Watch sync" })
        .catch((error: unknown) =>
          runtime.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`),
        )
        .finally(() => {
          syncing = false;
        });
    }, debounceMs);
  };

  watcher.on("add", runSync).on("change", runSync).on("unlink", runSync);
  writeText(
    runtime.stdout,
    `Watching ${loaded.metadata.trackedFiles.length} file(s). Press Ctrl+C to stop.`,
  );
  await new Promise<void>((resolve) => {
    const close = () => {
      void watcher.close().finally(resolve);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

export async function commentsCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & {
    format?: "text" | "markdown" | "json";
    open?: boolean;
    resolved?: boolean;
    all?: boolean;
    file?: string;
    session?: string;
  },
) {
  const loaded = options.session ? null : await loadSession(runtime, options);
  const metadata = loaded?.metadata;
  const sessionId = options.session ?? metadata?.reviewSessionId;
  if (!sessionId) {
    throw new CliError("A session id is required.", ExitCode.Usage);
  }
  const baseUrl = metadata?.baseUrl ?? normalizeBaseUrl(options.baseUrl);
  const client = await makeClient(runtime, { ...options, baseUrl });
  const status = options.all ? undefined : options.resolved ? "resolved" : "open";
  const result = await client.listComments({
    sessionId,
    status,
    filePath: options.file ? normalizeReviewPath(options.file) : undefined,
  });
  const format = options.json ? "json" : (options.format ?? "text");
  if (format === "json") {
    writeJson(runtime.stdout, { ok: true, threads: result.threads });
  } else if (format === "markdown") {
    writeText(
      runtime.stdout,
      formatCommentsMarkdown({
        session: metadata ?? {
          version: 1,
          reviewSessionId: sessionId,
          reviewUrl: `${baseUrl}/review/draft/${encodeURIComponent(sessionId)}`,
          baseUrl,
          rootPath: ".",
          trackedFiles: [],
          source: [],
          createdAt: "",
          lastSyncedAt: "",
          lastKnownRevision: null,
        },
        threads: result.threads,
      }),
    );
  } else {
    writeText(runtime.stdout, formatCommentsText(result.threads));
  }
}

export async function waitCommentCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & {
    session?: string;
    file?: string;
    includeReplies?: boolean;
    cursor?: string;
    from?: "beginning" | "latest";
    timeout?: string;
    format?: "text" | "markdown" | "json";
  },
) {
  const loaded = options.session ? null : await loadSession(runtime, options);
  const sessionId = options.session ?? loaded?.metadata.reviewSessionId;
  if (!sessionId) {
    throw new CliError("A session id is required.", ExitCode.Usage);
  }

  const baseUrl = loaded?.metadata.baseUrl ?? normalizeBaseUrl(options.baseUrl);
  const session = loaded?.metadata ?? placeholderSessionMetadata({ sessionId, baseUrl });
  const client = await makeClient(runtime, { ...options, baseUrl });
  const filePath = options.file ? normalizeReviewPath(options.file) : undefined;
  const timeoutMs = parseDurationMs(options.timeout, 30 * 60 * 1000);
  const abortController = new AbortController();
  let timedOut = false;
  let cursor = options.cursor ?? (options.from === "beginning" ? undefined : "latest");
  let reconnectDelayMs = 1000;
  const timeout =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, timeoutMs)
      : null;

  try {
    while (!abortController.signal.aborted) {
      try {
        for await (const event of client.streamDraftReviewEvents({
          sessionId,
          cursor,
          signal: abortController.signal,
        })) {
          cursor = event.id;
          reconnectDelayMs = 1000;
          if (event.type === "draft.deleted") {
            throw new CliError("Draft review was deleted before a comment arrived.", ExitCode.Api);
          }
          if (!isWaitCommentMatch({ event, includeReplies: options.includeReplies, filePath })) {
            continue;
          }

          const format = options.json ? "json" : (options.format ?? "markdown");
          if (format === "json") {
            writeJson(runtime.stdout, { ok: true, event });
          } else if (format === "text") {
            writeText(runtime.stdout, formatWaitCommentText(event));
          } else {
            writeText(runtime.stdout, formatWaitCommentMarkdown({ session, event }));
          }
          abortController.abort();
          return;
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          break;
        }
        if (error instanceof CliError && error.exitCode !== ExitCode.Network) {
          throw error;
        }
        if (options.verbose) {
          runtime.stderr.write(
            `Event stream disconnected; reconnecting in ${reconnectDelayMs}ms.\n`,
          );
        }
      }

      await delay(reconnectDelayMs, abortController.signal);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
    }
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }

  throw new CliError(
    timedOut
      ? "Timed out waiting for a draft review comment."
      : "Stopped waiting for a draft review comment.",
    timedOut ? ExitCode.Timeout : ExitCode.General,
  );
}

export async function replyCommand(
  runtime: CommandRuntime,
  threadId: string,
  message: string,
  options: GlobalOptions & { session?: string; alias?: string },
) {
  const loaded = options.session ? null : await loadSession(runtime, options);
  const sessionId = options.session ?? loaded?.metadata.reviewSessionId;
  if (!sessionId) {
    throw new CliError("A session id is required.", ExitCode.Usage);
  }
  const client = await makeClient(runtime, {
    ...options,
    baseUrl: loaded?.metadata.baseUrl ?? options.baseUrl,
  });
  const result = await client.replyToComment({
    sessionId,
    threadId,
    bodyMarkdown: message,
    agentAlias: resolveAgentAlias(options.alias),
  });
  const thread =
    result.thread.status === "resolved"
      ? (
          await client.updateCommentStatus({
            sessionId,
            threadId,
            status: "open",
          })
        ).thread
      : result.thread;
  if (options.json) {
    writeJson(runtime.stdout, { ok: true, thread });
  } else {
    writeText(
      runtime.stdout,
      thread.status === "open" && result.thread.status === "resolved"
        ? `Replied to ${threadId} and reopened the thread.`
        : `Replied to ${threadId}.`,
    );
  }
}

export async function resolveCommand(
  runtime: CommandRuntime,
  threadId: string,
  options: GlobalOptions & {
    session?: string;
    message?: string;
    alias?: string;
  },
) {
  const loaded = options.session ? null : await loadSession(runtime, options);
  const sessionId = options.session ?? loaded?.metadata.reviewSessionId;
  if (!sessionId) {
    throw new CliError("A session id is required.", ExitCode.Usage);
  }
  const client = await makeClient(runtime, {
    ...options,
    baseUrl: loaded?.metadata.baseUrl ?? options.baseUrl,
  });
  if (options.message?.trim()) {
    await client.replyToComment({
      sessionId,
      threadId,
      bodyMarkdown: options.message.trim(),
      agentAlias: resolveAgentAlias(options.alias),
    });
  }
  const result = await client.updateCommentStatus({ sessionId, threadId, status: "resolved" });
  if (options.json) {
    writeJson(runtime.stdout, { ok: true, thread: result.thread });
  } else {
    writeText(runtime.stdout, `Resolved ${threadId}.`);
  }
}

export async function pullCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & {
    dryRun?: boolean;
    yes?: boolean;
    backup?: boolean;
    output?: string;
  },
) {
  const loaded = await loadSession(runtime, options);
  const root = sessionRoot(loaded.filePath, loaded.metadata);
  const client = await makeClient(runtime, { ...options, baseUrl: loaded.metadata.baseUrl });
  const session = await client.getDraftReview(loaded.metadata.reviewSessionId);
  const writes: Array<{ path: string; target: string; content: string; changed: boolean }> = [];
  for (const file of session.draftReview.files) {
    const content = await client.getFileContent({
      sessionId: loaded.metadata.reviewSessionId,
      fileId: file.id,
    });
    const targetRoot = options.output ? path.resolve(runtime.cwd, options.output) : root;
    const target = path.resolve(targetRoot, file.path);
    let current: string | null = null;
    try {
      current = await fs.readFile(target, "utf8");
    } catch {
      current = null;
    }
    writes.push({ path: file.path, target, content, changed: current !== content });
  }

  if (options.dryRun) {
    const changed = writes.filter((write) => write.changed).map((write) => write.path);
    if (options.json) {
      writeJson(runtime.stdout, { ok: true, changedFiles: changed });
    } else {
      writeText(runtime.stdout, changed.length ? changed.join("\n") : "No remote changes.");
    }
    return;
  }

  const changedWrites = writes.filter((write) => write.changed);
  if (changedWrites.length > 0 && !options.yes && !options.output) {
    throw new CliError(
      "Pull would overwrite local files. Rerun with --yes, --backup, or --output <dir>.",
      ExitCode.Safety,
    );
  }

  for (const write of writes) {
    if (!write.changed) {
      continue;
    }
    await fs.mkdir(path.dirname(write.target), { recursive: true });
    if (options.backup) {
      try {
        await fs.copyFile(write.target, `${write.target}.bak`);
      } catch {
        // No existing file to back up.
      }
    }
    await fs.writeFile(write.target, write.content, "utf8");
  }

  const nextTracked = loaded.metadata.trackedFiles.map((tracked) => {
    const write = writes.find((candidate) => candidate.path === tracked.path);
    return write
      ? {
          ...tracked,
          contentHash: contentHash(write.content),
          sizeBytes: Buffer.byteLength(write.content),
        }
      : tracked;
  });
  await saveSessionMetadata(loaded.filePath, { ...loaded.metadata, trackedFiles: nextTracked });

  if (options.json) {
    writeJson(runtime.stdout, { ok: true, filesWritten: changedWrites.length });
  } else {
    writeText(runtime.stdout, `Pulled ${changedWrites.length} file(s).`);
  }
}

export async function openCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & { session?: string },
) {
  if (options.session) {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    await openOrPrint(runtime, `${baseUrl}/review/draft/${encodeURIComponent(options.session)}`);
    return;
  }
  const loaded = await loadSession(runtime, options);
  await openOrPrint(runtime, loaded.metadata.reviewUrl);
}

export async function statusCommand(runtime: CommandRuntime, options: GlobalOptions) {
  const loaded = await loadSession(runtime, options);
  const root = sessionRoot(loaded.filePath, loaded.metadata);
  const current = await readTrackedFiles(root, loaded.metadata.trackedFiles);
  const changed = changedFiles(current, loaded.metadata.trackedFiles).map((file) => file.path);
  let openComments: number | null = null;
  let resolvedComments: number | null = null;
  try {
    const client = await makeClient(runtime, { ...options, baseUrl: loaded.metadata.baseUrl });
    const [openResult, resolvedResult] = await Promise.all([
      client.listComments({ sessionId: loaded.metadata.reviewSessionId, status: "open" }),
      client.listComments({ sessionId: loaded.metadata.reviewSessionId, status: "resolved" }),
    ]);
    openComments = openResult.threads.length;
    resolvedComments = resolvedResult.threads.length;
  } catch {
    openComments = null;
    resolvedComments = null;
  }
  const payload = {
    ...publicSessionJson(loaded.metadata),
    changedFiles: changed,
    openComments,
    resolvedComments,
  };
  if (options.json) {
    writeJson(runtime.stdout, payload);
  } else {
    writeText(
      runtime.stdout,
      [
        `Session: ${loaded.metadata.reviewSessionId}`,
        `URL: ${loaded.metadata.reviewUrl}`,
        `Base URL: ${loaded.metadata.baseUrl}`,
        `Tracked files: ${loaded.metadata.trackedFiles.length}`,
        `Last revision: ${loaded.metadata.lastKnownRevision ?? "unknown"}`,
        `Changed files: ${changed.length ? changed.join(", ") : "none"}`,
        `Open comments: ${openComments ?? "unknown"}`,
        `Resolved comments: ${resolvedComments ?? "unknown"}`,
      ].join("\n"),
    );
  }
}

export async function sessionsCommand(runtime: CommandRuntime, options: GlobalOptions) {
  const client = await makeClient(runtime, options);
  const result = await client.listDraftReviews();
  if (options.json) {
    writeJson(runtime.stdout, result);
  } else {
    writeText(
      runtime.stdout,
      result.draftReviews
        .map((draft) => `${draft.id}\t${draft.title}\t${draft.reviewUrl}`)
        .join("\n") || "No draft reviews found.",
    );
  }
}

export async function revisionsCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & { session?: string },
) {
  const loaded = options.session ? null : await loadSession(runtime, options);
  const sessionId = options.session ?? loaded?.metadata.reviewSessionId;
  if (!sessionId) {
    throw new CliError("A session id is required.", ExitCode.Usage);
  }
  const client = await makeClient(runtime, {
    ...options,
    baseUrl: loaded?.metadata.baseUrl ?? options.baseUrl,
  });
  const result = await client.listRevisions(sessionId);
  if (options.json) {
    writeJson(runtime.stdout, result);
  } else {
    writeText(
      runtime.stdout,
      result.revisions
        .map(
          (revision) =>
            `#${revision.revisionNumber}\t${revision.summary ?? ""}\t${revision.createdAt ?? ""}`,
        )
        .join("\n") || "No revisions found.",
    );
  }
}
