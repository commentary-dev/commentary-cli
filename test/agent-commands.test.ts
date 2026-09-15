import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { getStoredToken, setStoredToken } from "../src/config.js";
import { REQUIRED_SCOPES } from "../src/constants.js";

let root: string;
let cwd: string;
let output: string;
let errors: string;
const stdout = { write: (chunk: string) => void (output += chunk) };
const stderr = { write: (chunk: string) => void (errors += chunk) };
const auth = ["--token", "test-token", "--base-url", "https://commentary.test", "--json"];
function response(data: unknown = { items: [] }, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json", ...headers },
  });
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "commentary-agent-"));
  cwd = path.join(root, "project");
  await mkdir(cwd);
  output = "";
  errors = "";
  vi.stubEnv("COMMENTARY_CONFIG_DIR", path.join(root, "config"));
  vi.stubEnv("COMMENTARY_TOKEN", "");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("agent HTTP v1 operations", () => {
  it.each([
    [
      ["interaction", "messages", "list", "ixn/a", "--cursor", "opaque+/="],
      "/api/v1/interactions/ixn%2Fa/messages",
    ],
    [["interaction", "guidance", "list", "ixn_1"], "/api/v1/interactions/ixn_1/guidance"],
    [["fulfillment", "get", "ixn_1"], "/api/v1/interactions/ixn_1/fulfillment"],
    [["workspace", "list"], "/api/v1/workspaces"],
    [["workspace", "get"], "/api/v1/workspaces/ws_1"],
    [
      ["workspace", "resources", "list", "--section", "reviews", "--filter", "state=active"],
      "/api/v1/workspaces/ws_1/resources",
    ],
    [
      ["workspace", "resources", "get", "draft_review", "draft_1"],
      "/api/v1/workspaces/ws_1/resources/draft_review/draft_1",
    ],
    [["workspace", "queue", "list", "--assignment", "unassigned"], "/api/v1/workspaces/ws_1/queue"],
    [["inbox", "list", "--mode", "history", "--status", "done"], "/api/v1/inbox"],
    [["inbox", "get", "ws_1", "inb_1"], "/api/v1/inbox/items/ws_1/inb_1"],
    [["inbox", "view", "list"], "/api/v1/inbox/views"],
    [["inbox", "policy", "list", "--scope", "workspace"], "/api/v1/inbox/policies"],
    [["inbox", "policy", "get", "iap_1"], "/api/v1/inbox/policies/iap_1"],
    [["inbox", "insights", "--window", "90"], "/api/v1/inbox/insights"],
    [["inbox", "notifications", "list"], "/api/v1/inbox/notification-deliveries"],
    [["webhook", "list"], "/api/v1/webhook-subscriptions"],
    [["webhook", "get", "whs_1"], "/api/v1/webhook-subscriptions/whs_1"],
    [
      ["webhook", "deliveries", "list", "whs_1", "--status", "failed"],
      "/api/v1/webhook-subscriptions/whs_1/deliveries",
    ],
  ] as [string[], string][])(
    "routes %j with delegated workspace authority",
    async (args, pathname) => {
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new URL(String(_url)).pathname).toBe(pathname);
        expect(init?.headers).toMatchObject({
          authorization: "Bearer test-token",
          "X-Commentary-Workspace-Id": "ws_1",
        });
        return response(
          { items: [], nextCursor: "opaque-next" },
          { etag: '"item:v3"', "x-correlation-id": "cor_1" },
        );
      });
      expect(
        await runCli([...auth, "--workspace", "ws_1", ...args], {
          cwd,
          stdout,
          stderr,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        data: { nextCursor: "opaque-next" },
        etag: '"item:v3"',
        correlationId: "cor_1",
      });
      expect(errors).toBe("");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      [
        "interaction",
        "update",
        "ixn_1",
        "--state",
        "waiting_for_agent",
        "--etag",
        '"ixn_1:v2"',
        "--idempotency-key",
        "retry_1",
      ],
      "PATCH",
      { state: "waiting_for_agent" },
    ],
    [
      [
        "interaction",
        "messages",
        "send",
        "ixn_1",
        "--stdin",
        "--etag",
        '"ixn_1:v2"',
        "--idempotency-key",
        "retry_1",
      ],
      "POST",
      { body: "Agent reply", revisionId: "ixr_1" },
    ],
    [
      ["interaction", "guidance", "acknowledge", "ixn_1", "ixg_1", "--idempotency-key", "retry_1"],
      "POST",
      undefined,
    ],
    [
      ["workspace", "resources", "link", "--stdin", "--idempotency-key", "retry_1"],
      "POST",
      { type: "draft_review", id: "draft_1" },
    ],
    [
      ["workspace", "resources", "rename", "draft_review", "draft_1", "--stdin"],
      "PATCH",
      { title: "New name", expectedUpdatedAt: "2026-09-15T12:00:00Z" },
    ],
    [
      ["inbox", "view", "propose", "--stdin"],
      "POST",
      { name: "My queue", definition: { version: 1 } },
    ],
    [
      ["inbox", "policy", "propose", "--stdin", "--idempotency-key", "retry_1"],
      "POST",
      { name: "Proposal", definition: { schemaVersion: 1 }, precedence: 10 },
    ],
    [
      ["inbox", "policy", "simulate", "--stdin"],
      "POST",
      { definition: { schemaVersion: 1 }, entryId: "inb_1" },
    ],
    [
      ["webhook", "update", "whs_1", "--stdin", "--etag", '"whs_1:v2"'],
      "PATCH",
      { eventTypes: ["interaction.created"] },
    ],
    [["webhook", "disable", "whs_1", "--etag", '"whs_1:v2"'], "POST", undefined],
    [["webhook", "deliveries", "replay", "whs_1", "whd_1", "--yes"], "POST", { confirm: true }],
  ] as [string[], string, unknown][])(
    "sends %j using exact request bodies",
    async (args, method, body) => {
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe(method);
        expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual(body);
        if (args.includes("--etag"))
          expect(init?.headers).toMatchObject({ "If-Match": args[args.indexOf("--etag") + 1] });
        if (args.includes("--idempotency-key"))
          expect(init?.headers).toMatchObject({ "Idempotency-Key": "retry_1" });
        return response({ id: "opaque" });
      });
      expect(
        await runCli([...auth, "--workspace", "ws_1", ...args], {
          cwd,
          stdout,
          stderr,
          stdin: Readable.from([JSON.stringify(body)]),
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it("bounds JSON input and rejects ambiguous payload flags before any request", async () => {
    const fetchImpl = vi.fn();
    expect(
      await runCli([...auth, "inbox", "view", "propose", "--stdin"], {
        cwd,
        stdout,
        stderr,
        stdin: Readable.from([JSON.stringify({ name: "x".repeat(17000) })]),
        fetchImpl,
      }),
    ).toBe(8);
    expect(fetchImpl).not.toHaveBeenCalled();
    errors = "";
    expect(
      await runCli([...auth, "inbox", "view", "propose", "--stdin", "--file", "view.json"], {
        cwd,
        stdout,
        stderr,
        fetchImpl,
      }),
    ).toBe(2);
    expect(JSON.parse(errors).ok).toBe(false);
  });
  it("requires confirmation for delivery replay and emits parseable usage errors", async () => {
    const fetchImpl = vi.fn();
    expect(
      await runCli([...auth, "webhook", "deliveries", "replay", "whs_1", "whd_1"], {
        cwd,
        stdout,
        stderr,
        fetchImpl,
      }),
    ).not.toBe(0);
    expect(JSON.parse(errors).error.code).toBe("usage_error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("preserves actionable API errors and correlation ids", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "insufficient_scope",
              message: "Inbox read scope is required.",
              correlationId: "cor-denied",
              retryable: false,
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    expect(await runCli([...auth, "inbox", "list"], { cwd, stdout, stderr, fetchImpl })).toBe(3);
    expect(JSON.parse(errors).error).toMatchObject({
      code: "insufficient_scope",
      correlationId: "cor-denied",
      retryable: false,
    });
  });
  it.each(["create", "rotate-secret"])(
    "writes a %s secret once, outside the project, and excludes it from output",
    async (name) => {
      const destination = path.join(root, "signing-secret");
      const fetchImpl = vi.fn(async () =>
        response({ id: "whs_1", secret: "one-time-signing-value" }),
      );
      const args =
        name === "create"
          ? ["webhook", name, "--stdin", "--idempotency-key", "retry_1"]
          : ["webhook", name, "whs_1", "--etag", '"whs_1:v1"'];
      expect(
        await runCli([...auth, ...args, "--secret-file", destination], {
          cwd,
          stdout,
          stderr,
          stdin: Readable.from([
            '{"endpointUrl":"https://receiver.test/events","eventTypes":["interaction.created"]}',
          ]),
          fetchImpl,
        }),
      ).toBe(0);
      expect(await readFile(destination, "utf8")).toBe("one-time-signing-value\n");
      expect(output + errors).not.toContain("one-time-signing-value");
      expect(JSON.parse(output)).toMatchObject({ secretSaved: true, data: { id: "whs_1" } });
      expect(
        await runCli([...auth, ...args, "--secret-file", destination], {
          cwd,
          stdout,
          stderr,
          stdin: Readable.from(["{}"]),
          fetchImpl,
        }),
      ).toBe(6);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a secret destination inside the repository from a nested working directory", async () => {
    await mkdir(path.join(cwd, ".git"));
    const nested = path.join(cwd, "subdirectory");
    await mkdir(nested);
    const fetchImpl = vi.fn();
    expect(
      await runCli(
        [
          ...auth,
          "webhook",
          "rotate-secret",
          "whs_1",
          "--etag",
          '"whs_1:v1"',
          "--secret-file",
          "../secret",
        ],
        { cwd: nested, stdout, stderr, fetchImpl },
      ),
    ).toBe(6);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("credential profiles", () => {
  it("validates requested scopes against metadata and replaces the default scope set", async () => {
    const metadata = {
      device_authorization_endpoint: "https://commentary.test/oauth/device/code",
      token_endpoint: "https://commentary.test/oauth/token",
      scopes_supported: ["commentary.inbox.read", "commentary.workspaces.read"],
    };
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}"));
      let value: unknown = metadata;
      if (pathname === "/oauth/device/code") {
        requested.push(body.scope);
        value = {
          device_code: "device",
          user_code: "code",
          verification_uri: "https://commentary.test/authorize",
          expires_in: 300,
          interval: 0,
        };
      }
      if (pathname === "/oauth/token")
        value = { access_token: "scoped-token", refresh_token: "refresh", expires_in: 3600 };
      return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    });
    expect(
      await runCli(
        [
          "--base-url",
          "https://commentary.test",
          "--profile",
          "reader",
          "login",
          "--no-open",
          "--scope",
          "commentary.inbox.read",
          "--scope",
          "commentary.workspaces.read",
        ],
        { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch },
      ),
    ).toBe(0);
    expect(requested).toEqual(["commentary.inbox.read commentary.workspaces.read"]);
    expect((await getStoredToken("https://commentary.test", "reader"))?.accessToken).toBe(
      "scoped-token",
    );
    expect(await getStoredToken("https://commentary.test")).toBeNull();
    expect(REQUIRED_SCOPES).toContain("commentary.interactions.fulfillment");
    requested.length = 0;
    expect(
      await runCli(
        ["--base-url", "https://commentary.test", "login", "--no-open", "--scope", "unsupported"],
        { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch },
      ),
    ).toBe(2);
    expect(requested).toEqual([]);
  });
  it("keeps profiles separate, never falls back from a missing profile, and retains explicit token precedence", async () => {
    await setStoredToken("https://commentary.test", { accessToken: "default-token" });
    await setStoredToken("https://commentary.test", { accessToken: "team-token" }, "team");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer team-token" });
      return response();
    });
    expect(
      await runCli(
        [
          "--base-url",
          "https://commentary.test",
          "--profile",
          "team",
          "--json",
          "workspace",
          "list",
        ],
        { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch },
      ),
    ).toBe(0);
    expect(await getStoredToken("https://commentary.test")).toEqual({
      accessToken: "default-token",
    });
    expect(
      await runCli(
        [
          "--base-url",
          "https://commentary.test",
          "--profile",
          "missing",
          "--json",
          "workspace",
          "list",
        ],
        { cwd, stdout, stderr, fetchImpl: fetchImpl as typeof fetch },
      ),
    ).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockImplementation(async (_url, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer test-token" });
      return response();
    });
    expect(
      await runCli([...auth, "--profile", "missing", "workspace", "list"], {
        cwd,
        stdout,
        stderr,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).toBe(0);
  });
  it("stores and logs out a selected profile without affecting the default", async () => {
    await setStoredToken("https://commentary.test", { accessToken: "default-token" });
    expect(await runCli([...auth, "--profile", "team", "login"], { cwd, stdout, stderr })).toBe(0);
    expect(await getStoredToken("https://commentary.test", "team")).toEqual({
      accessToken: "test-token",
    });
    expect(
      await runCli(["--base-url", "https://commentary.test", "--profile", "team", "logout"], {
        cwd,
        stdout,
        stderr,
      }),
    ).toBe(0);
    expect(await getStoredToken("https://commentary.test", "team")).toBeNull();
    expect(await getStoredToken("https://commentary.test")).toEqual({
      accessToken: "default-token",
    });
  });
});

describe("current-policy approval waits", () => {
  const approved = {
    state: "approved",
    approvals: 2,
    required: 2,
    completedSteps: 0,
    totalSteps: 1,
  };
  const receipt = {
    id: "ixd_1",
    interactionId: "ixn_1",
    revisionId: "ixr_1",
    actionId: "ixa_1",
    proposalFingerprint: "a".repeat(64),
    semanticAction: "approve",
    outcome: "approve",
    decidedAt: "2026-09-15T12:00:00Z",
    expiresAt: null,
    terminalState: "recorded",
    purged: false,
    contentPurgedAt: null,
  };
  function decisionResponse(data: unknown, approval: unknown) {
    return new Response(
      JSON.stringify({ data, polling: { complete: Boolean(data), retryAfterMs: 1000, approval } }),
      { status: data ? 200 : 202, headers: { "content-type": "application/json" } },
    );
  }
  it("keeps polling after one approval and returns the exact approving receipt only at policy completion", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(new URL(String(url)).searchParams.get("approval")).toBe("true");
      return fetchImpl.mock.calls.length === 1
        ? decisionResponse(null, { ...approved, state: "pending", approvals: 1 })
        : decisionResponse({ ...receipt, aggregate: approved }, approved);
    });
    expect(
      await runCli([...auth, "decision", "wait", "ixn_1", "--approval", "--poll-interval", "250"], {
        cwd,
        stdout,
        stderr,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output).decision).toMatchObject({ id: "ixd_1", aggregate: approved });
  });
  it.each(["rejected", "expired", "unsatisfiable"])(
    "exits 10 when approval becomes %s without claiming completion",
    async (state) => {
      const fetchImpl = vi.fn(async () => decisionResponse(null, { ...approved, state }));
      expect(
        await runCli([...auth, "decision", "wait", "ixn_1", "--approval"], {
          cwd,
          stdout,
          stderr,
          fetchImpl,
        }),
      ).toBe(10);
      expect(output).toBe("");
      expect(JSON.parse(errors).error.code).toBe("approval_negative");
    },
  );
  it("fails closed if the server returns an individual receipt without current approval status", async () => {
    const fetchImpl = vi.fn(async () => decisionResponse(receipt, undefined));
    expect(
      await runCli([...auth, "decision", "wait", "ixn_1", "--approval"], {
        cwd,
        stdout,
        stderr,
        fetchImpl,
      }),
    ).toBe(5);
    expect(output).toBe("");
  });
  it("bounds an in-flight request by timeout and honors interruption", async () => {
    const hangingFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        ),
    );
    expect(
      await runCli([...auth, "decision", "wait", "ixn_1", "--approval", "--timeout", "1"], {
        cwd,
        stdout,
        stderr,
        fetchImpl: hangingFetch as typeof fetch,
      }),
    ).toBe(124);
    const controller = new AbortController();
    const result = runCli([...auth, "decision", "wait", "ixn_1", "--approval"], {
      cwd,
      stdout,
      stderr,
      signal: controller.signal,
      fetchImpl: hangingFetch as typeof fetch,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await result).toBe(130);
  });
});
