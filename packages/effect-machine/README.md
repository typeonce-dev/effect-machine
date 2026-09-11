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

Declare the root once, derive its references, then add behavior with event maps:

```ts
import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"
const Root = Machine.state({ fields: { count: Schema.Number } })
const targets = Machine.targets(Root)
const Events = Machine.events({ Increment: { by: Schema.Number } })
const Counter = Machine.make({
  root: Root,
  events: Events
}).handle({
  root: () => ({ count: 0 }),
  on: {
    Increment: {
      update: targets.root,
      data: ({ root, event }) => ({ count: root.count + event.by })
    }
  }
})
const program = Effect.scoped(Effect.gen(function*() {
  const ref = yield* Machine.start(Counter)
  yield* ref.send(Events.Increment({ by: 1 }))
}))
```

Root data is shared state. `update: targets.root` replaces that value while
retaining the active child configuration and its running work. Ordinary
transitions target a descendant; the root itself is not a destination.

## Modeling workflow

Put data on the lowest state that owns it. Use tagged schemas or `fields` for
state-owned values and `{}` for structural states. Prefer distinct states over
boolean flags that allow impossible combinations. Put shared behavior on the
lowest common ancestor, and reserve parallel states for independent modes.

`Machine.state` declares topology. `Machine.make` captures protocols, startup
input, sources, and named branch groups. `.handle` implements behavior in one
nested object and returns an executable machine. One definition can create
independent implementations by calling `.handle` more than once.

### Declare startup data and initial edges

The root descriptor contains schemas and hierarchy. `make` registers protocols
and programs. `.handle` selects initial children and constructs their values:

```ts
const Root = Machine.state({
  fields: { seed: Schema.Number },
  states: {
    Loading: { fields: { count: Schema.Number } },
    Ready: {}
  }
})
const targets = Machine.targets(Root)
const machine = Machine.make({ root: Root, input: Schema.Number, events: Machine.events({}) }).handle({
  root: ({ input }) => ({ seed: input }),
  initial: { target: targets.root.Loading, data: ({ root }) => ({ count: root.seed }) }
})
```

Only the root constructor receives startup input. Child constructors receive
root data, their owning state's data, ancestors, and the lifecycle event.
Each compound declares an initial edge targeting one direct child; that edge
also supplies the child's required values. Nested compounds declare their own
edges in their handlers. There is no separate `initialConfiguration` override.

A parallel handler's `initial` is a map of region data. It enters all regions:

```ts
const Root = Machine.state({
  type: "parallel",
  states: {
    Editor: { fields: { draft: Schema.String }, states: { Editing: {}, Saved: {} } },
    Network: { fields: { online: Schema.Boolean } }
  }
})
const targets = Machine.targets(Root)
const machine = Machine.make({ root: Root, events: Machine.events({}) }).handle({
  initial: { Editor: { draft: "" }, Network: { online: false } },
  states: { Editor: { initial: { target: targets.root.Editor.Editing } } }
})
```

Root and region data accept the short literal or callback form. For decoded
values, use `{ decoded: true, data: valueOrCallback }`. This descriptor accepts
only those two keys. If your domain data itself has `decoded: true` and `data`
fields, return it from a callback: callback results are always ordinary schema
input. Required data is checked at compile time; schema-less regions accept no data.

Use root or state `entry`/`exit` for synchronous commands and `invoke` for
asynchronous work. Constructors only produce values. An unhandled definition
cannot be started, planned, or registered as a child machine.

### Construct state values

```ts
const Root = Machine.state({
  states: {
    Idle: {},
    Loading: { fields: { query: Schema.String } },
    Ready: { fields: { items: Schema.Array(Schema.String) } },
    Failed: { fields: { message: Schema.String } }
  }
})
const targets = Machine.targets(Root)
const Events = Machine.events({ Search: { query: Schema.String }, Reset: {} })
const Search = Machine.make({
  root: Root,
  events: Events
}).handle({
  initial: {
    target: targets.root.Idle
  },
  states: {
    Idle: {
      on: {
        Search: {
          target: targets.root.Loading,
          data: ({ event }) => ({ query: event.query })
        }
      }
    },
    Loading: { on: { Reset: { target: targets.root.Idle } } },
    Ready: {},
    Failed: {}
  }
})
```

