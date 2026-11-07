# Effect Machine documentation

This documentation covers `@typeonce/effect-machine` and its related packages.
It is generated for the installed version, so prefer it over any other copy.

**Note**: The examples contain comments for illustration. In practice, you would
not include them in your code.

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

#### Creating and running a machine

Declare the topology, the protocol, and the behavior, then start the result
inside a Scope.

```ts
import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

// The root declares the topology and the data each state owns.
export const CounterStates = Machine.state({
  states: {
    Idle: {},
    Running: { fields: { count: Schema.Number } }
  }
})

// Events are the public protocol. Each one also becomes a typed constructor.
export const CounterEvents = Machine.events({ Start: {}, Increment: {}, Stop: {} })

// `make` joins the topology and protocol. `handle` implements every state and
// returns the machine to export.
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

// `Machine.start` requires a Scope. Closing it stops the machine and everything
// the machine owns.
export const program = Effect.scoped(Effect.gen(function*() {
  const counter = yield* Machine.start(CounterMachine)

  yield* counter.send(CounterEvents.Start())
  yield* counter.send(CounterEvents.Increment())
}))
```

#### Choosing a destination from an event

List every destination in `branches`, next to the `resolve` that selects one.
The compiler checks one against the other, so this transition can be edited
without reading anything else.

```ts
import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const CheckoutStates = Machine.state({
  fields: { attempts: Schema.Number },
  states: {
    Editing: {},
    Charging: { fields: { amount: Schema.Number } },
    Paid: {}
  }
})

export const CheckoutEvents = Machine.events({
  Pay: { amount: Schema.Number },
  Paid: {}
})

export const CheckoutMachine = Machine.make({
  root: CheckoutStates,
  events: CheckoutEvents
}).handle({
  root: { attempts: 0 },
  initial: { target: "Editing" },
  states: {
    Editing: {
      on: {
        Pay: {
          // `stay` accepts the event, so `Machine.can` is true. `decline` refuses it, so `Machine.can` is false and a
          // parent handler for the same event runs.
          branches: [{ target: "Charging" }, { target: "Paid" }, { update: "root" }, { stay: true }, { decline: true }],
          resolve: ({ event, root, select }) => {
            if (event.amount < 0) return select.decline()
            if (event.amount === 0) return select.target("Paid")
            if (root.attempts >= 3) return select.stay()
            if (event.amount > 1_000) return select.update({ root: { attempts: root.attempts + 1 } })
            // Each call takes the values of the path it is given.
            return select.target("Charging", { data: { amount: event.amount } })
          }
        }
      }
    },
    Charging: {
      on: {
        Paid: { target: "Paid" }
      }
    }
  }
})
```

#### Updating retained state and enqueueing commands

`data` only ever means the target's value. `update` is a record naming the one
retained state it replaces. `commands` enqueues work on any plain transition.

```ts
import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const DocumentEmitted = Machine.emittedEvents({ Saved: { revision: Schema.Number } })

export const DocumentMachine = Machine.make({
  root: Machine.state({
    states: {
      Document: {
        fields: { revision: Schema.Number },
        states: {
          Editing: {},
          Saving: { fields: { draft: Schema.String } }
        }
      }
    }
  }),
  events: Machine.events({ Change: {}, Save: { draft: Schema.String }, Saved: {} }),
  emittedEvents: DocumentEmitted
}).handle({
  initial: { target: "Document", data: { revision: 0 } },
  states: {
    Document: {
      initial: { target: "Document.Editing" },
      on: {
        // Replaces the value of Document and keeps its active child and running work.
        Change: { update: { Document: ({ state }) => ({ revision: state.revision + 1 }) } }
      },
      states: {
        Editing: {
          on: {
            // Enters a state and replaces a retained ancestor in one validated step.
            Save: {
              target: "Document.Saving",
              data: ({ event }) => ({ draft: event.draft }),
              update: { Document: ({ ancestors }) => ({ revision: ancestors.Document.revision + 1 }) }
            }
          }
        },
        Saving: {
          on: {
            Saved: {
              target: "Document.Editing",
              commands: ({ ancestors }, enqueue) =>
                enqueue.emit(DocumentEmitted.Saved({ revision: ancestors.Document.revision }))
            }
          }
        }
      }
    }
  }
})
```

#### Verifying a machine after changing it

Run `MachineTest.check` after every change. It needs no test setup, and a
finding names the law it broke and the events that reproduce it.

```ts
import { Machine } from "@typeonce/effect-machine"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect } from "effect"

export const SwitchMachine = Machine.make({
  root: Machine.state({ states: { Off: {}, On: {} } }),
  events: Machine.events({ Toggle: {} })
}).handle({
  initial: { target: "Off" },
  states: {
    Off: { on: { Toggle: { target: "On" } } },
    On: { on: { Toggle: { target: "Off" } } }
  }
})

export const verified = Effect.gen(function*() {
  const report = yield* MachineTest.check(SwitchMachine)
  if (!report.ok) {
    return yield* Effect.die(MachineTest.formatCheckReport(report))
  }
  // "exhaustive" means nothing limited exploration. "bounded" lists why in `limits`, and is not a proof.
  return report.exploration
})
```

