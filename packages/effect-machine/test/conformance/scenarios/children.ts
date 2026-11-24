import { Effect, Schema, Stream } from "effect"
import { Machine } from "../../../src/index.js"
import type { Fixture } from "../support/fixture.js"
import type { Scenario, Step } from "../support/scenario.js"
import {
  die,
  element,
  fail,
  failed,
  final,
  named,
  send,
  started,
  stop,
  succeed,
  together
} from "../support/scenario.js"

const start = { happens: [{ Idle: {} }] }

const collector = (fixture: Fixture) =>
  Machine.make({
    root: Machine.state({
      states: {
        Idle: {},
        Collecting: { fields: { seen: Schema.Array(Schema.Number) } },
        Done: { fields: { total: Schema.Number } },
        Failed: { fields: { reason: Schema.String } }
      }
    }),
    events: Machine.events({ Collect: { name: Schema.String }, Cancel: {}, Restart: {} }),
    streams: { numbers: (name: string) => fixture.stream("numbers", name) }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Collect: { target: "Collecting", data: { seen: [] } } } },
      Collecting: {
        invoke: {
          src: "numbers",
          input: ({ event }) => event._tag === "Collect" ? event.name : "again",
          onElement: { update: { Collecting: ({ element, state }) => ({ seen: [...state.seen, element as number] }) } },
          onDone: {
            target: "Done",
            data: ({ state }) => ({ total: state.seen.reduce((sum, value) => sum + value, 0) })
          },
          onFailure: { target: "Failed", data: ({ error }) => ({ reason: error.reason }) }
        },
        on: {
          Cancel: { target: "Idle" },
          Restart: { target: "Collecting", reenter: true, data: { seen: [] } }
        }
      },
      Done: { on: { Collect: { target: "Collecting", data: { seen: [] } } } },
      Failed: {}
    }
  })

const stream: Scenario = {
  name: "handles the elements of a stream one by one, and its end",
  machine: collector,
  start,
  steps: [
    send({ _tag: "Collect", name: "a" }, { happens: [{ Collecting: { seen: [] } }, started("numbers", "a")] }),
    named("first element", element("numbers", 1, { happens: [{ Collecting: { seen: [1] } }] })),
    named(
      "two elements at once",
      together([element("numbers", 2), element("numbers", 3)], {
        happens: [{ Collecting: { seen: [1, 2] } }, { Collecting: { seen: [1, 2, 3] } }]
      })
    ),
    succeed("numbers", undefined, { happens: [{ Done: { total: 6 } }] }),
    named(
      "collect again",
      send({ _tag: "Collect", name: "b" }, { happens: [{ Collecting: { seen: [] } }, started("numbers", "b")] })
    ),
    fail("numbers", "cut", { happens: [{ Failed: { reason: "cut" } }] })
  ]
}

const chunk: Scenario = {
  name: "handles a stream that produces everything at once",
  machine: () =>
    Machine.make({
      root: Machine.state({
        states: {
          Idle: {},
          Collecting: { fields: { seen: Schema.Array(Schema.Number) } },
          Done: { fields: { seen: Schema.Array(Schema.Number) }, type: "final", output: Schema.Array(Schema.Number) }
        }
      }),
      events: Machine.events({ Collect: {} }),
      streams: { numbers: Stream.fromIterable([1, 2, 3]) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Collect: { target: "Collecting", data: { seen: [] } } } },
        Collecting: {
          invoke: {
            src: "numbers",
            onElement: { update: { Collecting: ({ element, state }) => ({ seen: [...state.seen, element] }) } },
            onDone: { target: "Done", data: ({ state }) => ({ seen: state.seen }) }
          }
        },
        Done: { output: ({ state }) => state.seen }
      }
    }),
  start,
  steps: [
    send({ _tag: "Collect" }, {
      happens: [
        { Collecting: { seen: [] } },
        { Collecting: { seen: [1] } },
        { Collecting: { seen: [1, 2] } },
        { Collecting: { seen: [1, 2, 3] } },
        { Done: { seen: [1, 2, 3] } }
      ],
      outcome: final([1, 2, 3])
    })
  ]
}

