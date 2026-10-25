import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { collectPackage, normalizePackagePath, sha256 } from "../src/package-files.js";

let cwd: string, output: string, errors: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "commentary-package-cli-"));
  output = "";
  errors = "";
  vi.stubEnv("COMMENTARY_CONFIG_DIR", path.join(cwd, "config"));
  vi.stubEnv("COMMENTARY_TOKEN", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});
async function invoke(args: string[], fetchImpl: typeof fetch) {
  return runCli(
    [
      "--token",
      "test-token",
      "--workspace",
      "workspace-1",
      "--base-url",
      "https://commentary.test",
      "--json",
      ...args,
    ],
    {
      cwd,
      stdout: { write: (value: string) => void (output += value) },
      stderr: { write: (value: string) => void (errors += value) },
      fetchImpl,
    },
  );
}
function response(data: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json", ...headers },
  });
}
describe("PACKAGE-001 PROJECTAGENT-001 DRAFT-003 dedicated package CLI", () => {
  it("includes generated directories and 21 pages without modifying Draft metadata or executing builds", async () => {
    await mkdir(path.join(cwd, "dist"));
    for (let i = 0; i < 21; i++) await writeFile(path.join(cwd, "dist", `${i}.md`), `# Page ${i}`);
    const fetchImpl = vi.fn();
    expect(await invoke(["package", "validate", "."], fetchImpl)).toBe(0);
    expect(JSON.parse(output).files).toHaveLength(21);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readFile(path.join(cwd, ".commentary", "session.json"))).rejects.toThrow();
    await expect(readFile(path.join(cwd, ".commentary", "package.json"))).rejects.toThrow();
  });
  it.each([
    "../page.md",
    "/page.md",
    "C:/page.md",
    "a%2fpage.md",
    "a\\page.md",
    "CON.md",
    "a/../page.md",
    "Ａ：page.md",
  ])("rejects unsafe path %s", (value) => {
    expect(() => normalizePackagePath(value)).toThrow();
  });
  it("rejects symlink escapes, normalized collisions, archives, unsupported scripts and credential config", async () => {
    await writeFile(path.join(cwd, "README.md"), "# Page");
    await mkdir(path.join(cwd, "actual"));
    await symlink(path.join(cwd, "actual"), path.join(cwd, "linked"), "junction");
    await expect(collectPackage(cwd)).rejects.toMatchObject({ exitCode: 6 });
    await rm(path.join(cwd, "linked"));
    await writeFile(path.join(cwd, "é.md"), "# One");
    await writeFile(path.join(cwd, "e\u0301.md"), "# Two");
    await expect(collectPackage(cwd)).rejects.toMatchObject({ exitCode: 6 });
    await rm(path.join(cwd, "é.md"));
    await rm(path.join(cwd, "e\u0301.md"));
    for (const name of ["files.zip", "build.js", ".env.local"]) {
      await writeFile(path.join(cwd, name), "do not execute");
      await expect(collectPackage(cwd)).rejects.toThrow();
      await rm(path.join(cwd, name));
    }
    await writeFile(
      path.join(cwd, "settings.json"),
      JSON.stringify({ token: "credential-example" }),
    );
    await expect(collectPackage(cwd)).rejects.toMatchObject({ exitCode: 6 });
  });
  it("rejects unbounded assets before reading content", async () => {
    await writeFile(path.join(cwd, "README.md"), "# Page");
    await writeFile(path.join(cwd, "large.pdf"), Buffer.alloc(25 * 1024 * 1024 + 1));
    await expect(collectPackage(cwd)).rejects.toMatchObject({ exitCode: 8 });
  });
  it("resumes a lost chunk response, retries lost publication without duplicate revisions, and syncs explicit deletion", async () => {
    await writeFile(path.join(cwd, "README.md"), "# Page");
    await writeFile(path.join(cwd, "second.md"), "# Second");
    const requests: { pathname: string; body: Record<string, unknown>; headers: Headers }[] = [];
    let upload: Record<string, unknown>;
    let chunks: { offset: number; bytes: number; sha256: string }[] = [];
    let loseChunk = true,
      losePublish = true,
      loseRevision = true,
      publications = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ pathname, body, headers: new Headers(init?.headers) });
      if (pathname.endsWith("/uploads")) {
        upload = {
          id: "upload-1",
          bytes: body.bytes,
          sha256: body.sha256,
          state: "uploading",
          receivedChunks: chunks,
        };
        return response(upload);
      }
      if (pathname.endsWith("/uploads/upload-1"))
        return response({ ...upload, receivedChunks: chunks });
      if (pathname.endsWith("/chunks")) {
        const bytes = Buffer.from(String(body.contentBase64), "base64");
        expect(sha256(bytes)).toBe(body.sha256);
        chunks = [
          { offset: Number(body.offset), bytes: bytes.length, sha256: String(body.sha256) },
        ];
        if (loseChunk) {
          loseChunk = false;
          throw new Error("disconnected");
        }
        return response(upload);
      }
      if (pathname.endsWith("/finalize")) {
        upload.state = "complete";
        return response({ id: "upload-1" });
      }
      if (pathname === "/api/v1/review-packages") {
        publications = 1;
        if (losePublish) {
          losePublish = false;
          throw new Error("lost publication receipt");
        }
        if (loseRevision) {
          loseRevision = false;
          return response({ id: "package-1" }, { etag: '"package-1:v1"' });
        }
        return response(
          { id: "package-1", revisionId: "revision-1", version: 1 },
          { etag: '"package-1:v1"' },
        );
      }
      if (pathname.endsWith("/revisions")) {
        expect(body.deletePaths).toEqual(["second.md"]);
        publications++;
        return response(
          { id: "package-1", revisionId: "revision-2", version: 2 },
          { etag: '"package-1:v2"' },
        );
      }
      throw new Error(`Unexpected route ${pathname}`);
    }) as typeof fetch;
    const command = ["package", "publish", ".", "--idempotency-key", "publication-1", "--no-open"];
    expect(await invoke(command, fetchImpl)).toBe(4);
    let metadata = JSON.parse(
      await readFile(path.join(cwd, ".commentary", "package.json"), "utf8"),
    );
    expect(metadata.pending.uploadId).toBe("upload-1");
    expect(metadata.files).toEqual([]);
    expect(await invoke(command, fetchImpl)).toBe(4);
    expect(await invoke(command, fetchImpl)).toBe(5);
    metadata = JSON.parse(await readFile(path.join(cwd, ".commentary", "package.json"), "utf8"));
    expect(metadata.pending.uploadId).toBe("upload-1");
    expect(metadata.files).toEqual([]);
    expect(metadata.revisionId).toBeUndefined();
    expect(await invoke(command, fetchImpl)).toBe(0);
    expect(publications).toBe(1);
    expect(requests.filter((request) => request.pathname.endsWith("/chunks"))).toHaveLength(1);
    metadata = JSON.parse(await readFile(path.join(cwd, ".commentary", "package.json"), "utf8"));
    expect(metadata.pending).toBeUndefined();
    expect(metadata.files).toHaveLength(2);
    expect(JSON.stringify(metadata)).not.toContain("test-token");
    await rm(path.join(cwd, "second.md"));
    chunks = [];
    expect(
      await invoke(
        ["package", "sync", ".", "--idempotency-key", "publication-2", "--no-open"],
        fetchImpl,
      ),
    ).toBe(0);
    expect(
      requests.find((request) => request.pathname.endsWith("/revisions"))?.headers.get("if-match"),
    ).toBe('"package-1:v1"');
    expect(publications).toBe(2);
  });
  it("keeps pending transfer on changed input, revoked authority, and concurrent publishers", async () => {
    await writeFile(path.join(cwd, "README.md"), "# Page");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "insufficient_scope",
              message: "Access revoked",
              version: "1",
              correlationId: "test",
              retryable: false,
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    expect(await invoke(["package", "publish", ".", "--idempotency-key", "key-1"], fetchImpl)).toBe(
      3,
    );
    const file = path.join(cwd, ".commentary", "package.json");
    const before = await readFile(file, "utf8");
    await writeFile(path.join(cwd, "README.md"), "# Changed");
    expect(await invoke(["package", "publish", ".", "--idempotency-key", "key-1"], fetchImpl)).toBe(
      7,
    );
    expect(await readFile(file, "utf8")).toBe(before);
    await writeFile(`${file}.lock`, "active publication");
    expect(await invoke(["package", "publish", ".", "--idempotency-key", "key-1"], fetchImpl)).toBe(
      7,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
