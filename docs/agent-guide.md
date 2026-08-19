# Effect Machine agent guide

This is the model-facing reference for the currently published
`@typeonce/effect-machine` API. Prefer these patterns over reconstructing the API
from its internal implementation.

## Design priorities

Prefer, in order: compile-time type safety, explicit and opinionated semantics,
readable and concise machine models, and alignment with Effect core. Convenience
must come from builders and inference rather than ambiguous omissions or weaker
contracts. The package is pre-1.0, so improve or remove an existing API when a
clearer long-term design replaces it; do not preserve an inferior design with
aliases by default.

Keep the core machine model local. Before adding a public name or capability,
check Effect's existing modules and especially Cluster. Distributed identity,
placement, discovery, transport, routing, delivery, sharding, and remote
lifecycle belong to Cluster; expose integration through an explicit adapter
instead of creating a similar local abstraction with different semantics.

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

1. Domain schemas used by state, and by event fields when they are shared.
2. `Machine.states`, using a tagged state union and `.cases` when state
   schemas need to be reused.
3. `Machine.events`, `Machine.internalEvents`, `Machine.emittedEvents`, and any
   protocol passed to `Machine.parent` or `Machine.optionalParent`; pass
   `Schema.TaggedUnion({...})` or tagged classes directly.
4. `Machine.make({...}).handle({...})`.
5. Child descriptors, then runtime, Atom, or Cluster adapters.

`Machine.make` returns a reusable definition. Each `handle` call creates one
independent machine implementation and the result does not expose `handle`
again. Put one implementation's complete behavior in a single handler tree;
call `handle` again on the original definition for a separate production,
testing, or simulation variant.

`Schema.TaggedUnion` avoids one class declaration per case:

```ts
const State = Schema.TaggedUnion({
  Idle: {},
  Saving: { draft: Draft },
  Failed: { message: Schema.String }
})

const States = Machine.states(State.cases)
export const Event = Machine.events(
  Schema.TaggedUnion({
    Save: {}
  })
)
export const Internal = Machine.internalEvents(
  Schema.TaggedUnion({
    Saved: { id: Schema.String },
    SaveFailed: { message: Schema.String }
  })
)
```

Pass these descriptors to `Machine.make`; the event descriptor is the public
handle, so do not introduce a tagged-union binding used only by an event helper.
Construct new state values through the target or initial
builder's `.from(...)` method. Both event constructors and state `.from(...)`
defer schema construction until planning, so validation failures remain typed
machine errors. Use
`Schema.TaggedClass` when a case needs class methods or nominal class identity;
the deferred constructors preserve that identity after decoding.

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
  an invoked Effect, logic process, or child machine and handle its lifecycle
  with `onDone`, `onFailure`, and `onSnapshot`.
- Put data on the narrowest state where it is valid. Put data shared by sibling
  phases on their compound parent.
- Declare finality only in the state definition. Do not put `type: "final"` in
  a handler.
- Every declared output schema needs a matching handler implementation before
  planning or execution.
- Handler `ancestors` keys are full dotted paths.
- Invoke lifetimes follow state entry and exit, not the spelling of the target
  builder.
- Handle every typed invoked Effect failure with `onFailure`. Defects and
  interruption terminate the owning machine.
- Reuse an exported child descriptor for inline invocation, `sendTo`, and child
  lookup. Independently constructed descriptors are equivalent only when both
  their id and machine identity match.
- `events` is the public machine-input protocol. `internalEvents` contains
  machine-local raised events. `parent: Machine.parent(events)` requires an
  owner, while `parent: Machine.optionalParent(events)` permits a root and
  exposes an optional owner. `emittedEvents` describes outward ephemeral
  notifications and is never delivered implicitly to a parent.
- Event tags in `events` and `internalEvents` must be disjoint.
- Event tags must also be unique within each protocol list.

## Canonical API choices

Choose one helper from the intent, and reach for the lower-level form only when
its extra control is required:

- Bind a shared Atom runtime once with `AtomMachine.bind(runtime)`, then use the
  returned `make` or `resume`. Use `AtomMachine.make(machine)` and
  `AtomMachine.resume(machine, snapshot)` for service-free machines.
- Use one invocation object: `effect` for one-shot work, `stream` for repeated
  externally produced values, `after` for a timer, `logic` for reusable process
  logic, and `child` for a complete child
  statechart. `Machine.invoke({...})` preserves owner state and source channels
  across sibling lifecycle handlers. Inside `.handle(...)`, `self` and any
  declared `parent` use the owning definition's exact protocols; no intermediate
  definition method is required.
