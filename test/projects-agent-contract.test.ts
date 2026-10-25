import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CommentaryApiClient } from "../src/api-client.js";
import runtimeContract from "../src/projects-contract.json" with { type: "json" };
import { runCli } from "../src/cli.js";

interface FrozenProjectsContract {
  contractVersion: string;
  implementation: string;
  digest: string;
  schemas: { $id: string; $defs: Record<string, unknown> };
  operations: {
    operationId: string;
    family: string;
    action: string;
    method: string;
    scopes: string[];
    inputSchema: string;
    outputSchema: string;
    status: string;
  }[];
  failureFixtures: {
    status: number;
    exitCode: number;
    payload: {
      error: {
        version: string;
        code: string;
        message: string;
        correlationId: string;
        retryable: boolean;
      };
    };
  }[];
}

const contract = JSON.parse(
  readFileSync(new URL("../contracts/projects-agent-v1.json", import.meta.url), "utf8"),
) as FrozenProjectsContract;

// PROJECTAGENT-001: shipped commands and transport must use the same current contract.
describe("PROJECTAGENT-001 frozen Projects contracts", () => {
  it("retains implemented families without an agent Decision-write path", () => {
    expect(contract.contractVersion).toBe("1");
    expect(contract.implementation).toBe("authorized_http_mcp_sdk");
    expect(contract.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(contract.schemas.$id).toBe("https://commentary.dev/contracts/projects-agent-v1");
    expect([...new Set(contract.operations.map((operation) => operation.family))].sort()).toEqual([
      "codebase_review",
      "commentary_projects",
      "commentary_trackers",
      "project_evidence",
      "project_review_session",
      "review_package",
    ]);
    expect(contract).toEqual(runtimeContract);
    expect(contract.operations).toHaveLength(158);
    expect(new Set(contract.operations.map((operation) => operation.operationId)).size).toBe(158);
    for (const operation of contract.operations) {
      expect(operation.status).toBe("implemented");
      expect(contract.schemas.$defs).toHaveProperty(operation.inputSchema);
      expect(contract.schemas.$defs).toHaveProperty(operation.outputSchema);
      expect(operation.action).not.toMatch(/approve|decision[_-]?(?:create|write)/iu);
      expect(operation.operationId).not.toMatch(/approve|(?:create|write)Decision/iu);
      expect(operation.scopes.join(" ")).not.toMatch(/decisions?\.(?:write|create|approve)/iu);
    }
  });

  it("covers nonzero auth, stale, validation and server exit meanings", () => {
    expect(new Set(contract.failureFixtures.map((fixture) => fixture.exitCode))).toEqual(
      new Set([3, 5, 7, 8, 9]),
    );
  });

  it.each(contract.failureFixtures)(
    "preserves $payload.error.code from HTTP $status with exit $exitCode",
    async (fixture) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify(fixture.payload), {
            status: fixture.status,
            headers: { "content-type": "application/json" },
          }),
      );
      const client = new CommentaryApiClient({
        baseUrl: "https://commentary.test",
        token: "test-token",
        fetchImpl: fetchImpl as typeof fetch,
      });
      await expect(client.getInteraction({ interactionId: "ixn_fixture" })).rejects.toMatchObject({
        code: fixture.payload.error.code,
        message: fixture.payload.error.message,
        exitCode: fixture.exitCode,
        correlationId: fixture.payload.error.correlationId,
        retryable: fixture.payload.error.retryable,
      });

      let output = "";
      let errors = "";
      const exitCode = await runCli(
        [
          "--json",
          "--token",
          "test-token",
          "--base-url",
          "https://commentary.test",
          "interaction",
          "get",
          "ixn_fixture",
        ],
        {
          cwd: process.cwd(),
          stdout: { write: (chunk: string) => void (output += chunk) },
          stderr: { write: (chunk: string) => void (errors += chunk) },
          fetchImpl: fetchImpl as typeof fetch,
        },
      );
      expect(exitCode).toBe(fixture.exitCode);
      expect(exitCode).not.toBe(0);
      expect(output).toBe("");
      expect(JSON.parse(errors)).toEqual({
        ok: false,
        error: {
          code: fixture.payload.error.code,
          message: fixture.payload.error.message,
          exitCode: fixture.exitCode,
          correlationId: fixture.payload.error.correlationId,
          retryable: fixture.payload.error.retryable,
        },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
});
