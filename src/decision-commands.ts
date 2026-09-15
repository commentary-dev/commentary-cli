import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Option, type Command } from "commander";
import { makeClient, type CommandRuntime, type GlobalOptions } from "./commands.js";
import { CliError, ExitCode } from "./errors.js";
import { writeJson, writeText } from "./output.js";
import type {
  InteractionAgentDecisionReceipt,
  InteractionFulfillmentEvidence,
  InteractionFulfillmentReport,
  InteractionFulfillmentStatus,
} from "./types.js";

const MAX_EVIDENCE_BYTES = 8 * 1024;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const NEGATIVE_DECISION_OUTCOMES = new Set(["reject", "request_revision"]);
const NEGATIVE_DECISION_STATES = new Set(["rejected", "canceled", "expired"]);
const SENSITIVE_EVIDENCE_KEY =
  /(?:authorization|cookie|credential|password|private.?key|secret|token)/iu;
const FULFILLMENT_STATUSES: InteractionFulfillmentStatus[] = [
  "received",
  "started",
  "completed",
  "failed",
  "unknown",
];

type CommonOptions = GlobalOptions & { correlationId?: string | undefined };

function options(command: Command) {
  return { ...command.optsWithGlobals<GlobalOptions>(), ...command.opts() };
}

function positiveInteger(value: string, label: string, minimum: number, maximum: number) {
  if (!/^\d+$/u.test(value)) {
    throw new CliError(`${label} must be an integer.`, ExitCode.Usage);
  }
  const number = Number(value);
  if (number < minimum || number > maximum) {
    throw new CliError(`${label} must be between ${minimum} and ${maximum}.`, ExitCode.Usage);
  }
  return number;
}

function exactFingerprint(value: string) {
  if (!FINGERPRINT.test(value)) {
    throw new CliError(
      "--proposal-fingerprint must be the exact lowercase 64-character SHA-256 fingerprint from the approved Decision.",
      ExitCode.Validation,
    );
  }
  return value;
}

async function readBoundedStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_EVIDENCE_BYTES) {
      throw new CliError("Fulfillment evidence exceeds 8 KiB.", ExitCode.Validation);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function containsSensitiveKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  return Object.entries(value).some(
    ([key, child]) => SENSITIVE_EVIDENCE_KEY.test(key) || containsSensitiveKey(child),
  );
}

async function readEvidence(
  runtime: CommandRuntime,
  input: { evidenceFile?: string | undefined; evidenceStdin?: boolean | undefined },
): Promise<InteractionFulfillmentEvidence | undefined> {
  if (input.evidenceFile && input.evidenceStdin) {
    throw new CliError(
      "Pass either --evidence-file or --evidence-stdin, not both.",
      ExitCode.Usage,
    );
  }
  if (!input.evidenceFile && !input.evidenceStdin) return undefined;

  let source: string;
  if (input.evidenceFile) {
    const filePath = path.resolve(runtime.cwd, input.evidenceFile);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      throw new CliError("The Fulfillment evidence file was not found.", ExitCode.Usage);
    }
    if (fileStat.size > MAX_EVIDENCE_BYTES) {
      throw new CliError("Fulfillment evidence exceeds 8 KiB.", ExitCode.Validation);
    }
    source = await readFile(filePath, "utf8");
  } else {
    if (!runtime.stdin) {
      throw new CliError("Standard input is unavailable.", ExitCode.Usage);
    }
    source = await readBoundedStream(runtime.stdin);
  }

  let evidence: unknown;
  try {
    evidence = JSON.parse(source);
  } catch {
    throw new CliError("Fulfillment evidence must be a JSON object.", ExitCode.Validation);
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new CliError("Fulfillment evidence must be a JSON object.", ExitCode.Validation);
  }
  if (containsSensitiveKey(evidence)) {
    throw new CliError(
      "Fulfillment evidence contains a forbidden sensitive field.",
      ExitCode.Validation,
    );
  }
  return evidence as InteractionFulfillmentEvidence;
}

function decisionIsNegative(decision: InteractionAgentDecisionReceipt) {
  return (
    NEGATIVE_DECISION_OUTCOMES.has(decision.outcome) ||
    NEGATIVE_DECISION_STATES.has(decision.terminalState)
  );
}

function decisionJson(
  decision: InteractionAgentDecisionReceipt,
  correlationId: string | null,
  polling: { complete: boolean; timedOut?: boolean; retryAfterMs: number | null },
) {
  return { ok: true, decision, polling, correlationId };
}

function writeDecision(
  runtime: CommandRuntime,
  commandOptions: CommonOptions,
  response: {
    body: {
      data: InteractionAgentDecisionReceipt;
      polling: { complete: boolean; timedOut?: boolean; retryAfterMs: number | null };
    };
    correlationId: string | null;
  },
) {
  const decision = response.body.data;
  if (commandOptions.json) {
    writeJson(
      runtime.stdout,
      decisionJson(decision, response.correlationId, response.body.polling),
    );
  } else if (!commandOptions.quiet) {
    writeText(
      runtime.stdout,
      [
        `Decision ${decision.id}`,
        `Outcome: ${decision.outcome}`,
        `State: ${decision.terminalState}`,
        `Interaction: ${decision.interactionId}`,
        `Revision: ${decision.revisionId}`,
        `Action: ${decision.actionId}`,
        `Proposal fingerprint: ${decision.proposalFingerprint}`,
        `Decided at: ${decision.decidedAt}`,
        `Purged: ${decision.purged ? "yes" : "no"}`,
      ].join("\n"),
    );
  }
}

