# @typeonce/effect-machine

Schema-first state machines and statecharts for Effect.

State, event, input, output, and persistence boundaries are described with
Effect Schema. The same definition can be planned synchronously, run as a
managed machine, mounted as an Atom, tested as a model, or hosted by the
cluster adapter.

> This is early-release software. Its API may change, and each release targets
> one exact Effect beta.

## Design principles

- **Type-safe by construction:** reject invalid protocols, compositions, and
  capabilities at compile time where possible, and preserve typed Effect
  failures at runtime.
- **Explicit and opinionated:** give different semantics different names and
  contracts. Builders and inference remove ceremony without making behavior
  depend on ambiguous omissions.
- **Readable models:** keep schemas, topology, behavior, and effects concise
  enough that a human can understand the complete model from its definition.
- **Effect-native:** design toward eventual inclusion in Effect core and follow
  its API shape, module boundaries, ownership, and failure conventions.

The package is pre-1.0: a clearer or safer long-term API takes priority over
backward compatibility. Breaking changes use minor releases, compatible fixes
use patch releases, and compatibility aliases are not added by default.

The core machine model remains local. Distributed identity, placement,
transport, routing, delivery, and remote lifecycle semantics belong to Effect
Cluster and are exposed only through explicit integration boundaries.

## Install

```sh
pnpm add @typeonce/effect-machine effect@4.0.0-rc.112
```

`effect` is an exact peer dependency. Install the version above and upgrade it
in lockstep with this package.

## Quick start

Define schemas first, derive the state topology, then add behavior:

```ts
import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema, Stream } from "effect"

const State = Schema.TaggedUnion({
  Running: { count: Schema.Number }
})

const States = Machine.states({
  Idle: {},
  Running: State.cases.Running
})

const CounterEvent = Machine.events(
  Schema.TaggedUnion({
    Start: {},
    Increment: {},
    Stop: {}
  })
)

const CounterDefinition = Machine.make({
  id: "Counter",
  states: States.states,
  events: CounterEvent,
  initial: (to) => to.Idle()
})

const Counter = CounterDefinition.handle({
  Idle: {
    on: {
      Start: (to) => to.full.Running().resolve(({ target }) => target.from({ count: 0 }))
    }
  },
  Running: {
    on: {
      Increment: (to) => to.full.Running().resolve(({ state, target }) => target.from({ count: state.count + 1 })),
      Stop: (to) => to.full.Idle()
    }
  }
})

const program = Effect.gen(function*() {
  const ref = yield* Machine.start(Counter)
  yield* ref.send(CounterEvent.Start())
  yield* ref.send(CounterEvent.Increment())
})
```

`handle` creates a complete implementation boundary. Its result does not
expose `handle`, so all behavior for one machine belongs in the same handler
tree. Reuse the definition when multiple independent implementations are
useful, such as production and testing variants:

```ts
const ProductionCounter = CounterDefinition.handle(productionHandlers)
const TestingCounter = CounterDefinition.handle(testingHandlers)
```

`Machine.start` returns a `MachineRef` with `send`, `state`, `snapshot`,
`changes`, `emissions`, `join`, and `stop`. Sending enqueues an event; observe
`changes` or use the testing probe when work must be causally acknowledged.

## Modeling workflow

Use this order to preserve inference and keep boundaries explicit:

1. Define domain schemas used by state and by shared event fields.
2. Declare topology with `Machine.states`, naming a tagged state union
   when its `.cases` are reused.
3. Create event descriptors with `Machine.events`, `Machine.internalEvents`,
   and `Machine.emittedEvents`, passing tagged unions or tagged classes directly.
4. Create the machine and implement every active state with
   `Machine.make({...}).handle({...})`.
5. Add child descriptors, then runtime, Atom, testing, or cluster adapters at
   the application boundary.

