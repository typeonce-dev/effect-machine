# @typeonce/effect-machine

## 0.27.1

## 0.27.0

## 0.26.2

## 0.26.1

## 0.26.0

### Minor Changes

- 4130963: Add `@typeonce/oxlint-plugin-effect-machine` with recommended rules for redundant default resolvers, asynchronous planning callbacks, and one-use intermediate `Machine.make(...)` definitions.

  All three Effect Machine packages now release at the same version.

### Patch Changes

- 806d2fd: Upgrade the exact Effect peer dependency and companion Effect packages to `4.0.0-rc.112`.

## 0.25.0

## 0.24.0

### Minor Changes

- eda432c: Add planner-backed simulation sessions to the web visualizer. Machine and event inputs are rendered as fields from their Effect schemas, including type and constraint metadata, nested objects, arrays, unions, enums, literals, booleans, strings, and numbers. Browser constraints provide immediate feedback, while authoritative Effect Schema failures are mapped back to their fields. Each isolated step uses the real Effect Machine planner and shows selected branches, concrete topology changes, raised and emitted events, planned commands, completion, and output as a structured trace.

  Expose `Machine.inputEventSchemas` so inspection tools can describe or construct valid public events without reaching into the opaque event protocol. Planning evaluates synchronous statechart callbacks but does not commit commands or start runtime activities. Schema and planning failures remain visible beside the machine topology.

## 0.23.0

### Patch Changes

- f90b37d: Move the published package into an Effect-style workspace without changing its public exports.
- f90b37d: Release `@typeonce/effect-machine` and `@typeonce/effect-machine-devtools` at the same version. Install matching versions so the devtools inspection protocol and machine model remain compatible.

## 0.22.0

### Minor Changes

- 6d080f5: Make state construction modes explicit and allow one topology target to replace a retained valued owner atomically.

  Valued builders are no longer callable. Replace `target(value)` and nested `builder(value, ...)` calls with `.decoded(value, ...)`; keep `.from(input, ...)` for schema make input. Plain state-update resolvers now expose the decoded owner as `current` and its construction builder as `owner`, replacing the previous `ancestors` plus `target` pattern.

  Declare a combined transition with `.updating(ownerSelector)`. The resolver must finish destination construction with `.update(...)`, so the owner replacement cannot be omitted:

  ```ts
  to.local
    .SavingPlan()
    .updating(to.branch.Ready)
    .resolve(({ current, owner, target }) =>
      target
        .from({ request })
        .update(owner.decoded(new Ready({ ...current, notice: null })))
    );
  ```

  Transition inspection and retained microsteps now include an `updates` array naming replaced owners.

## 0.21.0

### Minor Changes

- 473aa78: Add `to.local.update(...)` and `to.branch.<path>.update(...)` for replacing an active compound or parallel state's value without reconstructing its active descendants.

  Updates accept decoded values through `target(value)` or schema make input through `target.from(input)`. They preserve descendant configuration and state-owned work by default, support named branches and declinable resolvers, and expose the updated owner through transition inspection.

## 0.20.0

### Minor Changes

- 782c6ba: Add process-owned child machine spawning for runtime-sized child sets.

  Use `Machine.childFamily(machine)` to bind a child machine once, then call
  `children.spawn(Family(id), { input })` inside an invoked Effect. Successfully
  started children survive owner state changes and remain addressable through
  machine references and `AtomMachine` until they stop or their parent stops.

  `Logic.Scope.spawn` accepts the same child descriptors for lower-level process
  logic. Dynamic spawn calls retain child input, startup failure and service
  inference, and check the child's declared parent protocol.

## 0.19.1

### Patch Changes

- 9377142: Upgrade the exact Effect peer dependency and companion Effect packages to `4.0.0-rc.111`.
- 3348d88: Add focused guides for statechart modeling and Effect Atom ownership in React applications, and publish the statechart guide on the documentation website.

## 0.19.0

### Minor Changes

- b1a1f75: Make `Machine.encodeSnapshot` return a canonical JSON representation or fail
  with `MachineSchemaEncodeError`. Encoded state values, completion outputs, and
  history values are now typed as `Schema.Json`; rich schema values use their
  canonical JSON codecs, while cycles and other non-JSON values fail at the
  machine boundary instead of causing a later serialization crash.
  Declared `Schema.Void` and `Schema.Undefined` completion outputs now use their
  canonical `null` encoding; an omitted output is reserved for final states that
  do not declare an output schema.

  `ClusterMachine.make` now requires JSON-encoded state, completion-output, and
  public input-event schemas. Keep process-local capabilities in services,
  adapters, or internal events, and give transported values an explicit JSON
  codec. Cluster snapshot encoding failures are reported as
  `SnapshotEncodeFailure` without advancing the checkpoint.

  `MachineTest.observedGraph` continues to support process-local state. Its node
  `encoded` field is now optional: portable snapshots retain their canonical JSON
  form, while non-portable snapshots use local structural identity and omit it.
  Snapshot encoding failures no longer appear in the operation's error channel.

