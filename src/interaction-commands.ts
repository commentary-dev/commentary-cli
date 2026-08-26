import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Option, type Command } from "commander";
import { makeClient, type CommandRuntime, type GlobalOptions } from "./commands.js";
import { CliError, ExitCode } from "./errors.js";
import { writeJson, writeText } from "./output.js";
import type {
  Interaction,
  InteractionContent,
  InteractionResourceType,
  InteractionState,
} from "./types.js";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const TERMINAL_STATES = new Set<InteractionState>([
  "completed",
  "rejected",
  "canceled",
  "expired",
  "failed",
]);
const RESOURCE_TYPES: InteractionResourceType[] = [
  "repository",
  "pull_request",
  "document",
  "draft_review",
  "form",
  "research_study",
  "knowledge_brain",
  "web_app_review",
];
const STATES: InteractionState[] = [
  "draft",
  "active",
  "waiting_for_human",
  "waiting_for_agent",
  "completed",
  "rejected",
  "canceled",
  "expired",
  "failed",
];

type CommonInteractionOptions = GlobalOptions & {
  correlationId?: string | undefined;
};

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

async function readStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_PAYLOAD_BYTES) {
      throw new CliError("Interaction payload exceeds 256 KiB.", ExitCode.Validation);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readPayload(
  runtime: CommandRuntime,
  input: { file?: string | undefined; stdin?: boolean | undefined },
) {
  if (input.file && input.stdin) {
    throw new CliError("Pass either --file or --stdin, not both.", ExitCode.Usage);
  }
  let source: string;
  if (input.file) {
    const filePath = path.resolve(runtime.cwd, input.file);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      throw new CliError(`Interaction payload file was not found: ${input.file}`, ExitCode.Usage);
    }
    if (fileStat.size > MAX_PAYLOAD_BYTES) {
      throw new CliError("Interaction payload exceeds 256 KiB.", ExitCode.Validation);
    }
    source = await readFile(filePath, "utf8");
  } else if (input.stdin) {
    if (!runtime.stdin) {
      throw new CliError("Standard input is unavailable.", ExitCode.Usage);
    }
    source = await readStream(runtime.stdin);
  } else {
    throw new CliError("Pass --file <path> or --stdin for the JSON payload.", ExitCode.Usage);
  }
  try {
    const payload = JSON.parse(source) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("object");
    }
    return payload as InteractionContent;
  } catch {
    throw new CliError("Interaction payload must be a JSON object.", ExitCode.Validation);
  }
}

function responseJson(
  interaction: Interaction,
  metadata: {
    etag: string | null;
    correlationId: string | null;
    idempotencyReplayed: boolean;
  },
) {
  return {
    ok: true,
    interaction,
    etag: metadata.etag,
    correlationId: metadata.correlationId,
    idempotencyReplayed: metadata.idempotencyReplayed,
  };
}

