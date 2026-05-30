import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import open from "open";
import { CommentaryApiClient } from "./api-client.js";
import {
  CLIENT_ID,
  CLIENT_NAME,
  DRAFT_REVIEW_MAX_FILES,
  DRAFT_REVIEW_MAX_FILE_BYTES,
  DRAFT_REVIEW_MAX_TOTAL_BYTES,
  REQUIRED_SCOPES,
  SESSION_FILE,
} from "./constants.js";
import {
  getStoredToken,
  normalizeBaseUrl,
  removeStoredToken,
  setStoredToken,
  shouldRefreshStoredToken,
  type StoredToken,
} from "./config.js";
import { normalizeReviewPath } from "./content.js";
import { CliError, ExitCode } from "./errors.js";
import { collectFiles, readTrackedFiles, toTrackedFiles } from "./files.js";
import {
  defaultReviewRootForGitBase,
  hasGitBaseRequest,
  resolveGitBase,
  type GitBaseOptions,
} from "./git-base.js";
import { contentHash } from "./hash.js";
import {
  formatBrainstormingConsensusState,
  formatCommentsMarkdown,
  formatCommentsText,
  formatDraftRebased,
  formatDraftReviewShared,
  formatDraftReviewShares,
  formatGitBase,
  formatReviewCreated,
  formatReviewRestored,
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
  BrainstormingConsensusRule,
  BrainstormingConsensusRuleMode,
  BrainstormingConsensusState,
  BrainstormingFeedbackSignal,
  BrainstormingConsensusDecision,
  DraftReviewLiveEvent,
  DraftReviewGitBaseMetadata,
  DraftReviewMode,
  DraftReviewRevision,
  DraftReviewSession,
  DraftThread,
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
  const explicitToken = options.token?.trim() || process.env.COMMENTARY_TOKEN?.trim();
  if (explicitToken) {
    return new CommentaryApiClient({ baseUrl, token: explicitToken, fetchImpl: runtime.fetchImpl });
  }

  const stored = await getStoredToken(baseUrl);
  if (!stored) {
    return new CommentaryApiClient({ baseUrl, token: null, fetchImpl: runtime.fetchImpl });
  }

  const refreshStored = () => refreshStoredLogin(runtime, baseUrl);
  const token = shouldRefreshStoredToken(stored) ? await refreshStored() : stored.accessToken;
  return new CommentaryApiClient({
    baseUrl,
    token,
    fetchImpl: runtime.fetchImpl,
    onAuthRefresh: refreshStored,
  });
}

function isInvalidRefreshError(error: unknown) {
  return (
    error instanceof CliError &&
    error.exitCode === ExitCode.Auth &&
    (error.message === "invalid_grant" || /refresh token/i.test(error.message))
  );
}

async function refreshStoredLogin(runtime: CommandRuntime, baseUrl: string) {
  const stored = await getStoredToken(baseUrl);
  if (!stored?.refreshToken) {
    return null;
  }
  try {
    const client = new CommentaryApiClient({ baseUrl, fetchImpl: runtime.fetchImpl });
    const token = await client.refreshAccessToken({ refreshToken: stored.refreshToken });
    const refreshed: StoredToken = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    };
    await setStoredToken(baseUrl, refreshed);
    return refreshed.accessToken;
  } catch (error) {
    if (isInvalidRefreshError(error)) {
      await removeStoredToken(baseUrl);
      throw new CliError("Stored Commentary login expired. Run commentary login.", ExitCode.Auth);
    }
    throw error;
  }
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

function resolveClientName(clientName?: string | undefined) {
  const value = clientName?.trim();
  return value || undefined;
}

function normalizeMode(mode?: DraftReviewMode | undefined) {
  return mode ?? "draft";
}

function nonEmptyUnique(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function parseIntegerOption(value: string | undefined, name: string) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliError(`${name} must be a non-negative integer.`, ExitCode.Usage);
  }
  return parsed;
}

function isBrainstormingEventMatch(input: {
  event: DraftReviewLiveEvent;
  filePath?: string | undefined;
}) {
  const relevant = new Set([
    "comment.created",
    "reply.created",
    "comment.resolved",
    "comment.reopened",
    "thread.status_changed",
    "feedback_signal.changed",
    "feedback.marked_addressed",
    "draft.converted_to_brainstorming",
    "brainstorming.metadata_changed",
    "brainstorming.status_changed",
  ]);
  if (!relevant.has(input.event.type)) {
    return false;
  }
  if (!input.filePath) {
    return true;
  }
  return (
    (input.event.thread?.filePath ?? payloadString(input.event, "filePath")) === input.filePath
  );
}

async function resolveDraftSession(input: {
  runtime: CommandRuntime;
  options: GlobalOptions & { session?: string | undefined };
}) {
  const loaded = input.options.session ? null : await loadSession(input.runtime, input.options);
  const sessionId = input.options.session ?? loaded?.metadata.reviewSessionId;
  if (!sessionId) {
    throw new CliError("A session id is required.", ExitCode.Usage);
  }
  const baseUrl = loaded?.metadata.baseUrl ?? normalizeBaseUrl(input.options.baseUrl);
  const session = loaded?.metadata ?? placeholderSessionMetadata({ sessionId, baseUrl });
  const client = await makeClient(input.runtime, { ...input.options, baseUrl });
  return { loaded, sessionId, baseUrl, session, client };
}

