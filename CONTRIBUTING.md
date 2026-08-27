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
public entrypoint -> public module -> process -> planner
                                      |          |
                                      v          v
                                    runtime     model
                                      |          |
                                      └-> errors <-┘
```

Internal machine modules may refer back to the public `Machine` types through
type-only imports. The runtime is intentionally unaware of the model, planner,
and process layers. Testing implementations are isolated under
`packages/effect-machine/src/internal/testing` and may only be consumed by the public testing module or
other testing internals.

`pnpm check:architecture` builds a TypeScript dependency graph using the
project's NodeNext resolver. It distinguishes type-only and runtime edges,
understands imports, re-exports, and dynamic imports, and enforces:

- public entrypoints do not leak internals;
- internal back-edges and layer dependencies keep their intended direction;
- production code does not depend on testing internals;
- black-box tests do not depend on implementation internals;
- production runtime imports are acyclic;
- private directories have no barrels or legacy `machine*` filenames.

The checker has executable fixture tests and runs as part of `pnpm check`. Add
new rules only with a failing fixture that demonstrates the boundary.

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
