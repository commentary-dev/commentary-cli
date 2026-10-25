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
- Publishes complete static walkthrough packages with resumable byte transfers.
- Composes immutable Project Review Sessions and requests exact human Decisions.
- Publishes and inspects source snapshots with pinned provenance.
- Attaches caller evidence and requests independent provider verification.

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
commentary review ./docs/spec.md --title "Product spec" --consensus
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

## Review collaboration

New reviews default Polls and Consensus off. Use `commentary review ./docs --polls --consensus` to enable both at creation. Existing reviews use shared collaboration operations with JSON payloads:

`commentary collaboration settings --file review.json --json` reads settings for a typed `review` reference. `configure` accepts `review`, `collaboration`, `expectedVersion` and a stable `operationKey`. `decision` reads a thread; `decide` accepts the shared decision mutation, including `record_application` with an exact `resultingRevision`. `polls` and `poll` read and mutate polls. `gate` requires `review` and `revision`.

Reads require `commentary.review.read` or `commentary.comments.read` as appropriate. Poll mutations and thread decisions require `commentary.comments.write`; configuring settings additionally requires `commentary.review.settings.write`. Request that extra scope explicitly with repeatable `login --scope` options, which replace the default scopes.

All commands support `--stdin`. Reuse the same operation key and intent on retries. Obtain current versions before mutations. Agent input is advisory unless enabled; only humans configure or waive human sign-off. Reading a gate cannot manufacture approval. Upload content with the ordinary sync command, then separately record an application claim against the accepted decision. Resolving a thread does not clear a blocker or create approval.

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

## Projects and Trackers

Use singular `project` and `tracker` command families. `track` continues to
add local files to a Draft. Projects may have no Tracker; Trackers may stand alone.
Pass `--project <id>` or `--tracker <id>` explicitly. Global profiles, workspace,
base URL, token and JSON options work across these families.

Request the least-privilege scopes during login (repeat `--scope` to replace
defaults): `commentary.projects.read/write` and `commentary.trackers.read/write`.
Provider dispatch also needs `commentary.trackers.writeback`, current provider
write access and `--provider-intent`. The CLI invokes HTTP v1 only.

### A filesystem workflow

Save a contract as `schema.yaml`:

```yaml
kind: commentary_tracker
contractVersion: 1
name: Release readiness
fields:
  - id: title
    type: text
    label: Work
    required: true
views: []
```

```sh
commentary --workspace workspace-1 tracker validate --file schema.yaml --json
commentary --workspace workspace-1 tracker create --file schema.yaml --idempotency-key tracker-create-1 --json
commentary project create --workspace workspace-1 --file project.json --idempotency-key project-create-1 --json
commentary tracker get --tracker tracker-1 --json
commentary tracker records query --tracker tracker-1 --file query.json --json
commentary tracker records create --tracker tracker-1 --file record.json --idempotency-key record-create-1 --json
commentary tracker records update record-1 --tracker tracker-1 --file patch.json --etag '"record-1:v1"' --idempotency-key record-edit-1 --json
commentary tracker export --tracker tracker-1 --output portable.json --json
commentary tracker import new-preview --workspace workspace-1 --file portable.json --mode clone --dry-run --idempotency-key clone-preview-1 --json
```

`project.json` is `{"name":"Release readiness"}`; `query.json` is
`{"query":{"limit":25,"archived":false}}`. `record.json` contains
`{"schemaRevisionId":"schema-1","values":{"title":"Review walkthrough"}}`.
`patch.json` contains
`{"schemaRevisionId":"schema-1","patch":{"values":{"title":"Updated walkthrough"},"unset":[]}}`.
Use actual returned IDs, schema IDs and strong ETags. These examples do not assert
that placeholder IDs exist or that execution status grants human acceptance.

Link an existing Resource with `project resources link --project project-1`,
an exact Project ETag, retry key and a payload such as
`{"target":{"type":"tracker","id":"tracker-1"}}`. Links do not copy content
or grant source access. Resource/relationship detach operations retain originals.

