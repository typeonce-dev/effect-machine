# @typeonce/effect-machine

Schema-first state machines and statecharts for Effect.

> Early-release software: APIs may change, and releases are coupled to an exact
> Effect beta.

## Installation

```sh
pnpm add @typeonce/effect-machine effect@4.0.0-beta.107
```

`effect` is an exact peer dependency, not a bundled runtime dependency.
Consumers must install `effect@4.0.0-beta.107`. Upgrading this package may
require upgrading Effect in lockstep; do not override the peer to another beta.

## Entrypoints

```ts
import { Machine } from "@typeonce/effect-machine"
import { ClusterMachine } from "@typeonce/effect-machine/cluster"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { MachineTest } from "@typeonce/effect-machine/testing"
```

Each ESM entrypoint is independent and tree-shakeable. Importing the root does
not load the reactivity, cluster, or testing modules.

## First machine

Schemas provide runtime decoders and the types used by handlers, targets,
inputs, outputs, and running references. The public/internal event distinction
has an additional boundary described below.

Effect's `Schema.TaggedUnion` is a compact way to declare cases. Its `cases`
property contains the individual tagged schemas, and each case has a typed
`make` constructor.

```ts
import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

const State = Schema.TaggedUnion({
  Idle: {},
  Running: {}
})

const Event = Schema.TaggedUnion({
  Start: {}
})

const States = Machine.defineStates(State.cases)

const Counter = Machine.make({
  id: "Counter",
  states: States.states,
  events: [Event.cases.Start],
  initial: () => States.initial.Idle.from()
}).handle({
  Idle: {
    on: {
      Start: ({ target }) => target.full.Running.from()
    }
  },
  Running: {}
})
```

Handler objects mirror the state definition recursively. `effect-machine` does
not impose a fixed handler-tree depth; inference continues until TypeScript's
normal, shape-dependent compiler limits.

`initial` is always a function. For a machine with an input schema, the
initializer receives the decoded input.

Builder methods accept an already constructed state value directly, or expose
`.from` for constructing one safely from the state schema's make input:

```ts
target.local.Running(decodedRunning)
target.local.Running.from({ startedAt: event.at })
```

Use the direct call when a decoded value already exists. Use `.from` when
entering a state from fields. Construction runs through the schema's
`makeEffect` while the machine plans the configuration, so constructor
defaults and tagged-class identity are preserved and failed refinements become
`MachineSchemaDecodeError` failures instead of synchronous throws. The same
form is available on initial, local, branch, full, compound, parallel, and
final builders. A `.from` builder result is therefore a machine construction
instruction; it becomes a validated public snapshot when planning succeeds.

When `{}` is valid constructor input, omit it. Required state fields remain
required, while compound and parallel states still require their active-child
callback:

```ts
States.initial.Idle.from()
States.initial.Form.from({ draft: "" }, (form) => form.Editing.from())
States.initial.Flow.from((flow) => flow.Idle.from())
```

Tagged classes are equally valid when cases need class methods or nominal
identity:

```ts
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
```

## Public and internal events

Declare commands that callers may send in `events`. Declare machine-local
deliveries, such as invoke results and child emissions, in `internalEvents`:

```ts
const Command = Schema.TaggedUnion({
  Save: {}
})

const InternalEvent = Schema.TaggedUnion({
  Saved: { id: Schema.String },
  SaveFailed: { message: Schema.String }
})

const machine = Machine.make({
  states: States.states,
  events: [Command.cases.Save],
  internalEvents: [InternalEvent.cases.Saved, InternalEvent.cases.SaveFailed],
  initial: () => States.initial.Idle.from()
})
```

Construct reusable events with `Machine.event` when the schema is owned by the
machine protocol:

```ts
const save = Machine.event(machine, Command.cases.Save)
yield * ref.send(save)
```

The schema constructor runs once and the decoded value is trusted by that
machine and definitions derived from it with `handle`. This avoids decoding a
known event again on every delivery. A configured `Schema.TaggedUnion` can use
either the union schema itself or one of its `cases`. Treat the returned event
as immutable; sending it to an unrelated machine goes through that machine's
normal decoder.

Ordinary values remain valid and are decoded at every boundary:

```ts
yield * ref.send({ _tag: "Save" })
```

