import { open, unlink } from "node:fs/promises";
import { Option, type Command } from "commander";
import { makeClient, type CommandRuntime, type GlobalOptions } from "./commands.js";
import type { AgentOperation, AgentRequest } from "./agent-api.js";
import {
  pageLimit,
  readAgentPayload,
  secretDestination,
  writeAgentResponse,
} from "./agent-command-helpers.js";
import { CliError, ExitCode } from "./errors.js";

type Definition = {
  name: string;
  operation: AgentOperation;
  description: string;
  arguments?: [string, string][];
  payload?: boolean;
  etag?: boolean;
  retryKey?: boolean;
  secret?: boolean;
  list?: boolean;
  limit?: number;
  options?: [string, string][];
};
type Options = GlobalOptions & {
  file?: string;
  stdin?: boolean;
  etag?: string;
  idempotencyKey?: string;
  correlationId?: string;
  secretFile?: string;
  yes?: boolean;
  limit?: string;
  cursor?: string;
  state?: string;
  filter?: string[];
  [key: string]: unknown;
};

function register(parent: Command, runtime: CommandRuntime, definition: Definition) {
  const command = parent
    .command(definition.name)
    .description(definition.description)
    .option("--correlation-id <id>", "Request correlation id.");
  for (const [label] of definition.arguments ?? []) command.argument(label);
  if (definition.payload)
    command
      .option("--file <path>", "Read the JSON request from a file.")
      .option("--stdin", "Read the JSON request from standard input.");
  if (definition.etag)
    command.requiredOption(
      "--etag <etag>",
      "Exact strong ETag from the previous read or mutation.",
    );
  if (definition.retryKey)
    command.requiredOption(
      "--idempotency-key <key>",
      "Caller-generated retry key, at most 200 characters.",
    );
  if (definition.secret)
    command.requiredOption(
      "--secret-file <path>",
      "Write the one-time signing secret to a new file outside the project.",
    );
  if (definition.list)
    command
      .option(
        "--limit <count>",
        `Page size, at most ${definition.limit ?? 100}.`,
        String(definition.limit === 25 ? 25 : definition.limit === 20 ? 20 : 50),
      )
      .option("--cursor <cursor>", "Opaque continuation from the previous page.");
  for (const [flag, description] of definition.options ?? []) command.option(flag, description);
  if (definition.operation === "deliveryReplay")
    command.requiredOption("--yes", "Confirm replay of this delivery.");
  if (definition.operation === "interactionUpdate")
    command.addOption(
      new Option("--state <state>", "Non-decision lifecycle state.")
        .choices(["active", "waiting_for_human", "waiting_for_agent", "expired", "failed"])
        .makeOptionMandatory(),
    );
  if (definition.operation === "resourceList")
    command.option(
      "--filter <key=value>",
      "Repeat a collection filter.",
      (value: string, previous: string[] = []) => [...previous, value],
    );
  command.action(async function (this: Command, ...args: unknown[]) {
    const options = this.optsWithGlobals<Options>();
    const params: Record<string, string | undefined> = {};
    for (let index = 0; index < (definition.arguments?.length ?? 0); index++)
      params[definition.arguments![index]![1]] =
        typeof args[index] === "string" ? (args[index] as string) : undefined;
    const query: NonNullable<AgentRequest["query"]> = {};
    if (definition.list) {
      query.limit = pageLimit(options.limit!, definition.limit);
      query.cursor = options.cursor;
    }
    for (const key of [
      "q",
      "section",
      "sort",
      "mode",
      "bucket",
      "resourceType",
      "sourceKind",
      "agentId",
      "status",
      "deadline",
      "assignment",
      "queueName",
      "window",
      "scope",
    ]) {
      if (typeof options[key] === "string") query[key] = options[key] as string;
    }
    if (definition.operation === "resourceList") {
      const filters: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
      for (const filter of options.filter ?? []) {
        const separator = filter.indexOf("=");
        if (separator <= 0 || separator === filter.length - 1)
          throw new CliError("--filter must be key=value.", ExitCode.Usage);
        const key = filter.slice(0, separator);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key))
          throw new CliError("Invalid filter name.", ExitCode.Usage);
        filters[key] = [...(filters[key] ?? []), filter.slice(separator + 1)];
      }
      query.filters = JSON.stringify(filters);
    }
    if (
      options.idempotencyKey &&
      (!options.idempotencyKey.trim() || options.idempotencyKey.length > 200)
    )
      throw new CliError("--idempotency-key must contain 1 to 200 characters.", ExitCode.Usage);
    const body = definition.payload
      ? await readAgentPayload(
          runtime,
          options,
          definition.secret || definition.operation === "viewPropose" ? 16 * 1024 : undefined,
        )
      : definition.operation === "interactionUpdate"
        ? { state: options.state }
        : definition.operation === "deliveryReplay"
          ? { confirm: true }
          : undefined;
    const client = await makeClient(runtime, options);
    const destination = definition.secret
      ? await secretDestination(runtime.cwd, options.secretFile!)
      : undefined;
    const handle = destination
      ? await open(destination, "wx", 0o600).catch(() => {
          throw new CliError("The secret file must be new and writable.", ExitCode.Safety);
        })
      : undefined;
    let saved = false;
    try {
      const response = await client.agentOperation(definition.operation, {
        params,
        query,
        body,
        etag: options.etag,
        idempotencyKey: options.idempotencyKey,
        correlationId: options.correlationId,
      });
      if (handle) {
        const data = response.body.data as Record<string, unknown> | undefined;
        const secret = data?.secret;
        if (typeof secret === "string") {
          await handle.writeFile(`${secret}\n`, "utf8");
          saved = true;
          const safe = { ...data };
          Reflect.deleteProperty(safe, "secret");
          response.body = { ...response.body, data: safe, secretSaved: true };
        } else response.body = { ...response.body, secretSaved: false, secretUnavailable: true };
      }
      writeAgentResponse(runtime, options, response);
    } finally {
      await handle?.close();
      if (destination && !saved) await unlink(destination);
    }
  });
}