`data` accepts a value or a synchronous callback returning the schema's make
input, including constructor defaults and transformations. Add `decoded: true`
when supplying the already-decoded type, including class instances. Both paths
validate values and report `MachineSchemaDecodeError`. Omit data only when the
selected state supports empty construction. Schema-less states do not accept data.

A callback receives the specific event and source-state types, plus `root`,
`containingState`, `ancestors`, and the appropriate machine references. A
transition callback also receives the current logical `snapshot`. There is no
unrestricted destination builder in the callback.

### Declare advanced and conditional transitions

A resolver that chooses a branch, constructs nested children, or enqueues
commands uses a named group in `make`. The group captures every possible edge
before any resolver executes:

```ts
const machine = Machine.make({
  root: Root,
  events: Events,
  branches: {
    search: {
      loading: { target: targets.root.Loading, title: "Query supplied" },
      idle: { target: targets.root.Idle, title: "Empty query" }
    }
  }
}).handle({
  initial: { target: targets.root.Idle },
  states: {
    Idle: {
      on: {
        Search: {
          branches: "search",
          resolve: ({ event, select }) =>
            event.query.length > 0
              ? select.loading({ data: { query: event.query } })
              : select.idle()
        }
      }
    }
  }
})
```

Each selector is bound to its declared destination. Its constructor rejects a
payload belonging to another branch. A single-target group works the same way;
there is no second path declaration in the resolver. For a compound target,
`select.checkout({ data: parentValues, states: { Review: { data: childValues } } })`
constructs the explicitly selected subtree. Parallel constructors require every
entered region; source-local construction can retain active sibling regions. Every compound has an initial edge, including inactive branches. Final outputs,
history defaults, and choices remain part of machine readiness checking.

Use `guard: context => boolean` to decline before construction or commands.
For a resolver that can decline, explicitly add `declinable: true`; only then may
it return `context.decline()`. `reenter: true` restarts the handler's source
where that operation supports reentry. A retained source-value update does not
restart its lifecycle.

### Select destinations and retain owners

All references come from the same root descriptor supplied to `make`:

| Declaration                                           | Meaning                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `{ target: targets.root.Checkout.Review, data: ... }` | Enter a declared destination with its value.                              |
| `{ target: targets.root.Checkout, data: ... }`        | Enter the declared initial configuration of a compound or parallel state. |
| `{ history: targets.root.Checkout.recent }`           | Restore a declared history state.                                         |
| `{ update: targets.root.Checkout, data: ... }`        | Replace a retained active owner's value.                                  |
| `{ target: targets.root, input: ... }`                | Reconstruct root and its initial children using fresh machine input.      |
| `{ update: targets.root, data: ... }`                 | Replace root data and retain active descendants.                          |
| `{ none: true }`                                      | Accept an event without changing the configuration.                       |

An atomic transition can enter a destination and update one retained owner:

```ts
Save: {
  target: targets.root.Checkout.Saving,
  update: targets.root.Checkout,
  data: ({ event, ancestors }) => ({
    target: { request: event.request },
    update: { ...ancestors.Checkout, revision: event.revision }
  })
}
```

The complete replacement values are validated before either change is applied.
Advanced construction declares both references in a branch and uses
`select.saved({ data: destinationValues, update: { data: ownerValues } })`.
A retained owner must be active for that source and remain active through the
transition. A sibling region's value cannot be updated through this operation.

The runtime transition API does not replace arbitrary complete root
configurations. Root targets accept fresh input and follow the initial declarations in `.handle`; history
defaults retain complete subtree construction for restoration.

### Protocols and ownership

`Machine.events` defines public messages. `Machine.internalEvents` adds
machine-local raised events; `Machine.emittedEvents` defines notifications.
Their `FromSchemas` counterparts accept existing tagged schemas. Public and
internal tags must be disjoint. Deferred event constructors are validated when
the runtime receives the event.

Declare `parent: Machine.parent(events)` for a required owner protocol, or
`Machine.optionalParent(events)` for a machine that may run independently.
Handlers receive typed `self` and, when declared, `parent` references. Resolvers
use their second `enqueue` parameter to raise, emit, send, or stop work.
Planning stays synchronous: perform asynchronous work in an invocation.

