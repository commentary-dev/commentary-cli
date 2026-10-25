import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import catalog from "./projects-contract.json" with { type: "json" };
import { makeClient, type CommandRuntime, type GlobalOptions } from "./commands.js";
import { pageLimit, writeAgentResponse } from "./agent-command-helpers.js";
import { CliError, ExitCode } from "./errors.js";
import { PROJECT_OPERATIONS, readProjectPayload, validateProjectInput } from "./project-payload.js";
import { writeJson, writeText } from "./output.js";

type Options = GlobalOptions & {
  file?: string;
  stdin?: boolean;
  etag?: string;
  idempotencyKey?: string;
  correlationId?: string;
  output?: string;
  [key: string]: unknown;
};
type Field = { type?: string; minimum?: number; maximum?: number; enum?: unknown[] };
const definitions = catalog.schemas.$defs as unknown as Record<
  string,
  { properties: Record<string, Field> }
>;
const commands: Record<string, string[]> = {
  cancelPackageUpload: ["upload", "cancel"],
  downloadPackageFile: ["files", "download"],
  retryPackageIndexing: ["indexing", "retry"],
  mutatePackageReviewComment: ["comments", "mutate"],
  listPackageRenderers: ["renderers", "list"],
  managePackageRendererPublication: ["renderers", "manage"],
  comparePackageRevisions: ["impact"],
};
const MAX_PACKAGE_FILE_BYTES = 25 * 1024 * 1024;

function flagName(key: string) {
  return key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function queryValue(name: string, raw: string, field: Field): string | number | boolean {
  if (name === "limit") return pageLimit(raw, field.maximum);
  if (field.type === "integer") {
    const value = Number(raw);
    if (
      !/^\d+$/u.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < (field.minimum ?? 0) ||
      value > (field.maximum ?? Number.MAX_SAFE_INTEGER)
    )
      throw new CliError(
        `--${flagName(name)} is outside the server integer bounds.`,
        ExitCode.Usage,
      );
    return value;
  }
  if (field.type === "boolean") {
    if (raw !== "true" && raw !== "false")
      throw new CliError(`--${flagName(name)} must be true or false.`, ExitCode.Usage);
    return raw === "true";
  }
  return raw;
}

function child(parent: Command, words: string[]) {
  let current = parent;
  for (const word of words.slice(0, -1))
    current = current.commands.find((command) => command.name() === word) ?? current.command(word);
  return current.command(words.at(-1)!);
}

async function runOperation(
  runtime: CommandRuntime,
  operation: (typeof PROJECT_OPERATIONS)[number],
  root: Command,
  args: unknown[],
) {
  const options = root.optsWithGlobals<Options>();
  const routeParams = Object.fromEntries(
    [...operation.path.matchAll(/\{(\w+)\}/gu)].map((match, index) => [
      match[1]!,
      String(args[index]),
    ]),
  );
  const schema = definitions[operation.inputSchema]!.properties;
  const fields = Object.keys(schema).filter((key) => !Object.hasOwn(routeParams, key));
  let body: Record<string, unknown> = {};
  const query: Record<string, string | number | boolean> = {};
  if (operation.method === "GET") {
    for (const key of fields) {
      const value = options[key];
      if (value !== undefined) query[key] = queryValue(key, String(value), schema[key]!);
    }
  } else if (fields.length > 0) {
    body = await readProjectPayload(runtime, options);
    for (const key of Object.keys(routeParams))
      if (Object.hasOwn(body, key))
        throw new CliError(`Pass ${key} only as the explicit identifier.`, ExitCode.Usage);
  }
  const input = { ...body, ...query, ...routeParams };
  validateProjectInput(operation.inputSchema, input);
  const client = await makeClient(runtime, options);

  if (operation.operationId === "downloadPackageFile") {
    if (!options.output)
      throw new CliError("Pass --output to choose a new destination file.", ExitCode.Usage);
    const result = await client.projectBinaryOperation(operation.operationId, {
      params: routeParams,
      query,
      correlationId: options.correlationId,
      signal: runtime.signal,
      maxBytes: MAX_PACKAGE_FILE_BYTES,
    });
    const destination = path.resolve(runtime.cwd, options.output);
    try {
      await writeFile(destination, result.bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new CliError("Output file already exists; choose a new path.", ExitCode.Safety);
      throw error;
    }
    const receipt = {
      ok: true,
      path: destination,
      bytes: result.bytes.byteLength,
      mime: result.mime,
      sha256: createHash("sha256").update(result.bytes).digest("hex"),
      etag: result.etag,
      correlationId: result.correlationId,
    };
    if (options.json) writeJson(runtime.stdout, receipt);
    else if (!options.quiet)
      writeText(runtime.stdout, `${receipt.path}  ${receipt.bytes} bytes  ${receipt.mime}`);
    return;
  }

  const response = await client.projectOperation(operation.operationId, {
    params: routeParams,
    query,
    ...(operation.method !== "GET" ? { body } : {}),
    correlationId: options.correlationId,
    idempotencyKey: options.idempotencyKey,
    signal: runtime.signal,
  });
  writeAgentResponse(runtime, options, response);
}

export function addPackageApiCommands(root: Command, runtime: CommandRuntime) {
  for (const operation of PROJECT_OPERATIONS) {
    const words = commands[operation.operationId];
    if (!words || operation.status !== "implemented") continue;
    const command = child(root, words).description(
      `${operation.operationId}; scopes: ${operation.scopes.join(", ")}.`,
    );
    const params = [...operation.path.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!);
    for (const param of params) command.argument(`<${flagName(param)}>`);
    command.option("--correlation-id <id>", "Request correlation ID.");
    if (operation.idempotencyKey)
      command.requiredOption("--idempotency-key <key>", "Reuse only for an exact retry.");
    const schema = definitions[operation.inputSchema]!.properties;
    const fields = Object.keys(schema).filter((key) => !params.includes(key));
    if (operation.method !== "GET" && fields.length > 0)
      command
        .option("--file <path>", "JSON/core YAML request object.")
        .option("--stdin", "Read the request object from standard input.");
    if (operation.method === "GET")
      for (const key of fields)
        command.option(
          `--${flagName(key)} <value>`,
          `Server ${key} query${key === "path" ? "; exact relative file path" : ""}.`,
        );
    if (operation.operationId === "downloadPackageFile")
      command.requiredOption(
        "--output <path>",
        "Write bytes to a new file; existing files are never replaced.",
      );
    command.action(async function (this: Command, ...args: unknown[]) {
      await runOperation(runtime, operation, this, args);
    });
  }
}
