import { createHash } from "node:crypto";
import { lstat, readdir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { CliError, ExitCode } from "./errors.js";

export const PACKAGE_LIMITS = {
  files: 10000,
  bytes: 250 * 1024 * 1024,
  text: 2 * 1024 * 1024,
  asset: 25 * 1024 * 1024,
  chunk: 4 * 1024 * 1024,
};
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export type PackageFile = {
  path: string;
  bytes: number;
  sha256: string;
  mime: string;
  content: Buffer;
};
const mimes: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mdx": "text/mdx",
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".css": "text/css",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const textMimes = new Set([
  "text/plain",
  "text/markdown",
  "text/mdx",
  "text/html",
  "text/css",
  "application/json",
  "application/yaml",
  "image/svg+xml",
]);
export function normalizePackagePath(value: string) {
  const normalized = value.normalize("NFC");
  const compatible = normalized.normalize("NFKC");
  if (
    !value ||
    value.length > 1024 ||
    value !== value.trim() ||
    /[\\%:<>?*"|\p{Cc}\p{Cf}]/u.test(compatible) ||
    compatible.split("/").length !== normalized.split("/").length ||
    compatible
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part),
      )
  )
    throw new CliError("Package paths must be unambiguous relative paths.", ExitCode.Safety);
  if (
    /(?:^|\/)(?:Dockerfile|Procfile)$|\.(?:exe|dll|so|dylib|sh|bat|cmd|ps1|php|py|rb|jar|wasm|zip|tar|gz|7z)$/iu.test(
      normalized,
    )
  )
    throw new CliError("This file is unsupported by the inert upload protocol.", ExitCode.Safety);
  return normalized;
}
export function rejectPackageCredentials(content: string, name: string) {
  if (
    /(?:comm_pat_|github_pat_|gh[pousr]_|npm_)[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:["']?(?:token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}\n]{8,}/iu.test(
      content,
    )
  )
    throw new CliError(`Remove credentials from ${name} before publishing.`, ExitCode.Safety);
}
/** Dedicated static package policy; never invokes the Draft collector or customer scripts. */
export async function collectPackage(directory: string, mode: "static" | "source" = "static") {
  const root = await realpath(directory);
  if (!(await lstat(directory)).isDirectory())
    throw new CliError("Package input must be a directory.", ExitCode.Validation);
  const files: PackageFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let entries = 0;
  async function visit(relative: string) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      if (++entries > PACKAGE_LIMITS.files * 2)
        throw new CliError("Package directory entry limit exceeded.", ExitCode.Validation);
      if ([".commentary", ".git", "node_modules"].includes(name)) continue;
      if (/^\.env(?:\.|$)|^\.(?:npmrc|netrc|pypirc)$/iu.test(name))
        throw new CliError("Credential configuration cannot be published.", ExitCode.Safety);
      const raw = relative ? `${relative}/${name}` : name;
      const normalized = normalizePackagePath(raw);
      const location = path.join(root, raw);
      const info = await lstat(location);
      if (info.isSymbolicLink())
        throw new CliError("Package symlinks are not supported.", ExitCode.Safety);
      const resolved = await realpath(location);
      const within = path.relative(root, resolved);
      if (within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
        throw new CliError("Package file escaped its directory.", ExitCode.Safety);
      if (info.isDirectory()) {
        await visit(raw);
        continue;
      }
      if (!info.isFile())
        throw new CliError("Only regular package files are supported.", ExitCode.Safety);
      const key = normalized.normalize("NFKC").toUpperCase().toLowerCase();
      if (seen.has(key)) throw new CliError("Duplicate normalized package path.", ExitCode.Safety);
      seen.add(key);
      const extension = path.extname(normalized).toLowerCase();
      const mime =
        mimes[extension] ??
        (mode === "source" && !/\.(?:exe|dll|so|dylib|zip|tar|gz|7z|jar|wasm)$/iu.test(normalized)
          ? "text/plain"
          : undefined);
      if (!mime)
        throw new CliError(`Unsupported static package file: ${normalized}.`, ExitCode.Validation);
      if (
        files.length >= PACKAGE_LIMITS.files ||
        info.size > (textMimes.has(mime) ? PACKAGE_LIMITS.text : PACKAGE_LIMITS.asset) ||
        total + info.size > PACKAGE_LIMITS.bytes
      )
        throw new CliError("Package file or total byte limit exceeded.", ExitCode.Validation);
      const handle = await open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let content: Buffer;
      const changed = () =>
        new CliError(
          "Package changed during collection; retry a stable directory.",
          ExitCode.StaleRevision,
        );
      try {
        const opened = await handle.stat();
        // Compare identity before reading: Windows may not support O_NOFOLLOW.
        if (
          !opened.isFile() ||
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          opened.size !== info.size ||
          opened.mtimeMs !== info.mtimeMs
        )
          throw changed();
        content = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < content.length) {
          const { bytesRead } = await handle.read(
            content,
            offset,
            Math.min(65536, content.length - offset),
            offset,
          );
          if (!bytesRead) throw changed();
          offset += bytesRead;
        }
        const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
        const after = await handle.stat();
        const current = await lstat(location);
        if (
          extra.bytesRead ||
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          current.isSymbolicLink() ||
          current.dev !== info.dev ||
          current.ino !== info.ino ||
          (await realpath(location)) !== resolved
        )
          throw changed();
      } finally {
        await handle.close();
      }
      if (
        mime.startsWith("text/") ||
        ["application/json", "application/yaml", "application/xml", "image/svg+xml"].includes(mime)
      )
        rejectPackageCredentials(content.toString("utf8"), normalized);
      total += content.length;
      files.push({
        path: normalized,
        bytes: content.length,
        sha256: sha256(content),
        mime,
        content,
      });
    }
  }
  await visit("");
  if (
    mode === "source" &&
    (files.length > 5000 || files.some((file) => file.bytes > 16 * 1024 * 1024))
  )
    throw new CliError("Source capture limits exceeded.", ExitCode.Validation);
  if (
    (mode === "static" &&
      !files.some((file) => /\.(?:md|markdown|mdx|html|htm)$/iu.test(file.path))) ||
    total === 0
  )
    throw new CliError(
      "A package needs at least one semantic page and nonempty bytes.",
      ExitCode.Validation,
    );
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.content);
  return { root, files, bytes: total, sha256: hash.digest("hex") };
}
