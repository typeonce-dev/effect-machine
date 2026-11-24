import { Duration, Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import type { Scenario } from "../support/scenario.js"
import { advance, die, failed, final, named, restart, running, send, started, succeed } from "../support/scenario.js"

const Events = Machine.events({ Load: { id: Schema.String }, Note: {}, Reload: {} })

const root = Machine.state({
  states: {
    Idle: {},
    Loading: { fields: { id: Schema.String, notes: Schema.Number } },
    Loaded: { fields: { result: Schema.String } }
  }
})

const loading = (id: string, notes = 0) => ({ Loading: { id, notes } })

const start = { happens: [{ Idle: {} }] }

const work: Scenario = {
  name: "restarts while work runs",
  machine: (fixture) =>
    Machine.make({
      id: "Loader",
      root,
      events: Events,
      effects: { load: (id: string) => fixture.work("load", id) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: {
          on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } }
        },
        Loading: {
          entry: () => fixture.note("enter Loading"),
          exit: () => fixture.note("exit Loading"),
          invoke: {
            src: "load",
            input: ({ event, state }) => fixture.mapped("load", event, `${state.id}${state.notes}`),
            onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
            onFailure: { stay: true }
          },
          on: { Note: { update: { Loading: ({ state }) => ({ ...state, notes: state.notes + 1 }) } } }
        },
        Loaded: {}
      }
    }),
  start,
  steps: [
    send({ _tag: "Load", id: "a" }, {
      happens: [loading("a"), started("load", "a0")],
      log: ["enter Loading", "load by Load"]
    }),
    send({ _tag: "Note" }, { happens: [loading("a", 1)] }),
    // Nothing is entered, and the work is started from the state it left behind.
    named(
      "restart",
      restart(10, {
        happens: [started("load", "a1")],
        stopped: ["load(a0)"],
        log: ["load by initial"]
      })
    ),
    named("a result from before the restart", succeed("load", "lost", {}, 0)),
    named("an event after the restart", send({ _tag: "Note" }, { happens: [loading("a", 2)] })),
    succeed("load", "document a", { happens: [{ Loaded: { result: "document a" } }], log: ["exit Loading"] })
  ]
}

const timer = (downtime: number, steps: Scenario["steps"]): Scenario => ({
  name: downtime < 20 ? "restarts while a timer waits" : "restarts after a timer fell due",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Waiting: { fields: { seconds: Schema.Number } }, Expired: {} } }),
      events: Machine.events({ Wait: { seconds: Schema.Number } }),
      timers: { wait: (seconds: number) => Duration.seconds(seconds) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Wait: { target: "Waiting", data: ({ event }) => ({ seconds: event.seconds }) } } },
        Waiting: {
          invoke: {
            src: "wait",
            input: ({ event, state }) => fixture.mapped("wait", event, state.seconds),
            onDone: { target: "Expired" }
          }
        },
        Expired: {}
      }
    }),
  start,
  steps: [
    send({ _tag: "Wait", seconds: 60 }, { happens: [{ Waiting: { seconds: 60 } }], log: ["wait by Wait"] }),
    named("40 seconds of 60", advance("40 seconds")),
    named("restart", restart(downtime, { log: ["wait by initial"] })),
    ...steps
  ]
})

const settled: Scenario = {
  name: "restarts in a state whose work has ended",
  machine: (fixture) =>
    Machine.make({
      root,
      events: Events,
      effects: { first: fixture.work("first"), second: fixture.work("second") }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
        Loading: {
          invoke: [
            {
              src: "first",
              onDone: { update: { Loading: ({ state }) => ({ ...state, notes: state.notes + 1 }) } },
              onFailure: { stay: true }
            },
            {
              src: "second",
              onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
              onFailure: { stay: true }
            }
          ],
          on: { Reload: { target: "Loading", reenter: true, data: ({ state }) => state } }
        },
        Loaded: {}
      }
    }),
  start,
  steps: [
    send({ _tag: "Load", id: "a" }, { happens: [loading("a"), started("first"), started("second")] }),
    succeed("first", "done", { happens: [loading("a", 1)] }),
    named("restart", restart(10, { happens: [started("first"), started("second")], stopped: ["second"] })),
    named(
      "enter again",
      send({ _tag: "Reload" }, { happens: [started("first"), started("second")], stopped: ["first", "second"] })
    ),
    succeed("second", "done", { happens: [{ Loaded: { result: "done" } }], stopped: ["first"] })
  ]
}

