import { CliError, ExitCode } from "./errors.js";
import { AGENT_OPERATIONS, type AgentOperation, type AgentRequest } from "./agent-api.js";
import { PROJECT_OPERATIONS } from "./project-payload.js";
import { SseParser } from "./sse.js";
import type {
  ReviewConsensusState,
  DraftReviewAccessGrant,
  DraftFileInput,
  DraftReviewGitBaseMetadata,
  DraftReviewLiveEvent,
  ReviewRef,
  ReviewCollaboration,
  DraftReviewRevision,
  DraftReviewShareAudience,
  DraftReviewShareLink,
  DraftReviewSession,
  DraftThread,
  Interaction,
  InteractionAgentDecisionReceipt,
  InteractionContent,
  InteractionRevisionRequest,
  InteractionDecisionPolling,
  InteractionFulfillmentEvidence,
  InteractionFulfillmentReportResult,
  InteractionFulfillmentStatus,
  InteractionListPage,
  InteractionResource,
  InteractionState,
} from "./types.js";

export type FetchLike = typeof fetch;

type ApiClientOptions = {
  baseUrl: string;
  token?: string | null | undefined;
  workspaceId?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  onAuthRefresh?: (() => Promise<string | null>) | undefined;
};

type OAuthMetadata = {
  scopes_supported?: string[];
  issuer: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  authorization_endpoint?: string;
  registration_endpoint?: string;
};

export type InteractionResponse<T> = {
  body: T;
  etag: string | null;
  correlationId: string | null;
  idempotencyReplayed: boolean | null;
};

export type ProjectBinaryResponse = {
  bytes: Uint8Array;
  mime: string;
  etag: string | null;
  correlationId: string | null;
};

