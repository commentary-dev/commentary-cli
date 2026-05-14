# AGENTS.md

## Repo Intent

This repository builds `@commentary-dev/cli`, the command-line companion for Commentary Draft Review Sessions. The CLI creates, syncs, watches, reads comments from, waits for live comments, replies to, resolves, pulls, and opens draft reviews for local Markdown, HTML, MDX, and plain text files.

## Product Boundaries

- Keep the CLI thin. Commentary business logic belongs in the hosted Commentary API.
- Use the HTTP v1 draft-review API as the v1 transport. Do not introduce MCP as a second transport unless a user explicitly asks for it.
- Do not add GitHub branch creation, commits, pull requests, provider review submission, or GitHub token management.
- Do not store secrets in project metadata. `.commentary/session.json` may contain session ids, URLs, tracked file paths, file ids, hashes, and timestamps only.
- Token storage must stay outside the repo through OS config storage or a keychain integration when one is deliberately added.

## Implementation Standards

- Keep raw HTTP calls inside the API client layer.
- Keep event-stream parsing in a small reusable module. Commands should consume typed live events rather than parse SSE text.
- Keep command modules as orchestration: parse options, call pure helpers, call the API client, format output.
- Prefer pure, tested modules for file collection, content type detection, hashing, metadata IO, token config, and output formatting.
- Commands must support non-interactive use. If a command can prompt, it must also support flags such as `--yes`, `--dry-run`, or `--json`.
- Do not print spinners in CI or non-TTY output. Keep logs parseable.
- Preserve stable JSON output shapes for automation.
- Use clear, actionable errors and meaningful exit codes.
- Keep this repository public-safe. Do not commit local absolute paths, personal machine details, credentials, private Commentary source paths, private architecture notes, or unreleased internal product details.

## Build And Test Workflow

- Use Node 22 or newer.
- Install dependencies with `npm ci` after lockfile creation, or `npm install` while bootstrapping.
- Run `npm run verify` before handoff.
- Run `npm run public:check` before opening a PR and after adding generated files, docs, or workflows.
- Run `npm run test:live` only with `COMMENTARY_LIVE_TOKEN` set and only when live Commentary production validation is intended.

## API Notes

- Default base URL is `https://commentary.dev`.
- Supported override paths are `--base-url` and `COMMENTARY_BASE_URL`.
- Required scopes are `commentary.review.read`, `commentary.comments.read`, `commentary.comments.write`, and `commentary.comments.status`.
- Draft-review limits mirror the app: 20 files, 512 KiB per file, and 2 MiB total per revision.
- `commentary wait-comment` depends on the v1 live-events endpoint at `/api/v1/draft-reviews/{sessionId}/events`, starts from `cursor=latest` by default, and should use `--json` for agent automation.
