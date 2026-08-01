# Project guidance

A core objective of the library is type safety and ease of use of the user-facing API, for both humans and agents.

The goal is eventually to merge this inside the core of the `effect` library, so plan changes according to the patterns and expectations of `effect`.

Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Feature verification workflow

Before implementing a feature, run:

```sh
pnpm perf:types
```

Record the type-performance results as the baseline for the feature.

After implementing the feature, run:

```sh
pnpm typecheck
pnpm perf:types
```

Compare the final type-performance results with the baseline. When reporting the completed work, include the before and after results and call out the additional type-instantiation cost of the feature, including regressions or improvements.
