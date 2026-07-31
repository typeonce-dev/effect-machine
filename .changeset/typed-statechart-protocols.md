---
"@typeonce/effect-machine": minor
---

Separate public commands from machine-local events with typed `events` and
`internalEvents` protocols, unique-tag validation, and public-schema validation
for Cluster delivery.

Move finality entirely into state definitions. This is a breaking API change:
remove `type: "final"` from handlers and declare final states and output schemas
with `Machine.defineStates`. Handler `context.action` is also removed in favor
of the single canonical `Machine.action` staging API. Planning and execution
now require an output implementation for every declared output schema and
expose discriminated, schema-derived terminal results.

Add typed helpers for one-shot Effects, timers, staged actions with a returned
transition value, state retagging, immediate parents, and identity-safe invoked
child addressing. Add bound Atom runtime factories, fail-aware results,
equality-aware selectors, and reactive child bridges, while tightening startup
and protocol error types. Protocol schemas are owned by each machine and rely
on Effect's schema parser memoization instead of package-level cache registries.
Reactive child bridge identity uses Effect's standard `Atom.family` primitive.
Atom selectors now infer exact state paths and values from their bridge snapshot
and no longer require a separate `DefinedStates` argument.

Match child descriptors by id and machine identity, and split the old overloaded
child constructor:
use `Machine.child(id, machine)` for complete statecharts and
`Machine.childAddress<Event>(id)` for lower-level process addresses.
`Machine.invoke` now separates its lifecycle `id` from an explicit typed
`address`. Remove the direct `AtomMachine.make(runtime, machine)` overload in
favor of `AtomMachine.bind(runtime).make(machine)`, and make the default child
Atom startup-error channel `unknown`.