const paced: Scenario = {
  name: "pulls the next element of a stream once it has handled the one before",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Collecting: {}, Enough: {} } }),
      events: Machine.events({ Collect: {} }),
      streams: {
        numbers: Stream.fromIterable([1, 2, 3, 4]).pipe(
          Stream.rechunk(1),
          Stream.tap((value) => Effect.sync(() => fixture.note(`produce ${value}`)))
        )
      }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Collect: { target: "Collecting" } } },
        Collecting: {
          invoke: {
            src: "numbers",
            onElement: {
              branches: [{ stay: true }, { target: "Enough" }],
              resolve: ({ element, select }) => {
                fixture.note(`handle ${element}`)
                return element < 2 ? select.stay() : select.target("Enough")
              }
            },
            onDone: { target: "Idle" }
          }
        },
        Enough: {}
      }
    }),
  start,
  steps: [
    send({ _tag: "Collect" }, {
      happens: [{ Collecting: {} }, { Enough: {} }],
      log: ["produce 1", "handle 1", "produce 2", "handle 2"]
    })
  ]
}

const stoppedStream: Scenario = {
  name: "stops a stream when its state is left, and takes no element of it after that",
  machine: collector,
  start,
  steps: [
    send({ _tag: "Collect", name: "a" }, { happens: [{ Collecting: { seen: [] } }, started("numbers", "a")] }),
    named("an element", element("numbers", 1, { happens: [{ Collecting: { seen: [1] } }] })),
    send({ _tag: "Restart" }, {
      happens: [{ Collecting: { seen: [] } }, started("numbers", "again")],
      stopped: ["numbers(a)"]
    }),
    named("an element of the stream before", element("numbers", 99, {}, 0)),
    named("an element of the stream that runs", element("numbers", 2, { happens: [{ Collecting: { seen: [2] } }] })),
    send({ _tag: "Cancel" }, { happens: [{ Idle: {} }], stopped: ["numbers(again)"] })
  ]
}

const failingStream: Scenario = {
  name: "fails after a defect of a stream",
  machine: collector,
  start,
  steps: [
    send({ _tag: "Collect", name: "a" }, { happens: [{ Collecting: { seen: [] } }, started("numbers", "a")] }),
    die("numbers", new Error("broken stream"), { outcome: failed("Error: broken stream") }),
    send({ _tag: "Cancel" }, { answers: ["Ended"] })
  ]
}

const logic: Scenario = {
  name: "routes the snapshots and the output of process logic, and drops those of an earlier run",
  machine: (fixture) => {
    const Counter = Machine.childAddress<number>("counter")
    return Machine.make({
      root: Machine.state({
        states: {
          Idle: {},
          Counting: { fields: { seen: Schema.Number } },
          Done: { fields: { total: Schema.Number } }
        }
      }),
      events: Machine.events({ Count: {}, Add: { by: Schema.Number }, Restart: {}, Cancel: {}, Stale: {} }),
      logic: {
        counter: (name: string) =>
          Machine.logic<number, number, number, { readonly reason: string }>({
            initial: 0,
            run: ({ parent, receive, sendTo, setState, state }) =>
              Effect.onInterrupt(
                Effect.raceFirst(
                  Effect.forever(Effect.flatMap(receive, (by) => Effect.flatMap(state, (now) => setState(now + by)))),
                  Effect.andThen(fixture.work("counter", name), state)
                ),
                // Too late to be seen.
                () =>
                  Effect.andThen(
                    setState(999),
                    parent === undefined ? Effect.void : Effect.ignore(sendTo(parent, { _tag: "Stale" }))
                  )
              )
          })
      }
    }).handle({
      initial: { target: "Idle" },
      on: { Stale: { target: "Done", data: { total: -1 } } },
      states: {
        Idle: { on: { Count: { target: "Counting", data: { seen: 0 } } } },
        Counting: {
          invoke: {
            src: "counter",
            id: "counter",
            address: Counter,
            input: ({ event }) => event._tag === "Count" ? "first" : "again",
            onSnapshot: {
              update: { Counting: ({ snapshot }) => ({ seen: snapshot.state }) }
            },
            onDone: { target: "Done", data: ({ output }) => ({ total: output }) },
            onFailure: { target: "Idle" }
          },
          on: {
            Add: { stay: true, commands: ({ event }, enqueue) => enqueue.sendTo(Counter, event.by) },
            Restart: { target: "Counting", reenter: true, data: { seen: -1 } },
            Cancel: { target: "Idle" }
          }
        },
        Done: { on: { Count: { target: "Counting", data: { seen: 0 } } } }
      }
    })
  },
  needs: ["Commands"],
  start,
  steps: [
    send({ _tag: "Count" }, { happens: [{ Counting: { seen: 0 } }, started("counter", "first")] }),
    named("add 2", send({ _tag: "Add", by: 2 }, { happens: [{ Counting: { seen: 2 } }] })),
    named("add 3", send({ _tag: "Add", by: 3 }, { happens: [{ Counting: { seen: 5 } }] })),
    send({ _tag: "Restart" }, {
      happens: [{ Counting: { seen: -1 } }, started("counter", "again"), { Counting: { seen: 0 } }],
      stopped: ["counter(first)"]
    }),
    named("add 4", send({ _tag: "Add", by: 4 }, { happens: [{ Counting: { seen: 4 } }] })),
    succeed("counter", "done", { happens: [{ Done: { total: 4 } }] }),
    named(
      "count again",
      send({ _tag: "Count" }, {
        happens: [{ Counting: { seen: 0 } }, started("counter", "first")]
      })
    ),
    send({ _tag: "Cancel" }, { happens: [{ Idle: {} }], stopped: ["counter(first)"] })
  ]
}

