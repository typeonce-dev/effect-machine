# AI docs

`LLMS.md` is generated from `ai-docs/src`. Each build copies it into the core package as `AGENTS.md` and `CLAUDE.md`, next to a copy of `ai-docs`, so an installed package carries documentation matching its version.

## Add content

1. Add or update markdown in `ai-docs/src/**/index.md` for section text. Top-level sections start at `##`.
2. Add complete examples as `.ts` files in the same folder. `pnpm typecheck` compiles them.
3. Run `pnpm ai-docgen` to regenerate `LLMS.md`. `pnpm ai-docgen:check` fails when it is stale.

## Source file conventions

- Numeric filename prefixes control ordering. A `.ts` file starting with `0` is inlined into `LLMS.md`; any other is linked.
- A top JSDoc block with `@title` and an optional description sets the rendered title and description.
- `fixtures` directories are ignored.
- Link between sections with anchors, such as `[Root machine API](#root-machine-api)`, because every section ends up in one document.

Examples must represent real usage and explain the how and why in comments.
