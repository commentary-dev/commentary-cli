import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { contentHash } from "../src/hash.js";

let dir: string;
let output: string;
let errors: string;

const stdout = {
  write(chunk: string) {
    output += chunk;
  },
};
const stderr = {
  write(chunk: string) {
    errors += chunk;
  },
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "commentary-cli-"));
  output = "";
  errors = "";
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );
}

describe("CLI commands", () => {
  it("creates a review, writes metadata, and syncs a later revision", async () => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs/spec.md"), "# Spec\n", "utf8");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/api/v1/draft-reviews") && init?.method === "POST") {
        return jsonResponse(
          {
            ok: true,
            sessionId: "draft_1",
            reviewUrl: "https://commentary.test/review/draft/draft_1",
            draftReview: {
              id: "draft_1",
              title: "Spec",
              reviewUrl: "https://commentary.test/review/draft/draft_1",
              files: [{ id: "file_1", path: "docs/spec.md", contentType: "markdown" }],
              latestRevision: {
                id: "rev_1",
                revisionNumber: 1,
                files: [
                  {
                    fileId: "file_1",
                    path: "docs/spec.md",
                    contentType: "markdown",
                    contentHash: "remote_hash",
                    sizeBytes: 7,
                  },
                ],
              },
            },
          },
          201,
        );
      }
      if (
        requestUrl.endsWith("/api/v1/draft-reviews/draft_1/revisions") &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body));
        expect(body.files[0].fileId).toBe("file_1");
        return jsonResponse(
          {
            ok: true,
            revision: {
              id: "rev_2",
              revisionNumber: 2,
              files: [
                {
                  fileId: "file_1",
                  path: "docs/spec.md",
                  contentType: "markdown",
                  contentHash: "remote_hash_2",
                  sizeBytes: 15,
                },
              ],
            },
          },
          201,
        );
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });

    const createCode = await runCli(
      [
        "review",
        "docs/spec.md",
        "--title",
        "Spec",
        "--no-open",
        "--base-url",
        "https://commentary.test",
        "--token",
        "token",
        "--json",
      ],
      { cwd: dir, stdout, stderr, fetchImpl: fetchImpl as typeof fetch, isTty: false },
    );
    expect(createCode).toBe(0);
    const metadata = JSON.parse(await readFile(path.join(dir, ".commentary/session.json"), "utf8"));
    expect(metadata.reviewSessionId).toBe("draft_1");
    expect(metadata.trackedFiles[0].fileId).toBe("file_1");

    await writeFile(path.join(dir, "docs/spec.md"), "# Spec\n\nUpdated.\n", "utf8");
    const syncCode = await runCli(
      ["sync", "--base-url", "https://commentary.test", "--token", "token", "--json"],
      {
        cwd: dir,
        stdout,
        stderr,
        fetchImpl: fetchImpl as typeof fetch,
        isTty: false,
      },
    );
    expect(syncCode).toBe(0);
    const synced = JSON.parse(await readFile(path.join(dir, ".commentary/session.json"), "utf8"));
    expect(synced.lastKnownRevision).toBe(2);
  });

  it("restores a review session and syncs changed local files", async () => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs/spec.md"), "# Local\n", "utf8");
    const localHash = contentHash("# Local\n");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/api/v1/draft-reviews/draft_1") && init?.method === "GET") {
        return jsonResponse({
          ok: true,
          draftReview: {
            id: "draft_1",
            title: "Spec",
            reviewUrl: "https://commentary.test/review/draft/draft_1",
            files: [{ id: "file_1", path: "docs/spec.md", contentType: "markdown" }],
            latestRevision: {
              id: "rev_1",
              revisionNumber: 1,
              files: [
                {
                  fileId: "file_1",
                  path: "docs/spec.md",
                  contentType: "markdown",
                  contentHash: "remote_hash",
                  sizeBytes: 9,
                },
              ],
            },
          },
        });
      }
      if (
        requestUrl.endsWith("/api/v1/draft-reviews/draft_1/revisions") &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body));
        expect(body.summary).toBe("Restore local session");
        expect(body.files).toMatchObject([
          {
            fileId: "file_1",
            path: "docs/spec.md",
            content: "# Local\n",
            contentType: "markdown",
          },
        ]);
        return jsonResponse(
          {
            ok: true,
            revision: {
              id: "rev_2",
              revisionNumber: 2,
              files: [
                {
                  fileId: "file_1",
                  path: "docs/spec.md",
                  contentType: "markdown",
                  contentHash: localHash,
                  sizeBytes: 8,
                },
              ],
            },
          },
          201,
        );
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });

    const code = await runCli(
      ["restore", "draft_1", "--base-url", "https://commentary.test", "--token", "token", "--json"],
      { cwd: dir, stdout, stderr, fetchImpl: fetchImpl as typeof fetch, isTty: false },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(output);
    expect(payload.synced).toBe(true);
    expect(payload.changedFiles).toEqual(["docs/spec.md"]);
    const metadata = JSON.parse(await readFile(path.join(dir, ".commentary/session.json"), "utf8"));
    expect(metadata.reviewSessionId).toBe("draft_1");
    expect(metadata.rootPath).toBe("..");
    expect(metadata.trackedFiles[0].fileId).toBe("file_1");
    expect(metadata.trackedFiles[0].contentHash).toBe(localHash);
    expect(metadata.lastKnownRevision).toBe(2);
  });

  it("restores a review session without uploading when local hashes match", async () => {
    await writeFile(path.join(dir, "spec.md"), "# Spec\n", "utf8");
    const hash = contentHash("# Spec\n");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/api/v1/draft-reviews/draft_1") && init?.method === "GET") {
        return jsonResponse({
          ok: true,
          draftReview: {
            id: "draft_1",
            title: "Spec",
            reviewUrl: "https://commentary.test/review/draft/draft_1",
            files: [{ id: "file_1", path: "spec.md", contentType: "markdown" }],
            latestRevision: {
              id: "rev_1",
              revisionNumber: 1,
              files: [
                {
                  fileId: "file_1",
                  path: "spec.md",
                  contentType: "markdown",
                  contentHash: hash,
                  sizeBytes: 7,
                },
              ],
            },
          },
        });
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });

    const code = await runCli(
      ["restore", "draft_1", "--base-url", "https://commentary.test", "--token", "token", "--json"],
      { cwd: dir, stdout, stderr, fetchImpl: fetchImpl as typeof fetch, isTty: false },
    );

    expect(code).toBe(0);
    expect(JSON.parse(output).synced).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(await readFile(path.join(dir, ".commentary/session.json"), "utf8"));
    expect(metadata.lastKnownRevision).toBe(1);
    expect(metadata.trackedFiles[0].contentHash).toBe(hash);
  });

  it("does not restore when reviewed local files are missing", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://commentary.test/api/v1/draft-reviews/draft_1");
      expect(init?.method).toBe("GET");
      return jsonResponse({
        ok: true,
        draftReview: {
          id: "draft_1",
          title: "Spec",
          reviewUrl: "https://commentary.test/review/draft/draft_1",
          files: [{ id: "file_1", path: "missing.md", contentType: "markdown" }],
          latestRevision: {
            id: "rev_1",
            revisionNumber: 1,
            files: [
              {
                fileId: "file_1",
                path: "missing.md",
                contentType: "markdown",
                contentHash: "remote_hash",
                sizeBytes: 7,
              },
            ],
          },
        },
      });
    });

    const code = await runCli(
      ["restore", "draft_1", "--base-url", "https://commentary.test", "--token", "token"],
      { cwd: dir, stdout, stderr, fetchImpl: fetchImpl as typeof fetch, isTty: false },
    );

    expect(code).toBe(2);
    expect(errors).toContain("missing.md");
    await expect(readFile(path.join(dir, ".commentary/session.json"), "utf8")).rejects.toThrow();
  });

  it("requires --yes before replacing existing session metadata during restore", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(path.join(dir, ".commentary/session.json"), "{}\n", "utf8");
    const fetchImpl = vi.fn();

    const code = await runCli(
      ["restore", "draft_1", "--base-url", "https://commentary.test", "--token", "token"],
      { cwd: dir, stdout, stderr, fetchImpl: fetchImpl as typeof fetch, isTty: false },
    );

    expect(code).toBe(6);
    expect(errors).toContain("Rerun with --yes");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dry-runs restore without writing metadata or uploading", async () => {
    await writeFile(path.join(dir, "spec.md"), "# Local\n", "utf8");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://commentary.test/api/v1/draft-reviews/draft_1");
      expect(init?.method).toBe("GET");
      return jsonResponse({
        ok: true,
        draftReview: {
          id: "draft_1",
          title: "Spec",
          reviewUrl: "https://commentary.test/review/draft/draft_1",
          files: [{ id: "file_1", path: "spec.md", contentType: "markdown" }],
          latestRevision: {
            id: "rev_1",
            revisionNumber: 1,
            files: [
              {
                fileId: "file_1",
                path: "spec.md",
                contentType: "markdown",
                contentHash: "remote_hash",
                sizeBytes: 7,
              },
            ],
          },
        },
      });
    });

    const code = await runCli(
      [
        "restore",
        "draft_1",
        "--base-url",
        "https://commentary.test",
        "--token",
        "token",
        "--dry-run",
        "--json",
      ],
      { cwd: dir, stdout, stderr, fetchImpl: fetchImpl as typeof fetch, isTty: false },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(output);
    expect(payload.dryRun).toBe(true);
    expect(payload.changedFiles).toEqual(["spec.md"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(readFile(path.join(dir, ".commentary/session.json"), "utf8")).rejects.toThrow();
  });

  it("restores metadata without uploading when --no-sync is passed", async () => {
    await writeFile(path.join(dir, "spec.md"), "# Local\n", "utf8");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://commentary.test/api/v1/draft-reviews/draft_1");
      expect(init?.method).toBe("GET");
      return jsonResponse({
        ok: true,
        draftReview: {
          id: "draft_1",
          title: "Spec",
          reviewUrl: "https://commentary.test/review/draft/draft_1",
          files: [{ id: "file_1", path: "spec.md", contentType: "markdown" }],
          latestRevision: {
            id: "rev_1",
            revisionNumber: 1,
            files: [
              {
                fileId: "file_1",
                path: "spec.md",
                contentType: "markdown",
                contentHash: "remote_hash",
                sizeBytes: 7,
              },
            ],
          },
        },
      });
    });

    const code = await runCli(
      [
        "restore",
        "draft_1",
        "--base-url",
        "https://commentary.test",
        "--token",
        "token",
        "--no-sync",
        "--json",
      ],
      { cwd: dir, stdout, stderr, fetchImpl: fetchImpl as typeof fetch, isTty: false },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(output);
    expect(payload.synced).toBe(false);
    expect(payload.changedFiles).toEqual(["spec.md"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(await readFile(path.join(dir, ".commentary/session.json"), "utf8"));
    expect(metadata.trackedFiles[0].contentHash).toBe("remote_hash");
  });

  it("tracks a new file in an existing review and uploads a full revision", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "README.md"), "# Readme\n", "utf8");
    await writeFile(path.join(dir, "docs/skill.md"), "# Skill\n", "utf8");
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: "..",
        trackedFiles: [
          {
            path: "README.md",
            fileId: "file_1",
            contentType: "markdown",
            contentHash: "remote_hash",
            sizeBytes: 9,
          },
        ],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://commentary.test/api/v1/draft-reviews/draft_1/revisions");
      const body = JSON.parse(String(init?.body));
      expect(body.summary).toBe("Add skill page");
      expect(body.files.map((file: { path: string }) => file.path)).toEqual([
        "docs/skill.md",
        "README.md",
      ]);
      expect(body.files.find((file: { path: string }) => file.path === "README.md").fileId).toBe(
        "file_1",
      );
      expect(
        body.files.find((file: { path: string }) => file.path === "docs/skill.md").fileId,
      ).toBeUndefined();
      return jsonResponse(
        {
          ok: true,
          revision: {
            id: "rev_2",
            revisionNumber: 2,
            files: [
              {
                fileId: "file_2",
                path: "docs/skill.md",
                contentType: "markdown",
                contentHash: "remote_hash_2",
                sizeBytes: 8,
              },
              {
                fileId: "file_1",
                path: "README.md",
                contentType: "markdown",
                contentHash: "remote_hash_1",
                sizeBytes: 9,
              },
            ],
          },
        },
        201,
      );
    });

    const code = await runCli(
      ["track", "docs/skill.md", "--message", "Add skill page", "--token", "token", "--json"],
      {
        cwd: dir,
        stdout,
        stderr,
        fetchImpl: fetchImpl as typeof fetch,
        isTty: false,
      },
    );

    expect(code).toBe(0);
    const metadata = JSON.parse(await readFile(path.join(dir, ".commentary/session.json"), "utf8"));
    expect(metadata.lastKnownRevision).toBe(2);
    expect(metadata.trackedFiles.map((file: { path: string }) => file.path)).toEqual([
      "docs/skill.md",
      "README.md",
    ]);
    expect(metadata.trackedFiles[0].fileId).toBe("file_2");
  });

  it("creates a review with explicit GitHub base metadata without storing it locally", async () => {
    await writeFile(path.join(dir, "spec.md"), "# Spec\n", "utf8");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://commentary.test/api/v1/draft-reviews");
      expect(JSON.parse(String(init?.body)).gitBase).toEqual({
        provider: "github",
        owner: "commentary-dev",
        repo: "commentary-docs",
        ref: "main",
        sha: "abc123",
        path: "spec.md",
      });
      return jsonResponse(
        {
          ok: true,
          sessionId: "draft_1",
          reviewUrl: "https://commentary.test/review/draft/draft_1",
          draftReview: {
            id: "draft_1",
            title: "Spec",
            reviewUrl: "https://commentary.test/review/draft/draft_1",
            gitBase: {
              provider: "github",
              owner: "commentary-dev",
              repo: "commentary-docs",
              ref: "main",
              sha: "abc123",
              path: "spec.md",
            },
            files: [{ id: "file_1", path: "spec.md", contentType: "markdown" }],
            latestRevision: {
              id: "rev_1",
              revisionNumber: 1,
              files: [
                {
                  fileId: "file_1",
                  path: "spec.md",
                  contentType: "markdown",
                  contentHash: "remote_hash",
                  sizeBytes: 7,
                },
              ],
            },
          },
        },
        201,
      );
    });

    const code = await runCli(
      [
        "review",
        "spec.md",
        "--title",
        "Spec",
        "--no-open",
        "--base-url",
        "https://commentary.test",
        "--token",
        "token",
        "--git-base-repo",
        "commentary-dev/commentary-docs",
        "--git-base-sha",
        "abc123",
        "--git-base-ref",
        "main",
      ],
      { cwd: dir, stdout, stderr, fetchImpl: fetchImpl as typeof fetch, isTty: false },
    );

    expect(code).toBe(0);
    expect(output).toContain(
      "Git base: commentary-dev/commentary-docs ref main sha abc123 path spec.md",
    );
    const metadata = JSON.parse(await readFile(path.join(dir, ".commentary/session.json"), "utf8"));
    expect(metadata.gitBase).toBeUndefined();
  });

  it("updates GitHub base metadata with rebase", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(path.join(dir, "spec.md"), "# Spec\n", "utf8");
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: "..",
        trackedFiles: [
          {
            path: "spec.md",
            fileId: "file_1",
            contentType: "markdown",
            contentHash: "remote_hash",
            sizeBytes: 7,
          },
        ],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://commentary.test/api/v1/draft-reviews/draft_1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        gitBase: {
          provider: "github",
          owner: "commentary-dev",
          repo: "commentary-docs",
          ref: "main",
          sha: "abc123",
          path: "spec.md",
        },
      });
      return jsonResponse({
        ok: true,
        draftReview: {
          id: "draft_1",
          title: "Spec",
          reviewUrl: "https://commentary.test/review/draft/draft_1",
          gitBase: {
            provider: "github",
            owner: "commentary-dev",
            repo: "commentary-docs",
            ref: "main",
            sha: "abc123",
            path: "spec.md",
          },
          files: [{ id: "file_1", path: "spec.md", contentType: "markdown" }],
          latestRevision: null,
        },
      });
    });

    const code = await runCli(
      [
        "rebase",
        "--token",
        "token",
        "--git-base-repo",
        "commentary-dev/commentary-docs",
        "--git-base-sha",
        "abc123",
        "--git-base-ref",
        "main",
        "--json",
      ],
      { cwd: dir, stdout, stderr, fetchImpl: fetchImpl as typeof fetch, isTty: false },
    );

    expect(code).toBe(0);
    expect(JSON.parse(output).gitBase).toEqual({
      provider: "github",
      owner: "commentary-dev",
      repo: "commentary-docs",
      ref: "main",
      sha: "abc123",
      path: "spec.md",
    });
  });

  it("shares a draft review with an anyone link", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: "..",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://commentary.test/api/v1/draft-reviews/draft_1/shares");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ audience: "anyone" });
      return jsonResponse({
        ok: true,
        shareLink: {
          id: "share_1",
          audience: "anyone",
          url: "https://commentary.test/share/share_1",
        },
      });
    });

    const code = await runCli(["share", "--anyone", "--token", "token", "--json"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(0);
    const payload = JSON.parse(output);
    expect(payload.sessionId).toBe("draft_1");
    expect(payload.shareLink.id).toBe("share_1");
    const metadata = JSON.parse(await readFile(path.join(dir, ".commentary/session.json"), "utf8"));
    expect(metadata.shareLink).toBeUndefined();
  });

  it("lists and removes draft review share access", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: "..",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      requests.push(`${init?.method ?? "GET"} ${requestUrl}`);
      if (requestUrl.endsWith("/shares") && init?.method === "GET") {
        return jsonResponse({
          ok: true,
          shareLinks: [{ id: "share_1", url: "https://commentary.test/share/share_1" }],
          accessGrants: [{ id: "grant_1", recipient: "reviewer@example.com" }],
        });
      }
      if (requestUrl.endsWith("/shares/share_1") && init?.method === "DELETE") {
        return jsonResponse({ ok: true });
      }
      if (requestUrl.endsWith("/access-grants/grant_1") && init?.method === "DELETE") {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });

    const listCode = await runCli(["share", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });
    expect(listCode).toBe(0);
    expect(output).toContain("share_1");
    output = "";

    const revokeCode = await runCli(["share", "--revoke-link", "share_1", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });
    expect(revokeCode).toBe(0);
    output = "";

    const removeCode = await runCli(["share", "--remove-access", "grant_1", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });
    expect(removeCode).toBe(0);
    expect(requests).toEqual([
      "GET https://commentary.test/api/v1/draft-reviews/draft_1/shares",
      "DELETE https://commentary.test/api/v1/draft-reviews/draft_1/shares/share_1",
      "DELETE https://commentary.test/api/v1/draft-reviews/draft_1/access-grants/grant_1",
    ]);
  });

  it("formats comments as markdown", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: "..",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        threads: [
          {
            id: "thread_1",
            fileId: "file_1",
            filePath: "docs/spec.md",
            status: "open",
            selectedText: "target text",
            comments: [{ authorLogin: "user", bodyMarkdown: "Please clarify." }],
          },
        ],
      }),
    );

    const code = await runCli(["comments", "--format", "markdown", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(0);
    expect(errors).toBe("");
    expect(output).toContain("## Comment thread_1");
    expect(output).toContain("> Please clarify.");
  });

  it("waits for the next draft review comment event", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: "..",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(
        "https://commentary.test/api/v1/draft-reviews/draft_1/events?cursor=latest",
      );
      return sseResponse([
        ": connected\n\n",
        [
          "id: event_1",
          "event: draft-review",
          `data: ${JSON.stringify({
            id: "event_1",
            type: "comment.created",
            createdAt: "2026-01-01T00:00:00.000Z",
            payload: { threadId: "thread_1", filePath: "docs/spec.md" },
            thread: {
              id: "thread_1",
              fileId: "file_1",
              filePath: "docs/spec.md",
              status: "open",
              selectedText: "target text",
              comments: [{ authorLogin: "user", bodyMarkdown: "Please clarify." }],
            },
          })}`,
          "",
          "",
        ].join("\n"),
      ]);
    });

    const code = await runCli(["wait-comment", "--json", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(0);
    expect(errors).toBe("");
    const payload = JSON.parse(output);
    expect(payload.event.id).toBe("event_1");
    expect(payload.event.thread.id).toBe("thread_1");
  });

  it("next-comment returns open threads after starting the event stream", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: ".",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const requests: string[] = [];
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      requests.push(requestUrl);
      if (requestUrl.endsWith("/events?cursor=latest")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      if (requestUrl.endsWith("/comments?status=open")) {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            threads: [
              {
                id: "thread_1",
                fileId: "file_1",
                filePath: "docs/spec.md",
                status: "open",
                comments: [{ authorLogin: "user", bodyMarkdown: "Please clarify." }],
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });

    const code = await runCli(["next-comment", "--json", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(0);
    expect(requests[0]).toContain("/events?cursor=latest");
    expect(requests[1]).toContain("/comments?status=open");
    const payload = JSON.parse(output);
    expect(payload.source).toBe("open");
    expect(payload.threads[0].id).toBe("thread_1");
  });

  it("next-comment waits for an event when no open threads exist", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: ".",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/events?cursor=latest")) {
        return sseResponse([
          [
            "id: event_1",
            "event: draft-review",
            `data: ${JSON.stringify({
              id: "event_1",
              type: "comment.created",
              createdAt: "2026-01-01T00:00:00.000Z",
              payload: {},
              thread: {
                id: "thread_1",
                fileId: "file_1",
                filePath: "docs/spec.md",
                status: "open",
                comments: [{ authorLogin: "user", bodyMarkdown: "Please clarify." }],
              },
            })}`,
            "",
            "",
          ].join("\n"),
        ]);
      }
      if (requestUrl.endsWith("/comments?status=open")) {
        return jsonResponse({ ok: true, threads: [] });
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });

    const code = await runCli(["next-comment", "--json", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(0);
    const payload = JSON.parse(output);
    expect(payload.source).toBe("event");
    expect(payload.event.id).toBe("event_1");
    expect(payload.threads[0].id).toBe("thread_1");
  });

  it("next-comment can use a short bounded timeout", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: ".",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/events?cursor=latest")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      if (requestUrl.endsWith("/comments?status=open")) {
        return Promise.resolve(jsonResponse({ ok: true, threads: [] }));
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });

    const code = await runCli(["next-comment", "--timeout", "1ms", "--json", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(124);
    expect(errors).toContain("Timed out waiting for a draft review comment.");
  });

  it("streams comments in watch mode until a stop file is written", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: ".",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const stopFile = path.join(dir, ".commentary/stop-listening");
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/comments?status=open")) {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            threads: [
              {
                id: "thread_1",
                fileId: "file_1",
                filePath: "README.md",
                status: "open",
                comments: [{ authorLogin: "user", bodyMarkdown: "Please clarify." }],
              },
            ],
          }),
        );
      }
      if (requestUrl.endsWith("/events?cursor=latest")) {
        void writeFile(stopFile, "stop\n", "utf8");
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });

    const code = await runCli(["comments", "--watch", "--jsonl", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(0);
    const lines = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0].source).toBe("open");
    expect(lines[0].thread.id).toBe("thread_1");
    expect(lines.at(-1).stopped).toBe(true);
  });

  it("wait-comment returns reply events by default", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: ".",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        [
          "id: event_1",
          "event: draft-review",
          `data: ${JSON.stringify({
            id: "event_1",
            type: "reply.created",
            createdAt: "2026-01-01T00:00:00.000Z",
            payload: { threadId: "thread_1", filePath: "docs/spec.md" },
            thread: {
              id: "thread_1",
              fileId: "file_1",
              filePath: "docs/spec.md",
              status: "open",
              comments: [
                { authorLogin: "user", bodyMarkdown: "Please clarify." },
                { authorLogin: "reviewer", bodyMarkdown: "Following up." },
              ],
            },
          })}`,
          "",
          "",
        ].join("\n"),
      ]),
    );

    const code = await runCli(["wait-comment", "--json", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(0);
    expect(JSON.parse(output).event.type).toBe("reply.created");
  });

  it("reconnects wait-comment with the last seen cursor after a stream closes", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: ".",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls += 1;
      if (calls === 1) {
        expect(String(url)).toBe(
          "https://commentary.test/api/v1/draft-reviews/draft_1/events?cursor=latest",
        );
        return sseResponse([
          [
            "id: event_0",
            "event: draft-review",
            `data: ${JSON.stringify({
              id: "event_0",
              type: "revision.created",
              createdAt: "2026-01-01T00:00:00.000Z",
              payload: {},
              thread: null,
            })}`,
            "",
            "",
          ].join("\n"),
        ]);
      }
      expect(String(url)).toBe(
        "https://commentary.test/api/v1/draft-reviews/draft_1/events?cursor=event_0",
      );
      return sseResponse([
        [
          "id: event_1",
          "event: draft-review",
          `data: ${JSON.stringify({
            id: "event_1",
            type: "comment.created",
            createdAt: "2026-01-01T00:00:01.000Z",
            payload: {},
            thread: {
              id: "thread_1",
              fileId: "file_1",
              filePath: "docs/spec.md",
              status: "open",
              comments: [{ authorLogin: "user", bodyMarkdown: "Please clarify." }],
            },
          })}`,
          "",
          "",
        ].join("\n"),
      ]);
    });

    const code = await runCli(["wait-comment", "--json", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output).event.id).toBe("event_1");
  });

  it("times out while waiting for a draft review comment", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: ".",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );

    const code = await runCli(["wait-comment", "--timeout", "1ms", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(124);
    expect(errors).toContain("Timed out waiting for a draft review comment.");
  });

  it("sends agent aliases on replies and closing resolve messages", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: ".",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/comments/thread_1/replies")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          bodyMarkdown: "Updated.",
          agentAlias: "Docs agent",
        });
        return jsonResponse({
          ok: true,
          thread: {
            id: "thread_1",
            fileId: "file_1",
            filePath: "docs/spec.md",
            status: "open",
            comments: [],
          },
        });
      }
      if (requestUrl.endsWith("/comments/thread_2/replies")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          bodyMarkdown: "Fixed.",
          agentAlias: "Env agent",
        });
        return jsonResponse({
          ok: true,
          thread: {
            id: "thread_2",
            fileId: "file_1",
            filePath: "docs/spec.md",
            status: "open",
            comments: [],
          },
        });
      }
      if (requestUrl.endsWith("/comments/thread_2/status")) {
        expect(JSON.parse(String(init?.body))).toEqual({ status: "resolved" });
        return jsonResponse({
          ok: true,
          thread: {
            id: "thread_2",
            fileId: "file_1",
            filePath: "docs/spec.md",
            status: "resolved",
            comments: [],
          },
        });
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });

    const replyCode = await runCli(
      ["reply", "thread_1", "Updated.", "--alias", "Docs agent", "--token", "token"],
      {
        cwd: dir,
        stdout,
        stderr,
        fetchImpl: fetchImpl as typeof fetch,
        isTty: false,
      },
    );
    expect(replyCode).toBe(0);

    const previousAlias = process.env.COMMENTARY_AGENT_ALIAS;
    process.env.COMMENTARY_AGENT_ALIAS = "Env agent";
    try {
      const resolveCode = await runCli(
        ["resolve", "thread_2", "--message", "Fixed.", "--token", "token"],
        {
          cwd: dir,
          stdout,
          stderr,
          fetchImpl: fetchImpl as typeof fetch,
          isTty: false,
        },
      );
      expect(resolveCode).toBe(0);
    } finally {
      if (previousAlias === undefined) {
        delete process.env.COMMENTARY_AGENT_ALIAS;
      } else {
        process.env.COMMENTARY_AGENT_ALIAS = previousAlias;
      }
    }
  });

  it("accepts dash-leading thread ids for reply and resolve", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: ".",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const resolvePositionalId = "-PAeryRBpzwlICGZa3vkDevGFJn1p3u1";
    const resolveFlagId = "-k0_JuhBt2k6Em0zSpQLsRMmo5OApKVM";
    const replyPositionalId = "-s4ZSiV5JJfYTylI5qQ5OnsIWQn-EdJ2";
    const replyFlagId = "-threadFlag";
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      const threadId = [resolvePositionalId, resolveFlagId, replyPositionalId, replyFlagId].find(
        (id) => requestUrl.includes(`/comments/${encodeURIComponent(id)}/`),
      );
      if (!threadId) {
        throw new Error(`Unexpected request ${requestUrl}`);
      }

      if (requestUrl.endsWith(`/comments/${encodeURIComponent(threadId)}/replies`)) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          bodyMarkdown: expect.any(String),
        });
        return jsonResponse({
          ok: true,
          thread: {
            id: threadId,
            fileId: "file_1",
            filePath: "docs/spec.md",
            status: "open",
            comments: [],
          },
        });
      }

      if (requestUrl.endsWith(`/comments/${encodeURIComponent(threadId)}/status`)) {
        expect(JSON.parse(String(init?.body))).toEqual({ status: "resolved" });
        return jsonResponse({
          ok: true,
          thread: {
            id: threadId,
            fileId: "file_1",
            filePath: "docs/spec.md",
            status: "resolved",
            comments: [],
          },
        });
      }

      throw new Error(`Unexpected request ${requestUrl}`);
    });

    for (const argv of [
      ["resolve", resolvePositionalId, "--message", "Fixed positional.", "--token", "token"],
      ["resolve", "--thread", resolveFlagId, "--message", "Fixed flag.", "--token", "token"],
      ["reply", replyPositionalId, "Reply positional.", "--token", "token"],
      ["reply", "--thread", replyFlagId, "Reply flag.", "--token", "token"],
    ]) {
      output = "";
      errors = "";
      const code = await runCli(argv, {
        cwd: dir,
        stdout,
        stderr,
        fetchImpl: fetchImpl as typeof fetch,
        isTty: false,
      });
      expect(code).toBe(0);
      expect(errors).toBe("");
    }

    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("rejects ambiguous thread id argument forms before calling the API", async () => {
    const fetchImpl = vi.fn();
    const cases = [
      ["resolve", "--message", "Fixed.", "--token", "token"],
      ["resolve", "thread_1", "--thread", "-thread_2", "--token", "token"],
      ["reply", "--thread", "-thread_1", "thread_2", "Fixed.", "--token", "token"],
      ["reply", "-thread_1", "Fixed.", "extra", "--token", "token"],
    ];

    for (const argv of cases) {
      output = "";
      errors = "";
      const code = await runCli(argv, {
        cwd: dir,
        stdout,
        stderr,
        fetchImpl: fetchImpl as typeof fetch,
        isTty: false,
      });
      expect(code).toBe(2);
      expect(errors).not.toBe("");
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reopens resolved threads after replying", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: ".",
        trackedFiles: [],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/comments/thread_1/replies")) {
        expect(JSON.parse(String(init?.body))).toEqual({ bodyMarkdown: "New info." });
        return jsonResponse({
          ok: true,
          thread: {
            id: "thread_1",
            fileId: "file_1",
            filePath: "docs/spec.md",
            status: "resolved",
            comments: [],
          },
        });
      }
      if (requestUrl.endsWith("/comments/thread_1/status")) {
        expect(JSON.parse(String(init?.body))).toEqual({ status: "open" });
        return jsonResponse({
          ok: true,
          thread: {
            id: "thread_1",
            fileId: "file_1",
            filePath: "docs/spec.md",
            status: "open",
            comments: [],
          },
        });
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });

    const code = await runCli(["reply", "thread_1", "New info.", "--json", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output).thread.status).toBe("open");
  });

  it("prints command help with agent-oriented examples", async () => {
    const code = await runCli(["reply", "--help"], {
      cwd: dir,
      stdout,
      stderr,
      isTty: false,
    });

    expect(code).toBe(0);
    expect(output).toContain("Usage: commentary reply [options] <thread-id> <message>");
    expect(output).toContain("Examples:");
    expect(output).toContain("COMMENTARY_AGENT_ALIAS");
  });

  it("shows open and resolved comment counts in status", async () => {
    await mkdir(path.join(dir, ".commentary"), { recursive: true });
    await writeFile(path.join(dir, "spec.md"), "# Spec\n", "utf8");
    await writeFile(
      path.join(dir, ".commentary/session.json"),
      JSON.stringify({
        version: 1,
        reviewSessionId: "draft_1",
        reviewUrl: "https://commentary.test/review/draft/draft_1",
        baseUrl: "https://commentary.test",
        rootPath: "..",
        trackedFiles: [
          {
            path: "spec.md",
            contentType: "markdown",
            contentHash: "wrong",
            sizeBytes: 7,
          },
        ],
        source: [],
        createdAt: "",
        lastSyncedAt: "",
        lastKnownRevision: 1,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/api/v1/draft-reviews/draft_1")) {
        return jsonResponse({
          ok: true,
          draftReview: {
            id: "draft_1",
            title: "Spec",
            reviewUrl: "https://commentary.test/review/draft/draft_1",
            gitBase: {
              provider: "github",
              owner: "commentary-dev",
              repo: "commentary-docs",
              sha: "abc123",
              path: "spec.md",
            },
            files: [],
            latestRevision: null,
          },
        });
      }
      if (requestUrl.endsWith("/comments?status=open")) {
        return jsonResponse({ ok: true, threads: [{ id: "thread_1" }, { id: "thread_2" }] });
      }
      if (requestUrl.endsWith("/comments?status=resolved")) {
        return jsonResponse({ ok: true, threads: [{ id: "thread_3" }] });
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });

    const code = await runCli(["status", "--token", "token"], {
      cwd: dir,
      stdout,
      stderr,
      fetchImpl: fetchImpl as typeof fetch,
      isTty: false,
    });

    expect(code).toBe(0);
    expect(output).toContain("Open comments: 2");
    expect(output).toContain("Resolved comments: 1");
    expect(output).toContain("Git base: commentary-dev/commentary-docs sha abc123 path spec.md");
  });

  it("refreshes expired stored login tokens before running a command", async () => {
    const previousConfigDir = process.env.COMMENTARY_CONFIG_DIR;
    const configDir = path.join(dir, "config");
    process.env.COMMENTARY_CONFIG_DIR = configDir;
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        tokens: {
          "https://commentary.test": {
            accessToken: "expired-access",
            refreshToken: "refresh-token",
            expiresAt: "2020-01-01T00:00:00.000Z",
          },
        },
      }),
      "utf8",
    );

    try {
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = String(url);
        if (requestUrl.endsWith("/.well-known/oauth-authorization-server")) {
          return jsonResponse({
            issuer: "https://commentary.test",
            token_endpoint: "https://commentary.test/oauth/token",
            device_authorization_endpoint: "https://commentary.test/oauth/device/code",
          });
        }
        if (requestUrl.endsWith("/oauth/token")) {
          expect(JSON.parse(String(init?.body))).toEqual({
            grant_type: "refresh_token",
            refresh_token: "refresh-token",
          });
          return jsonResponse({
            access_token: "fresh-access",
            refresh_token: "fresh-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (requestUrl.endsWith("/api/v1/draft-reviews")) {
          expect((init?.headers as Record<string, string>).authorization).toBe(
            "Bearer fresh-access",
          );
          return jsonResponse({ ok: true, draftReviews: [] });
        }
        throw new Error(`Unexpected request ${requestUrl}`);
      });

      const code = await runCli(["whoami", "--base-url", "https://commentary.test"], {
        cwd: dir,
        stdout,
        stderr,
        fetchImpl: fetchImpl as typeof fetch,
        isTty: false,
      });

      expect(code).toBe(0);
      const config = JSON.parse(await readFile(path.join(configDir, "config.json"), "utf8"));
      expect(config.tokens["https://commentary.test"].accessToken).toBe("fresh-access");
      expect(config.tokens["https://commentary.test"].refreshToken).toBe("fresh-refresh");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.COMMENTARY_CONFIG_DIR;
      } else {
        process.env.COMMENTARY_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it("does not refresh when an explicit token is provided", async () => {
    const previousConfigDir = process.env.COMMENTARY_CONFIG_DIR;
    const configDir = path.join(dir, "config");
    process.env.COMMENTARY_CONFIG_DIR = configDir;
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        tokens: {
          "https://commentary.test": {
            accessToken: "expired-access",
            refreshToken: "refresh-token",
            expiresAt: "2020-01-01T00:00:00.000Z",
          },
        },
      }),
      "utf8",
    );

    try {
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = String(url);
        if (requestUrl.endsWith("/api/v1/draft-reviews")) {
          expect((init?.headers as Record<string, string>).authorization).toBe(
            "Bearer explicit-token",
          );
          return jsonResponse({ ok: true, draftReviews: [] });
        }
        throw new Error(`Unexpected request ${requestUrl}`);
      });

      const code = await runCli(
        ["whoami", "--base-url", "https://commentary.test", "--token", "explicit-token"],
        {
          cwd: dir,
          stdout,
          stderr,
          fetchImpl: fetchImpl as typeof fetch,
          isTty: false,
        },
      );

      expect(code).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.COMMENTARY_CONFIG_DIR;
      } else {
        process.env.COMMENTARY_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it("clears stored login state when refresh is rejected", async () => {
    const previousConfigDir = process.env.COMMENTARY_CONFIG_DIR;
    const configDir = path.join(dir, "config");
    process.env.COMMENTARY_CONFIG_DIR = configDir;
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        tokens: {
          "https://commentary.test": {
            accessToken: "expired-access",
            refreshToken: "bad-refresh",
            expiresAt: "2020-01-01T00:00:00.000Z",
          },
        },
      }),
      "utf8",
    );

    try {
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        const requestUrl = String(url);
        if (requestUrl.endsWith("/.well-known/oauth-authorization-server")) {
          return jsonResponse({
            issuer: "https://commentary.test",
            token_endpoint: "https://commentary.test/oauth/token",
            device_authorization_endpoint: "https://commentary.test/oauth/device/code",
          });
        }
        if (requestUrl.endsWith("/oauth/token")) {
          return jsonResponse({ error: "invalid_grant" }, 401);
        }
        throw new Error(`Unexpected request ${requestUrl}`);
      });

      const code = await runCli(["whoami", "--base-url", "https://commentary.test"], {
        cwd: dir,
        stdout,
        stderr,
        fetchImpl: fetchImpl as typeof fetch,
        isTty: false,
      });

      expect(code).toBe(3);
      expect(errors).toContain("Stored Commentary login expired. Run commentary login.");
      const config = JSON.parse(await readFile(path.join(configDir, "config.json"), "utf8"));
      expect(config.tokens["https://commentary.test"]).toBeUndefined();
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.COMMENTARY_CONFIG_DIR;
      } else {
        process.env.COMMENTARY_CONFIG_DIR = previousConfigDir;
      }
    }
  });
});