### Patch Changes

- 928017e: Upgrade the exact Effect peer dependency and companion Effect packages to `4.0.0-rc.110`.
- f4f9bdf: Document the nested configuration and callback APIs used by `Machine.states`, event protocols, `Machine.make`, `Definition.handle`, execution, transitions, and state invocation.

  The documentation site now presents those core authoring APIs on a standalone guide-reference page while keeping module pages focused on public exports. Parameters remain grouped under their point of use with searchable signatures, lifecycle contexts, target semantics, defaults, source links, focused examples, and a complete nested page outline. Redundant configuration headings are omitted, and each parameter is presented as a named API block with its signature, description, and attached source link. Long signatures stay contained within their documentation blocks across responsive layouts.

## 0.18.0

### Minor Changes

- 9e54de3: Add consumer-facing state and startup-input extractors. `Machine.Snapshot`, `Machine.Value`, and `Machine.SnapshotAt` accept either the object returned by `Machine.states` or a machine definition, while preserving exact path validation and excluding control-only paths from `Value`.

  `Machine.Machine.Input<M>` now extracts the decoded startup value and is `never` when the machine uses `Schema.Void`. Code that needs the startup schema should migrate from `Machine.Machine.Input<M>` to `Machine.Machine.InputSchema<M>`; code that previously used `Machine.Machine.Input<M>["Type"]` can use `Machine.Machine.Input<M>` directly.

- d6d19c1: Replace `Machine.invoke` and its object-configuration helper types with state-local fluent invocation chains. Select an Effect, Stream, timer, process logic, or child from the handler's `from` parameter, then handle every reachable lifecycle channel before returning the chain:

  ```ts
  machine.handle({
    Loading: {
      invoke: (from) =>
        from
          .effect("load", () => loadUser())
          .onDone((to) => to.full.Ready())
          .onFailure((to) => to.full.Failed()),
    },
  });
  ```

  Return an array of completed chains for multiple activities. Sources and child descriptors remain reusable, while keeping the invocation declaration local preserves exact owner-state, event, parent, output, failure, element, snapshot, and service inference.

## 0.17.0

### Minor Changes

- 600149b: Make owning-machine requirements explicit and statically safe. Declare `parent: Machine.parent(ParentEvents)` for a child-only machine; its behavior receives a non-optional `parent`, compatible owners are checked when the child is invoked, and independent root APIs reject the machine.

  Replace `parentEvents: ParentEvents` with `parent: Machine.optionalParent(ParentEvents)` when the same machine must remain valid as either a root or a child. Optional declarations retain the previous `parent | undefined` behavior. Machines without a parent declaration no longer expose `parent` in schema-first behavior contexts.

- a5c910a: Make definition-time topology instructions immutable values. Use `to.none`, declared `.initial` and history properties, and `to.local.with` without an empty call; state and choice destinations such as `to.full.Running()` remain callable.

  Author machine startup through the same target-first grammar: `initial: (to) => to.Flow.initial.resolve(...)`. The selector is captured once and its resolver remains lazy until initial planning.

  Remove `Machine.targetless` and the `{ target: Machine.targetless, resolve }` shorthand. Use `(to) => to.none` or `(to) => to.none.resolve(...)`; block-bodied targetless resolvers may omit an explicit `return undefined`.

- 64f4e36: Replace `Machine.transition(...)` with fluent transition selectors supplied directly to inline handlers. Select a target and optionally attach its resolver, reentry, or named branches without an intermediate wrapper:

  ```ts
  const handlers = {
    Start: (to) =>
      to.full
        .Running()
        .resolve(({ event, target }) => target.from({ count: event.count })),

    Route: (to) =>
      to
        .branches({
          running: { target: to.full.Running() },
          done: { target: to.full.Done() },
          unchanged: { target: to.none },
        })
        .resolve(({ event, select }) =>
          event.cached ? select.done.from() : select.running.from()
        ),
  };
  ```

  Use `.reenter()` for resolver-free reentry, or pass literal `declinable: true` to `.resolve(...)` when the resolver must receive `decline()`. Bare targets are accepted only when their schemas support default construction.

  Remove the machine-definition `.invoke(...)` method. Use `Machine.invoke(...)` in every state; it now retains the owning state, event, parent-event, output, error, element, snapshot, and service inference directly inside `handle(...)`.