const regions: Scenario = {
  name: "restarts while the work of regions runs",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({
        states: {
          Idle: {},
          Active: {
            type: "parallel",
            states: { left: { states: { Busy: {} } }, right: { states: { Busy: {}, Done: {} } } }
          }
        }
      }),
      events: Machine.events({ Go: {} }),
      effects: { work: (name: string) => Effect.orDie(fixture.work(name)) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Active" } } },
        Active: {
          states: {
            left: {
              initial: { target: "Active.left.Busy" },
              states: {
                Busy: { invoke: { src: "work", id: "left", input: () => "left", onDone: { stay: true } } }
              }
            },
            right: {
              invoke: { src: "work", id: "region", input: () => "region", onDone: { stay: true } },
              initial: { target: "Active.right.Busy" },
              states: {
                Busy: {
                  invoke: { src: "work", id: "right", input: () => "right", onDone: { target: "Active.right.Done" } }
                },
                Done: {}
              }
            }
          }
        }
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, {
      happens: [
        { "Active.left.Busy": {}, "Active.right.Busy": {} },
        started("region"),
        started("left"),
        started("right")
      ]
    }),
    named(
      "restart",
      restart(10, {
        happens: [started("region"), started("left"), started("right")],
        stopped: ["left", "region", "right"]
      })
    ),
    succeed("right", "done", { happens: [{ "Active.left.Busy": {}, "Active.right.Done": {} }] }),
    // Work of a state that was left before does not come back.
    named(
      "restart again",
      restart(10, { happens: [started("region"), started("left")], stopped: ["left", "region"] })
    )
  ]
}

const history: Scenario = {
  name: "restarts with a history to return to",
  machine: ({ note }) =>
    Machine.make({
      root: Machine.state({
        states: {
          Away: {},
          Album: {
            fields: { plays: Schema.Number },
            states: {
              First: {},
              Second: { fields: { at: Schema.Number } },
              exact: { type: "history", history: "deep" }
            }
          }
        }
      }),
      events: Machine.events({ Open: {}, Next: {}, Leave: {}, Back: {} })
    }).handle({
      initial: { target: "Away" },
      states: {
        Away: {
          on: {
            Open: { target: "Album", data: { plays: 7 } },
            Back: { branches: [{ history: "Album.exact" }], resolve: ({ select }) => select.history("Album.exact") }
          }
        },
        Album: {
          initial: { target: "Album.First" },
          history: {
            exact: {
              default: () => ({
                path: "" as const,
                value: undefined,
                state: {
                  path: "Album" as const,
                  value: { _tag: "Album" as const, plays: 0 },
                  state: { path: "Album.First" as const, value: undefined }
                }
              })
            }
          },
          on: { Leave: { target: "Away" }, Next: { target: "Album.Second", data: { at: 3 } } },
          states: { First: {}, Second: { entry: () => note("enter Second") } }
        }
      }
    }),
  start: { happens: [{ Away: {} }] },
  steps: [
    send({ _tag: "Open" }, { happens: [{ Album: { plays: 7 }, "Album.First": {} }] }),
    send({ _tag: "Next" }, { happens: [{ Album: { plays: 7 }, "Album.Second": { at: 3 } }], log: ["enter Second"] }),
    send({ _tag: "Leave" }, { happens: [{ Away: {} }] }),
    named("restart", restart(10)),
    send({ _tag: "Back" }, { happens: [{ Album: { plays: 7 }, "Album.Second": { at: 3 } }], log: ["enter Second"] })
  ]
}

const finished: Scenario = {
  name: "restarts after it ended",
  machine: () =>
    Machine.make({
      root: Machine.state({
        states: { Open: {}, Closed: { fields: { reason: Schema.String }, type: "final", output: Schema.String } }
      }),
      events: Machine.events({ Finish: { reason: Schema.String } })
    }).handle({
      initial: { target: "Open" },
      states: {
        Open: { on: { Finish: { target: "Closed", data: ({ event }) => ({ reason: event.reason }) } } },
        Closed: { output: ({ state }) => state.reason }
      }
    }),
  start: { happens: [{ Open: {} }] },
  steps: [
    send({ _tag: "Finish", reason: "late" }, { happens: [{ Closed: { reason: "late" } }], outcome: final("late") }),
    named("restart", restart(10)),
    named("an event after it", send({ _tag: "Finish", reason: "again" }, { answers: ["Ended"] }))
  ]
}

