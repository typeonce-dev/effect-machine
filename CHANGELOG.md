# @typeonce/effect-machine

## 0.4.0

### Minor Changes

- d02dacb: Add an Effect-native `@typeonce/effect-machine/testing` entrypoint with schema-derived scenarios, replayable planner traces, independent statechart law and finite-model verification for compound, parallel, and history states, trace coverage, observed Effect graphs, and live runtime command models.

  Expose retained planner transition evidence and correct reentry boundaries, simultaneous parallel target application, and recorded nested-history restoration through inactive ancestors.

  Model finite transitions through one discriminated `event | always | done` trigger representation, with independent stabilization, completion ordering, cycle detection, generated mixed-trigger models, managed-runtime differential checks, and activity-lifecycle command verification. Hand-authored finite models now migrate event transitions from `{ source, event, ... }` to `{ source, trigger: { type: "event", event }, ... }`.

- 4d6e7b0: Replace Effectful state transition, lifecycle, choice, history, and initial
  callbacks with a synchronous `(state, event) => [nextState, commands]` core.
  Callbacks may enqueue only typed `raise`, `emit`, `sendTo`, and `stop`
  operations; asynchronous work remains available through invoked Effects,
  actors, and child machines.

  Remove `Machine.action`, `Machine.runtime`, and `Machine.runActions`. Planning
  now returns closed actor `commands`, while managed runtimes execute those
  commands around state publication and typed emission delivery.

- f8fa4e3: Add first-class logical snapshot resumption with `Machine.resume`, plus lazy
  `AtomMachine.resume` and bound-runtime integration. Resumed machines validate
  decoded snapshots, preserve logical history and completion metadata, and create
  fresh managed invokes, children, scopes, and timers without replaying historical
  statechart work.
- 6809080: Add public getters for inspecting compiled state nodes, registered transition handlers, declared transition targets, and the active state configuration of a snapshot. Event, eventless, and completion handlers may declare an upper bound of target paths that is checked against inferred and runtime results.

  Represent compiled state-node inspection as a six-way discriminated union so atomic, compound, parallel, final, history, and choice metadata narrow without impossible field combinations.

- 2e45e12: Expose a captured full machine snapshot to event, eventless, and completion transition contexts; add serializable state-owned activity inspection for invokes, timers, and child machines; and surface resolved Effect Schema annotations plus descriptive pseudo-state annotations through state-node inspection.
- 1312de1: Add first-class, type-safe choice pseudo-states with Effectful resolvers,
  inspectable target bounds, stable-snapshot exclusion, and MachineTest trace,
  coverage, verification, generated-model, and reference-model support.

### Patch Changes

- 5656f41: Fix first-use nested history defaults by requiring a complete source-independent configuration containing the history owner and using it to rebuild inactive compound and parallel ancestors.
- 69f1c20: Reuse the validated statechart configuration while draining queued event batches, avoiding repeated snapshot normalization without retaining the cache while a machine is idle. Canonicalize history snapshot paths in machine document order so batched and public planning produce identical snapshots.
- 8151b3a: Suspend compiled statechart workers while their mailboxes are idle and start an
  on-demand drain when an event arrives. This reduces retained heap for idle
  machines and invoked families without changing event ordering, terminal
  arbitration, or the public machine API.
- 74362e3: Skip child-registry allocation for statecharts that cannot invoke child processes, while preserving empty child lookup, observation, send, and stop behavior.
- d602202: Compact running machine workers into a single generator loop and allocate emitted-event runtime closures only when a machine emits, reducing idle heap and improving event throughput without changing scheduler yield semantics.
- 80b3e73: Compact invoked-child session bookkeeping into an atomic runtime table, reducing parent and child lifecycle overhead without changing invoke ordering or race protection.
- 1350f10: Run compiled statecharts and their invoked machine children with a single process fiber, reducing lifecycle overhead and idle memory while preserving the general `Machine.logic` runtime contract.
- ad55919: Remove the library-owned eight-level handler-tree inference ceiling. Nested
  handler validation and accumulated state, error, service, choice, history, and
  output evidence now continue until TypeScript's normal compiler limits.
- 1aa746c: Deliver invoked child snapshots directly from the child runtime, removing the replay PubSub and watcher fiber previously retained by every snapshot-mapped invocation.
- 381cfe3: Reduce invoked-child memory and lifecycle overhead by delivering terminal outcomes directly through process supervision and allocating a watcher fiber only for invokes that map active child snapshots.
- 995bb3b: Let the Effect runtime scheduler control cooperative yielding while draining machine event bursts, preserving runtime scheduler configuration and avoiding a forced scheduler turn after every event.
- 757c10c: Add local and pull request runtime benchmark reporting for pure planning, end-to-end event drainage, machine lifecycle throughput, and idle-machine memory growth against the compiled package, XState 5, and the published XState 6 alpha.
- c6575bc: Reduce runtime planner allocation overhead by reusing compiled schema decoders and state topology paths, deferring effect service allocation until it is needed, and avoiding unused snapshots.
- e60b9d7: Update the required Effect runtime and development integration from `4.0.0-beta.102` to `4.0.0-beta.105`.
- 3848b9b: Allocate child process scopes and observable child registries only when a machine uses child-management capabilities.
- 7ccfe10: Allocate change-observation resources only when a machine's `changes` stream is first consumed, while preserving snapshot replay, terminal completion, and the existing `MachineRef` API.
- 7c8d86c: Reduce the memory retained by running machines by consolidating process termination into a single supervisor signal.
- fd64615: Reduce managed runtime memory and lifecycle overhead by removing redundant process coordination state, reusing the live runtime service, and allocating invoke management only for machines with invoke definitions.
- 73c1e6d: Reduce child-machine ownership memory by consolidating supervision and registry state, tracking anonymous children without per-child scope finalizers, and allocating child observation resources only when consumed.
- d3dc770: Store compiled machine snapshots in an owner-only mutable reference while
  retaining atomic terminal reservation and lazy observation. This reduces
  transition overhead and idle heap without changing the public API, event
  ordering, or terminal behavior.
- 9eac202: Harden machine execution and definitions while preserving the existing Effect-native API. Self-stop now uses supervisor-owned terminal arbitration without initialization or worker deadlocks; execution adapters consistently reject incomplete output, history, and choice implementations; finite-union event tags narrow correctly; and machine guards verify the runtime brand value.

  State definitions now reject unknown node properties and unsafe state keys at compile time and runtime with path-local diagnostics. Add deterministic lifecycle, adversarial snapshot-codec, type-performance, activity-lifecycle, and planner-versus-runtime verification coverage.

- fc08038: Harden planning, snapshot round trips, and logical runtime resumption for valid typed machines. Initial choices no longer retain abandoned roots, history fallbacks resolve nested choices before snapshot normalization, and the independent finite-model oracle follows nested choice initializers.

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
