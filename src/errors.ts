export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string | undefined;
  readonly correlationId: string | undefined;
  readonly retryable: boolean | undefined;

  constructor(
    message: string,
    exitCode = 1,
    details: { code?: string; correlationId?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = details.code;
    this.correlationId = details.correlationId;
    this.retryable = details.retryable;
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
  StaleRevision: 7,
  Validation: 8,
  Server: 9,
  TerminalNegative: 10,
  Timeout: 124,
  Interrupted: 130,
} as const;

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
