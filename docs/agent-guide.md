# Effect Machine agent guide

This is the model-facing reference for the currently published
`@typeonce/effect-machine` API. Prefer these patterns over reconstructing the API
from its internal implementation.

## Public imports

```ts
import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { ClusterMachine } from "@typeonce/effect-machine/cluster"
```

Do not import the published package as `effect/unstable/machine`. The package is
currently coupled to the exact Effect peer version listed in its `package.json`.

## Definition order

Use this order so inference has all schemas available when handlers are
declared:

1. Domain schemas used by state and event fields.
2. Tagged state schemas.
3. Tagged public-event, internal-event, and emitted-event schemas.
4. `Machine.defineStates`.
5. `Machine.make`, including input, events, internal events, emits, and the
   initial function.
6. One or more `.handle(...)` calls.
7. Child descriptors.
8. Runtime, Atom, or Cluster adapters.

`Schema.TaggedUnion` avoids one class declaration per case:

```ts
const State = Schema.TaggedUnion({
  Idle: {},
  Saving: { draft: Draft },
  Failed: { message: Schema.String }
})

const Event = Schema.TaggedUnion({
  Save: {}
})

const InternalEvent = Schema.TaggedUnion({
  Saved: { id: Schema.String },
  SaveFailed: { message: Schema.String }
})

const States = Machine.defineStates(State.cases)
```

Construct values with `State.cases.Idle.make({})` or
`Event.cases.Save.make({})`. Use `Schema.TaggedClass` instead when a case needs
class methods or nominal class identity.

## Hard invariants

- `Machine.make({ initial })` expects a function, including for `Schema.Void`
  input.
- State, emit, input, and output schemas validate their runtime boundaries.
  Event schemas provide decoders, but the local public/internal distinction is
  a TypeScript boundary; Cluster additionally validates public commands at its
  transport boundary.
- Return snapshots or typed target-builder results from transitions. Do not
  return raw decoded state values.
- Transition and lifecycle callbacks are synchronous. Put asynchronous work in
  an invoked Effect, actor, or child machine and map its result to an event.
- Put data on the narrowest state where it is valid. Put data shared by sibling
  phases on their compound parent.
- Declare finality only in the state definition. Do not put `type: "final"` in
  a handler.
- Every declared output schema needs a matching handler implementation before
  planning or execution.
- `parents` keys are full dotted paths.
- Invoke lifetimes follow state entry and exit, not the spelling of the target
  builder.
- Recover expected invoked Effect failures into machine events. Unrecovered
  child failures terminate the owning machine.
- Reuse the exact child descriptor value for `invokeMachine`, `sendTo`, and
  child lookup.
- `events` is the public input protocol. `internalEvents` contains machine-local
  deliveries such as invoke results and invoked-child emissions. Handlers see
  both; typed public `send` and `Machine.plan` accept only `events`.
- Event tags in `events` and `internalEvents` must be disjoint.
- Event tags must also be unique within each protocol list.

## Canonical API choices

Choose one helper from the intent, and reach for the lower-level form only when
its extra control is required:

- Bind a shared Atom runtime once with `AtomMachine.bind(runtime)`, then use the
  returned `make` or `resume`. Use `AtomMachine.make(machine)` and
  `AtomMachine.resume(machine, snapshot)` for service-free machines.
- Use `Machine.invokeEffect` for a typed one-shot Effect and `Machine.after` for
  a timer. Use `Machine.invoke` with `Machine.effect` only for custom child
  process behavior or snapshot mapping.
- Use `Machine.child(id, machine)` for a complete statechart descriptor and
  `Machine.childAddress<Event>(id)` for a low-level process address. An
  invocation is addressable only when `Machine.invoke` receives that address
  explicitly.
- Use the callback's `enqueue` argument for `raise`, `emit`, `sendTo`, and
  `stop`. These operations record closed actor commands and do not run Effects.

## Atomic, compound, parallel, and history states

Use an atomic state when no child phase can be active beneath it.

Use a compound state when exactly one child phase is active. It must declare an
`initial` child:

```ts
const FormState = Schema.TaggedUnion({
  Form: { draft: Schema.String },
  Editing: {},
  Saving: {}
})

const FormStates = Machine.defineStates({
  Form: {
    schema: FormState.cases.Form,
    initial: "Editing",
    states: {
      Editing: FormState.cases.Editing,
      Saving: FormState.cases.Saving
    }
  }
})
```

