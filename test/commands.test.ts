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
  });
});
