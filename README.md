# Commentary CLI

`@commentary-dev/cli` is the thin terminal companion for Commentary's human decision layer. It preserves established Draft and Brainstorming Review workflows and also maps durable Interaction, read-only Decision receipt, and agent-reported Fulfillment commands to the hosted HTTP v1 API.

The executable name is `commentary`.

```bash
npx @commentary-dev/cli review ./docs/spec.md
npm install -g @commentary-dev/cli
commentary review ./docs/spec.md
```

## What It Does

- Creates private Commentary draft reviews from local files or folders.
- Creates and manages Brainstorming Reviews through the v1 draft-review API.
- Restores local session metadata from existing draft reviews.
- Adds new files to existing draft reviews.
- Uploads new revisions after local edits.
- Watches tracked files and syncs changes.
- Lists comments in text, Markdown, or JSON.
- Returns currently open comments or waits for the next live draft-review comment event for local agent loops.
- Replies to and resolves comments.
- Sets Brainstorming feedback signals, owner consensus decisions, and consensus rules.
- Shares draft reviews with anyone who has a link or grants access to a specific user.
- Links a single-file draft review to a GitHub base commit through the Commentary API.
- Pulls latest reviewed content back to disk with overwrite safeguards.
- Opens the review URL in the browser when available.
- Creates, reads, lists, revises, cancels, and waits for durable Interactions through HTTP v1.
- Reads delegated Inbox items, saved views, policies, insights, and notification receipts.
- Discovers workspace resources and team queues; links resources and renames authorized reviews.
- Sends agent messages, acknowledges guidance, and reads fulfillment history.
- Manages scoped webhook subscriptions and delivery replay.

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
Device-login tokens refresh automatically until the stored refresh token expires or is revoked.

## Common Workflow

Create a review:

```bash
commentary review ./docs/spec.md --title "Product spec"
commentary review ./docs/spec.md --title "Product spec" --mode brainstorming
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
commentary sync --message "Apply accepted feedback" --addressed-thread thread_123
```

Restore a previous review into the current directory and sync changed local files:

```bash
commentary restore draft_123
commentary restore draft_123 --dry-run --json
commentary restore draft_123 --yes
```

Permanently abandon a review and remove its linked local session metadata:

```bash
commentary abandon --yes
commentary abandon --session draft_123 --yes
```

Abandon requires explicit confirmation because deletion is permanent. When `--session` is used, the CLI deletes only the remote review and does not change local session metadata.

Add files to the existing review and upload a new revision:

```bash
commentary track ./docs/new-page.md --message "Add requested page"
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
commentary next-comment --file docs/spec.md --timeout 60s
commentary next-comment --no-include-replies
```

`next-comment` starts the live event stream, checks currently open threads, and waits only when nothing is open. Use `wait-comment` when you specifically want a future live event.

For unattended listener processes, use cooperative stop-file support:

```bash
commentary comments --watch --jsonl
commentary comments --stop
```

Update the GitHub base later:

```bash
commentary rebase --git-base auto
commentary rebase --clear-git-base
```

Reply and resolve:

```bash
commentary reply <thread-id> "Updated this in revision 3." --alias "Docs agent"
commentary resolve <thread-id> --message "Addressed in revision 3." --alias "Docs agent"
commentary resolve --thread -thread_123 --message "Addressed."
```

Brainstorming Reviews:

```bash
commentary brainstorm enable
commentary brainstorm status --json
commentary brainstorm next --json
commentary brainstorm signal thread_123 agree --alias "Docs agent"
commentary brainstorm decide thread_123 accepted_for_change
commentary brainstorm rule --consensus-mode no_open_blockers --min-response-count 2
```

Share a review:

