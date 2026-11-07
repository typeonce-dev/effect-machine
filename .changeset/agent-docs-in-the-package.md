---
"@typeonce/effect-machine": minor
---

Ship agent documentation as `AGENTS.md`, `CLAUDE.md`, and `ai-docs/` in the package, replacing `docs/`.

An agent working in a project can now read documentation matching the installed version from `node_modules/@typeonce/effect-machine/AGENTS.md`. Replace links to `docs/agent-guide.md`, `docs/root-api.md`, `docs/effect-atom-react.md`, and `docs/machine-review.md` with that file, or with the matching section under `ai-docs/src`.