Use a parallel state when every direct region is active:

```ts
const ParallelState = Schema.TaggedUnion({
  Screen: {},
  Network: {},
  Online: {},
  Offline: {},
  Panel: {},
  Closed: {},
  Open: {}
})

const ParallelStates = Machine.defineStates({
  Screen: {
    schema: ParallelState.cases.Screen,
    type: "parallel",
    states: {
      network: {
        schema: ParallelState.cases.Network,
        initial: "Online",
        states: {
          Online: ParallelState.cases.Online,
          Offline: ParallelState.cases.Offline
        }
      },
      panel: {
        schema: ParallelState.cases.Panel,
        initial: "Closed",
        states: {
          Closed: ParallelState.cases.Closed,
          Open: ParallelState.cases.Open
        }
      }
    }
  }
})
```

Every parallel region needs an active state in initial and full snapshot
builders. The same rule applies when a local or branch target enters an
inactive nested parallel state.

Use `type: "final"` for a terminal leaf in `Machine.defineStates`. A final
child completes its compound parent. Put `onDone` on that completed parent,
never on the final leaf. The definition owns the output schema and the handler
computes its value:

```ts
const States = Machine.defineStates({
  Done: {
    schema: State.cases.Done,
    type: "final",
    output: Schema.String
  }
})

const machine = Machine.make({
  states: States.states,
  events: [],
  initial: () => States.initial.Done(State.cases.Done.make({}))
}).handle({
  Done: {
    output: () => "done"
  }
})
```

Do not repeat `type: "final"` in `handle`. Execution APIs reject a machine
until every declared output schema has an implementation.

Declare a history pseudo-state below the active parent whose configuration it
should remember. It has no schema, is excluded from active state identifiers,
and is addressed only through `target.history`:

```ts
const States = Machine.defineStates({
  checkout: {
    schema: Checkout,
    initial: "shipping",
    states: {
      shipping: Shipping,
      payment: {
        schema: Payment,
        initial: "cardEntry",
        states: {
          cardEntry: CardEntry,
          verifying: Verifying
        }
      },
      recent: { type: "history" },
      exact: { type: "history", history: "deep" }
    }
  },
  support: Support
})
```

Every history node needs a source-independent default for the first use. The
default is a complete root snapshot containing the history owner:

```ts
checkout: {
  history: {
    recent: { default: () => initialCheckoutSnapshot },
    exact: { default: () => initialCheckoutSnapshot }
  }
}
```

Target it without a value:

```ts
Resume: ({ target }) => target.history.checkout.exact()
```

Deep history restores the complete remembered subtree and its decoded values.
Shallow history restores only parent and direct-child values. If the remembered
child is compound, its configured initial child needs a freshly constructed
value, so implement `initial` only on paths required by shallow history:

```ts
payment: {
  initial: ({ state }) => new CardEntry({ attempt: state.attempt, cardNumber: "" })
}
```

A nested default must include every ancestor above its owner and every region
of any parallel ancestor. The containing branch is checked statically, so an
unrelated root, a sibling compound branch, a direct-owner-only nested snapshot,
or an incomplete parallel configuration is rejected. A canonical nested
default looks like:

```ts
Workspace: {
  history: {
    resume: {
      default: ({ target }) =>
        target.App(
          State.cases.App.make({ workspaceId: "default" }),
          (app) =>
            app.Workspace(
              State.cases.Workspace.make({}),
              (workspace) =>
                workspace.Editing(State.cases.Editing.make({}))
            )
        )
    }
  }
}
```

On first use from an inactive root, this complete configuration is entered. If
a parallel ancestor is already active, unaffected active regions are retained.
Once a history record exists, shallow or deep recorded restoration wins over
the default.

The machine's readiness type tracks missing defaults and shallow initializers.
History is an overwriteable register, not a stack: restoration does not consume
it, and the next parent exit replaces it. Entry actions and invokes run again;
prior effects, actors, and timers are not rewound.

## Choosing a target

| Builder          | Use it when                                                                | What it preserves                                                                 |
| ---------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `target.local`   | The destination is inside the nearest compound scope containing the source | The compound value, active ancestors, and unrelated parallel regions              |
| `target.branch`  | The destination is elsewhere under the active top-level root               | Omitted current ancestor values and parallel regions                              |
| `target.full`    | The destination may be under any top-level root                            | Nothing is inferred for a newly selected root; build its complete active snapshot |
| `target.history` | The destination is a declared history pseudo-state                         | Its parent's remembered configuration, or a source-independent complete default containing that owner before the first capture |

