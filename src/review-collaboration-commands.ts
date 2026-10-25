import type { Command } from "commander";
import { makeClient, type CommandRuntime, type GlobalOptions } from "./commands.js";
import { readAgentPayload } from "./agent-command-helpers.js";
import { writeJson, writeText } from "./output.js";
import { CliError, ExitCode } from "./errors.js";
import type { ReviewRef } from "./types.js";
export function addReviewCollaborationCommands(program: Command, runtime: CommandRuntime) {
  const group = program
    .command("collaboration")
    .description("Read or configure collaboration on any review source.");
  for (const action of [
    "settings",
    "configure",
    "decision",
    "decide",
    "polls",
    "poll",
    "gate",
  ] as const) {
    group
      .command(action)
      .description(
        action === "configure"
          ? "Conditionally update Polls and Consensus settings."
          : "Use the shared review collaboration API.",
      )
      .option(
        "--file <path>",
        "JSON request file; use review, threadId and revision as appropriate.",
      )
      .option("--stdin", "Read JSON from standard input.")
      .action(async function (this: Command) {
        const opts = this.optsWithGlobals<GlobalOptions & { file?: string; stdin?: boolean }>();
        const body = await readAgentPayload(runtime, opts, 48 * 1024);
        const client = await makeClient(runtime, opts);
        if (
          ["configure", "decide"].includes(action) &&
          (!Number.isSafeInteger(body.expectedVersion) || typeof body.operationKey !== "string")
        )
          throw new CliError(
            "expectedVersion and operationKey are required. Retry with the same key and intent.",
            ExitCode.Usage,
          );
        const threadId = typeof body.threadId === "string" ? body.threadId : "";
        if (["decision", "decide"].includes(action) && !threadId)
          throw new CliError("threadId is required.", ExitCode.Usage);
        const result =
          action === "settings"
            ? await client.getReviewSettings(body.review as ReviewRef)
            : action === "configure"
              ? await client.updateReviewSettings(body)
              : action === "decision"
                ? await client.getReviewDecision(threadId)
                : action === "decide"
                  ? await client.mutateReviewDecision(threadId, body)
                  : action === "polls"
                    ? await client.getReviewPolls({
                        ...(body.review ? { review: body.review as ReviewRef } : {}),
                        ...(body.action
                          ? { action: body.action as "get" | "list" | "markdown" }
                          : {}),
                        ...(typeof body.threadId === "string" ? { threadId: body.threadId } : {}),
                        ...(typeof body.pollId === "string" ? { pollId: body.pollId } : {}),
                        ...(typeof body.outcome === "string" ? { outcome: body.outcome } : {}),
                        ...(typeof body.after === "string" ? { after: body.after } : {}),
                      })
                    : action === "poll"
                      ? await client.mutateReviewPoll(body)
                      : await client.getReviewGate(
                          body.review as ReviewRef,
                          String(body.revision ?? ""),
                        );
        if (opts.json) writeJson(runtime.stdout, result);
        else if (!opts.quiet) writeText(runtime.stdout, JSON.stringify(result, null, 2));
      });
  }
}