Handlers and machine logic see the complete union. Local public APIs such as
`MachineRef.send`, `machineAtom.send`, and `Machine.plan` expose only `events`
in TypeScript. The local planner and runtime still share the complete event
decoder so machine-local deliveries can flow through the same execution
protocol; bypassing the types with JavaScript or `any` is therefore not a
runtime authorization boundary. Cluster RPC delivery additionally validates
incoming payloads against the public `events` schemas.

The utility types make the distinction available to application code:

```ts
type PublicCommand = Machine.Machine.InputEvent<typeof machine>
type HandledEvent = Machine.Machine.Event<typeof machine>
```

Tags must be unique within each list, and public and internal tags must be
disjoint. Reusing a tag is a type error, so a command cannot accidentally
masquerade as an internal result.

## Statechart structure

`Machine.defineStates` accepts atomic, compound, parallel, final, choice, and history
nodes:

```ts
const State = Schema.TaggedUnion({
  Form: { draft: Schema.String },
  Editing: {},
  Saving: {},
  Done: {}
})

const States = Machine.defineStates({
  Form: {
    schema: State.cases.Form,
    initial: "Editing",
    states: {
      Editing: State.cases.Editing,
      Saving: State.cases.Saving,
      Done: {
        schema: State.cases.Done,
        type: "final",
        output: Schema.String
      }
    }
  }
})
```

Compound states have one active child and declare its initial key. Parallel
states use `type: "parallel"` and have one active state in every direct region.
Finality is topology, so declare `type: "final"` only in the state definition.
Handlers implement behavior and output computation without repeating it:

```ts
const machine = Machine.make({
  states: States.states,
  events: [],
  initial: () => States.initial.Form.from({ draft: "" }, (form) => form.Editing.from())
}).handle({
  Form: {
    states: {
      Done: {
        output: () => "saved"
      }
    }
  }
})
```

Every declared output schema must have a matching handler implementation before
the machine can be planned, started, invoked, or adapted to Atom/Cluster.
Final children complete their parent; put `onDone` on that compound or parallel
parent, not on the final leaf.

Put data on the narrowest state where it is valid. If several sibling phases
share data, prefer storing it on their compound parent instead of copying it
into every child state.

### Choice states

A choice is a transient, targetable decision point. Declare it with only
`type: "choice"`; it has no schema, value, children, lifecycle actions, invoke,
or event handlers. A choice is therefore absent from `StateIdentifier`, stable
snapshots, configurations, and encoded snapshots.

```ts
const States = Machine.defineStates({
  Flow: {
    schema: State.cases.Flow,
    initial: "Routing",
    states: {
      Routing: { type: "choice" },
      Approved: State.cases.Approved,
      Rejected: State.cases.Rejected
    }
  }
})

const machine = Machine.make({
  states: States.states,
  events: [Event],
  initial: () =>
    States.initial.Flow(
      State.cases.Flow.make({ score: 80 }),
      (flow) => flow.Routing()
    )
}).handle({
  Flow: {
    states: {
      Routing: {
        choice: {
          targets: ["Flow.Approved", "Flow.Rejected"],
          transition: ({ parent, target }) =>
            parent.score >= 70
              ? target.local.Approved(State.cases.Approved.make({}))
              : target.local.Rejected(State.cases.Rejected.make({}))
        }
      }
    }
  }
})
```

The resolver is ordinary TypeScript or an `Effect`. It receives the triggering
lifecycle event, typed parent values, target builders, and the normal planning
capabilities, but no `state` because the choice itself has no state value. Its
declared `targets` are both a compile-time bound and inspectable graph edges.
The resolver must return one of them; missing, malformed, or undeclared targets
fail planning. Choice implementations are required before execution APIs are
available.

Initial, event, completion, always, history-default, and other choice
transitions settle in the same macrostep. Chained choices use the normal
infinite-transition limit. Choice nodes never run entry or exit actions and
never become active while their resolution remains visible in traces and
coverage as a `choice` transition trigger.

### History states