Entering an inactive parallel state through `target.local` or `target.branch`
requires a complete callback with one selection per region. A parallel state
that is already active remains partially addressable through `target.branch`;
unmentioned active regions are preserved.

These describe configuration construction, not automatic process restart.
Machine planning compares active paths and derives the actual exit and entry
sets. A `target.full` result with the same active paths can update values without
exiting shared states. To force the source to exit and enter again:

```ts
Refresh: {
  reenter: true,
  transition: ({ state, target }) =>
    target.full.Ready(new Ready({ value: state.value }))
}
```

Do not use `target.full` merely because it is easiest to discover. Prefer the
narrowest builder that expresses the intended configuration change.

Every state builder method has two construction forms:

```ts
target.local.Ready(decodedReady)
target.local.Ready.from({ value: event.value })
```

The direct call accepts the schema's decoded `Type`. `.from` accepts its
`~type.make.in`, so callers do not need to invoke a TaggedUnion case's `make`
or instantiate a TaggedClass. The machine resolves `.from` with
`schema.makeEffect` during planning. Constructor defaults and class identity
are retained; refinement failures use `MachineSchemaDecodeError` at the state
boundary rather than throwing synchronously. This applies recursively to
initial, full, local, branch, compound, parallel, final, and `local.with`
builders.

If `{}` satisfies the schema's constructor input, omit it:

```ts
target.local.Idle.from()
target.local.Flow.from((flow) => flow.Idle.from())
```

This shorthand also applies to schemas whose constructor fields are all
optional or defaulted. It does not make required fields optional. Compound and
parallel builders still require a callback selecting their active child or
every active region. Omitted input is normalized to `{}` and still passes
through `schema.makeEffect`, including refinements.

## Reading state and parents

`Machine.defineStates` returns typed helpers:

```ts
States.get(snapshot, "Route.Ready")
States.getWithParents(snapshot, "Route.Ready.Editing")
States.getSnapshot(snapshot, "Route.Ready")
States.matches(snapshot, "Route.Ready.Saving")
```

All paths are checked against the definition. `context.parent` is the immediate
typed parent (`undefined` at a root). Use `parents` when another ancestor is
needed:

```ts
parents["Route.Ready"]
parents["Route.Ready.Editing"]
```

Do not guess short properties such as `parents.Ready`.

### Inspecting the full transition configuration

Event, `always`, and `onDone` transition contexts include a fully typed
`snapshot`. It is the complete logical snapshot at the beginning of that
microstep, before any selected transition is applied:

```ts
BufferReady: ({ snapshot, target }) =>
  States.matches(snapshot, "Player.Network.Online")
    ? target.local.Playing(new Playing({}))
    : undefined
```

Use the existing `States.matches`, `States.get`, `States.getWithParents`, and
`States.getSnapshot` helpers for cross-region reads. Parallel transitions
selected in one microstep receive the same capture. Synchronous handlers use
that captured value and cannot consult live runtime state later.

Do not expect `snapshot` in entry, exit, invoke, initializer, history-default,
or choice contexts. Choice is an important soundness boundary: a startup or
chained choice can run without a complete stable configuration containing the
pseudo-source, so the API does not fabricate a partial `Machine.Snapshot`.

### State annotations

Attach active-state metadata through Effect Schema:

```ts
const Saving = State.cases.Saving.annotate({
  title: "Saving document",
  description: "Persisting local changes to the server",
  documentation: "https://docs.example.test/saving"
})
```

`Machine.stateNodes(machine)` returns the resolved annotation map. Choice and
history definitions may declare an `annotations` object containing only
`title`, `description`, and `documentation`. These values are descriptive;
they cannot change behavior, identity, or targeting. Visualization may show a
title, while the structural path remains authoritative.

Use `Machine.retag(TargetCase, source, patch?)` when sibling state payloads
share fields. It removes the source discriminator, reuses only compatible
fields, and requires a patch for every missing or incompatible required field.
Prefer moving broadly shared data to the compound parent rather than retagging
it through every phase.

## Planning, actions, raised events, and emissions

A transition returns a target synchronously:

```ts
Submit: ({ state, target }) =>
  state.valid ? target.local.Saving(new Saving({ draft: state.draft })) : undefined
```

