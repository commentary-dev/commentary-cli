import { describe, expect, it, vi } from "vitest";
import { CommentaryApiClient } from "../src/api-client.js";

describe("CommentaryApiClient", () => {
  it("creates draft reviews with the expected HTTP shape", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe("https://commentary.test/api/v1/draft-reviews");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer token");
      expect(JSON.parse(String(init?.body))).toEqual({
        title: "Spec",
        description: null,
        sourceType: "cli",
        files: [{ path: "spec.md", content: "# Spec\n", contentType: "markdown" }],
      });
      return new Response(
        JSON.stringify({
          ok: true,
          sessionId: "draft_1",
          reviewUrl: "https://commentary.test/review/draft/draft_1",
          draftReview: {
            id: "draft_1",
            title: "Spec",
            reviewUrl: "https://commentary.test/review/draft/draft_1",
            files: [],
            latestRevision: null,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = new CommentaryApiClient({
      baseUrl: "https://commentary.test",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await client.createDraftReview({
      title: "Spec",
      description: null,
      files: [{ path: "spec.md", content: "# Spec\n", contentType: "markdown" }],
    });

    expect(result.sessionId).toBe("draft_1");
  });

  it("turns API errors into actionable errors", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "Missing scope." }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new CommentaryApiClient({
      baseUrl: "https://commentary.test",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.listDraftReviews()).rejects.toThrow("Missing scope.");
  });

  it("streams draft review live events with bearer auth", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://commentary.test/api/v1/draft-reviews/draft_1/events?cursor=latest",
      );
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer token");
      expect((init?.headers as Record<string, string>).accept).toBe("text/event-stream");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  "id: event_1",
                  "event: draft-review",
                  `data: ${JSON.stringify({
                    id: "event_1",
                    type: "comment.created",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    payload: {},
                    thread: null,
                  })}`,
                  "",
                  "",
                ].join("\n"),
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
      );
    });
    const client = new CommentaryApiClient({
      baseUrl: "https://commentary.test",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const events = [];
    for await (const event of client.streamDraftReviewEvents({
      sessionId: "draft_1",
      cursor: "latest",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        id: "event_1",
        type: "comment.created",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {},
        thread: null,
      },
    ]);
  });
});