### Operations and safety

Project operations are create/list/get/update/archive/restore/complete,
`resources list/link/unlink`, `relationships list/link/unlink`, participants,
external references, workspace links and history. Lifecycle/access management
remains human-only when required by server authority; CLI registration does not
grant those permissions. Status/activity/feedback explain the current server
state through their implemented status/activity/feedback handlers. These commands
return authoritative status or bounded durable event pages, with opaque cursors.

Tracker operations include validate/create/list/get/update/archive/restore;
`schema get/list/preview/apply`; `records query/get/history/create/update/bulk/reorder/archive`;
`views list/get/create/update/delete`; export;
`import preview/new-preview/apply/get/cancel`; `authority preview/apply`;
`proposals stage`; and `sync bind/status/proposal/preview/apply/resolve/retry/cancel/refresh`.
Use nested `--help` for the exact scopes, child identifiers and flags.

Structured operations require exactly one `--file` or `--stdin`, accepting JSON
or core YAML. Duplicate keys, custom tags, aliases, unsafe keys, credentials and
oversized inputs are rejected. Contract and record semantics are validated by
the authoritative server. Import preview accepts either a request envelope or a
canonical export plus explicit mode/schema options. Query limits are bounded to 100. Import previews may retain a private diagnostic checkpoint; dry-run never
applies records or writes to a provider. Apply requires the explicit preview or
proposal identity and exact version. Azure writes return
`unsupported_provider_write`; the CLI never creates local branches/commits/PRs.