## Root machine API

A machine has one root state. It can own data, child topology, both, or neither.
`Machine.state` declares that structure; `Machine.make` declares protocols and
reusable sources; `.handle` supplies initialization and behavior.

### Startup input and state data

```ts
import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

const Root = Machine.state({
  fields: { locale: Schema.String },
  states: {
    Loading: { fields: { documentId: Schema.String } },
    Ready: {}
  }
})
const Events = Machine.events({
  Loaded: {},
  Reload: { locale: Schema.String, documentId: Schema.String }
})
const Document = Machine.make({
  root: Root,
  events: Events,
  input: Schema.Struct({ locale: Schema.String, documentId: Schema.String })
}).handle({
  root: ({ input }) => ({ locale: input.locale }),
  initial: {
    target: "Loading",
    data: ({ input }) => ({ documentId: input.documentId })
  },
  on: {
    Reload: {
      initialize: ({ event }) => ({ locale: event.locale, documentId: event.documentId }),
      reenter: true
    }
  },
  states: {
    Loading: { on: { Loaded: { target: "Ready" } } }
  }
})
```

Start with `Machine.start(Document, { locale: "en", documentId: "intro" })`.
Root construction runs before its initial child construction. Both receive the
same validated input. `documentId` belongs only to Loading; it need not be stored
in root data. Input is not retained as a reset value on the machine or snapshot.

Only the root's initial callbacks receive machine input. Nested initial callbacks
receive their owning state, ancestors, root, and lifecycle event. Pass any needed
values through the nested state's data. Input is not an entry/exit capability.

For a parallel root, every required region constructor receives input:

```ts
initial: {
  Documents: ({ input }) => ({ folder: input.folder }),
  Connection: ({ input }) => ({ endpoint: input.endpoint })
}
```

Structural regions require no data. Schema constructor defaults can supply
optional region data. Compound handlers declare one direct initial child with
`initial: { target, data }`; each compound has its own initial declaration.
There is no `initialConfiguration` or initializer in `make`.

### Root initialization and updates

The root is spelled `"root"` in declarations, so a top-level state cannot use
that name. It is not a transition destination.

`{ initialize: ... }` reconstructs root data and follows its initial
declarations using fresh machine input: a value or a callback of the transition
context. A machine without input declares `{ initialize: true }`. `initialize`
rejects `target`, `update`, `history`, `stay`, `data`, and `decoded`. A `branches`
entry declares `{ initialize: true }`, and its resolver passes the input with
`select.initialize({ input })`.

Initializing root retains its lifecycle unless it is reentered. Put a machine-wide
reset handler at root and use `reenter: true` to exit and enter root as well as
its descendants. Reentry restarts work owned by the exited states. Without
reentry, retained root work continues; it does not automatically acquire new
construction values. Ordinary transition conflict and lifecycle rules still apply.
This does not create a new machine reference or discard history records.

`{ update: { root: ... } }` instead replaces root's complete value,
retaining its active children and running work. It takes no input and does not
run initial constructors. Other source/ancestor updates follow the same rules.

### Inline and branching construction

Ordinary transitions stay inline:

```ts
Load: {
  target: "Loading",
  data: ({ event }) => ({ documentId: event.documentId })
}
```

Targeting a compound or parallel state follows its initial declarations. Event
transitions use `target`, never `initial`. `initial` names only handler startup
edges. `history` restores a declared history state; `stay: true` accepts an
event without changing its target configuration.

List `branches` next to `resolve` when a transition chooses an outcome or builds
an explicit subtree. The compiler checks one against the other in both directions:

```ts
Open: {
  branches: [{ target: "Checkout" }, { stay: true }],
  resolve: ({ event, select }) => event.open
    ? select.target("Checkout", {
      data: { cartId: event.cartId },
      states: { Review: { data: { total: event.total } } }
    })
    : select.stay()
}
```

Objects contain computed values, not nested constructor callbacks. `data` is
schema make input; `{ decoded: true, data: value }` supplies the decoded type.
Both paths validate and report typed schema failures before committing changes.
The decoded flag applies only to its own node. Structural nodes reject data.

Omitting `states` follows declared initial children. Explicit compound
construction selects exactly one child. Entering an inactive parallel subtree
requires every region. Source-local parallel construction can select a single
region while retaining its active siblings, preserving the existing scope rules.
Names under `states` cannot collide with construction metadata.

Each branch's destination remains inspectable without executing `resolve`.
Dynamically selected descendants are visible after resolution; this API does not
add static analysis of resolver bodies.

