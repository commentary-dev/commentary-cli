import path from "node:path";
import { CliError, ExitCode } from "./errors.js";
import type { DraftContentType, RequestedContentType } from "./types.js";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const PLAIN_EXTENSIONS = new Set([".txt"]);
const SUPPORTED_EXTENSIONS = new Set([
  ...MARKDOWN_EXTENSIONS,
  ...HTML_EXTENSIONS,
  ...PLAIN_EXTENSIONS,
]);

export function normalizeSlashes(value: string) {
  return value.replaceAll("\\", "/");
}

export function normalizeReviewPath(filePath: string) {
  const normalized = normalizeSlashes(filePath).trim().replace(/^\/+/, "");
  if (!normalized) {
    throw new CliError("Draft review file path is required.", ExitCode.Usage);
  }
  if (
    /^[a-z]:\//iu.test(normalized) ||
    filePath.trim().startsWith("/") ||
    filePath.trim().startsWith("\\")
  ) {
    throw new CliError("Draft review file paths must be relative.", ExitCode.Usage);
  }
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new CliError(
      "Draft review file paths must not contain empty, current, or parent directory segments.",
      ExitCode.Usage,
    );
  }
  return normalized;
}

export function getPathExtension(filePath: string) {
  return path.posix.extname(normalizeSlashes(filePath)).toLowerCase();
}

export function isSupportedPath(filePath: string) {
  return SUPPORTED_EXTENSIONS.has(getPathExtension(filePath));
}

export function isLikelyHtml(content: string) {
  const trimmed = content.trimStart().toLowerCase();
  return (
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    /<(head|body|main|article|section|div|p|h[1-6]|table|ul|ol)\b[^>]*>[\s\S]*<\/\1>/iu.test(
      content,
    )
  );
}

export function contentTypeFromPath(filePath: string): DraftContentType | null {
  const extension = getPathExtension(filePath);
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return "markdown";
  }
  if (HTML_EXTENSIONS.has(extension)) {
    return "html";
  }
  if (PLAIN_EXTENSIONS.has(extension)) {
    return "plain_text";
  }
  return null;
}

export function detectContentType(input: {
  filePath: string;
  content: string;
  requested?: RequestedContentType | undefined;
}): DraftContentType {
  const requested = input.requested ?? "auto";
  if (requested !== "auto") {
    if (!["markdown", "html", "plain_text"].includes(requested)) {
      throw new CliError("Choose a supported draft content type.", ExitCode.Usage);
    }
    return requested;
  }

  const fromPath = contentTypeFromPath(input.filePath);
  if (fromPath) {
    return fromPath;
  }
  return isLikelyHtml(input.content) ? "html" : "markdown";
}
