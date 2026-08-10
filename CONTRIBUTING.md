# Contributing

This project generally does not accept unsolicited pull requests. Open an issue first describing the problem or use case and, for API changes, the public API you want to add or change.

Wait for the proposal to be discussed and accepted before starting an implementation or opening a pull request. Pull requests without prior agreement may be closed.

## Repository architecture

The source tree follows Effect's public-module/internal-implementation split:

```text
src/
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
`test/internal/` are the only white-box suites allowed to import `src/internal`.

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
`src/internal/testing` and may only be consumed by the public testing module or
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