Closed statechart and actor operations use `enqueue`:

```ts
Submit: ({ target }, enqueue) => {
  enqueue.emit(new SaveRequested({}))
  return target.local.Saving(new Saving({}))
}
```

For asynchronous validation or persistence, invoke an Effect or child machine
from the state and handle its typed success or failure event in a later
transition. This keeps `(state, event) => [nextState, commands]` synchronous.

Plans have a discriminated completion result:

```ts
const planned = yield * Machine.plan(machine, state, event)
if (planned.done) {
  planned.output // schema-derived structural terminal union
}
```

When `done` is false, `output` is `undefined`. `MachineRef.join` and invoked
child `onDone.output` use the same structural terminal union rather than adding
an unconditional optional value. Output-less structural terminal paths
contribute `undefined`; active atomic roots do not. Handler behavior can make
the type conservative—for example, a root `onDone` transition can move away
before that root becomes the machine's terminal result.

`raise` queues an event for the same machine's current macrostep. `emit` queues
an event for the parent. Both operations validate their schemas.

## Public and internal event protocols

`events` defines the protocol callers can send. `internalEvents` augments the
union handled inside the statechart:

```ts
const machine = Machine.make({
  states: States.states,
  events: [Event.cases.Save],
  internalEvents: [InternalEvent.cases.Saved, InternalEvent.cases.SaveFailed],
  initial: () => States.initial.Idle.from()
})
```

When the same already-constructed event may be delivered repeatedly, construct
it once through its owning machine protocol:

```ts
const save = Machine.event(machine, Event.cases.Save)
yield* ref.send(save)
```

`Machine.event` runs the configured schema constructor once. That machine and
definitions derived from it with `handle` then recognize the decoded event as
trusted and do not decode it again. Tagged-union case schemas are recognized
when their union is configured. Treat the returned event as immutable. Raw
objects and values constructed for another machine continue through normal
runtime validation on every delivery.

Use the exported utility types when another API must preserve the boundary:

```ts
type PublicEvent = Machine.Machine.InputEvent<typeof machine>
type AnyHandledEvent = Machine.Machine.Event<typeof machine>
```

`MachineRef.send`, `machineAtom.send`, and `Machine.plan` use `InputEvent` at
their TypeScript boundary. Transition handlers, raised events, invoke results,
and mapped child events use the complete `Event` union. The local planner and
runtime intentionally share the complete decoder to support those internal
deliveries, so JavaScript or `any` can bypass the local public distinction.
Cluster RPC payloads are additionally decoded against the public `events`
schemas at the transport boundary. Never repeat an `_tag` within a list or
across both configuration lists.

## Recoverable state-scoped work

Use `Machine.invokeEffect` for a one-shot Effect. Its callbacks preserve the
typed success and failure channels while mapping both into machine events:

```ts
invoke: ({ state }) =>
  Machine.invokeEffect({
    id: "save",
    effect: SaveService.save(state.draft),
    onSuccess: (entry) => new Saved({ entry }),
    onFailure: (error) => new SaveFailed({ message: error.message })
  })
```

The owning state scopes the child. Owner-driven interruption on state exit is
normal cancellation and stale output is ignored. A child Effect that defects
or self-interrupts fails the parent. Omit `onFailure` only when the Effect error
type is `never`; defects and interruption are not mapped.

Successful non-void output is delivered as a parent event. Include every
possible mapped result schema in the parent machine's `internalEvents` array and
add handlers for the relevant tags. Leave defects and interruption fatal;
recover only expected typed failures.

A cancellable timer uses `Machine.after`:

```ts
invoke: Machine.after("3 seconds", new ClearStatus({}), {
  id: "clear-status"
})
```

The timer starts on state entry and is interrupted on exit. Supply an explicit
id when more than one active timer could deliver the same event tag. Use
lower-level `Machine.invoke` with `Machine.effect` when custom child logic or
snapshot mapping is required. In that API, `id` is only the invocation's
state-local lifecycle key. To communicate with the invocation, create a
`Machine.childAddress<Event>("worker")` and pass it as `address`; TypeScript
checks the address protocol against the child logic. Lifecycle ids must be
unique among simultaneously active invokes owned by the same state.

## Invoked child statecharts

Create a complete child-statechart descriptor:

```ts
const Editor = Machine.child("editor", EditorMachine)
```

Invoke it from its owning state:

```ts
invoke: Machine.invokeMachine({
  child: Editor,
  input: editorInput,
  onDone: ({ output }) => new EditorCompleted({ output })
})
```

Use `Editor` for:

```ts
Machine.sendTo(Editor, new Reset({}))
parentRef.child(Editor)
parentAtom.child(Editor)
```

Child emissions, mapped snapshots, and mapped completion output are delivered as
parent events and must be accepted by the parent's `internalEvents` list.
Invoked child IDs must be unique while simultaneously active.

Descriptors with the same id and machine identity address the same child, even
when independently constructed. The descriptor objects themselves are not
canonicalized. Prefer exporting one descriptor as the application boundary.
Use the separate
`Machine.childAddress<Event>(id)` constructor only for lower-level process
logic that does not have a complete machine descriptor.

### Inspecting state-owned activities

Use `Machine.activityDefinitions(machine)` to inspect invokes without running
them. Static `Machine.invoke`, `Machine.invokeEffect`, `Machine.after`, and
`Machine.invokeMachine` descriptors expose serializable ownership metadata:

```ts
Machine.activityDefinitions(machine)
// [{ source: "Loading", id: "load-timeout", type: "timer",
//    duration: "10s", event: "LoadTimedOut" }]
```

Effect success/failure mappers are closures and therefore appear as dynamic
outcomes. Child machines expose descriptor identity, never their runtime or
implementation. A function-valued `invoke` factory is represented as a dynamic
activity because inspection must not evaluate user code. The existing invoke
helpers remain the only execution API; this metadata does not add lifecycle
configuration syntax or affect execution.

## AtomMachine and React

`AtomMachine.make(machine, ...input)` works when the machine has no external
service requirements. For an application runtime, the canonical form is to
bind it once at the composition boundary:

```ts
const runtime = Atom.runtime(AppLayer)
const machines = AtomMachine.bind(runtime)
const machineAtom = machines.make(machine, input)
```

One bridge owns one machine instance per `AtomRegistry`. In React:

1. Render a `RegistryProvider` from `@effect/atom-react`.
2. Keep a component-owned bridge referentially stable, normally with
   `useMemo`.
3. Use scalar dependencies that define when the machine should restart.
4. Expect a new bridge identity to create a new instance once mounted.

The root bridge shapes are:

```ts
machineAtom.state
// Atom<AsyncResult<State, StartError>>

machineAtom.result
// Atom<AsyncResult<State, StartError | RuntimeError>>

machineAtom.snapshot
// Atom<AsyncResult<RuntimeSnapshot<State, RuntimeError, Output>, StartError>>
```

`state` remains a successful last-state value after a post-start runtime
failure. Prefer `result` for ordinary fail-aware UI state. Use `snapshot` when
the full lifecycle, completion output, cause, or stopped status matters.

Use equality-aware selectors instead of repeating AsyncResult/Option unwrapping.
Paths and selected values are inferred from the bridge snapshot, so do not pass
the `DefinedStates` object:

```ts
AtomMachine.select(machineAtom, "Ready")
AtomMachine.matches(machineAtom, "Ready.Saving")
AtomMachine.selectChild(childAtom, "Editing")
AtomMachine.matchesChild(childAtom, "Editing")
```

Like ordinary Effect Atom combinators, each selector call returns a derived
atom. Define it at a stable composition boundary or memoize it when constructing
it inside a component.

An invoked child bridge adds an inactivity axis. Keep the descriptor stable;
the bridge uses Effect's `Atom.family` identity semantics:

```ts
const editorAtom = parentAtom.child(Editor)

editorAtom.state
// Atom<AsyncResult<Option<State>, StartError>>
```

`Option.none()` means the child is not currently active or has not become
active yet. A child command while inactive fails with `ChildNotActiveError`.
Use `AtomMachine.ChildMachineAtom<typeof Editor>` for a descriptor-based child prop,
or `AtomMachine.ChildOf<typeof parentAtom, typeof Editor>` to infer the exact
bridge from a parent.

## Persistence

Use `Machine.encodeSnapshot` and `Machine.decodeSnapshot` for validated logical
statechart data. Persist machine identity and an application migration/version
next to the encoded snapshot.

The canonical resumption boundary is explicit:

```ts
const encoded = yield* Machine.encodeSnapshot(machine, snapshot)
const decoded = yield* Machine.decodeSnapshot(machine, encoded)
const ref = yield* Machine.resume(machine, decoded)
```

