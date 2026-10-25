import { afterEach, describe, expect, it, vi } from "vitest";
import { waitProjectEvents } from "../src/project-events.js";
import { CliError, ExitCode } from "../src/errors.js";
import type { CommentaryApiClient } from "../src/api-client.js";

afterEach(() => vi.useRealTimers());
function result(items: unknown[] = [], nextCursor = "opaque-next", hasMore = false) {
  return {
    body: { data: { items, nextCursor, hasMore, outcome: items.length ? "events" : "timeout" } },
    etag: null,
    correlationId: null,
    idempotencyReplayed: null,
  };
}
const input = {
  params: { sessionId: "session-1" },
  query: { cursor: "opaque-previous", limit: 25 },
};
const options = { timeoutMs: 1000, resyncOperationId: "getProjectReviewSession" };
function client(fn: ReturnType<typeof vi.fn>) {
  return { projectOperation: fn } as Pick<CommentaryApiClient, "projectOperation">;
}
describe("PROJECTAGENT-001 typed durable event recovery", () => {
  it("returns one bounded batch and deduplicates exact event IDs", async () => {
    const fn = vi.fn().mockResolvedValue(result([{ id: "event-1" }, { id: "event-1" }]));
    const response = await waitProjectEvents(
      client(fn),
      "listProjectReviewFeedback",
      input,
      options,
    );
    expect((response.body.data as { items: unknown[] }).items).toHaveLength(1);
    expect(fn.mock.calls[0]![1].query.cursor).toBe("opaque-previous");
    expect(fn.mock.calls[0]![1].query.waitMs).toBeLessThanOrEqual(1000);
  });
  it("refetches once after cursor expiry and explicitly reports resynchronization", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new CliError("Gap", ExitCode.Api, { code: "event_cursor_resync_required" }),
      )
      .mockResolvedValueOnce({ ...result(), body: { data: { revisionId: "current-exact" } } })
      .mockResolvedValueOnce(result([{ id: "event-1" }]));
    const response = await waitProjectEvents(
      client(fn),
      "listProjectReviewFeedback",
      input,
      options,
    );
    expect(fn.mock.calls.map((call) => call[0])).toEqual([
      "listProjectReviewFeedback",
      "getProjectReviewSession",
      "listProjectReviewFeedback",
    ]);
    expect(fn.mock.calls[2]![1].query.cursor).toBeUndefined();
    expect(response.body.data).toMatchObject({
      resynchronized: true,
      snapshot: { revisionId: "current-exact" },
      nextCursor: "opaque-next",
    });
  });
  it("reconnects with the last acknowledged opaque cursor after disconnect", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockResolvedValueOnce(result([], "cursor-ack"))
      .mockRejectedValueOnce(new CliError("Disconnected", ExitCode.Network))
      .mockResolvedValueOnce(result([{ id: "event-2" }]));
    const pending = waitProjectEvents(client(fn), "listProjectReviewFeedback", input, {
      ...options,
      timeoutMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(1300);
    await expect(pending).resolves.toMatchObject({ body: { data: { nextCursor: "opaque-next" } } });
    expect(fn.mock.calls[2]![1].query.cursor).toBe("cursor-ack");
  });
  it("bounds empty waits and returns timeout exit 124", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue(result());
    const pending = waitProjectEvents(client(fn), "listProjectReviewFeedback", input, options);
    const assertion = expect(pending).rejects.toMatchObject({
      exitCode: 124,
      diagnostics: [{ nextCursor: "opaque-next", pendingAttention: true }],
    });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fn.mock.calls.length).toBeLessThanOrEqual(4);
  });
  it("cancels the active network request and returns interruption exit 130", async () => {
    const controller = new AbortController();
    const fn = vi.fn(
      async (_operation, request) =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(new CliError("aborted", 4)), {
            once: true,
          }),
        ),
    );
    const pending = waitProjectEvents(client(fn), "listProjectReviewFeedback", input, {
      ...options,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ exitCode: 130 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("never retries revoked access and never repeatedly resets an expired continuation", async () => {
    const denied = vi
      .fn()
      .mockRejectedValue(new CliError("Revoked", ExitCode.Auth, { code: "source_access_revoked" }));
    await expect(
      waitProjectEvents(client(denied), "listProjectReviewFeedback", input, options),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(denied).toHaveBeenCalledTimes(1);
    const gap = new CliError("Gap", 5, { code: "event_cursor_resync_required" });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(gap)
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce(gap);
    await expect(
      waitProjectEvents(client(fn), "listProjectReviewFeedback", input, options),
    ).rejects.toBe(gap);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
