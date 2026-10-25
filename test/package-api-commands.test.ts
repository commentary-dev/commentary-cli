import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentaryApiClient } from "../src/api-client.js";
import { runCli } from "../src/cli.js";

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
  cwd = await mkdtemp(path.join(os.tmpdir(), "commentary-package-api-cli-"));
  output = "";
  errors = "";
  vi.stubEnv("COMMENTARY_CONFIG_DIR", path.join(cwd, "config"));
  vi.stubEnv("COMMENTARY_TOKEN", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});
function jsonResponse(data: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json", ...headers },
  });
}
function invoke(args: string[], fetchImpl: typeof fetch, body: unknown = {}, signal?: AbortSignal) {
  return runCli([...auth, ...args], {
    cwd,
    stdout: { write: (value: string) => void (output += value) },
    stderr: { write: (value: string) => void (errors += value) },
    stdin: Readable.from([JSON.stringify(body)]),
    signal,
    fetchImpl,
  });
}

describe("package API adapters", () => {
  it.each([
    {
      args: ["package", "upload", "cancel", "upload-1", "--idempotency-key", "cancel-1"],
      path: "/api/v1/review-packages/uploads/upload-1",
      method: "DELETE",
      body: {},
      query: "",
      key: "cancel-1",
    },
    {
      args: [
        "package",
        "indexing",
        "retry",
        "package-1",
        "revision-2",
        "--idempotency-key",
        "retry-1",
      ],
      path: "/api/v1/review-packages/package-1/revisions/revision-2/retry",
      method: "POST",
      body: {},
      query: "",
      key: "retry-1",
    },
    {
      args: ["package", "comments", "mutate", "package-1", "revision-2", "--stdin"],
      path: "/api/v1/review-packages/package-1/revisions/revision-2/comments",
      method: "POST",
      body: { action: "resolve", threadId: "thread-1" },
      query: "",
    },
    {
      args: ["package", "renderers", "list", "package-1", "--revision-id", "rev-2"],
      path: "/api/v1/review-packages/package-1/renderers",
      method: "GET",
      body: undefined,
      query: "?revisionId=rev-2",
    },
    {
      args: ["package", "renderers", "manage", "package-1", "--stdin"],
      path: "/api/v1/review-packages/package-1/renderers",
      method: "POST",
      body: { action: "revokePublication", publicationId: "publication-1" },
      query: "",
    },
    {
      args: [
        "package",
        "impact",
        "package-1",
        "--from-revision-id",
        "rev-1",
        "--to-revision-id",
        "rev-2",
        "--offset",
        "0",
      ],
      path: "/api/v1/review-packages/package-1/impact",
      method: "GET",
      body: undefined,
      query: "?fromRevisionId=rev-1&toRevisionId=rev-2&offset=0",
    },
  ])("routes $path with its current schema, method and exact identity", async (testCase) => {
    const expectedBody = testCase.body;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe(testCase.path);
      expect(parsed.search).toBe(testCase.query);
      expect(init?.method).toBe(testCase.method);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      expect(new Headers(init?.headers).get("X-Commentary-Contract-Version")).toBe("1");
      if (testCase.key)
        expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(testCase.key);
      expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(
        expectedBody,
      );
      return jsonResponse({ accepted: true });
    });
    expect(await invoke(testCase.args, fetchImpl as typeof fetch, testCase.body), errors).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("downloads exact binary bytes to a new output path and reports MIME and digest", async () => {
    const bytes = Buffer.from([0, 1, 2, 0xff]);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/v1/review-packages/package-1/revisions/revision-1/files");
      expect(parsed.searchParams.get("path")).toBe("assets/diagram.svg");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("accept")).toBe("application/octet-stream");
      return new Response(bytes, {
        headers: {
          "content-type": "image/svg+xml",
          "content-length": String(bytes.length),
          "x-correlation-id": "corr-1",
        },
      });
    });
    const outputPath = path.join(cwd, "diagram.svg");
    expect(
      await invoke(
        [
          "package",
          "files",
          "download",
          "package-1",
          "revision-1",
          "--path",
          "assets/diagram.svg",
          "--output",
          outputPath,
        ],
        fetchImpl as typeof fetch,
      ),
    ).toBe(0);
    expect(await readFile(outputPath)).toEqual(bytes);
    expect(JSON.parse(output)).toMatchObject({
      path: outputPath,
      bytes: bytes.length,
      mime: "image/svg+xml",
      correlationId: "corr-1",
    });
    expect(JSON.parse(output).sha256).toBe(
      "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56",
    );
  });

  it("never overwrites a package download destination", async () => {
    const destination = path.join(cwd, "existing.bin");
    await writeFile(destination, "keep me");
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("new")));
    expect(
      await invoke(
        [
          "package",
          "files",
          "download",
          "package-1",
          "revision-1",
          "--path",
          "file.bin",
          "--output",
          destination,
        ],
        fetchImpl as typeof fetch,
      ),
    ).toBe(6);
    expect(await readFile(destination, "utf8")).toBe("keep me");
  });

  it("rejects a binary response above the server's per-file bound before writing it", async () => {
    const destination = path.join(cwd, "oversized.bin");
    let canceled = false;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          {
            headers: { "content-length": String(25 * 1024 * 1024 + 1) },
          },
        ),
    );
    expect(
      await invoke(
        [
          "package",
          "files",
          "download",
          "package-1",
          "revision-1",
          "--path",
          "file.bin",
          "--output",
          destination,
        ],
        fetchImpl as typeof fetch,
      ),
    ).toBe(8);
    expect(canceled).toBe(true);
    await expect(readFile(destination)).rejects.toThrow();
  });

  it("cancels an oversized streamed body even without Content-Length", async () => {
    let canceled = false;
    const client = new CommentaryApiClient({
      baseUrl: "https://commentary.test",
      token: "test-token",
      fetchImpl: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              controller.enqueue(new Uint8Array([3, 4]));
            },
            cancel() {
              canceled = true;
            },
          }),
        )) as typeof fetch,
    });

    await expect(
      client.projectBinaryOperation("downloadPackageFile", {
        params: { packageId: "package-1", revisionId: "revision-1" },
        query: { path: "file.bin" },
        maxBytes: 3,
      }),
    ).rejects.toMatchObject({ exitCode: 8 });
    expect(canceled).toBe(true);
  });

  it("keeps structured access errors and writes no output file", async () => {
    const destination = path.join(cwd, "revoked.bin");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              version: "1",
              code: "source_access_revoked",
              message: "Source access was revoked.",
              correlationId: "corr-revoked",
              retryable: false,
            },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );
    expect(
      await invoke(
        [
          "package",
          "files",
          "download",
          "package-1",
          "revision-1",
          "--path",
          "file.bin",
          "--output",
          destination,
        ],
        fetchImpl as typeof fetch,
      ),
    ).toBe(8);
    expect(output).toBe("");
    expect(JSON.parse(errors)).toMatchObject({
      ok: false,
      error: {
        code: "source_access_revoked",
        message: "Source access was revoked.",
        exitCode: 8,
        correlationId: "corr-revoked",
        retryable: false,
      },
    });
    await expect(readFile(destination)).rejects.toThrow();
  });

  it("interrupts a canceled download without writing an output file", async () => {
    const destination = path.join(cwd, "interrupted.bin");
    const abort = new AbortController();
    let canceled = false;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      setTimeout(() => abort.abort(), 10);
      let reads = 0;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: async () => {
              if (reads++ === 0) return { done: false, value: new Uint8Array([1, 2]) };
              return new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
                const signal = init?.signal;
                const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
                if (signal?.aborted) rejectAbort();
                else signal?.addEventListener("abort", rejectAbort, { once: true });
              });
            },
            cancel: async () => {
              canceled = true;
            },
            releaseLock: () => undefined,
          }),
        },
      } as unknown as Response;
    });

    expect(
      await invoke(
        [
          "package",
          "files",
          "download",
          "package-1",
          "revision-1",
          "--path",
          "file.bin",
          "--output",
          destination,
        ],
        fetchImpl as typeof fetch,
        {},
        abort.signal,
      ),
    ).toBe(130);
    expect(canceled).toBe(true);
    expect(output).toBe("");
    await expect(readFile(destination)).rejects.toThrow();
  });

  it("rejects unsafe paths and invalid query values before contacting the server", async () => {
    const fetchImpl = vi.fn();
    expect(
      await invoke(
        [
          "package",
          "files",
          "download",
          "package-1",
          "revision-1",
          "--path",
          "../secret",
          "--output",
          "out",
        ],
        fetchImpl as typeof fetch,
      ),
    ).toBe(8);
    expect(
      await invoke(
        [
          "package",
          "impact",
          "package-1",
          "--from-revision-id",
          "a",
          "--to-revision-id",
          "b",
          "--offset",
          "-1",
        ],
        fetchImpl as typeof fetch,
      ),
    ).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