- 752a0b2: Add opt-in declinable transitions for conditional statechart dispatch.

  Set `declinable: true` on `Machine.transition` to expose a typed `decline()` resolver capability. Declining selects no transition, discards operations enqueued by that resolver, and lets hierarchical event or eventless dispatch continue with the next eligible ancestor. `target.none()` remains handled and continues to consume the trigger.

  Declining a completion or invocation outcome ignores that lifecycle occurrence because those triggers do not dispatch to ancestor handlers.

  Static transition definitions now expose `acceptance: "required" | "declinable"` alongside their exact target branches. Choices and initial routing remain total and reject declinable transitions.

### Patch Changes

- 7233677: Fix `AtomMachine` selectors so machines and invoked children with declared emitted events retain typed state selection and matching after `make` or `bind`.

## 0.16.0

### Minor Changes

- 1ca9af3: Replace conditional `cases` and `otherwise` transitions with named `branches`. Each branch declares one static target, while the required synchronous `resolve` function uses ordinary TypeScript control flow to return a typed `select` builder.

  ```ts
  Machine.transition({
    branches: (to) => ({
      moving: { target: to.local.Running() },
      unchanged: { target: to.none() },
    }),
    resolve: ({ event, select }) =>
      event.axis === 0
        ? select.unchanged()
        : select.moving.from({ startedAt: event.at }),
  });
  ```

  Branch keys are stable inspection, visualization, trace-verification, and coverage identities. Optional branch titles remain presentation metadata.

- 7bb9a45: Add `stream` sources to `Machine.invoke`. Stream values are handled through the typed `onElement` transition one committed parent macrostep at a time, while completion and typed failures use `onDone` and `onFailure`. Leaving the owning state interrupts the Stream and runs its finalizers.

  Add the direct `{ target: Machine.targetless, resolve }` transition shorthand for handlers that keep the current configuration and only enqueue commands.

## 0.15.0

### Minor Changes

- b94fee1: Make `handle` a one-shot implementation boundary. `Machine.make(...)` now returns a `Machine.Definition`; calling `handle(...)` returns a `Machine` without another `handle` method.

  To create multiple implementations, call `handle` independently on the original definition. Migrate chained calls by combining their state configurations into one handler tree.

- 1d44195: Add `Machine.state` for topology that is genuinely reused at multiple mounts, plus definition-bound `States.path(...)` and `Machine.Snapshot<typeof States>` helpers for checked finite path families and snapshot queries.

  Rename `Machine.defineStates` to `Machine.states`. Migrate by replacing `Machine.defineStates({...})` with `Machine.states({...})`; one-off topology should remain inline in that complete state definition. The returned state tree is now an immutable structural capture, so repeated mounts do not retain shared caller-owned configuration objects.

### Patch Changes

- 4dd8d24: Fix `Machine.invoke(...)` inside `.handle(...)` so invocation sources and lifecycle handlers receive the owning machine's typed `self` and `parent` protocols.

  Event protocol examples now pass tagged unions directly to `Machine.events`, `Machine.internalEvents`, and `Machine.emittedEvents`, avoiding throwaway schema bindings.

## 0.14.1

### Patch Changes

- e54803e: Fix `to.local.with()` so schema-backed compound scopes can select and rebuild their local value from both direct handlers and nested invoke outcomes.

  Expand the inspection examples with text and Mermaid state diagrams built from `Machine.stateNodes`, `Machine.initialDefinition`, `Machine.transitionDefinitions`, `Machine.activityDefinitions`, and live configuration. The examples render concrete conditional branches, reentry, choices, history and final states, activities, and safely escaped user-defined labels.

## 0.14.0

### Minor Changes

- 4554c4d: Make `MachineTest.coverage` report transition definitions and their exact branches separately. Read definition coverage through `coverage.transitions.definitions` and conditional branch coverage through `coverage.transitions.branches`.

  Replace the `targetBounds` verification law group with `definitions`. The new laws validate the declared startup root, transition registration, retained `branchIndex`, and the selected branch's exact target kind and scope.

