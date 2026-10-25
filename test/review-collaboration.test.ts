import { describe, it, expect, vi } from "vitest";
import { CommentaryApiClient } from "../src/api-client.js";
describe("shared review collaboration", () => {
  it("transports source identity, conditional versions and idempotency intent without inference", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ ok: true, settings: { version: 2 } }), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = new CommentaryApiClient({
      baseUrl: "https://commentary.test",
      token: "test-token",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const review = {
      kind: "pr" as const,
      provider: "github" as const,
      owner: "review-team",
      repo: "documents",
      prNumber: 42,
    };
    await client.getReviewSettings(review);
    const update = {
      review,
      collaboration: { polls: true, consensus: { enabled: true } },
      expectedVersion: 1,
      operationKey: "operation-123",
    };
    await client.updateReviewSettings(update);
    await client.updateReviewSettings(update);
    await client.getReviewDecision("thread/1");
    await client.mutateReviewDecision("thread/1", {
      action: "record_application",
      expectedVersion: 2,
      operationKey: "operation-456",
      resultingRevision: "sha-exact",
    });
    await client.getReviewPolls({ review });
    await client.getReviewPolls({
      action: "markdown",
      pollId: "poll/1",
      threadId: "thread/1",
      outcome: "accepted_for_change",
      after: "thread/0",
    });
    await client.mutateReviewPoll({
      review,
      action: "vote",
      pollId: "poll-1",
      selectedOptionIds: ["option-1"],
    });
    await client.getReviewGate(review, "sha-exact");
    expect(JSON.parse(new URL(requests[0]!.url).searchParams.get("review")!)).toEqual(review);
    expect(requests[1]!.method).toBe("PATCH");
    expect(requests[1]!.body).toEqual(update);
    expect(requests[2]).toEqual(requests[1]);
    expect(requests[3]!.url).toContain("/threads/thread%2F1/decision");
    expect(requests[4]!.body).toMatchObject({
      action: "record_application",
      resultingRevision: "sha-exact",
    });
    const pollQuery = new URL(requests[5]!.url).searchParams;
    expect(JSON.parse(pollQuery.get("review")!)).toEqual(review);
    expect(Object.fromEntries(new URL(requests[6]!.url).searchParams)).toEqual({
      action: "markdown",
      threadId: "thread/1",
      pollId: "poll/1",
      outcome: "accepted_for_change",
      after: "thread/0",
    });
    expect(new URL(requests[8]!.url).searchParams.get("revision")).toBe("sha-exact");
  });
});