A history pseudo-state remembers the last active configuration of its parent.
It has no value schema and never appears in an active snapshot. History is
shallow by default; use `history: "deep"` to retain the complete descendant
configuration and its validated values:

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
      resume: { type: "history", history: "deep" }
    }
  },
  support: Support
})
```

Implement a typed default for the first transition before any configuration
has been remembered, then target history without supplying a state value:

```ts
machine.handle({
  checkout: {
    history: {
      resume: {
        default: () => initialCheckoutSnapshot
      }
    }
  },
  support: {
    on: {
      Resume: ({ target }) => target.history.checkout.resume()
    }
  }
})
```

A history default is source-independent. It must construct a complete root
configuration containing the history owner, including every inactive ancestor
above a nested owner and every required region of a parallel ancestor. For a
top-level owner, its owner snapshot is already a complete root snapshot.

For example, a history node owned by `App.Workspace` can be targeted from an
unrelated `Closed` root and supplies the complete `App` configuration on first
use:

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

The containing branch is enforced statically: unrelated roots, sibling
compound branches that omit the owner, owner-only nested snapshots, and
incomplete parallel configurations are rejected.

Deep history restores every remembered descendant value. Shallow history
restores the parent and direct-child values, then follows normal initial paths.
Only compound or parallel states that shallow restoration can enter implicitly
need an `initial` handler to construct those new child values:

```ts
payment: {
  initial: ;
  ;(({ state }) => new CardEntry({ attempt: state.attempt, cardNumber: "" }))
}
```

Execution APIs remain unavailable until required history defaults and shallow
initializers have been implemented. History records are part of logical
snapshots and are schema-validated by `encodeSnapshot` and `decodeSnapshot`.

Transition between structurally related tagged states with `Machine.retag`.
The source `_tag` is discarded, compatible fields are reused, and missing or
incompatible required fields must be supplied:

```ts
const saving = Machine.retag(State.cases.Saving, editing)
```

## Choosing a target builder

Transition contexts expose four typed target builders:

| Builder          | Destination                                       | Configuration behavior                                                                         |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `target.local`   | Inside the source's nearest compound scope        | Keeps the compound value, active ancestors, and unrelated parallel regions                     |
| `target.branch`  | Anywhere under the source's active top-level root | Replaces the selected branch while keeping omitted active ancestor values and parallel regions |
| `target.full`    | Any top-level root                                | Builds a complete active snapshot for the selected root                                        |
| `target.history` | A declared history pseudo-state                   | Restores its parent's remembered configuration or runs its typed default                       |

When `target.local` or `target.branch` enters an inactive nested parallel
state, its callback must select every region, just like `initial` and
`target.full`. When that parallel state is already active, `target.branch`
can still update one region directly and preserves the other active regions.

The builder controls how the next configuration is assembled; it does not by
itself decide which invokes restart. The runtime derives exit and entry paths
from the previous and next active paths. Shared active ancestors remain entered,
even when `target.full` supplies their values again. Use an event transition
with `reenter: true` when the source state should explicitly exit and enter
again:

```ts
Refresh: {
  reenter: true,
  transition: ({ state, target }) =>
    target.full.Ready(new Ready({ value: state.value }))
}
```

`States.get`, `States.getWithParents`, `States.getSnapshot`, and
`States.matches` accept typed dotted paths. Handler `parents` values are also
keyed by full dotted paths, such as `parents["Form.Editing"]`; `context.parent`
provides the immediate parent directly and is `undefined` at a root state.

Event, eventless, and completion transition contexts also expose `snapshot`, a
read-only view of the complete logical configuration captured at the beginning
of that transition microstep. This lets one parallel region inspect a sibling
without copying active-state facts into parent values:

```ts
BufferReady: ;
;(({ snapshot, target }) =>
  States.matches(snapshot, "Player.Network.Online")
    ? target.local.Playing(State.cases.Playing.make({}))
    : undefined)