Keep one-off topology inline in `Machine.states`. Use `Machine.state` only when
the same active state definition is mounted more than once; tagged schemas are
already reusable without it. For repeated finite regions, derive names with
`States.path(...)` so every literal in the path family is checked against the
complete tree. Type full-snapshot helpers as `Machine.Snapshot<typeof States>`
or `Machine.Snapshot<typeof machine>`, schema-backed state payloads as
`Machine.Value<typeof States, Path>`, and path-rooted snapshots as
`Machine.SnapshotAt<typeof States, Path>`.

### Make invalid states unrepresentable

Treat topology as a domain contract, not as file organization. A parallel state
declares the full Cartesian product of its regions, so use it only when every
combination has a coherent meaning. If one region must inspect another before
entering a state safely, prefer a compound hierarchy that makes the forbidden
combination impossible. `matches` remains useful for views, tests, and genuine
coordination between independent regions; it should not repair an invalid
state product.

Keep state-scoped Effects beneath the state that guarantees their resources,
and enforce command availability in the machine rather than only by disabling
UI controls. When entering an inactive compound or parallel state's declared
default, select `.initial`; explicitly construct descendants only for a
non-default configuration or a complete replacement of an already-active
parallel root.

### Construct state through builders

Use `.from(...)` when constructing a new state from schema make input:

```ts
target.from({ draft: event.draft })
```

The machine runs these inputs through the state schema while planning. Schema
defaults, transformations, refinements, and tagged-class identity are
therefore preserved, and decode failures remain typed machine failures. This
is the default construction path.

Use `.decoded(...)` when the value is already a `Schema.Type`:

```ts
target.decoded(new Ready({ notice: null }))
```

The machine still validates the value against the schema's type side. It does
not run encoded-input transformations again. State builders are not callable;
the method name always makes the construction mode visible.

When sibling states share fields, remove the source discriminator and pass the
remaining fields through the target schema:

```ts
const handlers = {
  Submit: (to) =>
    to.local.Saving().resolve(({ state, target }) => {
      const { _tag: _, ...fields } = state
      return target.from({ ...fields, attempt: 1 })
    })
}
```

Omit `schema` when a state represents control flow but owns no data. Use `{}`
instead of defining an empty tagged schema:

```ts
const States = Machine.states({
  Form: {
    initial: "Editing",
    states: {
      Editing: {},
      Saving
    }
  }
})

const definition = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: (to) => to.Form.initial.resolve(({ target }) => target.from((form) => form.Editing.from()))
})
```

Schema-less states remain active, targetable, matchable, and visible through
`getSnapshot`, but have no value to read. Their builders expose only `.from`,
their handler `state` is `undefined`, and `get` / `getWithParents` accept only
schema-backed paths. Add a schema later if the state starts owning data.

Keep data-bearing state schemas together in a named `Schema.TaggedUnion` and
reference its cases from the topology. For a standalone state schema whose
class identity is useful, declare a named `Schema.TaggedClass`. Do not bury
one-off tagged schema declarations inside `Machine.states`.

Put data on the narrowest state where it is valid. If sibling phases share
data, put it on their compound parent.

### Separate inputs, raised events, and emissions

`events` is the public machine-input protocol. Events raised to the same machine
belong in `internalEvents`. Ephemeral outward notifications have their own
`emittedEvents` protocol:

```ts
export const CommandEvent = Machine.events(
  Schema.TaggedUnion({ Save: {} })
)
export type PublicCommandEvent = Machine.EventOf<typeof CommandEvent>
const InternalEvent = Machine.internalEvents(
  Schema.TaggedUnion({
    Saved: { id: Schema.String },
    SaveFailed: { message: Schema.String }
  })
)
const Emissions = Machine.emittedEvents(
  Schema.TaggedUnion({
    SaveObserved: { id: Schema.String }
  })
)

const definition = Machine.make({
  states: States.states,
  events: CommandEvent,
  internalEvents: InternalEvent,
  emittedEvents: Emissions,
  initial: (to) => to.Idle()
})
```