- a4cd309: Add exact `transitionCoverage` to `MachineTest.Exploration`. Coverage includes startup and every concretely planned event, including state-limit candidates, while unplanned depth- and transition-limit frontiers remain misses.
- 324ae69: Retain exact static and runtime transition evidence for testing and visualization. Transition branch inspection now includes the selected target kind and scope, retained planner transitions identify the zero-based branch that executed, and `Machine.initialDefinition` exposes the root startup selection without executing its resolver.

  Use `branchIndex` to associate a retained transition with the corresponding entry in `Machine.transitionDefinitions(machine).branches`. Direct transitions use index `0`; conditional cases retain their declaration index and `otherwise` follows the final case.

- 2c67924: Require `Machine.transition` for every machine transition and capture each possible target as static machine topology. Direct transitions declare `target` and `resolve`; conditional transitions declare titled `cases` whose `when` functions return `Option`, plus an explicit `otherwise` branch. The selected target builder and conditional match value are inferred in each resolver.

  Initial state construction now uses the same `target` and `resolve` shape, restricted to the machine's declared initial state. Replace process logic previously created with `Machine.transition` by `Machine.logic`, and replace function handlers, target upper-bound lists, and `States.initial` construction with the explicit transition and initial target selectors.

- 944cdb5: Allow conditional `Machine.transition` definitions to infer any number of heterogeneous cases. Define `cases` with its locally supplied `branch` constructor so each predicate match and selected target remain exact in the corresponding resolver:

  ```ts
  Machine.transition({
    cases: (branch) => [
      branch({
        title: "cached",
        when: ({ event }) => event.cached,
        target: (to) => to.full.Ready(),
        resolve: ({ match, target }) => target.from({ data: match }),
      }),
    ],
    otherwise: {
      target: (to) => to.full.Loading(),
      resolve: ({ target }) => target.from(),
    },
  });
  ```

  Replace each object previously written directly in the `cases` array with `branch({ ... })` inside the `cases: (branch) => [...]` factory. Direct transitions and `otherwise` keep their existing shape.

- 64094df: Make `MachineTest.verify` accept startup roots reached through exact retained initial-choice routes and reject retained targets whose choice, initial, or history resolution is inconsistent with their selected static branch. Resolution failures are reported as `definitions.resolution`.

## 0.13.0

### Minor Changes

- 0ca9134: Upgrade the exact Effect peer dependency and companion Effect packages to `4.0.0-rc.109`.
- aa4947f: Require every `Machine.invoke` `effect` source to be a factory evaluated when its owning state is entered. This gives lifecycle callbacks immediate output and failure inference while making Effect construction timing explicit.

  Wrap previously direct Effects in a zero-argument function:

  ```ts
  Machine.invoke({
    id: "load",
    effect: () => load,
    onDone: ({ output, target }) => target.none(),
  });
  ```

- 34a9a26: Add typed declared-initial entry to compound and parallel transition targets.

  Use `target.full.opened.initial()`, `initial(value)`, or `initial.from(input)` to enter the initial configuration declared by `Machine.defineStates`; the same operation is available through compatible `local` and `branch` target scopes. Schema-valued implicit children are constructed by `initialize: ({ builder }) => ...`, including fluent completion of every valued parallel region. Missing initializers are reported at `handle(...)`, and `.from` validation remains a typed `MachineSchemaDecodeError` during planning.

  State handler `initial` and its `StateInitial*` utility types have been replaced by `initialize` and `StateInitialize*`. Migrate compound initializers from `initial: () => new Child(...)` to `initialize: ({ builder }) => builder(new Child(...))`, and parallel initializers from returned value records to chained region builders.

- c8728e5: Add live, root-scoped machine inspection through `Machine.prepare(machine).inspection` and `AtomMachine.inspection(machineAtom)`.

  The hot Effect `Stream` observes ordered creation, initialization, mailbox delivery and processing, state changes, emissions, Effect and timer activities, and termination for a prepared root and all locally owned descendants:

  ```ts
  const prepared = yield * Machine.prepare(machine);

  yield *
    prepared.inspection.pipe(
      Stream.runForEach((event) =>
        Console.log(event.sequence, event.subject.id, event._tag)
      ),
      Effect.forkScoped({ startImmediately: true })
    );

  const ref = yield * prepared.start;
  ```

  Inspection is non-replayed, never fails, and completes with the root. Its session ids and ordering are local to one prepared ownership tree; distributed identity and delivery remain an Effect Cluster concern.

## 0.12.0

### Minor Changes