```

All non-conflicting handlers selected together observe the same captured
snapshot. Handlers are synchronous and cannot read mutable live runtime state
later. `snapshot` is intentionally absent from entry, exit,
invoke, and choice contexts. In particular, startup and chained choices may run
before a complete stable snapshot containing their pseudo-source exists.

Effect Schema annotations are the metadata source for active states. Annotate
the schema itself; `Machine.stateNodes` exposes the resolved annotation map:

```ts
const Saving = State.cases.Saving.annotate({
  title: "Saving document",
  description: "Persisting local changes to the server"
})
```

Schema-less choice and history nodes accept only descriptive `title`,
`description`, and `documentation` annotations. Titles may be used as display
labels, but structural paths remain the only identity and targeting mechanism.

## Synchronous transitions and actor commands

Transition, entry, exit, choice, initial, and history callbacks are synchronous.
They select state and may enqueue only explicit statechart or actor operations:
raise an internal event, emit to the parent, send to an invoked child, or stop a
child. Arbitrary Effects are not accepted at this boundary.

```ts
const handlers = {
  Save: ({ target }, enqueue) => {
    enqueue.emit(new SaveRequested({}))
    return target.local.Saving.from()
  }
}
```

Use `Machine.invokeEffect`, `Machine.invoke`, or an invoked child machine for
asynchronous work. Their results return to the parent as typed events, keeping
the transition core deterministic and synchronous.

`Machine.plan` and `Machine.planInitial` return a `done` discriminator. When
`done` is `true`, `output` is the schema-derived structural terminal union;
while the machine remains active, it is `undefined`. A started machine's
`join` uses the same terminal union. Output-less structural terminal paths
contribute `undefined`, while active atomic roots do not.

This union is intentionally conservative with respect to handler behavior. For
example, a root `onDone` transition may make one structurally terminal result
unreachable even though its schema remains in `Machine.TerminalOutput`.

## State-scoped invokes

`Machine.invoke` runs child logic while its owning state is active. Leaving the
state interrupts the child. For a one-shot Effect, `Machine.invokeEffect` maps
typed success and failure values directly to internal events:

```ts
const loading = {
  invoke: ({ state }) =>
    Machine.invokeEffect({
      id: "save",
      effect: save(state),
      onSuccess: (entry) => InternalEvent.cases.Saved.make({ id: entry.id }),
      onFailure: (error) =>
        InternalEvent.cases.SaveFailed.make({
          message: String(error)
        })
    })
}
```

Omit `onFailure` when the Effect cannot fail. Defects and interruption remain
failures rather than being mapped.

`Machine.after` creates a cancellable, state-scoped delayed event with the same
lifetime:

```ts
invoke: Machine.after("3 seconds", InternalEvent.cases.SaveFailed.make({ message: "Timed out" }), {
  id: "save-timeout"
})
```

Provide an explicit id when more than one active timer could deliver the same
event tag.

Use lower-level `Machine.invoke` with `Machine.effect` for custom child logic or
snapshot mapping. Its `id` is only the state-local lifecycle key. If the parent
must send events to that invocation, create a typed low-level address with
`Machine.childAddress<Event>("worker")` and pass it through the explicit
`address` option; the address protocol is checked against the child logic.
Lifecycle ids must be unique among simultaneously active invokes owned by the
same state.

Invoke outputs, invoke snapshot events, and invoked-child emissions belong in
`internalEvents`. They are available to typed handlers but are not accepted by
the typed public input APIs. Include a child machine's emitted protocol with
`internalEvents: [...ChildMachine.emits]` when those emissions should be handled
by the parent.

For a child statechart, create one descriptor for `invokeMachine`, `sendTo`,
and child lookup:

```ts
const Editor = Machine.child("editor", EditorMachine)
```

`Machine.child(id, machine)` is the complete statechart descriptor;
`Machine.childAddress<Event>(id)` is the lower-level event-only address.
Descriptors are matched by id and machine identity, so independently created
descriptors for the same pair address the same child without a global cache.
Exporting one descriptor remains the clearest module boundary.

`Machine.activityDefinitions(machine)` inspects state-owned work without
executing it. Static descriptors report their source path, lifecycle id, and
kind. Timers also report normalized duration and emitted event tag;
`invokeEffect` mappings are described as dynamic; invoked machines expose only
safe child identity. A function-valued `invoke` factory is reported as dynamic
and is never evaluated during inspection. The result is serializable and does
not contain Effects, closures, services, or child runtimes.

## Reactivity

`AtomMachine.make` creates a lazy bridge backed by one running machine per
`AtomRegistry`. Mounting or reading one of its atoms starts the machine;
disposing the registry-owned reference stops it.

```ts
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Atom } from "effect/unstable/reactivity"

