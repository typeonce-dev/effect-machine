# Project guidance

A core objective of the library is type safety and ease of use of the user-facing API, for both humans and agents.

The goal is eventually to merge this inside the core of the `effect` library, so plan changes according to the patterns and expectations of `effect`.

Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Effect internal standards

- Before introducing an internal abstraction or protocol, inspect the analogous implementation under `references/effect` and follow its naming, module-boundary, and ownership conventions where they apply.
- Keep public modules declarative and route implementation through `src/internal`. Preserve directed dependencies and avoid internal barrel modules.
- Give optimized planners and runtimes explicit contracts and ownership boundaries. Do not hide mutable state behind readonly types or retain caller-owned mutable containers in cached structures.
- Treat the generic planner/runtime as the semantic reference. Optimized strategies must fail closed: a new capability uses the generic path until its optimized semantics are implemented deliberately.
- Keep casts at genuine erased boundaries only. Prefer narrower internal representations, explicit invariants, and exhaustive capability checks over broad `any`-based protocols.
- For every optimized semantic change, add forced generic-versus-optimized differential coverage and a focused regression test. Include relevant edge cases such as targetless and reentering transitions, simultaneous transitions, raised events, completion, invocation, and retained snapshots.
- Put public behavioral tests under `test/` and implementation-strategy tests under `test/internal/`. Tests should establish observable semantics, not mirror implementation details.
- Treat correctness, type safety, and benchmark regressions as blockers. Do not recover performance by weakening semantics or public inference.

## Verification

Run:

```sh
pnpm check
```

For changes that can affect the public TypeScript API or its inference, also run:

```sh
pnpm perf:types
```

For changes to planning, runtime execution, machine construction, or another hot path, also run:

```sh
pnpm perf:runtime
```

Use the pull request performance workflows to compare against the base branch; do not draw conclusions from a single noisy benchmark run. Record the relevant checks and performance result in the pull request.

When an example changes, run its own check from the example directory:

```sh
pnpm check
```

Every package directly below `examples/` must have a `check` script and a committed lockfile.

## Pull request conventions

- Add or update a changeset for changes under `src/` or changes to `package.json`, following the changelog-writing guide in `.changeset/README.md`.
- Fill in the pull request template, including the validation performed and the changeset decision.
