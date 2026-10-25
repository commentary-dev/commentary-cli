import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

let cwd: string, output: string, errors: string;
const prefix = [
  "--token",
  "test-token",
  "--base-url",
  "https://commentary.test",
  "--workspace",
  "workspace-1",
  "--json",
];
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "commentary-engineering-cli-"));
  output = "";
  errors = "";
  vi.stubEnv("COMMENTARY_CONFIG_DIR", path.join(cwd, "config"));
  vi.stubEnv("COMMENTARY_TOKEN", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(status >= 400 ? data : { data }), {
    status,
    headers: { "content-type": "application/json", etag: '"exact:v1"' },
  });
}
function invoke(args: string[], fetchImpl: typeof fetch, body: unknown = {}) {
  return runCli([...prefix, ...args], {
    cwd,
    fetchImpl,
    stdout: { write: (value: string) => void (output += value) },
    stderr: { write: (value: string) => void (errors += value) },
    stdin: Readable.from([JSON.stringify(body)]),
  });
}
const target = {
  resource: { type: "review_package", id: "package-1" },
  revisionId: "revision-1",
  sha256: "a".repeat(64),
};
const sha = "a".repeat(40);
const context = { type: "project_review_session", id: "session-1" };
const sourceRequest = {
  reference: { provider: "uploaded", resource: { type: "repository", id: "repository-1" } },
  capturePolicy: "full",
};
describe("PROJECTAGENT-001 PROJECTREVIEW-002 engineering HTTP contracts", () => {
  it("rejects simultaneous local source publishers without losing the active upload identity", async () => {
    await writeFile(path.join(cwd, "app.ts"), "export const counter = 1;\n");
    let entered!: () => void, release!: () => void;
    const prepared = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (pathname.endsWith("/uploads")) {
        entered();
        await unblock;
        return response({ ...body, id: "upload-1", state: "uploading", receivedChunks: [] });
      }
      if (pathname.endsWith("/chunks") || pathname.endsWith("/finalize")) return response({});
      if (pathname === "/api/v1/source-snapshots")
        return response({ id: "snapshot-1", provenance: "uploaded" });
      throw new Error(`Unexpected mocked request ${pathname}`);
    });
    const args = [
      "source-snapshot",
      "publish-directory",
      ".",
      "--stdin",
      "--idempotency-key",
      "same-source-1",
    ];
    const first = invoke(args, fetchImpl as typeof fetch, sourceRequest);
    try {
      await prepared;
      expect(await invoke(args, fetchImpl as typeof fetch, sourceRequest)).toBe(7);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      release();
      expect(await first).toBe(0);
      const metadata = JSON.parse(
        await readFile(path.join(cwd, ".commentary", "source-snapshot.json"), "utf8"),
      );
      expect(metadata.snapshotId).toBe("snapshot-1");
      await expect(
        readFile(path.join(cwd, ".commentary", "source-snapshot.json.lock")),
      ).rejects.toThrow();
    } finally {
      release();
      await first;
    }
  });
  it("returns existing canonical review routes and pins a known exact Session revision", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.includes("project-review-sessions"))
        return response({ id: "session/1", manifest: { revisionId: "revision/1", targets: [] } });
      if (pathname.includes("source-snapshots"))
        return response({ id: "snapshot/1", provenance: "uploaded" });
      return response({
        id: "evidence-1",
        context: { type: "project", id: "project/1" },
        provenance: "reported",
      });
    });
    expect(await invoke(["review-session", "get", "session/1"], fetchImpl as typeof fetch)).toBe(0);
    expect(JSON.parse(output).data.canonicalUrl).toBe(
      "https://commentary.test/review/project/session%2F1?sessionRevision=revision%2F1",
    );
    output = "";
    expect(await invoke(["source-snapshot", "get", "snapshot/1"], fetchImpl as typeof fetch)).toBe(
      0,
    );
    expect(JSON.parse(output).data.canonicalUrl).toBe(
      "https://commentary.test/review/source/snapshot%2F1",
    );
    output = "";
    expect(await invoke(["evidence", "get", "evidence-1"], fetchImpl as typeof fetch)).toBe(0);
    expect(JSON.parse(output).data).toMatchObject({
      canonicalUrl: "https://commentary.test/workspaces/workspace-1/projects/project%2F1/evidence",
      provenance: "reported",
    });
  });
  it("publishes bounded local source, resumes an interrupted snapshot response and preserves metadata without bodies", async () => {
    const source = "export const counter = 1;\n";
    await writeFile(path.join(cwd, "app.ts"), source);
    let upload: Record<string, unknown> = {};
    let completed = false,
      firstPublish = true;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (parsed.pathname.endsWith("/uploads") && init?.method === "POST") {
        upload = { ...body, id: "upload-1", state: "uploading", receivedChunks: [] };
        expect((body.manifest as { files: unknown[] }).files).toHaveLength(1);
        return response(upload);
      }
      if (parsed.pathname.endsWith("/uploads/upload-1") && init?.method === "GET")
        return response({ ...upload, state: completed ? "complete" : "uploading" });
      if (parsed.pathname.endsWith("/uploads/upload-1/chunks")) {
        expect(Buffer.from(String(body.contentBase64), "base64").toString()).toBe(source);
        return response({ received: true });
      }
      if (parsed.pathname.endsWith("/uploads/upload-1/finalize")) {
        completed = true;
        return response({ id: "upload-1", state: "complete" });
      }
      if (parsed.pathname === "/api/v1/source-snapshots") {
        expect(body.reference).toEqual({ ...sourceRequest.reference, uploadId: "upload-1" });
        if (firstPublish) {
          firstPublish = false;
          throw new Error("Disconnected after publication");
        }
        return response({
          id: "snapshot-1",
          provenance: "uploaded",
          manifestSha256: "a".repeat(64),
        });
      }
      throw new Error(`Unexpected mocked request ${parsed.pathname}`);
    });
    const args = [
      "source-snapshot",
      "publish-directory",
      ".",
      "--stdin",
      "--idempotency-key",
      "local-source-1",
      "--no-open",
    ];
    expect(await invoke(args, fetchImpl as typeof fetch, sourceRequest)).toBe(4);
    const filename = path.join(cwd, ".commentary", "source-snapshot.json");
    const pending = JSON.parse(await readFile(filename, "utf8"));
    expect(pending.pending.uploadId).toBe("upload-1");
    expect(pending.files).toEqual([]);
    errors = "";
    expect(await invoke(args, fetchImpl as typeof fetch, sourceRequest)).toBe(0);
    const metadata = await readFile(filename, "utf8");
    expect(JSON.parse(metadata)).toMatchObject({
      snapshotId: "snapshot-1",
      files: [{ path: "app.ts" }],
    });
    expect(metadata).not.toContain(source);
    expect(metadata).not.toContain("test-token");
    expect(metadata).not.toContain("repository-1");
    expect(metadata).not.toContain("pending");
    expect(fetchImpl.mock.calls.filter((call) => String(call[0]).endsWith("/chunks"))).toHaveLength(
      1,
    );
    expect(
      fetchImpl.mock.calls.filter((call) => String(call[0]).endsWith("/finalize")),
    ).toHaveLength(1);
  });
  it("local source dry-run reads a bounded source manifest without API or metadata writes", async () => {
    await writeFile(path.join(cwd, "app.ts"), "export const counter = 1;\n");
    const fetchImpl = vi.fn();
    expect(
      await invoke(
        [
          "source-snapshot",
          "publish-directory",
          ".",
          "--stdin",
          "--idempotency-key",
          "source-1",
          "--dry-run",
        ],
        fetchImpl,
        sourceRequest,
      ),
    ).toBe(0);
    expect(JSON.parse(output).data).toMatchObject({
      dryRun: true,
      provenance: "uploaded",
      files: [{ path: "app.ts" }],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readFile(path.join(cwd, ".commentary", "source-snapshot.json"))).rejects.toThrow();
  });
  it.each([
    [
      "review-session",
      "create",
      "/api/v1/project-review-sessions",
      "POST",
      { title: "Walkthrough", targets: [target] },
      true,
    ],
    [
      "review-session",
      "revision",
      "/api/v1/project-review-sessions/session%2F1/revisions",
      "POST",
      { targets: [target] },
      false,
    ],
    [
      "review-session",
      "update",
      "/api/v1/project-review-sessions/session%2F1",
      "PATCH",
      { purposeMarkdown: "Updated" },
      false,
    ],
    [
      "review-session",
      "request-review",
      "/api/v1/project-review-sessions/session%2F1/acceptance-requests",
      "POST",
      {
        target: {
          version: 1,
          sessionId: "session/1",
          scope: "session",
          sessionRevisionId: "revision-1",
          manifestSha256: "a".repeat(64),
          revisionSetFingerprint: "b".repeat(64),
          targets: [target],
          supportingRevisions: [],
        },
        consequence: "Accept this exact revision",
      },
      false,
    ],
    [
      "source-snapshot",
      "publish",
      "/api/v1/source-snapshots",
      "POST",
      {
        reference: {
          provider: "github",
          resource: { type: "repository", id: "repository-1" },
          commitSha: sha,
        },
        capturePolicy: "selected",
        selectedPaths: ["src/app.ts"],
      },
      true,
    ],
    [
      "source-snapshot",
      "publish",
      "/api/v1/source-snapshots",
      "POST",
      {
        reference: {
          provider: "uploaded",
          resource: { type: "repository", id: "repository-1" },
          uploadId: "upload-1",
        },
        capturePolicy: "full",
      },
      true,
    ],
    [
      "evidence",
      "attach",
      "/api/v1/project-evidence",
      "POST",
      {
        context,
        title: "Caller test report",
        targets: [target],
        report: { format: "json", content: '{"passed":true}' },
        result: "passed",
      },
      false,
    ],
    [
      "evidence",
      "reconcile",
      "/api/v1/project-evidence/evidence%2F1",
      "PATCH",
      { result: "failed" },
      false,
    ],
    [
      "evidence",
      "request-verification",
      "/api/v1/project-evidence/evidence%2F1/verification",
      "POST",
      {
        evidenceRevisionId: "evidence-revision-1",
        provider: "github",
        runId: "run-1",
        commitSha: sha,
      },
      false,
    ],
  ] as const)(
    "transports %s %s with exact versions and workspace",
    async (family, command, route, method, body, injectWorkspace) => {
      const args: string[] = [family, command];
      if (family === "review-session" && command !== "create") args.push("session/1");
      if (family === "evidence" && command !== "attach") args.push("evidence/1");
      args.push("--stdin", "--idempotency-key", "retry-1", "--correlation-id", "correlation-1");
      if (
        ["revision", "update", "request-review", "reconcile", "request-verification"].includes(
          command,
        )
      )
        args.push("--etag", '"exact:v1"');
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(new URL(String(url)).pathname).toBe(route);
        expect(init?.method).toBe(method);
        expect(init?.headers).toMatchObject({
          authorization: "Bearer test-token",
          "X-Commentary-Workspace-Id": "workspace-1",
          "Idempotency-Key": "retry-1",
          "X-Commentary-Contract-Version": "1",
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          ...body,
          ...(injectWorkspace ? { workspaceId: "workspace-1" } : {}),
        });
        return response({
          id: "resource-1",
          revisionId: "revision-1",
          provenance: "reported",
          result: "passed",
          canonicalUrl: "https://commentary.test/review/1",
        });
      });
      expect(await invoke(args, fetchImpl as typeof fetch, body)).toBe(0);
      expect(errors).toBe("");
      expect(JSON.parse(output).data).toMatchObject({
        provenance: "reported",
        revisionId: "revision-1",
        result: "passed",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it("encodes hosted tree/file windows and evidence typed context without source fallback", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.includes("/source-snapshots/")) {
        expect(parsed.pathname).toBe("/api/v1/source-snapshots/snapshot%2F1/file");
        expect(parsed.searchParams.get("path")).toBe("src/app.ts");
        expect(parsed.searchParams.get("startLine")).toBe("10");
        expect(parsed.searchParams.get("lineCount")).toBe("25");
      } else {
        expect(JSON.parse(parsed.searchParams.get("context")!)).toEqual(context);
        expect(parsed.searchParams.get("archived")).toBe("false");
        expect(parsed.searchParams.get("cursor")).toBe("opaque+/=");
      }
      return response({ items: [], nextCursor: null });
    });
    expect(
      await invoke(
        [
          "source-snapshot",
          "file",
          "snapshot/1",
          "--path",
          "src/app.ts",
          "--start-line",
          "10",
          "--line-count",
          "25",
        ],
        fetchImpl as typeof fetch,
      ),
    ).toBe(0);
    expect(
      await invoke(
        [
          "evidence",
          "list",
          "--context",
          JSON.stringify(context),
          "--archived",
          "false",
          "--cursor",
          "opaque+/=",
        ],
        fetchImpl as typeof fetch,
      ),
    ).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["source-snapshot", "file", "snapshot-1", "--path", "../private", "--line-count", "10"],
    ["source-snapshot", "file", "snapshot-1", "--path", "src/app.ts", "--line-count", "1001"],
    ["source-snapshot", "file", "snapshot-1", "--path", "src/app.ts", "--start-line", "0"],
    ["evidence", "list", "--context", "[]"],
    ["evidence", "list", "--context", JSON.stringify(context), "--archived", "yes"],
  ])("rejects invalid bounded query %j before HTTP", async (...args) => {
    const fetchImpl = vi.fn();
    expect(await invoke(args, fetchImpl)).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("retains denied private-source diagnostic and does not retry authorization", async () => {
    const fetchImpl = vi.fn(async () =>
      response(
        {
          error: {
            code: "source_access_revoked",
            message: "Source access revoked",
            retryable: false,
          },
        },
        403,
      ),
    );
    expect(await invoke(["source-snapshot", "get", "snapshot-1"], fetchImpl as typeof fetch)).toBe(
      3,
    );
    expect(JSON.parse(errors).error.code).toBe("source_access_revoked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("reports old server capability absence and preserves exact stale mutation", async () => {
    expect(
      await invoke(
        ["review-session", "get", "session-1"],
        vi.fn(async () => new Response("", { status: 404 })) as typeof fetch,
      ),
    ).toBe(8);
    expect(JSON.parse(errors).error.code).toBe("capability_unsupported");
    errors = "";
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: "precondition_failed", message: "Stale exact revision" } }, 412),
    );
    expect(
      await invoke(
        [
          "evidence",
          "reconcile",
          "evidence-1",
          "--stdin",
          "--etag",
          '"exact:v1"',
          "--idempotency-key",
          "reconcile-1",
        ],
        fetchImpl as typeof fetch,
        { result: "failed" },
      ),
    ).toBe(7);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("retrieves durable correction feedback as a bounded page", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/v1/project-review-sessions/session-1/feedback");
      expect(parsed.searchParams.get("cursor")).toBe("opaque-old");
      expect(parsed.searchParams.get("waitMs")).toBe("10000");
      return response({
        items: [
          {
            id: "correction-1",
            eventType: "review.comment_created.v1",
            retrievalUrl: "/api/v1/project-review-sessions/session-1/discussion",
          },
        ],
        nextCursor: "opaque-next",
        hasMore: false,
        outcome: "events",
      });
    });
    expect(
      await invoke(
        ["review-session", "feedback", "session-1", "--cursor", "opaque-old", "--wait-ms", "10000"],
        fetchImpl as typeof fetch,
      ),
    ).toBe(0);
    expect(JSON.parse(output).data.nextCursor).toBe("opaque-next");
  });
  it("adds an exact Resource by conditional immutable revision and rejects filtered manifests", async () => {
    const manifest = {
      manifestVersion: 1,
      sessionId: "session-1",
      revisionId: "session-revision-1",
      targets: [target],
    };
    const canonical = JSON.stringify({
      manifestVersion: 1,
      revisionId: "session-revision-1",
      sessionId: "session-1",
      targets: [
        {
          resource: { id: "package-1", type: "review_package" },
          revisionId: "revision-1",
          sha256: "a".repeat(64),
        },
      ],
    });
    const hash = createHash("sha256").update(canonical).digest("hex");
    const other = { ...target, revisionId: "revision-2", sha256: "b".repeat(64) };
    let filtered = false;
    const fetchImpl = vi.fn(async (_url, init) => {
      if (init?.method === "GET")
        return response({
          manifest: { ...manifest, targets: filtered ? [] : [target] },
          manifestSha256: hash,
        });
      expect(JSON.parse(String(init?.body))).toEqual({ targets: [target, other] });
      expect(init?.headers).toMatchObject({ "If-Match": '"exact:v1"' });
      return response({ manifest: { ...manifest, targets: [target, other] } });
    });
    const args = [
      "review-session",
      "resources",
      "link",
      "session-1",
      "--stdin",
      "--etag",
      '"exact:v1"',
      "--idempotency-key",
      "link-1",
    ];
    expect(await invoke(args, fetchImpl as typeof fetch, { target: other })).toBe(0);
    filtered = true;
    expect(await invoke(args, fetchImpl as typeof fetch, { target: other })).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("exposes no CLI operation for agents to approve human Decisions", async () => {
    const fetchImpl = vi.fn();
    expect(await invoke(["review-session", "approve", "session-1"], fetchImpl)).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
