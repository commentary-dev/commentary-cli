import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

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

  it("formats comments as markdown", async () => {
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
});
