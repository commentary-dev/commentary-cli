import { Command, Option } from "commander";
import {
  brainstormDecideCommand,
  brainstormEnableCommand,
  brainstormNextCommand,
  brainstormRuleCommand,
  brainstormSignalCommand,
  brainstormStatusCommand,
  commentsCommand,
  loginCommand,
  nextCommentCommand,
  logoutCommand,
  openCommand,
  pullCommand,
  rebaseCommand,
  replyCommand,
  resolveCommand,
  restoreCommand,
  reviewCommand,
  revisionsCommand,
  sessionsCommand,
  shareCommand,
  statusCommand,
  syncCommand,
  trackCommand,
  watchCommand,
  waitCommentCommand,
  whoamiCommand,
  type CommandRuntime,
  type GlobalOptions,
} from "./commands.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./constants.js";
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

function resolveThreadIdArgument(
  positionalThreadId: string | undefined,
  options: { thread?: string | undefined },
) {
  const optionThreadId = options.thread;
  if (positionalThreadId && optionThreadId) {
    throw new CliError(
      "Pass the thread id either as <thread-id> or --thread, not both.",
      ExitCode.Usage,
    );
  }
  const threadId = optionThreadId ?? positionalThreadId;
  if (!threadId) {
    throw new CliError("A thread id is required.", ExitCode.Usage);
  }
  if (!optionThreadId && threadId.startsWith("--")) {
    throw new CliError(
      'Thread ids beginning with "--" must be passed with --thread <id>.',
      ExitCode.Usage,
    );
  }
  return threadId;
}

function resolveReplyArguments(args: string[], options: { thread?: string | undefined }) {
  if (options.thread) {
    const message = args[0];
    if (message === undefined) {
      throw new CliError("A reply message is required.", ExitCode.Usage);
    }
    if (args.length > 1) {
      throw new CliError(
        "Pass the thread id either as <thread-id> or --thread, not both.",
        ExitCode.Usage,
      );
    }
    return {
      threadId: resolveThreadIdArgument(undefined, options),
      message,
    };
  }

  if (args.length === 0) {
    throw new CliError("A thread id is required.", ExitCode.Usage);
  }
  if (args.length === 1) {
    throw new CliError("A reply message is required.", ExitCode.Usage);
  }
  if (args.length > 2) {
    throw new CliError("Too many arguments for reply.", ExitCode.Usage);
  }

  const threadId = args[0];
  const message = args[1];
  if (threadId === undefined || message === undefined) {
    throw new CliError("A reply message is required.", ExitCode.Usage);
  }

  return {
    threadId: resolveThreadIdArgument(threadId, options),
    message,
  };
}

