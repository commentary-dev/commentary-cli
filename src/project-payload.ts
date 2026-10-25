import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import catalog from "./projects-contract.json" with { type: "json" };
import type { CommandRuntime } from "./commands.js";
import { CliError, ExitCode } from "./errors.js";

export const PROJECT_OPERATIONS = catalog.operations;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(catalog.schemas);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

export function validateProjectInput(schema: string, value: unknown) {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile({ $ref: `${catalog.schemas.$id}#/$defs/${schema}` });
    validators.set(schema, validate);
  }
  if (!validate(value)) {
    const diagnostics = (validate.errors ?? []).slice(0, 100).map((error) => ({
      path: `$${error.instancePath}${typeof (error.params.missingProperty ?? error.params.additionalProperty) === "string" ? `/${String(error.params.missingProperty ?? error.params.additionalProperty)}` : ""}`,
      code: "PROJECT_AGENT_VALIDATION",
      message: `Invalid ${error.keyword}.`,
    }));
    throw new CliError("Payload does not match the server contract v1.", ExitCode.Validation, {
      code: "validation_failed",
      diagnostics,
    });
  }
}

function bounded(value: unknown, depth = 0, budget = { nodes: 0 }) {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new CliError("Payload numbers must be finite JSON values.", ExitCode.Validation);
  if (++budget.nodes > 1000000 || depth > 32)
    throw new CliError("Payload nesting or node limit exceeded.", ExitCode.Validation);
  if (
    typeof value === "string" &&
    /(?:comm_pat_|github_pat_|gh[pousr]_)[A-Za-z0-9_-]{12,}/u.test(value)
  )
    throw new CliError("Payload must not contain credentials.", ExitCode.Safety);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new CliError("Unsafe payload key.", ExitCode.Validation);
    bounded(child, depth + 1, budget);
  }
}

export async function readProjectPayload(
  runtime: CommandRuntime,
  options: { file?: string; stdin?: boolean },
) {
  if (Boolean(options.file) === Boolean(options.stdin))
    throw new CliError("Pass exactly one of --file or --stdin.", ExitCode.Usage);
  const maximum = 16 * 1024 * 1024;
  let source: string;
  if (options.file) {
    const location = path.resolve(runtime.cwd, options.file);
    const info = await stat(location).catch(() => null);
    if (!info?.isFile()) throw new CliError("The payload file was not found.", ExitCode.Usage);
    if (info.size > maximum) throw new CliError("Payload exceeds 16 MiB.", ExitCode.Validation);
    source = await readFile(location, "utf8");
  } else {
    if (!runtime.stdin) throw new CliError("Standard input is unavailable.", ExitCode.Usage);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of runtime.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > maximum) throw new CliError("Payload exceeds 16 MiB.", ExitCode.Validation);
      chunks.push(buffer);
    }
    source = Buffer.concat(chunks).toString("utf8");
  }
  if (Buffer.byteLength(source) > maximum)
    throw new CliError("Payload exceeds 16 MiB.", ExitCode.Validation);
  let value: unknown;
  try {
    const document = parseDocument(source, { schema: "core", uniqueKeys: true, merge: false });
    if (document.errors.length || document.warnings.length) throw new Error();
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new CliError(
      "Payload must be JSON or core YAML without tags, aliases or duplicate keys.",
      ExitCode.Validation,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError("Payload must be an object.", ExitCode.Validation);
  bounded(value);
  return value as Record<string, unknown>;
}