Handlers see both protocols. Typed `send` and `Machine.plan` accept only public
events. Event tags must be unique and public/internal tags must be disjoint.

Export the descriptor returned by `Machine.events` instead of exporting its
schemas. This keeps the deferred constructors as the standard way to create
events without exposing schema `.make` methods:

```ts
ref.send(CommandEvent.Save())
enqueue.raise(InternalEvent.Saved({ id: "entry-1" }))
enqueue.emit(Emissions.SaveObserved({ id: "entry-1" }))
```

The returned constructors preserve each schema's make input, including required
fields and constructor defaults. They defer schema construction until delivery,
so invalid values fail planning or the running machine with
`MachineSchemaDecodeError` instead of throwing at the call site.
Schemas with an open discriminator such as `_tag: Schema.String` remain valid
protocols but cannot expose a finite constructor set; pass a complete event
object to `send` or `Machine.plan` for those events.

`ref.emissions` is a hot `Stream`: it publishes only notifications produced
after subscription, replays nothing, and completes when the machine terminates.
Snapshots remain separate and stateful: `ref.changes` begins with the current
lifecycle snapshot and then follows later changes. Use `Machine.prepare` when
an observer must be installed before initial-entry actions run:

```ts
const prepared = yield * Machine.prepare(machine)

yield * prepared.emissions.pipe(
  Stream.runForEach(handleEmission),
  Effect.forkScoped({ startImmediately: true })
)

const ref = yield * prepared.start
```

`Machine.start(machine)` remains the one-step convenience for callers that do
not observe startup emissions. Preparation does not retain or replay an
emission: the observer is simply subscribed before initialization begins.

### Inspect a live machine tree

`Machine.prepare(machine).inspection` is the operational counterpart to the
domain-facing `changes` and `emissions` streams. It observes the prepared root
and every locally owned child, `Logic` process, Effect, and timer in one total
publication order:

```ts
const prepared = yield * Machine.prepare(checkout)

yield * prepared.inspection.pipe(
  Stream.runForEach((record) => Console.log(record.sequence, record.subject.id, record._tag)),
  Effect.forkScoped({ startImmediately: true })
)

const checkoutRef = yield * prepared.start
```

For a handled input, the stream may expose values such as:

```ts
{ _tag: "EventSent", sequence: 2, deliveryId: 0,
  subject: { id: "checkout", sessionId: "machine:0", kind: "Machine" },
  source: undefined, target: { id: "checkout", sessionId: "machine:0" },
  event: CheckoutEvents.Submit(), causedBy: undefined }

{ _tag: "EventProcessed", sequence: 4, macrostepId: 0,
  deliveryId: 0, handled: true, configurationChanged: true,
  before: { status: "active", state: /* ... */ },
  after: { status: "active", state: /* ... */ }, microsteps: [/* ... */] }
```

The closed `Machine.Inspection.Event` union also reports creation,
initialization and startup failure, direct `Logic` state updates, outward
emissions, Effect/timer activity lifecycles, and termination. Records erase
unrelated child protocols to `unknown`; application-level observation remains
typed through each reference's `changes` and `emissions`.

The stream is hot, non-replayed, never fails, and completes after the root
terminates. Subscribe before `prepared.start` to capture initialization. Local
session ids are unique only inside that prepared ownership tree: `machine:0`
is the root and later ids identify its descendants. They are intentionally not
distributed identities. Cluster placement, routing, and correlation continue
to use Cluster entity, runner, and request identities at the integration
boundary.

`AtomMachine.inspection(machineAtom)` provides the same root-scoped stream and
starts a fresh atom-backed machine only after its inspection subscription is
installed.

Invalid event and emission constructions fail the machine with a typed
`MachineSchemaDecodeError`; they do not throw from the constructor call.

### Send explicitly between machines

`raise` targets the current machine in the same macrostep. `sendTo` targets a
machine mailbox and is processed later. A machine that requires an owner
declares the subset of parent inputs it may send with `Machine.parent`:

```ts
const ParentEvents = Machine.events(ChildFinished)

const child = Machine.make({
  states: ChildStates.states,
  events: ChildEvents,
  parent: Machine.parent(ParentEvents),
  initial: (to) => to.Working()
}).handle({
  Working: {
    on: {
      Finish: (to) =>
        to.full.Done().resolve(({ parent, target }, enqueue) => {
          enqueue.sendTo(parent, ParentEvents.ChildFinished({ id: "job-1" }))
          return target.from()
        })
    }
  },
  Done: {}
})

const Child = Machine.child("worker", child)
const ParentInputs = Machine.events(Start, ParentEvents)
```

`parent` is statically present in every child callback, and root APIs such as
`Machine.start`, `Machine.planInitial`, Atom machines, and Cluster machines
reject this machine. When `Child` is invoked, the parent definition must accept
every declared parent event; otherwise `.handle(...)` is a compile-time error.
Inside the child, the parent target accepts only those declared events.

Use `parent: Machine.optionalParent(ParentEvents)` when the same machine is
intentionally valid both as a root and as a child. In that case `parent` is
`MachineTarget<...> | undefined` and must be narrowed before sending. When no
parent declaration is present, callbacks do not expose a `parent` property.
`emit` never sends to the parent: it only publishes on the emitting machine's
`emissions` stream.

Every handler also receives `self`, which can be targeted with `sendTo` when a
later mailbox turn is required. Use `raise` instead for same-macrostep work.
Both `self` and `parent` are minimal `Machine.MachineTarget<Event>` values. The
shared `Machine.MachineReferences<InputEvents, ParentEvents>` context keeps
their input protocols separate without exposing snapshot or lifecycle APIs.
Structural state values use distinct names: `containingState` is the immediate
valued state in the same statechart, while `ancestors` maps valued ancestor
paths. `parent` always means the owning machine target.

### Choose the target by scope

| Builder          | Use when                                 | Preserves                                         |
| ---------------- | ---------------------------------------- | ------------------------------------------------- |
| `target.none()`  | Handling without selecting a destination | The complete current configuration                |
| `target.local`   | Moving inside the nearest compound scope | Ancestors and unrelated parallel regions          |
| `target.branch`  | Moving elsewhere under the active root   | Omitted active ancestors and parallel regions     |
| `target.full`    | Replacing or selecting a complete root   | Nothing implicit for a newly selected root        |
| `target.history` | Restoring a declared history node        | The remembered configuration or its typed default |

Every required transition handler selects a target from its inline `to`
builder. Return a bare selection such as `to.full.Idle()` when the selected
builder supports zero-argument construction; the machine applies the same
default construction as `target.from()`. This includes empty schemas and
schemas whose constructor fields are all optional or defaulted. TypeScript
rejects the bare form when state data or nested configuration is required.
Call `.resolve(...)` when construction depends on handler context or the
transition needs to enqueue commands. An absent handler ignores the trigger; `to.none` handles
it and retains queued commands, raised events, and emitted events without
selecting a destination. Concrete destinations stay narrowed inside their
resolver, and `to.branches({...})` gives the resolver only the declared named
`select` builders. Builders describe the
next logical configuration. Shared states exit and enter only when paths
change; call `.reenter()` for resolver-free reentry or pass `{ reenter: true }`
to `.resolve(...)` when the source must restart. With `to.none`, reentry
restarts the source while retaining its configuration.

Topology-only definition instructions are values: `to.none`, declared
`.initial` and history selections, and `to.local.with`. Concrete state and
choice destinations remain calls such as `to.full.Running()`. Runtime named
branch builders remain callable, including `select.unchanged()`, because their
result carries the selected branch evidence.

### Update an active scope value

Use `to.local.update(...)` to replace the value owned by the nearest active
compound scope without rebuilding its active child. Use
`to.branch.<path>.update(...)` for a valued compound or parallel ancestor of the
handler source:

```ts
const handlers = {
  Increment: (to) => to.branch.root.session.update(({ current, owner }) => owner.from({ count: current.count + 1 }))
}
```

The update keeps the exact active descendants, their values, history records,
completion outputs, and unrelated parallel regions. It runs no exit or entry
actions and does not restart state-owned work. Eventless stabilization still
runs, so an `always` transition can react to the new value.

The plain update method remains useful when topology does not change. It is
also a static selection for a named branch:

```ts
to.branches({
  changed: { target: to.local.update },
  unchanged: { target: to.none }
}).resolve(({ select, event }) =>
  event.changed
    ? select.changed.from({ count: event.count })
    : select.unchanged()
)
```

### Change topology and a retained owner together

When a transition enters another child and also replaces a valued ancestor
that stays active, declare both operations on the same target:

```ts
const handlers = {
  CreatePlan: (to) =>
    to.local.SavingPlan()
      .updating(to.branch.Ready)
      .resolve(({ current, event, owner, target }) =>
        target.from({
          request: { _tag: "Create", input: event.input }
        }).update(
          owner.decoded(new Ready({ ...current, notice: null }))
        )
      )
}
```

`to.local.SavingPlan()` selects topology. `.updating(to.branch.Ready)` names
the retained valued owner and makes its replacement mandatory: the resolver
does not type-check unless destination construction finishes with
`.update(...)`. `current` is that owner's decoded value from the
pre-transition snapshot. `target` constructs the destination; `owner`
constructs the complete replacement owner value.

The topology change and owner replacement apply atomically in one microstep.
The owner does not exit or reenter, its work is not restarted, and destination
entry actions observe the new owner value. Eventless stabilization follows.
Only one retained owner may be replaced by a combined target. A `full` target,
or any target that exits the selected owner, does not expose `.updating`.
Combined updates use a direct resolver in this release; named branches continue
to support value-only updates.

For a schema-less destination, construction remains explicit:

```ts
to.local.Idle()
  .updating(to.branch.Ready)
  .resolve(({ current, output, owner, target }) =>
    target.from().update(
      owner.decoded(
        new Ready({
          ...current,
          day: output,
          notice: "Plan changed."
        })
      )
    )
  )
```

Both values derive from the same pre-transition snapshot and are validated
before lifecycle actions run. Competing transitions that write the same owner
conflict; document order and hierarchy select one writer rather than applying
last-write-wins behavior.

The resolver must return `target.decoded(value)` or `target.from(input)`. It
may return `decline()` only with `{ declinable: true }`. Pass `{ reenter: true }`
on event or invocation transitions when the handler source should exit and
enter again. Reentry applies to that source, not to the ancestor whose value
changed.

The selector omits `update` for schema-less scopes, atomic and final states,
inactive branches, parallel sibling regions, and choice resolvers. Updating a
parallel sibling requires an event handled by that region.

Use `declinable: true` when a resolver may decide that its transition is not
enabled. Only that resolver receives `decline()`, and its return type expands to
accept the opaque declined result:

```ts
const handlers = {
  Submit: (to) =>
    to.local.Saving().resolve(
      ({ event, target, decline }) => accepts(event) ? target.from({ draft: event.draft }) : decline(),
      { declinable: true }
    )
}
```

Declining discards work enqueued by that resolver. Event and eventless dispatch
continues with the next eligible ancestor; if no candidate accepts, no
transition is selected. This differs from `target.none()`, which consumes the
trigger and prevents an ancestor from handling it. `transitionDefinitions`
reports each handler's `acceptance` as `"required"` or `"declinable"` while
preserving the exact declared target branches. Choices and initial routing must
remain total and cannot use declinable transitions. Completion and invocation
outcomes have no ancestor candidate: declining one ignores that lifecycle
occurrence and leaves the current configuration active.

## Statechart capabilities