async function delay(ms: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const done = () => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      done();
      reject(new CliError("Decision wait was interrupted.", ExitCode.Interrupted));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function throwNegativeDecision(decision: InteractionAgentDecisionReceipt) {
  if (decisionIsNegative(decision)) {
    throw new CliError(
      `Decision reached negative outcome ${decision.outcome}.`,
      ExitCode.TerminalNegative,
      { code: "decision_negative" },
    );
  }
}

function safeFulfillmentReport(report: InteractionFulfillmentReport) {
  return {
    id: report.id,
    interactionId: report.interactionId,
    decisionId: report.decisionId,
    revisionId: report.revisionId,
    actionId: report.actionId,
    proposalFingerprint: report.proposalFingerprint,
    status: report.status,
    reportedAt: report.reportedAt,
    contentPurgedAt: report.contentPurgedAt,
    selfReported: report.selfReported,
    verified: report.verified,
  };
}

export function addDecisionAndFulfillmentCommands(program: Command, runtime: CommandRuntime) {
  const decision = program
    .command("decision")
    .description("Read or wait for immutable human Decision receipts.")
    .addHelpText(
      "after",
      [
        "",
        "HTTP v1 read-only: agents cannot approve, reject, choose, answer, or otherwise write Decisions.",
        "",
        "Examples:",
        "  commentary decision get ixn_123 ixd_123 --json",
        "  commentary decision wait ixn_123 --timeout 300 --json",
        "  commentary decision wait ixn_123 --after ixd_previous --timeout 300 --json",
      ].join("\n"),
    );

  decision
    .command("get")
    .description("Get one privacy-safe immutable Decision receipt.")
    .argument("<interaction-id>")
    .argument("<decision-id>")
    .option("--correlation-id <id>", "Opaque correlation id returned by the server.")
    .action(async function (this: Command, interactionId: string, decisionId: string) {
      const commandOptions = options(this) as CommonOptions;
      const client = await makeClient(runtime, commandOptions);
      const response = await client.getInteractionDecision({
        interactionId,
        decisionId,
        correlationId: commandOptions.correlationId,
      });
      if (!response.body.data) {
        throw new CliError("Decision receipt was not found.", ExitCode.Validation, {
          code: "decision_not_found",
        });
      }
      const found = {
        ...response,
        body: { ...response.body, data: response.body.data },
      };
      writeDecision(runtime, commandOptions, found);
      throwNegativeDecision(found.body.data);
    });

  decision
    .command("wait")
    .description("Poll until a Decision receipt is available or the timeout expires.")
    .argument("<interaction-id>")
    .option("--after <decision-id>", "Wait for a receipt after this opaque Decision id.")
    .option(
      "--approval",
      "Wait for an approving receipt whose exact current approval policy is satisfied.",
    )
    .option("--timeout <seconds>", "Bounded timeout from 1 to 3600 seconds.", "300")
    .option("--poll-interval <ms>", "Polling interval from 250 to 60000 milliseconds.", "1000")
    .option("--correlation-id <id>", "Opaque correlation id returned by the server.")
    .action(async function (this: Command, interactionId: string) {
      const commandOptions = options(this) as CommonOptions & {
        after?: string;
        approval?: boolean;
        timeout: string;
        pollInterval: string;
      };
      const timeoutMs = positiveInteger(commandOptions.timeout, "--timeout", 1, 3600) * 1000;
      const intervalMs = positiveInteger(
        commandOptions.pollInterval,
        "--poll-interval",
        250,
        60_000,
      );
      const deadline = Date.now() + timeoutMs;
      const client = await makeClient(runtime, commandOptions);
      const abortController = new AbortController();
      const interrupt = () => abortController.abort();
      if (runtime.signal?.aborted) interrupt();
      const timeoutTimer = setTimeout(() => abortController.abort(), timeoutMs);
      process.once("SIGINT", interrupt);
      runtime.signal?.addEventListener("abort", interrupt, { once: true });
      try {
        while (true) {
          if (abortController.signal.aborted) {
            throw new CliError("Decision wait was interrupted.", ExitCode.Interrupted);
          }
          const response = await client.getInteractionDecision({
            interactionId,
            afterDecisionId: commandOptions.after,
            waitMs: 0,
            approval: commandOptions.approval,
            correlationId: commandOptions.correlationId,
            signal: abortController.signal,
          });
          const approval = response.body.polling.approval ?? response.body.data?.aggregate;
          if (
            commandOptions.approval &&
            approval &&
            ["rejected", "expired", "unsatisfiable"].includes(approval.state)
          ) {
            throw new CliError(
              `Approval is ${approval.state}. Request a new revision before proceeding.`,
              ExitCode.TerminalNegative,
              { code: "approval_negative" },
            );
          }
          if (commandOptions.approval && response.body.data && !approval) {
            throw new CliError(
              "The server did not return current-policy approval status.",
              ExitCode.Api,
              { code: "approval_status_missing" },
            );
          }
          if (
            response.body.data &&
            (!commandOptions.approval ||
              (approval?.state === "approved" && response.body.data.outcome === "approve"))
          ) {
            const found = {
              ...response,
              body: { ...response.body, data: response.body.data },
            };
            writeDecision(runtime, commandOptions, found);
            throwNegativeDecision(found.body.data);
            return;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new CliError(
              `Decision wait timed out after ${commandOptions.timeout} seconds.`,
              ExitCode.Timeout,
              { code: "decision_wait_timeout" },
            );
          }
          await delay(Math.min(intervalMs, remaining), abortController.signal);
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          if (Date.now() >= deadline)
            throw new CliError(
              `Decision wait timed out after ${commandOptions.timeout} seconds.`,
              ExitCode.Timeout,
              { code: "decision_wait_timeout" },
            );
          throw new CliError("Decision wait was interrupted.", ExitCode.Interrupted);
        }
        throw error;
      } finally {
        clearTimeout(timeoutTimer);
        process.removeListener("SIGINT", interrupt);
        runtime.signal?.removeEventListener("abort", interrupt);
      }
    });

  const fulfillment = program
    .command("fulfillment")
    .description("Report append-only, self-reported Fulfillment for an approved proposal.")
    .addHelpText(
      "after",
      [
        "",
        "HTTP v1 only. Reports are retry-safe self-reports, not verified provider-success proof.",
        "",
        "Example:",
        "  commentary fulfillment report ixn_123 --decision-id ixd_123 --revision-id ixr_123 --action-id ixa_123 --proposal-fingerprint <sha256> --status completed --idempotency-key report-42 --evidence-file evidence.json --json",
      ].join("\n"),
    );

  fulfillment
    .command("report")
    .description("Append a retry-safe Fulfillment report for an exact approved fingerprint.")
    .argument("<interaction-id>")
    .requiredOption("--decision-id <id>", "Exact opaque approved Decision id.")
    .requiredOption("--revision-id <id>", "Exact opaque approved revision id.")
    .requiredOption("--action-id <id>", "Exact opaque approved action id.")
    .requiredOption("--proposal-fingerprint <sha256>", "Exact approved proposal fingerprint.")
    .addOption(
      new Option("--status <status>", "Self-reported status.")
        .choices(FULFILLMENT_STATUSES)
        .makeOptionMandatory(),
    )
    .requiredOption("--idempotency-key <key>", "Caller-generated retry key (maximum 200 chars).")
    .option("--evidence-file <path>", "Read bounded structured evidence from a JSON file.")
    .option("--evidence-stdin", "Read bounded structured evidence from standard input.")
    .option("--correlation-id <id>", "Opaque correlation id returned by the server.")
    .action(async function (this: Command, interactionId: string) {
      const commandOptions = options(this) as CommonOptions & {
        decisionId: string;
        revisionId: string;
        actionId: string;
        proposalFingerprint: string;
        status: InteractionFulfillmentStatus;
        idempotencyKey: string;
        evidenceFile?: string;
        evidenceStdin?: boolean;
      };
      if (commandOptions.idempotencyKey.length > 200) {
        throw new CliError(
          "--idempotency-key must contain at most 200 characters.",
          ExitCode.Usage,
        );
      }
      const client = await makeClient(runtime, commandOptions);
      const response = await client.reportInteractionFulfillment({
        interactionId,
        decisionId: commandOptions.decisionId,
        revisionId: commandOptions.revisionId,
        actionId: commandOptions.actionId,
        proposalFingerprint: exactFingerprint(commandOptions.proposalFingerprint),
        status: commandOptions.status,
        evidence: await readEvidence(runtime, commandOptions),
        idempotencyKey: commandOptions.idempotencyKey,
        correlationId: commandOptions.correlationId,
      });
      const report = response.body.data.report;
      if (commandOptions.json) {
        writeJson(runtime.stdout, {
          ok: true,
          fulfillment: {
            report: safeFulfillmentReport(response.body.data.report),
            current: safeFulfillmentReport(response.body.data.current),
          },
          correlationId: response.correlationId,
          idempotencyReplayed: response.idempotencyReplayed,
        });
      } else if (!commandOptions.quiet) {
        writeText(
          runtime.stdout,
          [
            `Fulfillment report ${report?.id ?? "accepted"}`,
            `Status: ${report?.status ?? commandOptions.status}`,
            `Interaction: ${interactionId}`,
            `Decision: ${commandOptions.decisionId}`,
            `Proposal fingerprint: ${commandOptions.proposalFingerprint}`,
            `Idempotency replayed: ${response.idempotencyReplayed ? "yes" : "no"}`,
            "Self-reported: yes",
            "Verified provider success: no",
          ].join("\n"),
        );
      }
    });
}
