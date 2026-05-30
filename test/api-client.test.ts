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

  it("creates draft reviews with GitHub base metadata when provided", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        gitBase: {
          provider: "github",
          owner: "commentary-dev",
          repo: "commentary-docs",
          ref: "main",
          sha: "abc123",
          path: "spec.md",
        },
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

    await client.createDraftReview({
      title: "Spec",
      description: null,
      files: [{ path: "spec.md", content: "# Spec\n", contentType: "markdown" }],
      gitBase: {
        provider: "github",
        owner: "commentary-dev",
        repo: "commentary-docs",
        ref: "main",
        sha: "abc123",
        path: "spec.md",
      },
    });
  });

  it("patches draft review GitHub base metadata", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://commentary.test/api/v1/draft-reviews/draft_1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        gitBase: {
          provider: "github",
          owner: "commentary-dev",
          repo: "commentary-docs",
          sha: "abc123",
          path: "spec.md",
        },
      });
      return new Response(
        JSON.stringify({
          ok: true,
          draftReview: {
            id: "draft_1",
            title: "Spec",
            reviewUrl: "https://commentary.test/review/draft/draft_1",
            files: [],
            latestRevision: null,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new CommentaryApiClient({
      baseUrl: "https://commentary.test",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.updateDraftReview({
      sessionId: "draft_1",
      gitBase: {
        provider: "github",
        owner: "commentary-dev",
        repo: "commentary-docs",
        sha: "abc123",
        path: "spec.md",
      },
    });
  });

  it("manages draft review shares", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          shareLinks: [{ id: "share_1", url: "https://commentary.test/share/share_1" }],
          accessGrants: [{ id: "grant_1", recipient: "reviewer@example.com" }],
          shareLink: { id: "share_1", url: "https://commentary.test/share/share_1" },
          accessGrant: { id: "grant_1", recipient: "reviewer@example.com" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new CommentaryApiClient({
      baseUrl: "https://commentary.test",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.listDraftReviewShares("draft_1");
    await client.shareDraftReview({ sessionId: "draft_1", audience: "anyone" });
    await client.shareDraftReview({
      sessionId: "draft_1",
      audience: "user",
      recipient: "reviewer@example.com",
    });
    await client.revokeDraftReviewShare({ sessionId: "draft_1", shareLinkId: "share_1" });
    await client.removeDraftReviewAccess({ sessionId: "draft_1", accessGrantId: "grant_1" });

    expect(requests).toEqual([
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/shares",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/shares",
        method: "POST",
        body: { audience: "anyone" },
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/shares",
        method: "POST",
        body: { audience: "user", recipient: "reviewer@example.com" },
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/shares/share_1",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/access-grants/grant_1",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("uses Brainstorming Review API shapes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          draftReviews: [],
          sessionId: "draft_1",
          reviewUrl: "https://commentary.test/review/draft/draft_1",
          draftReview: {
            id: "draft_1",
            title: "Brainstorm",
            mode: "brainstorming",
            reviewUrl: "https://commentary.test/review/draft/draft_1",
            files: [],
            latestRevision: null,
          },
          revision: { id: "rev_1", revisionNumber: 1, files: [] },
          addressedThreadIds: ["thread_1"],
          threads: [],
          thread: {
            id: "thread_1",
            fileId: null,
            filePath: "spec.md",
            status: "open",
            comments: [],
          },
          consensusRule: { enabled: true, mode: "owner_decides" },
          counts: { acceptedForChange: 1 },
          filesWithActionableThreads: ["spec.md"],
          filesWithBlockedThreads: [],
          agentReady: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new CommentaryApiClient({
      baseUrl: "https://commentary.test",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.listDraftReviews({ mode: "brainstorming" });
    await client.createDraftReview({
      title: "Brainstorm",
      mode: "brainstorming",
      description: null,
      files: [{ path: "spec.md", content: "# Spec\n", contentType: "markdown" }],
    });
    await client.updateDraftReview({ sessionId: "draft_1", mode: "brainstorming" });
    await client.createRevision({
      sessionId: "draft_1",
      summary: "Apply accepted feedback",
      addressedThreadIds: ["thread_1"],
      files: [{ fileId: "file_1", path: "spec.md", content: "# Spec\n", contentType: "markdown" }],
    });
    await client.listComments({ sessionId: "draft_1", consensusState: "accepted_for_change" });
    await client.updateCommentFeedback({
      sessionId: "draft_1",
      threadId: "thread_1",
      signal: "agree",
      active: false,
      agentAlias: "Docs agent",
      clientName: "cli",
    });
    await client.updateCommentConsensusDecision({
      sessionId: "draft_1",
      threadId: "thread_1",
      decision: "accepted_for_change",
      reason: "Ready",
    });
    await client.getConsensusRule("draft_1");
    await client.updateConsensusRule({
      sessionId: "draft_1",
      rule: { mode: "no_open_blockers", minResponseCount: 2 },
    });
    await client.getConsensusState("draft_1");

    expect(requests).toEqual([
      {
        url: "https://commentary.test/api/v1/draft-reviews?mode=brainstorming",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews",
        method: "POST",
        body: {
          title: "Brainstorm",
          description: null,
          mode: "brainstorming",
          sourceType: "cli",
          files: [{ path: "spec.md", content: "# Spec\n", contentType: "markdown" }],
        },
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1",
        method: "PATCH",
        body: { mode: "brainstorming" },
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/revisions",
        method: "POST",
        body: {
          summary: "Apply accepted feedback",
          addressedThreadIds: ["thread_1"],
          files: [
            {
              fileId: "file_1",
              path: "spec.md",
              content: "# Spec\n",
              contentType: "markdown",
            },
          ],
        },
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/comments?consensusState=accepted_for_change",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/comments/thread_1/feedback",
        method: "POST",
        body: {
          signal: "agree",
          active: false,
          agentAlias: "Docs agent",
          clientName: "cli",
        },
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/comments/thread_1/consensus-decision",
        method: "POST",
        body: { decision: "accepted_for_change", reason: "Ready" },
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/consensus-rule",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/consensus-rule",
        method: "PATCH",
        body: { mode: "no_open_blockers", minResponseCount: 2 },
      },
      {
        url: "https://commentary.test/api/v1/draft-reviews/draft_1/consensus-state",
        method: "GET",
        body: undefined,
      },
    ]);
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

  it("refreshes auth once after a 401 and retries the request", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push((init?.headers as Record<string, string>).authorization ?? "");
      if (requests.length === 1) {
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, draftReviews: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new CommentaryApiClient({
      baseUrl: "https://commentary.test",
      token: "expired",
      fetchImpl: fetchImpl as typeof fetch,
      onAuthRefresh: async () => "fresh",
    });

    await expect(client.listDraftReviews()).resolves.toEqual({ ok: true, draftReviews: [] });
    expect(requests).toEqual(["Bearer expired", "Bearer fresh"]);
  });

  it("exchanges refresh tokens with the OAuth token endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://commentary.test",
            token_endpoint: "https://commentary.test/oauth/token",
            device_authorization_endpoint: "https://commentary.test/oauth/device/code",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(requestUrl).toBe("https://commentary.test/oauth/token");
      expect(JSON.parse(String(init?.body))).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-token",
      });
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new CommentaryApiClient({
      baseUrl: "https://commentary.test",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.refreshAccessToken({ refreshToken: "refresh-token" })).resolves.toEqual({
      access_token: "new-access",
      refresh_token: "new-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    });
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
