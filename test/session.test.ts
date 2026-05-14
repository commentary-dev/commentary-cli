import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSessionFile, loadSessionMetadata, saveSessionMetadata } from "../src/session.js";
import type { SessionMetadata } from "../src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "commentary-session-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("session metadata", () => {
  it("saves metadata and finds it from subdirectories", async () => {
    const filePath = await findSessionFile(dir);
    const metadata: SessionMetadata = {
      version: 1,
      reviewSessionId: "draft_1",
      reviewUrl: "https://commentary.test/review/draft/draft_1",
      baseUrl: "https://commentary.test",
      rootPath: ".",
      trackedFiles: [],
      source: ["review", "docs/spec.md"],
      createdAt: "2026-05-13T00:00:00.000Z",
      lastSyncedAt: "2026-05-13T00:00:00.000Z",
      lastKnownRevision: 1,
    };
    await saveSessionMetadata(filePath, metadata);

    const loaded = await loadSessionMetadata(path.join(dir, "nested"));

    expect(loaded.filePath).toBe(filePath);
    expect(loaded.metadata.reviewSessionId).toBe("draft_1");
  });
});
