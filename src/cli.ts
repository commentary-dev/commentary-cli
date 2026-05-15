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

function helpText(details: string, examples: string[]) {
  return [
    "",
    "Details:",
    `  ${details}`,
    "",
    "Examples:",
    ...examples.map((example) => `  ${example}`),
  ].join("\n");
}

export function buildProgram(runtime: CommandRuntime) {
  const program = new Command();
  program.configureOutput({
    writeOut: (chunk) => runtime.stdout.write(chunk),
    writeErr: (chunk) => runtime.stderr.write(chunk),
    outputError: (chunk, write) => write(chunk),
  });
  program
    .name("commentary")
    .description(
      "Create and manage Commentary draft review sessions from local Markdown, MDX, HTML, and text files.",
    )
    .version("0.1.0")
    .showHelpAfterError()
    .exitOverride();

  program
    .option(
      "--base-url <url>",
      "Commentary base URL. Defaults to COMMENTARY_BASE_URL or https://commentary.dev.",
    )
    .option(
      "--token <token>",
      "Commentary API token. Defaults to COMMENTARY_TOKEN or the stored login token.",
    )
    .option("--json", "Print machine-readable JSON output for agent automation.")
    .option("--verbose", "Print verbose diagnostics, including live-event reconnect notices.")
    .option("--quiet", "Suppress non-essential human-readable output.")
    .option("--no-color", "Disable color output")
    .option(
      "--session-file <path>",
      "Path to project session metadata. Defaults to .commentary/session.json.",
    );

  program
    .command("login")
    .description("Authenticate with Commentary.")
    .option(
      "--token <token>",
      "Store an existing API token instead of starting browser/device login.",
    )
    .option("--no-open", "Print the device login URL instead of opening a browser.")
    .addHelpText(
      "after",
      helpText("Stores the token outside project metadata. Session files never contain secrets.", [
        "commentary login",
        "commentary login --token <commentary-api-token>",
        "commentary --base-url https://commentary.example.com login",
      ]),
    )
    .action(async function (this: Command) {
      await loginCommand(runtime, commandOptionsWithNoOpen(this));
    });

  program
    .command("logout")
    .description("Remove the stored Commentary token for the selected base URL.")
    .addHelpText(
      "after",
      helpText(
        "Removes only local CLI authentication state for the selected Commentary base URL.",
        ["commentary logout", "commentary --base-url https://commentary.example.com logout"],
      ),
    )
    .action(wrap(runtime, (options) => logoutCommand(runtime, options)));

  program
    .command("whoami")
    .description("Validate the configured Commentary token.")
    .addHelpText(
      "after",
      helpText("Checks whether the active token can reach the draft-review API.", [
        "commentary whoami",
        "COMMENTARY_TOKEN=<token> commentary whoami --json",
      ]),
    )
    .action(wrap(runtime, (options) => whoamiCommand(runtime, options)));

  program
    .command("review")
    .description("Create a draft review from files or folders.")
    .argument("<paths...>")
    .option("--title <title>", "Review title shown in Commentary.")
    .option("--description <description>", "Optional review description shown in Commentary.")
    .addOption(
      new Option("--content-type <type>", "Content type")
        .choices(["auto", "markdown", "html", "plain_text"])
        .default("auto"),
    )
    .option("--watch", "Keep running and upload a new revision whenever tracked files change.")
    .option("--no-open", "Do not open the browser after creating the review.")
    .option(
      "--root <path>",
      "Root used for relative review paths. Defaults to the current directory.",
    )
    .option(
      "--include <glob>",
      "Include glob for directory review. May be repeated.",
      collectOption,
    )
    .option(
      "--exclude <glob>",
      "Exclude glob for directory review. May be repeated.",
      collectOption,
    )
    .addHelpText(
      "after",
      helpText(
        "Creates a hosted draft review and writes .commentary/session.json for later commands.",
        [
          'commentary review ./docs/spec.md --title "Product spec"',
          'commentary review ./docs --include "**/*.md" --exclude "drafts/**"',
          "commentary review ./docs/spec.md --watch --no-open",
          "commentary review ./docs/spec.md --json",
        ],
      ),
    )
    .action(async function (this: Command, paths: string[]) {
      await reviewCommand(runtime, paths, commandOptionsWithNoOpen(this));
    });

  const sync = program
    .command("sync")
    .description("Upload current tracked files as a new revision.")
    .option("--message <summary>", "Revision summary shown in Commentary.")
    .option("--all", "Upload even when tracked file hashes have not changed.")
    .option("--dry-run", "Print pending changed paths without uploading a revision.")
    .addHelpText(
      "after",
      helpText("Reads the linked session, compares tracked files, and uploads changed content.", [
        'commentary sync --message "Address review comments"',
        "commentary sync --dry-run --json",
        'commentary sync --all --message "Refresh rendered output"',
      ]),
    )
    .action(async function (this: Command) {
      await syncCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });
  program
    .command("revision")
    .description("Alias for sync.")
    .option("--message <summary>", "Revision summary shown in Commentary.")
    .option("--all", "Upload even when tracked file hashes have not changed.")
    .option("--dry-run", "Print pending changed paths without uploading a revision.")
    .addHelpText(
      "after",
      helpText("Alias for commentary sync.", [
        'commentary revision --message "Address review comments"',
        "commentary revision --dry-run",
      ]),
    )
    .action(async function (this: Command) {
      await syncCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("watch")
    .description("Watch tracked files and sync revisions.")
    .option("--debounce <ms>", "Milliseconds to wait after a file event before syncing.", "1500")
    .option("--message <summary>", "Revision summary used for watch-triggered uploads.")
    .addHelpText(
      "after",
      helpText(
        "Runs until interrupted. It watches files already listed in .commentary/session.json.",
        ["commentary watch", 'commentary watch --debounce 3000 --message "Watch sync"'],
      ),
    )
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
    .option("--open", "Show open threads. This is the default unless --resolved or --all is used.")
    .option("--resolved", "Show resolved threads.")
    .option("--all", "Show open and resolved threads.")
    .option("--file <path>", "Filter by review file path, e.g. docs/spec.md.")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .addHelpText(
      "after",
      helpText(
        "Prints thread ids, file anchors, comment bodies, and replies for the selected session.",
        [
          "commentary comments --format markdown --open",
          "commentary comments --all --json",
          "commentary comments --file docs/spec.md --format text",
          "commentary comments --session draft_123 --json",
        ],
      ),
    )
    .action(async function (this: Command) {
      await commentsCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("wait-comment")
    .description("Wait for the next draft review comment event.")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .option("--file <path>", "Filter by review file path, e.g. docs/spec.md.")
    .option("--include-replies", "Return reply.created events. This is enabled by default.")
    .option(
      "--no-include-replies",
      "Ignore reply.created events and wait only for new top-level comments.",
    )
    .option(
      "--cursor <id>",
      "Resume after a specific live-event cursor returned by a previous wait.",
    )
    .addOption(
      new Option("--from <position>", "Where to start when no cursor is provided")
        .choices(["beginning", "latest"])
        .default("latest"),
    )
    .option("--timeout <duration>", "Maximum wait time, e.g. 30m, 10s, or 0 for no timeout.", "30m")
    .addOption(
      new Option("--format <format>", "Output format")
        .choices(["text", "markdown", "json"])
        .default("markdown"),
    )
    .addHelpText(
      "after",
      helpText(
        "Streams draft-review live events, auto-reconnects on stream drops, and exits after the first matching comment or reply.",
        [
          "commentary wait-comment --json",
          "commentary wait-comment --file docs/spec.md --timeout 15m",
          "commentary wait-comment --cursor event_123 --json",
          "commentary wait-comment --from beginning --no-include-replies",
          "commentary wait-comment --timeout 0 --format markdown",
        ],
      ),
    )
    .action(async function (this: Command) {
      await waitCommentCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("reply")
    .description("Reply to a comment thread.")
    .argument("<thread-id>")
    .argument("<message>")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .option(
      "--alias <name>",
      "Agent alias for reply attribution. Overrides COMMENTARY_AGENT_ALIAS.",
    )
    .addHelpText(
      "after",
      helpText(
        "Adds a reply to the thread id printed by comments or wait-comment. Replies reopen resolved threads.",
        [
          'commentary reply thread_123 "Updated this in revision 3."',
          'commentary reply thread_123 "Fixed." --alias "Docs agent"',
          'COMMENTARY_AGENT_ALIAS="Docs agent" commentary reply thread_123 "Fixed." --json',
        ],
      ),
    )
    .action(async function (this: Command, threadId: string, message: string) {
      await replyCommand(runtime, threadId, message, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("resolve")
    .description("Resolve a comment thread.")
    .argument("<thread-id>")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .option("--message <message>", "Add a closing reply before resolving the thread.")
    .option(
      "--alias <name>",
      "Agent alias for the closing reply. Overrides COMMENTARY_AGENT_ALIAS.",
    )
    .addHelpText(
      "after",
      helpText(
        "Marks a thread resolved. Use --message when the final response should be visible in the thread.",
        [
          "commentary resolve thread_123",
          'commentary resolve thread_123 --message "Addressed in revision 3."',
          'commentary resolve thread_123 --message "Fixed." --alias "Docs agent" --json',
        ],
      ),
    )
    .action(async function (this: Command, threadId: string) {
      await resolveCommand(runtime, threadId, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("pull")
    .description("Download latest reviewed files safely.")
    .option("--dry-run", "Show which files would change without writing to disk.")
    .option("--yes", "Allow overwriting changed local files.")
    .option("--backup", "Create .bak files before overwriting existing files.")
    .option(
      "--output <dir>",
      "Write files to a separate directory instead of overwriting tracked files.",
    )
    .addHelpText(
      "after",
      helpText("Downloads the latest Commentary file content for the linked draft review.", [
        "commentary pull --dry-run",
        "commentary pull --output reviewed",
        "commentary pull --backup --yes",
      ]),
    )
    .action(async function (this: Command) {
      await pullCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("open")
    .description("Open the linked review in a browser, or print the URL in headless output.")
    .option("--session <id>", "Open an explicit draft review session id instead of local metadata.")
    .addHelpText(
      "after",
      helpText("In CI or non-TTY output this prints the URL instead of launching a browser.", [
        "commentary open",
        "commentary open --session draft_123",
      ]),
    )
    .action(async function (this: Command) {
      await openCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("status")
    .description("Show current linked review status.")
    .addHelpText(
      "after",
      helpText(
        "Summarizes local metadata, changed tracked files, and open/resolved thread counts.",
        ["commentary status", "commentary status --json"],
      ),
    )
    .action(wrap(runtime, (options) => statusCommand(runtime, options)));

  program
    .command("sessions")
    .description("List draft review sessions for the authenticated account.")
    .addHelpText(
      "after",
      helpText("Lists draft reviews visible to the configured token.", [
        "commentary sessions",
        "commentary sessions --json",
      ]),
    )
    .action(wrap(runtime, (options) => sessionsCommand(runtime, options)));

  program
    .command("revisions")
    .description("List revisions for the linked or specified draft review.")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .addHelpText(
      "after",
      helpText("Shows uploaded revisions for the selected draft review.", [
        "commentary revisions",
        "commentary revisions --session draft_123 --json",
      ]),
    )
    .action(async function (this: Command) {
      await revisionsCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  sync.alias("upload");
  program.addHelpText(
    "after",
    `\nAgent loop:\n  1. commentary review ./docs/spec.md --title "Spec"\n  2. commentary wait-comment --json\n  3. edit files, then commentary sync --message "Address comments"\n  4. commentary reply <thread-id> "Fixed." --alias "Docs agent"\n\nExamples:\n  npx ${PACKAGE_NAME} review ./docs/spec.md\n  commentary comments --format markdown --open\n  commentary wait-comment --json\n  commentary resolve <thread-id> --message "Addressed."\n`,
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
