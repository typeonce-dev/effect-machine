# Effect Machine

This repository is the pnpm workspace for Effect Machine and its development tools.

- [`@typeonce/effect-machine`](./packages/effect-machine/README.md) contains the machine runtime, testing modules, and documentation.
- [`@typeonce/effect-machine-devtools`](./packages/devtools/README.md) contains the publishable local machine visualizer and CLI.
- [`@typeonce/oxlint-plugin-effect-machine`](./packages/oxlint-plugin/README.md) checks Effect Machine models for common structural mistakes.

All three packages use the same version. Install matching versions so the runtime, devtools, and lint rules stay aligned.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for repository development and validation commands.
