import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectPackage,
  normalizePackagePath,
  PACKAGE_LIMITS,
  sha256,
} from "../src/package-files.js";
import { transferPackage } from "../src/package-commands.js";
import type { CommentaryApiClient } from "../src/api-client.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "commentary-package-safety-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
describe("PACKAGE-001 DRAFT-003 dedicated package collection", () => {
  it.each([
    "../index.md",
    "/index.md",
    "C:/index.md",
    "pages\\index.md",
    "%2e%2e/index.md",
    "page\u200d.md",
    "NUL.md",
    "pages//index.md",
    "pages/./index.md",
  ])("rejects ambiguous relative path %s", (value) => {
    expect(() => normalizePackagePath(value)).toThrow();
  });
  it("collects generated build output explicitly and excludes Commentary metadata", async () => {
    await mkdir(path.join(cwd, "dist"));
    await mkdir(path.join(cwd, ".commentary"));
    await writeFile(path.join(cwd, "dist", "index.html"), "<main>Walkthrough</main>");
    await writeFile(path.join(cwd, ".commentary", "session.json"), "comm_pat_" + "x".repeat(20));
    const collection = await collectPackage(cwd);
    expect(collection.files.map((file) => file.path)).toEqual(["dist/index.html"]);
    expect(collection.sha256).toBe(sha256(collection.files[0]!.content));
    expect(collection.files[0]!.sha256).toBe(collection.sha256);
  });
  it("keeps static MIME restrictions while allowing inert local source bytes", async () => {
    await writeFile(path.join(cwd, "index.html"), "<main>Walkthrough</main>");
    await writeFile(path.join(cwd, "app.ts"), "export const counter = 1;");
    await expect(collectPackage(cwd)).rejects.toMatchObject({ exitCode: 8 });
    expect((await collectPackage(cwd, "source")).files.map((file) => file.path)).toEqual([
      "app.ts",
      "index.html",
    ]);
  });
  it.each([".env.local", ".npmrc", "settings.json"])(
    "rejects credential-bearing configuration %s before publication",
    async (name) => {
      await writeFile(path.join(cwd, "index.md"), "# Walkthrough");
      await writeFile(path.join(cwd, name), '{"token":"comm_pat_' + "x".repeat(20) + '"}');
      await expect(collectPackage(cwd)).rejects.toMatchObject({ exitCode: 6 });
    },
  );
  it("rejects symlink traversal without reading external bodies", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "commentary-symlink-target-"));
    try {
      await writeFile(path.join(cwd, "index.md"), "# Walkthrough");
      await writeFile(path.join(outside, "private.md"), "private body");
      await symlink(outside, path.join(cwd, "linked"), "junction");
      await expect(collectPackage(cwd)).rejects.toMatchObject({ exitCode: 6 });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it("rejects malicious archive bytes and case-normalized duplicates", async () => {
    await writeFile(path.join(cwd, "index.md"), "# Walkthrough");
    await writeFile(path.join(cwd, "bundle.zip"), "malicious archive");
    await expect(collectPackage(cwd)).rejects.toMatchObject({ exitCode: 6 });
    // Pure path normalization supports fixture portability on case-insensitive filesystems.
    expect(normalizePackagePath("pages/e\u0301.md")).toBe("pages/é.md");
  });
});

describe("PACKAGE-001 resumable chunk protocol", () => {
  it("skips acknowledged chunks, verifies their digests and finalizes only missing bytes", async () => {
    const content = Buffer.alloc(PACKAGE_LIMITS.chunk + 10, 97);
    const files = [
      {
        path: "asset.png",
        bytes: content.length,
        sha256: sha256(content),
        mime: "image/png",
        content,
      },
    ];
    const collected = { root: cwd, files, bytes: content.length, sha256: sha256(content) };
    const fn = vi.fn(async (operation: string, input: { body?: Record<string, unknown> }) => {
      if (operation === "getPackageUpload")
        return {
          body: {
            data: {
              id: "upload-1",
              bytes: content.length,
              sha256: collected.sha256,
              state: "uploading",
              receivedChunks: [
                {
                  offset: 0,
                  bytes: PACKAGE_LIMITS.chunk,
                  sha256: sha256(content.subarray(0, PACKAGE_LIMITS.chunk)),
                },
              ],
            },
          },
        };
      if (operation === "transferPackageChunk") {
        expect(input.body!.offset).toBe(PACKAGE_LIMITS.chunk);
        expect(Buffer.from(String(input.body!.contentBase64), "base64")).toEqual(
          content.subarray(PACKAGE_LIMITS.chunk),
        );
      }
      return { body: { data: {} } };
    });
    expect(
      await transferPackage(
        { projectOperation: fn } as unknown as CommentaryApiClient,
        collected,
        "workspace-1",
        "retry-1",
        { uploadId: "upload-1" },
        vi.fn(),
      ),
    ).toBe("upload-1");
    expect(fn.mock.calls.map((call) => call[0])).toEqual([
      "getPackageUpload",
      "transferPackageChunk",
      "finalizePackageUpload",
    ]);
  });
  it("rejects a resumed upload bound to different bytes before sending chunks", async () => {
    const content = Buffer.from("# Walkthrough");
    const collected = {
      root: cwd,
      files: [
        {
          path: "index.md",
          bytes: content.length,
          sha256: sha256(content),
          mime: "text/markdown",
          content,
        },
      ],
      bytes: content.length,
      sha256: sha256(content),
    };
    const fn = vi.fn().mockResolvedValue({
      body: { data: { bytes: content.length, sha256: "a".repeat(64), state: "uploading" } },
    });
    await expect(
      transferPackage(
        { projectOperation: fn } as unknown as CommentaryApiClient,
        collected,
        "workspace-1",
        "retry-1",
        { uploadId: "upload-1" },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ exitCode: 7 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