function addGitBaseOptions(command: Command) {
  return command
    .option("--git-base <mode>", "Use a GitHub base. Supported value: auto.")
    .option("--git-base-repo <owner/repo>", "GitHub owner/repo for explicit base metadata.")
    .option("--git-base-sha <sha>", "GitHub commit sha for explicit base metadata.")
    .option("--git-base-ref <ref>", "GitHub branch or ref label for base metadata.")
    .option(
      "--git-base-path <path>",
      "GitHub file path for base metadata. Defaults to the reviewed file path.",
    )
    .option("--git-remote <name>", "Git remote used by --git-base auto.", "origin");
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
    .version(PACKAGE_VERSION)
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
    .command("restore")
    .description("Restore local session metadata for an existing draft review.")
    .argument("<session-id>")
    .option("--yes", "Replace existing local session metadata.")
    .option("--dry-run", "Show what would be restored without writing metadata or syncing.")
    .option("--no-sync", "Restore metadata without uploading changed local files.")
    .addHelpText(
      "after",
      helpText(
        "Recreates .commentary/session.json from review metadata, then syncs changed local files from the current directory.",
        [
          "commentary restore draft_123",
          "commentary restore draft_123 --dry-run --json",
          "commentary restore draft_123 --yes",
          "commentary restore draft_123 --no-sync",
        ],
      ),
    )
    .action(async function (this: Command, sessionId: string) {
      await restoreCommand(runtime, sessionId, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("review")
    .description("Create a draft review from files or folders.")
    .argument("<paths...>")
    .option("--title <title>", "Review title shown in Commentary.")
    .option("--description <description>", "Optional review description shown in Commentary.")
    .addOption(
      new Option("--mode <mode>", "Review mode")
        .choices(["draft", "brainstorming"])
        .default("draft"),
    )
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
    .option("--git-base <mode>", "Use a GitHub base. Supported value: auto.")
    .option("--git-base-repo <owner/repo>", "GitHub owner/repo for explicit base metadata.")
    .option("--git-base-sha <sha>", "GitHub commit sha for explicit base metadata.")
    .option("--git-base-ref <ref>", "GitHub branch or ref label for base metadata.")
    .option(
      "--git-base-path <path>",
      "GitHub file path for base metadata. Defaults to the reviewed file path.",
    )
    .option("--git-remote <name>", "Git remote used by --git-base auto.", "origin")
    .addHelpText(
      "after",
      helpText(
        "Creates a hosted draft review and writes .commentary/session.json for later commands.",
        [
          'commentary review ./docs/spec.md --title "Product spec" --git-base auto',
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
    .option(
      "--addressed-thread <id>",
      "Brainstorming thread id addressed by this revision. May be repeated.",
      collectOption,
    )
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
    .option(
      "--addressed-thread <id>",
      "Brainstorming thread id addressed by this revision. May be repeated.",
      collectOption,
    )
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

  addGitBaseOptions(
    program.command("rebase").description("Update or clear the GitHub base for the linked review."),
  )
    .option("--clear-git-base", "Clear the linked GitHub base metadata.")
    .option("--dry-run", "Resolve and print the base metadata without updating Commentary.")
    .addHelpText(
      "after",
      helpText(
        "Updates only hosted draft-review base metadata. It does not create branches, commits, pull requests, or provider reviews.",
        [
          "commentary rebase --git-base auto",
          "commentary rebase --git-base-repo commentary-dev/commentary-docs --git-base-sha abc123",
          "commentary rebase --clear-git-base",
          "commentary rebase --git-base auto --dry-run --json",
        ],
      ),
    )
    .action(async function (this: Command) {
      await rebaseCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("track")
    .description("Add files to the linked draft review and upload a new revision.")
    .argument("<paths...>")
    .option("--message <summary>", "Revision summary shown in Commentary.")
    .addOption(
      new Option("--content-type <type>", "Content type")
        .choices(["auto", "markdown", "html", "plain_text"])
        .default("auto"),
    )
    .option(
      "--include <glob>",
      "Include glob for directory tracking. May be repeated.",
      collectOption,
    )
    .option(
      "--exclude <glob>",
      "Exclude glob for directory tracking. May be repeated.",
      collectOption,
    )
    .option("--dry-run", "Print files that would be tracked without uploading a revision.")
    .addHelpText(
      "after",
      helpText(
        "Merges new paths with existing tracked files, uploads a full revision, and updates .commentary/session.json.",
        [
          'commentary track docs/new-page.md --message "Add docs page"',
          'commentary track docs --include "**/*.md" --dry-run --json',
        ],
      ),
    )
    .action(async function (this: Command, paths: string[]) {
      await trackCommand(runtime, paths, { ...globalOptions(this), ...this.opts() });
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
    .addOption(
      new Option(
        "--consensus-state <state>",
        "Filter Brainstorming Review threads by consensus state",
      ).choices([
        "pending",
        "accepted_for_change",
        "blocked",
        "needs_owner_decision",
        "rejected",
        "out_of_scope",
        "applied",
        "resolved",
      ]),
    )
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .option("--watch", "Stream open and future comment events as JSON lines until stopped.")
    .option("--jsonl", "Use newline-delimited JSON output for watch mode.")
    .option("--stop-file <path>", "Stop-file path for --watch or --stop.")
    .option("--stop", "Request a running comments --watch process to stop.")
    .option(
      "--include-replies",
      "Return reply.created events in watch mode. This is enabled by default.",
    )
    .option(
      "--no-include-replies",
      "Ignore reply.created events in watch mode and stream only new top-level comments.",
    )
    .addHelpText(
      "after",
      helpText(
        "Prints thread ids, file anchors, comment bodies, and replies for the selected session.",
        [
          "commentary comments --format markdown --open",
          "commentary comments --all --json",
          "commentary comments --file docs/spec.md --format text",
          "commentary comments --session draft_123 --json",
          "commentary comments --watch --jsonl",
          "commentary comments --stop",
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
    .command("next-comment")
    .description("Return currently open comments, or wait for the next live comment event.")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .option("--file <path>", "Filter by review file path, e.g. docs/spec.md.")
    .option("--include-replies", "Return reply.created events. This is enabled by default.")
    .option(
      "--no-include-replies",
      "Ignore reply.created events and wait only for new top-level comments.",
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
        "Agent-safe loop primitive: starts the live stream, checks open threads, then waits only if none are open.",
        [
          "commentary next-comment --json",
          "commentary next-comment --timeout 15m --json",
          "commentary next-comment --file docs/spec.md --format markdown",
          "commentary next-comment --no-include-replies --json",
        ],
      ),
    )
    .action(async function (this: Command) {
      await nextCommentCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  const consensusStateChoices = [
    "pending",
    "accepted_for_change",
    "blocked",
    "needs_owner_decision",
    "rejected",
    "out_of_scope",
    "applied",
    "resolved",
  ];

  const brainstorm = program
    .command("brainstorm")
    .description("Manage Brainstorming Review feedback and consensus.");

  brainstorm
    .command("enable")
    .description("Convert the linked draft review to a Brainstorming Review.")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .addHelpText(
      "after",
      helpText("Updates only hosted review metadata; local session metadata is unchanged.", [
        "commentary brainstorm enable",
        "commentary brainstorm enable --session draft_123 --json",
      ]),
    )
    .action(async function (this: Command) {
      await brainstormEnableCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  brainstorm
    .command("status")
    .description("Show Brainstorming Review consensus status.")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .addHelpText(
      "after",
      helpText(
        "Summarizes consensus counts, actionable files, blocked files, and agent readiness.",
        ["commentary brainstorm status", "commentary brainstorm status --json"],
      ),
    )
    .action(async function (this: Command) {
      await brainstormStatusCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  brainstorm
    .command("next")
    .description("Return matching Brainstorming threads, or wait for a matching live event.")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .option("--file <path>", "Filter by review file path, e.g. docs/spec.md.")
    .addOption(
      new Option("--consensus-state <state>", "Consensus state to return")
        .choices(consensusStateChoices)
        .default("accepted_for_change"),
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
        "Agent-safe Brainstorming loop primitive for accepted or blocked consensus states.",
        [
          "commentary brainstorm next --json",
          "commentary brainstorm next --consensus-state blocked --timeout 60s",
        ],
      ),
    )
    .action(async function (this: Command) {
      await brainstormNextCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  brainstorm
    .command("signal")
    .usage("[options] <thread-id> <signal>")
    .description("Set or clear a Brainstorming feedback signal.")
    .argument("<thread-id>")
    .argument("<signal>")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .option("--clear", "Clear this signal instead of setting it.")
    .option(
      "--alias <name>",
      "Agent alias for signal attribution. Overrides COMMENTARY_AGENT_ALIAS.",
    )
    .option("--client-name <name>", "Client name for signal attribution.")
    .addHelpText(
      "after",
      helpText(
        "Signals are agree, object, blocker, needs_clarification, or addressed. addressed is owner-only.",
        [
          "commentary brainstorm signal thread_123 agree --alias docs-agent",
          "commentary brainstorm signal thread_123 blocker --clear",
        ],
      ),
    )
    .action(async function (this: Command, threadId: string, signal: string) {
      const choices = ["agree", "object", "blocker", "needs_clarification", "addressed"] as const;
      if (!(choices as readonly string[]).includes(signal)) {
        throw new CliError(
          "Signal must be agree, object, blocker, needs_clarification, or addressed.",
          ExitCode.Usage,
        );
      }
      await brainstormSignalCommand(runtime, threadId, signal as (typeof choices)[number], {
        ...globalOptions(this),
        ...this.opts(),
      });
    });

  brainstorm
    .command("decide")
    .usage("[options] <thread-id> <decision>")
    .description("Set or clear an owner consensus decision for a Brainstorming thread.")
    .argument("<thread-id>")
    .argument("<decision>")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .option("--reason <text>", "Optional owner decision reason.")
    .addHelpText(
      "after",
      helpText("Decisions are accepted_for_change, rejected, out_of_scope, or clear.", [
        "commentary brainstorm decide thread_123 accepted_for_change",
        'commentary brainstorm decide thread_123 rejected --reason "Not in scope"',
      ]),
    )
    .action(async function (this: Command, threadId: string, decision: string) {
      const choices = ["accepted_for_change", "rejected", "out_of_scope", "clear"] as const;
      if (!(choices as readonly string[]).includes(decision)) {
        throw new CliError(
          "Decision must be accepted_for_change, rejected, out_of_scope, or clear.",
          ExitCode.Usage,
        );
      }
      await brainstormDecideCommand(runtime, threadId, decision as (typeof choices)[number], {
        ...globalOptions(this),
        ...this.opts(),
      });
    });

  brainstorm
    .command("rule")
    .description("Get or update the Brainstorming consensus rule.")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .option("--enabled", "Enable consensus rules.")
    .option("--disabled", "Disable consensus rules.")
    .addOption(
      new Option("--consensus-mode <mode>", "Consensus mode").choices([
        "owner_decides",
        "no_open_blockers",
        "n_of_m",
        "required_reviewers",
      ]),
    )
    .option("--agreement-threshold <count>", "Agreement count required for n_of_m mode.")
    .option("--min-response-count <count>", "Minimum reviewer responses before acceptance.")
    .option("--required-reviewer <id>", "Required reviewer id. May be repeated.", collectOption)
    .addOption(
      new Option(
        "--required-reviewer-condition <condition>",
        "Required reviewer condition",
      ).choices([
        "all_required_agree",
        "no_required_objects",
        "owner_plus_one_required_agrees",
        "threshold_no_blockers",
      ]),
    )
    .addOption(
      new Option("--objection-policy <policy>", "How objections affect consensus").choices([
        "block",
        "owner_decision",
        "ignore",
      ]),
    )
    .option("--blockers-block", "Block consensus when blockers are present.")
    .option("--blockers-do-not-block", "Do not block consensus when blockers are present.")
    .option("--count-agent-signals", "Count agent signals in consensus.")
    .option("--ignore-agent-signals", "Ignore agent signals in consensus.")
    .addOption(
      new Option("--decision-poll-completion <policy>", "Decision poll completion policy").choices([
        "closed",
        "threshold",
      ]),
    )
    .addHelpText(
      "after",
      helpText(
        "With no rule flags, prints the current rule. With flags, patches only supplied fields.",
        [
          "commentary brainstorm rule",
          "commentary brainstorm rule --consensus-mode no_open_blockers --min-response-count 2",
        ],
      ),
    )
    .action(async function (this: Command) {
      const opts = this.opts<{
        enabled?: boolean;
        disabled?: boolean;
        blockersBlock?: boolean;
        blockersDoNotBlock?: boolean;
        countAgentSignals?: boolean;
        ignoreAgentSignals?: boolean;
      }>();
      await brainstormRuleCommand(runtime, {
        ...globalOptions(this),
        ...opts,
        ...(opts.disabled
          ? { enabled: false }
          : opts.enabled !== undefined
            ? { enabled: opts.enabled }
            : {}),
        ...(opts.blockersDoNotBlock
          ? { blockersBlock: false }
          : opts.blockersBlock !== undefined
            ? { blockersBlock: opts.blockersBlock }
            : {}),
        ...(opts.ignoreAgentSignals
          ? { countAgentSignals: false }
          : opts.countAgentSignals !== undefined
            ? { countAgentSignals: opts.countAgentSignals }
            : {}),
      });
    });

  program
    .command("share")
    .description("Share the linked draft review or manage existing access.")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .option("--list", "List existing share links and user access grants. This is the default.")
    .option("--anyone", "Create or return a share link for anyone with the URL.")
    .option("--user <recipient>", "Grant access to a specific user or email address.")
    .option("--revoke-link <id>", "Revoke an anyone share link by id.")
    .option("--remove-access <id>", "Remove a user access grant by id.")
    .addHelpText(
      "after",
      helpText(
        "Uses the draft-review sharing API. Share data is kept in Commentary, not local session metadata.",
        [
          "commentary share --anyone",
          "commentary share --user reviewer@example.com",
          "commentary share --list --json",
          "commentary share --revoke-link share_123",
          "commentary share --remove-access grant_123",
        ],
      ),
    )
    .action(async function (this: Command) {
      await shareCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("reply")
    .usage("[options] <thread-id> <message>")
    .description("Reply to a comment thread.")
    .argument("[args...]")
    .allowUnknownOption()
    .option("--thread <id>", "Thread id. Use this when the id starts with a dash.")
    .option("--session <id>", "Use an explicit draft review session id instead of local metadata.")
    .option(
      "--alias <name>",
      "Agent alias for reply attribution. Overrides COMMENTARY_AGENT_ALIAS.",
    )
    .addHelpText(
      "after",
      helpText(
        "Adds a reply to the thread id printed by comments, next-comment, or wait-comment. Replies reopen resolved threads.",
        [
          'commentary reply thread_123 "Updated this in revision 3."',
          'commentary reply --thread -thread_123 "Fixed."',
          'commentary reply thread_123 "Fixed." --alias "Docs agent"',
          'COMMENTARY_AGENT_ALIAS="Docs agent" commentary reply thread_123 "Fixed." --json',
        ],
      ),
    )
    .action(async function (this: Command, args: string[]) {
      const { threadId, message } = resolveReplyArguments(args, this.opts());
      await replyCommand(runtime, threadId, message, { ...globalOptions(this), ...this.opts() });
    });

  program
    .command("resolve")
    .usage("[options] <thread-id>")
    .description("Resolve a comment thread.")
    .argument("[thread-id]")
    .allowUnknownOption()
    .option("--thread <id>", "Thread id. Use this when the id starts with a dash.")
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
          'commentary resolve --thread -thread_123 --message "Fixed."',
          'commentary resolve thread_123 --message "Addressed in revision 3."',
          'commentary resolve thread_123 --message "Fixed." --alias "Docs agent" --json',
        ],
      ),
    )
    .action(async function (this: Command, threadId: string) {
      threadId = resolveThreadIdArgument(threadId, this.opts());
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
    .addOption(
      new Option("--mode <mode>", "Filter by review mode").choices(["draft", "brainstorming"]),
    )
    .addHelpText(
      "after",
      helpText("Lists draft reviews visible to the configured token.", [
        "commentary sessions",
        "commentary sessions --json",
      ]),
    )
    .action(async function (this: Command) {
      await sessionsCommand(runtime, { ...globalOptions(this), ...this.opts() });
    });

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
    `\nAgent loop:\n  1. commentary review ./docs/spec.md --title "Spec" --git-base auto\n  2. commentary next-comment --timeout 15m --json\n  3. edit files, then commentary sync --message "Address comments"\n  4. commentary reply <thread-id> "Fixed." --alias "Docs agent"\n\nBrainstorming loop:\n  1. commentary review ./docs/spec.md --mode brainstorming\n  2. commentary brainstorm next --timeout 15m --json\n  3. edit files, then commentary sync --addressed-thread <thread-id>\n\nExamples:\n  npx ${PACKAGE_NAME} review ./docs/spec.md\n  commentary comments --format markdown --open\n  commentary next-comment --json\n  commentary brainstorm status --json\n  commentary resolve <thread-id> --message "Addressed."\n`,
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
