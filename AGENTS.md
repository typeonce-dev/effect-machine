# Project guidance

Effect Machine is intended to become part of the core `effect` library. Treat that as an architectural requirement: public APIs, failures, module boundaries, ownership, and implementation patterns must meet Effect's standards and fit its general API shape.

## Product priorities

Apply these priorities in order:

1. **Type safety.** Make invalid states, events, compositions, references, and capabilities unrepresentable at compile time whenever possible. Preserve typed Effect failures at runtime; validation must not escape as an accidental throw.
2. **Explicit, opinionated semantics.** Similar concepts need distinct names and contracts. Do not hide a material semantic choice behind an omission, permissive overload, or ambiguous default. Convenience should come from builders and inference, not weaker boundaries.
3. **Readable, concise models.** A human should be able to read a machine definition from top to bottom and understand its protocols, topology, behavior, and effects. Prefer declarative builders and eliminate raw schema plumbing, duplicated declarations, and incidental ceremony. Concision must not obscure intent.
4. **Effect-core alignment.** Follow Effect naming, failure, `Scope`, `Stream`, service, module, and ownership conventions. Inspect analogous implementations under `references/effect` before designing a new abstraction.

When compatibility, convenience, concision, and semantic clarity conflict, prefer type safety and semantic clarity. Then optimize the resulting API for readable models. Make architectural decisions for the long term; do not accept a stopgap intended to be replaced later.

## Experimental versioning

- The library is experimental and pre-1.0. Public additions and breaking API changes use a minor changeset; compatible fixes and implementation improvements use a patch changeset. Do not create major changesets before 1.0.
- `@typeonce/effect-machine`, `@typeonce/effect-machine-react`, `@typeonce/effect-machine-devtools`, and `@typeonce/oxlint-plugin-effect-machine` release from one Changesets fixed group and must always have the same version. Keep their package versions, workspace dependencies, and release configuration synchronized so users can install matching versions for compatibility.
- Backward compatibility is not currently a design goal. Change or remove an existing API whenever a clearer, safer, smaller long-term design replaces it.
- Do not add deprecated aliases, compatibility wrappers, or parallel APIs solely to preserve an inferior existing design unless the user explicitly requests them.
- Explain the resulting API and direct migration in changesets. Do not use changelog entries to credit an external library or narrate implementation history.

## Effect and Cluster boundaries

- Effect Machine owns declarative state modelling, typed machine protocols, local machine references, child lifecycles, execution, and observation.
- Effect Cluster owns distributed identity, placement, discovery, transport, routing, delivery, sharding, and remote lifecycle semantics. Do not recreate those capabilities in the core machine API.
- Before exporting a new name or capability, inspect Effect's public modules and the relevant implementation under `references/effect`, with explicit attention to Cluster. Avoid names that already carry a different Cluster meaning, especially actor-, entity-, shard-, node-, and distributed-reference terminology.
- Reuse Cluster terminology only when the semantics genuinely match and the integration is intentional and documented. Do not introduce a local lookalike with a different contract.
- Keep necessary Cluster integration behind an explicit adapter or integration module. Do not leak distributed concerns into the local machine model.

## Effect internal standards

- Before introducing an internal abstraction or protocol, inspect the analogous implementation under `references/effect` and follow its naming, module-boundary, and ownership conventions where they apply.
- Keep public modules declarative and route implementation through `packages/effect-machine/src/internal`. Preserve directed dependencies and avoid internal barrel modules.
- Give optimized planners and runtimes explicit contracts and ownership boundaries. Do not hide mutable state behind readonly types or retain caller-owned mutable containers in cached structures.
- Treat the generic planner/runtime as the semantic reference. Optimized strategies must fail closed: a new capability uses the generic path until its optimized semantics are implemented deliberately.
- Keep casts at genuine erased boundaries only. Prefer narrower internal representations, explicit invariants, and exhaustive capability checks over broad `any`-based protocols.
- For every optimized semantic change, add forced generic-versus-optimized differential coverage and a focused regression test. Include relevant edge cases such as targetless and reentering transitions, simultaneous transitions, raised events, completion, invocation, and retained snapshots.
- Put public behavioral tests under `packages/effect-machine/test/` and implementation-strategy tests under `packages/effect-machine/test/internal/`. Tests should establish observable semantics, not mirror implementation details.
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

## Pull request conventions

- Add or update a changeset for changes under `packages/effect-machine/src/` or changes to a publishable package manifest, following the changelog-writing guide in `.changeset/README.md`.
- Fill in the pull request template, including the validation performed and the changeset decision.