```bash
commentary share --anyone
commentary share --user reviewer@example.com
commentary share --list
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
commentary restore <session-id>
commentary abandon --yes
commentary track <paths...>
commentary sync
commentary revision
commentary rebase
commentary watch
commentary comments
commentary brainstorm enable
commentary brainstorm status
commentary brainstorm next
commentary brainstorm signal <thread-id> <signal>
commentary brainstorm decide <thread-id> <decision>
commentary brainstorm rule
commentary next-comment
commentary wait-comment
commentary reply <thread-id> <message>
commentary reply --thread <thread-id> <message>
commentary resolve <thread-id>
commentary resolve --thread <thread-id>
commentary share
commentary pull
commentary open
commentary status
commentary sessions
commentary revisions
commentary interaction create
commentary interaction get <interaction-id>
commentary interaction list
commentary interaction revise <interaction-id>
commentary interaction cancel <interaction-id>
commentary interaction wait <interaction-id>
commentary decision get <interaction-id> <decision-id>
commentary decision wait <interaction-id>
commentary fulfillment report <interaction-id>
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

## Agent Inbox And Workspaces

Inbox and workspace commands use the hosted HTTP v1 API. The credential fixes the
workspace authority; `--workspace` must match that grant and never changes the
browser's selected workspace. A different workspace requires a credential granted
for that workspace. Existing credentials need the relevant additional scopes:

| Capability                                                                  | Scope                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------- |
| Inbox items, saved views, policies, simulation, insights, delivery receipts | `commentary.inbox.read`                                   |
| Workspace context, resource collections, team queue                         | `commentary.workspaces.read`                              |
| Link resources and rename owned draft or Web App reviews                    | `commentary.workspaces.resources.write`                   |
| Pending view and policy proposals                                           | `commentary.interactions.create`                          |
| Webhook diagnostics or mutations                                            | `commentary.webhooks.read` or `commentary.webhooks.write` |

Current workspace membership, source access, owner permissions, and feature
availability still apply. Discovery reads preserve recipient state. Insights
contain content-free metrics and suppress cohorts below 20 observations.
Notification history omits titles and app paths. View and policy proposals stay
inactive until an eligible human accepts them.

Combining `commentary.workspaces.read` with `commentary.interactions.read` permits
source-authorized workspace conversation reads beyond the token owner's received
Interactions. Decision receipts, guidance, and fulfillment retain creator authority.

Store separate credentials with the existing login command and `--profile <name>`.
Use that same global option on subsequent commands. A missing named profile never
falls back to the default login. An explicit `--token` or `COMMENTARY_TOKEN` takes
precedence. Tokens remain in OS configuration storage. Repeatable `login --scope`
values replace the default requested scopes and must be advertised by the server.
Default login now also requests `commentary.interactions.fulfillment`.

```bash
commentary --profile team --json workspace list
commentary --profile team --workspace ws_123 --json workspace get
commentary --profile team --workspace ws_123 --json workspace resources list --section reviews --filter state=active
commentary --profile team --workspace ws_123 --json workspace resources get draft_review draft_123
commentary --profile team --workspace ws_123 --json workspace queue list --assignment unassigned
commentary --profile team --workspace ws_123 --json inbox list --mode active --sort recommended
commentary --profile team --json inbox get ws_123 inb_123
commentary --profile team --json inbox view list
commentary --profile team --json inbox policy list --scope workspace
commentary --profile team --json inbox policy get iap_123
commentary --profile team --json inbox insights --window 30
commentary --profile team --json inbox notifications list --limit 20
```

Lists return one page and retain opaque continuations. Pass `--cursor` unchanged
on the next request with the same workspace and filters. Resource collections use
25-item pages; Inbox and conversation lists allow up to 100; notification history
allows up to 20. Collections support the browser's section-specific filters and
sorts. `--filter key=value` is repeatable.

Mutations read JSON using exactly one of `--file` or `--stdin`. No content payload
needs to appear in command arguments. Requests are bounded to 256 KiB, with 16 KiB
limits for view proposals and webhook creation. The API applies narrower field
limits where required.

```bash
commentary --workspace ws_123 --json workspace resources link --file link.json --idempotency-key link-42
commentary --workspace ws_123 --json workspace resources rename draft_review draft_123 --file rename.json
commentary --json inbox view propose --file view.json
commentary --json inbox policy propose --file policy.json --idempotency-key policy-42
commentary --json inbox policy simulate --file simulation.json
```

Resource link JSON is `{ "type": "draft_review", "id": "draft_123" }`. Rename
JSON contains `title` and the exact `expectedUpdatedAt` from the resource read.
Policy proposal JSON contains `name`, `precedence`, `definition`, and optional
`scope` (`personal` or `workspace`). Definitions use the API's typed
`schemaVersion: 1`, `condition`, and `effects` contract. Simulation JSON contains
`definition` and `entryId`; Commentary obtains authorized metadata for that item
and applies no effects. View proposals use `name` and their existing typed
`definition` contract.

These scopes expose agent work only. Human Decisions, feedback authoring, guidance
authoring, policy activation, notification consent, member management, and
credential administration remain outside these command groups. Dedicated Form,
Research, Brain, and preview authoring workflows are not introduced here.

## Agent Conversations And Webhooks

```bash
commentary --json interaction update ixn_123 --state waiting_for_agent --etag '"ixn_123:v2"' --idempotency-key state-42
commentary --json interaction messages list ixn_123
commentary --json interaction messages send ixn_123 --file message.json --etag '"ixn_123:v2"' --idempotency-key message-42
commentary --json interaction guidance list ixn_123
commentary --json interaction guidance acknowledge ixn_123 ixg_123 --idempotency-key guidance-42
commentary --json fulfillment get ixn_123
commentary --json webhook list
commentary --json webhook get whs_123
commentary --json webhook create --file webhook.json --idempotency-key webhook-42 --secret-file ../private/signing-secret
commentary --json webhook update whs_123 --file webhook-update.json --etag '"whs_123:v2"'
commentary --json webhook disable whs_123 --etag '"whs_123:v2"'
commentary --json webhook rotate-secret whs_123 --etag '"whs_123:v2"' --secret-file ../private/rotated-secret
commentary --json webhook deliveries list whs_123 --status failed
commentary --json webhook deliveries replay whs_123 whd_123 --yes
```

Message JSON contains `body` and optional `revisionId`. Lifecycle updates accept
only `active`, `waiting_for_human`, `waiting_for_agent`, `expired`, and `failed`;
they do not record human Decisions. Guidance retrieval and acknowledgment are
limited to the creating agent. An acknowledgment records delivery rather than
learning or application. Fulfillment remains self-reported history.

Webhook creation JSON contains `endpointUrl` and `eventTypes`. Creation and secret
rotation require a new `--secret-file` outside the project, whose parent directory
already exists. The CLI creates it exclusively, requests owner-only file permissions
where the operating system supports them, and excludes the secret from output. A creation
replay cannot return the secret again. Subscription changes use the exact ETag;
delivery replay requires `--yes` and can resend an external notification.

New agent command JSON preserves the API body and adds `ok`, `etag`,
`correlationId`, and `idempotencyReplayed`. Existing Interaction, Decision,
Fulfillment-report, Draft, and Brainstorming output shapes remain stable. Errors
in these agent groups are JSON on stderr with a meaningful exit code.

## Interaction Lifecycle

Interaction commands are thin mappings to '/api/v1/interactions'. The server remains
authoritative for lifecycle, validation, Resource authorization, scopes, retries, and
policy. The CLI does not use MCP or keep local Interaction state. Decision commands
are read-only; no CLI or agent command can approve, reject, choose, answer, or
otherwise write a human Decision.

Create content in a file so request bodies and sensitive review context do not enter
process arguments:

```bash
commentary interaction create \
  --resource-type draft_review \
  --resource-id draft_123 \
  --file interaction.json \
  --idempotency-key agent-run-42 \
  --correlation-id agent-run-42 \
  --json