- 9798994: Rename the minimal inter-machine reference types so they use machine terminology and remain distinct from Effect Cluster concepts.

  ```ts
  Machine.ActorRef<Event>; // before
  Machine.MachineTarget<Event>; // after

  Machine.ActorContext<InputEvents, ParentEvents>; // before
  Machine.MachineReferences<InputEvents, ParentEvents>; // after
  ```

  The inferred `self` and `parent` fields and all runtime behavior are unchanged.

## 0.11.0

### Minor Changes

- 2a84cd2: Add `Machine.prepare` for composing snapshot and emission streams before a machine initializes, while keeping `Machine.start` as the one-step convenience.

  ```ts
  const prepared = yield * Machine.prepare(machine);
  yield *
    prepared.emissions.pipe(
      Stream.runForEach(handleEmission),
      Effect.forkScoped({ startImmediately: true })
    );
  const ref = yield * prepared.start;
  ```

  AtomMachine emission streams use the same preparation boundary, and machine definitions now expose `definition.invoke(...)` so invocation `self` and `parent` references use the exact public input and `parentEvents` protocols.

## 0.10.0

### Minor Changes

- b7004c2: Make `Machine.events` and `Machine.internalEvents` definition-time protocol descriptors that are passed directly to `Machine.make`. The descriptors expose type-safe deferred constructors while retaining their schemas privately, so applications can export the event API without exporting schemas or reaching for throwing schema `.make` methods.

  ```ts
  const Events = Machine.events(PublicEvent);
  const InternalEvents = Machine.internalEvents(InternalEvent);

  const machine = Machine.make({
    states: States.states,
    events: Events,
    internalEvents: InternalEvents,
    initial: () => States.initial.Idle.from(),
  });
  ```

  Remove the eager schema-based `Machine.event` constructor. Pass complete decoded event objects directly to APIs that intentionally retain values, such as manual model-testing scenarios or transport messages.

- cb137a7: Add `target.none()` for explicit targetless transitions. Every installed transition handler now returns a concrete target or `target.none()`; declared `targets` remain an upper bound on concrete destinations and never exclude `target.none()`.

  Remove `Machine.retag`. To reuse compatible fields across sibling states, destructure away the source discriminator and construct the destination through its target builder:

  ```ts
  const { _tag: _, ...fields } = state;
  return target.local.Saving.from({ ...fields, attempt: 1 });
  ```

- 62e2281: Separate actor inputs from outward notifications. Declare emissions with `Machine.emittedEvents`, publish them with `emit`, and observe the hot, non-replaying `MachineRef.emissions` stream. Children declare the public inputs they expect from their owner through `parentEvents`, then communicate explicitly with the typed, optional `parent` actor reference:

  ```ts
  const Emissions = Machine.emittedEvents(Progress);
  const ParentEvents = Machine.events(Completed);

  const worker = Machine.make({
    // ...
    emittedEvents: Emissions,
    parentEvents: ParentEvents,
  }).handle({
    Working: {
      entry: ({ parent }, enqueue) => {
        enqueue.emit(Emissions.Progress({ value: 0.5 }));
        if (parent !== undefined) {
          enqueue.sendTo(parent, ParentEvents.Completed({ value: 42 }));
        }
      },
    },
  });
  ```

  Handler contexts also expose typed `self`; invoked-child composition checks that every `parentEvents` case is accepted by the parent. This release renames structural handler ancestry to `containingState` and `ancestors`, supports zero-payload event and emission constructors with `()`, and exposes root and child emission streams through AtomMachine.

## 0.9.0

### Minor Changes

- d471d42: Add `Machine.events(machine)` and `Machine.internalEvents(machine)` as the standard way to construct protocol events.

  The returned tag-keyed constructors preserve schema make inputs and defer decoding until machine delivery, so invalid values fail with `MachineSchemaDecodeError` through planning or the running machine instead of throwing at the construction call site.

- 59580de: Replace `Machine.invokeEffect`, `Machine.after`, `Machine.invokeMachine`, and `Machine.effect` with one inline `invoke` lifecycle object API and a zero-runtime `Machine.invoke` inference helper.

  Choose an `effect`, `after`, `logic`, or `child` source and handle typed outcomes directly with `onDone`, `onFailure`, and `onSnapshot`. Lifecycle handlers can now transition the owning state without routing results through mapped machine events.

  State-dependent Effect sources infer their owner state, output, error, and service requirements together without a manual return annotation.

## 0.8.0

### Minor Changes