### Retained-owner updates

An inline combined transition keeps the target's value and the owner's value
separate, so `data` only ever means the target's value:

```ts
Save: {
  target: "Checkout.Saving",
  data: ({ event }) => ({ requestId: event.requestId }),
  update: { Checkout: ({ event }) => ({ cartId: event.cartId }) }
}
```

A `branches` entry names the same pair, `{ target: "Checkout.Saving", update: "Checkout" }`,
and its call constructs both:

```ts
select.target("Checkout.Saving", {
  data: { requestId: event.requestId },
  update: { Checkout: { cartId: event.cartId } }
})
```

`update` takes exactly one owner. It is not an
arbitrary nested-state operation. The owner must be active and retained across
the transition. Both complete values validate before either is committed.

### History and lifecycle

History fallback uses a bound function with the same node object format:

```ts
history: {
  recent: {
    default: ({ target }) => target({
      states: {
        Checkout: {
          data: { cartId: "new" },
          states: { Review: { data: { total: 0 } } }
        }
      }
    })
  }
}
```

A fallback must explicitly construct a complete tree containing its owner,
including required ancestors and parallel siblings. Its root data is state data,
not startup input. `Machine.resume` restores a validated snapshot without rerunning
startup constructors.

`guard` declines before construction. A resolver may return `select.decline()` only
when `branches` lists `{ decline: true }`. Both exist only on `on` handlers and
`always`. Effect, Stream, timer, logic, child invocation, completion,
entry/exit, and required outcome channels retain their existing contracts.

## Effect Atom and React

React code should own one stable machine atom, pass it through props or
Context, and subscribe in the descendants that render machine state. Keep the
machine definition free of React dependencies.

