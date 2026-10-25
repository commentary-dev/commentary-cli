import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Command } from "commander";
import { makeClient, type CommandRuntime, type GlobalOptions } from "./commands.js";
import { PROJECT_OPERATIONS, readProjectPayload, validateProjectInput } from "./project-payload.js";
import { CliError, ExitCode } from "./errors.js";
import { pageLimit, writeAgentResponse } from "./agent-command-helpers.js";
import { writeText } from "./output.js";

type Options = GlobalOptions & {
  file?: string;
  stdin?: boolean;
  etag?: string;
  idempotencyKey?: string;
  correlationId?: string;
  providerIntent?: boolean;
  dryRun?: boolean;
  output?: string;
  project?: string;
  tracker?: string;
  [key: string]: unknown;
};
const names: Record<string, string[]> = {
  review_progress_reconcile: ["review", "reconcile"],
  records_patch: ["records", "update"],
  schema_apply: ["schema", "apply"],
  import_new_preview: ["import", "new-preview"],
  source_bind: ["sync", "bind"],
  source_refresh: ["sync", "refresh"],
  proposal_stage: ["proposals", "stage"],
  authority_migrate: ["authority", "apply"],
  schemas_list: ["schema", "list"],
};
const reserved = new Set([
  "getProjectStatus",
  "listProjectActivity",
  "listProjectFeedback",
  "listTrackerActivity",
  "listTrackerFeedback",
]);