function defaultStopFilePath(sessionFilePath: string) {
  return path.join(path.dirname(sessionFilePath), "stop-listening");
}

function resolveStopFilePath(input: {
  runtimeCwd: string;
  sessionFilePath?: string | undefined;
  explicitPath?: string | undefined;
}) {
  if (input.explicitPath) {
    return path.resolve(input.runtimeCwd, input.explicitPath);
  }
  return input.sessionFilePath ? defaultStopFilePath(input.sessionFilePath) : null;
}

function assertRevisionLimits(files: CollectedFile[]) {
  if (files.length > DRAFT_REVIEW_MAX_FILES) {
    throw new CliError(
      `Draft reviews support up to ${DRAFT_REVIEW_MAX_FILES} files per revision.`,
      ExitCode.Usage,
    );
  }
  let totalBytes = 0;
  for (const file of files) {
    if (file.sizeBytes > DRAFT_REVIEW_MAX_FILE_BYTES) {
      throw new CliError(
        `Draft review file exceeds ${DRAFT_REVIEW_MAX_FILE_BYTES} bytes: ${file.absolutePath}`,
        ExitCode.Usage,
      );
    }
    totalBytes += file.sizeBytes;
  }
  if (totalBytes > DRAFT_REVIEW_MAX_TOTAL_BYTES) {
    throw new CliError(
      `Draft review revisions support up to ${DRAFT_REVIEW_MAX_TOTAL_BYTES} total bytes.`,
      ExitCode.Usage,
    );
  }
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function trackedFilesFromDraftReview(draftReview: DraftReviewSession): TrackedFile[] {
  if (draftReview.latestRevision) {
    return draftReview.latestRevision.files.map((file) => ({
      path: file.path,
      fileId: file.fileId,
      contentType: file.contentType,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
    }));
  }
  return draftReview.files.map((file) => ({
    path: file.path,
    fileId: file.id,
    contentType: file.contentType,
    contentHash: "",
    sizeBytes: 0,
  }));
}

async function missingTrackedFiles(root: string, trackedFiles: TrackedFile[]) {
  const missing: string[] = [];
  for (const file of trackedFiles) {
    if (!(await fileExists(path.resolve(root, file.path)))) {
      missing.push(file.path);
    }
  }
  return missing;
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

async function waitForDraftReviewCommentEvent(input: {
  client: CommentaryApiClient;
  sessionId: string;
  filePath?: string | undefined;
  includeReplies?: boolean | undefined;
  cursor?: string | undefined;
  from?: "beginning" | "latest" | undefined;
  timeoutMs: number;
  abortController?: AbortController | undefined;
  verbose?: boolean | undefined;
  stderr: Writer;
}) {
  const abortController = input.abortController ?? new AbortController();
  let timedOut = false;
  let cursor = input.cursor ?? (input.from === "beginning" ? undefined : "latest");
  let reconnectDelayMs = 1000;
  const timeout =
    input.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, input.timeoutMs)
      : null;

  try {
    while (!abortController.signal.aborted) {
      try {
        for await (const event of input.client.streamDraftReviewEvents({
          sessionId: input.sessionId,
          cursor,
          signal: abortController.signal,
        })) {
          cursor = event.id;
          reconnectDelayMs = 1000;
          if (event.type === "draft.deleted") {
            throw new CliError("Draft review was deleted before a comment arrived.", ExitCode.Api);
          }
          if (
            !isWaitCommentMatch({
              event,
              includeReplies: input.includeReplies,
              filePath: input.filePath,
            })
          ) {
            continue;
          }
          abortController.abort();
          return event;
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          break;
        }
        if (error instanceof CliError && error.exitCode !== ExitCode.Network) {
          throw error;
        }
        if (input.verbose) {
          input.stderr.write(`Event stream disconnected; reconnecting in ${reconnectDelayMs}ms.\n`);
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

async function waitForBrainstormingReviewEvent(input: {
  client: CommentaryApiClient;
  sessionId: string;
  filePath?: string | undefined;
  timeoutMs: number;
  abortController?: AbortController | undefined;
  verbose?: boolean | undefined;
  stderr: Writer;
}) {
  const abortController = input.abortController ?? new AbortController();
  let timedOut = false;
  let cursor: string | undefined = "latest";
  let reconnectDelayMs = 1000;
  const timeout =
    input.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, input.timeoutMs)
      : null;

  try {
    while (!abortController.signal.aborted) {
      try {
        for await (const event of input.client.streamDraftReviewEvents({
          sessionId: input.sessionId,
          cursor,
          signal: abortController.signal,
        })) {
          cursor = event.id;
          reconnectDelayMs = 1000;
          if (event.type === "draft.deleted") {
            throw new CliError(
              "Draft review was deleted before a matching event arrived.",
              ExitCode.Api,
            );
          }
          if (!isBrainstormingEventMatch({ event, filePath: input.filePath })) {
            continue;
          }
          abortController.abort();
          return event;
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          break;
        }
        if (error instanceof CliError && error.exitCode !== ExitCode.Network) {
          throw error;
        }
        if (input.verbose) {
          input.stderr.write(`Event stream disconnected; reconnecting in ${reconnectDelayMs}ms.\n`);
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
      ? "Timed out waiting for a Brainstorming Review event."
      : "Stopped waiting for a Brainstorming Review event.",
    timedOut ? ExitCode.Timeout : ExitCode.General,
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
    mode?: DraftReviewMode;
    contentType?: RequestedContentType;
    watch?: boolean;
    noOpen?: boolean;
    include?: string[];
    exclude?: string[];
    root?: string;
  } & GitBaseOptions,
) {
  const root = await defaultReviewRootForGitBase({
    cwd: runtime.cwd,
    explicitRoot: options.root,
    options,
  });
  const collectionPaths =
    !options.root && options.gitBase === "auto"
      ? paths.map((inputPath) =>
          path.isAbsolute(inputPath)
            ? inputPath
            : path.relative(root, path.resolve(runtime.cwd, inputPath)) || ".",
        )
      : paths;
  const files = await collectFiles(collectionPaths, {
    root,
    include: options.include,
    exclude: options.exclude,
    requestedContentType: options.contentType ?? "auto",
  });
  const gitBase = await resolveGitBase({
    cwd: runtime.cwd,
    root,
    files,
    options,
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
    mode: options.mode,
    gitBase,
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

export async function restoreCommand(
  runtime: CommandRuntime,
  sessionId: string,
  options: GlobalOptions & {
    yes?: boolean;
    dryRun?: boolean;
    sync?: boolean;
  },
) {
  const sessionFilePath = await findSessionFile(runtime.cwd, options.sessionFile);
  if ((await fileExists(sessionFilePath)) && !options.yes) {
    throw new CliError(
      `Session metadata already exists at ${sessionFilePath}. Rerun with --yes to replace it.`,
      ExitCode.Safety,
    );
  }

  const client = await makeClient(runtime, options);
  const result = await client.getDraftReview(sessionId);
  const trackedFiles = trackedFilesFromDraftReview(result.draftReview);
  if (trackedFiles.length === 0) {
    throw new CliError("Draft review has no files to restore.", ExitCode.Usage);
  }
  const missing = await missingTrackedFiles(runtime.cwd, trackedFiles);
  if (missing.length > 0) {
    throw new CliError(
      `Cannot restore because local file(s) are missing: ${missing.join(", ")}`,
      ExitCode.Usage,
    );
  }

  const now = nowIso();
  const metadata: SessionMetadata = {
    version: 1,
    reviewSessionId: result.draftReview.id,
    reviewUrl: result.draftReview.reviewUrl,
    baseUrl: client.baseUrl,
    rootPath: path.relative(path.dirname(sessionFilePath), runtime.cwd) || ".",
    trackedFiles,
    source: ["restore", sessionId],
    createdAt: now,
    lastSyncedAt: now,
    lastKnownRevision: result.draftReview.latestRevision?.revisionNumber ?? null,
  };
  const current = await readTrackedFiles(runtime.cwd, trackedFiles);
  const changedLocalFiles = changedFiles(current, trackedFiles);
  let nextMetadata = metadata;
  let revision: DraftReviewRevision | undefined;
  const shouldSync = options.sync !== false && changedLocalFiles.length > 0;

  if (options.dryRun) {
    const payload = {
      ok: true,
      dryRun: true,
      sessionFilePath,
      session: publicSessionJson(metadata),
      synced: false,
      changedFiles: changedLocalFiles.map((file) => file.path),
    };
    if (options.json) {
      writeJson(runtime.stdout, payload);
    } else {
      writeText(
        runtime.stdout,
        formatReviewRestored({
          metadata,
          sessionFilePath,
          changedFiles: payload.changedFiles,
          synced: false,
          dryRun: true,
          noSync: options.sync === false,
        }),
      );
    }
    return;
  }

  if (shouldSync) {
    const syncResult = await client.createRevision({
      sessionId: metadata.reviewSessionId,
      summary: "Restore local session",
      files: current,
    });
    revision = syncResult.revision;
    nextMetadata = {
      ...metadata,
      trackedFiles: toTrackedFiles(current, apiFilesFromRevision(syncResult.revision)),
      lastSyncedAt: nowIso(),
      lastKnownRevision: syncResult.revision.revisionNumber,
    };
  }

  await saveSessionMetadata(sessionFilePath, nextMetadata);
  const changedFilePaths = changedLocalFiles.map((file) => file.path);
  if (options.json) {
    writeJson(runtime.stdout, {
      ok: true,
      sessionFilePath,
      session: publicSessionJson(nextMetadata),
      synced: shouldSync,
      changedFiles: changedFilePaths,
      ...(revision ? { revision } : {}),
    });
  } else {
    writeText(
      runtime.stdout,
      formatReviewRestored({
        metadata: nextMetadata,
        sessionFilePath,
        changedFiles: changedFilePaths,
        synced: shouldSync,
        noSync: options.sync === false,
        revision,
      }),
    );
  }
}

export async function syncCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & {
    message?: string;
    all?: boolean;
    dryRun?: boolean;
    addressedThread?: string[];
  },
) {
  const loaded = await loadSession(runtime, options);
  const root = sessionRoot(loaded.filePath, loaded.metadata);
  const current = await readTrackedFiles(root, loaded.metadata.trackedFiles);
  const changed = changedFiles(current, loaded.metadata.trackedFiles);
  const addressedThreadIds = nonEmptyUnique(options.addressedThread);
  if (options.dryRun) {
    const payload = {
      ok: true,
      changedFiles: changed.map((file) => file.path),
      addressedThreadIds,
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
  if (!options.all && changed.length === 0 && addressedThreadIds.length === 0) {
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
    addressedThreadIds: addressedThreadIds.length ? addressedThreadIds : undefined,
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
      addressedThreadIds: result.addressedThreadIds ?? addressedThreadIds,
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

export async function trackCommand(
  runtime: CommandRuntime,
  paths: string[],
  options: GlobalOptions & {
    message?: string;
    contentType?: RequestedContentType;
    include?: string[];
    exclude?: string[];
    dryRun?: boolean;
  },
) {
  const loaded = await loadSession(runtime, options);
  const root = sessionRoot(loaded.filePath, loaded.metadata);
  const current = await readTrackedFiles(root, loaded.metadata.trackedFiles);
  const additions = await collectFiles(paths, {
    root,
    include: options.include,
    exclude: options.exclude,
    requestedContentType: options.contentType ?? "auto",
  });
  const filesByPath = new Map(current.map((file) => [file.path, file]));
  for (const file of additions) {
    const existing = loaded.metadata.trackedFiles.find((tracked) => tracked.path === file.path);
    filesByPath.set(file.path, { ...file, fileId: existing?.fileId });
  }
  const nextFiles = [...filesByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  assertRevisionLimits(nextFiles);
  const added = additions
    .map((file) => file.path)
    .filter(
      (filePath) => !loaded.metadata.trackedFiles.some((tracked) => tracked.path === filePath),
    );

  if (options.dryRun) {
    const payload = {
      ok: true,
      dryRun: true,
      addedFiles: added,
      trackedFiles: nextFiles.map((file) => file.path),
      fileCount: nextFiles.length,
    };
    if (options.json) {
      writeJson(runtime.stdout, payload);
    } else {
      writeText(runtime.stdout, added.length ? added.join("\n") : "No new files to track.");
    }
    return;
  }

  const client = await makeClient(runtime, { ...options, baseUrl: loaded.metadata.baseUrl });
  const result = await client.createRevision({
    sessionId: loaded.metadata.reviewSessionId,
    summary: options.message ?? null,
    files: nextFiles,
  });
  const nextMetadata: SessionMetadata = {
    ...loaded.metadata,
    trackedFiles: toTrackedFiles(nextFiles, apiFilesFromRevision(result.revision)),
    source: ["review", ...nextFiles.map((file) => file.path)],
    lastSyncedAt: nowIso(),
    lastKnownRevision: result.revision.revisionNumber,
  };
  await saveSessionMetadata(loaded.filePath, nextMetadata);

  if (options.json) {
    writeJson(runtime.stdout, {
      ok: true,
      revision: result.revision,
      addedFiles: added,
      session: publicSessionJson(nextMetadata),
    });
  } else {
    writeText(
      runtime.stdout,
      formatRevision({
        metadata: nextMetadata,
        revision: result.revision,
        uploaded: nextFiles.length,
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
    consensusState?: BrainstormingConsensusState;
    session?: string;
    watch?: boolean;
    jsonl?: boolean;
    stopFile?: string;
    stop?: boolean;
    includeReplies?: boolean;
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
  const stopPath = resolveStopFilePath({
    runtimeCwd: runtime.cwd,
    sessionFilePath: loaded?.filePath,
    explicitPath: options.stopFile,
  });

  if (options.stop) {
    if (!stopPath) {
      throw new CliError("--stop requires local session metadata or --stop-file.", ExitCode.Usage);
    }
    await fs.mkdir(path.dirname(stopPath), { recursive: true });
    await fs.writeFile(stopPath, `${new Date().toISOString()}\n`, "utf8");
    if (options.json || options.jsonl) {
      writeJson(runtime.stdout, { ok: true, stopped: true, stopFile: stopPath });
    } else {
      writeText(runtime.stdout, `Stop requested: ${stopPath}`);
    }
    return;
  }

  const status = options.all ? undefined : options.resolved ? "resolved" : "open";
  const result = await client.listComments({
    sessionId,
    status,
    filePath: options.file ? normalizeReviewPath(options.file) : undefined,
    consensusState: options.consensusState,
  });
  if (options.watch) {
    if (!stopPath) {
      throw new CliError("--watch requires local session metadata or --stop-file.", ExitCode.Usage);
    }
    await fs.rm(stopPath, { force: true });
    const filePath = options.file ? normalizeReviewPath(options.file) : undefined;
    const abortController = new AbortController();
    const stopTimer = setInterval(() => {
      void fileExists(stopPath).then((exists) => {
        if (exists) {
          abortController.abort();
        }
      });
    }, 500);
    const writeLine = (payload: unknown) => runtime.stdout.write(`${JSON.stringify(payload)}\n`);
    try {
      for (const thread of result.threads) {
        writeLine({ ok: true, source: "open", thread });
      }
      for await (const event of client.streamDraftReviewEvents({
        sessionId,
        cursor: "latest",
        signal: abortController.signal,
      })) {
        if (!isWaitCommentMatch({ event, includeReplies: options.includeReplies, filePath })) {
          continue;
        }
        writeLine({
          ok: true,
          source: "event",
          event,
          thread: event.thread,
        });
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        throw error;
      }
    } finally {
      clearInterval(stopTimer);
    }
    writeLine({ ok: true, stopped: true, stopFile: stopPath });
    return;
  }

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
  const event = await waitForDraftReviewCommentEvent({
    client,
    sessionId,
    filePath,
    includeReplies: options.includeReplies,
    cursor: options.cursor,
    from: options.from,
    timeoutMs,
    verbose: options.verbose,
    stderr: runtime.stderr,
  });

  const format = options.json ? "json" : (options.format ?? "markdown");
  if (format === "json") {
    writeJson(runtime.stdout, { ok: true, event });
  } else if (format === "text") {
    writeText(runtime.stdout, formatWaitCommentText(event));
  } else {
    writeText(runtime.stdout, formatWaitCommentMarkdown({ session, event }));
  }
}

export async function nextCommentCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & {
    session?: string;
    file?: string;
    includeReplies?: boolean;
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
  const waitPromise = waitForDraftReviewCommentEvent({
    client,
    sessionId,
    filePath,
    includeReplies: options.includeReplies,
    from: "latest",
    timeoutMs,
    abortController,
    verbose: options.verbose,
    stderr: runtime.stderr,
  });
  void waitPromise.catch(() => undefined);

  let openThreads: DraftThread[];
  try {
    const result = await client.listComments({
      sessionId,
      status: "open",
      filePath,
    });
    openThreads = result.threads;
  } catch (error) {
    abortController.abort();
    throw error;
  }

  const format = options.json ? "json" : (options.format ?? "markdown");
  if (openThreads.length > 0) {
    abortController.abort();
    if (format === "json") {
      writeJson(runtime.stdout, { ok: true, source: "open", threads: openThreads });
    } else if (format === "text") {
      writeText(runtime.stdout, formatCommentsText(openThreads));
    } else {
      writeText(runtime.stdout, formatCommentsMarkdown({ session, threads: openThreads }));
    }
    return;
  }

  const event = await waitPromise;
  const threads = event.thread ? [event.thread] : [];
  if (format === "json") {
    writeJson(runtime.stdout, { ok: true, source: "event", threads, event });
  } else if (format === "text") {
    writeText(runtime.stdout, formatWaitCommentText(event));
  } else {
    writeText(runtime.stdout, formatWaitCommentMarkdown({ session, event }));
  }
}

export async function rebaseCommand(
  runtime: CommandRuntime,
  options: GlobalOptions &
    GitBaseOptions & {
      dryRun?: boolean | undefined;
      clearGitBase?: boolean | undefined;
    },
) {
  const loaded = await loadSession(runtime, options);
  const root = sessionRoot(loaded.filePath, loaded.metadata);
  const client = await makeClient(runtime, { ...options, baseUrl: loaded.metadata.baseUrl });
  const files = loaded.metadata.trackedFiles.map((file) => ({
    path: file.path,
    absolutePath: path.resolve(root, file.path),
  }));
  if (options.clearGitBase && hasGitBaseRequest(options)) {
    throw new CliError(
      "Use either --clear-git-base or git base options, not both.",
      ExitCode.Usage,
    );
  }
  if (!options.clearGitBase && !hasGitBaseRequest(options)) {
    throw new CliError(
      "Pass --git-base auto, explicit --git-base-repo/--git-base-sha, or --clear-git-base.",
      ExitCode.Usage,
    );
  }
  const gitBase = options.clearGitBase
    ? null
    : await resolveGitBase({
        cwd: runtime.cwd,
        root,
        files,
        options,
      });
  if (gitBase === undefined) {
    throw new CliError("Could not resolve GitHub base metadata.", ExitCode.Usage);
  }
  if (options.dryRun) {
    if (options.json) {
      writeJson(runtime.stdout, { ok: true, dryRun: true, gitBase });
    } else {
      writeText(runtime.stdout, `Would update Git base: ${formatGitBase(gitBase)}`);
    }
    return;
  }
  const result = await client.updateDraftReview({
    sessionId: loaded.metadata.reviewSessionId,
    gitBase,
  });
  if (options.json) {
    writeJson(runtime.stdout, {
      ok: true,
      draftReview: result.draftReview,
      gitBase: result.draftReview.gitBase ?? gitBase,
    });
  } else {
    writeText(runtime.stdout, formatDraftRebased({ draftReview: result.draftReview }));
  }
}

export async function shareCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & {
    session?: string;
    list?: boolean;
    anyone?: boolean;
    user?: string;
    revokeLink?: string;
    removeAccess?: string;
  },
) {
  const loaded = options.session ? null : await loadSession(runtime, options);
  const sessionId = options.session ?? loaded?.metadata.reviewSessionId;
  if (!sessionId) {
    throw new CliError("A session id is required.", ExitCode.Usage);
  }

  const actions = [
    Boolean(options.list),
    Boolean(options.anyone),
    Boolean(options.user),
    Boolean(options.revokeLink),
    Boolean(options.removeAccess),
  ].filter(Boolean).length;
  if (actions > 1) {
    throw new CliError(
      "Use only one share action: --list, --anyone, --user, --revoke-link, or --remove-access.",
      ExitCode.Usage,
    );
  }

  const client = await makeClient(runtime, {
    ...options,
    baseUrl: loaded?.metadata.baseUrl ?? options.baseUrl,
  });

  if (options.anyone) {
    const result = await client.shareDraftReview({ sessionId, audience: "anyone" });
    if (options.json) {
      writeJson(runtime.stdout, { sessionId, ...result });
    } else {
      writeText(
        runtime.stdout,
        formatDraftReviewShared({
          sessionId,
          shareLink: result.shareLink,
          accessGrant: result.accessGrant,
        }),
      );
    }
    return;
  }

  if (options.user) {
    const recipient = options.user.trim();
    if (!recipient) {
      throw new CliError("--user requires a recipient.", ExitCode.Usage);
    }
    const result = await client.shareDraftReview({ sessionId, audience: "user", recipient });
    if (options.json) {
      writeJson(runtime.stdout, { sessionId, ...result });
    } else {
      writeText(
        runtime.stdout,
        formatDraftReviewShared({
          sessionId,
          shareLink: result.shareLink,
          accessGrant: result.accessGrant,
        }),
      );
    }
    return;
  }

  if (options.revokeLink) {
    const shareLinkId = options.revokeLink.trim();
    if (!shareLinkId) {
      throw new CliError("--revoke-link requires a share link id.", ExitCode.Usage);
    }
    const result = await client.revokeDraftReviewShare({ sessionId, shareLinkId });
    if (options.json) {
      writeJson(runtime.stdout, { sessionId, shareLinkId, ...result });
    } else {
      writeText(runtime.stdout, `Revoked share link ${shareLinkId}.`);
    }
    return;
  }

  if (options.removeAccess) {
    const accessGrantId = options.removeAccess.trim();
    if (!accessGrantId) {
      throw new CliError("--remove-access requires an access grant id.", ExitCode.Usage);
    }
    const result = await client.removeDraftReviewAccess({ sessionId, accessGrantId });
    if (options.json) {
      writeJson(runtime.stdout, { sessionId, accessGrantId, ...result });
    } else {
      writeText(runtime.stdout, `Removed access grant ${accessGrantId}.`);
    }
    return;
  }

  const result = await client.listDraftReviewShares(sessionId);
  if (options.json) {
    writeJson(runtime.stdout, { sessionId, ...result });
  } else {
    writeText(
      runtime.stdout,
      formatDraftReviewShares({
        sessionId,
        shareLinks: result.shareLinks,
        accessGrants: result.accessGrants,
      }),
    );
  }
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

export async function brainstormEnableCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & { session?: string },
) {
  const { sessionId, client } = await resolveDraftSession({ runtime, options });
  const result = await client.updateDraftReview({ sessionId, mode: "brainstorming" });
  if (options.json) {
    writeJson(runtime.stdout, { ok: true, draftReview: result.draftReview });
  } else {
    writeText(runtime.stdout, `Enabled Brainstorming Review mode for ${sessionId}.`);
  }
}

export async function brainstormStatusCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & { session?: string },
) {
  const { sessionId, client } = await resolveDraftSession({ runtime, options });
  const state = await client.getConsensusState(sessionId);
  if (options.json) {
    writeJson(runtime.stdout, { sessionId, ...state });
  } else {
    writeText(runtime.stdout, formatBrainstormingConsensusState({ sessionId, state }));
  }
}

export async function brainstormSignalCommand(
  runtime: CommandRuntime,
  threadId: string,
  signal: BrainstormingFeedbackSignal,
  options: GlobalOptions & {
    session?: string;
    clear?: boolean;
    alias?: string;
    clientName?: string;
  },
) {
  const { sessionId, client } = await resolveDraftSession({ runtime, options });
  const result = await client.updateCommentFeedback({
    sessionId,
    threadId,
    signal,
    active: !options.clear,
    agentAlias: resolveAgentAlias(options.alias),
    clientName: resolveClientName(options.clientName),
  });
  if (options.json) {
    writeJson(runtime.stdout, { ...result, sessionId, threadId, signal, active: !options.clear });
  } else {
    writeText(
      runtime.stdout,
      `${options.clear ? "Cleared" : "Set"} ${signal} feedback for ${threadId}.`,
    );
  }
}

export async function brainstormDecideCommand(
  runtime: CommandRuntime,
  threadId: string,
  decision: BrainstormingConsensusDecision,
  options: GlobalOptions & { session?: string; reason?: string },
) {
  const { sessionId, client } = await resolveDraftSession({ runtime, options });
  const result = await client.updateCommentConsensusDecision({
    sessionId,
    threadId,
    decision,
    reason: options.reason ?? null,
  });
  if (options.json) {
    writeJson(runtime.stdout, { ...result, sessionId, threadId, decision });
  } else {
    writeText(runtime.stdout, `Updated consensus decision for ${threadId}: ${decision}.`);
  }
}

function buildConsensusRulePatch(options: {
  enabled?: boolean;
  consensusMode?: BrainstormingConsensusRuleMode;
  agreementThreshold?: string;
  minResponseCount?: string;
  requiredReviewer?: string[];
  requiredReviewerCondition?: BrainstormingConsensusRule["requiredReviewerCondition"];
  objectionPolicy?: BrainstormingConsensusRule["objectionPolicy"];
  blockersBlock?: boolean;
  ownerOverrideAllowed?: boolean;
  countOwnerAgreement?: boolean;
  countAgentSignals?: boolean;
  autoApplyAcceptedThreads?: boolean;
  staleOnNewActivity?: boolean;
  decisionPollCompletion?: BrainstormingConsensusRule["decisionPollCompletion"];
}) {
  const rule: BrainstormingConsensusRule = {};
  if (options.enabled !== undefined) {
    rule.enabled = options.enabled;
  }
  if (options.consensusMode) {
    rule.mode = options.consensusMode;
  }
  const agreementThreshold = parseIntegerOption(
    options.agreementThreshold,
    "--agreement-threshold",
  );
  if (agreementThreshold !== undefined) {
    rule.agreementThreshold = agreementThreshold;
  }
  const minResponseCount = parseIntegerOption(options.minResponseCount, "--min-response-count");
  if (minResponseCount !== undefined) {
    rule.minResponseCount = minResponseCount;
  }
  if (options.requiredReviewer) {
    rule.requiredReviewerIds = nonEmptyUnique(options.requiredReviewer);
  }
  if (options.requiredReviewerCondition) {
    rule.requiredReviewerCondition = options.requiredReviewerCondition;
  }
  if (options.objectionPolicy) {
    rule.objectionPolicy = options.objectionPolicy;
  }
  if (options.blockersBlock !== undefined) {
    rule.blockersBlock = options.blockersBlock;
  }
  if (options.ownerOverrideAllowed !== undefined) {
    rule.ownerOverrideAllowed = options.ownerOverrideAllowed;
  }
  if (options.countOwnerAgreement !== undefined) {
    rule.countOwnerAgreement = options.countOwnerAgreement;
  }
  if (options.countAgentSignals !== undefined) {
    rule.countAgentSignals = options.countAgentSignals;
  }
  if (options.autoApplyAcceptedThreads !== undefined) {
    rule.autoApplyAcceptedThreads = options.autoApplyAcceptedThreads;
  }
  if (options.staleOnNewActivity !== undefined) {
    rule.staleOnNewActivity = options.staleOnNewActivity;
  }
  if (options.decisionPollCompletion) {
    rule.decisionPollCompletion = options.decisionPollCompletion;
  }
  return rule;
}

export async function brainstormRuleCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & {
    session?: string;
    enabled?: boolean;
    consensusMode?: BrainstormingConsensusRuleMode;
    agreementThreshold?: string;
    minResponseCount?: string;
    requiredReviewer?: string[];
    requiredReviewerCondition?: BrainstormingConsensusRule["requiredReviewerCondition"];
    objectionPolicy?: BrainstormingConsensusRule["objectionPolicy"];
    blockersBlock?: boolean;
    ownerOverrideAllowed?: boolean;
    countOwnerAgreement?: boolean;
    countAgentSignals?: boolean;
    autoApplyAcceptedThreads?: boolean;
    staleOnNewActivity?: boolean;
    decisionPollCompletion?: BrainstormingConsensusRule["decisionPollCompletion"];
  },
) {
  const { sessionId, client } = await resolveDraftSession({ runtime, options });
  const rulePatch = buildConsensusRulePatch(options);
  const shouldPatch = Object.keys(rulePatch).length > 0;
  const result = shouldPatch
    ? await client.updateConsensusRule({ sessionId, rule: rulePatch })
    : await client.getConsensusRule(sessionId);
  if (options.json) {
    writeJson(runtime.stdout, { sessionId, ...result });
  } else {
    writeText(
      runtime.stdout,
      [
        shouldPatch ? "Updated Brainstorming consensus rule" : "Brainstorming consensus rule",
        "",
        `Session: ${sessionId}`,
        JSON.stringify(result.consensusRule, null, 2),
      ].join("\n"),
    );
  }
}

export async function brainstormNextCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & {
    session?: string;
    file?: string;
    consensusState?: BrainstormingConsensusState;
    timeout?: string;
    format?: "text" | "markdown" | "json";
  },
) {
  const { sessionId, session, client } = await resolveDraftSession({ runtime, options });
  const filePath = options.file ? normalizeReviewPath(options.file) : undefined;
  const consensusState = options.consensusState ?? "accepted_for_change";
  const timeoutMs = parseDurationMs(options.timeout, 30 * 60 * 1000);
  const abortController = new AbortController();
  const waitPromise = waitForBrainstormingReviewEvent({
    client,
    sessionId,
    filePath,
    timeoutMs,
    abortController,
    verbose: options.verbose,
    stderr: runtime.stderr,
  });
  void waitPromise.catch(() => undefined);

  let result;
  try {
    result = await client.listComments({ sessionId, filePath, consensusState });
  } catch (error) {
    abortController.abort();
    throw error;
  }

  const format = options.json ? "json" : (options.format ?? "markdown");
  if (result.threads.length > 0) {
    abortController.abort();
    if (format === "json") {
      writeJson(runtime.stdout, {
        ok: true,
        source: "open",
        consensusState,
        threads: result.threads,
      });
    } else if (format === "text") {
      writeText(runtime.stdout, formatCommentsText(result.threads));
    } else {
      writeText(runtime.stdout, formatCommentsMarkdown({ session, threads: result.threads }));
    }
    return;
  }

  while (true) {
    const event = await waitPromise;
    const next = await client.listComments({ sessionId, filePath, consensusState });
    if (next.threads.length === 0 && event.thread) {
      next.threads = [event.thread];
    }
    if (format === "json") {
      writeJson(runtime.stdout, {
        ok: true,
        source: "event",
        consensusState,
        threads: next.threads,
        event,
      });
    } else if (format === "text") {
      writeText(
        runtime.stdout,
        next.threads.length ? formatCommentsText(next.threads) : formatWaitCommentText(event),
      );
    } else if (next.threads.length) {
      writeText(runtime.stdout, formatCommentsMarkdown({ session, threads: next.threads }));
    } else {
      writeText(runtime.stdout, formatWaitCommentMarkdown({ session, event }));
    }
    return;
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
  let gitBase: DraftReviewGitBaseMetadata | null = null;
  let mode: DraftReviewMode | null = null;
  let consensusState: Awaited<ReturnType<CommentaryApiClient["getConsensusState"]>> | null = null;
  try {
    const client = await makeClient(runtime, { ...options, baseUrl: loaded.metadata.baseUrl });
    const [draftResult, openResult, resolvedResult] = await Promise.all([
      client.getDraftReview(loaded.metadata.reviewSessionId),
      client.listComments({ sessionId: loaded.metadata.reviewSessionId, status: "open" }),
      client.listComments({ sessionId: loaded.metadata.reviewSessionId, status: "resolved" }),
    ]);
    mode = normalizeMode(draftResult.draftReview.mode);
    gitBase = draftResult.draftReview.gitBase ?? null;
    openComments = openResult.threads.length;
    resolvedComments = resolvedResult.threads.length;
    if (mode === "brainstorming") {
      consensusState = await client.getConsensusState(loaded.metadata.reviewSessionId);
    }
  } catch {
    openComments = null;
    resolvedComments = null;
  }
  const payload = {
    ...publicSessionJson(loaded.metadata),
    changedFiles: changed,
    openComments,
    resolvedComments,
    mode,
    consensusState,
    gitBase,
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
        `Mode: ${mode ?? "unknown"}`,
        `Tracked files: ${loaded.metadata.trackedFiles.length}`,
        `Last revision: ${loaded.metadata.lastKnownRevision ?? "unknown"}`,
        `Changed files: ${changed.length ? changed.join(", ") : "none"}`,
        `Open comments: ${openComments ?? "unknown"}`,
        `Resolved comments: ${resolvedComments ?? "unknown"}`,
        consensusState
          ? `Brainstorming accepted: ${consensusState.counts.acceptedForChange ?? 0}`
          : null,
        consensusState ? `Brainstorming blocked: ${consensusState.counts.blocked ?? 0}` : null,
        consensusState
          ? `Brainstorming agent ready: ${consensusState.agentReady ? "yes" : "no"}`
          : null,
        `Git base: ${formatGitBase(gitBase)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

export async function sessionsCommand(
  runtime: CommandRuntime,
  options: GlobalOptions & { mode?: DraftReviewMode },
) {
  const client = await makeClient(runtime, options);
  const result = await client.listDraftReviews({ mode: options.mode });
  if (options.json) {
    writeJson(runtime.stdout, result);
  } else {
    writeText(
      runtime.stdout,
      result.draftReviews
        .map(
          (draft) =>
            `${draft.id}\t${normalizeMode(draft.mode)}\t${draft.title}\t${draft.reviewUrl}`,
        )
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