Pass only a decoded `Machine.Snapshot` to `resume`; encoded or arbitrary
transport data belongs at `decodeSnapshot`. Resumption validates and normalizes
the logical snapshot again, then publishes it as the fresh runtime's first
state. It does not call the initial function, require machine input, or include
initial-only failures and services in its Effect type.

Encoding does not preserve:

- running invokes or spawned children;
- subscriptions, queued events, fibers, scopes, timers, or services;
- the machine definition;
- application migration metadata.

`resume` reconstructs runtime ownership from logical state only:

- no historical entry, transition, completion, eventless, raise, or emit work
  is replayed;
- completion and history records survive but do not retrigger `onDone`;
- active-state invokes start once in ordinary ancestor/document order with
  `Machine.InitialEvent`;
- `invokeEffect` restarts, `invokeMachine` creates a fresh child from its normal
  initial state, and `Machine.after` restarts its complete duration;
- inactive invokes, spawned children, child snapshots, elapsed timer time, and
  prior `RuntimeSnapshot` status/errors are not restored;
- a final logical snapshot creates an immediately completed ref;
- `resume` itself does not evaluate `always` or `onDone`, including transitions
  newly enabled by a changed machine definition. Later events use ordinary
  planning semantics.

Use `AtomMachine.resume(machine, decoded)` or
`AtomMachine.bind(runtime).resume(machine, decoded)` for the same contract in a
lazy atom bridge. Registry disposal stops the fresh invokes and timers exactly
as it does for `AtomMachine.make`.

This is not durable runtime restoration. `ClusterMachine` has a separate
checkpoint/planning contract and process-local restrictions; do not substitute
`Machine.resume` for cluster recovery.

## Testing machine semantics

Import planner testing tools from the dedicated entrypoint:

```ts
import { MachineTest } from "@typeonce/effect-machine/testing"
```

Use three distinct layers:

1. `MachineTest.verify(machine, trace)` checks structural statechart and
   planner lifecycle laws.
2. `MachineTest.assertInvariants(machine, trace, laws)` checks application
   semantics such as conservation, authorization, and exact state updates.
3. Runtime command models check executed actions, invokes, timing, process
   publication, and cancellation. Planner traces do not execute this work.

Define semantic laws with a machine-bound builder so the callback receives the
exact state and event types:

```ts
const invariant = MachineTest.invariants(machine)

const laws = [
  invariant.state("balance is never negative", ({ snapshot }) =>
    snapshot.value.balance >= 0 || "negative balance"),
  invariant.step("withdrawal is exact", ({ before, event, after }) =>
    event._tag !== "Withdraw" ||
    after.value.balance === before.value.balance - event.amount),
  invariant.trace("all inputs were planned", ({ trace }) =>
    trace.steps.length === trace.scenario.events.length)
]
```

State laws observe settled states by default. Select `"microsteps"`, `"all"`,
or `"final"` only when the law requires that evidence. A `when` condition with
no matches is explicitly `untested`; use
`require: { minObservations: 1 }` when the current trace must exercise it.
Prefer `assertInvariants` inside FastCheck properties because it succeeds with
`void`. Use `checkInvariants` when the test needs the per-law report.

For systematic planner exploration, provide a finite abstraction explicitly:

```ts
const explored = yield * MachineTest.explore(machine, {
  events: ({ snapshot }) => eventRepresentatives(snapshot),
  stateKey: ({ snapshot }) => logicalStateKey(snapshot),
  limits: { maxDepth: 20, maxStates: 1_000 },
  invariants: laws
})
```

The event callback returns concrete representatives, not schemas or
arbitraries. Include meaningful boundary values based on the current snapshot.
The key defines which snapshots are treated as equivalent; it must retain every
piece of data that can change the future behavior being tested. A coarse key
can make exploration finite but under-approximate behavior.

`assertReachable` returns the shortest witness. `assertUnreachable` succeeds
only when `explored.completeness` is `Complete`. Never interpret a truncated
depth, state, or transition frontier as an unreachability proof. The explorer
retains cycles as graph edges but does not enumerate every path around them;
use a separate temporal/path model when a law depends on repeated traversal
rather than logical-state reachability.

Do not encode application invariants as guards merely to make them testable.
Keep ordinary TypeScript branching in transition handlers unless a choice is
part of the statechart topology. Invariants independently verify the resulting
trace without changing production transition selection.

