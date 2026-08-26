import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

let cwd: string;
let output: string;
let errors: string;

const stdout = { write: (chunk: string) => void (output += chunk) };
const stderr = { write: (chunk: string) => void (errors += chunk) };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function interaction(state = "active", version = 1) {
  return {
    id: "ixn_opaque",
    state,
    version,
    resource: { type: "draft_review", id: "draft_opaque" },
    currentRevisionId: `ixr_${version}`,
  };
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "commentary-cli-interaction-"));
  output = "";
  errors = "";
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(cwd, { recursive: true, force: true });
});

describe("INTERACTION-003 CLI lifecycle", () => {
  it("creates and replays with payload content kept out of argv", async () => {
    const payloadPath = path.join(cwd, "interaction.json");
    await writeFile(payloadPath, JSON.stringify({ title: "Review the revision" }), "utf8");
    const requests: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return jsonResponse({ data: interaction() }, 201, {
        etag: '"ixn_opaque:v1"',
        "x-correlation-id": "run-42",
        "idempotency-replayed": String(requests.length > 1),
      });
    });
    const argv = [
      "--json",
      "--token",
      "test-token",
      "--base-url",
      "https://commentary.test",
      "interaction",
      "create",
      "--resource-type",
      "draft_review",
      "--resource-id",
      "draft_opaque",
      "--file",
      "interaction.json",
      "--idempotency-key",
      "create-42",
      "--correlation-id",
      "run-42",
    ];

    expect(await runCli(argv, { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch })).toBe(
      0,
    );
    const first = JSON.parse(output);
    output = "";
    expect(await runCli(argv, { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch })).toBe(
      0,
    );
    const replay = JSON.parse(output);

    expect(first).toMatchSnapshot("interaction create JSON");
    expect(replay.idempotencyReplayed).toBe(true);
    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      resource: { type: "draft_review", id: "draft_opaque" },
      content: { title: "Review the revision" },
    });
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer test-token",
      "Idempotency-Key": "create-42",
      "X-Correlation-Id": "run-42",
    });
    expect(argv).not.toContain("Review the revision");
    expect(output).not.toContain("test-token");
    expect(errors).toBe("");
  });

  it("gets and lists opaque ids with filters and cursor pagination", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("?")) {
        return jsonResponse({ data: [interaction()], nextCursor: "cursor_opaque" }, 200, {
          "x-correlation-id": "list-run",
        });
      }
      return jsonResponse({ data: interaction() }, 200, {
        etag: '"ixn_opaque:v1"',
        "x-correlation-id": "get-run",
      });
    });

    expect(
      await runCli(
        [
          "--json",
          "--token",
          "token",
          "--base-url",
          "https://commentary.test",
          "interaction",
          "get",
          "ixn%2Fopaque",
        ],
        { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch },
      ),
    ).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ interaction: { id: "ixn_opaque" } });
    output = "";
    expect(
      await runCli(
        [
          "--json",
          "--token",
          "token",
          "--base-url",
          "https://commentary.test",
          "interaction",
          "list",
          "--limit",
          "25",
          "--cursor",
          "cursor_start",
          "--state",
          "active",
          "--resource-type",
          "draft_review",
        ],
        { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch },
      ),
    ).toBe(0);

    expect(JSON.parse(output)).toMatchSnapshot("interaction list JSON");
    expect(urls[0]?.endsWith("/api/v1/interactions/ixn%252Fopaque")).toBe(true);
    expect(urls[1]).toContain(
      "limit=25&cursor=cursor_start&state=active&resourceType=draft_review",
    );
  });

  it("revises with If-Match and cancels with a distinct idempotency key", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const next = interaction(init?.method === "DELETE" ? "canceled" : "active", 2);
      return jsonResponse({ data: next }, init?.method === "DELETE" ? 200 : 201, {
        etag: '"ixn_opaque:v2"',
        "x-correlation-id": "mutation-run",
      });
    });
    const common = [
      "--json",
      "--token",
      "token",
      "--base-url",
      "https://commentary.test",
      "interaction",
    ];

    expect(
      await runCli(
        [
          ...common,
          "revise",
          "ixn_opaque",
          "--etag",
          '"ixn_opaque:v1"',
          "--idempotency-key",
          "revise-1",
          "--stdin",
        ],
        {
          cwd,
          stdout,
          stderr,
          stdin: Readable.from(['{"title":"Updated"}']),
          fetchImpl: fetchImpl as typeof fetch,
        },
      ),
    ).toBe(0);
    output = "";
    expect(
      await runCli(
        [
          ...common,
          "cancel",
          "ixn_opaque",
          "--etag",
          '"ixn_opaque:v2"',
          "--idempotency-key",
          "cancel-1",
        ],
        { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch },
      ),
    ).toBe(0);

    expect(requests.map((request) => request.init?.method)).toEqual(["POST", "DELETE"]);
    expect(requests[0]?.url.endsWith("/api/v1/interactions/ixn_opaque/revisions")).toBe(true);
    expect(requests[0]?.init?.headers).toMatchObject({
      "If-Match": '"ixn_opaque:v1"',
      "Idempotency-Key": "revise-1",
    });
    expect(requests[1]?.init?.headers).toMatchObject({
      "If-Match": '"ixn_opaque:v2"',
      "Idempotency-Key": "cancel-1",
    });
  });

  it.each([
    ["completed", 0],
    ["rejected", 10],
    ["canceled", 10],
    ["expired", 10],
    ["failed", 10],
  ])("wait maps terminal %s to exit %i", async (state, exitCode) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: interaction(state) }, 200, {
        etag: '"ixn_opaque:v1"',
        "x-correlation-id": "wait-run",
      }),
    );
    const code = await runCli(
      [
        "--json",
        "--token",
        "token",
        "--base-url",
        "https://commentary.test",
        "interaction",
        "wait",
        "ixn_opaque",
        "--timeout",
        "1",
      ],
      { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch },
    );

    expect(code).toBe(exitCode);
    expect(JSON.parse(output)).toMatchObject({ interaction: { state } });
    if (exitCode === 0) expect(errors).toBe("");
    else expect(JSON.parse(errors)).toMatchObject({ error: { exitCode: 10 } });
  });

  it("wait times out deterministically and remains bounded", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => jsonResponse({ data: interaction("active") }));
    const pending = runCli(
      [
        "--json",
        "--token",
        "token",
        "--base-url",
        "https://commentary.test",
        "interaction",
        "wait",
        "ixn_opaque",
        "--timeout",
        "1",
        "--poll-interval",
        "250",
      ],
      { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch },
    );
    await vi.advanceTimersByTimeAsync(1_001);

    expect(await pending).toBe(124);
    expect(JSON.parse(errors)).toMatchObject({ error: { exitCode: 124 } });
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("wait interruption cleans up with exit 130", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => jsonResponse({ data: interaction("active") }));
    const pending = runCli(
      [
        "--json",
        "--token",
        "token",
        "--base-url",
        "https://commentary.test",
        "interaction",
        "wait",
        "ixn_opaque",
        "--timeout",
        "30",
      ],
      {
        cwd,
        stdout,
        stderr,
        signal: controller.signal,
        fetchImpl: fetchImpl as typeof fetch,
      },
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();

    expect(await pending).toBe(130);
    expect(JSON.parse(errors)).toMatchObject({ error: { exitCode: 130 } });
  });

  it("maps stale ETags, validation, auth, network, and server errors predictably", async () => {
    const cases = [
      [412, "precondition_failed", 7],
      [400, "validation_failed", 8],
      [403, "insufficient_scope", 3],
      [500, "internal_error", 9],
    ] as const;
    for (const [status, errorCode, exitCode] of cases) {
      output = "";
      errors = "";
      const fetchImpl = vi.fn(async () =>
        jsonResponse(
          {
            error: {
              version: "1",
              code: errorCode,
              message: "Mapped failure.",
              correlationId: "error-run",
              retryable: status >= 500,
            },
          },
          status,
        ),
      );
      const code = await runCli(
        [
          "--json",
          "--token",
          "token",
          "--base-url",
          "https://commentary.test",
          "interaction",
          "get",
          "ixn_opaque",
        ],
        { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch },
      );
      expect(code).toBe(exitCode);
      expect(JSON.parse(errors)).toMatchObject({
        ok: false,
        error: { code: errorCode, exitCode, correlationId: "error-run" },
      });
    }

    errors = "";
    const code = await runCli(
      [
        "--json",
        "--token",
        "token",
        "--base-url",
        "https://commentary.test",
        "interaction",
        "get",
        "ixn_opaque",
      ],
      {
        cwd,
        stdout,
        stderr,
        fetchImpl: vi.fn(async () => {
          throw new Error("connection refused");
        }) as typeof fetch,
      },
    );
    expect(code).toBe(4);
    expect(JSON.parse(errors)).toMatchObject({ error: { exitCode: 4 } });
  });

  it("preserves legacy Review command help", async () => {
    const code = await runCli(["review", "--help"], { cwd, stdout, stderr });
    expect(code).toBe(0);
    expect(output).toContain("Create a draft review from files or folders.");
    expect(output).toContain("commentary review ./docs/spec.md");
  });
});