- e02dba3: Allow active states to omit `schema` when they own no data. Schema-less atomic, compound, parallel, and final states keep full control-flow semantics while exposing value-free `.from(...)` builders, `undefined` handler state, and snapshot-only query APIs.

  ```ts
  const States = Machine.defineStates({
    Form: {
      initial: "Editing",
      states: { Editing: {}, Saving },
    },
  });

  States.initial.Form.from((form) => form.Editing.from());
  ```

## 0.7.0

### Minor Changes

- b192484: Allow `Machine.defineStates` query helpers to inspect an extracted
  snapshot subtree. Paths remain absolute and type-safe, but `get`,
  `getSnapshot`, and `matches` can now continue from a snapshot selected
  earlier instead of requiring the complete root snapshot.

  ```ts
  const readySnapshot = States.getSnapshot(snapshot, "Ready");

  if (Option.isSome(readySnapshot)) {
    States.get(readySnapshot.value, "Ready.editor");
    States.matches(readySnapshot.value, "Ready.editor.Editing");
  }

  const editorSnapshotAtom = AtomMachine.selectSnapshot(
    machineAtom,
    "Ready.editor"
  );
  ```

  Add equality-aware `AtomMachine.selectSnapshot` and
  `AtomMachine.selectSnapshotChild` combinators for reactive consumers that
  need the complete logical snapshot subtree instead of only its state value.
  The selected atoms retain nested topology, suppress structurally equal
  updates, and produce `Option.none()` while the path or invoked child is
  inactive.

## 0.6.1

### Patch Changes

- efc4f2f: Reduce pull request performance-check latency while preserving focused type,
  runtime, and memory regression coverage.
- a6774a0: Include the original TypeScript sources in the published package.

## 0.6.0

### Minor Changes

- e786835: Upgrade Effect and the companion Effect packages from the beta release line to `4.0.0-rc.108`.

### Patch Changes

- 449984b: Upgrade the XState v6 performance comparison to `6.0.0-alpha.36`.

## 0.5.1

### Patch Changes

- a23463c: Complete the interactive examples, align example state construction with the recommended API, and restructure the README around the current usage patterns.

## 0.5.0

### Minor Changes

- f3e1e78: Add reusable runtime invariants, law-oriented causal command verification, and
  an explicit planner/runtime agreement check. Causal probe microsteps now retain
  stable public snapshots even when the optimized runtime reuses internal state.
- 0dbb538: Add state, step, and trace invariants for checking application semantics over planner traces, including machine-inferred builders, conditional observation requirements, structured reports, and property-test assertions. Add bounded breadth-first exploration with state-dependent event representatives, shortest witnesses, explicit truncation frontiers, and fail-closed reachability assertions. Add testing-only runtime probes with acknowledged event delivery so tests can causally inspect ignored, targetless, changing, and failed live macrosteps without adding a production `sendAndAwait` API.
- c01c7d2: Add explicitly named causal and enqueue-oriented runtime command runners. Causal command tests now retain an exact probe step for every processed send, support probe-bound asynchronous waits, attribute processing failures to the submitted command, and format replayable causal transcripts. Deprecate the ambiguous `runRuntimeCommands` and `formatRuntimeTranscript` names in favor of their explicit enqueue-oriented replacements.

### Patch Changes

- ea7c522: Add Effect-compatible TypeDoc API reference generation and a lightweight static reference website with module navigation, declaration pages, source links, responsive layouts, and local search. Document the public API with library-native version metadata and focused examples for the primary machine, persistence, testing, reactivity, and Cluster workflows.

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

- 9f1bf76: Batch lossless ordered snapshot publications across each synchronous compiled machine drain segment and share the compact process context through prototype methods.
- ea1ea8e: Reduce the retained memory of invoked machines by running the original child logic with a compact guarded `sendParent` channel instead of allocating a wrapper process for every invocation.
- 5656f41: Fix first-use nested history defaults by requiring a complete source-independent configuration containing the history owner and using it to rebuild inactive compound and parallel ancestors.
- 8fe6e7b: Consolidate generic and compiled state-scoped invocation lifecycle handling behind one owner-local child registry, preserving duplicate detection, stale callback isolation, and path-scoped teardown without changing the public API.
- 69f1c20: Reuse the validated statechart configuration while draining queued event batches, avoiding repeated snapshot normalization without retaining the cache while a machine is idle. Canonicalize history snapshot paths in machine document order so batched and public planning produce identical snapshots.
- b7ea7a5: Capture event dispatch definitions when handlers are registered and make compiled execution fall back safely when a state configuration contains unknown semantics.
- 881575b: Decompose machine topology, schema protocols, configurations, snapshot serialization, command execution, semantic planning, and compiled execution plans into explicit internal modules without changing runtime behavior or public types.
- 5d37ead: Reduce compiled-machine lifecycle and retained-memory overhead by using owner-local terminal arbitration while preserving public completion, cleanup, and first-terminal-wins semantics.
- 2d6a76e: Organize public, internal, testing, and unstable modules into Effect-shaped directories without changing package entrypoints. Add a TypeScript-resolved architecture check that enforces dependency direction, test boundaries, acyclic runtime imports, and internal naming conventions.
- 7bc3abf: Reduce retained machine memory by sharing immutable zero-input execution descriptors across process instances while preserving per-instance invoke state.
- 8151b3a: Suspend compiled statechart workers while their mailboxes are idle and start an
  on-demand drain when an event arrives. This reduces retained heap for idle
  machines and invoked families without changing event ordering, terminal
  arbitration, or the public machine API.
