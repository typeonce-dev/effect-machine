# @typeonce/effect-machine

External home for the schema-first Machine API proposed in
[Effect PR #6429](https://github.com/Effect-TS/effect/pull/6429). During
incubation this repository is the canonical implementation; the synchronization
tool keeps the Effect PR mechanically aligned without a second logic
implementation.

> Early-release software: APIs may change, and releases are coupled to an exact
> Effect beta.

## Installation

```sh
pnpm add @typeonce/effect-machine effect@4.0.0-beta.102
```

`effect` is an exact peer dependency, not a bundled runtime dependency. Consumers
must install `effect@4.0.0-beta.102`. Upgrading this package may require upgrading
Effect in lockstep; do not override the peer to another beta.

## Entrypoints

```ts
import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { ClusterMachine } from "@typeonce/effect-machine/cluster"
```

Each ESM entrypoint is independent and tree-shakeable. Importing the root does
not load the reactivity or cluster adapters.

## Basic machine

```ts
import { Effect, Schema } from "effect"
import { Machine } from "@typeonce/effect-machine"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Running extends Schema.TaggedClass<Running>("Running")("Running", {}) {}
class Start extends Schema.TaggedClass<Start>("Start")("Start", {}) {}

const states = Machine.defineStates({ Idle, Running })

const Counter = Machine.make({
  id: "Counter",
  states: states.states,
  events: [Start],
  initial: states.initial.Idle(new Idle())
}).handle({
  Idle: {
    on: {
      Start: ({ target }) => Effect.succeed(target.full.Running(new Running()))
    }
  }
})
```

The exported namespaces preserve the API, type identifiers, service keys,
semantics, and documentation of the Effect proposal.

## Development and validation

Use pnpm 10 and Node.js 20 or newer:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Individual commands are available for `build`, `test`, `test:types`,
`typecheck`, `format:check`, `test:consumer`, `test:sync`, `sync:check`, and
`pack:check`. Runtime tests use `@effect/vitest`; type tests use TSTyche and
TypeScript 6.0.3.

## Synchronizing Effect PR #6429

Make logic changes here first and run `pnpm check`. Then generate the mapped
production files, runtime tests, and type tests into a writable Effect checkout:

```sh
pnpm sync:effect -- /path/to/effect
```

The explicit mapping covers only the eight production files and six test files.
It rewrites package imports to Effect repository-relative `.ts` imports and
restores Effect's private `PipeInspectableProto` boundary. It never copies
package metadata, documentation, release files, or changesets.

Check an existing checkout without writing:

```sh
pnpm sync:effect -- --check /path/to/effect
```

Check mode exits non-zero on any drift. `pnpm test:sync` exercises generation,
a clean check, and drift detection in a disposable temporary directory. Never
generate into a checkout with work you have not reviewed. After generation,
inspect the Effect diff and run its targeted machine, reactivity, cluster, and
type-test validations followed by `pnpm check`.

The current source reference is branch `sandro/state-charts` in the Effect
repository. Exact dependency pins and the sync check are the proof boundary;
vendoring the rest of Effect is intentionally unnecessary.

## Releases

Add a changeset with `pnpm changeset`. CI validates frozen installation and the
complete check suite. The release workflow opens version PRs and publishes with
npm provenance through GitHub Actions.

Before the first release, create the `typeonce-dev/effect-machine` GitHub
repository and configure npm trusted publishing for the repository and
`.github/workflows/release.yml` environment. No npm token is intended.

When equivalent Machine modules ship in Effect, this package is intended to
become a thin compatibility re-export package before eventual retirement.