export function addProjectCommands(program: Command, runtime: CommandRuntime) {
  const families = new Map([
    [
      "commentary_projects",
      program
        .command("project")
        .description("Optional Projects and independently authorized Resource links."),
    ],
    [
      "commentary_trackers",
      program
        .command("tracker")
        .description("Schema-defined Trackers, records, native views and portable Git proposals."),
    ],
  ]);
  for (const operation of PROJECT_OPERATIONS) {
    const root = families.get(operation.family);
    if (!root || (operation.status !== "implemented" && !reserved.has(operation.operationId)))
      continue;
    const words = names[operation.action] ?? operation.action.split("_");
    let parent = root;
    for (const word of words.slice(0, -1))
      parent = parent.commands.find((command) => command.name() === word) ?? parent.command(word);
    const command = parent
      .command(words.at(-1)!)
      .description(`${operation.operationId}; scopes: ${operation.scopes.join(", ")}.`);
    const params = [...operation.path.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!);
    const schema = catalogInput(operation.inputSchema);
    const fields = Object.keys(schema.properties!).filter((key) => !params.includes(key));
    const payload = operation.method !== "GET" && fields.length > 0;
    // Parent IDs are explicit options; child identity is an explicit positional argument.
    for (const key of params) {
      if (key === "projectId" || key === "trackerId")
        command.requiredOption(
          `--${key === "projectId" ? "project" : "tracker"} <id>`,
          "Explicit Resource identity.",
        );
      else command.argument(`<${key}>`);
    }
    command.option("--correlation-id <id>", "Request correlation ID.");
    if (operation.ifMatch)
      command.requiredOption("--etag <etag>", "Exact strong ETag from the previous read.");
    if (operation.idempotencyKey)
      command.requiredOption("--idempotency-key <key>", "Reuse only for an exact retry.");
    if (payload)
      command
        .option("--file <path>", "JSON/YAML request object.")
        .option("--stdin", "Read the request object from standard input.");
    if (operation.method === "GET")
      for (const key of fields.filter((key) => key !== "workspaceId")) {
        const flag = key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
        command.option(
          `--${flag} <value>`,
          `Server ${key} query.`,
          key === "limit" ? "25" : undefined,
        );
      }
    if (operation.scopes.includes("commentary.trackers.writeback"))
      command.requiredOption(
        "--provider-intent",
        "Explicitly authorize the named server provider operation.",
      );
    if (
      ["previewTrackerImport", "previewNewTrackerImport", "previewTrackerSync"].includes(
        operation.operationId,
      )
    )
      command.option(
        "--dry-run",
        "Preview only; does not apply records or dispatch provider writes.",
      );
    if (
      ["previewTrackerImport", "previewNewTrackerImport", "stageTrackerProposal"].includes(
        operation.operationId,
      )
    )
      command
        .option("--mode <mode>", "Explicit import mode for a canonical bundle.")
        .option("--expected-schema-revision-id <id>", "Exact schema for a canonical bundle.")
        .option("--base-commit-sha <sha>", "Exact source base for a canonical proposal.");
    if (operation.operationId === "exportTracker")
      command.option("--output <path>", "Write canonical data to a new JSON file.");
    command.action(async function (this: Command, ...args: unknown[]) {
      const options = this.optsWithGlobals<Options>();
      if (operation.status !== "implemented")
        throw new CliError(
          "This capability is not implemented by the current server contract. Use project history until status/activity support is enabled.",
          ExitCode.Validation,
          { code: "capability_unsupported" },
        );
      if (options.etag && !/^"[^"\r\n]+"$/u.test(options.etag))
        throw new CliError("--etag must be an exact strong quoted ETag.", ExitCode.Usage);
      if (
        operation.idempotencyKey &&
        (!options.idempotencyKey ||
          !/^[\x21-\x7e][\x20-\x7e]{0,199}$/u.test(options.idempotencyKey))
      )
        throw new CliError(
          "--idempotency-key must contain 1 to 200 printable ASCII characters.",
          ExitCode.Usage,
        );
      const routeParams: Record<string, string> = {};
      let position = 0;
      for (const key of params)
        routeParams[key] =
          key === "projectId"
            ? options.project!
            : key === "trackerId"
              ? options.tracker!
              : String(args[position++]);
      let body = payload ? await readProjectPayload(runtime, options) : {};
      if (body.kind === "commentary_tracker" && fields.includes("contract"))
        body = { contract: body };
      if (body.kind === "commentary_tracker_export" && fields.includes("bundle"))
        body = { bundle: body };
      for (const key of ["mode", "expectedSchemaRevisionId", "baseCommitSha"]) {
        if (typeof options[key] !== "string") continue;
        if (!fields.includes(key) || (body[key] !== undefined && body[key] !== options[key]))
          throw new CliError(`Payload ${key} differs from the explicit option.`, ExitCode.Usage);
        body[key] = options[key];
      }
      for (const key of params)
        if (Object.hasOwn(body, key))
          throw new CliError(
            `Pass ${key} only through the explicit command identifier.`,
            ExitCode.Usage,
          );
      const query: Record<string, string | number> = {};
      if (operation.method === "GET")
        for (const key of fields) {
          const value = key === "workspaceId" ? options.workspace : options[key];
          if (value !== undefined)
            query[key] =
              key === "limit"
                ? pageLimit(String(value))
                : key === "waitMs"
                  ? waitLimit(String(value))
                  : String(value);
        }
      else if (fields.includes("workspaceId")) {
        if (options.workspace && body.workspaceId && options.workspace !== body.workspaceId)
          throw new CliError("Payload workspaceId differs from --workspace.", ExitCode.Safety);
        if (options.workspace) body.workspaceId = options.workspace;
      }
      validateProjectInput(operation.inputSchema, { ...body, ...query, ...routeParams });
      const client = await makeClient(runtime, options);
      try {
        const response = await client.projectOperation(operation.operationId, {
          params: routeParams,
          query,
          ...(operation.method !== "GET" ? { body } : {}),
          etag: options.etag,
          idempotencyKey: options.idempotencyKey,
          correlationId: options.correlationId,
        });
        if (options.output) {
          await writeFile(
            path.resolve(runtime.cwd, options.output),
            `${JSON.stringify(response.body.data, null, 2)}\n`,
            { flag: "wx", mode: 0o600 },
          );
        }
        if (options.json) writeAgentResponse(runtime, options, response);
        else if (!options.quiet) {
          const data = response.body.data as Record<string, unknown> | undefined;
          const items = Array.isArray(data?.items) ? data.items : data ? [data] : [];
          for (const item of items) {
            const row = item as Record<string, unknown>;
            const values = row.values as Record<string, unknown> | undefined;
            writeText(
              runtime.stdout,
              [
                row.id,
                row.name ?? values?.title ?? row.state ?? row.lifecycle,
                row.version ? `v${String(row.version)}` : "",
                row.canonicalUrl ?? row.url,
              ]
                .filter(Boolean)
                .join("  ") || JSON.stringify(row),
            );
          }
          if (data?.nextCursor)
            writeText(runtime.stdout, `Next cursor: ${String(data.nextCursor)}`);
          if (response.etag) writeText(runtime.stdout, `ETag: ${response.etag}`);
          if (response.correlationId)
            writeText(runtime.stdout, `Correlation: ${response.correlationId}`);
        }
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        if (
          operation.method !== "GET" &&
          ["precondition_failed", "version_conflict"].includes(error.code ?? "")
        ) {
          const directory = path.join(runtime.cwd, ".commentary", "conflicts");
          await mkdir(directory, { recursive: true });
          const recoveryFile = path.join(directory, `${randomUUID()}.json`);
          await writeFile(
            recoveryFile,
            `${JSON.stringify({ operationId: operation.operationId, params: routeParams, body, etag: options.etag, idempotencyKey: options.idempotencyKey }, null, 2)}\n`,
            { flag: "wx", mode: 0o600 },
          );
          const readOperation = params.includes("recordId")
            ? "getTrackerRecord"
            : params.includes("viewId")
              ? "getTrackerView"
              : params.includes("trackerId")
                ? "getTracker"
                : "getProject";
          const latest = await client
            .projectOperation(readOperation, { params: routeParams })
            .catch(() => null);
          throw new CliError(
            "Conflict: submitted payload preserved. Review the current version and explicitly reconcile with a new retry key.",
            error.exitCode,
            {
              code: error.code!,
              ...(error.correlationId ? { correlationId: error.correlationId } : {}),
              reconciliation: { recoveryFile, currentEtag: latest?.etag ?? null },
            },
          );
        }
        if (
          error.code === "capability_unsupported" ||
          (error.code === undefined && error.message.includes("404"))
        )
          throw new CliError(
            "Server does not support this Project/Tracker capability. Upgrade the server or select a compatible endpoint.",
            ExitCode.Validation,
            { code: "capability_unsupported" },
          );
        throw error;
      }
    });
  }
}

import catalog from "./projects-contract.json" with { type: "json" };
function catalogInput(name: string) {
  return (catalog.schemas.$defs as Record<string, { properties?: Record<string, unknown> }>)[name]!;
}
function waitLimit(value: string) {
  if (!/^\d+$/u.test(value) || Number(value) > 10000)
    throw new CliError("--wait-ms must be 0 to 10000.", ExitCode.Usage);
  return Number(value);
}