Read [Effect Machine agent guide](#effect-machine-agent-guide) for statechart
modeling, transitions, services, and testing.

### Recommended folder structure

```text
src/
├── context/
│   └── auth-machine-context.tsx  # React ownership and distribution
├── lib/
│   ├── atom-runtime.ts           # Shared bound AtomMachine runtime
│   └── services/
└── machines/
    └── auth-machine.ts           # States, events, and behavior
```

`machine.ts` owns the workflow. A Context module only creates and distributes
the machine atom. State-slot components decide which state paths they render.

Bind service-backed machines once at the application runtime:

```ts
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Atom } from "effect/reactivity"
import { AppLayer } from "./app-layer"

const atomRuntime = Atom.runtime(AppLayer)

export const MachineAtoms = AtomMachine.bind(atomRuntime)
```

Service-free machines can use `AtomMachine.make` directly.

### Own a machine in one React subtree

Create a context from a factory. Each Provider owns a fresh bridge in its current
Atom registry; it does not subscribe to state changes.

```tsx
import { createMachineContext } from "@typeonce/effect-machine-react"
import { MachineAtoms } from "../lib/atom-runtime"
import { AuthMachine } from "../machines/auth-machine"

export const Auth = createMachineContext(({ input }: { input: AuthInput }) => MachineAtoms.make(AuthMachine, input))
export const useAuthMachine = Auth.useMachine

function AuthRoute({ input, attemptId }: Props) {
  return (
    <Auth.Provider key={attemptId} input={input}>
      <AuthCard />
    </Auth.Provider>
  )
}
```

The factory takes one options object, and each option it declares is a
Provider prop of the same name and type. A machine without input can pass
`MachineAtoms.factory(Machine)` directly, and its Provider takes no `input`.
Input is startup-only. Send events to update the existing workflow; change the
Provider's React key to create a new one. `MachineState` does not suspend, so
the first paint needs no Suspense boundary. Custom readers that use
`useAtomSuspense` still suspend during startup; keep the Provider above their
Suspense boundary so suspension does not discard the owner. Supply an Atom
RegistryProvider at the application boundary. The same factory used by two Providers creates isolated
machines, even when their inputs are equal.

`useMachineAtom(() => makeMachine(input))` remains available for custom owners.
It mounts the reference after commit without reading `result` or `snapshot`.

### Per-owner capabilities

A router, a callback owned by a component, or another per-instance capability
is a service, never a schema field or startup input. Declare the service, let a
state invoke the work that needs it, and provide the implementation from the
React owner:

```tsx
import { Machine } from "@typeonce/effect-machine"
import { useMachineAtom } from "@typeonce/effect-machine-react"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Context, Effect, Layer } from "effect"
import { Atom } from "effect/reactivity"
import { AppLayer } from "../lib/app-layer"

export class Navigation extends Context.Service<Navigation, {
  readonly push: (href: string) => Effect.Effect<void>
}>()("Navigation") {}

export const OnboardingMachine = Machine.make({
  root: Machine.state({
    states: { Editing: {}, Leaving: {}, Done: { type: "final" } }
  }),
  events: Machine.events({ Submit: {} }),
  effects: {
    navigateNext: Effect.flatMap(Navigation, (navigation) => navigation.push("/onboarding/next"))
  }
}).handle({
  initial: { target: "Editing" },
  states: {
    Editing: { on: { Submit: { target: "Leaving" } } },
    Leaving: { invoke: { src: "navigateNext", onDone: { target: "Done" } } },
    Done: {}
  }
})

function OnboardingRoute() {
  const router = useRouter()
  const machine = useMachineAtom(() =>
    AtomMachine
      .bind(Atom.runtime(Layer.merge(
        AppLayer,
        Layer.succeed(Navigation, {
          push: (href) => Effect.sync(() => router.push(href))
        })
      )))
      .make(OnboardingMachine)
  )

  return <OnboardingForm machine={machine} />
}
```

The requirement stays on the machine type. Binding the machine to a runtime
without `Navigation`, such as the application-wide `MachineAtoms`, is a compile
error. Snapshots contain only schema data, so `Machine.encodeSnapshot` keeps
working, and tests substitute the capability with `Layer.mock(Navigation, ...)`.

Create the runtime inside the `useMachineAtom` factory so each owner builds it
once. `Atom.runtime` builds layers through the registry's memo map: the shared
`AppLayer` is built once per registry and reused, and each owner builds only its
own capability layer. Use `Layer.provideMerge(ownerLayer, AppLayer)` when the
owner layer itself needs application services.

To share the owner-bound machine with a subtree, declare the capability as a
`layer` option of a `createMachineContext` factory. `OnboardingMachine` has no
input, so the factory declares only `layer`:

```tsx
import { createMachineContext } from "@typeonce/effect-machine-react"

const navigationLayer = (router: Router) =>
  Layer.succeed(Navigation, {
    push: (href) => Effect.sync(() => router.push(href))
  })

export const Onboarding = createMachineContext(
  ({ layer }: { layer: Layer.Layer<Navigation> }) =>
    AtomMachine
      .bind(Atom.runtime(Layer.provideMerge(layer, AppLayer)))
      .make(OnboardingMachine)
)

function OnboardingRoute() {
  return (
    <Onboarding.Provider layer={navigationLayer(useRouter())}>
      <OnboardingForm />
    </Onboarding.Provider>
  )
}
```

The Provider requires a `layer` prop of exactly the declared `Layer` type, and
an `input` prop when the factory also declares input, as in
`({ input, layer }: { input: SignInInput; layer: Layer.Layer<Navigation> })`.
Options other than `input` and `layer` are rejected, so a capability cannot
travel under another name. A factory without a `layer` option has a Provider
without a `layer` prop. Like `input`, the layer is read once, when the Provider
mounts: a new router instance does not rebuild the running machine. Change the
Provider's React `key` to create a new owner with a new layer. Binding still
checks the machine's requirements, so a layer type that omits `Navigation` is a
compile error.

### Render state-owned data

Render a typed path in the smallest component that needs it:

```tsx
import { MachineState } from "@typeonce/effect-machine-react"

function EditingFields() {
  const machine = useAuthMachine()
  return (
    <MachineState machine={machine} path="Editing" inactive={null}>
      {({ value }) => <EmailField email={value.email} />}
    </MachineState>
  )
}
```

`MachineState` subscribes only its renderer. The path determines the callback's
snapshot type. It does not suspend: until the machine has a snapshot it renders
`pending`, and an inactive path renders `inactive` (both null by default).
Startup and runtime failures reach the nearest error boundary. Once a snapshot
has rendered, the renderer keeps it while the machine is still starting, for
example while a bound runtime layer builds after hydration.

`MachineState` also renders a child machine. Pass the child bridge; paths and
the snapshot are then the child's, and `inactive` also renders while the state
that owns the child is not active:

```tsx
<MachineState machine={machine.child(QuantityChild)} path="" inactive={null}>
  {(snapshot) => <NumberField value={snapshot.value.quantity} />}
</MachineState>
```

For custom hooks, `useMachineResult(atom)` reads any result atom, such as
`AtomMachine.selectSnapshot(machine, path)`, `matches`, or `can`, with the same
rendering semantics as `MachineState`: it does not suspend, serves the planned
value during server rendering and hydration, and keeps the last `Success` while
the machine is still starting. Prefer it to `useAtomValue`, which returns
`Initial` again after hydration and makes the renderer replace hydrated markup.
`useAtomSuspense(AtomMachine.selectSnapshot(machine, path)).value` returns an
Option of the selected snapshot for readers inside a Suspense boundary.

`AtomMachine.select` returns the selected state value.
`AtomMachine.selectSnapshot` also retains the selected state's child topology.
Both return `Option.none()` while the path is inactive. Do not replace that
absence with an empty string, `null`, or a global boolean.

Repeated calls with the same machine and path return the same atom, so path
selection is safe during render without `useMemo`. Equal selected values do not
notify the component.

Nested paths keep the same ownership:

```tsx
function PasswordField() {
  const machine = useAuthMachine()
  const password = useAtomSuspense(
    AtomMachine.select(machine, "Editing.Password")
  ).value

  return Option.match(password, {
    onNone: () => null,
    onSome: ({ password }) => <input type="password" value={password} />
  })
}
```

Place independent subscriptions in independent descendants:

```tsx
function AuthCard() {
  return (
    <>
      <EditingFields />
      <VerificationFields />
      <FailureMessage />
      <SubmitButton />
    </>
  )
}
```

Atom granularity cannot isolate hooks that all live in `AuthCard`. Any selected
change rerenders the component that called the hook.

### Send without subscribing

Use the writable atom directly:

```tsx
import { useAtomSet } from "@effect/atom-react"

function SubmitButton() {
  const machine = useAuthMachine()
  const send = useAtomSet(machine.send)

  return (
    <button onClick={() => send({ _tag: "Submitted" })}>
      Continue
    </button>
  )
}
```

`useAtomSet` mounts the writable atom and does not subscribe the component to
its value.

A write to a ready machine is processed inside the event handler, and work
invoked by the entered state starts there too. A browser call that requires
user activation, such as `window.open`, `navigator.clipboard.writeText`, or
`HTMLMediaElement.play`, can therefore run in the first step of the invoked
Effect. A write held while the machine is still starting is delivered later,
outside the user's gesture.

Writes made while the machine is still starting, for example while a bound
`Atom.runtime` layer is building after hydration, are held and delivered in
write order once the machine is ready. The write result stays waiting until
the event is delivered and fails with the startup error if startup fails.
Writes after the machine stopped or completed fail with `StoppedError`. The
same applies to `stop` and to child `send` and `stop`; a child command fails
with `ChildNotActiveError` when the state that owns the child is not active.

### Query concrete event acceptance

`AtomMachine.can` turns one concrete event input into a reusable machine
projection. Declare the projection once, then apply it to the React-owned
machine. Repeated applications to the same machine return the same atom:

```tsx
import { useAtomSet, useAtomSuspense } from "@effect/atom-react"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { AuthEvents } from "../machines/auth-machine"

const submitAllowed = AtomMachine.can(AuthEvents.Submitted())

function SubmitButton() {
  const machine = useAuthMachine()
  const canSubmit = useAtomSuspense(submitAllowed(machine)).value
  const send = useAtomSet(machine.send)

  return (
    <button
      disabled={!canSubmit}
      onClick={() => send(AuthEvents.Submitted())}
    >
      Continue
    </button>
  )
}
```

Startup still suspends, startup and runtime failures reach the error boundary,
and invalid event input for an active machine remains a
`MachineSchemaDecodeError`. Done and stopped machines return `false`.

When acceptance depends on a changing payload, project an event atom instead:

```ts
import { Atom } from "effect/reactivity"

const submitEvent = Atom.map(draftAtom, (draft) => AuthEvents.Submitted({ draft }))

const submitAllowed = AtomMachine.can(submitEvent)
```

Changes to `draftAtom` recompute acceptance. The event atom contains the event
input itself rather than an `AsyncResult`.

`can` is `true` whenever the active configuration selects a transition. A
`{ stay: true }` branch is a selected transition: it accepts the event without
changing state. A resolver that falls back to `stay` therefore keeps the button
enabled:

```ts
// Before: an incomplete form still accepts Submitted, so `can` is true.
Submitted: {
  branches: [{ target: "Reviewing" }, { stay: true }],
  resolve: ({ state, select }) =>
    state.email.length > 0 ? select.target("Reviewing") : select.stay()
}
```

When the event must be refused, decline it. Use `guard` for an ordinary
transition, or `{ decline: true }` with `select.decline()` in a resolver:

```ts
// After: an incomplete form declines Submitted, so `can` is false.
Submitted: { target: "Reviewing", guard: ({ state }) => state.email.length > 0 }

// A resolver that needs commands or construction declines explicitly.
Submitted: {
  branches: [{ target: "Reviewing" }, { decline: true }],
  resolve: ({ state, select }) =>
    state.email.length > 0 ? select.target("Reviewing") : select.decline()
}
```

Keep `stay` for events that are deliberately accepted and ignored. The
`effect-machine/no-conditional-stay-branch` lint rule reports the conditional
fallback.

Query acceptance during render through `AtomMachine.can(event)(machine)`. Do
not call `Effect.runSync(Machine.can(...))` in a component: the atom shares the
running machine's snapshot, suspends during startup, and recomputes when the
snapshot changes.

### Whole-result and custom selections

Reading the full result is correct when a component renders the complete
machine state:

```tsx
function AuthScreen() {
  const machine = useAuthMachine()
  const state = useAtomSuspense(machine.result).value

  return <MachineSummary snapshot={state} />
}
```

That component rerenders for every result change. Prefer typed path selectors
for state-owned UI.

Selection and equality belong to atoms, not to React hooks. To subscribe to
part of a selected value, derive an atom from the path selector and give it the
equality that defines a meaningful change. Declare the derivation once with
`Atom.family`, keyed by the machine atom, so every render reuses the same atom:

```tsx
import { useAtomSuspense } from "@effect/atom-react"
import { Equal, Option } from "effect"
import { Atom } from "effect/reactivity"

type AuthMachineAtom = ReturnType<typeof useAuthMachine>

const editingEmail = Atom.family((machine: AuthMachineAtom) =>
  Atom.mapResult(
    AtomMachine.select(machine, "Editing"),
    Option.map(({ email }) => email)
  ).pipe(Atom.withEquality(Equal.equals))
)

function EmailField() {
  const machine = useAuthMachine()
  const email = useAtomSuspense(editingEmail(machine)).value

  return Option.match(email, {
    onNone: () => null,
    onSome: (email) => <input value={email} />
  })
}
```

The component rerenders only when the projected email changes, not when other
`Editing` fields change. Do not create a fresh derived atom on every render.

### Share a keyed machine outside one React owner

`AtomMachine.family` is for registry-owned machines that unrelated consumers
find by startup input. It is not the default for one React-owned workflow.

```ts
export const processAtoms = MachineAtoms.family(ProcessMachine, {
  atoms: {
    details: AtomMachine.select("Processing"),
    ready: AtomMachine.matches("Ready"),
    send: (machine) => machine.send
  }
})
```

Consumers use the input as the shared identity key:

```tsx
const details = useAtomSuspense(processAtoms.details(input)).value
const send = useAtomSet(processAtoms.send(input))
```

Each public projection retains its private machine owner. Keeping only
`details(input)` or `send(input)` is safe. Do not return a weakly held composite
scope and retain only one field from it.

Family keys use Effect `Equal` and `Hash` semantics. Keep them immutable. If a
changing value should update one running workflow, model it as an event instead
of changing the family key.

### Module-owned machines

A no-input machine may intentionally have one module-owned identity:

```ts
export const CounterMachineAtom = MachineAtoms.make(CounterMachine)
export const CounterStateAtom = AtomMachine.select(CounterMachineAtom, "Count")
```

Every consumer using the same `AtomRegistry` reaches the same running machine.
Different registries still run independent instances.

### Child machines

Direct child selectors follow the active child and preserve inactivity:

```tsx
const editor = machine.child(Editor)
const editing = useAtomSuspense(
  AtomMachine.selectSnapshotChild(editor, "Editing")
).value
```

An inactive child or path returns `Option.none()`. Re-entry follows the
replacement child instance. `MachineState` accepts the child bridge directly
and renders `inactive` in both cases.

Use `AtomMachine.familyChild` when a parent owns a runtime-sized set of keyed
children:

```ts
const Plant = Machine.childFamily(PlantMachine)

export const plantAtoms = AtomMachine.familyChild(CentralMachineAtom, {
  child: (plantId: string) => Plant(plantId),
  atoms: {
    broken: AtomMachine.matchesChild("Broken"),
    state: (plant) => plant.result,
    send: (plant) => plant.send
  }
})
```

### Generic helpers

Use `AtomMachine.MachineAtom.Any` and `AtomMachine.ChildMachineAtom.Any` to
accept any bridge, including bridges for machines without events. Recover the
exact types with the namespace extractors:

```ts
function StateView<A extends AtomMachine.MachineAtom.Any>(props: {
  readonly machine: A
  readonly render: (state: AtomMachine.MachineAtom.State<A>) => React.ReactNode
}) {
  const state = useAtomSuspense(props.machine.result).value
  return props.render(state)
}

type AuthEvent = AtomMachine.MachineAtom.Event<typeof AuthMachineAtom>
type EditorState = AtomMachine.ChildMachineAtom.State<
  AtomMachine.ChildOf<typeof AuthMachineAtom, typeof Editor>
>
```

### Keep workflow effects out of emissions

Emissions are ephemeral notifications for observers. They are not replayed, so
a subscriber that mounts late never sees an earlier emission. Do not drive work
the workflow depends on, such as navigation, from emissions. Invoke that work
from the state that requires it through a capability service, as in
[Per-owner capabilities](#per-owner-capabilities); the machine then decides when
it runs, what cancels it, and how failure changes the workflow.

An emission that only feeds UI feedback has two stream-atom details:

- `Atom.make(AtomMachine.emissions(machine))` publishes each emission as a
  waiting `Success`, then publishes the last emission again, no longer waiting,
  when the machine completes. Handlers must tolerate that repeated value.
- `useAtomSubscribe(atom, f)` subscribes after commit without reading the atom.
  Pass `{ immediate: true }` so a lazy emissions atom starts; without it the
  callback never runs. The callback then also receives the initial result.

### Registry and rendering semantics

A `MachineAtom` identifies one machine per `AtomRegistry`. Passing the same
machine atom through two registry providers creates two independent runtimes.
Unmounting a React owner releases its mount. The registry stops the machine
after its final subscription and configured idle retention expire.
`registry.dispose()` stops it immediately.

`useMachineAtom` does not start a machine during server rendering because
React effects do not run on the server. Server reads never start a machine
either. Every bridge atom carries an Effect Atom server value, which
`@effect/atom-react` hooks read during server rendering and hydration, and
`Atom.getServerValue` reads directly:

| Atom                                         | Server value                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ref`, `send`, `stop`                        | `Initial`                                                                                                     |
| `snapshot`                                   | `Success({ status: "active", state })`, waiting                                                               |
| `result`                                     | `Success(state)`, waiting                                                                                     |
| `select`, `selectSnapshot`, `matches`, `can` | the projection of `state`, waiting                                                                            |
| `child(Child).result` and child projections  | `Success(Option.some(childState))` when the planned state invokes `Child`, otherwise `Success(Option.none())` |
| `family` and `familyChild` projections       | the server value of the projected bridge atom                                                                 |

`state` is the machine's planned startup state: the state `Machine.planInitial`
settles into with the bridge's input, without running startup commands,
invocations, or services. A resumed bridge uses its resumed snapshot. Children
spawned at runtime or through child families are `Option.none()`. When the
startup state cannot be planned synchronously, for example because the input
is invalid, every server value is `Initial`. Each bridge plans at most once,
on its first server read.

### Server rendering and hydration

Render state slots with `MachineState` and no Suspense boundary:

```tsx
<Onboarding.Provider input={input}>
  <MachineState machine={Onboarding.useMachine()} path="Editing">
    {(editing) => <input value={editing.value.email} onChange={onChange} />}
  </MachineState>
</Onboarding.Provider>
```

The server renders the planned `Editing` snapshot. Hydration renders the same
markup, then the Provider mounts the machine and the same component tree
receives live snapshots. The input keeps its DOM node, typed text, and focus.

Do not wrap hydrated forms in a Suspense boundary that a startup read can
trigger. A suspended boundary replaces its server-rendered content with the
fallback and later mounts new DOM nodes, discarding typed text and focus.

## Effect Machine implementation review

Use this review after a machine and its UI adapter have been implemented. Look
for modeling mistakes, redundant API usage, and logic that escaped the machine.
Do not force a change when the current ownership is intentional.

Read [Effect Machine agent guide](#effect-machine-agent-guide) for statechart
modeling and [Effect Atom and React](#effect-atom-and-react) for integration
patterns.

Run the recommended rules from
`@typeonce/oxlint-plugin-effect-machine` before
the manual review. They catch provable duplicate invocation identities,
asynchronous work, browser access, nondeterminism, redundant resolvers, and
conditional `none` fallbacks in direct same-module machine definitions.
Continue with this review for cross-module ownership and architectural
questions that syntax alone cannot answer.

### Review the responsibility boundaries

Use this split when deciding where code belongs:

| Layer              | Owns                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| Machine            | State, transitions, workflow decisions, effect lifetimes, and service execution |
| Atoms              | Reactive selection, projections, and keyed machine lookup                       |
| Component          | Rendering and translating user interaction into domain events                   |
| `RegistryProvider` | An optional Atom registry ownership boundary                                    |

If a component coordinates a workflow, an atom performs business work, or a
provider has no ownership purpose, inspect that code more closely.

### Keep ordinary transitions inline

Use `{ target: "Running" }` for a state with default construction.
Use `{ target: "Running", data: ({ event }) => ({ count: event.count }) }`
when the destination needs data. The checker rejects missing required fields.
Use `decoded` for values already decoded by their schema.

Reserve named branch groups and `resolve` for conditional outcomes, commands,
or nested construction. The group lives in `make`; its resolver selects only
constructors derived from those declarations. Avoid an extra branch group for
an ordinary transition. Use `reenter: true` when the source must restart.
A `{ stay: true }` branch accepts its event, so `Machine.can` and
`AtomMachine.can` return `true` when a resolver selects it. Review check: for
every event that enables or disables a control, refuse it with `guard` or with
`{ decline: true }` and `select.decline()`. Keep `stay` only for events that are
deliberately accepted and ignored.

### Choose React ownership or keyed family lookup

Use `useMachineAtom` when one React subtree owns the workflow, including a
machine with startup input:

```tsx
const makeProcessMachine = machineAtoms.factory(processMachine)
const machine = useMachineAtom(() => makeProcessMachine(input))
```

Pass the stable machine through props or Context. Startup input is captured
once. Send an event to change the running workflow, or change the owner's React
key to replace it.

Use `AtomMachine.family` when unrelated consumers must find one shared machine
by its startup input. Effect Atom keeps a family value for an equal key while
that returned value is reachable. Current runtimes may hold family values
through `WeakRef`. Retaining one field from a composite family value does not
retain the composite itself:

```ts
// Unsafe when consumers retain only stateAtom or sendAtom
const processScope = Atom.family((input: ProcessInput) => {
  const machine = machineAtoms.make(processMachine, input)
  return {
    stateAtom: AtomMachine.select(machine, "process"),
    sendAtom: machine.send
  }
})
```

`AtomMachine.family` returns direct atom families whose atoms retain the
private machine bridge:

```ts
export const processAtoms = machineAtoms.family(processMachine, {
  atoms: {
    state: AtomMachine.select("process"),
    send: (machine) => machine.send
  }
})

const stateAtom = processAtoms.state(input)
const sendAtom = processAtoms.send(input)
```

No component `useMemo` is needed. The registry retains the public atom while a
hook subscribes to it, and that atom retains the machine owner. Equal inputs
use Effect `Equal` and `Hash` semantics and select the same family value.

For a no-input machine, use one module-level bridge or `useMachineAtom` in the
owning React subtree. Do not add an unused family key.

Review check: search for composite `Atom.family` values that own a machine,
`useMemo` around family lookup, repeated input propagation through one React
subtree, and component-local calls to `machineAtoms.make` without a stable
owner. Choose `AtomMachine.family` only when consumers need shared keyed
lookup.

### Justify each `RegistryProvider`

Effect Atom hooks use a shared default registry when no provider is present.
Do not add `RegistryProvider` automatically.

Keep a provider when the subtree intentionally needs its own registry. Common
reasons include:

- the same atom or machine descriptors must represent independent instances in
  separate subtrees;
- the subtree owns registry disposal;
- server rendering or hydration requires a request-local registry;
- the registry needs initial values, custom scheduling, or custom idle
  settings.

Without one of those requirements, the default registry is enough:

```tsx
// A shared application instance can use the default registry.
export function App() {
  return <ProcessScreen />
}
```

Remember that adding or nesting a provider changes identity. The same atom
descriptor stores separate state in each registry, so an unnecessary provider
can split a machine that consumers expected to share.

Review check: for every `RegistryProvider`, state which registry boundary it
creates and why. Remove it when there is no deliberate boundary.

### Keep workflow logic in the machine

The machine owns business flow. Components render selected state and send
domain events. Atoms adapt machine state for reactive consumers. Neither layer
should coordinate the workflow.

The following component owns too much:

```tsx
const submit = async () => {
  send(OrderEvents.SubmitStarted())
  const order = await api.submitOrder(form)
  analytics.track("order submitted", { orderId: order.id })
  send(OrderEvents.SubmitSucceeded({ order }))
}
```

Model `Submit` as the component-facing event. Let a machine state own the work
and its lifetime:

```ts
// In make: effects: { submitOrder }
machine.handle({
  states: {
    Editing: {
      on: {
        Submit: { target: "Submitting", data: ({ event }) => ({ order: event.order }) }
      }
    },
    Submitting: {
      invoke: {
        src: "submitOrder",
        input: ({ state }) => state.order,
        onDone: { target: "Complete", data: ({ output }) => ({ order: output }) },
        onFailure: { target: "Failed", data: ({ error }) => ({ message: String(error) }) }
      }
    }
  }
})
```

`submitOrder` can use Effect services for the API request and analytics. The
service implementation may live in its own module, but the machine decides
when it runs, which state owns it, what cancels it, and how success or failure
changes the workflow.

Apply the same test to browser APIs, storage, timers, analytics, navigation,
and other effects. If the result or lifetime affects machine behavior, execute
it through the machine. UI-only work such as focusing an element or measuring
layout can remain in the component when it does not participate in the domain
flow.

Review check: search components, hooks, and atom modules for service calls,
`Effect.run*`, promises, browser APIs, analytics, timers, and chains of `send`
calls. Move workflow coordination into states, transitions, and invoked work.

Per-instance capabilities, such as a router or a component callback, are
services provided by the React owner, not schema fields or startup input. A
function in state data or input cannot be encoded by `Machine.encodeSnapshot`.
Review check: search schemas for `Schema.declare` guards that accept functions
and move each one to a service, as in
[Per-owner capabilities](#per-owner-capabilities). Do not
drive navigation or other workflow effects from emissions.

### Report findings

For each issue, cite the file and line, name the violated boundary, and show the
smallest correction. Distinguish a confirmed problem from a provider or
ownership choice that needs clarification. Do not rewrite correct code merely
to match an example in this guide.