const Reports = Machine.events({ Reported: { count: Schema.Number } })

const makeWorker = (fixture: Fixture) =>
  Machine.make({
    id: "Worker",
    root: Machine.state({
      fields: { name: Schema.String },
      states: { Counting: { fields: { count: Schema.Number } }, Done: { type: "final", output: Schema.String } }
    }),
    input: Schema.String,
    events: Machine.events({ Add: { by: Schema.Number }, Report: {}, Finish: {}, Break: {} }),
    parent: Machine.parent(Reports),
    effects: { guard: (name: string) => fixture.work("worker", name) }
  }).handle({
    root: ({ input }) => ({ name: input }),
    initial: { target: "Counting", data: { count: 0 } },
    states: {
      Counting: {
        invoke: {
          src: "guard",
          input: ({ root }) => root.name,
          onDone: { stay: true },
          onFailure: { stay: true }
        },
        on: {
          Add: { update: { Counting: ({ event, state }) => ({ count: state.count + event.by }) } },
          Report: {
            stay: true,
            commands: ({ parent, state }, enqueue) => enqueue.sendTo(parent, { _tag: "Reported", count: state.count })
          },
          Finish: { target: "Done" },
          Break: {
            branches: [{ target: "Done" }],
            resolve: ({ select, state }) => {
              if (state.count >= 0) throw new Error("broken worker")
              return select.target("Done")
            }
          }
        }
      },
      Done: { output: ({ ancestors }) => `done by ${ancestors[""].name}` }
    }
  })

const hosting = (fixture: Fixture) => {
  const Worker = Machine.child("worker", makeWorker(fixture))
  return Machine.make({
    root: Machine.state({
      states: {
        Idle: {},
        Hosting: { fields: { reported: Schema.Number } },
        Ready: { fields: { result: Schema.String }, type: "final", output: Schema.String }
      }
    }),
    events: Machine.events({
      Host: { name: Schema.String },
      Add: { by: Schema.Number },
      Report: {},
      Finish: {},
      Break: {},
      Restart: {},
      Cancel: {},
      Reported: { count: Schema.Number }
    }),
    children: { worker: Worker }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Host: { target: "Hosting", data: { reported: 0 } } } },
      Hosting: {
        invoke: {
          src: "worker",
          input: ({ event }) => event._tag === "Host" ? event.name : "again",
          onDone: { target: "Ready", data: ({ output }) => ({ result: output }) }
        },
        on: {
          Add: { stay: true, commands: ({ event }, enqueue) => enqueue.sendTo(Worker, { _tag: "Add", by: event.by }) },
          Report: { stay: true, commands: (_, enqueue) => enqueue.sendTo(Worker, { _tag: "Report" }) },
          Finish: { stay: true, commands: (_, enqueue) => enqueue.sendTo(Worker, { _tag: "Finish" }) },
          Break: { stay: true, commands: (_, enqueue) => enqueue.sendTo(Worker, { _tag: "Break" }) },
          Reported: { update: { Hosting: ({ event }) => ({ reported: event.count }) } },
          Restart: { target: "Hosting", reenter: true, data: { reported: 0 } },
          Cancel: { target: "Idle" }
        }
      },
      Ready: { output: ({ state }) => state.result }
    }
  })
}

