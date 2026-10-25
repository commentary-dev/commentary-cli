import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import catalog from "../src/projects-contract.json" with { type: "json" };
import { setStoredToken } from "../src/config.js";

let cwd: string, output: string, errors: string;
const auth = [
  "--token",
  "test-token",
  "--base-url",
  "https://commentary.test",
  "--workspace",
  "workspace-1",
  "--json",
];
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "commentary-project-cli-"));
  output = "";
  errors = "";
  vi.stubEnv("COMMENTARY_CONFIG_DIR", path.join(cwd, "config"));
  vi.stubEnv("COMMENTARY_TOKEN", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});
function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(status >= 400 ? data : { data }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
function invoke(args: string[], fetchImpl: typeof fetch, body: unknown = {}, prefix = auth) {
  return runCli([...prefix, ...args], {
    cwd,
    stdout: { write: (v: string) => void (output += v) },
    stderr: { write: (v: string) => void (errors += v) },
    stdin: Readable.from([typeof body === "string" ? body : JSON.stringify(body)]),
    fetchImpl,
  });
}
const contract = {
  kind: "commentary_tracker",
  contractVersion: 1,
  name: "Readiness",
  fields: [{ id: "title", type: "text", label: "Work", required: true }],
  views: [],
};
const bundle = {
  kind: "commentary_tracker_export",
  formatVersion: 1,
  tracker: {
    id: "tracker-1",
    version: 1,
    schemaRevisionId: "schema-1",
    orderVersion: 1,
    lifecycle: "active",
  },
  schemas: [{ id: "schema-1", contentHash: "sha256:" + "a".repeat(64), contract }],
  records: [],
  views: [],
  history: [],
  receipts: [],
};
const definition = { key: "list", renderer: "list", mappings: { title: "title" } };
const sha = "a".repeat(40);
// Independent public HTTP fixtures: command spelling, operation ID and body.
const cases: [string[], string, Record<string, unknown>?][] = [
  [["project", "create"], "createProject", { name: "Readiness" }],
  [["project", "list"], "listProjects"],
  [["project", "get"], "getProject"],
  [["project", "update"], "updateProject", { name: "Revised" }],
  [["project", "archive"], "archiveProject"],
  [["project", "restore"], "restoreProject"],
  [["project", "complete"], "completeProject"],
  [["project", "resources", "list"], "listProjectResources"],
  [
    ["project", "resources", "link"],
    "linkProjectResource",
    { target: { type: "tracker", id: "tracker-1" } },
  ],
  [["project", "resources", "unlink"], "unlinkProjectResource"],
  [["project", "relationships", "list"], "listProjectRelationships"],
  [
    ["project", "relationships", "link"],
    "linkProjectRelationship",
    { targetProjectId: "project-2", relation: "related" },
  ],
  [["project", "relationships", "unlink"], "unlinkProjectRelationship"],
  [["project", "participants", "list"], "listProjectParticipants"],
  [
    ["project", "participants", "set"],
    "setProjectParticipant",
    { actor: { type: "agent", id: "agent-1" }, role: "contributor", grantId: "grant-1" },
  ],
  [["project", "participants", "remove"], "removeProjectParticipant"],
  [["project", "references", "list"], "listProjectExternalReferences"],
  [
    ["project", "references", "link"],
    "linkProjectExternalReference",
    { url: "https://example.com/document" },
  ],
  [["project", "references", "unlink"], "unlinkProjectExternalReference"],
  [["project", "history"], "listProjectChanges"],
  [["project", "workspaces", "link"], "linkProjectWorkspace", { workspaceId: "workspace-1" }],
  [["tracker", "validate"], "validateTrackerContract", { contract }],
  [["tracker", "create"], "createTracker", { contract }],
  [["tracker", "list"], "listTrackers"],
  [["tracker", "get"], "getTracker"],
  [["tracker", "update"], "updateTracker", { visibility: "workspace" }],
  [["tracker", "archive"], "archiveTracker"],
  [["tracker", "restore"], "restoreTracker"],
  [["tracker", "schema", "get"], "getTrackerSchema"],
  [["tracker", "schema", "list"], "listTrackerSchemas"],
  [
    ["tracker", "schema", "preview"],
    "previewTrackerSchema",
    { contract, expectedSchemaRevisionId: "schema-1" },
  ],
  [
    ["tracker", "schema", "apply"],
    "applyTrackerSchema",
    { contract, expectedSchemaRevisionId: "schema-1" },
  ],
  [
    ["tracker", "records", "query"],
    "queryTrackerRecords",
    { query: { limit: 10, archived: false } },
  ],
  [["tracker", "records", "get"], "getTrackerRecord"],
  [["tracker", "records", "history"], "listTrackerRecordHistory"],
  [
    ["tracker", "records", "create"],
    "createTrackerRecord",
    { schemaRevisionId: "schema-1", values: { title: "Work", enabled: false, count: 0 } },
  ],
  [
    ["tracker", "records", "update"],
    "patchTrackerRecord",
    {
      schemaRevisionId: "schema-1",
      patch: { values: { title: "Updated", enabled: false, count: 0 }, unset: [] },
    },
  ],
  [["tracker", "records", "archive"], "archiveTrackerRecord"],
  [
    ["tracker", "records", "bulk"],
    "bulkTrackerRecords",
    {
      schemaRevisionId: "schema-1",
      items: [
        { recordId: "record-1", etag: '"record-1:v1"', patch: { values: { title: "Work" } } },
      ],
    },
  ],
  [
    ["tracker", "records", "reorder"],
    "reorderTrackerRecords",
    { recordIds: ["record-1"], expectedOrderVersion: 1 },
  ],
  [["tracker", "views", "list"], "listTrackerViews"],
  [["tracker", "views", "get"], "getTrackerView"],
  [["tracker", "views", "create"], "createTrackerView", { definition, visibility: "shared" }],
  [["tracker", "views", "update"], "updateTrackerView", { definition }],
  [["tracker", "views", "delete"], "deleteTrackerView"],
  [["tracker", "export"], "exportTracker"],
  [
    ["tracker", "import", "preview"],
    "previewTrackerImport",
    { bundle, mode: "reconcile-existing", expectedSchemaRevisionId: "schema-1" },
  ],
  [["tracker", "import", "new-preview"], "previewNewTrackerImport", { bundle, mode: "clone" }],
  [
    ["tracker", "import", "apply"],
    "applyTrackerImport",
    { previewId: "preview-1", expectedSchemaRevisionId: "schema-1" },
  ],
  [["tracker", "import", "get"], "getTrackerImport"],
  [["tracker", "import", "cancel"], "cancelTrackerImport"],
  [
    ["tracker", "authority", "preview"],
    "previewTrackerAuthority",
    { mode: "commentary", expectedSchemaRevisionId: "schema-1" },
  ],
  [
    ["tracker", "authority", "apply"],
    "migrateTrackerAuthority",
    { mode: "commentary", previewId: "preview-1", expectedSchemaRevisionId: "schema-1" },
  ],
  [
    ["tracker", "proposals", "stage"],
    "stageTrackerProposal",
    { bundle, expectedSchemaRevisionId: "schema-1", baseCommitSha: sha },
  ],
  [
    ["tracker", "sync", "bind"],
    "bindTrackerGitSource",
    { sourceRef: "refs/heads/main", baseCommitSha: sha },
  ],
  [["tracker", "sync", "status"], "getTrackerSync"],
  [["tracker", "sync", "proposal"], "getTrackerSyncProposal"],
  [["tracker", "sync", "preview"], "previewTrackerSync", { baseCommitSha: sha }],
  [["tracker", "sync", "apply"], "applyTrackerSync", { operationId: "sync-1", baseCommitSha: sha }],
  [
    ["tracker", "sync", "resolve"],
    "resolveTrackerSync",
    { operationId: "sync-1", resolutions: [] },
  ],
  [["tracker", "sync", "retry"], "retryTrackerSync", { operationId: "sync-1", baseCommitSha: sha }],
  [["tracker", "sync", "cancel"], "cancelTrackerSync", { operationId: "sync-1" }],
  [["tracker", "sync", "refresh"], "refreshTrackerGitSource"],
  [["project", "status"], "getProjectStatus"],
  [["project", "progress", "policy", "get"], "getProjectProgressPolicy"],
  [
    ["project", "progress", "policy", "set"],
    "setProjectProgressPolicy",
    { policy: { completeValues: [], rules: [] } },
  ],
  [["tracker", "progress", "policy", "get"], "getTrackerProgressPolicy"],
  [
    ["tracker", "progress", "policy", "set"],
    "setTrackerProgressPolicy",
    { policy: { completeValues: [], rules: [] } },
  ],
  [["tracker", "renderers", "list"], "listTrackerRenderers"],
  [
    ["tracker", "renderers", "manage"],
    "manageTrackerRendererPublication",
    { action: "revokePublication", publicationId: "publication-1" },
  ],
  [["tracker", "review", "progress"], "getTrackerReviewProgress"],
  [["tracker", "review", "reconcile"], "reconcileTrackerReviewProgress"],
  [
    ["tracker", "review", "relation", "set"],
    "configureTrackerReviewRelation",
    {
      target: {
        version: 1,
        sessionId: "session-1",
        sessionRevisionId: "session-revision-1",
        revisionSetFingerprint: "b".repeat(64),
        manifestSha256: "c".repeat(64),
        scope: "session",
        targets: [
          {
            resource: { type: "review_package", id: "package-1" },
            revisionId: "package-revision-1",
            sha256: "a".repeat(64),
          },
        ],
        supportingRevisions: [],
      },
      acceptanceRequired: false,
      expectedRelationVersion: 0,
    },
  ],
  [
    ["tracker", "review", "relation", "remove"],
    "removeTrackerReviewRelation",
    { expectedRelationVersion: 1 },
  ],
  [["project", "activity"], "listProjectActivity"],
  [["project", "feedback"], "listProjectFeedback"],
  [["tracker", "activity"], "listTrackerActivity"],
  [["tracker", "feedback"], "listTrackerFeedback"],
];

describe("PROJECTAGENT-001 TRACKER-006 TRACKER-007 HTTP command contract", () => {
  it.each(cases)(
    "routes %j through %s with exact conditional metadata",
    async (command, operationId, payload) => {
      const operation = catalog.operations.find((item) => item.operationId === operationId)!;
      const params = [...operation.path.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!);
      const values: Record<string, string> = {
        projectId: "project/1",
        trackerId: "tracker/1",
        recordId: "record/1",
        viewId: "view/1",
        linkId: "link/1",
        relationshipId: "relationship/1",
        participantId: "participant/1",
        referenceId: "reference/1",
        previewId: "preview/1",
        operationId: "operation/1",
        sessionId: "session/1",
      };
      const args = [...command];
      for (const key of params)
        args.push(
          ...(key === "projectId"
            ? ["--project", values[key]!]
            : key === "trackerId"
              ? ["--tracker", values[key]!]
              : [values[key]!]),
        );
      if (payload) args.push("--stdin");
      if (operation.ifMatch) args.push("--etag", '"exact:v1"');
      if (operation.idempotencyKey) args.push("--idempotency-key", "retry-1");
      if (operation.scopes.includes("commentary.trackers.writeback"))
        args.push("--provider-intent");
      args.push("--correlation-id", "correlation-1");
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(new URL(String(url)).pathname).toBe(
          operation.path.replace(/\{(\w+)\}/gu, (_, key: string) =>
            encodeURIComponent(values[key]!),
          ),
        );
        expect(init?.method).toBe(operation.method);
        expect(init?.headers).toMatchObject({
          authorization: "Bearer test-token",
          "X-Commentary-Workspace-Id": "workspace-1",
          "X-Commentary-Contract-Version": "1",
          "X-Correlation-Id": "correlation-1",
          ...(operation.ifMatch ? { "If-Match": '"exact:v1"' } : {}),
          ...(operation.idempotencyKey ? { "Idempotency-Key": "retry-1" } : {}),
        });
        if (operation.method !== "GET")
          expect(JSON.parse(String(init?.body))).toEqual({
            ...(payload ?? {}),
            ...(["createProject", "createTracker", "previewNewTrackerImport"].includes(operationId)
              ? { workspaceId: "workspace-1" }
              : {}),
          });
        const properties = (
          catalog.schemas.$defs as Record<string, { properties?: Record<string, unknown> }>
        )[operation.inputSchema]!.properties!;
        if (operation.method === "GET" && properties.limit)
          expect(new URL(String(url)).searchParams.get("limit")).toBe("25");
        if (operation.method === "GET" && properties.workspaceId)
          expect(new URL(String(url)).searchParams.get("workspaceId")).toBe("workspace-1");
        return response(
          {
            id: "resource-1",
            permissions: { canRead: true },
            nextCursor: "opaque-next",
            diagnostics: [],
          },
          200,
          {
            etag: '"exact:v2"',
            "x-correlation-id": "correlation-1",
            "idempotency-replayed": "true",
          },
        );
      });
      expect(await invoke(args, fetchImpl as typeof fetch, payload), errors).toBe(0);
      expect(errors).toBe("");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        data: { id: "resource-1", nextCursor: "opaque-next", permissions: { canRead: true } },
        etag: '"exact:v2"',
        correlationId: "correlation-1",
        idempotencyReplayed: true,
      });
    },
  );
  it("covers the entire implemented Project/Tracker catalog", () => {
    expect(cases.map((item) => item[1]).sort()).toEqual(
      catalog.operations
        .filter(
          (item) =>
            ["commentary_projects", "commentary_trackers"].includes(item.family) &&
            item.status === "implemented",
        )
        .map((item) => item.operationId)
        .sort(),
    );
  });
  it.each(["status", "activity", "feedback"])(
    "preserves older-server diagnostics for newly implemented project %s",
    async (name) => {
      const fetchImpl = vi.fn(async () =>
        response(
          { error: { code: "capability_unsupported", message: "Unavailable on this server" } },
          400,
        ),
      );
      expect(await invoke(["project", name, "--project", "project-1"], fetchImpl)).toBe(8);
      expect(JSON.parse(errors).error.code).toBe("capability_unsupported");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it("uses core YAML and keeps false, zero and unset patches", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaRevisionId: "schema-1",
        patch: { values: { enabled: false, count: 0, notes: "" }, unset: [] },
      });
      return response({ id: "record-1" });
    });
    const yaml =
      'schemaRevisionId: schema-1\npatch:\n  values:\n    enabled: false\n    count: 0\n    notes: ""\n  unset: []\n';
    expect(
      await invoke(
        [
          "tracker",
          "records",
          "update",
          "record-1",
          "--tracker",
          "tracker-1",
          "--stdin",
          "--etag",
          '"record-1:v1"',
          "--idempotency-key",
          "edit-1",
        ],
        fetchImpl as typeof fetch,
        yaml,
      ),
    ).toBe(0);
  });
  it.each([
    "contract: !custom x",
    "contract: .nan",
    "contract: &a {kind: commentary_tracker}\nother: *a",
    "name: first\nname: second",
    '{"__proto__": {"polluted": true}}',
    JSON.stringify({ contract: { ...contract, contractVersion: 2 } }),
  ])("rejects unsafe/invalid payload %s without HTTP", async (body) => {
    const fetchImpl = vi.fn();
    expect(await invoke(["tracker", "validate", "--stdin"], fetchImpl, body)).toBe(8);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reports authoritative field paths and schema version diagnostics", async () => {
    expect(
      await invoke(["tracker", "validate", "--stdin"], vi.fn(), {
        contract: { ...contract, contractVersion: 2 },
      }),
    ).toBe(8);
    expect(JSON.parse(errors).error.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$/contract/contractVersion" }),
    );
  });
  it("preserves a stale stdin edit, refetches and never overwrites", async () => {
    const body = { schemaRevisionId: "schema-1", patch: { values: { title: "Proposed" } } };
    const fetchImpl = vi.fn(async (_url, init) =>
      init?.method === "PATCH"
        ? response(
            {
              error: {
                code: "precondition_failed",
                message: "Stale",
                correlationId: "cor-1",
                retryable: false,
              },
            },
            412,
          )
        : response({ id: "record-1", values: { title: "Concurrent" } }, 200, {
            etag: '"record-1:v2"',
          }),
    );
    expect(
      await invoke(
        [
          "tracker",
          "records",
          "update",
          "record-1",
          "--tracker",
          "tracker-1",
          "--stdin",
          "--etag",
          '"record-1:v1"',
          "--idempotency-key",
          "edit-1",
        ],
        fetchImpl as typeof fetch,
        body,
      ),
    ).toBe(7);
    const error = JSON.parse(errors).error;
    expect(error.reconciliation.currentEtag).toBe('"record-1:v2"');
    const saved = JSON.parse(await readFile(error.reconciliation.recoveryFile, "utf8"));
    expect(saved.body).toEqual(body);
    expect(saved.etag).toBe('"record-1:v1"');
    expect(JSON.stringify(saved)).not.toContain("test-token");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(output).toBe("");
  });
  it("passes opaque pagination without decoding and bounds pages", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const query = new URL(String(url)).searchParams;
      expect(query.get("cursor")).toBe("opaque+/=");
      expect(query.get("limit")).toBe("100");
      return response({ items: [], nextCursor: null });
    });
    expect(
      await invoke(
        ["tracker", "list", "--cursor", "opaque+/=", "--limit", "100"],
        fetchImpl as typeof fetch,
      ),
    ).toBe(0);
    expect(await invoke(["tracker", "list", "--limit", "101"], fetchImpl as typeof fetch)).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("requires explicit provider intent and retains Azure unsupported diagnostics", async () => {
    const args = [
      "tracker",
      "sync",
      "apply",
      "--tracker",
      "tracker-1",
      "--stdin",
      "--etag",
      '"tracker-1:v1"',
      "--idempotency-key",
      "sync-1",
    ];
    const fetchImpl = vi.fn(async () =>
      response(
        {
          error: {
            code: "unsupported_provider_write",
            message: "Azure supports authorized reads; write dispatch is unsupported.",
            retryable: false,
          },
        },
        400,
      ),
    );
    expect(
      await invoke(args, fetchImpl as typeof fetch, { operationId: "sync-1", baseCommitSha: sha }),
    ).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    errors = "";
    expect(
      await invoke([...args, "--provider-intent"], fetchImpl as typeof fetch, {
        operationId: "sync-1",
        baseCommitSha: sha,
      }),
    ).toBe(8);
    expect(JSON.parse(errors).error.code).toBe("unsupported_provider_write");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("never falls back from a missing profile", async () => {
    await setStoredToken("https://commentary.test", { accessToken: "default-token" });
    const fetchImpl = vi.fn();
    const prefix = [
      "--base-url",
      "https://commentary.test",
      "--json",
      "--profile",
      "missing",
      "--workspace",
      "workspace-1",
    ];
    expect(await invoke(["tracker", "list"], fetchImpl, {}, prefix)).toBe(3);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reads exactly one file/stdin and rejects mismatched workspace", async () => {
    await writeFile(path.join(cwd, "request.yaml"), "name: Readiness\n");
    const fetchImpl = vi.fn(async () => response({ id: "project-1" }));
    expect(
      await invoke(
        ["project", "create", "--file", "request.yaml", "--idempotency-key", "create-1"],
        fetchImpl as typeof fetch,
      ),
    ).toBe(0);
    expect(
      await invoke(
        ["project", "create", "--file", "request.yaml", "--stdin", "--idempotency-key", "create-2"],
        fetchImpl as typeof fetch,
      ),
    ).toBe(2);
    expect(
      await invoke(
        ["project", "create", "--stdin", "--idempotency-key", "create-3"],
        fetchImpl as typeof fetch,
        { name: "Readiness", workspaceId: "other" },
      ),
    ).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("writes a canonical portable export once without credentials or session metadata", async () => {
    const fetchImpl = vi.fn(async () => response(bundle));
    expect(
      await invoke(
        ["tracker", "export", "--tracker", "tracker-1", "--output", "tracker.json"],
        fetchImpl as typeof fetch,
      ),
    ).toBe(0);
    expect(JSON.parse(await readFile(path.join(cwd, "tracker.json"), "utf8"))).toEqual(bundle);
    await expect(readFile(path.join(cwd, ".commentary", "session.json"))).rejects.toThrow();
  });
  it("rejects credentials and overlarge input before sending or preserving", async () => {
    const fetchImpl = vi.fn();
    expect(
      await invoke(["project", "create", "--stdin", "--idempotency-key", "create-1"], fetchImpl, {
        name: "comm_pat_" + "a".repeat(20),
      }),
    ).toBe(6);
    expect(
      await invoke(["tracker", "validate", "--stdin"], fetchImpl, "x".repeat(16 * 1024 * 1024 + 1)),
    ).toBe(8);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

it("TRACKER-006 validates a raw YAML contract and previews a canonical export with explicit mode", async () => {
  const fetchImpl = vi.fn(async (_url, init) => response(JSON.parse(String(init?.body))));
  expect(
    await invoke(["tracker", "validate", "--stdin"], fetchImpl as typeof fetch, contract),
  ).toBe(0);
  expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({ contract });
  output = "";
  expect(
    await invoke(
      [
        "tracker",
        "import",
        "new-preview",
        "--stdin",
        "--mode",
        "clone",
        "--dry-run",
        "--idempotency-key",
        "preview-1",
      ],
      fetchImpl as typeof fetch,
      bundle,
    ),
  ).toBe(0);
  expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body))).toEqual({
    workspaceId: "workspace-1",
    bundle,
    mode: "clone",
  });
  expect(JSON.parse(output).idempotencyReplayed).toBeNull();
});

it("PROJECTAGENT-001 preserves server semantic field diagnostics and treats older-server absence actionably", async () => {
  const fetchImpl = vi.fn(async () =>
    response(
      {
        error: {
          code: "schema_incompatible",
          message: "Invalid mapping",
          details: [{ field: "$/contract/views/0/mappings", issue: "UNKNOWN_FIELD" }],
        },
      },
      400,
    ),
  );
  expect(
    await invoke(["tracker", "validate", "--stdin"], fetchImpl as typeof fetch, { contract }),
  ).toBe(8);
  expect(JSON.parse(errors).error.diagnostics).toEqual([
    { field: "$/contract/views/0/mappings", issue: "UNKNOWN_FIELD" },
  ]);
  errors = "";
  expect(
    await invoke(
      ["tracker", "get", "--tracker", "tracker-1"],
      vi.fn(async () => new Response("", { status: 404 })) as typeof fetch,
    ),
  ).toBe(8);
  expect(JSON.parse(errors).error.code).toBe("capability_unsupported");
});

it("TRACKER-007 does not preserve a nonexistent submitted payload for a read-only sync conflict", async () => {
  const fetchImpl = vi.fn(async () =>
    response({ error: { code: "version_conflict", message: "No approved Git binding" } }, 409),
  );
  expect(
    await invoke(
      ["tracker", "sync", "status", "--tracker", "tracker-1"],
      fetchImpl as typeof fetch,
    ),
  ).toBe(8);
  expect(JSON.parse(errors).error.reconciliation).toBeUndefined();
  await expect(readFile(path.join(cwd, ".commentary", "conflicts"))).rejects.toThrow();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