function formatInteraction(interaction: Interaction, etag: string | null) {
  return [
    `Interaction ${interaction.id}`,
    `State: ${interaction.state}`,
    `Version: ${interaction.version}`,
    `Resource: ${interaction.resource.type} ${interaction.resource.id}`,
    etag ? `ETag: ${etag}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function writeInteraction(
  runtime: CommandRuntime,
  commandOptions: CommonInteractionOptions,
  response: {
    body: { data: Interaction };
    etag: string | null;
    correlationId: string | null;
    idempotencyReplayed: boolean;
  },
) {
  if (commandOptions.json) {
    writeJson(runtime.stdout, responseJson(response.body.data, response));
  } else if (!commandOptions.quiet) {
    writeText(runtime.stdout, formatInteraction(response.body.data, response.etag));
  }
}

function addPayloadOptions(command: Command) {
  return command
    .option("--file <path>", "Read the JSON content object from a file.")
    .option("--stdin", "Read the JSON content object from standard input.");
}

function addRequestOptions(command: Command) {
  return command
    .requiredOption("--idempotency-key <key>", "Caller-generated retry key (maximum 200 chars).")
    .option("--correlation-id <id>", "Opaque correlation id returned by the server.");
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
      reject(new CliError("Interaction wait was interrupted.", ExitCode.Interrupted));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function addInteractionCommands(program: Command, runtime: CommandRuntime) {
  const interaction = program
    .command("interaction")
    .description("Create, inspect, revise, cancel, and wait for durable Interactions.")
    .addHelpText(
      "after",
      [
        "",
        "HTTP v1 only: the server owns validation, authorization, policy, and lifecycle rules.",
        "",
        "Examples:",
        "  commentary interaction create --resource-type draft_review --resource-id draft_123 --file request.json --idempotency-key run-42",
        "  commentary interaction get ixn_123 --json",
        "  commentary interaction wait ixn_123 --timeout 300 --json",
      ].join("\n"),
    );

  addRequestOptions(
    addPayloadOptions(
      interaction
        .command("create")
        .description("Create an Interaction for an authorized Resource.")
        .requiredOption("--resource-type <type>", "Resource type.")
        .requiredOption("--resource-id <id>", "Opaque Resource id.")
        .addOption(new Option("--initial-state <state>").choices(["draft", "active"])),
    ),
  ).action(async function (this: Command) {
    const commandOptions = options(this) as CommonInteractionOptions & {
      resourceType: InteractionResourceType;
      resourceId: string;
      initialState?: "draft" | "active";
      idempotencyKey: string;
      file?: string;
      stdin?: boolean;
    };
    if (!RESOURCE_TYPES.includes(commandOptions.resourceType)) {
      throw new CliError("Unsupported Interaction Resource type.", ExitCode.Usage);
    }
    const client = await makeClient(runtime, commandOptions);
    const content = await readPayload(runtime, commandOptions);
    const response = await client.createInteraction({
      resource: { type: commandOptions.resourceType, id: commandOptions.resourceId },
      content,
      initialState: commandOptions.initialState,
      idempotencyKey: commandOptions.idempotencyKey,
      correlationId: commandOptions.correlationId,
    });
    writeInteraction(runtime, commandOptions, response);
  });

  interaction
    .command("get")
    .description("Get one Interaction and its current strong ETag.")
    .argument("<interaction-id>")
    .option("--correlation-id <id>", "Opaque correlation id returned by the server.")
    .action(async function (this: Command, interactionId: string) {
      const commandOptions = options(this) as CommonInteractionOptions;
      const client = await makeClient(runtime, commandOptions);
      writeInteraction(
        runtime,
        commandOptions,
        await client.getInteraction({ interactionId, correlationId: commandOptions.correlationId }),
      );
    });

  interaction
    .command("list")
    .description("List a deterministic cursor page of Interactions.")
    .option("--limit <count>", "Page size from 1 to 100.", "50")
    .option("--cursor <cursor>", "Opaque cursor from a previous page.")
    .addOption(new Option("--state <state>", "Filter by lifecycle state.").choices(STATES))
    .addOption(
      new Option("--resource-type <type>", "Filter by Resource type.").choices(RESOURCE_TYPES),
    )
    .option("--correlation-id <id>", "Opaque correlation id returned by the server.")
    .action(async function (this: Command) {
      const commandOptions = options(this) as CommonInteractionOptions & {
        limit: string;
        cursor?: string;
        state?: InteractionState;
        resourceType?: InteractionResourceType;
      };
      const client = await makeClient(runtime, commandOptions);
      const response = await client.listInteractions({
        limit: positiveInteger(commandOptions.limit, "--limit", 1, 100),
        cursor: commandOptions.cursor,
        state: commandOptions.state,
        resourceType: commandOptions.resourceType,
        correlationId: commandOptions.correlationId,
      });
      if (commandOptions.json) {
        writeJson(runtime.stdout, {
          ok: true,
          interactions: response.body.data,
          page: {
            limit: positiveInteger(commandOptions.limit, "--limit", 1, 100),
            nextCursor: response.body.nextCursor,
          },
          correlationId: response.correlationId,
        });
      } else if (!commandOptions.quiet) {
        const rows = response.body.data.map(
          (item) => `${item.id}\t${item.state}\t${item.resource.type}\t${item.resource.id}`,
        );
        writeText(
          runtime.stdout,
          rows.length
            ? [...rows, response.body.nextCursor ? `Next cursor: ${response.body.nextCursor}` : ""]
                .filter(Boolean)
                .join("\n")
            : "No Interactions found.",
        );
      }
    });

  addRequestOptions(
    addPayloadOptions(
      interaction
        .command("revise")
        .description("Create an immutable revision using the current ETag.")
        .argument("<interaction-id>")
        .requiredOption("--etag <etag>", "Exact strong ETag returned by get or a prior mutation."),
    ),
  ).action(async function (this: Command, interactionId: string) {
    const commandOptions = options(this) as CommonInteractionOptions & {
      etag: string;
      idempotencyKey: string;
      file?: string;
      stdin?: boolean;
    };
    const client = await makeClient(runtime, commandOptions);
    const response = await client.reviseInteraction({
      interactionId,
      content: await readPayload(runtime, commandOptions),
      etag: commandOptions.etag,
      idempotencyKey: commandOptions.idempotencyKey,
      correlationId: commandOptions.correlationId,
    });
    writeInteraction(runtime, commandOptions, response);
  });

  addRequestOptions(
    interaction
      .command("cancel")
      .description("Cancel an Interaction using the current ETag.")
      .argument("<interaction-id>")
      .requiredOption("--etag <etag>", "Exact strong ETag returned by get or a prior mutation."),
  ).action(async function (this: Command, interactionId: string) {
    const commandOptions = options(this) as CommonInteractionOptions & {
      etag: string;
      idempotencyKey: string;
    };
    const client = await makeClient(runtime, commandOptions);
    const response = await client.cancelInteraction({
      interactionId,
      etag: commandOptions.etag,
      idempotencyKey: commandOptions.idempotencyKey,
      correlationId: commandOptions.correlationId,
    });
    writeInteraction(runtime, commandOptions, response);
  });

  interaction
    .command("wait")
    .description("Poll until an Interaction reaches a terminal state or the timeout expires.")
    .argument("<interaction-id>")
    .option("--timeout <seconds>", "Bounded timeout from 1 to 3600 seconds.", "300")
    .option("--poll-interval <ms>", "Polling interval from 250 to 60000 milliseconds.", "1000")
    .option("--correlation-id <id>", "Opaque correlation id returned by the server.")
    .action(async function (this: Command, interactionId: string) {
      const commandOptions = options(this) as CommonInteractionOptions & {
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
      const client = await makeClient(runtime, commandOptions);
      const deadline = Date.now() + timeoutMs;
      const abortController = new AbortController();
      const interrupt = () => abortController.abort();
      process.once("SIGINT", interrupt);
      runtime.signal?.addEventListener("abort", interrupt, { once: true });
      let lastState: InteractionState | undefined;
      try {
        while (true) {
          if (abortController.signal.aborted) {
            throw new CliError("Interaction wait was interrupted.", ExitCode.Interrupted);
          }
          const response = await client
            .getInteraction({
              interactionId,
              correlationId: commandOptions.correlationId,
              signal: abortController.signal,
            })
            .catch((error: unknown) => {
              if (abortController.signal.aborted) {
                throw new CliError("Interaction wait was interrupted.", ExitCode.Interrupted);
              }
              throw error;
            });
          const current = response.body.data;
          if (!commandOptions.json && !commandOptions.quiet && current.state !== lastState) {
            runtime.stderr.write(`Waiting: ${current.state} (version ${current.version})\n`);
          }
          lastState = current.state;
          if (TERMINAL_STATES.has(current.state)) {
            writeInteraction(runtime, commandOptions, response);
            if (current.state !== "completed") {
              throw new CliError(
                `Interaction reached terminal state ${current.state}.`,
                ExitCode.TerminalNegative,
              );
            }
            return;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new CliError(
              `Interaction wait timed out after ${commandOptions.timeout} seconds.`,
              ExitCode.Timeout,
            );
          }
          await delay(Math.min(intervalMs, remaining), abortController.signal);
        }
      } finally {
        process.removeListener("SIGINT", interrupt);
        runtime.signal?.removeEventListener("abort", interrupt);
      }
    });
}
