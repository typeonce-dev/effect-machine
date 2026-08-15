# @typeonce/effect-machine

Schema-first state machines and statecharts for Effect.

State, event, input, output, and persistence boundaries are described with
Effect Schema. The same definition can be planned synchronously, run as a
managed machine, mounted as an Atom, tested as a model, or hosted by the
cluster adapter.

> This is early-release software. Its API may change, and each release targets
> one exact Effect beta.

## Install

```sh
pnpm add @typeonce/effect-machine effect@4.0.0-rc.108
```

`effect` is an exact peer dependency. Install the version above and upgrade it
in lockstep with this package.

## Quick start

Define schemas first, derive the state topology, then add behavior:

```ts
import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

const State = Schema.TaggedUnion({
  Idle: {},
  Running: { count: Schema.Number }
})

const Event = Schema.TaggedUnion({
  Start: {},
  Increment: {},
  Stop: {}
})

const States = Machine.defineStates(State.cases)

const CounterDefinition = Machine.make({
  id: "Counter",
  states: States.states,
  events: [Event],
  initial: () => States.initial.Idle.from()
})

const Counter = CounterDefinition.handle({
  Idle: {
    on: {
      Start: ({ target }) => target.full.Running.from({ count: 0 })
    }
  },
  Running: {
    on: {
      Increment: ({ state, target }) => target.full.Running.from({ count: state.count + 1 }),
      Stop: ({ target }) => target.full.Idle.from()
    }
  }
})

const CounterEvent = Machine.events(Counter)

const program = Effect.gen(function*() {
  const ref = yield* Machine.start(Counter)
  yield* ref.send(CounterEvent.Start())
  yield* ref.send(CounterEvent.Increment())
})
```

`Machine.start` returns a `MachineRef` with `send`, `state`, `snapshot`,
`changes`, `join`, and `stop`. Sending enqueues an event; observe `changes` or
use the testing probe when work must be causally acknowledged.

## Modeling workflow

Use this order to preserve inference and keep boundaries explicit:

1. Define domain, state, public-event, internal-event, and emitted-event schemas.
2. Declare topology with `Machine.defineStates`.
3. Create the protocol and initializer with `Machine.make`.
4. Implement every active state with `.handle(...)`.
5. Add runtime, Atom, testing, or cluster adapters at the application boundary.

### Construct state through builders

Use `.from(...)` when constructing a new state from fields:

```ts
target.local.Saving.from({ draft: event.draft })
States.initial.Form.from({ draft: "" }, (form) => form.Editing.from())
```

The machine runs these inputs through the state schema while planning. Schema
defaults, refinements, and tagged-class identity are therefore preserved, and
decode failures remain typed machine failures. Pass a value directly only when
it is already decoded, such as a value returned by `Machine.retag`.

Omit `schema` when a state represents control flow but owns no data:

```ts
const States = Machine.defineStates({
  Form: {
    initial: "Editing",
    states: {
      Editing: {},
      Saving
    }
  }
})

States.initial.Form.from((form) => form.Editing.from())
```

Schema-less states remain active, targetable, matchable, and visible through
`getSnapshot`, but have no value to read. Their builders expose only `.from`,
their handler `state` is `undefined`, and `get` / `getWithParents` accept only
schema-backed paths. Add a schema later if the state starts owning data.

Put data on the narrowest state where it is valid. If sibling phases share
data, put it on their compound parent.

### Separate public and internal events

`events` is the public command protocol. Invoke results, timer deliveries,
raised events, and child emissions belong in `internalEvents`:

```ts
const Command = Schema.TaggedUnion({ Save: {} })
const Internal = Schema.TaggedUnion({
  Saved: { id: Schema.String },
  SaveFailed: { message: Schema.String }
})

const definition = Machine.make({
  states: States.states,
  events: [Command],
  internalEvents: [Internal],
  initial: () => States.initial.Idle.from()
})

const CommandEvent = Machine.events(definition)
const InternalEvent = Machine.internalEvents(definition)
```

Handlers see both protocols. Typed `send` and `Machine.plan` accept only public
events. Event tags must be unique and public/internal tags must be disjoint.

Use `Machine.events(machine)` and `Machine.internalEvents(machine)` as the
standard constructors for their respective protocols:

```ts
ref.send(CommandEvent.Save())
enqueue.raise(InternalEvent.Saved({ id: "entry-1" }))
```

The returned constructors preserve each schema's make input, including required
fields and constructor defaults. They defer schema construction until delivery,
so invalid values fail planning or the running machine with
`MachineSchemaDecodeError` instead of throwing at the call site.

### Choose the target by scope