const failure: Scenario = {
  name: "restarts after it failed",
  machine: (fixture) =>
    Machine.make({
      root,
      events: Events,
      effects: { load: (id: string) => Effect.orDie(fixture.work("load", id)) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
        Loading: {
          invoke: {
            src: "load",
            input: ({ state }) => state.id,
            onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) }
          }
        },
        Loaded: {}
      }
    }),
  start,
  steps: [
    send({ _tag: "Load", id: "a" }, { happens: [loading("a"), started("load", "a")] }),
    die("load", new Error("broken"), { outcome: failed("Error: broken") }),
    // What is durable is the state, and not that the machine failed in it.
    named("restart", restart(10, { happens: [started("load", "a")], outcome: running })),
    succeed("load", "document a", { happens: [{ Loaded: { result: "document a" } }] })
  ]
}

class Parcel extends Schema.TaggedClass<Parcel>("ConformanceParcel")("Parcel", {
  weight: Schema.NumberFromString
}) {}

const values: Scenario = {
  name: "restarts with decoded values",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Parcel } }),
      events: Machine.events({ Send: { weight: Schema.Number } }),
      effects: { send: (weight: string) => fixture.work("send", weight) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: {
          on: { Send: { target: "Parcel", decoded: true, data: ({ event }) => new Parcel({ weight: event.weight }) } }
        },
        Parcel: {
          invoke: {
            src: "send",
            input: ({ state }) => `${state instanceof Parcel} ${typeof state.weight}`,
            onDone: { target: "Idle" },
            onFailure: { stay: true }
          }
        }
      }
    }),
  start,
  steps: [
    send({ _tag: "Send", weight: 5 }, { happens: [{ Parcel: { weight: "5" } }, started("send", "true number")] }),
    named("restart", restart(10, { happens: [started("send", "true number")], stopped: ["send(true number)"] })),
    succeed("send", "sent", { happens: [{ Idle: {} }] })
  ]
}

const completion: Scenario = {
  name: "restarts after one of two regions completed",
  machine: ({ note }) =>
    Machine.make({
      root: Machine.state({
        states: {
          Idle: {},
          Both: {
            type: "parallel",
            output: Schema.Number,
            states: {
              left: { states: { Busy: {}, Done: { type: "final", output: Schema.Number } } },
              right: { states: { Busy: {}, Done: { type: "final", output: Schema.Number } } }
            }
          },
          Ready: { fields: { total: Schema.Number } }
        }
      }),
      events: Machine.events({ Go: {}, Left: { value: Schema.Number }, Right: {} })
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Both" } } },
        Both: {
          onDone: { target: "Ready", data: ({ output }) => ({ total: output }) },
          output: ({ outputs }) => {
            note("output")
            return outputs.left + outputs.right
          },
          states: {
            left: {
              initial: { target: "Both.left.Busy" },
              states: {
                Busy: { on: { Left: { target: "Both.left.Done" } } },
                Done: { output: ({ event }) => event._tag === "Left" ? event.value : -1 }
              }
            },
            right: {
              initial: { target: "Both.right.Busy" },
              states: { Busy: { on: { Right: { target: "Both.right.Done" } } }, Done: { output: () => 2 } }
            }
          }
        },
        Ready: {}
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ "Both.left.Busy": {}, "Both.right.Busy": {} }] }),
    send({ _tag: "Left", value: 5 }, { happens: [{ "Both.left.Done": {}, "Both.right.Busy": {} }] }),
    named("restart", restart(10)),
    // The output of the region that completed before is not computed again.
    send({ _tag: "Right" }, { happens: [{ Ready: { total: 7 } }], log: ["output"] })
  ]
}

const instant: Scenario = {
  name: "restarts in a state whose work ends at once",
  machine: (fixture) =>
    Machine.make({
      root,
      events: Events,
      effects: {
        load: (runs: number) => runs === 0 ? fixture.work("load") : fixture.instant("again", Effect.succeed("at once"))
      }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
        Loading: {
          invoke: {
            src: "load",
            input: () => fixture.runs.length,
            onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
            onFailure: { stay: true }
          }
        },
        Loaded: {}
      }
    }),
  start,
  steps: [
    send({ _tag: "Load", id: "a" }, { happens: [loading("a"), started("load")] }),
    named(
      "restart",
      restart(10, { happens: [started("again"), { Loaded: { result: "at once" } }], stopped: ["load"] })
    )
  ]
}

export const restarts: ReadonlyArray<Scenario> = [
  work,
  timer(10, [
    named("the time that remained", advance("10 seconds")),
    named("59 seconds after the restart", advance("49 seconds")),
    named("60 seconds after the restart", advance("1 second", { happens: [{ Expired: {} }] }))
  ]),
  timer(60, [
    named("59 seconds after the restart", advance("59 seconds")),
    named("60 seconds after the restart", advance("1 second", { happens: [{ Expired: {} }] }))
  ]),
  settled,
  regions,
  history,
  finished,
  failure,
  values,
  completion,
  instant
]