export class CommentaryApiClient {
  readonly baseUrl: string;
  private token: string | null;
  private readonly workspaceId: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly onAuthRefresh: (() => Promise<string | null>) | undefined;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token ?? null;
    this.workspaceId = options.workspaceId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onAuthRefresh = options.onAuthRefresh;
  }

  async agentOperation<T = Record<string, unknown>>(
    operation: AgentOperation,
    input: AgentRequest = {},
  ) {
    const [method, template] = AGENT_OPERATIONS[operation];
    const route = template.replace(/:([A-Za-z]+)/gu, (_match, key: string) => {
      const value = input.params?.[key] ?? (key === "workspaceId" ? this.workspaceId : undefined);
      if (!value)
        throw new CliError(
          `Missing ${key}; pass the corresponding argument or --workspace.`,
          ExitCode.Usage,
        );
      return encodeURIComponent(value);
    });
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined)
        query.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    return this.interactionRequest<T>(`/api/v1${route}${query.size ? `?${query}` : ""}`, {
      method,
      ...(input.body !== undefined ? { body: input.body } : {}),
      headers: {
        ...(input.etag ? { "If-Match": input.etag } : {}),
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
        ...(input.correlationId ? { "X-Correlation-Id": input.correlationId } : {}),
      },
    });
  }

  async projectOperation(operationId: string, input: AgentRequest = {}) {
    const operation = PROJECT_OPERATIONS.find((item) => item.operationId === operationId);
    if (!operation || operation.status !== "implemented")
      throw new CliError(
        "Projects capability is unsupported by this client contract.",
        ExitCode.Validation,
        { code: "capability_unsupported" },
      );
    const route = operation.path.replace(/\{(\w+)\}/gu, (_match, key: string) => {
      const value = input.params?.[key];
      if (!value) throw new CliError(`Missing explicit ${key}.`, ExitCode.Usage);
      return encodeURIComponent(value);
    });
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input.query ?? {}))
      if (value !== undefined) query.set(key, String(value));
    return this.interactionRequest<Record<string, unknown>>(
      route + (query.size ? `?${query}` : ""),
      {
        method: operation.method,
        ...(input.signal ? { signal: input.signal } : {}),
        unknownReplay: true,
        ...(input.body !== undefined ? { body: input.body } : {}),
        headers: {
          "X-Commentary-Contract-Version": "1",
          ...(input.etag ? { "If-Match": input.etag } : {}),
          ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
          ...(input.correlationId ? { "X-Correlation-Id": input.correlationId } : {}),
        },
      },
    ).catch((error) => {
      if (input.signal?.aborted)
        throw new CliError("Request interrupted; resumable state retained.", ExitCode.Interrupted);
      if (error instanceof CliError && error.code === undefined && error.message.includes("404"))
        throw new CliError(
          "Server does not support this capability; upgrade or select a compatible endpoint.",
          ExitCode.Validation,
          { code: "capability_unsupported" },
        );
      throw error;
    });
  }

  async projectBinaryOperation(
    operationId: string,
    input: AgentRequest & { maxBytes?: number } = {},
  ): Promise<ProjectBinaryResponse> {
    const operation = PROJECT_OPERATIONS.find((item) => item.operationId === operationId);
    if (!operation || operation.status !== "implemented" || operation.method !== "GET")
      throw new CliError(
        "Projects binary capability is unsupported by this client contract.",
        ExitCode.Validation,
        { code: "capability_unsupported" },
      );
    const route = operation.path.replace(/\{(\w+)\}/gu, (_match, key: string) => {
      const value = input.params?.[key];
      if (!value) throw new CliError(`Missing explicit ${key}.`, ExitCode.Usage);
      return encodeURIComponent(value);
    });
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input.query ?? {}))
      if (value !== undefined) query.set(key, String(value));
    const url = route + (query.size ? `?${query}` : "");
    const maximum = input.maxBytes ?? 16 * 1024 * 1024;
    try {
      const response = await this.doFetch(url, {
        auth: true,
        method: operation.method,
        signal: input.signal,
        headers: {
          accept: "application/octet-stream",
          "X-Commentary-Contract-Version": "1",
          ...(input.correlationId ? { "X-Correlation-Id": input.correlationId } : {}),
        },
      });
      if (!response.ok) await this.throwApiError(response);
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > maximum) {
        await response.body?.cancel().catch(() => undefined);
        throw new CliError(`Downloaded file exceeds ${maximum} bytes.`, ExitCode.Validation);
      }
      const reader = response.body?.getReader();
      if (!reader)
        return {
          bytes: new Uint8Array(),
          mime: response.headers.get("content-type") ?? "application/octet-stream",
          etag: response.headers.get("etag"),
          correlationId: response.headers.get("x-correlation-id"),
        };
      const chunks: Uint8Array[] = [];
      let size = 0;
      let completed = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            completed = true;
            break;
          }
          size += value.byteLength;
          if (size > maximum) {
            await reader.cancel().catch(() => undefined);
            throw new CliError(`Downloaded file exceeds ${maximum} bytes.`, ExitCode.Validation);
          }
          chunks.push(value);
        }
      } finally {
        if (!completed) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        bytes,
        mime: response.headers.get("content-type") ?? "application/octet-stream",
        etag: response.headers.get("etag"),
        correlationId: response.headers.get("x-correlation-id"),
      };
    } catch (error) {
      if (input.signal?.aborted)
        throw new CliError(
          "Request interrupted; no output file was written.",
          ExitCode.Interrupted,
        );
      if (error instanceof CliError && error.code === undefined && error.message.includes("404"))
        throw new CliError(
          "Server does not support this capability; upgrade or select a compatible endpoint.",
          ExitCode.Validation,
          { code: "capability_unsupported" },
        );
      throw error;
    }
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

  async refreshAccessToken(input: { refreshToken: string }) {
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
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      },
    });
  }

  async getReviewSettings(review: ReviewRef) {
    return this.request<Record<string, unknown>>(
      `/api/v1/review/settings?review=${encodeURIComponent(JSON.stringify(review))}`,
    );
  }
  async updateReviewSettings(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("/api/v1/review/settings", {
      method: "PATCH",
      body,
    });
  }
  async getReviewDecision(threadId: string) {
    return this.request<Record<string, unknown>>(
      `/api/v1/review/threads/${encodeURIComponent(threadId)}/decision`,
    );
  }
  async mutateReviewDecision(threadId: string, body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>(
      `/api/v1/review/threads/${encodeURIComponent(threadId)}/decision`,
      { method: "POST", body },
    );
  }
  async getReviewPolls(input: {
    review?: ReviewRef;
    action?: "get" | "list" | "markdown";
    threadId?: string;
    pollId?: string;
    outcome?: string;
    after?: string;
  }) {
    const params = new URLSearchParams();
    if (input.review) params.set("review", JSON.stringify(input.review));
    if (input.action) params.set("action", input.action);
    if (input.threadId) params.set("threadId", input.threadId);
    if (input.pollId) params.set("pollId", input.pollId);
    if (input.outcome) params.set("outcome", input.outcome);
    if (input.after) params.set("after", input.after);
    return this.request<Record<string, unknown>>(
      `/api/v1/review/polls${params.size ? `?${params}` : ""}`,
    );
  }
  async mutateReviewPoll(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("/api/v1/review/polls", { method: "POST", body });
  }
  async getReviewGate(review: ReviewRef, revision: string) {
    return this.request<Record<string, unknown>>(
      `/api/v1/review/gate?review=${encodeURIComponent(JSON.stringify(review))}&revision=${encodeURIComponent(revision)}`,
    );
  }
  async listDraftReviews() {
    const params = new URLSearchParams();

    const suffix = params.size ? `?${params}` : "";
    return this.request<{ ok: true; draftReviews: DraftReviewSession[] }>(
      `/api/v1/draft-reviews${suffix}`,
    );
  }

  async createDraftReview(input: {
    title: string;
    description?: string | null;
    collaboration?: ReviewCollaboration;
    files: DraftFileInput[];
    gitBase?: DraftReviewGitBaseMetadata | null | undefined;
  }) {
    return this.request<{
      ok: true;
      draftReview: DraftReviewSession;
      sessionId: string;
      reviewUrl: string;
    }>("/api/v1/draft-reviews", {
      method: "POST",
      body: {
        ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
        title: input.title,
        description: input.description,
        ...(input.collaboration ? { collaboration: input.collaboration } : {}),
        sourceType: "cli",
        ...(input.gitBase !== undefined ? { gitBase: input.gitBase } : {}),
        files: input.files.map((file) => ({
          path: file.path,
          content: file.content,
          contentType: file.contentType,
        })),
      },
    });
  }

  async updateDraftReview(input: {
    sessionId: string;
    title?: string | undefined;
    description?: string | null | undefined;
    status?: string | undefined;
    collaboration?: ReviewCollaboration;
    gitBase?: DraftReviewGitBaseMetadata | null | undefined;
  }) {
    return this.request<{ ok: true; draftReview: DraftReviewSession }>(
      `/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}`,
      {
        method: "PATCH",
        body: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),

          ...(input.gitBase !== undefined ? { gitBase: input.gitBase } : {}),
        },
      },
    );
  }

  async deleteDraftReview(sessionId: string) {
    return this.request<{ ok: true; deleted: boolean }>(
      `/api/v1/draft-reviews/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
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
    return this.request<{
      ok: true;
      revision: DraftReviewRevision;
      noOp?: boolean;
    }>(`/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}/revisions`, {
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
    });
  }

  async listRevisions(sessionId: string) {
    return this.request<{ ok: true; revisions: DraftReviewRevision[] }>(
      `/api/v1/draft-reviews/${encodeURIComponent(sessionId)}/revisions`,
    );
  }

  async listDraftReviewShares(sessionId: string) {
    return this.request<{
      ok: true;
      shareLinks: DraftReviewShareLink[];
      accessGrants: DraftReviewAccessGrant[];
    }>(`/api/v1/draft-reviews/${encodeURIComponent(sessionId)}/shares`);
  }

  async shareDraftReview(input: {
    sessionId: string;
    audience: DraftReviewShareAudience;
    recipient?: string | undefined;
  }) {
    return this.request<{
      ok: true;
      shareLink?: DraftReviewShareLink;
      accessGrant?: DraftReviewAccessGrant;
    }>(`/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}/shares`, {
      method: "POST",
      body: {
        audience: input.audience,
        ...(input.recipient ? { recipient: input.recipient } : {}),
      },
    });
  }

  async revokeDraftReviewShare(input: { sessionId: string; shareLinkId: string }) {
    return this.request<{ ok: true }>(
      `/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}/shares/${encodeURIComponent(input.shareLinkId)}`,
      { method: "DELETE" },
    );
  }

  async removeDraftReviewAccess(input: { sessionId: string; accessGrantId: string }) {
    return this.request<{ ok: true }>(
      `/api/v1/draft-reviews/${encodeURIComponent(input.sessionId)}/access-grants/${encodeURIComponent(input.accessGrantId)}`,
      { method: "DELETE" },
    );
  }

  async listComments(input: {
    sessionId: string;
    status?: "open" | "resolved" | undefined;
    filePath?: string | undefined;
    fileId?: string | undefined;
    consensusState?: ReviewConsensusState | undefined;
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
    if (input.consensusState) {
      params.set("consensusState", input.consensusState);
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

  async createInteraction(input: {
    resource: InteractionResource;
    content: InteractionContent;
    initialState?: "draft" | "active" | undefined;
    interactionType?: "request" | "notification" | "decision_request" | undefined;
    priority?: "low" | "normal" | "high" | "urgent" | undefined;
    idempotencyKey: string;
    correlationId?: string | undefined;
  }) {
    return this.interactionRequest<{ data: Interaction }>("/api/v1/interactions", {
      method: "POST",
      body: {
        resource: input.resource,
        content: input.content,
        ...(input.initialState ? { initialState: input.initialState } : {}),
        ...(input.interactionType ? { interactionType: input.interactionType } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
      },
      headers: {
        "Idempotency-Key": input.idempotencyKey,
        ...(input.correlationId ? { "X-Correlation-Id": input.correlationId } : {}),
      },
    });
  }

  async getInteraction(input: {
    interactionId: string;
    correlationId?: string | undefined;
    signal?: AbortSignal | undefined;
  }) {
    return this.interactionRequest<{ data: Interaction }>(
      `/api/v1/interactions/${encodeURIComponent(input.interactionId)}`,
      {
        ...(input.correlationId ? { headers: { "X-Correlation-Id": input.correlationId } } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
  }

  async listInteractions(input: {
    limit?: number | undefined;
    cursor?: string | undefined;
    state?: InteractionState | undefined;
    resourceType?: string | undefined;
    correlationId?: string | undefined;
  }) {
    const params = new URLSearchParams();
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    if (input.state) params.set("state", input.state);
    if (input.resourceType) params.set("resourceType", input.resourceType);
    const suffix = params.size ? `?${params}` : "";
    return this.interactionRequest<InteractionListPage>(
      `/api/v1/interactions${suffix}`,
      input.correlationId ? { headers: { "X-Correlation-Id": input.correlationId } } : {},
    );
  }

  async reviseInteraction(input: {
    interactionId: string;
    content: InteractionRevisionRequest;
    etag: string;
    idempotencyKey: string;
    correlationId?: string | undefined;
  }) {
    return this.interactionRequest<{ data: Interaction }>(
      `/api/v1/interactions/${encodeURIComponent(input.interactionId)}/revisions`,
      {
        method: "POST",
        body: input.content,
        headers: {
          "If-Match": input.etag,
          "Idempotency-Key": input.idempotencyKey,
          ...(input.correlationId ? { "X-Correlation-Id": input.correlationId } : {}),
        },
      },
    );
  }

  async cancelInteraction(input: {
    interactionId: string;
    etag: string;
    idempotencyKey: string;
    correlationId?: string | undefined;
  }) {
    return this.interactionRequest<{ data: Interaction }>(
      `/api/v1/interactions/${encodeURIComponent(input.interactionId)}`,
      {
        method: "DELETE",
        headers: {
          "If-Match": input.etag,
          "Idempotency-Key": input.idempotencyKey,
          ...(input.correlationId ? { "X-Correlation-Id": input.correlationId } : {}),
        },
      },
    );
  }

  async getInteractionDecision(input: {
    interactionId: string;
    decisionId?: string | undefined;
    afterDecisionId?: string | undefined;
    waitMs?: number | undefined;
    approval?: boolean | undefined;
    correlationId?: string | undefined;
    signal?: AbortSignal | undefined;
  }) {
    const params = new URLSearchParams();
    if (input.decisionId) params.set("decisionId", input.decisionId);
    if (input.afterDecisionId) params.set("after", input.afterDecisionId);
    if (input.waitMs !== undefined) params.set("waitMs", String(input.waitMs));
    if (input.approval) params.set("approval", "true");
    const suffix = params.size ? `?${params}` : "";
    return this.interactionRequest<{
      data: InteractionAgentDecisionReceipt | null;
      polling: InteractionDecisionPolling;
    }>(`/api/v1/interactions/${encodeURIComponent(input.interactionId)}/decisions${suffix}`, {
      ...(input.correlationId ? { headers: { "X-Correlation-Id": input.correlationId } } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async reportInteractionFulfillment(input: {
    interactionId: string;
    decisionId: string;
    revisionId: string;
    actionId: string;
    proposalFingerprint: string;
    status: InteractionFulfillmentStatus;
    evidence?: InteractionFulfillmentEvidence | undefined;
    idempotencyKey: string;
    correlationId?: string | undefined;
  }) {
    return this.interactionRequest<{ data: InteractionFulfillmentReportResult }>(
      `/api/v1/interactions/${encodeURIComponent(input.interactionId)}/fulfillment`,
      {
        method: "POST",
        body: {
          decisionId: input.decisionId,
          revisionId: input.revisionId,
          actionId: input.actionId,
          proposalFingerprint: input.proposalFingerprint,
          status: input.status,
          ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
        },
        headers: {
          "Idempotency-Key": input.idempotencyKey,
          ...(input.correlationId ? { "X-Correlation-Id": input.correlationId } : {}),
        },
      },
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

  private async interactionRequest<T>(
    pathOrUrl: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      unknownReplay?: boolean;
    } = {},
  ): Promise<InteractionResponse<T>> {
    const response = await this.doFetch(pathOrUrl, { ...init, auth: true });
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? ((await response.json()) as unknown)
      : null;
    if (!response.ok) this.throwPayloadError(response.status, payload);
    return {
      body: payload as T,
      etag: response.headers.get("etag"),
      correlationId: response.headers.get("x-correlation-id"),
      idempotencyReplayed:
        init.unknownReplay && !response.headers.has("idempotency-replayed")
          ? null
          : response.headers.get("idempotency-replayed") === "true",
    };
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
      headers?: Record<string, string> | undefined;
    },
  ) {
    const url =
      pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
        ? pathOrUrl
        : `${this.baseUrl}${pathOrUrl}`;
    const headers: Record<string, string> = {
      accept: init.accept ?? "application/json",
      ...init.headers,
      ...(init.auth && this.workspaceId ? { "X-Commentary-Workspace-Id": this.workspaceId } : {}),
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
      const buildRequestInit = (): RequestInit => {
        const requestInit: RequestInit = {
          method: init.method ?? "GET",
          headers: { ...headers },
        };
        if (init.signal) {
          requestInit.signal = init.signal;
        }
        if (body !== undefined) {
          requestInit.body = body;
        }
        return requestInit;
      };
      const response = await this.fetchImpl(url, buildRequestInit());
      if (response.status !== 401 || !init.auth || !this.onAuthRefresh) {
        return response;
      }
      const refreshedToken = await this.onAuthRefresh();
      if (!refreshedToken) {
        return response;
      }
      this.token = refreshedToken;
      headers.authorization = `Bearer ${refreshedToken}`;
      return await this.fetchImpl(url, buildRequestInit());
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
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
        ? (payload as {
            error?: unknown;
            error_description?: unknown;
          })
        : {};
    const structured =
      body.error && typeof body.error === "object"
        ? (body.error as {
            code?: unknown;
            message?: unknown;
            correlationId?: unknown;
            retryable?: unknown;
            diagnostics?: unknown;
            details?: unknown;
          })
        : null;
    const message =
      typeof structured?.message === "string"
        ? structured.message
        : typeof body.error === "string"
          ? body.error
          : typeof body.error_description === "string"
            ? body.error_description
            : `Commentary API returned ${status}.`;
    const code = typeof structured?.code === "string" ? structured.code : undefined;
    const exitCode = structured
      ? status === 401 || status === 403
        ? ExitCode.Auth
        : status === 412 || status === 428
          ? ExitCode.StaleRevision
          : status === 400 ||
              status === 404 ||
              status === 409 ||
              status === 422 ||
              (status === 410 && code === "event_cursor_resync_required")
            ? ExitCode.Validation
            : status >= 500
              ? ExitCode.Server
              : ExitCode.Api
      : status === 401 || status === 403
        ? ExitCode.Auth
        : ExitCode.Api;
    throw new CliError(message, exitCode, {
      ...(code ? { code } : {}),
      ...(typeof structured?.correlationId === "string"
        ? { correlationId: structured.correlationId }
        : {}),
      ...(typeof structured?.retryable === "boolean" ? { retryable: structured.retryable } : {}),
      ...(Array.isArray(structured?.details) ? { diagnostics: structured.details } : {}),
      ...(Array.isArray(structured?.diagnostics) ? { diagnostics: structured.diagnostics } : {}),
    });
  }
}