- Use `Machine.child(id, machine)` for a complete statechart descriptor and
  `Machine.childAddress<Event>(id)` for a low-level process address. A logic
  invocation is addressable only when `Machine.invoke` receives that
  address explicitly.
- Use the callback's `enqueue` argument for `raise`, `emit`, `sendTo`, and
  `stop`. These operations record closed machine commands and do not run Effects.

## Atomic, compound, parallel, and history states

### Inline topology by default; extract only repeated states

Prefer writing the complete topology inline in `Machine.states`. A one-off
compound or parallel area is easier to understand in place, and extracting it
does not improve its types. Use `Machine.state` only when the same active state
definition is mounted more than once. Tagged schemas are already reusable and
do not need `Machine.state`.

```ts
type TeamSlot = 1 | 2 | 3 | 4 | 5 | 6

const TradingSlot = Machine.state({
  initial: "Idle",
  states: {
    Idle: {},
    InSession: State.cases.InSession,
    Applying: State.cases.Applying
  }
})

const States = Machine.states({
  root: {
    type: "parallel",
    states: {
      trading: {
        type: "parallel",
        states: {
          slot1: TradingSlot,
          slot2: TradingSlot,
          slot3: TradingSlot,
          slot4: TradingSlot,
          slot5: TradingSlot,
          slot6: TradingSlot
        }
      },
      // Other explicit regions stay visible here.
    }
  }
})
```

`Machine.state` accepts one active atomic, compound, or parallel node. It
checks child keys and the compound `initial` at the reusable definition. It is
not a second model builder, does not define handlers, and does not accept
history or choice nodes as roots. `Machine.states` remains the complete model
boundary and captures every mount independently.

For a finite family of paths, bind the template to that definition instead of
maintaining a parallel string table:

```ts
const inSessionPath = <const Slot extends TeamSlot>(slot: Slot) =>
  States.path(`root.trading.slot${slot}.InSession`)

States.matches(snapshot, inSessionPath(slot))
AtomMachine.matches(machineAtom, inSessionPath(slot))
```

`States.path` is a compile-time identity helper. It accepts a literal or a
finite template-literal union only when every member is an active path in this
tree. Renaming a slot or child therefore breaks the path helper at its
definition rather than leaving a stale catalog.

Use the definition-bound snapshot type when a query genuinely needs the full
machine snapshot:

```ts
const offeredIfSlot = (
  snapshot: Machine.Snapshot<typeof States>,
  slot: TeamSlot
) =>
  !States.matches(snapshot, inSessionPath(slot))
```

Do not derive this type with `Parameters<typeof States.get>[0]`; that depends
on overload order and does not express ownership by the state definition.

An active state does not need a schema unless it owns data. Omit `schema` for
control-only atomic, compound, parallel, and final states:

```ts
const States = Machine.states({
  Idle: {},
  Form: {
    initial: "Editing",
    states: {
      Editing: {},
      Saving: State.cases.Saving
    }
  }
})

initial: (to) => to.Form.initial.resolve(({ target }) => target((form) => form.Editing.from()))
```

Schema-less states have the same control semantics as schema-backed states:
they are active, targetable, matchable, receive lifecycle handlers, and appear
in snapshots. They do not have a state value:

```ts
Idle: {
  on: {
    Start: (to) =>
      to.full.Form.initial.resolve(({ state, target }) => {
        // state: undefined
        return target.from((form) => form.Editing.from())
      })
  }
}

States.matches(snapshot, "Form")              // allowed
States.getSnapshot(snapshot, "Form")          // allowed
States.get(snapshot, "Form")                  // type error: no value schema
```

For a schema-less path, builders expose only `.from(...)`; the direct callable
form is reserved for already-decoded schema values. Structural ancestors are
also omitted from `ancestors`; an immediate structural containing state is
typed as `undefined`. Add `schema` when a state begins to own data or needs runtime
validation and persistence for that data.

Use an atomic state when no child phase can be active beneath it.

Use a compound state when exactly one child phase is active. It must declare an
`initial` child:

```ts
const FormState = Schema.TaggedUnion({ Saving: { draft: Schema.String } })

const FormStates = Machine.states({
  Form: {
    initial: "Editing",
    states: {
      Editing: {},
      Saving: FormState.cases.Saving
    }
  }
})
```

Use a parallel state when every direct region is active:

```ts
const ParallelStates = Machine.states({
  Screen: {
    type: "parallel",
    states: {
      network: {
        initial: "Online",
        states: {
          Online: {},
          Offline: {}
        }
      },
      panel: {
        initial: "Closed",
        states: {
          Closed: {},
          Open: {}
        }
      }
    }
  }
})
```

Every parallel region needs an active state in initial and full snapshot
builders. The same rule applies when a local or branch target enters an
inactive nested parallel state.

Use `type: "final"` for a terminal leaf in `Machine.states`. A final
child completes its compound parent. Put `onDone` on that completed parent,
never on the final leaf. The definition owns the output schema and the handler
computes its value:

```ts
const States = Machine.states({
  Done: {
    schema: State.cases.Done,
    type: "final",
    output: Schema.String
  }
})

const machine = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: (to) => to.Done().resolve(({ target }) => target.from())
}).handle({
  Done: {
    output: () => "done"
  }
})
```

Do not repeat `type: "final"` in `handle`. Execution APIs reject a machine
until every declared output schema has an implementation.

Enter a compound or parallel state through its declared initial configuration
with `.initial`. This is available on top-level state methods under
`target.full` and compatible nested state methods under `target.local` and
`target.branch`; atomic and final state methods do not expose it:

```ts
Open: (to) => to.full.opened.initial.resolve(({ target }) => target.from({ teamId: "team-1" }))
```

The definition-time `.initial` property is a topology value. The exact
resolver `target` is still a callable runtime builder.

The selected state's own value is passed directly to `initial(value)` or
constructed inside planning with `initial.from(input)`. A structural selected
state uses `initial()`.

When a declared initial child owns a schema, its parent implements
`initialize`. The context's `builder` is already bound to that child, so it
cannot accidentally select a state that differs from the definition:

```ts
opened: {
  initialize: ({ state, builder }) =>
    builder.from({ requestId: state.requestId })
}
```

A parallel initializer supplies every schema-valued direct region with a
fluent completion builder. Structural regions are omitted:

```ts
dashboard: {
  initialize: ({ builder }) =>
    builder.filters.from({ query: "" }).results.from({ page: 1 })
}
```

Default entry then continues recursively. Nested compound and parallel owners
provide their own `initialize` implementations. Missing implementations and
incomplete parallel builders are reported at `handle(...)`. Builder `.from`
inputs are decoded by the machine, so schema failures remain typed machine
failures. An explicit snapshot target that manually selects all children does
not use `initialize`.

Declare a history pseudo-state below the active parent whose configuration it
should remember. It has no schema, is excluded from active state identifiers,
and is addressed only through `target.history`:

```ts
const States = Machine.states({
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
Resume: (to) => to.history.checkout.exact.resolve(({ target }) => target())
```

Each declared history leaf is a topology value; the resolver's selected
history builder remains callable to construct restoration evidence.

Deep history restores the complete remembered subtree and its decoded values.
Shallow history restores only parent and direct-child values. If the remembered
child is compound, its configured initial child needs a freshly constructed
value, so implement `initialize` only on paths required by shallow history:

```ts
payment: {
  initialize: ({ state, builder }) =>
    builder.from({ cardNumber: `attempt-${state.attempt}` })
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
        target.App.from({ workspaceId: "default" }, (app) =>
          app.Workspace.from((workspace) => workspace.Editing.from()))
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
prior effects, machine instances, and timers are not rewound.

## Choosing a target

| Builder          | Use it when                                                                | What it preserves                                                                 |
| ---------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `target.local`   | The destination is inside the nearest compound scope containing the source | The compound value, active ancestors, and unrelated parallel regions              |
| `target.branch`  | The destination is elsewhere under the active top-level root               | Omitted current ancestor values and parallel regions                              |
| `target.full`    | The destination may be under any top-level root                            | Nothing is inferred for a newly selected root; build its complete active snapshot |
| `target.history` | The destination is a declared history pseudo-state                         | Its parent's remembered configuration, or a source-independent complete default containing that owner before the first capture |

Definition-time instructions that only identify topology are values:
`to.none`, `to.full.Flow.initial`, `to.history.Flow.recent`, and
`to.local.with`. State and choice destinations remain calls, such as
`to.full.Running()` and `to.local.Routing()`, because those calls select the
node. Resolver-time builders also remain callable because they construct and,
for named branches, brand runtime evidence such as `select.unchanged()`.

Use `to.local.with` when a descendant transition updates the nearest
schema-backed compound value while retaining that same compound scope:

```ts
Play: (to) =>
  to.local.with.resolve(({ containingState, target }) =>
    target.from({ ...containingState, playing: true }, (flow) => flow.Playing.from()))
