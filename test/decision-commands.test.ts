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
const fingerprint = "a".repeat(64);

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function receipt(outcome = "approve", terminalState = "recorded") {
  return {
    id: "ixd_opaque",
    interactionId: "ixn_opaque",
    revisionId: "ixr_opaque",
    actionId: "ixa_opaque",
    proposalFingerprint: fingerprint,
    semanticAction: outcome,
    outcome,
    decidedAt: "2026-08-27T10:00:00.000Z",
    expiresAt: null,
    terminalState,
    purged: false,
    contentPurgedAt: null,
  };
}

function report() {
  return {
    id: "ixf_opaque",
    interactionId: "ixn_opaque",
    decisionId: "ixd_opaque",
    revisionId: "ixr_opaque",
    actionId: "ixa_opaque",
    proposalFingerprint: fingerprint,
    status: "received",
    reportingAgent: { type: "agent", id: "agent_opaque" },
    evidence: { externalReference: "provider_opaque" },
    reportedAt: "2026-08-27T10:01:00.000Z",
    contentPurgeAfter: "2026-09-26T10:01:00.000Z",
    contentPurgedAt: null,
    selfReported: true,
    verified: false,
  };
}

function runtime(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return { cwd, stdout, stderr, fetchImpl, ...extra };
}

const globals = ["--json", "--token", "test-token", "--base-url", "https://commentary.test"];

const reportArgs = [
  ...globals,
  "fulfillment",
  "report",
  "ixn_opaque",
  "--decision-id",
  "ixd_opaque",
  "--revision-id",
  "ixr_opaque",
  "--action-id",
  "ixa_opaque",
  "--proposal-fingerprint",
  fingerprint,
  "--status",
  "received",
  "--idempotency-key",
  "report-42",
  "--correlation-id",
  "run-42",
];

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "commentary-cli-decision-"));
  output = "";
  errors = "";
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(cwd, { recursive: true, force: true });
});

describe("INTERACTION-006 Decision receipt CLI", () => {
  it("gets an opaque privacy-safe receipt without exposing a Decision write", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return jsonResponse(
        {
          data: receipt(),
          polling: { complete: true, retryAfterMs: null },
        },
        200,
        { "x-correlation-id": "get-run" },
      );
    });

    const code = await runCli(
      [...globals, "decision", "get", "ixn%2Fopaque", "ixd%2Fopaque"],
      runtime(fetchImpl as typeof fetch),
    );

    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchSnapshot("decision get JSON");
    expect(requests[0]?.url).toContain(
      "/api/v1/interactions/ixn%252Fopaque/decisions?decisionId=ixd%252Fopaque",
    );
    expect(requests[0]?.init?.method ?? "GET").toBe("GET");
    expect(output).not.toContain("actor");
    expect(errors).toBe("");

    output = "";
    expect(await runCli(["decision", "--help"], { cwd, stdout, stderr })).toBe(0);
    expect(output).toContain("agents cannot approve, reject, choose, answer");
    expect(output).not.toContain("decision approve");
    expect(output).not.toContain("decision reject");
  });

  it.each([
    ["approve", "recorded", 0],
    ["acknowledge", "recorded", 0],
    ["choose", "recorded", 0],
    ["answer", "recorded", 0],
    ["comment", "recorded", 0],
    ["snooze", "recorded", 0],
    ["reject", "recorded", 10],
    ["request_revision", "recorded", 10],
    ["approve", "rejected", 10],
    ["approve", "canceled", 10],
    ["approve", "expired", 10],
  ])("maps outcome %s in state %s to exit %i", async (outcome, state, expected) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: receipt(outcome, state),
        polling: { complete: true, retryAfterMs: null },
      }),
    );

    const code = await runCli(
      [...globals, "decision", "get", "ixn_opaque", "ixd_opaque"],
      runtime(fetchImpl as typeof fetch),
    );

    expect(code).toBe(expected);
    expect(JSON.parse(output)).toMatchObject({ decision: { outcome, terminalState: state } });
    if (expected === 10) {
      expect(JSON.parse(errors)).toMatchObject({
        error: { code: "decision_negative", exitCode: 10 },
      });
    } else {
      expect(errors).toBe("");
    }
  });

  it("waits with opaque after handles and returns the first receipt", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return jsonResponse({
        data: receipt(),
        polling: { complete: true, retryAfterMs: null },
      });
    });

    const code = await runCli(
      [...globals, "decision", "wait", "ixn_opaque", "--after", "ixd_previous", "--timeout", "1"],
      runtime(fetchImpl as typeof fetch),
    );

    expect(code).toBe(0);
    expect(urls[0]).toContain("after=ixd_previous&waitMs=0");
    expect(JSON.parse(output)).toMatchObject({
      decision: { id: "ixd_opaque" },
      polling: { complete: true },
    });
  });

  it("bounds timeout and supports interruption", async () => {
    vi.useFakeTimers();
    const timeoutFetch = vi.fn(async () =>
      jsonResponse({
        data: null,
        polling: { complete: false, timedOut: false, retryAfterMs: 2_000 },
      }),
    );
    const pending = runCli(
      [...globals, "decision", "wait", "ixn_opaque", "--timeout", "1", "--poll-interval", "250"],
      runtime(timeoutFetch as typeof fetch),
    );
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await pending).toBe(124);
    expect(JSON.parse(errors)).toMatchObject({
      error: { code: "decision_wait_timeout", exitCode: 124 },
    });
    expect(timeoutFetch.mock.calls.length).toBeLessThanOrEqual(6);

    vi.useRealTimers();
    output = "";
    errors = "";
    const controller = new AbortController();
    const interruptFetch = vi.fn(async () =>
      jsonResponse({
        data: null,
        polling: { complete: false, timedOut: false, retryAfterMs: 2_000 },
      }),
    );
    const interrupted = runCli(
      [...globals, "decision", "wait", "ixn_opaque", "--timeout", "30"],
      runtime(interruptFetch as typeof fetch, { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(interruptFetch).toHaveBeenCalledOnce());
    controller.abort();
    expect(await interrupted).toBe(130);
    expect(JSON.parse(errors)).toMatchObject({ error: { exitCode: 130 } });
  });
});

