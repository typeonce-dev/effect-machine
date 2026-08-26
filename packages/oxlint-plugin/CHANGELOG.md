# @typeonce/oxlint-plugin-effect-machine

## 0.26.1

### Patch Changes

- 99c237b: Fix the published plugin entrypoints so Oxlint loads built JavaScript instead of TypeScript source under `node_modules`.

  Upgrade from `0.26.0` without changing the Oxlint configuration. Both the package root and the recommended configuration now resolve to built files.

## 0.26.0

### Minor Changes

- 4130963: Add `@typeonce/oxlint-plugin-effect-machine` with recommended rules for redundant default resolvers, asynchronous planning callbacks, and one-use intermediate `Machine.make(...)` definitions.

  All three Effect Machine packages now release at the same version.