const runtime = Atom.runtime(AppLayer)
const machines = AtomMachine.bind(runtime)
const machineAtom = machines.make(Counter)
```

For applications with a shared runtime, treat
`AtomMachine.bind(runtime).make(...)` as the canonical form. It keeps runtime
ownership at the composition boundary so it does not need to be passed through
every feature. Service-free machines may use `AtomMachine.make(machine)`
directly.

The bridge exposes:

- `ref`: the running `MachineRef`
- `result`: fail-aware logical state, combining startup and post-start runtime
  failures
- `snapshot`: authoritative runtime lifecycle, including `active`, `done`,
  `error`, and `stopped`
- `state`: the last logical state, including the retained state after a runtime
  failure
- `send` and `stop`: writable command atoms
- `child(descriptor)`: a reactive bridge for a directly owned child

Use `AtomMachine.select` and `AtomMachine.matches` for equality-aware root
derivations. Use `selectChild` and `matchesChild` for child bridges. Selector
paths and selected value types are inferred directly from the bridge snapshot,
so these combinators do not need the `DefinedStates` object. They follow normal
Atom identity semantics and return a new atom on each call, so retain or memoize
them when constructing them in a component. The `child` method uses Effect's
`Atom.family` to reuse a live bridge for the same descriptor without maintaining
a package-level cache.
`AtomMachine.ChildMachineAtom<typeof Child>` uses `unknown` as its startup-error
default for general component props.
`AtomMachine.ChildOf<typeof parentAtom, typeof Child>` preserves the exact
parent startup-error channel.

Child state and snapshot atoms contain `Option.none()` while that child is
inactive. React applications using `@effect/atom-react` need a
`RegistryProvider`; see the [Pokémon example](./examples/pokemon).

## Snapshots and persistence

`Machine.encodeSnapshot` and `Machine.decodeSnapshot` validate logical
statechart data for storage or transport. The encoded representation does not
contain the machine definition, machine version, services, subscriptions, or
running child processes. Store machine identity and migration/version metadata
alongside it.

Resume a decoded logical snapshot explicitly:

```ts
const encoded = yield * Machine.encodeSnapshot(machine, snapshot)
const decoded = yield * Machine.decodeSnapshot(machine, encoded)
const ref = yield * Machine.resume(machine, decoded)
```

`resume` does not call `initial`, require machine input, or replay entry,
transition, completion, eventless, raised-event, or emitted-event work that
produced the snapshot. The decoded snapshot is the first published logical
state. A final snapshot immediately yields a completed ref with its output.

Resumption creates a fresh runtime. Invokes owned by active states start once in
normal ancestor/document order and receive `Machine.InitialEvent` as their
lifecycle event. `invokeEffect` runs again, invoked machines start from their
own initial state, and `Machine.after` timers restart from their full declared
duration. Spawned children, queued events, subscriptions, fibers, scopes,
elapsed timer time, child snapshots, and prior `RuntimeSnapshot` status/errors
are not restored. Completion and history metadata remain logical state and are
not replayed. A changed machine definition does not cause `resume` itself to
evaluate newly enabled `always` or `onDone` transitions.

Reactive applications use `AtomMachine.resume(machine, decoded)` for a
service-free machine or `AtomMachine.bind(runtime).resume(machine, decoded)`
for a service-backed machine. These bridges have the same lazy one-runtime-per-
registry ownership and disposal behavior as `AtomMachine.make`.

`ClusterMachine` provides a separate persisted entity adapter. Its process-local
restrictions, checkpoint planning, and delivery guarantees are documented on
that API. `Machine.resume` is logical resumption, not durable process or cluster
restoration.

## Property-based semantic invariants

`MachineTest.verify` checks statechart structure and planner lifecycle laws.
Application semantics belong in invariants that can be reused across generated
scenarios and, in future, bounded exploration:

```ts
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect } from "effect"

const invariant = MachineTest.invariants(accountMachine)
const laws = [
  invariant.state(
    "balance is never negative",
    ({ snapshot }) =>
      snapshot.value.balance >= 0 ||
      `negative balance: ${snapshot.value.balance}`
  ),
  invariant.step(
    "withdrawal removes exactly its amount",
    ({ before, event, after }) =>
      event._tag !== "Withdraw" ||
      after.value.balance === before.value.balance - event.amount
  )
]

const generated = MachineTest.scenarios(accountMachine, {
  minEvents: 0,
  maxEvents: 30
})

