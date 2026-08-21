# Effect Machine agent guide

Use this guide to model a statechart with `@typeonce/effect-machine`. It covers
the decisions that shape the machine. Use the API reference for method
signatures, history states, and choice states.

Read [Effect Atom and React patterns](./effect-atom-react.md) when React needs
to consume a machine. Keep React ownership and atom lookup out of the machine
model.

## Create a machine

Define schemas first, then states, events, the machine definition, and its
handlers. Export the state descriptor, public event descriptor, and implemented
machine. Tests, runtimes, and adapters can then use the same model.

```ts
import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

const CounterState = Schema.TaggedUnion({
  Running: { count: Schema.Number }
})

export const CounterStates = Machine.states({
  Idle: {},
  Running: CounterState.cases.Running
})

export const CounterEvents = Machine.events(
  Schema.TaggedUnion({
    Start: {},
    Increment: {},
    Stop: {}
  })
)

export const CounterMachine = Machine.make({
  id: "Counter",
  states: CounterStates.states,
  events: CounterEvents,
  initial: (to) => to.Idle()
}).handle({
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
```

Each step has one job:

- `Machine.states` declares the state tree and the data owned by each state.
- `Machine.events` declares the public messages the machine accepts and returns
  typed event constructors.
- `Machine.make` joins the state tree, event protocol, input, and initial state.
- `.handle` implements the behavior of every active state and returns the
  machine to export.

Chain `.handle` from `Machine.make`. Do not store the intermediate definition
when the module exports one machine implementation.

State builders construct the next snapshot. Use `.from(...)` when a state owns
data. The machine validates that input through the state schema while it plans
the transition.

The examples below show one modeling decision at a time. They omit unchanged
state and event declarations already shown above.

Start the implemented machine at the application boundary and send events
through the exported descriptor:

```ts
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const counter = yield* Machine.start(CounterMachine)

  yield* counter.send(CounterEvents.Start())
  yield* counter.send(CounterEvents.Increment())
})
```

## Make impossible states unrepresentable

A finite state describes how the machine behaves now. State data holds values
needed while that mode is active.

Do not model mutually exclusive modes with separate flags such as `loading`,
`data`, and `error`. Those fields permit combinations such as loading with both
data and an error. Put the modes in the state tree instead:

```ts
const RequestState = Schema.TaggedUnion({
  Ready: { value: Schema.String },
  Failed: { message: Schema.String }
})

const RequestStates = Machine.states({
  Idle: {},
  Loading: {},
  Ready: RequestState.cases.Ready,
  Failed: RequestState.cases.Failed
})
```

The machine can now be `Loading`, `Ready`, or `Failed`. It cannot construct a
snapshot that represents two of those modes at once.

Use this test when deciding between a state and a field: if the value changes
which events the machine should handle, which work runs, or how the machine
behaves, model it as a state. Otherwise, keep it as data on the state that owns
it.

## Put data on the lowest state that owns it

State data should exist only while it is valid. Put it on the lowest node whose
active subtree needs it. If several sibling states need the same data, their
compound parent owns it.

```ts
const DocumentState = Schema.TaggedUnion({
  Open: {
    documentId: Schema.String,
    draft: Schema.String
  },
  SaveFailed: {
    message: Schema.String
  }
})

const DocumentStates = Machine.states({
  Closed: {},
  Open: {
    // Editing, Saving, and SaveFailed all need the document and draft.
    schema: DocumentState.cases.Open,
    initial: "Editing",
    states: {
      Editing: {},
      Saving: {},
      // Only this state owns an error message.
      SaveFailed: DocumentState.cases.SaveFailed
    }
  }
})
```

Do not copy `documentId` and `draft` into every child. Copies can disagree after
a transition. Do not move `message` to `Open` either. That would allow an error
message while `Editing` or `Saving` is active.

## Put shared behavior on the lowest common ancestor

Hierarchy owns behavior as well as data. Define a transition on the lowest
compound state whose children share it.

```ts
const DocumentEvents = Machine.events(
  Schema.TaggedUnion({
    Close: {}
  })
)

const DocumentMachine = Machine.make({
  states: DocumentStates.states,
  events: DocumentEvents,
  initial: (to) => to.Closed()
}).handle({
  Closed: {},
  Open: {
    on: {
      // All Open children close the document in the same way.
      Close: (to) => to.full.Closed()
    },
    states: {
      Editing: {},
      Saving: {},
      SaveFailed: {}
    }
  }
})
```

The machine checks the deepest active state first, then its ancestors. Put a
handler on a child when that state needs different behavior. Keep the shared
case on the parent instead of repeating it in every child.

## Treat events as the domain protocol

An event tells the machine what was requested or what happened. Name events
after domain actions and outcomes. Do not expose state setters such as
`SetLoading` or `SetError`.