const child: Scenario = {
  name: "runs an invoked child machine, which reports to it and ends with an output",
  machine: hosting,
  needs: ["Commands"],
  start,
  steps: [
    send({ _tag: "Host", name: "ada" }, { happens: [{ Hosting: { reported: 0 } }, started("worker", "ada")] }),
    named("add 2", send({ _tag: "Add", by: 2 })),
    named("add 3", send({ _tag: "Add", by: 3 })),
    send({ _tag: "Report" }, { happens: [{ Hosting: { reported: 5 } }] }),
    // A new child, which knows nothing of the one before.
    send({ _tag: "Restart" }, {
      happens: [{ Hosting: { reported: 0 } }, started("worker", "again")],
      stopped: ["worker(ada)"]
    }),
    named("add 1", send({ _tag: "Add", by: 1 })),
    named("report again", send({ _tag: "Report" }, { happens: [{ Hosting: { reported: 1 } }] })),
    send({ _tag: "Cancel" }, { happens: [{ Idle: {} }], stopped: ["worker(again)"] }),
    named(
      "host again",
      send({ _tag: "Host", name: "bob" }, { happens: [{ Hosting: { reported: 0 } }, started("worker", "bob")] })
    ),
    send({ _tag: "Finish" }, {
      happens: [{ Ready: { result: "done by bob" } }],
      stopped: ["worker(bob)"],
      outcome: final("done by bob")
    })
  ]
}

const failingChild: Scenario = {
  name: "fails with an invoked child machine that fails",
  machine: hosting,
  needs: ["Commands"],
  start,
  steps: [
    send({ _tag: "Host", name: "ada" }, { happens: [{ Hosting: { reported: 0 } }, started("worker", "ada")] }),
    send({ _tag: "Break" }, { stopped: ["worker(ada)"], outcome: failed("Error: broken worker") }),
    send({ _tag: "Report" }, { answers: ["Ended"] })
  ]
}

const ownsWorkers = (name: string, end: Step): Scenario => ({
  name,
  machine: (fixture) => {
    const Worker = Machine.childFamily(makeWorker(fixture))
    return Machine.make({
      root: Machine.state({
        fields: { reported: Schema.Number },
        states: { Idle: {}, Spawning: {}, Running: {}, Closing: {}, Closed: { type: "final" } }
      }),
      events: Machine.events({
        Spawn: {},
        Report: {},
        Close: {},
        Finish: {},
        Reported: { count: Schema.Number }
      }),
      effects: {
        spawn: (children: Machine.ChildOwner<{ readonly _tag: "Reported"; readonly count: number }>) =>
          Effect.gen(function*() {
            yield* children.spawn(Worker("first"), { input: "first" })
            yield* children.spawn(Worker("second"), { input: "second" })
            const duplicate = yield* Effect.exit(children.spawn(Worker("first"), { input: "duplicate" }))
            fixture.note(`duplicate ${duplicate._tag}`)
            yield* children.sendTo(Worker("first"), { _tag: "Add", by: 7 })
            yield* children.sendTo(Worker("missing"), { _tag: "Add", by: 1 })
          }).pipe(Effect.orDie),
        report: Machine.sendTo(Worker("first"), { _tag: "Report" }).pipe(Effect.orDie),
        close: Machine.stopChild(Worker("first"))
      }
    }).handle({
      root: () => ({ reported: 0 }),
      initial: { target: "Idle" },
      on: { Reported: { update: { root: ({ event }) => ({ reported: event.count }) } }, Finish: { target: "Closed" } },
      states: {
        Idle: { on: { Spawn: { target: "Spawning" } } },
        Spawning: { invoke: { src: "spawn", input: ({ children }) => children, onDone: { target: "Running" } } },
        Running: {
          invoke: { src: "report", onDone: { stay: true } },
          on: { Close: { target: "Closing" } }
        },
        Closing: { invoke: { src: "close", onDone: { stay: true } } },
        Closed: {}
      }
    })
  },
  needs: ["OwnedChildren"],
  start: { happens: [{ "": { reported: 0 }, Idle: {} }] },
  steps: [
    send({ _tag: "Spawn" }, {
      happens: [
        { "": { reported: 0 }, Spawning: {} },
        started("worker", "first"),
        started("worker", "second"),
        { "": { reported: 0 }, Running: {} },
        { "": { reported: 7 }, Running: {} }
      ],
      log: ["duplicate Failure"]
    }),
    send({ _tag: "Close" }, { happens: [{ "": { reported: 7 }, Closing: {} }], stopped: ["worker(first)"] }),
    end
  ]
})