describe("INTERACTION-007 Fulfillment report CLI", () => {
  it("passes the exact fingerprint and bounded evidence with retry-safe replay", async () => {
    await writeFile(
      path.join(cwd, "evidence.json"),
      JSON.stringify({ externalReference: "provider_opaque" }),
      "utf8",
    );
    const requests: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      const fulfillmentReport = report();
      return jsonResponse(
        {
          data: {
            outcome: requests.length > 1 ? "replayed" : "recorded",
            report: fulfillmentReport,
            current: fulfillmentReport,
            interaction: {
              id: "ixn_opaque",
              state: "waiting_for_agent",
              version: 3,
              resource: { type: "draft_review", id: "draft_opaque" },
              currentRevisionId: "ixr_opaque",
            },
          },
        },
        requests.length > 1 ? 200 : 201,
        {
          "x-correlation-id": "run-42",
          "idempotency-replayed": String(requests.length > 1),
        },
      );
    });
    const argv = [...reportArgs, "--evidence-file", "evidence.json"];

    expect(await runCli(argv, runtime(fetchImpl as typeof fetch))).toBe(0);
    const first = JSON.parse(output);
    output = "";
    expect(await runCli(argv, runtime(fetchImpl as typeof fetch))).toBe(0);
    const replay = JSON.parse(output);

    expect(first).toMatchSnapshot("fulfillment report JSON");
    expect(replay.idempotencyReplayed).toBe(true);
    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      decisionId: "ixd_opaque",
      revisionId: "ixr_opaque",
      actionId: "ixa_opaque",
      proposalFingerprint: fingerprint,
      status: "received",
      evidence: { externalReference: "provider_opaque" },
    });
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer test-token",
      "Idempotency-Key": "report-42",
      "X-Correlation-Id": "run-42",
    });
    expect(JSON.stringify(first)).not.toContain("externalReference");
    expect(JSON.stringify(first)).not.toContain("reportingAgent");
    expect(errors).toBe("");
  });

  it("accepts evidence from stdin and rejects mismatched fingerprints and sensitive evidence locally", async () => {
    const fetchImpl = vi.fn(async () => {
      const fulfillmentReport = report();
      return jsonResponse({
        data: {
          outcome: "recorded",
          report: fulfillmentReport,
          current: fulfillmentReport,
          interaction: {
            id: "ixn_opaque",
            state: "waiting_for_agent",
            version: 3,
            resource: { type: "draft_review", id: "draft_opaque" },
            currentRevisionId: "ixr_opaque",
          },
        },
      });
    });
    expect(
      await runCli(
        [...reportArgs, "--evidence-stdin"],
        runtime(fetchImpl as typeof fetch, {
          stdin: Readable.from(['{"externalReference":"provider_opaque"}']),
        }),
      ),
    ).toBe(0);

    output = "";
    errors = "";
    const invalidFingerprint = [...reportArgs];
    invalidFingerprint[invalidFingerprint.indexOf(fingerprint)] = fingerprint.toUpperCase();
    expect(await runCli(invalidFingerprint, runtime(fetchImpl as typeof fetch))).toBe(8);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(errors).not.toContain(fingerprint);

    errors = "";
    expect(
      await runCli(
        [...reportArgs, "--evidence-stdin"],
        runtime(fetchImpl as typeof fetch, {
          stdin: Readable.from(['{"nested":{"accessToken":"must-not-leak"}}']),
        }),
      ),
    ).toBe(8);
    expect(errors).not.toContain("must-not-leak");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [409, "interaction_conflict", 8],
    [403, "insufficient_scope", 3],
    [400, "validation_failed", 8],
    [500, "internal_error", 9],
  ])("maps HTTP %i (%s) to exit %i", async (status, errorCode, exitCode) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            version: "1",
            code: errorCode,
            message: "Report rejected.",
            correlationId: "error-run",
            retryable: status >= 500,
          },
        },
        status,
      ),
    );

    expect(await runCli(reportArgs, runtime(fetchImpl as typeof fetch))).toBe(exitCode);
    expect(JSON.parse(errors)).toMatchObject({
      error: { code: errorCode, exitCode, correlationId: "error-run" },
    });
  });

  it("maps network failures and preserves legacy Review commands", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    expect(await runCli(reportArgs, runtime(fetchImpl as typeof fetch))).toBe(4);
    expect(JSON.parse(errors)).toMatchObject({ error: { exitCode: 4 } });

    output = "";
    errors = "";
    expect(await runCli(["review", "--help"], { cwd, stdout, stderr })).toBe(0);
    expect(output).toContain("Create a draft review from files or folders.");
  });
});
