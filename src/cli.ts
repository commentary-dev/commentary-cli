import { Command, Option } from "commander";
import {
  commentsCommand,
  loginCommand,
  logoutCommand,
  openCommand,
  pullCommand,
  replyCommand,
  resolveCommand,
  reviewCommand,
  revisionsCommand,
  sessionsCommand,
  statusCommand,
  syncCommand,
  watchCommand,
  waitCommentCommand,
  whoamiCommand,
  type CommandRuntime,
  type GlobalOptions,
} from "./commands.js";
import { PACKAGE_NAME } from "./constants.js";
import { CliError, ExitCode, toErrorMessage } from "./errors.js";

type RunOptions = Partial<CommandRuntime>;

function collectOption(value: string, previous: string[] = []) {
  previous.push(value);
  return previous;
}

function runtimeFromOptions(options?: RunOptions): CommandRuntime {
  return {
    cwd: options?.cwd ?? process.cwd(),
    stdout: options?.stdout ?? process.stdout,
    stderr: options?.stderr ?? process.stderr,
    fetchImpl: options?.fetchImpl,
    isTty: options?.isTty ?? process.stdout.isTTY,
  };
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function wrap(runtime: CommandRuntime, action: (options: GlobalOptions) => Promise<void>) {
  return async function wrapped(this: Command) {
    await action(globalOptions(this));
  };
}

function commandOptionsWithNoOpen(command: Command) {
  const options = command.opts();
  return {
    ...globalOptions(command),
    ...options,
    noOpen: (options as { open?: boolean }).open === false,
  };
}

export function buildProgram(runtime: CommandRuntime) {
  const program = new Command();
  program
    .name("commentary")
    .description("Create and manage Commentary draft review sessions from local files.")
    .version("0.1.0")
    .showHelpAfterError()
    .exitOverride();

  program
    .option("--base-url <url>", "Commentary base URL")
    .option("--token <token>", "Commentary API token")
    .option("--json", "Print JSON output")
    .option("--verbose", "Print verbose diagnostics")
    .option("--quiet", "Suppress non-essential output")
    .option("--no-color", "Disable color output")
    .option("--session-file <path>", "Path to project session metadata");

  program
    .command("login")
    .description("Authenticate with Commentary.")
    .option("--token <token>", "Store an existing API token")
    .option("--no-open", "Do not open the browser during device login")
    .action(async function (this: Command) {
      await loginCommand(runtime, commandOptionsWithNoOpen(this));
    });

  program
    .command("logout")
    .description("Remove the stored Commentary token for the selected base URL.")
    .action(wrap(runtime, (options) => logoutCommand(runtime, options)));

  program
    .command("whoami")
    .description("Validate the configured Commentary token.")
    .action(wrap(runtime, (options) => whoamiCommand(runtime, options)));

  program
    .command("review")
    .description("Create a draft review from files or folders.")
    .argument("<paths...>")
    .option("--title <title>", "Review title")
    .option("--description <description>", "Review description")
    .addOption(
      new Option("--content-type <type>", "Content type")
        .choices(["auto", "markdown", "html", "plain_text"])
        .default("auto"),
    )
    .option("--watch", "Watch files and sync after creating the review")
    .option("--no-open", "Do not open the browser")
    .option("--root <path>", "Root for relative review paths")
    .option("--include <glob>", "Include glob for directory review", collectOption)
    .option("--exclude <glob>", "Exclude glob for directory review", collectOption)
    .action(async function (this: Command, paths: string[]) {
      await reviewCommand(runtime, paths, commandOptionsWithNoOpen(this));
    });

  const sync = program
    .command("sync")
    .description("Upload current tracked files as a new revision.")
    .option("--message <summary>", "Revision summary")
    .option("--all", "Upload even when hashes have not changed")
    .option("--dry-run", "Print pending changes without uploading")
    .action(async function (this: Command) {
      await syncCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });
  program
    .command("revision")
    .description("Alias for sync.")
    .option("--message <summary>", "Revision summary")
    .option("--all", "Upload even when hashes have not changed")
    .option("--dry-run", "Print pending changes without uploading")
    .action(async function (this: Command) {
      await syncCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("watch")
    .description("Watch tracked files and sync revisions.")
    .option("--debounce <ms>", "Debounce in milliseconds", "1500")
    .option("--message <summary>", "Revision summary")
    .action(async function (this: Command) {
      await watchCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("comments")
    .description("List draft review comments.")
    .addOption(
      new Option("--format <format>", "Output format")
        .choices(["text", "markdown", "json"])
        .default("text"),
    )
    .option("--open", "Show open comments")
    .option("--resolved", "Show resolved comments")
    .option("--all", "Show all comments")
    .option("--file <path>", "Filter by file path")
    .option("--session <id>", "Explicit session id")
    .action(async function (this: Command) {
      await commentsCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("wait-comment")
    .description("Wait for the next draft review comment event.")
    .option("--session <id>", "Explicit session id")
    .option("--file <path>", "Filter by file path")
    .option("--include-replies", "Also return reply.created events")
    .option("--cursor <id>", "Resume after a specific live event cursor")
    .addOption(
      new Option("--from <position>", "Where to start when no cursor is provided")
        .choices(["beginning", "latest"])
        .default("latest"),
    )
    .option("--timeout <duration>", "Maximum wait time, e.g. 30m, 10s, or 0", "30m")
    .addOption(
      new Option("--format <format>", "Output format")
        .choices(["text", "markdown", "json"])
        .default("markdown"),
    )
    .action(async function (this: Command) {
      await waitCommentCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("reply")
    .description("Reply to a comment thread.")
    .argument("<comment-id>")
    .argument("<message>")
    .option("--session <id>", "Explicit session id")
    .action(async function (this: Command, threadId: string, message: string) {
      await replyCommand(runtime, threadId, message, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("resolve")
    .description("Resolve a comment thread.")
    .argument("<comment-id>")
    .option("--session <id>", "Explicit session id")
    .option("--message <message>", "Reply before resolving")
    .action(async function (this: Command, threadId: string) {
      await resolveCommand(runtime, threadId, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("pull")
    .description("Download latest reviewed files safely.")
    .option("--dry-run", "Show what would change")
    .option("--yes", "Overwrite changed files")
    .option("--backup", "Create .bak files before overwrite")
    .option("--output <dir>", "Write files to a separate directory")
    .action(async function (this: Command) {
      await pullCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("open")
    .description("Open the linked review in a browser, or print the URL in headless output.")
    .option("--session <id>", "Explicit session id")
    .action(async function (this: Command) {
      await openCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("status")
    .description("Show current linked review status.")
    .action(wrap(runtime, (options) => statusCommand(runtime, options)));

  program
    .command("sessions")
    .description("List draft review sessions for the authenticated account.")
    .action(wrap(runtime, (options) => sessionsCommand(runtime, options)));

  program
    .command("revisions")
    .description("List revisions for the linked or specified draft review.")
    .option("--session <id>", "Explicit session id")
    .action(async function (this: Command) {
      await revisionsCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  sync.alias("upload");
  program.addHelpText(
    "after",
    `\nExamples:\n  npx ${PACKAGE_NAME} review ./docs/spec.md\n  commentary comments --format markdown --open\n  commentary wait-comment --json\n`,
  );
  return program;
}

export async function runCli(argv = process.argv.slice(2), options?: RunOptions) {
  const runtime = runtimeFromOptions(options);
  const program = buildProgram(runtime);
  try {
    await program.parseAsync(argv, { from: "user" });
    return ExitCode.Ok;
  } catch (error) {
    const commanderError = error as { code?: string; exitCode?: number; message?: string };
    if (
      commanderError.code === "commander.helpDisplayed" ||
      commanderError.code === "commander.version"
    ) {
      return ExitCode.Ok;
    }
    if (commanderError.code?.startsWith("commander.")) {
      runtime.stderr.write(`${commanderError.message ?? "Invalid command."}\n`);
      return commanderError.exitCode ?? ExitCode.Usage;
    }
    if (error instanceof CliError) {
      runtime.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    runtime.stderr.write(`${toErrorMessage(error)}\n`);
    return ExitCode.General;
  }
}
