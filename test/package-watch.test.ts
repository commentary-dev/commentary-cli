import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { sha256 } from "../src/package-files.js";

const watcher = vi.hoisted(() => ({
  changed: null as null | (() => void),
  close: vi.fn(async () => undefined),
}));
vi.mock("chokidar", () => ({
  default: {
    watch: () => ({
      on: (_event: string, callback: () => void) => {
        watcher.changed = callback;
      },
      close: watcher.close,
    }),
  },
}));
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "commentary-package-watch-"));
  vi.stubEnv("COMMENTARY_CONFIG_DIR", path.join(cwd, "config"));
  vi.stubEnv("COMMENTARY_TOKEN", "");
  watcher.close.mockClear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});
function response(data: unknown, etag?: string) {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json", ...(etag ? { etag } : {}) },
  });
}

it("PACKAGE-001 serializes changes during publication, coalesces watch races and preserves acknowledged hashes after failure", async () => {
  await mkdir(path.join(cwd, ".commentary"));
  await writeFile(path.join(cwd, "index.md"), "# First revision");
  const metadataFile = path.join(cwd, ".commentary", "package.json");
  await writeFile(
    metadataFile,
    JSON.stringify({
      formatVersion: 1,
      packageId: "package-1",
      revisionId: "revision-0",
      etag: '"package-1:v1"',
      files: [{ path: "index.md", sha256: sha256("# Original") }],
    }),
  );
  let beginFirst!: () => void, finishFirst!: () => void, beginSecond!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    beginFirst = resolve;
  });
  const releaseFirst = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const secondEntered = new Promise<void>((resolve) => {
    beginSecond = resolve;
  });
  let preparations = 0,
    publications = 0,
    active = 0,
    maximumActive = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (pathname.endsWith("/uploads")) {
      preparations++;
      return response({
        ...body,
        id: `upload-${preparations}`,
        state: "uploading",
        receivedChunks: [],
      });
    }
    if (pathname.endsWith("/chunks") || pathname.endsWith("/finalize")) return response({});
    if (pathname.endsWith("/revisions")) {
      publications++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (publications === 1) {
        expect(new Headers(init?.headers).get("If-Match")).toBe('"package-1:v1"');
        beginFirst();
        await releaseFirst;
        active--;
        return response({ id: "package-1", revisionId: "revision-1" }, '"package-1:v2"');
      }
      expect(new Headers(init?.headers).get("If-Match")).toBe('"package-1:v2"');
      active--;
      beginSecond();
      throw new Error("Disconnected second publication");
    }
    throw new Error(`Unexpected mocked request ${pathname}`);
  });
  const controller = new AbortController();
  let errors = "";
  const pending = runCli(
    [
      "--token",
      "test-token",
      "--base-url",
      "https://commentary.test",
      "--workspace",
      "workspace-1",
      "--json",
      "package",
      "watch",
      ".",
      "--no-open",
    ],
    {
      cwd,
      fetchImpl: fetchImpl as typeof fetch,
      signal: controller.signal,
      stdout: { write: () => undefined },
      stderr: { write: (value) => void (errors += value) },
    },
  );
  try {
    await firstEntered;
    await writeFile(path.join(cwd, "index.md"), "# Corrected revision");
    watcher.changed!();
    watcher.changed!();
    expect(publications).toBe(1);
    finishFirst();
    await secondEntered;
    controller.abort();
    expect(await pending).toBe(130);
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    expect(metadata.revisionId).toBe("revision-1");
    expect(metadata.files).toEqual([{ path: "index.md", sha256: sha256("# First revision") }]);
    expect(metadata.pending.uploadId).toBe("upload-2");
    expect(maximumActive).toBe(1);
    expect(publications).toBe(2);
    expect(preparations).toBe(2);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(errors).toContain("interrupted");
  } finally {
    finishFirst();
    controller.abort();
    await pending;
  }
});