```ts
export const CheckoutEvents = Machine.events(
  Schema.TaggedUnion({
    Submit: {},
    Cancel: {}
  })
)

const CheckoutMachine = Machine.make({
  states: CheckoutStates.states,
  events: CheckoutEvents,
  initial: (to) => to.Editing()
}).handle({
  Editing: {
    on: {
      Submit: (to) => to.full.Submitting()
    }
  },
  Submitting: {
    on: {
      // Cancel has meaning while work is in progress.
      Cancel: (to) => to.full.Editing()
    }
  },
  Complete: {}
})
```

The sender requests `Submit`. The machine decides whether `Submit` has a
transition in the current state. The sender does not choose `Submitting`.

Carry facts that the machine cannot read from its current snapshot in the event
payload. Do not copy current state into an event to help a handler reconstruct
what the machine already knows.

## Use parallel states only for independent modes

A compound state activates one direct child. A parallel state activates one
child in every region. A parallel model therefore accepts the full product of
those regions.

```ts
const ScreenStates = Machine.states({
  Screen: {
    type: "parallel",
    states: {
      connection: {
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

This model permits all four combinations: online with a closed panel, online
with an open panel, offline with a closed panel, and offline with an open panel.

If one combination would break a domain rule, do not repair it with a UI check
or repeated cross-region conditions. Change the topology. A compound hierarchy
can place a mode only under the parent where it is valid.

## Let states own running work

Put asynchronous work on the state whose meaning requires that work. The
machine starts the work when it enters the state and interrupts it when it exits.
Handle expected success and failure as transitions.

```ts
const LoadState = Schema.TaggedUnion({
  Loading: { documentId: Schema.String },
  Ready: { content: Schema.String },
  Failed: { message: Schema.String }
})

const LoadStates = Machine.states({
  Idle: {},
  Loading: LoadState.cases.Loading,
  Ready: LoadState.cases.Ready,
  Failed: LoadState.cases.Failed
})

const LoadMachine = Machine.make({
  states: LoadStates.states,
  events: Machine.events(),
  initial: (to) => to.Idle()
}).handle({
  Idle: {},
  Loading: {
    invoke: (from) =>
      from
        .effect("load-document", ({ state }) => loadDocument(state.documentId))
        .onDone((to) => to.full.Ready().resolve(({ output, target }) => target.from({ content: output })))
        .onFailure((to) => to.full.Failed().resolve(({ error, target }) => target.from({ message: String(error) })))
  },
  Ready: {},
  Failed: {}
})
```

`loadDocument` may require Effect services. Those requirements remain on the
implemented machine type, so the runtime must provide them when it starts the
machine.

Do not start a promise inside a transition callback. A transition has no
lifetime in which to own that work. A state does.

## Keep transition decisions synchronous

A transition should choose the next state from the current snapshot and event.
Use ordinary TypeScript conditions when one event has several valid outcomes.

```ts
const ReviewEvents = Machine.events(
  Schema.TaggedUnion({
    Evaluate: { score: Schema.Number }
  })
)

const ReviewMachine = Machine.make({
  states: ReviewStates.states,
  events: ReviewEvents,
  initial: (to) => to.Pending()
}).handle({
  Pending: {
    on: {
      Evaluate: (to) =>
        to
          .branches({
            accepted: { target: to.full.Accepted() },
            rejected: { target: to.full.Rejected() }
          })
          .resolve(({ event, select }) =>
            event.score >= 80
              ? select.accepted.from()
              : select.rejected.from()
          )
    }
  },
  Accepted: {},
  Rejected: {}
})
```

Given the same snapshot and event, the handler should choose the same result.
Do not read the clock, generate randomness, call a service, or await work while
choosing a transition. Receive such values in an event or produce them through
state-owned work first.

## Test paths and invariants

Test the statechart as a graph. Send domain events, inspect reached states, and
state the rules that every trace must preserve. Do not duplicate the handler's
branches inside the test.

```ts
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect, Option } from "effect"

const testProgram = Effect.gen(function*() {
  const define = MachineTest.invariants(CounterMachine)

  const countNeverBecomesNegative = define.state(
    "count never becomes negative",
    ({ snapshot }) =>
      !CounterStates.matches(snapshot, "Running") ||
      CounterStates.get(snapshot, "Running").pipe(
        Option.exists(({ count }) => count >= 0)
      ) ||
      "count became negative"
  )

  const trace = yield* MachineTest.run(CounterMachine, {
    events: [
      CounterEvents.Start(),
      CounterEvents.Increment(),
      CounterEvents.Increment()
    ]
  })

  yield* MachineTest.verify(CounterMachine, trace)
  yield* MachineTest.checkInvariants(CounterMachine, trace, [
    countNeverBecomesNegative
  ])
})
```

Use pure planner traces for state and transition rules. Start a live machine
and use `MachineTest.probe` when a test depends on timers, invoked work, raised
events, or runtime scheduling.
