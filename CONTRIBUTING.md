# Contributing

This project generally does not accept unsolicited pull requests. Open an issue first describing the problem or use case and, for API changes, the public API you want to add or change.

Wait for the proposal to be discussed and accepted before starting an implementation or opening a pull request. Pull requests without prior agreement may be closed.

## Repository architecture

The source tree follows Effect's public-module/internal-implementation split:

```text
packages/effect-machine/src/
├── Machine.ts
├── index.ts
├── testing/
├── unstable/
└── internal/
    ├── machine/
    └── testing/machine/
```

Public entrypoints and public modules use Effect-style names. Private files sit
under the domain they implement and use responsibility names such as
`planner.ts`, `process.ts`, and `runtime.ts`; they do not repeat `machine` in
every filename. Runtime tests mirror the same domains. Tests below
`packages/effect-machine/test/internal/` are the only white-box suites allowed to import `packages/effect-machine/src/internal`.

The core dependency direction is:

```text
public entrypoint -> Machine -> model and planner <- process <- LocalMachine
                                        |               |
                                        v               v
                                      errors  <----  runtime
```

`Machine` is the model. It declares machines, plans their steps, and defines the
contracts their types mention, and it imports nothing from a host, not even a
type. A host runs the model: `LocalMachine` in memory, `AtomMachine` by hosting a
local machine in an Atom registry, and `ClusterMachine` as a persisted entity,
without the local runtime.

Internal machine modules may refer back to the public `Machine` types through
type-only imports. The runtime is intentionally unaware of the model, planner,
and process layers. Testing implementations are isolated under
`packages/effect-machine/src/internal/testing` and may only be consumed by the public testing module or
other testing internals.

`implementation.ts` owns the captured handler representation. `.handle`
captures the declarations of each state as executable transitions, and semantic
layers use `toImpl` to read them instead of treating the erased public machine as
`any`.

Runtime responsibilities are separated as follows:

- `process.ts` compiles machine definitions into process logic, for roots and for
  child machines, and implements `LocalMachine`.
- `runtime.ts` allocates a root runtime and selects an execution strategy. It is
  bound to a function that builds the logic of a child machine, because child
  descriptors hold no process logic.
- `runtimeProtocol.ts` owns shared process contracts, child ownership, mailboxes,
  and observation. It receives startup functions from the coordinator so child
  startup does not create a dependency back to either execution strategy.
- `runtimeGeneric.ts` runs the general Effect worker and supervisor.
- `runtimeCompiled.ts` runs compiled statecharts, including synchronous owned
  child startup. It preserves the same lifecycle contract as the generic runtime.

Consumers import directly from the module that owns a contract. Runtime modules
must remain independent of planning and statechart semantics. The Cluster adapter
similarly shares its checkpoint service and wire schemas through `clusterProtocol.ts`.

`pnpm check:architecture` builds a TypeScript dependency graph using the
project's NodeNext resolver. It distinguishes type-only and runtime edges,
understands imports, re-exports, and dynamic imports, and enforces:

- public entrypoints do not leak internals;
- internal back-edges and layer dependencies keep their intended direction;
- the model and the Cluster host do not depend on the local runtime, directly or
  transitively, including through type-only imports;
- production code does not depend on testing internals;
- black-box tests do not depend on implementation internals;
- production runtime imports are acyclic;
- private directories have no barrels or legacy `machine*` filenames.

The checker has executable fixture tests and runs as part of `pnpm check`. Add
new rules only with a failing fixture that demonstrates the boundary.

## Add a host

A host is anything that runs a machine: `LocalMachine`, `AtomMachine`,
`ClusterMachine`. The conformance suite under
`packages/effect-machine/test/conformance` writes each scenario once and runs
it on every host. To add one:

1. Implement `Host` from `test/conformance/support/host.ts` under
   `test/conformance/support/hosts`. A host that needs library internals goes
   under `test/internal/machine/support` instead.
2. Give each instance its `Scheduling`: `settle`, which lets everything happen
   that does not wait for time, and `advance`, which lets time pass. The suite
   assumes no scheduler and no clock of its own. A host that runs on fibers and
   the `TestClock` takes `fiberScheduling`; a host with its own task queue or
   timers implements both.
3. Declare its `Capabilities`. They are the only reason a scenario skips a
   host, so declare what the host can do.
4. Add it to `hosts` in `HostConformance.test.ts`, run
   `pnpm vitest run test/conformance` in the package, and read the change to
   `matrix.txt` (update it with `-u`).
