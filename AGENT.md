# AGENT.md

This file exists for tools that look for singular `AGENT.md`.

The canonical agent instructions are in [AGENTS.md](/AGENTS.md). Follow that file first, then the rule documents under [docs/](/docs/).

This project is used across multiple machines. Do not encode machine-specific paths, package-manager state, or local runtime assumptions into repository files. Use the npm/package-lock workflow described in `AGENTS.md`.

When the user explicitly says "发布" / "publish" for a post, follow the one-command workflow in `AGENTS.md`: run `npm run post:release -- <post> --message "<commit message>"`, which publishes metadata, uploads images, validates, builds, commits, and pushes.