### Live event causality

Use a probe when a test must establish that one event was processed by a
running statechart rather than merely accepted by its mailbox:

```ts
const ref = yield * Machine.start(machine)
const probe = yield * MachineTest.probe(machine, ref)
const step = yield * probe.sendAndAwait(event)
```

Inspect `step.before`, `step.after`, `step.plan`, `step.handled`, and
`step.configurationChanged`. An ignored event has `handled: false` and an
empty microstep list, but still completes its acknowledgement. A targetless
handler has `handled: true` even if its before and after snapshots are equal.

Do not use a probe as a substitute for a domain completion event. The
acknowledgement covers the submitted event's synchronous macrostep, state
commit, emissions, and invoke startup; it does not wait for an invoke or timer
to complete. Application code should continue to use `MachineRef.send`.

For generated runtime command sequences, select delivery behavior by name:

```ts
yield* MachineTest.runCausalCommands(probe, commands, causalModel)
yield* MachineTest.runEnqueuedCommands(ref, commands, enqueueModel)
```

Prefer `runCausalCommands` for semantic and reference-model properties. Every
accepted send produces a `SendProcessed` result containing its exact
`ProbeStep`, including ignored and targetless events. A machine processing
error fails that exact command and retains its checked prefix for shrinking.
The next command does not begin until the submitted send's managed macrostep
has completed.

Use `probe.await.until(predicate)` in a causal model step only when the
assertion also requires later timer, invoke, or child activity. It observes the
current runtime snapshot before waiting for subsequent publications, so it
does not miss work that completed immediately after the causal boundary.

Use `runEnqueuedCommands` only when outstanding mailbox work is intentional,
such as burst ordering and queue behavior. Its `RuntimeSynchronization`
policies observe public snapshots but do not turn send acceptance into causal
completion. Do not use the deprecated `runRuntimeCommands` name in new code;
it is an alias for enqueue behavior and hides that important distinction.

## Common compiler errors

### `initial` is not callable

Wrap the initial builder result:

```ts
initial: () => States.initial.Idle(new Idle({}))
```

### Invoked child output must be a machine event

Add the output's tagged schema to the parent machine's `internalEvents` array,
or map/ignore the output before it reaches the parent.

### Invoked child emits events not accepted by the parent

Add the child's emitted schemas to the parent machine's `internalEvents` array:

```ts
events: [Submit],
internalEvents: [...ChildMachine.emits]
```

### An internal event is rejected by `send`

This is intentional. Public input boundaries accept only schemas declared in
`events`. Handle the event as an invoke result, child delivery, or raised event;
move it to `events` only if external callers should genuinely be allowed to
send it.

### Public and internal event tags overlap

Give the cases distinct `_tag` values. The split is a protocol boundary, so one
tag cannot be both externally sendable and machine-local.

### Missing output implementation

An output schema is a runtime contract, not an optional annotation. Add the
corresponding nested handler:

```ts
Done: {
  output: ({ state }) => state.value
}
```

Keep `type: "final"` and `output: Schema...` in the state definition; do not
repeat the final marker in this handler.

### `type: "final"` is rejected by `handle`

Move it to `Machine.defineStates`. Definitions own statechart topology;
handlers own behavior.

### Parent property does not exist

Use its full path:

```ts
parents["Route.Ready"]
```

### Child descriptor types are unrelated

Use the descriptor exported by the module that configured `invokeMachine`.
An independently created descriptor with the same id and machine identity also
matches; the same id paired with a different machine remains a distinct child.

### Child atom start error defaults to `unknown`

`ChildMachineAtom<Child>` is suitable for a general boundary because its startup
error defaults to `unknown`. Atoms created with an `AtomRuntime<R, E>` include
`E` in their startup error type. Use `ChildOf<ParentAtom, Child>` to infer that
exact channel from a parent instead of restating it manually.

### Handler tree reaches a compiler instantiation limit

`effect-machine` does not impose a fixed handler-tree depth. Inference follows
the nested handler object until TypeScript reaches its normal, shape-dependent
compiler resource or instantiation limits.

## Unsupported and intentionally imperative features

The current API does not include:

- declarative first-class guards;
- a complete inspectable graph for arbitrary transition Effects.

Use ordinary TypeScript conditions for guards and `Machine.after` for
state-scoped timers. Do not invent undocumented state-node properties such as
`guard`.