Reuse an idempotency key only for an exact retry, including its original ETag.
Stale edits retain the submitted request under `.commentary/conflicts/`, refetch
the current version and return exit 7 (or the server's stable conflict exit).
Reconcile explicitly using a fresh key; no automatic last-write-wins retry occurs.
Recovery files never contain CLI credentials; session metadata is untouched.

JSON keeps `ok/data/etag/correlationId/idempotencyReplayed` and server pagination,
permissions and diagnostics. Replay is `null` when a server omits its optional
header, instead of inferring that a write did not replay. Errors retain codes and
field diagnostics. Missing credential profiles fail without fallback.

Core Projects, native Tracker views, portability, agent API and Git source are
Free. Authorized Git writeback is Pro-preview and remains usable during no billing.
Publication/deployment, live providers, MCP parity and genuine human acceptance
require their own release evidence; CLI fixture tests do not establish them.

## Packages and Engineering Reviews

The singular `package`, `review-session`, `source-snapshot`, and `evidence`
families use HTTP v1 and the same global `--workspace`, `--profile`, `--base-url`
and `--json` options. Existing Draft `review`, `sync`, `sessions`, `comments`,
`decision` and `fulfillment` keep their meanings. New scopes must be granted
explicitly; old credentials gain no additional access automatically.

| Family                           | Scopes                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Package read/publication         | `commentary.review_packages.read`, `commentary.review_packages.write`                 |
| Review Session read/revisions    | `commentary.project_reviews.read`, `commentary.project_reviews.write`                 |
| Exact human review request       | Session write plus `commentary.interactions.create`                                   |
| Source snapshot read/publication | `commentary.source_snapshots.read`, `commentary.source_snapshots.write`               |
| Evidence read/write/verification | `commentary.evidence.read`, `commentary.evidence.write`, `commentary.evidence.verify` |

Feedback retrieval additionally requires `commentary.comments.read`. Workspace,
Resource, registered Agent, current grant and provider authorization are checked
by the server on each operation. Linking a Resource never grants access to it.

### Publish and revise a walkthrough

Prepare a directory with `index.md`, `architecture.md`, and any referenced static
assets. An optional `package-manifest.json` outside that directory can describe
stable page IDs and navigation:

```json
{
  "kind": "commentary_review_package",
  "manifestVersion": 1,
  "title": "Implementation walkthrough",
  "entryPage": "index.md",
  "pages": [
    { "id": "overview", "path": "index.md", "title": "Overview" },
    { "id": "architecture", "path": "architecture.md", "title": "Architecture" }
  ],
  "trustTier": "static"
}
```

```sh
commentary --workspace workspace-1 --json package validate ./walkthrough --manifest package-manifest.json
commentary --workspace workspace-1 --json package publish ./walkthrough --manifest package-manifest.json --idempotency-key walkthrough-publish-1 --no-open
commentary --workspace workspace-1 --json package get package-1
commentary --workspace workspace-1 --json package revisions package-1
commentary --workspace workspace-1 --json package comments package-1 --path index.md
# Edit the walkthrough in response to the returned native review threads.
commentary --workspace workspace-1 --json package sync ./walkthrough --manifest package-manifest.json --no-open
commentary --workspace workspace-1 --json package watch ./walkthrough --manifest package-manifest.json --no-open
commentary --workspace workspace-1 --json package upload status upload-1
```

Use actual returned identities and exact ETags. `package sync` reads the last
acknowledged package identity/ETag from `.commentary/package.json`, or accepts
explicit `--package` and `--etag`. A pending publication retains its original
retry identity and upload ID; repeating the same input resumes missing chunks.
Changing pending input returns a conflict rather than silently replacing it.
Watch debounces changes, serializes revisions, excludes Commentary metadata and
retains the last acknowledged revision when a publication fails.

`validate` and `--dry-run` hash and validate without HTTP or metadata writes.
Publication never runs customer build commands. The explicit package collector
includes generated `dist`/`build` content, while Draft's ignored directories and
20-file/512-KiB/2-MiB limits remain unchanged. Static packages have at most 10,000
files and 250 MiB total, with 2 MiB text and 25 MiB asset limits. Supported static
assets include styles, images, fonts, structured data and PDFs. Paths must be
relative and unambiguous; symlinks, archives, unsupported executable files,
duplicate normalized paths and credential configuration are rejected. Executable
renderer bundles use their separate isolated publication contract.

Package metadata contains identifiers, relative paths, acknowledged hashes and
pending transfer identities. Source bodies, authentication tokens and reviewer
identities are excluded. It is separate from Draft's `.commentary/session.json`.

### Compose an exact Review Session

Save `session.json` with exact Resource revisions from authorized server reads:

```json
{
  "title": "Review the implementation",
  "purposeMarkdown": "Read the walkthrough, then inspect the retained source and evidence.",
  "targets": [
    {
      "resource": { "type": "review_package", "id": "package-1" },
      "revisionId": "package-revision-1",
      "sha256": "COPY_THE_ACTUAL_RETURNED_64_CHARACTER_SHA256"
    }
  ]
}
```

The illustrative SHA string must be replaced with the exact returned digest.
Targets can also include other authorized reviews and snapshots; Session
composition retains their original Resource identities and access rules.

```sh
commentary --workspace workspace-1 --json review-session create --file session.json --idempotency-key session-create-1
commentary --workspace workspace-1 --json review-session list
commentary --workspace workspace-1 --json review-session get session-1
commentary --workspace workspace-1 --json review-session status session-1
commentary --workspace workspace-1 --json review-session manifest session-1 session-revision-1
commentary --workspace workspace-1 --json review-session resources link session-1 --file target.json --etag '"session-1:v1"' --idempotency-key session-link-1
commentary --workspace workspace-1 --json review-session revision session-1 --file revised-session.json --etag '"session-1:v2"' --idempotency-key session-revise-1
commentary --workspace workspace-1 --json review-session request-review session-1 --file acceptance-request.json --etag '"session-1:v3"' --idempotency-key session-review-1
commentary --workspace workspace-1 --json review-session acceptance get session-1
commentary --workspace workspace-1 --json review-session feedback session-1 --cursor OPAQUE_CURSOR --timeout 60
```

`target.json` is `{ "target": <one exact target> }`; `resources unlink` takes the
same envelope. Both create an immutable manifest revision using the exact Session
ETag and require a complete authorized manifest. `revised-session.json` contains
the entire intended ordered `targets` array and optional title/purpose changes.
`update` changes Session descriptive fields; it does not substitute new targets.

`request-review` calls the existing exact acceptance-request API and creates an
Interaction for eligible humans. Its request is `{ "target": <exact acceptance
target>, "consequence": "Accept this exact implementation" }`, with optional
`approvalPolicy`. The target contains `version: 1`, `sessionId`,
`sessionRevisionId`, `revisionSetFingerprint`, `manifestSha256`, `scope`
(`session` or `deliverable`), exact `targets`, and `supportingRevisions` copied
from authoritative reads. There is no CLI agent approval operation. Reading a
receipt or publishing a later revision does not manufacture acceptance; material
revision changes are evaluated against the server's exact acceptance rules.

Session activity/feedback return one bounded event page, optionally waiting
0–10,000 ms with `--wait-ms`. `--timeout` waits for at most 1–3,600 seconds,
replays the last acknowledged cursor after disconnection, and refetches the
current Session once after a cursor gap. The JSON marks that recovery with
`resynchronized` and an authorized `snapshot`. Retain `nextCursor` unchanged for
the next invocation. Timeout returns 124 and interruption returns 130.

### Retain source provenance

Provider publication takes an explicit repository Resource and exact commit SHA:

```json
{
  "reference": {
    "provider": "github",
    "resource": { "type": "repository", "id": "repository-1" },
    "commitSha": "COPY_THE_ACTUAL_40_CHARACTER_COMMIT_SHA"
  },
  "capturePolicy": "selected",
  "selectedPaths": ["src/app.ts"]
}
```

```sh
commentary --workspace workspace-1 --json source-snapshot publish --file source-request.json --idempotency-key source-reference-1
commentary --workspace workspace-1 --json source-snapshot get snapshot-1
commentary --workspace workspace-1 --json source-snapshot tree snapshot-1 --path src
commentary --workspace workspace-1 --json source-snapshot file snapshot-1 --path src/app.ts --start-line 1 --line-count 100
commentary --workspace workspace-1 --json source-snapshot search snapshot-1 --file search.json
commentary --workspace workspace-1 --json source-snapshot publish-directory ./source --file local-source.json --idempotency-key local-source-1 --dry-run
commentary --workspace workspace-1 --json source-snapshot publish-directory ./source --file local-source.json --idempotency-key local-source-1 --no-open
```

`search.json` is `{ "query": "counter", "limit": 25 }`. `local-source.json` is
`{ "reference": { "provider": "uploaded", "resource": { "type": "repository",
"id": "repository-1" } }, "capturePolicy": "full" }`. It omits `uploadId`; the
CLI supplies it after resumable upload. Directory transfers additionally require `commentary.review_packages.read` and `commentary.review_packages.write` for the shared upload protocol. Local bytes have `uploaded` provenance,
not provider-confirmed provenance. Provider publication supports GitHub and
Azure DevOps reads under current authority. Tree/file/search always read the
hosted snapshot; local files do not replace revoked or unavailable hosted content.

Local collection permits bounded inert source files, requires at most 5,000
files, and retains the upload safety rules and conservative text limits. The
shared inert upload policy excludes script and executable names such as `.py`,
`.rb`, `.sh`, `.bat`, `.cmd`, `.ps1`, `.php`, `Dockerfile` and `Procfile`, as well
as executable binaries and archives. Admitted source text remains inert;
publication never executes code. `.commentary/source-snapshot.json` retains hashes and transfer
identities separately from Draft and package metadata. Retrying unchanged input
with the same key resumes the transfer; modified pending input fails safely.

### Keep reports separate from observed verification

```sh
commentary --workspace workspace-1 --json evidence attach --file evidence.json --idempotency-key evidence-attach-1
commentary --workspace workspace-1 --json evidence list --context '{"type":"project_review_session","id":"session-1"}'
commentary --workspace workspace-1 --json evidence get evidence-1
commentary --workspace workspace-1 --json evidence reconcile evidence-1 --file evidence-update.json --etag '"evidence-1:v1"' --idempotency-key evidence-reconcile-1
commentary --workspace workspace-1 --json evidence request-verification evidence-1 --file verification.json --etag '"evidence-1:v2"' --idempotency-key verification-request-1
commentary --workspace workspace-1 --json evidence read-results evidence-1 verification-1
```

`evidence.json` contains an owning `context` (Project or Review Session), `title`,
exact `targets`, optional relations and supplied `report: { "format": "json",
"content": "..." }`, plus optional reported `result`. Local reports are inert
caller evidence; the CLI does not parse a test report as proof that Commentary
ran it. `verification.json` names the exact `evidenceRevisionId`, `provider`,
`runId`, `commitSha`, and optional expected artifact digests. Server observations
remain distinct from reported outcomes, artifact existence, human review and
acceptance. Read JSON provenance, currency and receipt fields as returned.

Basic packages, Session organization, source exploration, evidence and agent
access are Free under `review_packages.basic`, `review_packages.agent_api`,
`project_reviews.basic`, `project_reviews.agent_api`, `review.source_explorer`
and `projects.evidence.basic`. Advanced independent evidence processing uses
`project_reviews.advanced_evidence` Pro-preview and remains usable during the
no-billing phase. Dedicated renderer entitlements govern executable bundles.

JSON responses preserve `ok/data/etag/correlationId/idempotencyReplayed`, exact
revision identities, canonical URLs and server attention/provenance fields when
provided. Exact ETags and retry keys govern conditional writes; stale versions
are not overwritten. Older servers return actionable unsupported-capability
errors. Auth/API/safety/conflict/validation exits remain 3/5/6/7/8.
Deterministic fixtures and installed integration tests are separate from live
provider validation and real human correction/acceptance. Those release
boundaries require their own recorded evidence; CLI tests do not establish them.

## Current API parity

The CLI covers the versioned 158-operation Projects catalog through commands and
local publication workflows. `npm run contracts:check` verifies that the runtime
catalog and test snapshot agree. Maintainers can compare a supplied canonical
contract with `npm run contracts:check -- --source <canonical-contract.json>`.
The normal verification gate also checks that each operation has a reachable
command or an explicit publication/sync step.

Additional package operations use exact package and revision identities:

```sh
commentary --json package upload cancel upload-1 --idempotency-key cancel-1
commentary --json package files download package-1 revision-1 --path assets/diagram.svg --output diagram.svg
commentary --json package indexing retry package-1 revision-1 --idempotency-key retry-index-1
commentary --json package comments mutate package-1 revision-1 --file comment-action.json
commentary --json package renderers list package-1 --revision-id revision-1
commentary --json package renderers manage package-1 --file renderer-action.json
commentary --json package impact package-1 --from-revision-id revision-1 --to-revision-id revision-2
commentary --json review-session impact compare session-1 --from-revision-id revision-1 --to-revision-id revision-2
```

Downloads preserve bytes and MIME, accept at most 25 MiB, and require a new output
file. JSON output reports its path, size, SHA-256, ETag and correlation ID. Existing
files are never replaced. Comment actions use the current server schema, for
example `{ "action": "reply", "threadId": "thread-1", "bodyMarkdown": "Updated the explanation." }`.
Comment status actions require the separate comment-status scope. Renderer and
indexing operations retain their existing server permissions and license checks.

`review-session request review session-1 --file invitation.json --etag '"version"'
--idempotency-key invitation-1` sends an ordinary review invitation. Its payload
contains `manifestSha256`, `recipientIds`, and optional `messageMarkdown`.
The existing `review-session request-review` continues to request exact human
acceptance; the two operations have distinct payloads and do not approve anything.

Inbox listing supports `--interaction-type` and `--priority-band` alongside its
other filters. Interaction listing accepts Project, Tracker, package, review-guide
and source-snapshot resource types; interaction creation keeps its narrower
supported resource contract. Poll listing accepts `action` (`get`, `list` or
`markdown`), `pollId`, `threadId`, `outcome` and `after` in its JSON request as
appropriate. Expired event cursors retain the API's validation exit code 8.
