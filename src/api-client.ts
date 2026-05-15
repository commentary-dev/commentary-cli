import { CliError, ExitCode } from "./errors.js";
import { SseParser } from "./sse.js";
import type {
  DraftFileInput,
  DraftReviewLiveEvent,
  DraftReviewRevision,
  DraftReviewSession,
  DraftThread,
} from "./types.js";

export type FetchLike = typeof fetch;

type ApiClientOptions = {
  baseUrl: string;
  token?: string | null | undefined;
  fetchImpl?: FetchLike | undefined;
};

type OAuthMetadata = {
  issuer: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  authorization_endpoint?: string;
  registration_endpoint?: string;
};

export class CommentaryApiClient {
  readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getOAuthMetadata() {
    return this.rawJson<OAuthMetadata>("/.well-known/oauth-authorization-server", { auth: false });
  }

  async requestDeviceCode(input: {
    clientId: string;
    clientName: string;
    scope: string;
    resource: string;
  }) {
    const metadata = await this.getOAuthMetadata();
    return this.rawJson<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    }>(metadata.device_authorization_endpoint, {
      auth: false,
      method: "POST",
      body: {
        client_id: input.clientId,
        client_name: input.clientName,
        scope: input.scope,
        resource: input.resource,
      },
    });
  }

  async exchangeDeviceCode(input: { deviceCode: string; resource: string }) {
    const metadata = await this.getOAuthMetadata();
    return this.rawJson<{
      access_token: string;
      refresh_token: string;
      token_type: "Bearer";
      expires_in: number;
    }>(metadata.token_endpoint, {
      auth: false,
      method: "POST",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: input.deviceCode,
        resource: input.resource,
      },
    });
  }

  async listDraftReviews() {
    return this.request<{ ok: true; draftReviews: DraftReviewSession[] }>("/api/v1/draft-reviews");
  }

  async createDraftReview(input: {
    title: string;
    description?: string | null;
    files: DraftFileInput[];
  }) {
    return this.request<{
      ok: true;
      draftReview: DraftReviewSession;
      sessionId: string;
      reviewUrl: string;
    }>("/api/v1/draft-reviews", {
      method: "POST",
      body: {
        title: input.title,
        description: input.description,
        sourceType: "cli",
        files: input.files.map((file) => ({
          path: file.path,
          content: file.content,
          contentType: file.contentType,
        })),
      },
    });
  }

  async getDraftReview(sessionId: string) {
    return this.request<{ ok: true; draftReview: DraftReviewSession }>(
      `/api/v1/draft-reviews/${encodeURIComponent(sessionId)}`,
    );
  }

  async createRevision(input: {
    sessionId: string;
    summary?: string | null;
    files: DraftFileInput[];
  }) {
    return this.request<{ ok: true; revision: DraftReviewRevision; noOp?: boolean }>(
      `/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}/revisions`,
      {
        method: "POST",
        body: {
          summary: input.summary,
          files: input.files.map((file) => ({
            fileId: file.fileId,
            path: file.path,
            content: file.content,
            contentType: file.contentType,
          })),
        },
      },
    );
  }

  async listRevisions(sessionId: string) {
    return this.request<{ ok: true; revisions: DraftReviewRevision[] }>(
      `/api/v1/draft-reviews/${encodeURIComponent(sessionId)}/revisions`,
    );
  }

  async listComments(input: {
    sessionId: string;
    status?: "open" | "resolved" | undefined;
    filePath?: string | undefined;
    fileId?: string | undefined;
  }) {
    const params = new URLSearchParams();
    if (input.status) {
      params.set("status", input.status);
    }
    if (input.filePath) {
      params.set("filePath", input.filePath);
    }
    if (input.fileId) {
      params.set("fileId", input.fileId);
    }
    const suffix = params.size ? `?${params}` : "";
    return this.request<{ ok: true; threads: DraftThread[] }>(
      `/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}/comments${suffix}`,
    );
  }

  async replyToComment(input: {
    sessionId: string;
    threadId: string;
    bodyMarkdown: string;
    agentAlias?: string | undefined;
  }) {
    return this.request<{ ok: true; thread: DraftThread }>(
      `/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}/comments/${encodeURIComponent(input.threadId)}/replies`,
      {
        method: "POST",
        body: {
          bodyMarkdown: input.bodyMarkdown,
          ...(input.agentAlias ? { agentAlias: input.agentAlias } : {}),
        },
      },
    );
  }

  async updateCommentStatus(input: {
    sessionId: string;
    threadId: string;
    status: "open" | "resolved";
  }) {
    return this.request<{ ok: true; thread: DraftThread }>(
      `/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}/comments/${encodeURIComponent(input.threadId)}/status`,
      {
        method: "POST",
        body: { status: input.status },
      },
    );
  }

  async getFileContent(input: { sessionId: string; fileId: string }) {
    return this.rawText(
      `/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}/files/${encodeURIComponent(input.fileId)}/content`,
      { auth: true },
    );
  }

  async *streamDraftReviewEvents(input: {
    sessionId: string;
    cursor?: string | undefined;
    once?: boolean | undefined;
    signal?: AbortSignal | undefined;
  }): AsyncGenerator<DraftReviewLiveEvent> {
    const params = new URLSearchParams();
    if (input.cursor) {
      params.set("cursor", input.cursor);
    }
    if (input.once) {
      params.set("once", "1");
    }
    const suffix = params.size ? `?${params}` : "";
    const response = await this.doFetch(
      `/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}/events${suffix}`,
      { auth: true, accept: "text/event-stream", signal: input.signal },
    );
    if (!response.ok) {
      await this.throwApiError(response);
    }
    if (!response.body) {
      throw new CliError("Commentary event stream did not include a response body.", ExitCode.Api);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let completed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        completed = done;
        const messages = done
          ? parser.flush()
          : parser.feed(decoder.decode(value, { stream: true }));
        for (const message of messages) {
          if (message.event && message.event !== "draft-review") {
            continue;
          }
          if (!message.data) {
            continue;
          }
          yield JSON.parse(message.data) as DraftReviewLiveEvent;
        }
        if (done) {
          break;
        }
      }
    } catch (error) {
      if (input.signal?.aborted) {
        return;
      }
      throw new CliError(
        error instanceof Error ? error.message : "Commentary event stream failed.",
        ExitCode.Network,
      );
    } finally {
      if (!completed) {
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
  }

  private async request<T>(pathOrUrl: string, init?: { method?: string; body?: unknown }) {
    return this.rawJson<T>(pathOrUrl, { ...init, auth: true });
  }

  private async rawText(
    pathOrUrl: string,
    init: { auth: boolean; method?: string; body?: unknown },
  ) {
    const response = await this.doFetch(pathOrUrl, init);
    if (!response.ok) {
      await this.throwApiError(response);
    }
    return response.text();
  }

  private async rawJson<T>(
    pathOrUrl: string,
    init: { auth: boolean; method?: string; body?: unknown },
  ) {
    const response = await this.doFetch(pathOrUrl, init);
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? ((await response.json()) as unknown)
      : null;
    if (!response.ok) {
      this.throwPayloadError(response.status, payload);
    }
    return payload as T;
  }

  private async doFetch(
    pathOrUrl: string,
    init: {
      auth: boolean;
      method?: string;
      body?: unknown;
      accept?: string;
      signal?: AbortSignal | undefined;
    },
  ) {
    const url =
      pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
        ? pathOrUrl
        : `${this.baseUrl}${pathOrUrl}`;
    const headers: Record<string, string> = {
      accept: init.accept ?? "application/json",
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    if (init.auth) {
      if (!this.token) {
        throw new CliError(
          "Authentication is required. Run commentary login or set COMMENTARY_TOKEN.",
          ExitCode.Auth,
        );
      }
      headers.authorization = `Bearer ${this.token}`;
    }
    try {
      const requestInit: RequestInit = {
        method: init.method ?? "GET",
        headers,
      };
      if (init.signal) {
        requestInit.signal = init.signal;
      }
      if (body !== undefined) {
        requestInit.body = body;
      }
      return await this.fetchImpl(url, requestInit);
    } catch (error) {
      throw new CliError(
        error instanceof Error ? error.message : "Network request failed.",
        ExitCode.Network,
      );
    }
  }

  private async throwApiError(response: Response): Promise<never> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      this.throwPayloadError(response.status, await response.json());
    }
    throw new CliError(
      `Commentary API returned ${response.status}.`,
      response.status === 401 ? ExitCode.Auth : ExitCode.Api,
    );
  }

  private throwPayloadError(status: number, payload: unknown): never {
    const body =
      payload && typeof payload === "object"
        ? (payload as { error?: unknown; error_description?: unknown })
        : {};
    const message =
      typeof body.error === "string"
        ? body.error
        : typeof body.error_description === "string"
          ? body.error_description
          : `Commentary API returned ${status}.`;
    throw new CliError(message, status === 401 || status === 403 ? ExitCode.Auth : ExitCode.Api);
  }
}