export function addAgentCommands(program: Command, runtime: CommandRuntime) {
  const interaction = program.commands.find((command) => command.name() === "interaction")!;
  register(interaction, runtime, {
    name: "update",
    operation: "interactionUpdate",
    description: "Conditionally update a non-decision lifecycle state.",
    arguments: [["<interaction-id>", "interactionId"]],
    etag: true,
    retryKey: true,
  });
  const messages = interaction
    .command("messages")
    .description("Read conversation and send new agent replies.");
  register(messages, runtime, {
    name: "list",
    operation: "messageList",
    description: "Read one conversation page without marking it read.",
    arguments: [["<interaction-id>", "interactionId"]],
    list: true,
  });
  register(messages, runtime, {
    name: "send",
    operation: "messageSend",
    description: "Append an agent message from a JSON body/revisionId request.",
    arguments: [["<interaction-id>", "interactionId"]],
    payload: true,
    etag: true,
    retryKey: true,
  });
  const guidance = interaction
    .command("guidance")
    .description("Retrieve and acknowledge future guidance as the creating agent.");
  register(guidance, runtime, {
    name: "list",
    operation: "guidanceList",
    description: "Read immutable guidance and delivery receipts.",
    arguments: [["<interaction-id>", "interactionId"]],
    list: true,
  });
  register(guidance, runtime, {
    name: "acknowledge",
    operation: "guidanceAcknowledge",
    description: "Acknowledge delivery; this does not claim learning or application.",
    arguments: [
      ["<interaction-id>", "interactionId"],
      ["<guidance-id>", "guidanceId"],
    ],
    retryKey: true,
  });
  register(program.commands.find((command) => command.name() === "fulfillment")!, runtime, {
    name: "get",
    operation: "fulfillmentGet",
    description: "Read current self-reported fulfillment and retained history.",
    arguments: [["<interaction-id>", "interactionId"]],
  });
  const workspace = program
    .command("workspace")
    .description("Discover and update work within delegated workspace authority.");
  register(workspace, runtime, {
    name: "list",
    operation: "workspaceList",
    description: "List workspaces authorized by this credential.",
  });
  register(workspace, runtime, {
    name: "get",
    operation: "workspaceGet",
    description: "Read workspace context and effective agent capabilities.",
    arguments: [["[workspace-id]", "workspaceId"]],
  });
  const resources = workspace
    .command("resources")
    .description("Source-authorized workspace collections; requires --workspace.");
  register(resources, runtime, {
    name: "list",
    operation: "resourceList",
    description: "Read a resource collection page.",
    list: true,
    limit: 25,
    options: [
      ["--section <section>", "reviews, forms, research, brain, or sources."],
      ["--q <query>", "Search names and source context."],
      ["--sort <sort>", "Collection sort."],
    ],
  });
  register(resources, runtime, {
    name: "get",
    operation: "resourceGet",
    description: "Read an authorized resource summary.",
    arguments: [
      ["<resource-type>", "resourceType"],
      ["<resource-id>", "resourceId"],
    ],
  });
  register(resources, runtime, {
    name: "link",
    operation: "resourceLink",
    description: "Link a resource using a JSON type/id request.",
    payload: true,
    retryKey: true,
  });
  register(resources, runtime, {
    name: "rename",
    operation: "resourceRename",
    description: "Rename an authorized draft or preview using title/expectedUpdatedAt JSON.",
    arguments: [
      ["<resource-type>", "resourceType"],
      ["<resource-id>", "resourceId"],
    ],
    payload: true,
  });
  const queue = workspace
    .command("queue")
    .description("Read eligible team work; assignment remains human-owned.");
  register(queue, runtime, {
    name: "list",
    operation: "queueList",
    description: "Read the authorized team queue.",
    options: [
      ["--queue-name <name>", "Queue name."],
      ["--assignment <value>", "any, me, or unassigned."],
    ],
  });
  const inbox = program
    .command("inbox")
    .description("Read delegated Inbox work and submit inactive proposals.");
  register(inbox, runtime, {
    name: "list",
    operation: "inboxList",
    description: "Read ranked work without changing recipient state.",
    list: true,
    options: [
      ["--mode <mode>", "active or history."],
      ["--sort <sort>", "recommended, newest, or due_soon."],
      ["--bucket <bucket>", "Attention bucket."],
      ["--resource-type <type>", "Resource type."],
      ["--source-kind <kind>", "Source category."],
      ["--agent-id <id>", "Registered sender."],
      ["--status <status>", "Recipient status."],
      ["--deadline <deadline>", "Deadline window."],
      ["--assignment <assignment>", "any, me, or unassigned."],
    ],
  });
  register(inbox, runtime, {
    name: "get",
    operation: "inboxGet",
    description: "Read one authorized item independently of feed pagination.",
    arguments: [
      ["<workspace-id>", "workspaceId"],
      ["<entry-id>", "entryId"],
    ],
  });
  const views = inbox
    .command("view")
    .description("Read saved views and propose new views to their human owner.");
  register(views, runtime, {
    name: "list",
    operation: "viewList",
    description: "Read private saved views.",
  });
  register(views, runtime, {
    name: "propose",
    operation: "viewPropose",
    description: "Submit an inactive name/definition proposal.",
    payload: true,
  });
  const policies = inbox
    .command("policy")
    .description("Inspect, propose, and simulate typed attention policies.");
  register(policies, runtime, {
    name: "list",
    operation: "policyList",
    description: "Read authorized policy versions.",
    options: [["--scope <scope>", "personal or workspace."]],
  });
  register(policies, runtime, {
    name: "get",
    operation: "policyGet",
    description: "Read an authorized policy.",
    arguments: [["<policy-id>", "policyId"]],
  });
  register(policies, runtime, {
    name: "propose",
    operation: "policyPropose",
    description: "Submit a disabled pending policy proposal.",
    payload: true,
    retryKey: true,
  });
  register(policies, runtime, {
    name: "simulate",
    operation: "policySimulate",
    description: "Evaluate a proposal against authorized metadata without applying effects.",
    payload: true,
  });
  register(inbox, runtime, {
    name: "insights",
    operation: "insightGet",
    description: "Read content-free, privacy-thresholded outcome insights.",
    options: [["--window <days>", "30 or 90 days."]],
  });
  const notifications = inbox
    .command("notifications")
    .description("Read delivery receipts without changing consent.");
  register(notifications, runtime, {
    name: "list",
    operation: "notificationList",
    description: "Read minimized notification history.",
    list: true,
    limit: 20,
  });
  const webhooks = program
    .command("webhook")
    .description("Manage scoped outbound subscriptions and delivery receipts.");
  register(webhooks, runtime, {
    name: "list",
    operation: "webhookList",
    description: "Read a subscription page.",
    list: true,
  });
  register(webhooks, runtime, {
    name: "get",
    operation: "webhookGet",
    description: "Read a subscription and its ETag.",
    arguments: [["<subscription-id>", "subscriptionId"]],
  });
  register(webhooks, runtime, {
    name: "create",
    operation: "webhookCreate",
    description: "Create a subscription from endpointUrl/eventTypes JSON.",
    payload: true,
    retryKey: true,
    secret: true,
  });
  for (const [name, operation, payload, secret] of [
    ["update", "webhookUpdate", true, false],
    ["disable", "webhookDisable", false, false],
    ["rotate-secret", "webhookRotate", false, true],
  ] as const)
    register(webhooks, runtime, {
      name,
      operation,
      description: "Conditionally change a subscription using its exact ETag.",
      arguments: [["<subscription-id>", "subscriptionId"]],
      etag: true,
      payload,
      secret,
    });
  const deliveries = webhooks
    .command("deliveries")
    .description("Inspect and deliberately replay delivery attempts.");
  register(deliveries, runtime, {
    name: "list",
    operation: "deliveryList",
    description: "Read delivery receipts.",
    arguments: [["<subscription-id>", "subscriptionId"]],
    list: true,
    options: [["--status <status>", "Delivery status."]],
  });
  register(deliveries, runtime, {
    name: "replay",
    operation: "deliveryReplay",
    description: "Replay one delivery with explicit confirmation.",
    arguments: [
      ["<subscription-id>", "subscriptionId"],
      ["<delivery-id>", "deliveryId"],
    ],
  });
}