printf '%s' '{"title":"Review the updated plan"}' |
  commentary interaction create \
    --resource-type draft_review \
    --resource-id draft_123 \
    --stdin \
    --idempotency-key agent-run-43 \
    --json
```

The JSON file or standard input is the Interaction 'content' object. Supported
Resource types are 'repository', 'pull_request', 'document', 'draft_review', 'form',
'research_study', 'knowledge_brain', and 'web_app_review'. Ids and cursors are opaque
and must be passed back unchanged.

Read and paginate:

```bash
commentary interaction get ixn_123 --json
commentary interaction list --state waiting_for_human --limit 25 --json
commentary interaction list --cursor cursor_from_previous_page --json
```

Mutations require the exact strong ETag returned by 'get', 'create', or the previous
mutation, plus a caller-generated idempotency key:

```bash
commentary interaction revise ixn_123 \
  --etag '"ixn_123:v1"' \
  --file revised-content.json \
  --idempotency-key revise-42 \
  --json

commentary interaction cancel ixn_123 \
  --etag '"ixn_123:v2"' \
  --idempotency-key cancel-42 \
  --json
```

Wait is interruptible with Ctrl-C and always bounded. Timeout is 1–3600 seconds and
poll interval is 250–60000 milliseconds:

```bash
commentary interaction wait ixn_123 --timeout 300 --poll-interval 1000 --json
```

Interaction exit codes are stable:

| Code | Meaning                                                                  |
| ---: | ------------------------------------------------------------------------ |
|    0 | Terminal success ('completed') or a successful non-wait command          |
|    2 | CLI usage error                                                          |
|    3 | Authentication or scope denial                                           |
|    4 | Network failure                                                          |
|    5 | Other API failure                                                        |
|    7 | Missing or stale ETag / precondition failure                             |
|    8 | Validation, not-found, or idempotency conflict                           |
|    9 | Server failure                                                           |
|   10 | Terminal negative state ('rejected', 'canceled', 'expired', or 'failed') |
|  124 | Wait timeout                                                             |
|  130 | Wait interrupted                                                         |

Every successful Interaction '--json' response includes 'ok'; item commands include
'interaction', 'etag', 'correlationId', and 'idempotencyReplayed'. Lists include
'interactions', 'page.limit', 'page.nextCursor', and 'correlationId'. Errors are
written as one JSON object to stderr with 'code', 'message', and 'exitCode', plus
server correlation and retry fields when supplied. Tokens and payload content are
never logged.

## Decision Receipts and Fulfillment

`decision wait --approval` waits for an approving receipt whose exact current
revision, action, fingerprint, expiry, and current approval policy are satisfied.
An individual approval in an unfinished team chain keeps waiting. Rejected,
expired, or unsatisfiable approval exits with code 10. Pending waits retain the
normal bounded timeout and interruption behavior. Approval counts omit human
identities. Ordinary receipt reads and waits retain their established behavior.

```bash
commentary decision wait ixn_123 --approval --timeout 300 --json
```

Interaction creation additionally accepts `--type request|notification|decision_request`
and `--priority low|normal|high|urgent`, subject to agent controls. Revision JSON may
contain plain content or an envelope with `content`, `priorRevisionId`, and
`addressedFeedbackIds`. Rich blocks, images, action policies, provenance, feedback
references, and revision differences remain in the server response.

`decision get` and `decision wait` are HTTP-only, privacy-safe reads from
`GET /api/v1/interactions/{interactionId}/decisions`. Opaque handles are passed
back unchanged. Receipts include the exact revision, action, approved proposal
fingerprint, semantic outcome, timestamps, terminal state, and purge state; they
exclude human identity, Resource data, consequence content, and action snapshots.
The CLI deliberately has no Decision mutation command.

```bash
commentary decision get ixn_123 ixd_123 --json
commentary decision wait ixn_123 --timeout 300 --poll-interval 1000 --json
commentary decision wait ixn_123 --after ixd_previous --timeout 300 --json
```

Decision waits are interruptible with Ctrl-C. The overall timeout is bounded from
1–3600 seconds and polling from 250–60000 milliseconds. A positive receipt exits 0. `reject`, `request_revision`, or a `rejected`, `canceled`, or `expired`
terminal state exits 10 after writing the receipt. A timeout exits 124 and an
interrupt exits 130.

`fulfillment report` appends an agent self-report to
`POST /api/v1/interactions/{interactionId}/fulfillment`. It requires the exact
Decision, revision, action, and lowercase 64-character SHA-256 proposal
fingerprint from the approved receipt. The server enforces scope, ownership,
approval, lifecycle ordering, expiry, revocation, and fingerprint matching.

```bash
commentary fulfillment report ixn_123 \
  --decision-id ixd_123 \
  --revision-id ixr_123 \
  --action-id ixa_123 \
  --proposal-fingerprint 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --status received \
  --idempotency-key receive-42 \
  --json

