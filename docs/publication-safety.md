# Public Publication Safety

This repository is intended to be public. Treat every commit as externally visible.

## Required Gates Before Main

1. Open changes through a pull request.
2. Require the CI `verify` job to pass before merge.
3. Run `npm run public:check` locally before pushing changes that add docs, scripts, workflows, generated files, or test fixtures.
4. Keep branch protection enabled for `main`:
   - require pull requests before merging
   - require status checks to pass
   - require the `verify` workflow
   - restrict direct pushes to maintainers or disable direct pushes entirely
5. Rotate any token that was ever pasted into chat, terminal history, screenshots, logs, or issue comments.

## What The Public Check Blocks

`npm run public:check` scans every file Git would commit, including untracked files, for:

- Commentary PATs, npm tokens, GitHub tokens, and private-key blocks
- local absolute paths and personal workspace paths
- private Commentary source checkout paths
- staging host references
- committed `.env` files
- generated or local workspace directories such as `dist`, `coverage`, `node_modules`, and `.commentary`

## Manual Review Checklist

For every new file, ask:

- Is this necessary for users, contributors, CI, release, or tests?
- Is the file safe for a public repository?
- Does it reveal private product source paths, internal implementation details, unreleased plans, customer data, credentials, personal machine details, or private infrastructure?
- Can the same behavior be documented with public URLs, public API contracts, or generic examples?

If the answer is uncertain, leave it out or move it to private operational documentation.
