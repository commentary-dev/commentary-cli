export const DEFAULT_BASE_URL = "https://commentary.dev";
export const SESSION_FILE = ".commentary/session.json";
export const PACKAGE_NAME = "@commentary-dev/cli";
export const CLIENT_ID = "commentary-cli";
export const CLIENT_NAME = "Commentary CLI";

export const REQUIRED_SCOPES = [
  "commentary.review.read",
  "commentary.comments.read",
  "commentary.comments.write",
  "commentary.comments.status",
] as const;

export const SUPPORTED_EXTENSIONS = [".md", ".markdown", ".mdx", ".html", ".htm", ".txt"] as const;
export const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/coverage/**",
  "**/.commentary/**",
  "**/.DS_Store",
] as const;

export const DRAFT_REVIEW_MAX_FILES = 20;
export const DRAFT_REVIEW_MAX_FILE_BYTES = 512 * 1024;
export const DRAFT_REVIEW_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