`Machine.prepare(machine)` exposes an `inspection` stream for the live local
machine tree; subscribe before running `prepared.start` to observe startup. Distributed
placement, transport, routing, and identity belong to the explicit Cluster
adapter.

## Statechart capabilities

The same root supports compound and parallel states, eventless `always`
transitions, ordered named choices, final states, `onDone` completion,
initial declarations, shallow and deep history, and retained snapshots. The topology
is captured directly from declarations; visualization and branch coverage do
not execute user resolvers or depend on TypeScript source extraction.

A compound root completes with its direct completed workflow's output unless
that child handles completion first. Parallel completion waits for all required
regions. An arbitrary final descendant does not finish every ancestor.

## Effects, Streams, timers, and child machines

Register programs inside `make`, then invoke them by `src`:

```ts
const Search = Machine.make({
  root: Root,
  events: Events,
  effects: {
    load: (query: string) => searchItems(query),
    refreshCache: Cache.refresh
  },
  streams: { updates: changes },
  timers: { timeout: "5 seconds" },
  logic: { worker: workerLogic },
  children: { validation: ValidationChild }
}).handle({
  initial: {
    target: Machine.targets(Root).root.Idle
  },
  states: {
    Idle: {},
    Loading: {
      invoke: {
        src: "load",
        input: ({ state }) => state.query,
        onDone: { target: targets.root.Ready, data: ({ output }) => ({ items: output }) },
        onFailure: { target: targets.root.Failed, data: ({ error }) => ({ message: error.message }) }
      }
    },
    Ready: {},
    Failed: {}
  }
})
```

Effects and Streams are lazy values: pass them directly when they need no
input. Use `Effect.suspend` or `Stream.suspend` when construction itself must be
deferred. An input-taking source has exactly one required parameter and the
invocation must supply a typed `input` mapper. A direct value forbids `input`.
Zero-argument and optional-argument factories are rejected to keep this choice
explicit. Source names are unique across all five registries.

| Source         | Required handlers                                                                                   | Optional handlers |
| -------------- | --------------------------------------------------------------------------------------------------- | ----------------- |
| Effect         | `onDone` when success is not `never`; `onFailure` when error is not `never`                         | None              |
| Stream         | `onElement` when its element is not `never`; `onFailure` when error is not `never`; always `onDone` | None              |
| Timer          | `onDone`                                                                                            | None              |
| Logic or child | Reachable `onDone` and `onFailure`                                                                  | `onSnapshot`      |

A `void` success still requires `onDone`. Unreachable channels are rejected.
Startup errors, defects, and interruption follow the existing runtime failure
and cancellation boundaries; a typed `onFailure` handles the source's declared
runtime error channel.

```ts
const invocations = [
  {
    src: "updates",
    onElement: {
      none: true,
      resolve: ({ element }, enqueue) => {
        enqueue.raise(Events.Changed({ value: element }))
      }
    },
    onDone: { none: true },
    onFailure: { none: true }
  },
  { src: "timeout", onDone: { target: targets.root.Expired } },
  { src: "worker", id: "worker", address: WorkerAddress, onSnapshot: { none: true } },
  { src: "validation", input: ({ state }) => ({ query: state.query }), onDone: { none: true } }
]
```

Include each handler demanded by the concrete program's type. Use an explicit
`id` for simultaneous instances of one source; effect, stream, and timer IDs
default to `src`. Logic requires a lifecycle `id` and a typed `Machine.childAddress`.
A child uses its `Machine.child` descriptor's identity and protocol. All
invocations are owned by their state and cancelled when it exits.

Effect services flow through the used sources and lifecycle effects into the
machine's requirements. Unused registrations add no requirements. Supply them
with ordinary `Effect.provide` / `Effect.provideService`, or an Atom runtime
backed by a Layer. Context services provide implementation substitution and
scoped resources; there is no separate machine-specific dependency container.

### Dynamic children

A registered `Machine.child` describes a fixed state-owned child. For an open
set of process-owned children, use `Machine.childFamily` with the `children`
capability supplied to a registered Effect through its input mapper.
`children.spawn` completes after child initialization; the child survives the
commissioning invocation and state. `children.sendTo` and `children.stop`
address it from Effects; resolvers use `enqueue.sendTo` and `enqueue.stop`.
Duplicate active IDs fail with `ChildAlreadyExistsError` and preserve the
existing child. Parent-protocol compatibility is checked at each spawn.

