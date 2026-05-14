import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import {
  DEFAULT_IGNORES,
  DRAFT_REVIEW_MAX_FILE_BYTES,
  DRAFT_REVIEW_MAX_FILES,
  DRAFT_REVIEW_MAX_TOTAL_BYTES,
  SUPPORTED_EXTENSIONS,
} from "./constants.js";
import {
  detectContentType,
  isSupportedPath,
  normalizeReviewPath,
  normalizeSlashes,
} from "./content.js";
import { CliError, ExitCode } from "./errors.js";
import { contentHash } from "./hash.js";
import type { DraftFileInput, RequestedContentType, TrackedFile } from "./types.js";

export type CollectOptions = {
  root: string;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  requestedContentType?: RequestedContentType | undefined;
};

export type CollectedFile = DraftFileInput & {
  absolutePath: string;
  contentHash: string;
  sizeBytes: number;
};

function toPosixRelative(root: string, absolutePath: string) {
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CliError(`Path is outside the review root: ${absolutePath}`, ExitCode.Usage);
  }
  return normalizeReviewPath(relative);
}

async function readUtf8File(absolutePath: string) {
  const bytes = await fs.readFile(absolutePath);
  const content = bytes.toString("utf8");
  if (content.includes("\u0000")) {
    throw new CliError(
      `File must be UTF-8 text, not binary content: ${absolutePath}`,
      ExitCode.Usage,
    );
  }
  return content;
}

async function collectPathEntries(inputPaths: string[], options: CollectOptions) {
  const root = path.resolve(options.root);
  const entries = new Set<string>();
  const includeExtensions = SUPPORTED_EXTENSIONS.map((extension) => extension.replace(".", ""));

  for (const inputPath of inputPaths) {
    const absolute = path.resolve(root, inputPath);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      throw new CliError(`Path does not exist: ${inputPath}`, ExitCode.Usage);
    }

    if (stat.isDirectory()) {
      const relativeDir = normalizeSlashes(path.relative(root, absolute)) || ".";
      const patterns = options.include?.length
        ? options.include.map((pattern) => normalizeSlashes(path.posix.join(relativeDir, pattern)))
        : [`${relativeDir === "." ? "" : `${relativeDir}/`}**/*.{${includeExtensions.join(",")}}`];
      const matches = await fg(patterns, {
        cwd: root,
        onlyFiles: true,
        dot: false,
        ignore: [...DEFAULT_IGNORES, ...(options.exclude ?? [])],
      });
      matches.forEach((match) => entries.add(path.resolve(root, match)));
      continue;
    }

    if (stat.isFile()) {
      if (!isSupportedPath(absolute)) {
        throw new CliError(`Unsupported file type: ${inputPath}`, ExitCode.Usage);
      }
      entries.add(absolute);
    }
  }

  return [...entries].sort((left, right) => left.localeCompare(right));
}

export async function collectFiles(
  inputPaths: string[],
  options: CollectOptions,
): Promise<CollectedFile[]> {
  if (inputPaths.length === 0) {
    throw new CliError("At least one path is required.", ExitCode.Usage);
  }

  const root = path.resolve(options.root);
  const absolutePaths = await collectPathEntries(inputPaths, options);
  if (absolutePaths.length === 0) {
    throw new CliError("No supported files were found.", ExitCode.Usage);
  }
  if (absolutePaths.length > DRAFT_REVIEW_MAX_FILES) {
    throw new CliError(
      `Draft reviews support up to ${DRAFT_REVIEW_MAX_FILES} files per revision.`,
      ExitCode.Usage,
    );
  }

  let totalBytes = 0;
  const collected: CollectedFile[] = [];
  for (const absolutePath of absolutePaths) {
    const content = await readUtf8File(absolutePath);
    const sizeBytes = Buffer.byteLength(content);
    if (sizeBytes > DRAFT_REVIEW_MAX_FILE_BYTES) {
      throw new CliError(
        `Draft review file exceeds ${DRAFT_REVIEW_MAX_FILE_BYTES} bytes: ${absolutePath}`,
        ExitCode.Usage,
      );
    }
    totalBytes += sizeBytes;
    if (totalBytes > DRAFT_REVIEW_MAX_TOTAL_BYTES) {
      throw new CliError(
        `Draft review revisions support up to ${DRAFT_REVIEW_MAX_TOTAL_BYTES} total bytes.`,
        ExitCode.Usage,
      );
    }
    const reviewPath = toPosixRelative(root, absolutePath);
    const contentType = detectContentType({
      filePath: reviewPath,
      content,
      requested: options.requestedContentType,
    });
    collected.push({
      absolutePath,
      path: reviewPath,
      content,
      contentType,
      contentHash: contentHash(content),
      sizeBytes,
    });
  }

  return collected;
}

export async function readTrackedFiles(
  root: string,
  trackedFiles: TrackedFile[],
): Promise<CollectedFile[]> {
  const collected: CollectedFile[] = [];
  for (const tracked of trackedFiles) {
    const absolutePath = path.resolve(root, tracked.path);
    const content = await readUtf8File(absolutePath);
    const sizeBytes = Buffer.byteLength(content);
    collected.push({
      absolutePath,
      path: tracked.path,
      fileId: tracked.fileId,
      content,
      contentType: tracked.contentType,
      contentHash: contentHash(content),
      sizeBytes,
    });
  }
  return collected;
}

export function toTrackedFiles(
  files: CollectedFile[],
  apiFiles?: Array<{
    fileId: string;
    path: string;
    contentHash: string;
    sizeBytes: number;
    contentType: string;
  }>,
): TrackedFile[] {
  const apiByPath = new Map(apiFiles?.map((file) => [file.path, file]) ?? []);
  return files.map((file) => {
    const apiFile = apiByPath.get(file.path);
    return {
      path: file.path,
      fileId: apiFile?.fileId ?? file.fileId,
      contentType: file.contentType,
      contentHash: apiFile?.contentHash ?? file.contentHash,
      sizeBytes: apiFile?.sizeBytes ?? file.sizeBytes,
    };
  });
}