`Machine.states` supports:

- atomic states;
- compound states with one active child;
- parallel states with one active state in every region;
- final states and typed outputs;
- transient choice states;
- shallow and deep history states.

Declare topology—including finality, output schemas, choices, and history—only
in `states`. Handlers implement behavior and output computation without
repeating structural metadata. Final children complete their parent, so
`onDone` belongs on that compound or parallel parent.

Transition, entry, exit, choice, initial, and history callbacks are
synchronous. Conditions use ordinary TypeScript control flow. Callbacks may
select state and enqueue explicit `raise`, `emit`, `sendTo`, or `stop` commands;
arbitrary asynchronous Effects do not run inside planning.

## Effects, Streams, timers, and child machines

State-scoped work starts on entry and is interrupted on exit:

```ts
machine.handle({
  Loading: {
    invoke: (from) =>
      from.effect("save-document", () => saveDocument)
        .onDone((to) => to.full.Saved().resolve(({ output, target }) => target.from({ id: output.id })))
        .onFailure((to) => to.full.Failed().resolve(({ error, target }) => target.from({ message: String(error) })))
  },
  Waiting: {
    invoke: (from) =>
      from.timer("save-timeout", "3 seconds")
        .onDone((to) => to.full.Failed().resolve(({ target }) => target.from({ message: "Timed out" })))
  }
})
```

The state-local `from` selector starts an `effect`, `stream`, `timer`, reusable
`logic`, or complete `child` statechart. The selected source determines which
lifecycle methods the chain requires and which methods are available. For
example, an Effect with non-`never` output and error channels must handle both;
the completed chain is the value returned by the callback:

```ts
machine.handle({
  Loading: {
    invoke: (from) =>
      from.effect("load-document", ({ state }) => loadDocument(state.documentId))
        .onDone((to) => to.full.Ready().resolve(({ output, target }) => target.from({ document: output })))
        .onFailure((to) => to.full.Failed().resolve(({ error, target }) => target.from({ message: error.message })))
  }
})
```

A Stream source remains independent of the parent event protocol. Each element
is mapped by `onElement`, and the next element is not pulled until that parent
macrostep commits:

```ts
machine.handle({
  Listening: {
    invoke: (from) =>
      from.stream("channel", () => channelMessages)
        .onElement((to) =>
          to.none.resolve(({ element }, enqueue) => {
            enqueue.raise(Events.MessageReceived({ message: element }))
          })
        )
        .onDone((to) => to.none)
        .onFailure((to) => to.full.Failed().resolve(({ error, target }) => target.from({ error })))
  }
})
```

`to.none` is the targetless transition value. Return it directly to keep the
current configuration, or call `.resolve(...)` when the transition only needs
to enqueue commands. A block resolver may omit its return because it is
contextually typed to return `undefined`.

Inside `.handle(...)`, `from` receives the owning machine's public input and
declared parent protocol contextually. Source and lifecycle callbacks can send
through `self` and `parent` while retaining the invoked Effect's output and
error inference:

```ts
const machine = Machine.make({
  events: Commands,
  internalEvents: InternalEvents,
  parent: Machine.parent(ParentEvents)
  // ...
}).handle({
  Saving: {
    invoke: (from) =>
      from.effect("notify-parent", () => saveDocument)
        .onDone((to) =>
          to.none.resolve(({ parent, self }, enqueue) => {
            enqueue.sendTo(self, Commands.Save())
            enqueue.sendTo(parent, ParentEvents.ChildFinished({ id: "job-1" }))
          })
        )
        .onFailure((to) => to.none)
  }
})
```

Return an array of completed chains to compose multiple state-owned activities.
The source computation itself, process logic, or `Machine.child(id, machine)`
descriptor can be named and reused; the invocation chain stays local so its
transitions retain the exact owning state and machine protocols.

