import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeClient } from "../src/commands.js";
import { getStoredToken, setStoredToken } from "../src/config.js";

let directory: string;
let previous: string | undefined;
const baseUrl = "https://commentary.test";
const expired = {
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: "2000-01-01T00:00:00Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "commentary-refresh-test-"));
  previous = process.env.COMMENTARY_CONFIG_DIR;
  process.env.COMMENTARY_CONFIG_DIR = directory;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.COMMENTARY_CONFIG_DIR;
  else process.env.COMMENTARY_CONFIG_DIR = previous;
  await rm(directory, { recursive: true, force: true });
});

it("serializes concurrent commands and retains the winning rotated credential", async () => {
  await setStoredToken(baseUrl, expired);
  let refreshes = 0;
  const fetchImpl: typeof fetch = async (url) => {
    if (String(url).includes(".well-known"))
      return json({ token_endpoint: `${baseUrl}/oauth/token` });
    if (++refreshes > 1) return json({ error: "invalid_grant" }, 401);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
  };
  const runtime = { cwd: directory, stdout: { write() {} }, stderr: { write() {} }, fetchImpl };
  await Promise.all([makeClient(runtime, { baseUrl }), makeClient(runtime, { baseUrl })]);
  expect(refreshes).toBe(1);
  expect((await getStoredToken(baseUrl))?.refreshToken).toBe("new-refresh");
});

it.each([true, false])(
  "preserves an explicit login during an older refresh (rejected=%s)",
  async (rejected) => {
    await setStoredToken(baseUrl, expired);
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).includes(".well-known"))
        return json({ token_endpoint: `${baseUrl}/oauth/token` });
      await setStoredToken(baseUrl, {
        accessToken: "explicit-login",
        refreshToken: "explicit-refresh",
      });
      return rejected
        ? json({ error: "invalid_grant" }, 401)
        : json({ access_token: "stale-result", refresh_token: "stale-refresh", expires_in: 3600 });
    };
    await makeClient(
      { cwd: directory, stdout: { write() {} }, stderr: { write() {} }, fetchImpl },
      { baseUrl },
    );
    expect((await getStoredToken(baseUrl))?.accessToken).toBe("explicit-login");
  },
);

it("serializes config writes for different profiles without losing credentials", async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      setStoredToken(baseUrl, { accessToken: `access-${i}` }, `reviewer-${i}`),
    ),
  );
  const config = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
  expect(Object.keys(config.profiles[baseUrl])).toHaveLength(8);
});

it("reuses a refresh when another old request returns 401 after rotation", async () => {
  await setStoredToken(baseUrl, { ...expired, expiresAt: "2099-01-01T00:00:00Z" });
  let refreshes = 0;
  let oldRequests = 0;
  let releaseLateResponse!: () => void;
  const rotatedRequest = new Promise<void>((resolve) => {
    releaseLateResponse = resolve;
  });
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).includes(".well-known"))
      return json({ token_endpoint: `${baseUrl}/oauth/token` });
    if (String(url).endsWith("/oauth/token")) {
      refreshes++;
      return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }
    if ((init?.headers as Record<string, string>).authorization === "Bearer old-access") {
      if (++oldRequests === 2) await rotatedRequest;
      return json({ error: "invalid_token" }, 401);
    }
    releaseLateResponse();
    return json({ ok: true, draftReviews: [] });
  };
  const client = await makeClient(
    { cwd: directory, stdout: { write() {} }, stderr: { write() {} }, fetchImpl },
    { baseUrl },
  );
  await Promise.all([client.listDraftReviews(), client.listDraftReviews()]);
  expect(refreshes).toBe(1);
  expect((await getStoredToken(baseUrl))?.refreshToken).toBe("new-refresh");
});

it("serializes refreshes across separate CLI processes", async () => {
  let refreshes = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.includes(".well-known"))
      return response.end(JSON.stringify({ token_endpoint: `${endpoint}/oauth/token` }));
    const count = ++refreshes;
    setTimeout(() => {
      response.statusCode = count === 1 ? 200 : 401;
      response.end(
        JSON.stringify(
          count === 1
            ? { access_token: "process-access", refresh_token: "process-refresh", expires_in: 3600 }
            : { error: "invalid_grant" },
        ),
      );
    }, 150);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await setStoredToken(endpoint, expired);
  const code = `import {makeClient} from './src/commands.ts'; await makeClient({cwd:process.cwd(),stdout:{write(){}},stderr:{write(){}}},{baseUrl:process.env.TEST_ENDPOINT});`;
  const children: ReturnType<typeof spawn>[] = [];
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", code],
        {
          cwd: process.cwd(),
          env: { ...process.env, TEST_ENDPOINT: endpoint, COMMENTARY_TOKEN: "" },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      children.push(child);
      let errors = "";
      child.stderr?.on("data", (chunk) => {
        errors += chunk;
      });
      child.on("error", reject);
      child.on("exit", (status) => (status === 0 ? resolve() : reject(new Error(errors))));
    });
  try {
    await Promise.all([run(), run()]);
    expect(refreshes).toBe(1);
    expect((await getStoredToken(endpoint))?.refreshToken).toBe("process-refresh");
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);