```

Entering an inactive parallel state through `target.local` or `target.branch`
requires a complete callback with one selection per region. A parallel state
that is already active remains partially addressable through `target.branch`;
unmentioned active regions are preserved.

These describe configuration construction, not automatic process restart.
Machine planning compares active paths and derives the actual exit and entry
sets. A `target.full` result with the same active paths can update values without
exiting shared states. To force the source to exit and enter again:

```ts
Refresh: (to) =>
  to.full.Ready().resolve(({ state, target }) => target.from({ value: state.value }), { reenter: true })
```

When no resolver is needed, use the selected target directly and append
`.reenter()` only when restart semantics are intentional:

```ts
Finish: (to) => to.full.Done()
Restart: (to) => to.none.reenter()
```

Do not use `target.full` merely because it is easiest to discover. Prefer the
narrowest builder that expresses the intended configuration change.

Every state builder method has two construction forms:

```ts
target(decodedReady)
target.from({ value: event.value })
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
target.from()
target.from((flow) => flow.Idle.from())
```

This shorthand also applies to schemas whose constructor fields are all
optional or defaulted. It does not make required fields optional. Compound and
parallel builders still require a callback selecting their active child or
every active region. Omitted input is normalized to `{}` and still passes
through `schema.makeEffect`, including refinements.

## Reading state and structural ancestors

`Machine.states` returns typed helpers:

```ts
States.get(snapshot, "Route.Ready")
States.getWithParents(snapshot, "Route.Ready.Editing")
States.getSnapshot(snapshot, "Route.Ready")
States.matches(snapshot, "Route.Ready.Saving")
```

Snapshots returned by `getSnapshot` can be queried again with `get`,
`getSnapshot`, or `matches`. Paths remain absolute and are restricted to the
extracted snapshot and its descendants:

```ts
const ready = Option.getOrThrow(States.getSnapshot(snapshot, "Route.Ready"))
States.matches(ready, "Route.Ready.Saving")
```

All paths are checked against the definition. `get` and `getWithParents` accept
only schema-backed paths; use `matches` or `getSnapshot` for any active path.
`context.containingState` is the immediate typed state value (`undefined` at a
root or when that state is schema-less). `context.ancestors` contains only
valued structural ancestors. This is separate from `context.parent`, which is
present only when declared by the machine. `Machine.parent` makes it a required
owning-machine target; `Machine.optionalParent` makes it a target or
`undefined`. Use full state paths when another ancestor value is needed:

```ts
ancestors["Route.Ready"]
ancestors["Route.Ready.Editing"]
```

Do not guess short properties such as `ancestors.Ready`.

### Inspecting the full transition configuration

Event, `always`, and `onDone` transition contexts include a fully typed
`snapshot`. It is the complete logical snapshot at the beginning of that
microstep, before any selected transition is applied:

```ts
BufferReady: (to) =>
  to.branches({
    online: { target: to.local.Playing() },
    unchanged: { target: to.none }
  }).resolve(({ snapshot, select }) =>
    States.matches(snapshot, "Player.Network.Online")
      ? select.online.from()
      : select.unchanged()
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

When sibling state payloads share fields, destructure away the source
discriminator and construct the destination through its target builder:

```ts
Submit: (to) =>
  to.local.Saving().resolve(({ state, target }) => {
    const { _tag: _, ...fields } = state
    return target.from({ ...fields, attempt: 1 })
  })
```

The target schema remains responsible for defaults, transforms, refinements,
and class identity. Prefer moving broadly shared data to the compound parent
rather than copying it through every phase.

## Planning, actions, raised events, and emissions

A transition declares every possible branch and resolves the selected target
synchronously:

```ts
Submit: (to) =>
  to.branches({
    valid: { target: to.local.Saving() },
    invalid: { target: to.none }
  }).resolve(({ state, select }) => state.valid
    ? select.valid.from({ draft: state.draft })
    : select.invalid()
```

Every installed event, `always`, `onDone`, choice, and invoke lifecycle handler
receives a bound `to` selector. A direct transition selects one target and calls
its `resolve` method. A branching transition calls `to.branches` with every
possible target, then uses ordinary TypeScript control flow in `resolve` to return one
typed `select` builder. Branch keys are stable testing and inspection identities;
an optional `title` controls presentation and otherwise defaults to the key.
Selecting a branch whose target is `to.none` handles the transition without a
destination while retaining queued commands, raised events, and emitted events.

Set `declinable: true` only when the resolver may decide that its transition is
not enabled. The flag adds a typed `decline()` capability to that resolver and
permits its opaque result:

```ts
Submit: (to) =>
  to.branches({
    accepted: { target: to.local.Saving() },
    consumed: { target: to.none }
  }).resolve(({ event, select, decline }) => {
    if (!belongsToThisState(event)) return decline()
    return event.consume ? select.consumed() : select.accepted.from()
  }, { declinable: true })
```

Declining discards that resolver's enqueue buffer and resumes hierarchical
event or eventless selection at the next eligible ancestor. If no candidate
accepts, the trigger is unhandled. This is deliberately different from
`to.none`, which consumes the trigger. `decline()` is absent and its result is
rejected unless the literal flag is present. Choice and initial routing remain
total and cannot decline. Static inspection exposes the distinction through
`TransitionDefinition.acceptance` without executing resolver code. Completion
and invocation outcomes have no ancestor candidate; declining one ignores that
lifecycle occurrence and leaves the current configuration active.

The `branches` callback runs once when handlers are installed. Its record uses
the deterministic ECMAScript property order for presentation and `branchIndex`;
array-index and symbol keys are rejected. Treat the string key as semantic:
reordering named properties may change their display index, but visualizers,
coverage, and trace verification identify each branch by its key.

`reenter: true` remains meaningful with `to.none`: the source exits and
enters again while its logical configuration is retained.

Closed statechart and machine operations use `enqueue`:

```ts
Submit: (to) =>
  to.local.Saving().resolve(({ target }, enqueue) => {
    enqueue.emit(Emissions.SaveRequested())
    return target.from()
  })
```

Declare emission constructors separately from machine inputs:

```ts
const Emissions = Machine.emittedEvents(SaveRequested, AuditRecorded)

const definition = Machine.make({
  events: Commands,
  internalEvents: InternalEvents,
  emittedEvents: Emissions,
  // ...
})
```

`enqueue.raise(...)` is a same-macrostep input to self. `enqueue.sendTo(...)`
targets a machine mailbox and is processed later. `enqueue.emit(...)` is neither:
it publishes a one-off outward notification. Observe it with
`ref.emissions`, a hot non-replayed `Stream` that completes with the machine.
`ref.changes` is stateful and begins with the current lifecycle snapshot.
Use `Machine.prepare(machine)` to obtain `changes` and `emissions` before
initialization. Subscribe to the desired stream and then evaluate
`prepared.start`. `Machine.start(machine)` remains the one-step convenience
when startup observation is unnecessary. Emissions are still never retained or
replayed; state remains the representation for facts that must be retained.

```ts
const prepared = yield* Machine.prepare(machine)
yield* prepared.emissions.pipe(
  Stream.runForEach(handleEmission),
  Effect.forkScoped({ startImmediately: true })
)
const ref = yield* prepared.start
```

`prepared.inspection` is a third, operational stream. It covers the root and
its complete local ownership tree rather than one machine protocol. Subscribe
before `prepared.start` when creation and initialization records matter:

```ts
const prepared = yield* Machine.prepare(machine)
yield* prepared.inspection.pipe(
  Stream.runForEach((event) => Console.log(event.sequence, event.subject.id, event._tag)),
  Effect.forkScoped({ startImmediately: true })
)
const ref = yield* prepared.start
```

`Machine.Inspection.Event` is a closed union:

- `Created`, `Initialized`, and `StartFailed` describe process startup;
- `EventSent` records accepted mailbox delivery and `EventProcessed` records
  the committed macrostep, including retained transitions, raised events,
  emissions, commands, and entry/exit paths for each microstep;
- `StateChanged` describes direct updates made by generic `Logic`;
- `Emitted` records actual outward notification publication;
- `ActivityStarted` and `ActivityStopped` describe Effect and timer invokes;
- `Terminated` carries the final `done`, `error`, or `stopped` snapshot.

Every record has a root-local `sequence`, `rootSessionId`, and `subject`.
`deliveryId` correlates acceptance with processing; `macrostepId` correlates
work caused by one statechart input. `source` is present for sends originating
inside the inspected tree. `origin` distinguishes a root, state-owned invoke,
and explicit spawn. Child machine and generic process protocols are erased to
`unknown` because one stream can contain unrelated types.

Inspection is hot, non-replayed, never fails, and completes with the prepared
root. It is not a replacement for `changes`, which retains the latest lifecycle
snapshot, or `emissions`, which remains the typed domain-notification channel.
Invalid decoded inputs or emissions still fail the owning machine through its
typed `MachineSchemaDecodeError`; inspection never turns validation into a
throw or a stream failure.

Session ids are deterministic and unique only inside one prepared local tree
(`machine:0`, `machine:1`, ...). Do not persist them as globally unique actor
ids. Distributed identity, placement, delivery, and request correlation belong
to Effect Cluster and its entity, runner, shard, and request identifiers. A
Cluster adapter may translate local inspection records into telemetry, but the
core machine stream does not claim cross-node identity or ordering.

For child-to-parent input, export a public builder protocol and reuse it at both
composition boundaries:

```ts
export const ParentEvents = Machine.events(ChildFinished)

const child = Machine.make({
  events: ChildEvents,
  parent: Machine.parent(ParentEvents),
  // ...
}).handle({
  Working: {
    on: {
      Finish: (to) =>
        to.none.resolve(({ parent }, enqueue) => {
          enqueue.sendTo(parent, ParentEvents.ChildFinished())
        })
    }
  }
})

const parent = Machine.make({
  events: Machine.events(ParentCommands, ParentEvents),
  // ...
})
```

Invoking the child under a parent that lacks any required parent event is a
type error. Within child handlers, `parent` accepts only that protocol and is
not optional. Root APIs reject the machine. Use
`Machine.optionalParent(ParentEvents)` instead when the same definition must
also run as a root; then `parent` is optional. With no declaration, callbacks
have no `parent` property. `self` accepts the machine's public inputs. Both
targets are minimal `MachineTarget<Event>` values. Neither machine target is a
structural state value; use
`containingState` and `ancestors` for statechart ancestry.

Atom-backed machines retain the same transient semantics. Use
`AtomMachine.emissions(machineAtom)` for a root and
`AtomMachine.childEmissions(childAtom)` for the currently active child. Both
return streams requiring the corresponding `AtomRegistry`; emissions are not
stored as atom state.

Use `AtomMachine.inspection(machineAtom)` for root-scoped operational records.
It installs the subscription before a fresh bridge starts, so initialization,
owned children, and activities are visible without storing inspection records
in atom state.

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
const Events = Machine.events(
  Schema.TaggedUnion({
    Save: {}
  })
)
const InternalEvents = Machine.internalEvents(
  Schema.TaggedUnion({
    Saved: { id: Schema.String },
    SaveFailed: { message: Schema.String }
  })
)

const definition = Machine.make({
  states: States.states,
  events: Events,
  internalEvents: InternalEvents,
  initial: (to) => to.Idle().resolve(({ target }) => target.from())
})
```

Use the protocol-bound constructors at every machine delivery boundary:

```ts
yield* ref.send(Events.Save())
enqueue.raise(InternalEvents.Saved({ id: "entry-1" }))
```

`Machine.events` exposes only public constructors;
`Machine.internalEvents` exposes only machine-local constructors. Both flatten
configured tagged unions and preserve tagged classes, finite discriminator
unions, required inputs, and constructor defaults. A constructor returns an
opaque instruction whose `_tag` is available for activity metadata. Its decoded
fields are intentionally unavailable until the owning machine processes it.

Invalid constructor input fails `Machine.plan` or the running machine with
`MachineSchemaDecodeError`; creating the instruction itself never performs
schema validation. APIs that explicitly retain decoded events, such as manual
model-testing scenarios or transport messages, can receive complete event
objects directly.

An open discriminator such as `_tag: Schema.String` cannot produce named
constructors because its tag set is not finite. The schema still participates
in the protocol; pass a complete event object at the delivery boundary.

Use the exported utility types when another API must preserve the boundary:

```ts
type PublicEvent = Machine.Machine.InputEvent<typeof definition>
type AnyHandledEvent = Machine.Machine.Event<typeof definition>
```

`MachineRef.send`, `machineAtom.send`, and `Machine.plan` accept decoded public
events or constructions returned by `Machine.events`. Transition handlers
receive only decoded events. Raised events additionally accept constructions
from `Machine.internalEvents`; outward notifications accept constructions from
`Machine.emittedEvents`. The
local planner and runtime intentionally share the complete decoder to support
those internal deliveries, so JavaScript or `any` can bypass the local public
distinction.
Cluster RPC payloads are additionally decoded against the public `events`
schemas at the transport boundary. Never repeat an `_tag` within a list or
across both configuration lists.

## Recoverable state-scoped work

Use `Machine.invoke` with an `effect` for one-shot work. Lifecycle callbacks
receive the typed Effect channels and can transition directly:

```ts
invoke: Machine.invoke({
  id: "save",
  effect: () => SaveService.save(draft),
  onDone: (to) => to.full.Saved().resolve(({ output, target }) => target.from({ entry: output })),
  onFailure: (to) =>
    to.full.SaveFailed().resolve(({ error, target }) => target.from({ message: error.message }))
})
```

The owning state scopes the child. Owner-driven interruption on state exit is
normal cancellation and stale output is ignored. An Effect that defects or
self-interrupts fails the parent. `onDone` is required when the output is not
`never`; `onFailure` is required when the typed error is not `never`. Handlers
are forbidden when their channel is `never`.

The source may also be a function of the owning state's entry context when it
needs `state`, `containingState`, `ancestors`, or the entry `event`. Source construction
errors, defects, and interruption are machine failures rather than a second
phase in `onFailure`.

Use a Stream invocation for repeated values that are not themselves machine
events. `onElement` maps each value into an owner transition, while `onDone`
handles normal Stream completion and `onFailure` handles the typed Stream error:

```ts
invoke: Machine.invoke({
  id: "broadcast-channel",
  stream: () => messages,
  onElement: (to) =>
    to.none.resolve(({ element }, enqueue) => {
      enqueue.raise(Events.MessageReceived({ message: element }))
    }),
  onDone: (to) => to.none,
  onFailure: (to) => to.full.Disconnected().resolve(({ error, target }) => target.from({ error }))
})
```

Element delivery is owner-scoped and backpressured: the Stream pulls again only
after the selected parent macrostep commits. Exiting or reentering the owner
interrupts the Stream and runs its finalizers. A later entry starts a fresh
Stream. Stream defects and self-interruption fail the owning machine.

Use `to.none` when a transition keeps the current configuration. Call
`to.none.resolve(...)` when it also enqueues commands; a block resolver may
omit its return because it is contextually typed to return `undefined`.

When a source function reads `state`, `containingState`, `ancestors`, or the entry `event`,
`Machine.invoke` infers that owner context and the returned Effect's output,
error, and service channels together. No return annotation is needed:

```ts
invoke: Machine.invoke({
  id: "load",
  effect: ({ state }) => LoadService.load(state.userId),
  onDone: (to) => to.full.Loaded().resolve(({ output, target }) => target.from({ user: output })),
  onFailure: (to) => to.full.LoadFailed().resolve(({ error, target }) => target.from({ error }))
})
```

Inside `.handle(...)`, the constructor receives the owning machine's public
input and declared parent protocol contextually. Sources and lifecycle handlers
can send through `self` and `parent` without naming the definition:

```ts
const machine = Machine.make({
  events: Commands,
  internalEvents: InternalEvents,
  parent: Machine.parent(ParentEvents),
  // ...
}).handle({
  Saving: {
    invoke: Machine.invoke({
      id: "notify-parent",
      effect: () => saveDocument,
      onDone: (to) =>
        to.none.resolve(({ parent, self }, enqueue) => {
          enqueue.sendTo(self, Commands.Save())
          enqueue.sendTo(parent, ParentEvents.ChildFinished({ id: "job-1" }))
        }),
      onFailure: (to) => to.none
    })
  }
})
```

The standard `Machine.invoke(...)` form retains the owning machine protocols
even when the definition is named separately. A direct `invoke: { ... }` object
remains available when lifecycle handlers do not need source-derived context.

A cancellable timer uses the same object:

```ts
invoke: Machine.invoke({
  id: "clear-status",
  after: "3 seconds",
  onDone: (to) => to.full.Clear().resolve(({ target }) => target())
})
```

The timer starts on state entry and is interrupted on exit. Its `onDone` is
always required. `effect: () => Effect.sleep(...)` has the same scoped
cancellation behavior, but `after` records timer intent and exposes a static
duration through `Machine.activityDefinitions`. Effect sources are always
factories evaluated when their state is entered. For reusable process logic,
provide `logic`, a state-local lifecycle `id`, and a typed `address`. TypeScript
checks the address protocol against the logic event protocol. Lifecycle ids and
addresses serve different purposes and must both be explicit.

## Invoked child statecharts

Create a complete child-statechart descriptor:

```ts
const Editor = Machine.child("editor", EditorMachine)
```

Invoke it from its owning state:

```ts
invoke: Machine.invoke({
  child: Editor,
  input: editorInput,
  onDone: (to) => to.full.EditorDone().resolve(({ output, target }) => target.from({ output }))
})
```

Use `Editor` for:

```ts
Machine.sendTo(Editor, EditorEvent.Reset())
parentRef.child(Editor)
parentAtom.child(Editor)
```

Child emissions remain on the child's hot `emissions` stream; they are never
delivered implicitly to the parent. A child sends an input explicitly with
`enqueue.sendTo(parent, ParentEvents.Example())`. `onSnapshot`, `onDone`, and
`onFailure` are direct parent transitions. Invoked child IDs must be unique
while simultaneously active.

Descriptors with the same id and machine identity address the same child, even
when independently constructed. The descriptor objects themselves are not
canonicalized. Prefer exporting one descriptor as the application boundary.
Use the separate
`Machine.childAddress<Event>(id)` constructor only for lower-level process
logic that does not have a complete machine descriptor.

### Inspecting state-owned activities

Use `Machine.activityDefinitions(machine)` to inspect invokes without running
them. Static inline `Machine.invoke` definitions expose serializable ownership
metadata:

```ts
Machine.activityDefinitions(machine)
// [{ source: "Loading", id: "load-timeout", type: "timer",
//    duration: "10s" }]
```

Child machines expose descriptor identity, never their runtime or
implementation. Function-valued sources and durations are represented as
dynamic because inspection must not evaluate user code.

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
AtomMachine.selectSnapshot(machineAtom, "Ready")
AtomMachine.matches(machineAtom, "Ready.Saving")
AtomMachine.selectChild(childAtom, "Editing")
AtomMachine.selectSnapshotChild(childAtom, "Editing")
AtomMachine.matchesChild(childAtom, "Editing")
```

`select` returns only the decoded state value. Use `selectSnapshot` when a
component needs the selected node's compound or parallel child topology.

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
- inline Effects restart, child machines start fresh from their normal initial
  state, and timers restart their complete duration;
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
`step.configurationChanged`. An ignored event, including one for which every
eligible candidate declines, has `handled: false` and an empty microstep list,
but still completes its acknowledgement. A targetless handler has
`handled: true` even if its before and after snapshots are equal.

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

For semantic laws over live execution, bind runtime invariant constructors to
the machine and use the law-oriented causal verifier:

```ts
const invariant = MachineTest.runtimeInvariants(machine)

const laws = [
  invariant.snapshot("balance never becomes negative", ({ snapshot }) =>
    snapshot.state.value.balance >= 0
  ),
  invariant.command("stopped sends are rejected", ({ previous, result }) =>
    previous?.result._tag !== "Stopped" || result._tag === "SendRejected"
  )
]

yield* MachineTest.verifyCausalCommands(probe, commands, { invariants: laws })
```

Do not create a dummy model merely to run runtime laws. Continue to use
`runCausalCommands` when an independent simplified model supplies exact
expected results, then apply the same laws to its returned transcript with
`assertRuntimeInvariants`. Conditional laws that must execute should declare
`require.minObservations` so irrelevant generated commands cannot pass them
vacuously.

Use `assertPlannerRuntimeAgreement(machine, transcript)` only to check the
managed runtime boundary against a fresh pure plan. It is not an independent
business oracle and is intentionally an explicit operation rather than a
generic conformance mode. Combine it with application runtime laws or a
reference model when correctness of the expected behavior matters.

## Common compiler errors

### `initial` requires a static target

Select the initial root separately from constructing its value:

```ts
initial: (to) => to.Idle().resolve(({ target }) => target.from())
```

### Invoked child expects events not accepted by the parent

Export one parent-event protocol from the child boundary and compose it into
the parent's public events:

```ts
export const ChildParentEvents = Machine.events(ChildFinished)

// child-only machine
parent: Machine.parent(ChildParentEvents)

// parent
events: Machine.events(Submit, ChildParentEvents)
```

Use `Machine.optionalParent(ChildParentEvents)` only when the child is also a
valid independent root and narrow `parent` before sending.

### An internal event is rejected by `send`

This is intentional. Public input boundaries accept only schemas declared in
`events`. Handle the event as a child delivery or raised event; move it to
`events` only if external callers should genuinely be allowed to send it.

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

Move it to `Machine.states`. Definitions own statechart topology;
handlers own behavior.

### Parent property does not exist

Use the structural ancestor's full path:

```ts
ancestors["Route.Ready"]
```

### Child descriptor types are unrelated

Use the descriptor exported by the module that configured the child invocation.
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

Use ordinary TypeScript conditions for guards and an inline `Machine.invoke`
with `after` for state-scoped timers. Do not invent undocumented state-node
properties such as `guard`.