5. A failing scenario is a bug of the host, unless users are told about the
   difference. Record a documented difference as a `Deliberate` entry in
   `differences.ts`, with the sentence of the documentation that promises it,
   and an undocumented one or a known bug as an `Open` entry with its
   evidence.

A new host lives in its own module, depends on `Machine` and not on the local
runtime when it can (`pnpm check:architecture` enforces this for Cluster), and
documents what it runs, what it refuses, and how its guarantees differ from
`LocalMachine`.

## TypeScript compatibility

The repository toolchain uses TypeScript 6. TypeDoc, tstyche, and the
repository scripts load its JavaScript compiler API, so the root `typescript`
dependency stays on 6.x.

`pnpm check` also verifies the native TypeScript 7 compiler. The private
`tooling/typescript-7` workspace package pins it in its own `node_modules`, so
its `tsc` binary never replaces the TypeScript 6 `tsc` used by the root and the
publishable packages:

- `pnpm typecheck:ts7` type-checks every package project and
  `tsconfig.tests.json` without emitting. Run it after `pnpm typecheck` or
  `pnpm build`, because package references resolve to the TypeScript 6
  declaration output.
- `pnpm test:consumer` compiles the packed consumer fixture with TypeScript 6
  and then with TypeScript 7. Set `TSGO_BIN` to an executable native compiler to
  check another TypeScript 7 build.

Type tests run only with TypeScript 6: tstyche 7.2 selects targets from
TypeScript 5.4 up to, but not including, 7.0, because TypeScript 7 does not
provide the in-process compiler API that tstyche uses. TypeScript 7 still
compiles the public types through the package projects and the runtime tests,
but type assertions are evaluated only with TypeScript 6.

## Formatting and linting

`pnpm format` formats the repository with dprint, as Effect does. `pnpm lint`
builds the local `@typeonce/oxlint-plugin-effect-machine` package and runs
Oxlint with the configuration in `.oxlintrc.json`. Both run as part of
`pnpm check`.

Type-aware rules run through `oxlint-tsgolint`, which reads each file's nearest
tsconfig. The root `tsconfig.json` references `tsconfig.tests.json` so tests get
the repository's compiler options. Type tests, type-performance fixtures, and
scripts belong to no tsconfig and skip type-aware rules.

The repository's own Effect Machine rules check the devtools example machines
and the machine fixtures under `packages/effect-machine/test`. Fix a finding
rather than suppressing it. When code must keep the reported pattern, for
example a cast that TypeScript 6 requires but the TypeScript 7 checker used by
`oxlint-tsgolint` does not, suppress only that line and give the reason:

```ts
// oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- TypeScript 6 infers `readonly string[]` without it.
```

## API reference data

`pnpm docs:api` generates an Effect-compatible TypeDoc dataset under
`.data/api-reference/v4`. The dataset contains a top-level manifest, a package
manifest, and one checksummed reflection JSON file per module configured in
`api-reference.config.json`. Generated data is not committed.

`pnpm docs:api:check` runs the API reference unit tests, generates the complete
dataset in a temporary directory, validates its manifests and checksums, and
ensures every reflection can be consumed by the site-facing normalizer. It runs
as part of `pnpm check`.

`pnpm docs:site` turns that dataset into a multi-page static website under
`.data/api-reference-site/v4` and creates its Pagefind search index.
Generate the devtools example-machine gallery under the isolated
`.data/api-reference-site/v4/devtools` route after building the main site:

```sh
pnpm docs:site
pnpm devtools build \
  --root ../.. \
  --include "packages/devtools/src/internal/browser/{example-machine,*-example}.ts" \
  --out-dir ../../.data/api-reference-site/v4/devtools
```

Run `pnpm docs:site:serve` to preview the main site at
`http://127.0.0.1:4173/` and the gallery at
`http://127.0.0.1:4173/devtools/`. Site output is generated data and is not
committed.

The release workflow calls the GitHub Pages workflow after Changesets publishes
a package. The Pages workflow can also be run manually to deploy the current
commit before a release without invoking the package-release job. It uploads the
combined output, keeping the API reference at the Pages root and the devtools
gallery under `/devtools/`. Pages supplies
`API_REFERENCE_BASE_PATH` during the build so project URLs and custom domains
use the same generated site without configuration edits. It also reads the
repository star count through GitHub's API and supplies it as
`API_REFERENCE_GITHUB_STARS`, keeping the deployed badge independent of
browser-side API access.