commentary fulfillment report ixn_123 \
  --decision-id ixd_123 \
  --revision-id ixr_123 \
  --action-id ixa_123 \
  --proposal-fingerprint 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --status completed \
  --idempotency-key complete-42 \
  --evidence-file evidence.json \
  --json
```

Evidence is optional structured JSON read only through `--evidence-file` or
`--evidence-stdin`, never a content-bearing argument. It is limited to 8 KiB,
must be an object, and rejects credential-shaped fields. Evidence and reporting
identity are omitted from normal JSON and human output. A successful report exits
0 even when its self-reported status is `failed` or `unknown`: acceptance of a
report does not claim successful execution or verified provider proof.

Decision and Fulfillment exit codes use the same stable transport contract:

| Code | Meaning                                                                     |
| ---: | --------------------------------------------------------------------------- |
|    0 | Positive Decision receipt or accepted Fulfillment report                    |
|    2 | CLI usage error                                                             |
|    3 | Authentication, ownership, or scope denial                                  |
|    4 | Network failure                                                             |
|    5 | Other API failure                                                           |
|    8 | Validation, not-found, fingerprint/idempotency mismatch, or server conflict |
|    9 | Server failure                                                              |
|   10 | Negative/rejected/canceled/expired Decision                                 |
|  124 | Decision wait timeout                                                       |
|  130 | Decision wait interrupted                                                   |

Successful Decision JSON contains `ok`, `decision`, `polling`, and
`correlationId`. Successful Fulfillment JSON contains `ok`, redacted
`fulfillment.report` and `fulfillment.current`, `correlationId`, and
`idempotencyReplayed`. Errors are one JSON object on stderr. API tokens,
evidence, and Decision content are never included in diagnostics.

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

5. For interactive review loops, the agent should use short bounded `next-comment` waits so it does not miss comments created while it was editing and can stop promptly when asked:

   ```bash
   commentary next-comment --timeout 60s --json
   ```

6. The agent updates the local file.
7. Upload the revision:

   ```bash
   commentary sync --message "Address review comments"
   ```

8. Repeat until ready to commit locally with your own git tools.

If a review comment asks for an additional file, add it to the existing review instead of creating a second review:

```bash
commentary track ./docs/new-page.md --message "Add requested page"
```

## JSON Output

Use `--json` for automation:

```bash
commentary review ./docs/spec.md --json
commentary status --json
commentary comments --json --open
commentary next-comment --json
commentary brainstorm status --json
commentary brainstorm next --json
commentary abandon --yes --json
commentary interaction list --json
commentary interaction wait ixn_123 --timeout 300 --json
commentary decision wait ixn_123 --timeout 300 --json
commentary fulfillment report ixn_123 --decision-id ixd_123 --revision-id ixr_123 --action-id ixa_123 --proposal-fingerprint <sha256> --status received --idempotency-key receive-42 --json
```

JSON output is intended to be stable across patch releases. Additive fields may appear in minor releases.

`commentary abandon` uses `DELETE /api/v1/draft-reviews/{sessionId}` and requires the `commentary.draft_reviews.delete` scope. Stored device-login grants created before this scope was added may require `commentary logout` followed by `commentary login` before they can abandon reviews.

Interaction commands require the matching 'commentary.interactions.create',
'.read', '.update', or '.cancel' scope. Stored device-login grants created before
these scopes were added may require 'commentary logout' followed by 'commentary
login'.

Decision receipt reads require `commentary.interactions.read`. Fulfillment
reports require `commentary.interactions.fulfillment`; these scopes never grant
human Decision authority. Existing configurations remain valid, but stored
device-login grants created before the Fulfillment scope was added may require a
fresh login.

## Live Comment Waiting

`commentary next-comment` and `commentary wait-comment` use Commentary draft-review live updates and require a server that exposes `GET /api/v1/draft-reviews/{sessionId}/events`. Tokens need the `commentary.comments.read` scope.

For agent loops, prefer `commentary next-comment --timeout 60s --json`. It starts the live event stream, lists open threads, returns open threads immediately if any exist, and otherwise waits for the next matching event. Short bounded waits let an agent stop promptly when the user asks it to stop.

For unattended listeners, use `commentary comments --watch --jsonl`. Stop a running listener with `commentary comments --stop`, or pass a custom `--stop-file <path>` to both commands.

`commentary wait-comment` starts from `cursor=latest` by default, waits for a future `comment.created` or `reply.created` event, prints the first match, and exits. Replies are included by default so a human follow-up to an agent reply wakes the waiting agent. Use `--no-include-replies` to wait only for top-level comments, `--cursor <id>` to resume after a known live-event cursor, `--from beginning` to read historical events, and `--timeout 0` to wait indefinitely. If the event stream disconnects before a matching comment arrives, the CLI reconnects with the latest cursor it has seen.

`commentary wait-comment` is future-event-only by default. It does not list already-open threads.

## Brainstorming Reviews

Use `commentary review --mode brainstorming <paths...>` to create a Brainstorming Review, or `commentary brainstorm enable` to convert the linked draft review. The local `.commentary/session.json` format is unchanged; mode, feedback, and consensus state stay in Commentary.

`commentary comments --consensus-state <state>` filters Brainstorming threads by consensus state. `commentary brainstorm next` defaults to `accepted_for_change`, starts the live event stream, lists current matching threads, and waits only if none are ready.

Feedback signals are:

```text
agree
object
blocker
needs_clarification
addressed
```

`addressed` and `brainstorm decide` are owner/status operations and require the token to have the required Commentary scopes and feature access. To mark accepted feedback as applied while uploading local changes, pass one or more `--addressed-thread <id>` flags to `commentary sync`.

## GitHub Base Metadata

Single-file draft reviews can be linked to a GitHub base commit:

```bash
commentary review ./docs/spec.md --git-base auto
commentary rebase --git-base auto
commentary rebase --git-base-repo commentary-dev/commentary-docs --git-base-sha abc123
```

The CLI sends this metadata to the Commentary API as `gitBase`. It is not stored in `.commentary/session.json`, and it does not create branches, commits, pull requests, provider reviews, or GitHub tokens. `commentary revisions` lists uploaded local draft revisions; the GitHub base is server-side comparison metadata, not a local revision row.

## Restoring Local State

Use `commentary restore <session-id>` when a previous draft review exists but local `.commentary/session.json` is missing. Restore reads review-relative file metadata from Commentary, writes local session metadata under the current directory, and uploads a new revision when local file hashes differ from the review's latest revision.

Restore never stores local absolute paths on the server. The current directory becomes the local review root. If a session file already exists, pass `--yes` to replace it. Use `--dry-run` to preview and `--no-sync` to write metadata without uploading changed local files.

## Sharing Reviews

Use `commentary share --anyone` to create or return a share link, or `commentary share --user <recipient>` to grant access to a specific user. `commentary share` and `commentary share --list` show current share links and user access grants. Revoke access with `--revoke-link <shareLinkId>` or `--remove-access <accessGrantId>`.

Sharing state is stored by the Commentary API. The CLI does not write share links, recipients, or access grants to `.commentary/session.json`.

## Heading Anchors

Commentary-rendered Markdown heading anchors normalize heading text to lowercase words separated by single hyphens. Punctuation and repeated separators collapse, so `Security & Compliance` becomes `#security-compliance`. This can differ from GitHub-style anchors for headings with punctuation.

