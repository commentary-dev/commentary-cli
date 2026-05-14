import fs from "node:fs/promises";
import path from "node:path";
import { SESSION_FILE } from "./constants.js";
import { CliError, ExitCode } from "./errors.js";
import type { SessionMetadata } from "./types.js";

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findSessionFile(startDir: string, explicitPath?: string) {
  if (explicitPath) {
    return path.resolve(startDir, explicitPath);
  }

  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, SESSION_FILE);
    if (await pathExists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir, SESSION_FILE);
    }
    current = parent;
  }
}

export async function loadSessionMetadata(startDir: string, explicitPath?: string) {
  const filePath = await findSessionFile(startDir, explicitPath);
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    throw new CliError(
      `No Commentary session metadata found at ${filePath}. Run commentary review first.`,
      ExitCode.Usage,
    );
  }

  const metadata = JSON.parse(raw) as SessionMetadata;
  return {
    filePath,
    metadata,
  };
}

export async function saveSessionMetadata(filePath: string, metadata: SessionMetadata) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
}

export function sessionRoot(sessionFilePath: string, metadata: SessionMetadata) {
  return path.resolve(path.dirname(sessionFilePath), metadata.rootPath);
}
