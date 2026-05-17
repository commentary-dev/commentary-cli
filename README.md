# Commentary CLI

`@commentary-dev/cli` creates and manages Commentary Draft Review Sessions from local Markdown, MDX, HTML, and plain text files. It is a thin terminal companion for the hosted Commentary review UI.

The executable name is `commentary`.

```bash
npx @commentary-dev/cli review ./docs/spec.md
npm install -g @commentary-dev/cli
commentary review ./docs/spec.md
```

## What It Does

- Creates private Commentary draft reviews from local files or folders.
- Uploads new revisions after local edits.
- Watches tracked files and syncs changes.
- Lists comments in text, Markdown, or JSON.
- Returns currently open comments or waits for the next live draft-review comment event for local agent loops.
- Replies to and resolves comments.
- Links a single-file draft review to a GitHub base commit through the Commentary API.
- Pulls latest reviewed content back to disk with overwrite safeguards.
- Opens the review URL in the browser when available.

It does not create GitHub branches, commits, pull requests, provider comments, or GitHub tokens.

## Install

```bash
npm install -g @commentary-dev/cli
commentary --help
```

For one-off use:

```bash
npx @commentary-dev/cli --help
```

## Authentication

Browser/device login:

```bash
commentary login
```

Manual token login:

```bash
commentary login --token <commentary-api-token>
```

Environment token for automation:

```bash
COMMENTARY_TOKEN=<token> commentary review ./docs/spec.md
```

Tokens are stored outside the project config. Project metadata in `.commentary/session.json` never stores secrets.

## Common Workflow

Create a review:

```bash
commentary review ./docs/spec.md --title "Product spec"
commentary review ./docs/spec.md --title "Product spec" --git-base auto
```

`--git-base auto` infers the GitHub owner/repo from the local `origin` remote, uses the current `HEAD` commit, and uses the repository-relative file path. For explicit metadata, use `--git-base-repo <owner/repo>` and `--git-base-sha <sha>`.

Create one review from a folder or multiple files:

```bash
commentary review ./docs
commentary review ./docs/spec.md ./docs/architecture.md
```

Upload a new revision:

```bash
commentary sync --message "Address review comments"
```

Watch tracked files:

```bash
commentary review ./docs/spec.md --watch
commentary watch
```

List open comments for an agent:

```bash
commentary comments --format markdown --open
```

Return the next actionable review comment for an agent:

```bash
commentary next-comment --json
commentary next-comment --file docs/spec.md --timeout 15m
commentary next-comment --no-include-replies
```

`next-comment` starts the live event stream, checks currently open threads, and waits only when nothing is open. Use `wait-comment` when you specifically want a future live event.

Update the GitHub base later:

```bash
commentary rebase --git-base auto
commentary rebase --clear-git-base
```

Reply and resolve:

```bash
commentary reply <thread-id> "Updated this in revision 3." --alias "Docs agent"
commentary resolve <thread-id> --message "Addressed in revision 3." --alias "Docs agent"
```

Pull latest reviewed content safely:

```bash
commentary pull --dry-run
commentary pull --backup --yes
commentary pull --output reviewed
```

Open the review:

```bash
commentary open
```

## Commands

```text
commentary login
commentary logout
commentary whoami
commentary review <paths...>
commentary sync
commentary revision
commentary rebase
commentary watch
commentary comments
commentary next-comment
commentary wait-comment
commentary reply <thread-id> <message>
commentary resolve <thread-id>
commentary pull
commentary open
commentary status
commentary sessions
commentary revisions
```

Global options:

```text
--base-url <url>
--token <token>
--json
--verbose
--quiet
--no-color
--session-file <path>
```

Environment variables:

```text
COMMENTARY_BASE_URL
COMMENTARY_TOKEN
COMMENTARY_SESSION
COMMENTARY_NO_COLOR
COMMENTARY_CONFIG_DIR
COMMENTARY_AGENT_ALIAS
```

## Base URLs

Production is the default:

```bash
commentary review ./docs/spec.md
```

Use another environment or localhost:

```bash
COMMENTARY_BASE_URL=https://commentary.example.com commentary review ./docs/spec.md
commentary --base-url http://localhost:3000 review ./docs/spec.md
```

## Supported Files

Included by default:

```text
.md
.markdown
.mdx
.html
.htm
.txt
```

Ignored by default:

```text
.git
node_modules
dist
build
.next
.nuxt
coverage
.commentary
.DS_Store
```

App-side draft review limits are enforced before upload:

- 20 files per revision
- 512 KiB per file
- 2 MiB total per revision

## Agent Workflow

1. Ask your agent to create or update a Markdown, MDX, HTML, or text file.
2. Run:

   ```bash
   commentary review ./docs/spec.md --git-base auto
   ```

3. Review the rendered document in Commentary and leave comments.
4. Ask the agent to run:

   ```bash
   commentary comments --format markdown --open
   ```

5. For interactive review loops, the agent should use `next-comment` so it does not miss comments created while it was editing:

   ```bash
   commentary next-comment --timeout 15m --json
   ```

6. The agent updates the local file.
7. Upload the revision:

   ```bash
   commentary sync --message "Address review comments"
   ```

8. Repeat until ready to commit locally with your own git tools.

## JSON Output

Use `--json` for automation:

```bash
commentary review ./docs/spec.md --json
commentary status --json
commentary comments --json --open
commentary next-comment --json
```

JSON output is intended to be stable across patch releases. Additive fields may appear in minor releases.

## Live Comment Waiting

`commentary next-comment` and `commentary wait-comment` use Commentary draft-review live updates and require a server that exposes `GET /api/v1/draft-reviews/{sessionId}/events`. Tokens need the `commentary.comments.read` scope.

For agent loops, prefer `commentary next-comment --timeout 15m --json`. It starts the live event stream, lists open threads, returns open threads immediately if any exist, and otherwise waits for the next matching event. This avoids relying on the live event stream as a substitute for checking open threads.

`commentary wait-comment` starts from `cursor=latest` by default, waits for a future `comment.created` or `reply.created` event, prints the first match, and exits. Replies are included by default so a human follow-up to an agent reply wakes the waiting agent. Use `--no-include-replies` to wait only for top-level comments, `--cursor <id>` to resume after a known live-event cursor, `--from beginning` to read historical events, and `--timeout 0` to wait indefinitely. If the event stream disconnects before a matching comment arrives, the CLI reconnects with the latest cursor it has seen.

`commentary wait-comment` is future-event-only by default. It does not list already-open threads.

## GitHub Base Metadata

Single-file draft reviews can be linked to a GitHub base commit:

```bash
commentary review ./docs/spec.md --git-base auto
commentary rebase --git-base auto
commentary rebase --git-base-repo commentary-dev/commentary-docs --git-base-sha abc123
```

The CLI sends this metadata to the Commentary API as `gitBase`. It is not stored in `.commentary/session.json`, and it does not create branches, commits, pull requests, provider reviews, or GitHub tokens. `commentary revisions` lists uploaded local draft revisions; the GitHub base is server-side comparison metadata, not a local revision row.

## Heading Anchors

Commentary-rendered Markdown heading anchors normalize heading text to lowercase words separated by single hyphens. Punctuation and repeated separators collapse, so `Security & Compliance` becomes `#security-compliance`. This can differ from GitHub-style anchors for headings with punctuation.

## Agent Alias

Use `--alias <name>` on `reply` or `resolve --message` to attribute agent-authored replies. For automation, set `COMMENTARY_AGENT_ALIAS`; an explicit `--alias` flag takes precedence.

`commentary reply` reopens a resolved thread when the reply API response still reports the thread as resolved. This keeps a thread active after a new follow-up response.

## Local Metadata

The CLI writes `.commentary/session.json` in the project. It includes:

- draft review session id
- review URL
- base URL
- root path
- tracked files and file ids
- file hashes and sizes
- last known revision
- sync timestamps

It does not include auth tokens.

## Development

```bash
npm install
npm run dev -- --help
npm run typecheck
npm run lint
npm run test
npm run build
npm run verify
```

Live production validation is opt-in:

```bash
COMMENTARY_LIVE_TOKEN=<token> npm run test:live
```

The live suite creates a review, waits for reviewer comments, syncs agent revisions, and verifies a two-turn comment/revision loop. The release workflow requires production live validation on `main`, then publishes to npm with provenance when the package version has not already been published.

## Security Model

Commentary stores review sessions and comments. The CLI syncs local text files to Commentary and can download reviewed files back to disk. Users and local agents remain responsible for local edits, commits, branches, and pushes.

Use `--dry-run`, `--output`, `--backup`, and `--yes` with `commentary pull` to control local file writes.
