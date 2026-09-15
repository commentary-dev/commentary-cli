import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CommandRuntime, GlobalOptions } from "./commands.js";
import { CliError, ExitCode } from "./errors.js";
import { writeJson, writeText } from "./output.js";
import type { InteractionResponse } from "./api-client.js";

export async function readAgentPayload(
  runtime: CommandRuntime,
  input: { file?: string; stdin?: boolean },
  maximum = 256 * 1024,
): Promise<Record<string, unknown>> {
  if (Boolean(input.file) === Boolean(input.stdin))
    throw new CliError("Pass exactly one of --file or --stdin.", ExitCode.Usage);
  let source: string;
  if (input.file) {
    const location = path.resolve(runtime.cwd, input.file);
    const info = await stat(location).catch(() => null);
    if (!info?.isFile()) throw new CliError("The payload file was not found.", ExitCode.Usage);
    if (info.size > maximum)
      throw new CliError(`Payload exceeds ${maximum} bytes.`, ExitCode.Validation);
    source = await readFile(location, "utf8");
  } else {
    if (!runtime.stdin) throw new CliError("Standard input is unavailable.", ExitCode.Usage);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of runtime.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > maximum)
        throw new CliError(`Payload exceeds ${maximum} bytes.`, ExitCode.Validation);
      chunks.push(buffer);
    }
    source = Buffer.concat(chunks).toString("utf8");
  }
  if (Buffer.byteLength(source) > maximum)
    throw new CliError(`Payload exceeds ${maximum} bytes.`, ExitCode.Validation);
  try {
    const payload: unknown = JSON.parse(source);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch {
    throw new CliError("Payload must be a JSON object.", ExitCode.Validation);
  }
}

export function pageLimit(value: string, maximum = 100) {
  const limit = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(limit) || limit < 1 || limit > maximum)
    throw new CliError(`--limit must be between 1 and ${maximum}.`, ExitCode.Usage);
  return limit;
}

export function writeAgentResponse(
  runtime: CommandRuntime,
  options: GlobalOptions,
  response: InteractionResponse<Record<string, unknown>>,
) {
  const value = {
    ...response.body,
    ok: true,
    etag: response.etag,
    correlationId: response.correlationId,
    idempotencyReplayed: response.idempotencyReplayed,
  };
  if (options.json) writeJson(runtime.stdout, value);
  else if (!options.quiet) writeText(runtime.stdout, JSON.stringify(value, null, 2));
}

/** Resolve both sides to reject project destinations, including symlinked parents. */
export async function secretDestination(cwd: string, value: string) {
  let projectRoot = await realpath(cwd);
  for (let candidate = projectRoot; ; candidate = path.dirname(candidate)) {
    if (await stat(path.join(candidate, ".git")).catch(() => null)) {
      projectRoot = candidate;
      break;
    }
    if (path.dirname(candidate) === candidate) break;
  }
  const requested = path.resolve(cwd, value);
  const parent = await realpath(path.dirname(requested)).catch(() => null);
  if (!parent)
    throw new CliError("The secret destination directory must already exist.", ExitCode.Usage);
  const destination = path.join(parent, path.basename(requested));
  const relative = path.relative(projectRoot, destination);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
    throw new CliError("--secret-file must be outside the project.", ExitCode.Safety);
  return destination;
}