## External observation and tracing

Use `Machine.waitFor(ref, predicate)` when an external Effect needs a particular
current or subsequent published snapshot. Type predicates narrow the result.
It does not send an event or prove that a particular event caused the snapshot.
Prefer `ref.join` for final output, invocation `onDone` / `onFailure` for workflow
behavior, atom selectors for UI reads, and `ref.changes` for continuous observation.

```ts
const ready = yield * Machine.waitFor(ref, isReady).pipe(Effect.timeout("5 seconds"))
```

The predicate runs first, including for terminal snapshots. An unmatched failure
preserves its `Cause`; an unmatched stop fails with `StoppedError`; completion
without a match fails with `Cause.NoSuchElementError`. A predicate exception is
a defect. Observation is lazy, has no default timeout, and releases its
subscription on completion or interruption without stopping the machine. It does
not replay historical snapshots or expose intermediate macrostep configurations.

Effect, Stream, and timer invocations run inside an Effect span named
`Machine.invoke`. Application spans inside that work inherit the invocation span.
Configure the application's ordinary Effect tracer and exporter; no Machine-specific
exporter or inspection subscription is required. Standard Effect tracing and
sampling controls apply, including `Effect.withTracerEnabled(false)`.

Spans identify `machine.id`, `machine.sessionId`, `machine.state.path`,
`machine.invoke.id`, `machine.invoke.source`, `machine.invoke.kind`, and
`machine.invoke.sessionId`. Source is the registered name; invocation IDs can be
overridden independently. Payloads are not recorded automatically. Execution spans
end when the Effect, Stream consumption, or timer settles, including cancellation;
they do not change the lifetime of resources held in an enclosing Scope. Source
construction keeps its existing startup failure boundary. This does not add
machine-lifetime spans or propagate the trace context of each sender through the
mailbox. Tracing can add diagnostic Cause annotations without changing failure
values or interruption semantics. Even without an exporter, tracing has runtime
cost.

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
Use `factory` when the same definition constructs several independent bridges:

```ts
const MachineAtoms = AtomMachine.bind(runtime)
const makeProcessMachine = MachineAtoms.factory(ProcessMachine)

const first = makeProcessMachine({ processId: "first" })
const second = makeProcessMachine({ processId: "second" })
type ProcessMachineAtom = ReturnType<typeof makeProcessMachine>
```

Each call creates a fresh lazy bridge. `factory` does not cache by input;
`AtomMachine.family` remains the keyed shared-identity interface.

The bridge exposes `ref`, `snapshot`, `state`, fail-aware `result`, writable
`send` and `stop` atoms, and `child(descriptor)`. Use `AtomMachine.select`,
`AtomMachine.selectSnapshot`, and `AtomMachine.matches` for typed,
equality-aware derivations. Repeating one of these calls with the same bridge
and state path returns the same atom.

Use `AtomMachine.can` to project concrete event acceptance. Declare the
projection once and apply it to compatible bridges:

```ts
const submitAllowed = AtomMachine.can(Events.Submit({ draft }))
const canSubmitAtom = submitAllowed(machineAtom)
```

Pass an `Atom<EventInput>` instead when the event payload changes reactively.
Each projection returns the same derived atom for repeated applications to one
bridge. Startup and runtime failures remain typed, while done and stopped
machines return `false`.

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
    canStart: AtomMachine.can(ProcessEvents.Start()),
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

Logical snapshots use codec version 2, including the root at path `""`. Earlier
encoded snapshots are rejected; migrate persisted data explicitly before decoding.

Snapshots can be validated for storage or transport:

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
    { _tag: "Increment", by: 1 },
    { _tag: "Increment", by: 2 }
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

Use `guard: predicate` to decline before construction, or `declinable: true`
when a resolver can return `decline()`.
Pull requests that change `src/` or `package.json` need
a changeset and the performance checks described in `AGENTS.md`.

When equivalent Machine modules ship in Effect, this package is intended to
become a compatibility re-export before eventual retirement.