- 74362e3: Skip child-registry allocation for statecharts that cannot invoke child processes, while preserving empty child lookup, observation, send, and stop behavior.
- 7ac8ddd: Remove unused internal declarations, imports, and type assertions, and enforce unused-local and unchecked-index diagnostics during type checking.
- 7193025: Keep `MachineTest.run` service-free for machines with invoked effects, matching the pure `Machine.planInitial` and `Machine.plan` APIs it uses internally.
- 12845fe: Separate the public Machine, MachineTest, AtomMachine, and ClusterMachine contracts from their internal implementations. Enforce designated implementation seams and explicit public function signatures through the architecture check without changing the package API.
- 1e4eab6: Run eligible compound and parallel statecharts on a compact indexed configuration with precompiled numeric topology and event dispatch. Public snapshots are materialized only at process boundaries, reducing per-event configuration work while preserving schema validation, raised-event stabilization, transition conflict rules, resume behavior, and the public machine API.
- d602202: Compact running machine workers into a single generator loop and allocate emitted-event runtime closures only when a machine emits, reducing idle heap and improving event throughput without changing scheduler yield semantics.
- 80b3e73: Compact invoked-child session bookkeeping into an atomic runtime table, reducing parent and child lifecycle overhead without changing invoke ordering or race protection.
- fc9989b: Run compiled statecharts on a compact, class-backed process kernel that shares operation implementations and materializes terminal and observation primitives only when used. This reduces retained memory and improves runtime throughput while preserving the general `Machine.logic` process contract, lifecycle arbitration, child cleanup, and public `MachineRef` API.
- 1350f10: Run compiled statecharts and their invoked machine children with a single process fiber, reducing lifecycle overhead and idle memory while preserving the general `Machine.logic` runtime contract.
- aa6f95f: Compile eligible machine initial-state normalization, reuse the validated startup configuration, and unify invoked-child ownership with the runtime child registry.
- 1e3a86d: Compile reusable statechart execution metadata and run eligible flat machines through a synchronous specialized planner inside the compact Effect process kernel. This removes per-event Effect wrappers and repeated topology construction while preserving schema validation, raised-event stabilization, lifecycle ordering, observation, interruption, invoked children, and the public planning and machine APIs.
- ad55919: Remove the library-owned eight-level handler-tree inference ceiling. Nested
  handler validation and accumulated state, error, service, choice, history, and
  output evidence now continue until TypeScript's normal compiler limits.
