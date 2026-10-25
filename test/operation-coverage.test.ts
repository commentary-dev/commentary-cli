import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { buildProgram, runCli } from "../src/cli.js";
import type { Command } from "commander";
import catalog from "../src/projects-contract.json" with { type: "json" };

// PROJECTAGENT-001: every implemented operation must have a reachable command or
// an explicit directory publication step, independently of the schema snapshot.
const workflows: Record<string, string[]> = {
  preparePackageUpload: ["package", "publish"],
  transferPackageChunk: ["package", "publish"],
  finalizePackageUpload: ["package", "publish"],
  publishReviewPackage: ["package", "publish"],
  publishPackageRevision: ["package", "sync"],
  getPackageUpload: ["package", "upload", "status"],
  getReviewPackage: ["package", "get"],
  listPackageRevisions: ["package", "revisions"],
  getPackageManifest: ["package", "manifest"],
  listPackageComments: ["package", "comments"],
  listPackageActivity: ["package", "activity"],
  listPackageFeedback: ["package", "feedback"],
};
const sink = { write: () => {} };
const runtime = { cwd: process.cwd(), stdout: sink, stderr: sink };
function allCommands(command: Command): Command[] {
  return command.commands.flatMap((child) => [child, ...allCommands(child)]);
}

describe("PROJECTAGENT-001 current CLI operation coverage", () => {
  const program = buildProgram(runtime);
  const commands = allCommands(program);
  it.each(catalog.operations)("exposes $operationId", (operation) => {
    expect(operation.status).toBe("implemented");
    const workflow = workflows[operation.operationId];
    if (workflow) {
      let command: Command | undefined = program;
      for (const name of workflow)
        command = command?.commands.find((child) => child.name() === name);
      expect(command, `${operation.operationId}: ${workflow.join(" ")}`).toBeDefined();
    } else {
      expect(
        commands.filter((command) => command.description().startsWith(`${operation.operationId};`)),
      ).toHaveLength(1);
    }
  });

  it("sends a review invitation independently from the legacy exact acceptance request", async () => {
    const body = {
      manifestSha256: "a".repeat(64),
      recipientIds: ["reviewer-1"],
      messageMarkdown: "Review this version.",
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe(
        "/api/v1/project-review-sessions/session%2F1/review-requests",
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "If-Match": '"v1"', "Idempotency-Key": "invite-1" });
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return new Response(JSON.stringify({ data: { id: "request-1" } }), {
        headers: { "content-type": "application/json" },
      });
    });
    expect(
      await runCli(
        [
          "--token",
          "test-token",
          "--json",
          "review-session",
          "request",
          "review",
          "session/1",
          "--stdin",
          "--etag",
          '"v1"',
          "--idempotency-key",
          "invite-1",
        ],
        {
          ...runtime,
          fetchImpl: fetchImpl as typeof fetch,
          stdin: Readable.from([JSON.stringify(body)]),
        },
      ),
    ).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("compares exact guide revisions with a typed bounded offset", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const request = new URL(String(url));
      expect(request.pathname).toBe("/api/v1/project-review-sessions/session%2F1/impact");
      expect(Object.fromEntries(request.searchParams)).toEqual({
        fromRevisionId: "before",
        toRevisionId: "after",
        offset: "25",
      });
      return new Response(JSON.stringify({ data: { items: [], nextOffset: null } }), {
        headers: { "content-type": "application/json" },
      });
    });
    const args = [
      "--token",
      "test-token",
      "--json",
      "review-session",
      "impact",
      "compare",
      "session/1",
      "--from-revision-id",
      "before",
      "--to-revision-id",
      "after",
      "--offset",
    ];
    expect(
      await runCli([...args, "25"], { ...runtime, fetchImpl: fetchImpl as typeof fetch }),
    ).toBe(0);
    expect(
      await runCli([...args, "-1"], { ...runtime, fetchImpl: fetchImpl as typeof fetch }),
    ).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