| Builder          | Use when                                 | Preserves                                         |
| ---------------- | ---------------------------------------- | ------------------------------------------------- |
| `target.local`   | Moving inside the nearest compound scope | Ancestors and unrelated parallel regions          |
| `target.branch`  | Moving elsewhere under the active root   | Omitted active ancestors and parallel regions     |
| `target.full`    | Replacing or selecting a complete root   | Nothing implicit for a newly selected root        |
| `target.history` | Restoring a declared history node        | The remembered configuration or its typed default |

Builders describe the next logical configuration. Shared states exit and enter
only when paths change; use `{ reenter: true, transition }` when the source must
restart even if its path is unchanged.

## Statechart capabilities

`Machine.defineStates` supports:

- atomic states;
- compound states with one active child;
- parallel states with one active state in every region;
- final states and typed outputs;
- transient choice states;
- shallow and deep history states.

Declare topology—including finality, output schemas, choices, and history—only
in `defineStates`. Handlers implement behavior and output computation without
repeating structural metadata. Final children complete their parent, so
`onDone` belongs on that compound or parallel parent.

Transition, entry, exit, choice, initial, and history callbacks are
synchronous. Conditions use ordinary TypeScript control flow. Callbacks may
select state and enqueue explicit `raise`, `emit`, `sendTo`, or `stop` commands;
arbitrary asynchronous Effects do not run inside planning.

## Effects, timers, and child machines

State-scoped work starts on entry and is interrupted on exit:

```ts
Loading: {
  invoke: {
    id: "save-document",
    effect: saveDocument,
    onDone: ({ output, target }) => target.full.Saved({ id: output.id }),
    onFailure: ({ error, target }) => target.full.Failed({ message: String(error) })
  }
}

Waiting: {
  invoke: {
    id: "save-timeout",
    after: "3 seconds",
    onDone: ({ target }) => target.full.Failed({ message: "Timed out" })
  }
}
```

Use `effect` for one Effect, `after` for a cancellable delay, `logic` for a
reusable process, and `child` for a complete child statechart—all through the
same inline `invoke` object. `Machine.invoke({...})` is also available as a
zero-runtime identity helper when constructing an invocation separately. Reuse one exported
`Machine.child(id, machine)` descriptor for invocation, `sendTo`, and child
lookup.

Typed failures must have an `onFailure` transition. Defects, interruption, and
source-construction failures terminate the owning runtime.

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
equality-aware derivations. React applications using `@effect/atom-react` need
a `RegistryProvider`.

## Persistence

Logical snapshots can be validated for storage or transport:

```ts
const encoded = yield * Machine.encodeSnapshot(machine, snapshot)
const decoded = yield * Machine.decodeSnapshot(machine, encoded)
const ref = yield * Machine.resume(machine, decoded)
```

Resumption restores logical state, values, completion, and history metadata.
It creates a fresh runtime: active invokes restart, timers restart at their
full duration, and prior fibers, subscriptions, queues, and child runtimes are
not restored. Store machine identity and migration/version metadata beside the
encoded snapshot.

## Testing

The testing entrypoint provides complementary layers:

- `MachineTest.run` and `verify` inspect pure planner traces;
- invariants and generated scenarios check application laws;
- `explore` performs bounded breadth-first state-space exploration;
- `probe` causally acknowledges live runtime commands;
- runtime command models cover timers, invokes, bursts, and scheduling.

```ts
import { MachineTest } from "@typeonce/effect-machine/testing"

const trace = yield* MachineTest.run(Counter, {
  events: [
    Machine.event(Counter, Event.cases.Start),
    Machine.event(Counter, Event.cases.Increment)
  ]
})

yield* MachineTest.verify(Counter, trace)
```

`MachineTest` scenarios retain decoded event values for model inspection, so
this is the main case for the eager `Machine.event` API. Pure planner tests do
not execute invokes or time. Use a started machine and a probe when those
semantics matter.

## Entrypoints

```ts
import { Machine } from "@typeonce/effect-machine"
import { ClusterMachine } from "@typeonce/effect-machine/cluster"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { MachineTest } from "@typeonce/effect-machine/testing"
```

Each ESM entrypoint is independent and tree-shakeable.

## Examples

Every package directly under [`examples/`](./examples) has its own lockfile and
`check` script.

| Example                             | What it demonstrates                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Playground](./examples/playground) | Five focused React examples: atomic turnstile commands, state-scoped traffic-light timers, microwave safety across parallel regions, a service-backed media player, and a worker-hosted machine synchronized across tabs |
| [Pokémon](./examples/pokemon)       | Compound and parallel states, invoked child machines, typed emissions, Atom reactivity, and a live Effect service                                                                                                        |
| [Platformer](./examples/platformer) | Nested parallel statecharts, typed deep history, raised events, state-scoped timers, deterministic model tests, and a playable SVG adapter                                                                               |

The playground is the shortest path from one concept to working code. The
standalone examples show larger composition and ownership boundaries.

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
