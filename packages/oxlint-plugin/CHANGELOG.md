# @typeonce/oxlint-plugin-effect-machine

## 0.31.3

## 0.31.2

## 0.31.1

## 0.31.0

## 0.30.0

## 0.29.0

## 0.28.0

## 0.27.1

## 0.27.0

### Minor Changes

- 74111e2: Add recommended rules that reject duplicate invocation identities, browser API access during planning, and nondeterministic time or randomness during planning.

  Strengthen `no-async-planning-callback` to detect direct Promise, fetch, timer, and scheduling operations, and extend `no-redundant-resolve` fixes to resolver-only reentry and empty targetless resolvers. Diagnostics now explain how to move work into state-owned invocations, pass external facts through input or events, or model sequential work with separate states.

## 0.26.2

## 0.26.1

### Patch Changes

- 99c237b: Fix the published plugin entrypoints so Oxlint loads built JavaScript instead of TypeScript source under `node_modules`.

  Upgrade from `0.26.0` without changing the Oxlint configuration. Both the package root and the recommended configuration now resolve to built files.

## 0.26.0

### Minor Changes

- 4130963: Add `@typeonce/oxlint-plugin-effect-machine` with recommended rules for redundant default resolvers, asynchronous planning callbacks, and one-use intermediate `Machine.make(...)` definitions.

  All three Effect Machine packages now release at the same version.
