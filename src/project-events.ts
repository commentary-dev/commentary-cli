import { setTimeout as delay } from "node:timers/promises";
import type { CommentaryApiClient, InteractionResponse } from "./api-client.js";
import type { AgentRequest } from "./agent-api.js";
import { CliError, ExitCode } from "./errors.js";

export type ProjectEvent = {
  id: string;
  eventType: string;
  resource: { type: string; id: string };
  aggregateVersion: number;
  retrievalUrl: string;
  change: string;
  occurredAt: string;
};
export type ProjectEventPage = {
  items: ProjectEvent[];
  nextCursor: string;
  hasMore: boolean;
  outcome: "events" | "idle" | "timeout" | "canceled";
};

/** Bounded polling uses durable continuation; notifications never imply approval. */
export async function waitProjectEvents(
  client: Pick<CommentaryApiClient, "projectOperation">,
  operationId: string,
  input: AgentRequest,
  options: { timeoutMs: number; signal?: AbortSignal | undefined; resyncOperationId: string },
): Promise<InteractionResponse<Record<string, unknown>>> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 3600000)
    throw new CliError("Event timeout must be between 0 and 3600000 ms.", ExitCode.Usage);
  const controller = new AbortController();
  let interrupted = options.signal?.aborted ?? false;
  const cancel = () => {
    interrupted = true;
    controller.abort();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (interrupted) controller.abort();
  const deadline = Date.now() + options.timeoutMs;
  const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  let cursor = input.query?.cursor;
  let resynchronized = false;
  let snapshot: unknown;
  let disconnects = 0;
  const waitFailure = (message: string, exitCode: number) =>
    new CliError(message, exitCode, {
      diagnostics: [
        { nextCursor: typeof cursor === "string" ? cursor : null, pendingAttention: true },
      ],
    });
  const stopped = () => {
    if (interrupted) throw waitFailure("Event wait interrupted.", ExitCode.Interrupted);
    if (controller.signal.aborted) throw waitFailure("Event wait timed out.", ExitCode.Timeout);
  };
  try {
    for (;;) {
      stopped();
      const remaining = deadline - Date.now();
      if (options.timeoutMs && remaining <= 0)
        throw waitFailure("Event wait timed out.", ExitCode.Timeout);
      try {
        const response = await client.projectOperation(operationId, {
          ...input,
          query: {
            ...input.query,
            cursor,
            waitMs: options.timeoutMs ? Math.min(10000, remaining) : (input.query?.waitMs ?? 0),
          },
          signal: controller.signal,
        });
        stopped();
        const page = response.body.data as ProjectEventPage;
        if (!page || !Array.isArray(page.items) || typeof page.nextCursor !== "string")
          throw new CliError("Server returned an invalid durable event page.", ExitCode.Api);
        cursor = page.nextCursor;
        // Each page is a bounded batch. Consumers retain nextCursor for the next invocation.
        if (page.items.length || !options.timeoutMs || page.hasMore)
          return {
            ...response,
            body: {
              ...response.body,
              data: {
                ...page,
                items: [...new Map(page.items.map((event) => [event.id, event])).values()],
                ...(resynchronized ? { resynchronized, snapshot } : {}),
              },
            },
          };
        if (page.outcome === "canceled")
          throw waitFailure("Event wait interrupted.", ExitCode.Interrupted);
        await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, {
          signal: controller.signal,
        });
      } catch (error) {
        stopped();
        if (
          error instanceof CliError &&
          error.code === "event_cursor_resync_required" &&
          !resynchronized
        ) {
          const current = await client.projectOperation(options.resyncOperationId, {
            ...(input.params ? { params: input.params } : {}),
            signal: controller.signal,
          });
          snapshot = current.body.data;
          resynchronized = true;
          cursor = undefined;
          continue;
        }
        if (
          options.timeoutMs &&
          error instanceof CliError &&
          error.exitCode === ExitCode.Network &&
          disconnects++ < 3
        ) {
          await delay(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, {
            signal: controller.signal,
          }).catch(() => stopped());
          continue;
        }
        throw error;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
