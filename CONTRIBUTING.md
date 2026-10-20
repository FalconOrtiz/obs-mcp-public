# Contributing

Thanks for helping improve obs-mcp.

## Setup

- Node.js 22.18 or newer (TypeScript runs through `--experimental-strip-types`; there is no build step and no npm dependencies).
- `npm test` runs the full suite against in-process fakes. OBS, Twitch, YouTube, Kick and X are never contacted.

## Pull requests

1. Fork, create a branch, and open a **draft** pull request early.
2. Add or update tests for every behavior change. `npm test` must pass.
3. Keep writes dry-run by default, and never log or return a secret value.
4. Use placeholders in docs, tests and fixtures: no real tokens, user ids, usernames, posts, channel names or local paths.
5. Describe what you changed and how you verified it.

## Reporting bugs

Open an issue with your OS, OBS and obs-websocket versions, Node version, and the steps to reproduce. For security issues, see [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