it.effect.prop(
  "preserves account laws",
  { scenario: generated.arbitrary },
  ({ scenario }) =>
    MachineTest.run(accountMachine, scenario).pipe(
      Effect.tap((trace) => MachineTest.verify(accountMachine, trace)),
      Effect.flatMap((trace) => MachineTest.assertInvariants(accountMachine, trace, laws))
    )
)
```

State invariants observe settled startup and public-event states by default.
Set `observe` to `"microsteps"`, `"all"`, or `"final"` for a different scope.
Use `when` for conditional laws. A condition with no matches is reported as
`untested`; add `require: { minObservations: 1 }` when a particular trace must
exercise it. `checkInvariants` returns this report, while `assertInvariants`
returns `void` for direct use in property tests. Failures retain the complete
shrunk trace and precise event, microstep, configuration, and observation
location.

These APIs inspect planner evidence. Staged action effects, invokes, timing,
and process scheduling require the runtime command-model APIs instead.

Use bounded exploration when random scenarios should be complemented by a
systematic search over concrete event representatives:

```ts
const explored = yield * MachineTest.explore(accountMachine, {
  events: ({ snapshot }) => [
    new Deposit({ amount: 1 }),
    new Withdraw({ amount: snapshot.value.balance }),
    new Withdraw({ amount: snapshot.value.balance + 1 })
  ],
  stateKey: ({ snapshot }) => `${snapshot.value._tag}:${snapshot.value.balance}`,
  limits: {
    maxDepth: 20,
    maxStates: 1_000,
    maxTransitions: 10_000
  },
  invariants: laws
})

const rejected = yield * MachineTest.assertReachable(
  explored,
  "insufficient funds rejection",
  ({ configuration }) => configuration.includes("Rejected")
)

console.log(rejected.trace.scenario.events) // shortest witness
```

Exploration is breadth-first, so each retained node owns its shortest trace.
It is exhaustive only for the concrete events returned by `events` and the
equivalence relation defined by `stateKey`. Equal keys intentionally collapse
snapshots and only the first representative is expanded. Results distinguish
`Complete` from `Truncated` and retain the depth, state, or transition frontier
that hit a limit. An unreachability assertion succeeds only for a complete
result; otherwise it fails as inconclusive. Cycles are retained as graph edges,
but exploration does not enumerate every cyclic path. Invariants are checked
on startup and on each planned edge extending a node's shortest trace.

## Current limits

Declarative first-class guards are not part of the current API. Ordinary
TypeScript conditions implement guards. Use `Machine.after` for a cancellable
state-scoped delayed event.

## Guidance for agents and contributors

The shipped [agent guide](./docs/agent-guide.md) contains the recommended
definition order, modeling rules, lifecycle invariants, React recipe, common
compiler errors, and unsupported features.

## Development and validation

Use pnpm 10 and Node.js 20 or newer:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Individual commands are available for `build`, `test`, `test:types`,
`typecheck`, `format:check`, `test:consumer`, and `pack:check`. Runtime tests use
`@effect/vitest`; type tests use TSTyche and TypeScript 6.0.3. The consumer check
packs the package, imports all public entrypoints, and compiles a strict
TypeScript consumer with `skipLibCheck: false`.

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before proposing a change. Pull
requests receive an automated base-versus-head type-instantiation report.

## Examples

The [platformer statechart example](./examples/platformer) is a playable SVG
demo centered on a schema-first character machine. It demonstrates nested
compound locomotion, parallel airborne motion and air-jump regions, independent
facing and wall-contact regions, a pause/resume flow backed by typed deep
history, typed protocol events, state-scoped timers, and state-driven SVG
transforms.

The [Pokémon statechart example](./examples/pokemon) is a standalone React and
Vite project demonstrating compound and parallel states, state-scoped invokes,
invoked child statecharts, typed emissions, and Atom reactivity. It uses a local
`file:` dependency on this package while retaining an isolated dependency graph,
lockfile, build, and CI job.

The [playground](./examples/playground) collects focused interactive examples
for traffic lights, turnstiles, media players, microwaves, and worker-backed
machines. CI discovers every direct package under `examples/` and runs its
`check` script automatically.

## Releases

Add a changeset with `pnpm changeset`. CI validates frozen installation and the
complete check suite. The release workflow opens version PRs and publishes with
npm provenance through GitHub Actions.

When equivalent Machine modules ship in Effect, this package is intended to
become a thin compatibility re-export package before eventual retirement.
