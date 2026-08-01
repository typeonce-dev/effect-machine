# @typeonce/effect-machine

Schema-first state machines and statecharts for Effect.

> Early-release software: APIs may change, and releases are coupled to an exact
> Effect beta.

## Installation

```sh
pnpm add @typeonce/effect-machine effect@4.0.0-beta.102
```

`effect` is an exact peer dependency, not a bundled runtime dependency.
Consumers must install `effect@4.0.0-beta.102`. Upgrading this package may
require upgrading Effect in lockstep; do not override the peer to another beta.

## Entrypoints

```ts
import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { ClusterMachine } from "@typeonce/effect-machine/cluster"
```

Each ESM entrypoint is independent and tree-shakeable. Importing the root does
not load the reactivity or cluster adapters.

## First machine

Schemas provide runtime decoders and the types used by handlers, targets,
inputs, outputs, and running references. The public/internal event distinction
has an additional boundary described below.

Effect's `Schema.TaggedUnion` is a compact way to declare cases. Its `cases`
property contains the individual tagged schemas, and each case has a typed
`make` constructor.

```ts
import { Schema } from "effect"
import { Machine } from "@typeonce/effect-machine"

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
  initial: () => States.initial.Idle(State.cases.Idle.make({}))
}).handle({
  Idle: {
    on: {
      Start: ({ target }) => target.full.Running(State.cases.Running.make({}))
    }
  },
  Running: {}
})
```

`initial` is always a function. For a machine with an input schema, the
initializer receives the decoded input.

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
  initial: () => States.initial.Idle(State.cases.Idle.make({}))
})
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

`Machine.defineStates` accepts atomic, compound, parallel, and final state
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
  initial: () =>
    States.initial.Form(State.cases.Form.make({ draft: "" }), (form) => form.Editing(State.cases.Editing.make({})))
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

Transition between structurally related tagged states with `Machine.retag`.
The source `_tag` is discarded, compatible fields are reused, and missing or
incompatible required fields must be supplied:

```ts
const saving = Machine.retag(State.cases.Saving, editing)
```

## Choosing a target builder

Transition contexts expose three typed target builders:

| Builder         | Destination                                       | Configuration behavior                                                                         |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `target.local`  | Inside the source's nearest compound scope        | Keeps the compound value, active ancestors, and unrelated parallel regions                     |
| `target.branch` | Anywhere under the source's active top-level root | Replaces the selected branch while keeping omitted active ancestor values and parallel regions |
| `target.full`   | Any top-level root                                | Builds a complete active snapshot for the selected root                                        |

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

## Planning Effects and staged actions

An Effect returned by a transition handler is part of planning. Use it to read
services, choose a target, raise an event, or emit an event. Wrap external side
effects in `Machine.action`; actions are staged during planning and run by the
managed runtime before it publishes the next state.

```ts
Save: ({ target }) => Machine.action(writeAuditLog, target.local.Saving(State.cases.Saving.make({})))
```

The one-argument form returns `void` after staging. The two-argument form
returns its second argument, which avoids a generator when an action and the
next target are the whole transition.

If an action fails, the runtime keeps the previously published state and
suppresses emissions from that plan.

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

## Reactivity

`AtomMachine.make` creates a lazy bridge backed by one running machine per
`AtomRegistry`. Mounting or reading one of its atoms starts the machine;
disposing the registry-owned reference stops it.

```ts
import { Atom } from "effect/unstable/reactivity"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"

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

`ClusterMachine` provides a separate persisted entity adapter. Its process-local
restrictions and delivery guarantees are documented on that API.

## Current limits

History states and declarative first-class guards are not part of the current
API. Ordinary TypeScript conditions implement guards. Use `Machine.after` for a
cancellable state-scoped delayed event.

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

## Examples

The [platformer statechart example](./examples/platformer) is a playable SVG
demo centered on a schema-first character machine. It demonstrates nested
compound locomotion, parallel airborne motion and air-jump regions, independent
facing and wall-contact regions, typed protocol events, state-scoped timers,
and state-driven SVG transforms.

The [Pokémon statechart example](./examples/pokemon) is a standalone React and
Vite project demonstrating compound and parallel states, state-scoped invokes,
invoked child statecharts, typed emissions, and Atom reactivity. It uses a local
`file:` dependency on this package while retaining an isolated dependency graph,
lockfile, build, and CI job.

## Releases

Add a changeset with `pnpm changeset`. CI validates frozen installation and the
complete check suite. The release workflow opens version PRs and publishes with
npm provenance through GitHub Actions.

When equivalent Machine modules ship in Effect, this package is intended to
become a thin compatibility re-export package before eventual retirement.