const owned = ownsWorkers(
  "owns the children its work spawns, until it stops them or ends",
  send({ _tag: "Finish" }, {
    happens: [{ "": { reported: 7 }, Closed: {} }],
    stopped: ["worker(second)"],
    outcome: { _tag: "Final" }
  })
)

const ownedAndStopped = ownsWorkers(
  "stops the children its work spawned when its owner stops it",
  stop({ stopped: ["worker(second)"], outcome: { _tag: "Stopped" } })
)

const spawnedLogic: Scenario = {
  name: "spawns process logic from its work, and stops it by its address",
  machine: (fixture) => {
    const Counter = Machine.childAddress<number>("counter")
    const counter = Machine.logic<number, number>({
      initial: 0,
      run: (context) =>
        Effect.andThen(
          Effect.sync(() => fixture.note("logic runs")),
          Effect.forever(Effect.flatMap(context.receive, (by) => {
            fixture.note(`received ${by}`)
            return context.updateState((count) => Effect.succeed(count + by))
          }))
        ).pipe(Effect.onInterrupt(() => Effect.sync(() => fixture.note("logic stops"))))
    })
    return Machine.make({
      root: Machine.state({ states: { Idle: {}, Spawning: {}, Stopping: {} } }),
      events: Machine.events({ Go: {}, Stop: {} }),
      effects: {
        spawn: Effect.gen(function*() {
          yield* Machine.spawn(counter, { id: Counter })
          yield* Machine.sendTo(Counter, 2)
        }).pipe(Effect.orDie),
        stop: Machine.stopChild(Counter)
      }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Spawning" } } },
        Spawning: { invoke: { src: "spawn", onDone: { stay: true } }, on: { Stop: { target: "Stopping" } } },
        Stopping: { invoke: { src: "stop", onDone: { target: "Idle" } } }
      }
    })
  },
  needs: ["OwnedChildren"],
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ Spawning: {} }], log: ["logic runs", "received 2"] }),
    // It outlives the state whose work spawned it.
    send({ _tag: "Stop" }, { happens: [{ Stopping: {} }, { Idle: {} }], log: ["logic stops"] }),
    named("spawn again", send({ _tag: "Go" }, { happens: [{ Spawning: {} }], log: ["logic runs", "received 2"] }))
  ]
}

const stoppedByOwner: Scenario = {
  name: "stops its work and takes no more events when its owner stops it",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Working: {} } }),
      events: Machine.events({ Go: {} }),
      effects: { work: fixture.work("work") }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Working" } } },
        Working: {
          exit: () => fixture.note("exit Working"),
          invoke: { src: "work", onDone: { target: "Idle" }, onFailure: { target: "Idle" } }
        }
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ Working: {} }, started("work")] }),
    stop({ stopped: ["work"], outcome: { _tag: "Stopped" } }),
    named("a late result", succeed("work", "late")),
    named("an event after it", send({ _tag: "Go" }, { answers: ["Ended"] }))
  ]
}

export const children: ReadonlyArray<Scenario> = [
  stream,
  chunk,
  paced,
  stoppedStream,
  failingStream,
  logic,
  child,
  failingChild,
  owned,
  ownedAndStopped,
  spawnedLogic,
  stoppedByOwner
]