```ts
const refreshCache = Cache.refresh

machine.handle({
  Active: {
    invoke: (from) => [
      from.effect("refresh-cache", () => refreshCache).onDone((to) => to.none).onFailure((to) => to.none),
      from.timer("expire-session", "5 minutes").onDone((to) => to.full.Expired())
    ]
  }
})
```

`onDone` is required for a non-`never` output, and `onFailure` is required for a
non-`never` typed error. Streams additionally require `onElement` when their
element channel is non-`never` and always require `onDone`; logic and child
chains optionally expose `onSnapshot`. A handled method disappears from the
next builder step, so every reachable lifecycle channel is handled exactly
once. Defects, interruption, and source-construction failures terminate the
owning runtime. Effect sources are factories evaluated when their state is
entered. Use an Effect containing `Effect.sleep(...)` for generic work, while
`from.timer(...)` keeps timer intent explicit and makes static durations visible
through activity inspection.

### Spawn dynamic child machines

Use `from.child(...)` when a state owns a fixed child lifecycle. Use the
`children` context inside an invoked Effect when the machine process owns an
open set of children that must survive state changes:

```ts
const Plant = Machine.childFamily(plantMachine)

const central = Machine.make({
  events: Machine.events(ResourcesOffered, PlantBroken)
  // ...
}).handle({
  Commissioning: {
    invoke: (from) =>
      from.effect("commission-wave", ({ children, state }) =>
        Effect.forEach(
          state.plants,
          (input) => children.spawn(Plant(input.id), { input }),
          { discard: true }
        ))
        .onDone((to) => to.full.Operating())
        .onFailure((to) => to.full.CommissioningFailed())
  }
})
```

`children.spawn` completes after initialization. The new child remains owned
by the machine process after the commissioning Effect completes or its state
exits. `children.sendTo` and `children.stop` address one active child from an
Effect; transition resolvers use `enqueue.sendTo` and `enqueue.stop` with the
same descriptor. Duplicate active ids fail with `ChildAlreadyExistsError` and
do not replace the existing child. Earlier successful spawns remain active if
a later spawn in the same wave fails.

The child machine's declared `Machine.parent(...)` events must be accepted by
the owner. This is checked at each spawn call even though ids and cardinality
remain dynamic. `scope.spawn(child, { input })` provides the same descriptor
form for lower-level process logic, where the process event protocol is known.

## Reactivity

`AtomMachine` runs one lazy machine instance per `AtomRegistry`:

```ts
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Atom } from "effect/unstable/reactivity"

const runtime = Atom.runtime(AppLayer)
const counterAtom = AtomMachine.bind(runtime).make(Counter)
```

Binding a shared runtime once is the canonical form for service-backed
applications. Service-free machines can use `AtomMachine.make(Counter)`.

The bridge exposes `ref`, `snapshot`, `state`, fail-aware `result`, writable
`send` and `stop` atoms, and `child(descriptor)`. Use `AtomMachine.select`,
`AtomMachine.selectSnapshot`, and `AtomMachine.matches` for typed,
equality-aware derivations. Repeating one of these calls with the same bridge
and state path returns the same atom.

Use `useMachineAtom` from `@typeonce/effect-machine-react` when one React
subtree owns the machine. It mounts the machine without subscribing the owner
to state. Pass the returned machine atom through props or Context, then call
`useAtomSuspense(AtomMachine.selectSnapshot(machine, path))` in the descendant
that renders that state slot. Hooks from `@effect/atom-react` use a shared
default registry. Add `RegistryProvider` only when a subtree needs separate
registry identity or disposal.

When consumers need keyed lookup for a machine with startup input,
`AtomMachine.family` uses that input as the family key and exposes direct atom
families. Each returned atom retains its private machine bridge while
preserving lazy registry startup and disposal:

```ts
const processAtoms = AtomMachine.bind(runtime).family(processMachine, {
  atoms: {
    details: AtomMachine.select("Processing"),
    ready: AtomMachine.matches("Ready"),
    send: (machine) => machine.send
  }
})

const detailsAtom = processAtoms.details(input)
const sendAtom = processAtoms.send(input)
```

