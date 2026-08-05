# @typeonce/effect-machine

## 0.3.0

### Minor Changes

- 1d1f35f: Add fully typed shallow and deep history states. History targets restore schema-validated state values, support typed defaults before the first capture, require only the initializers needed by shallow restoration, preserve parallel configurations, and round-trip through snapshot encoding and decoding.
- e556e63: Add safe `.from` state construction to initial and transition target builders.
  Constructor inputs are resolved through the selected state schema during
  planning, preserving defaults and class identity while reporting validation
  failures as `MachineSchemaDecodeError` values.
- 3646067: Allow state builder `.from()` calls to omit the constructor input when the
  selected schema accepts `{}`. Required fields and compound or parallel child
  selection remain type-safe, and omitted inputs still run through schema
  construction during planning.

### Patch Changes

- 607a0c4: Allow local and branch targets to enter inactive nested parallel states. These
  targets now require a complete selection for every parallel region while
  preserving partial updates for parallel states that are already active.
- ea8e165: Improve compile-time diagnostics for invalid state definitions, event protocols,
  and handler configurations. Errors now retain the relevant configuration shape
  and state path while preserving existing inference and type safety.
- 955663f: Preserve every machine protocol channel when creating bound AtomMachine bridges from deeply composed handled machines. Inline invoked children also retain their exact error, service, event, and output types instead of inheriting erased contextual `any` channels.

## 0.2.0

### Minor Changes

- 1a4a68f: Separate public commands from machine-local events with typed `events` and
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
