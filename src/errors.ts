export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export const ExitCode = {
  Ok: 0,
  General: 1,
  Usage: 2,
  Auth: 3,
  Network: 4,
  Api: 5,
  Safety: 6,
  Timeout: 124,
} as const;

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