- 1aa746c: Deliver invoked child snapshots directly from the child runtime, removing the replay PubSub and watcher fiber previously retained by every snapshot-mapped invocation.
- 381cfe3: Reduce invoked-child memory and lifecycle overhead by delivering terminal outcomes directly through process supervision and allocating a watcher fiber only for invokes that map active child snapshots.
- b942882: Reduce hierarchical transition overhead by materializing the compiled transition context as a plain object.
- 995bb3b: Let the Effect runtime scheduler control cooperative yielding while draining machine event bursts, preserving runtime scheduler configuration and avoiding a forced scheduler turn after every event.
- a0d06e0: Reduce the retained memory of `childChanges` observers with a compact ordered handoff that avoids replaying complete child-registry snapshots.
- f550ac0: Reduce child lifecycle overhead by reserving child starts atomically and specializing zero- and one-item invoke cleanup without weakening parallel finalization.
- c751d88: Avoid rebuilding a complete configuration for same-state atomic snapshot transitions in the compiled flat executor.
- da95851: Reuse settled startup outcomes, fast-path idle childless startup and stop, and move invoked session coordination onto a compact parent-owned kernel.
- 757c10c: Add local and pull request runtime benchmark reporting for pure planning, end-to-end event drainage, machine lifecycle throughput, and idle-machine memory growth against the compiled package, XState 5, and the published XState 6 alpha.
- f229e7a: Start eligible compiled invoked machines directly from their synchronous initial kernel while preserving per-instance input evaluation, inherited services, scoped ownership, observation, and terminal behavior. Reuse the immutable process descriptor captured by `Machine.invokeMachine` across parent instances.
- 2f7fd0e: Defer construction of a compiled machine's `StoppedError` until its stopped `join` result is observed.
- 27957e2: Initialize eligible compiled machines through the shared synchronous startup kernel while preserving Effect services and invoke lifecycle behavior.
- c6575bc: Reduce runtime planner allocation overhead by reusing compiled schema decoders and state topology paths, deferring effect service allocation until it is needed, and avoiding unused snapshots.
- e60b9d7: Update the required Effect runtime and development integration from `4.0.0-beta.102` to `4.0.0-beta.105`.
- fcddd68: Update the supported Effect 4 beta to 4.0.0-beta.107, preserve schema-arbitrary diagnostics across Effect's new generator factory API, and refresh the XState v6 runtime benchmark baseline to 6.0.0-alpha.31.
- 3848b9b: Allocate child process scopes and observable child registries only when a machine uses child-management capabilities.
- 7ccfe10: Allocate change-observation resources only when a machine's `changes` stream is first consumed, while preserving snapshot replay, terminal completion, and the existing `MachineRef` API.
- 1fa7b71: Use a compact FIFO mailbox for on-demand compiled statecharts while retaining
  Effect Queue for persistent custom process logic. This reduces idle heap for
  machines and invoked families while preserving FIFO delivery, terminal send
  rejection, and wake-up behavior.
- 7c8d86c: Reduce the memory retained by running machines by consolidating process termination into a single supervisor signal.
- fd64615: Reduce managed runtime memory and lifecycle overhead by removing redundant process coordination state, reusing the live runtime service, and allocating invoke management only for machines with invoke definitions.
- 73c1e6d: Reduce child-machine ownership memory by consolidating supervision and registry state, tracking anonymous children without per-child scope finalizers, and allocating child observation resources only when consumed.
- 1e7821a: Reduce child-capable process memory and lifecycle overhead with a compact synchronous registry, while lazily allocating ordered child-change publication only when observed.
- 04ea202: Add `Machine.event` for constructing protocol-owned events that validate once and avoid redundant decoding on repeated delivery.
- 603baaf: Run eligible flat machines on the same indexed execution representation as compound and parallel machines, with a specialized single-root dispatch loop and owner-local state slots. This removes the separate flat configuration executor while preserving schema validation, raised events, immutable public snapshots, resume behavior, and terminal completion.
- d3dc770: Store compiled machine snapshots in an owner-only mutable reference while
  retaining atomic terminal reservation and lazy observation. This reduces
  transition overhead and idle heap without changing the public API, event
  ordering, or terminal behavior.
- 2274b8e: Replace implicit compiled-process capability markers with one typed execution descriptor, make lifecycle states explicit, and centralize snapshot publication at Effect boundaries.
- 1951844: Add direct generic/indexed planner and generic/compiled runtime strategy guardrails, including startup, targetless, reentry, invoke, snapshot-stability, and generated-model coverage. Expand the runtime benchmark suite with hierarchical and parallel planning, observed hierarchical execution, and generic process lifecycle measurements.
- 9eac202: Harden machine execution and definitions while preserving the existing Effect-native API. Self-stop now uses supervisor-owned terminal arbitration without initialization or worker deadlocks; execution adapters consistently reject incomplete output, history, and choice implementations; finite-union event tags narrow correctly; and machine guards verify the runtime brand value.

  State definitions now reject unknown node properties and unsafe state keys at compile time and runtime with path-local diagnostics. Add deterministic lifecycle, adversarial snapshot-codec, type-performance, activity-lifecycle, and planner-versus-runtime verification coverage.

- e7be28f: Compile event dispatch, ancestry lookup, value-only leaf updates, and final-state checks for compound and parallel machines that do not use automatic or lifecycle transitions. Unsupported statechart capabilities continue through the general planner with unchanged semantics.
- 9400d99: Use the compact synchronous teardown path for idle compiled invoked children while preserving ownership cleanup and stopped completion behavior.
- e830c66: Make compiled execution plans expose an honest runtime-only contract, document their owned indexed state, and strengthen differential coverage for mutation-sensitive transitions.
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
