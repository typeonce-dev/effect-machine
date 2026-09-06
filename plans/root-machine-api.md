# Root machine API implementation

This branch implements the agreed root-based public model. The milestones below
are implementation checkpoints, not compatibility APIs or separate releases.

## Contract

- Every machine has one explicit root descriptor. `Machine.make({ root })`
  replaces the public top-level state map constructor.
- The root uses the empty absolute path. Its children retain paths such as
  `Editing` and `Editing.Form`; no artificial path prefix is introduced.
- Root snapshots participate in the same atomic, compound, and parallel snapshot
  model as every other active node. A root value is never an optional path lookup.
- `Machine.state` captures an immutable descriptor with typed snapshot helpers.
  Nested nodes may be inline. `fields` generates a tagged schema; `schema` reuses
  an existing schema unchanged. The two properties are mutually exclusive.
- Root initialization follows declared defaults. Explicit configuration
  construction remains separately named. Required root and descendant values
  must be supplied before a machine becomes executable.
- Root handlers are passed directly to `handle`. An implemented machine cannot
  be handled again. Root work is scoped to the root and survives child changes.
- `self.update` replaces the handler owner's value. Retained ancestor updates
  and coordinated destination/owner updates preserve existing atomicity and
  conflict semantics. No partial merge or implicit sequential parallel writes.
- Direct target `from` and `decoded` take callbacks. Complex resolvers retain
  explicit builders and queued commands. Guards decline with ancestor fallback.
- Named branches retain `target` and optional `title`.
- Public, internal, and emitted protocols remain distinct. Local field records
  and explicitly imported schemas produce deferred, validated constructors.
- Atom bridges expose `result` and `snapshot`, with no separate `state`
  projection. React ownership, registry identity, and child inactivity persist.
- Tests accept production event construction inputs and record decoded events.
- Cluster retains ownership of distributed identity and delivery.

## Stage 1: contract and inference — implemented

Prove root definitions, field/schema construction, root and child values,
initialization, ownership-aware targets, and invalid compositions with focused
type cases. Compare the model against Effect schemas and immutable descriptors.

## Stage 2: execution and migration — implemented

Implement the root in the generic planner and optimized strategies; migrate
runtime, snapshots, codecs, child lifecycles, testing, and integration boundaries.
Cover targetless/reentering transitions, parallel conflicts, raised events,
completion, invocations, and retained snapshots differentially.

## Stage 3: authoring and React — implemented

Complete direct protocols, fields, construction methods, guards, React state
rendering and context ownership; migrate examples and documentation; remove
deprecated aliases and update the public reference. Optional new testing DSLs
are not part of this work.

## Resolved contracts

- Reusing `machine.root` carries topology and schemas, never another machine's
  explicit startup override or its initialization proof.
- Default constructors use schema make defaults when the complete make input
  can be omitted. Required active descendant values still require an initializer.
- A compound executable root forwards its completed direct workflow's output
  unless that workflow handles completion itself. Nested compound completion
  continues to require a direct final child; parallel roots wait for all regions.
- History beneath a retained root preserves current root data. Root history can
  restore the root's own data. Encoded snapshots use version 2 and reject version 1.
- Final state values cannot be updated. Root and active owner updates replace the
  whole value and never implicitly reenter or restart scoped work.
- React providers own startup identity. Changing input props does not restart a
  machine; a new key does. Inactive selected paths remain optional and startup
  failures reach the React error boundary.
- Recursive builder and selector types have explicit variance where their
  contracts require it. Existing type-performance budgets remain unchanged.

## Release gate

Run `pnpm check`, `pnpm perf:types`, and `pnpm perf:runtime`. Inspect CI
base-versus-branch performance and memory reports. Add a minor changeset and
complete the PR template. Merge only a current branch with every required check
green, then verify the remote merge and feature-branch deletion.
