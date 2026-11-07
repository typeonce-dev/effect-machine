## Effect Machine agent guide

Use this guide to model a statechart with `@typeonce/effect-machine`. It covers
the decisions that shape the machine. Use the API reference for method
signatures, history states, and choice states.

Read [Effect Atom and React](#effect-atom-and-react) when React needs to consume
a machine. Keep React ownership and atom lookup out of the machine model.

### Create a machine

Define schemas first, then states, events, the machine definition, and its
handlers. Export the state descriptor, public event descriptor, and implemented
machine. Tests, runtimes, and adapters can then use the same model.

```ts
import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

const CounterState = Schema.TaggedUnion({
  Running: { count: Schema.Number }
})

export const CounterStates = Machine.state({
  states: {
    Idle: {},
    Running: CounterState.cases.Running
  }
})

export const CounterEvents = Machine.eventsFromSchemas(
  Schema.TaggedUnion({
    Start: {},
    Increment: {},
    Stop: {}
  })
)

export const CounterMachine = Machine.make({
  id: "Counter",
  root: CounterStates,
  events: CounterEvents
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: {
      on: {
        Start: { target: "Running", data: () => ({ count: 0 }) }
      }
    },
    Running: {
      on: {
        Increment: { update: { Running: ({ state }) => ({ count: state.count + 1 }) } },
        Stop: { target: "Idle" }
      }
    }
  }
})
```

Each step has one job:

- `Machine.state` declares the root, its child topology, and state-owned data.
- `Machine.events` declares the public messages the machine accepts and returns
  typed event constructors.
- `Machine.make` joins the state tree, event protocol, input, and reusable sources.
- `.handle` declares initial children and implements the behavior of every active state and returns the
  machine to export.

Chain `.handle` from `Machine.make`. Do not store the intermediate definition
when the module exports one machine implementation.

Use `data` for schema make input. Constructor defaults and validation run while
planning. Use `{ decoded: true, data }` for an existing schema Type; validation
still applies. Named selectors take the same object format, with nested children
under `states`. Structural states omit data. See [Root machine API](#root-machine-api) for
startup input, root initialization, subtree construction, and history fallbacks.

The examples below show one modeling decision at a time. They omit unchanged
state and event declarations already shown above.

Start the implemented machine at the application boundary and send events
through the exported descriptor:

```ts
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const counter = yield* Machine.start(CounterMachine)

  yield* counter.send(CounterEvents.Start())
  yield* counter.send(CounterEvents.Increment())
}))
```

`Machine.start` requires a `Scope`. Closing it stops the machine and everything
it owns; use `ref.stop` to stop earlier.

### Make impossible states unrepresentable

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

const RequestStates = Machine.state({
  states: {
    Idle: {},
    Loading: {},
    Ready: RequestState.cases.Ready,
    Failed: RequestState.cases.Failed
  }
})
```

The machine can now be `Loading`, `Ready`, or `Failed`. It cannot construct a
snapshot that represents two of those modes at once.

Use this test when deciding between a state and a field: if the value changes
which events the machine should handle, which work runs, or how the machine
behaves, model it as a state. Otherwise, keep it as data on the state that owns
it.

### Put data on the lowest state that owns it

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

const DocumentStates = Machine.state({
  states: {
    Closed: {},
    Open: {
      // Editing, Saving, and SaveFailed all need the document and draft.
      schema: DocumentState.cases.Open,
      states: {
        Editing: {},
        Saving: {},
        // Only this state owns an error message.
        SaveFailed: DocumentState.cases.SaveFailed
      }
    }
  }
})
```

Do not copy `documentId` and `draft` into every child. Copies can disagree after
a transition. Do not move `message` to `Open` either. That would allow an error
message while `Editing` or `Saving` is active.

### Put shared behavior on the lowest common ancestor

Hierarchy owns behavior as well as data. Define a transition on the lowest
compound state whose children share it.

```ts
const DocumentEvents = Machine.eventsFromSchemas(
  Schema.TaggedUnion({
    Close: {}
  })
)

const DocumentMachine = Machine.make({
  root: DocumentStates,
  events: DocumentEvents
}).handle({
  initial: { target: "Closed" },
  states: {
    Closed: {},
    Open: {
      initial: { target: "Open.Editing" },
      on: {
        // All Open children close the document in the same way.
        Close: { target: "Closed" }
      },
      states: {
        Editing: {},
        Saving: {},
        SaveFailed: {}
      }
    }
  }
})
```

The machine checks the deepest active state first, then its ancestors. Put a
handler on a child when that state needs different behavior. Keep the shared
case on the parent instead of repeating it in every child.

### Treat events as the domain protocol

An event tells the machine what was requested or what happened. Name events
after domain actions and outcomes. Do not expose state setters such as
`SetLoading` or `SetError`.

```ts
export const CheckoutEvents = Machine.eventsFromSchemas(
  Schema.TaggedUnion({
    Submit: {},
    Cancel: {}
  })
)

const CheckoutMachine = Machine.make({
  root: CheckoutStates,
  events: CheckoutEvents
}).handle({
  states: {
    Editing: {
      on: {
        Submit: { target: "Submitting" }
      }
    },
    Submitting: {
      on: {
        // Cancel has meaning while work is in progress.
        Cancel: { target: "Editing" }
      }
    },
    Complete: {}
  }
})
```

The sender requests `Submit`. The machine decides whether `Submit` has a
transition in the current state. The sender does not choose `Submitting`.

Carry facts that the machine cannot read from its current snapshot in the event
payload. Do not copy current state into an event to help a handler reconstruct
what the machine already knows.

### Use parallel states only for independent modes

A compound state activates one direct child. A parallel state activates one
child in every region. A parallel model therefore accepts the full product of
those regions.

```ts
const ScreenStates = Machine.state({
  states: {
    Screen: {
      type: "parallel",
      states: {
        connection: {
          states: {
            Online: {},
            Offline: {}
          }
        },
        panel: {
          states: {
            Closed: {},
            Open: {}
          }
        }
      }
    }
  }
})
const ScreenMachine = Machine.make({ root: ScreenStates, events: Machine.events({}) }).handle({
  initial: { target: "Screen" },
  states: {
    Screen: {
      states: {
        connection: { initial: { target: "Screen.connection.Online" } },
        panel: { initial: { target: "Screen.panel.Closed" } }
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

### Let states own running work

Put asynchronous work on the state whose meaning requires that work. The
machine starts the work when it enters the state and interrupts it when it exits.
Handle expected success and failure as transitions.

```ts
const LoadState = Schema.TaggedUnion({
  Loading: { documentId: Schema.String },
  Ready: { content: Schema.String },
  Failed: { message: Schema.String }
})

const LoadStates = Machine.state({
  states: {
    Idle: {},
    Loading: LoadState.cases.Loading,
    Ready: LoadState.cases.Ready,
    Failed: LoadState.cases.Failed
  }
})

const LoadMachine = Machine.make({
  root: LoadStates,
  effects: { loadDocument },
  events: Machine.eventsFromSchemas()
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: {},
    Loading: {
      invoke: {
        src: "loadDocument",
        input: ({ state }) => state.documentId,
        onDone: { target: "Ready", data: ({ output }) => ({ content: output }) },
        onFailure: { target: "Failed", data: ({ error }) => ({ message: String(error) }) }
      }
    },
    Ready: {},
    Failed: {}
  }
})
```

`loadDocument` may require Effect services. Those requirements remain on the
implemented machine type, so the runtime must provide them when it starts the
machine.

Model a per-instance capability, such as a router or a callback owned by a UI
component, as such a service. Do not put functions in state data or startup
input: snapshots must remain encodable. A React owner provides the capability
through its own runtime, as described in
[Per-owner capabilities](#per-owner-capabilities).

Do not start a promise inside a transition callback. A transition has no
lifetime in which to own that work. A state does.

Invoked work starts while the event that entered its state is processed. It
runs in the sender's turn until it first suspends, and its outcome is handled
in a later turn, even when the work completes without suspending. A state that
invokes work is therefore always observed before its outcome leaves it. Put a
browser call that requires user activation, such as `window.open` or
`navigator.clipboard.writeText`, in the first step of the invoked Effect:

```ts
effects: {
  authenticate: Effect.gen(function*() {
    // Runs inside the click that sent the event.
    const popup = yield* Effect.sync(() => window.open("about:blank", "auth", "popup"))
    return yield* signInWithPopup(popup)
  })
}
```

The sender also runs any synchronous work before that first suspension. Keep
expensive synchronous computation behind a suspension or in a separate state.

Give every invocation declared by one state a unique lifecycle ID. Give every
logic or child process that can be active at the same time a unique runtime
address as well:

```ts
// Register timers: { loadTimeout: "10 seconds" } in make.
Loading: {
  invoke: [
    {
      src: "loadDocument",
      input: ({ state }) => state.documentId,
      onDone: { target: "Ready", data: ({ output }) => ({ content: output }) },
      onFailure: { target: "Failed", data: ({ error }) => ({ message: String(error) }) }
    },
    { src: "loadTimeout", onDone: { target: "Idle" } }
  ]
}
```

Invocation outcomes are routed by state path and lifecycle ID, and overlapping
children cannot own the same runtime address. If work is sequential, represent
the sequence with separate states and transition from the first outcome. Do
not depend on one child completing quickly enough for another declaration to
reuse its identity.

#### Choose state-owned or process-owned children

Register a descriptor in `make({ children: { worker: Worker } })` and use
`invoke: { src: "worker", ...outcomes }` when a child belongs to one state and
must stop when that state exits. Use a child family and `children.spawn(...)`
inside a registered Effect when runtime events determine ids or cardinality
and the children must survive owner state changes. See the
dynamic children example in the package README for the complete
input mapping and service requirements.

The Effect owns the startup attempt. The machine process owns every child that
starts successfully. Leaving `Commissioning` does not stop those children.
Stop one with `children.stop(Worker(id))` inside an Effect or
`enqueue.stop(Worker(id))` inside a transition. A duplicate active id fails
instead of replacing the existing child, and a partially successful group is
not rolled back automatically.

### Keep transition decisions synchronous

A transition should choose the next state from the current snapshot and event.
Use ordinary TypeScript conditions when one event has several valid outcomes.

```ts
const ReviewEvents = Machine.eventsFromSchemas(
  Schema.TaggedUnion({
    Evaluate: { score: Schema.Number }
  })
)

const ReviewMachine = Machine.make({
  root: ReviewStates,
  events: ReviewEvents
}).handle({
  initial: { target: "Pending" },
  states: {
    Pending: {
      on: {
        Evaluate: {
          branches: [{ target: "Accepted" }, { target: "Rejected" }],
          resolve: ({ event, select }) =>
            event.score >= 80
              ? select.target("Accepted")
              : select.target("Rejected")
        }
      }
    },
    Accepted: {},
    Rejected: {}
  }
})
```

Given the same snapshot and event, the handler should choose the same result.
Do not read the clock, generate randomness, call a service, or await work while
choosing a transition. Receive such values in an event or produce them through
state-owned work first.

`resolve` is checked against `branches` in both directions, and each `select`
call takes the values of the path it is given. An agent can edit this one
transition without reading anything else: a missing entry, an entry that is never
selected, and a path that returns nothing are all compile errors that name the fix.

A `{ stay: true }` accepts its event without changing state, so `Machine.can`
reports `true` when a resolver selects it. When the event must be refused, for
example to disable a control, use `guard`, or list `{ decline: true }` and return
`select.decline()` from the resolver. `guard` and `decline` exist only on `on`
handlers and `always`: an invocation outcome, a completion, and a choice have no
other candidate, so they use `{ stay: true }` or select a destination. A declined
invocation outcome would strand the machine in its state.

A `{ stay: true }` in one parallel region accepts the event, so it blocks a handler
for that event on a parallel ancestor. `{ decline: true }` lets that handler run.

Enqueue work with `commands` on any plain transition, and with `enqueue` in
`resolve`:

```ts
Cancelled: {
  target: "Archived",
  commands: (_, enqueue) => enqueue.emit(Emitted.Cancelled())
}
```

When only an active state's value changes, use `update` to preserve its active
descendants and running work:

```ts
Changed: {
  update: {
    Document: ({ ancestors }) => ({
      ...ancestors.Document,
      revision: ancestors.Document.revision + 1
    })
  }
}
```

Choose a valued source or retained ancestor explicitly. To change a parallel
sibling, send an event handled by that sibling. Combine a destination and one
retained owner update with `{ target, data, update: { Owner: ... } }`, where `data`
only ever means the target's value. Both values are validated atomically, and
destination entry sees the new owner value. A `branches` entry names the same pair
as `{ target, update: "Owner" }`, and its call passes the value:
`select.target(target, { data, update: { Owner: value } })`.

The destination of `{ target, update, data }` can be a choice. The owner is
updated before the choice resolves, so its resolver reads the new value through
`containingState`, `ancestors`, or `root`, and `data` returns only the complete
owner input. Every branch the choice can reach, including through nested
choices, must stay below the owner; otherwise the definition does not compile
and `handle` throws while naming the choice, branch, and escaping target.

### Verify a machine after changing it

Run this after writing or changing a machine, before writing a specific test:

```ts
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect } from "effect"