## Agent Alias

Use `--alias <name>` on `reply` or `resolve --message` to attribute agent-authored replies. For automation, set `COMMENTARY_AGENT_ALIAS`; an explicit `--alias` flag takes precedence.

Use `--thread <id>` with `reply` or `resolve` when a thread id starts with a dash and could be confused for an option.

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

The release workflow uses npm trusted publishing through GitHub Actions OIDC,
with Node 24, npm 11, and `id-token: write`. Configure a GitHub Actions trusted
publisher in the npm package settings for `@commentary-dev/cli`:

| Setting              | Value                                       |
| -------------------- | ------------------------------------------- |
| Organization or user | `commentary-dev`                            |
| Repository           | `commentary-cli`                            |
| Workflow filename    | `release.yml`                               |
| Environment name     | Leave blank                                 |
| Allowed actions      | Enable direct publishing with `npm publish` |

The workflow filename is entered without its directory. The release job has no
GitHub environment. `NPM_TOKEN` is not used by this workflow; retain
`COMMENTARY_LIVE_TOKEN` for the production smoke test. After confirming a
successful trusted publication, remove the unused npm publishing secret and
revoke its old token. See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Security Model

Commentary stores review sessions and comments. The CLI syncs local text files to Commentary and can download reviewed files back to disk. Users and local agents remain responsible for local edits, commits, branches, and pushes.

Use `--dry-run`, `--output`, `--backup`, and `--yes` with `commentary pull` to control local file writes.