The key follows Effect `Equal` and `Hash` semantics. Equal input values reuse
the same public atom while it remains reachable. The family does not keep an
unbounded strong cache on platforms with weak references. Keep keys immutable.

Descriptors reconstructed from a `Machine.childFamily` resolve the same child
bridge by machine identity and id:

```ts
const Plant = Machine.childFamily(plantMachine)
const plants = AtomMachine.familyChild(centralAtom, {
  child: (plantId: string) => Plant(plantId),
  atoms: {
    broken: AtomMachine.matchesChild("Broken"),
    send: (plant) => plant.send
  }
})

const brokenAtom = plants.broken(selectedPlantId)
```

Emissions stay streams rather than becoming retained atom state:

```ts
const rootEmissions = AtomMachine.emissions(counterAtom)
const childEmissions = AtomMachine.childEmissions(counterAtom.child(Worker))
```

These streams require the same `AtomRegistry`, follow the currently mounted
machine instance, and do not replay notifications from an earlier subscription
or child instance.

## Persistence

Logical snapshots can be validated for storage or transport:

```ts
const encoded = yield * Machine.encodeSnapshot(machine, snapshot)
const decoded = yield * Machine.decodeSnapshot(machine, encoded)
const ref = yield * Machine.resume(machine, decoded)
```

Decoded snapshots are local runtime values and may contain class instances or
other process-local data. `encodeSnapshot` is the persistence boundary: it uses
each declared schema's canonical JSON codec and succeeds only when every active
state value, completion output, and history value is JSON. Rich values such as
dates and bigints use their schema-defined JSON representation; cyclic or
non-JSON values fail with `MachineSchemaEncodeError` instead of escaping to a
later `JSON.stringify` crash.

Resumption restores logical state, values, completion, and history metadata.
It creates a fresh runtime: active invokes restart, timers restart at their
full duration, and prior fibers, subscriptions, queues, and child runtimes are
not restored. Store machine identity and migration/version metadata beside the
encoded snapshot.

## Testing

The testing entrypoint provides complementary layers:

- `MachineTest.run` and `verify` inspect pure planner traces;
- `coverage` reports exact transition-definition and conditional-branch hits;
- invariants and generated scenarios check application laws;
- `explore` performs bounded breadth-first state-space exploration and retains
  exact transition-definition and branch coverage for every plan it computes;
- `probe` causally acknowledges live runtime commands;
- runtime command models cover timers, invokes, bursts, and scheduling.

```ts
import { MachineTest } from "@typeonce/effect-machine/testing"

const trace = yield* MachineTest.run(Counter, {
  events: [
    { _tag: "Start" },
    { _tag: "Increment" }
  ]
})

yield* MachineTest.verify(Counter, trace)
```

`MachineTest` scenarios retain decoded event values for model inspection, so
pass complete decoded objects when defining scenarios manually. Pure planner
tests do not execute invokes or time. Use a started machine and a probe when
those semantics matter.

## Entrypoints

```ts
import { Machine } from "@typeonce/effect-machine"
import { ClusterMachine } from "@typeonce/effect-machine/cluster"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { MachineTest } from "@typeonce/effect-machine/testing"
```

Each ESM entrypoint is independent and tree-shakeable.

## Reference and development

- [API reference](https://effect-machine.typeonce.dev)
- [Agent and implementation guide](./docs/agent-guide.md)
- [Contributing guide](./CONTRIBUTING.md)

Use pnpm 10 and Node.js 20 or newer:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Declarative first-class guards are not currently part of the API; use ordinary
TypeScript conditions. Pull requests that change `src/` or `package.json` need
a changeset and the performance checks described in `AGENTS.md`.

When equivalent Machine modules ship in Effect, this package is intended to
become a compatibility re-export before eventual retirement.