const verifyCounter = Effect.gen(function*() {
  const report = yield* MachineTest.check(CounterMachine)
  if (!report.ok) yield* Effect.die(MachineTest.formatCheckReport(report))
})
```

From a shell, `effect-machine check src/counter.ts --json` from
`@typeonce/effect-machine-devtools` does the same for every machine a file exports.

To fix a finding, keep the failing evidence first. Replay its events to reproduce
it, make the smallest behavior change, then run the check again. Do not silence a
finding by weakening a type or a test.

| Law                          | Meaning                                                         | Fix                                                                 |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `topology.noPathFromInitial` | No declared transition can enter the state.                     | Add the missing transition, or remove the state.                    |
| `events.noHandler`           | No state handles a public event.                                | Handle it, or remove it from the protocol.                          |
| `planning.deterministic`     | The same snapshot and event planned two different results.      | Move the clock, randomness, or external read into an event or work. |
| `planning.failed`            | A planning callback threw or a value failed its schema.         | Replay the events, then fix the callback or the value.              |
| `planning.verification`      | A planner law failed. This usually means an Effect Machine bug. | Report it with the replay.                                          |
| `invariant.violated`         | An invariant you supplied failed.                               | Replay the events, then fix the behavior or the invariant.          |
| `transition.notCovered`      | Exploration never took a declared branch. This is a warning.    | Cover it with a scenario, or remove it if it cannot happen.         |
| `schema.underivable`         | Input or events could not be sampled from their schemas.        | Pass `input` or `events` explicitly.                                |

A report is `"exhaustive"` only when `limits` is empty. Otherwise a pass means
nothing was found in what was explored. Keep sampled checks, bounded exploration,
and proof distinct when reporting a result. Invocations do not run during planning,
so test them on a started machine with `MachineTest.probe`.

### Test paths and invariants

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

### Choose observation deliberately

Use atom selectors to render state, invocation outcomes to express workflow
behavior, `ref.join` to await final output, and `ref.changes` for ongoing
observation. Emissions are non-replayed notifications; do not use them for work
the workflow depends on, such as navigation. Reach for
`Machine.waitFor(ref, predicate)` only when an external Effect or test must wait
for a specific current or subsequent snapshot, such as a long-lived connection
becoming ready. Compose `Effect.timeout` when needed.

Do not use `send` followed by `waitFor` as an acknowledgement protocol. The current
snapshot might already match, and a match does not identify which event caused
it. Keep workflow steps in the machine. A matching terminal snapshot succeeds;
an unmatched error preserves its Cause, stopping fails with `StoppedError`, and
completion without a match fails with `Cause.NoSuchElementError`.

Invoked Effects, Streams, and timers already receive a `Machine.invoke` Effect
span with machine, state, source, and invocation identity. Use ordinary Effect
tracing configuration and application spans such as `Effect.fn("Payments.charge")`.
Do not add manual spans around every transition or introduce a second exporter.
Sender trace context is not automatically carried through machine mailboxes.
