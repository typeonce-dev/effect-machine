import { Duration, Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import type { Fixture } from "../support/fixture.js"
import type { Scenario } from "../support/scenario.js"
import { advance, failed, named, send, started, succeed } from "../support/scenario.js"

const Events = Machine.events({
  Wait: { seconds: Schema.Number },
  Note: {},
  Cancel: {},
  Restart: {},
  Finish: {}
})

const wait = (seconds: number) => ({ _tag: "Wait", seconds })

const root = Machine.state({
  states: {
    Idle: {},
    Waiting: { fields: { seconds: Schema.Number, notes: Schema.Number } },
    Expired: {},
    Finished: { type: "final" }
  }
})

const waiting = (seconds: number, notes = 0) => ({ Waiting: { seconds, notes } })

/** Waits as long as its state says. */
export const timer = (fixture: Fixture) =>
  Machine.make({
    id: "Timer",
    root,
    events: Events,
    timers: {
      wait: (seconds: number) => {
        fixture.note(`duration ${seconds}`)
        return Duration.seconds(seconds)
      }
    }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Wait: { target: "Waiting", data: ({ event }) => ({ seconds: event.seconds, notes: 0 }) } } },
      Waiting: {
        invoke: {
          src: "wait",
          input: ({ event, state }) => fixture.mapped("wait", event, state.seconds),
          onDone: { target: "Expired" }
        },
        on: {
          Note: { update: { Waiting: ({ state }) => ({ ...state, notes: state.notes + 1 }) } },
          Cancel: { target: "Idle" },
          Restart: { target: "Waiting", reenter: true, data: ({ state }) => state },
          Finish: { target: "Finished" }
        }
      },
      Expired: {
        on: { Wait: { target: "Waiting", data: ({ event }) => ({ seconds: event.seconds, notes: 0 }) } }
      }
    }
  })

const start = { happens: [{ Idle: {} }] }

const waits = (seconds: number) =>
  send(wait(seconds), { happens: [waiting(seconds)], log: ["wait by Wait", `duration ${seconds}`] })

const fires: Scenario = {
  name: "fires a timer at its duration, which its state parameterizes",
  machine: timer,
  start,
  steps: [
    waits(10),
    named("9 seconds of 10", advance("9 seconds")),
    // A step that keeps the state neither starts the timer over nor evaluates it.
    send({ _tag: "Note" }, { happens: [waiting(10, 1)] }),
    advance("999 millis"),
    advance("1 millis", { happens: [{ Expired: {} }] }),
    named("wait longer", waits(90)),
    advance("89999 millis"),
    named("the end of the longer wait", advance("1 millis", { happens: [{ Expired: {} }] })),
    advance("1 minute")
  ]
}

const cancelled: Scenario = {
  name: "cancels a timer when its state is left",
  machine: timer,
  start,
  steps: [
    waits(10),
    advance("9 seconds"),
    send({ _tag: "Cancel" }, { happens: [{ Idle: {} }] }),
    advance("1 minute"),
    named("wait again", waits(10)),
    send({ _tag: "Finish" }, { happens: [{ Finished: {} }], outcome: { _tag: "Final" } }),
    advance("2 minutes")
  ]
}

const startsOver: Scenario = {
  name: "starts a timer over when its state is entered again",
  machine: timer,
  start,
  steps: [
    waits(10),
    advance("6 seconds"),
    send({ _tag: "Restart" }, { log: ["wait by Restart", "duration 10"] }),
    advance("9 seconds"),
    advance("999 millis"),
    advance("1 millis", { happens: [{ Expired: {} }] })
  ]
}

const immediate: Scenario = {
  name: "fires a timer without a duration, after the state that owns it",
  machine: timer,
  start,
  steps: [
    named(
      "wait for nothing",
      send(wait(0), {
        happens: [waiting(0), { Expired: {} }],
        log: ["wait by Wait", "duration 0"]
      })
    ),
    named("wait for something", waits(5)),
    advance("5 seconds", { happens: [{ Expired: {} }] })
  ]
}

const timeout = (fixture: Fixture) =>
  Machine.make({
    root: Machine.state({
      states: { Idle: {}, Loading: {}, Loaded: { fields: { result: Schema.String } }, TimedOut: {} }
    }),
    events: Machine.events({ Load: {}, Reset: {} }),
    effects: { load: fixture.work("load") },
    timers: { timeout: "10 seconds" }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Load: { target: "Loading" } } },
      Loading: {
        invoke: [
          {
            src: "load",
            onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
            onFailure: { stay: true }
          },
          { src: "timeout", onDone: { target: "TimedOut" } }
        ]
      },
      Loaded: { on: { Reset: { target: "Idle" } } },
      TimedOut: { on: { Reset: { target: "Idle" } } }
    }
  })

const loads = send({ _tag: "Load" }, { happens: [{ Loading: {} }, started("load")] })

const timerWins: Scenario = {
  name: "stops the effect next to a timer that fires first",
  machine: timeout,
  start,
  steps: [
    loads,
    advance("10 seconds", { happens: [{ TimedOut: {} }], stopped: ["load"] }),
    named("a late result", succeed("load", "late"))
  ]
}

const effectWins: Scenario = {
  name: "cancels the timer next to an effect that ends first",
  machine: timeout,
  start,
  steps: [
    loads,
    advance("9 seconds"),
    succeed("load", "document", { happens: [{ Loaded: { result: "document" } }] }),
    advance("1 minute"),
    send({ _tag: "Reset" }, { happens: [{ Idle: {} }] }),
    // The first timer is not the one that fires.
    named("load again", loads),
    named("9 seconds of 10", advance("9 seconds")),
    advance("1 second", { happens: [{ TimedOut: {} }], stopped: ["load"] })
  ]
}

const effectStays: Scenario = {
  name: "keeps a timer that waits when the effect next to it ends and stays",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Loading: { fields: { loads: Schema.Number } }, TimedOut: {} } }),
      events: Machine.events({ Load: {} }),
      effects: { load: fixture.work("load") },
      timers: { timeout: "10 seconds" }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Load: { target: "Loading", data: { loads: 0 } } } },
        Loading: {
          invoke: [
            { src: "timeout", onDone: { target: "TimedOut" } },
            {
              src: "load",
              onDone: { update: { Loading: ({ state }) => ({ loads: state.loads + 1 }) } },
              onFailure: { stay: true }
            }
          ]
        },
        TimedOut: {}
      }
    }),
  start,
  steps: [
    send({ _tag: "Load" }, { happens: [{ Loading: { loads: 0 } }, started("load")] }),
    advance("6 seconds"),
    succeed("load", "document", { happens: [{ Loading: { loads: 1 } }] }),
    advance("3999 millis"),
    advance("1 millis", { happens: [{ TimedOut: {} }] })
  ]
}

const regions: Scenario = {
  name: "fires the timers of two regions at their own times, and in order when they are due together",
  machine: () =>
    Machine.make({
      root: Machine.state({
        states: {
          Idle: {},
          Both: {
            type: "parallel",
            states: {
              left: { states: { Waiting: {}, Done: {} } },
              right: { states: { Waiting: {}, Done: {} } }
            }
          }
        }
      }),
      events: Machine.events({ Go: { left: Schema.Number, right: Schema.Number }, Stop: {} }),
      timers: {
        left: (seconds: number) => Duration.seconds(seconds),
        right: (seconds: number) => Duration.seconds(seconds)
      }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Both" } } },
        Both: {
          on: { Stop: { target: "Idle" } },
          states: {
            left: {
              initial: { target: "Both.left.Waiting" },
              states: {
                Waiting: {
                  invoke: {
                    src: "left",
                    input: ({ event }) => event._tag === "Go" ? event.left : 0,
                    onDone: { target: "Both.left.Done" }
                  }
                },
                Done: {}
              }
            },
            right: {
              initial: { target: "Both.right.Waiting" },
              states: {
                Waiting: {
                  invoke: {
                    src: "right",
                    input: ({ event }) => event._tag === "Go" ? event.right : 0,
                    onDone: { target: "Both.right.Done" }
                  }
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
    named(
      "wait for different times",
      send({ _tag: "Go", left: 20, right: 10 }, { happens: [{ "Both.left.Waiting": {}, "Both.right.Waiting": {} }] })
    ),
    named(
      "the right one is due",
      advance("10 seconds", { happens: [{ "Both.left.Waiting": {}, "Both.right.Done": {} }] })
    ),
    named("the left one is due", advance("10 seconds", { happens: [{ "Both.left.Done": {}, "Both.right.Done": {} }] })),
    send({ _tag: "Stop" }, { happens: [{ Idle: {} }] }),
    named(
      "wait for the same time",
      send({ _tag: "Go", left: 5, right: 5 }, { happens: [{ "Both.left.Waiting": {}, "Both.right.Waiting": {} }] })
    ),
    advance("5 seconds", {
      happens: [
        { "Both.left.Done": {}, "Both.right.Waiting": {} },
        { "Both.left.Done": {}, "Both.right.Done": {} }
      ]
    })
  ]
}

const stays: Scenario = {
  name: "fires a timer that stays once, until its state is entered again",
  machine: () =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Waiting: { fields: { rings: Schema.Number } } } }),
      events: Machine.events({ Go: {}, Restart: {} }),
      timers: { ring: "10 seconds" }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Waiting", data: { rings: 0 } } } },
        Waiting: {
          invoke: {
            src: "ring",
            onDone: { update: { Waiting: ({ state }) => ({ rings: state.rings + 1 }) } }
          },
          on: { Restart: { target: "Waiting", reenter: true, data: ({ state }) => state } }
        }
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ Waiting: { rings: 0 } }] }),
    named("the first ring", advance("10 seconds", { happens: [{ Waiting: { rings: 1 } }] })),
    advance("1 minute"),
    send({ _tag: "Restart" }),
    advance("9 seconds"),
    advance("1 second", { happens: [{ Waiting: { rings: 2 } }] })
  ]
}

const periodic: Scenario = {
  name: "fires again and again in a state that its completion enters again",
  machine: () =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Ticking: { fields: { ticks: Schema.Number } } } }),
      events: Machine.events({ Go: {}, Halt: {} }),
      timers: { tick: "10 seconds" }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Ticking", data: { ticks: 0 } } } },
        Ticking: {
          invoke: {
            src: "tick",
            onDone: { target: "Ticking", reenter: true, data: ({ state }) => ({ ticks: state.ticks + 1 }) }
          },
          on: { Halt: { target: "Idle" } }
        }
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ Ticking: { ticks: 0 } }] }),
    named("the first tick", advance("10 seconds", { happens: [{ Ticking: { ticks: 1 } }] })),
    named("the second tick", advance("10 seconds", { happens: [{ Ticking: { ticks: 2 } }] })),
    advance("9 seconds"),
    send({ _tag: "Halt" }, { happens: [{ Idle: {} }] }),
    advance("1 minute")
  ]
}

const unapplicable: Scenario = {
  name: "fails when the completion of a timer cannot be applied",
  machine: () =>
    Machine.make({ root, events: Events, timers: { wait: "10 seconds" } }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Wait: { target: "Waiting", data: { seconds: 10, notes: 0 } } } },
        Waiting: {
          invoke: {
            src: "wait",
            onDone: {
              branches: [{ target: "Expired" }],
              resolve: ({ select, state }) => {
                if (state.notes === 0) throw new Error("cannot leave")
                return select.target("Expired")
              }
            }
          }
        }
      }
    }),
  start,
  steps: [
    send(wait(10), { happens: [waiting(10)] }),
    advance("10 seconds", { outcome: failed("Error: cannot leave") }),
    send({ _tag: "Note" }, { answers: ["Ended"] })
  ]
}

const unevaluable = (name: string, duration: () => Duration.Input, failure: string): Scenario => ({
  name: `fails when the duration of a timer ${name}, in the state that owns it`,
  machine: (fixture) =>
    Machine.make({
      root,
      events: Events,
      effects: { side: fixture.work("side") },
      timers: { wait: (_: string) => duration() }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Wait: { target: "Waiting", data: { seconds: 10, notes: 0 } } } },
        Waiting: {
          invoke: [
            { src: "side", onDone: { stay: true }, onFailure: { stay: true } },
            { src: "wait", input: () => "now", onDone: { target: "Expired" } }
          ]
        }
      }
    }),
  start,
  steps: [
    send(wait(10), { happens: [waiting(10), started("side")], stopped: ["side"], outcome: failed(failure) }),
    send({ _tag: "Note" }, { answers: ["Ended"] })
  ]
})

const unnamed: Scenario = {
  name: "fails when the input of a timer names no duration, as the end of the timer",
  machine: (fixture) =>
    Machine.make({
      root,
      events: Events,
      effects: { first: fixture.work("first"), last: fixture.work("last") },
      // A string that names no duration, which only the timer itself reads.
      timers: { wait: (input: string) => input as Duration.Input }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Wait: { target: "Waiting", data: { seconds: 10, notes: 0 } } } },
        Waiting: {
          invoke: [
            { src: "first", onDone: { stay: true }, onFailure: { stay: true } },
            { src: "wait", input: () => "soon", onDone: { target: "Expired" } },
            { src: "last", onDone: { stay: true }, onFailure: { stay: true } }
          ]
        }
      }
    }),
  start,
  steps: [
    send(wait(10), {
      happens: [waiting(10), started("first"), started("last")],
      stopped: ["first", "last"],
      outcome: failed("Error: Invalid Input: soon")
    }),
    send({ _tag: "Note" }, { answers: ["Ended"] })
  ]
}

const evaluation: Scenario = {
  name: "evaluates a duration in order with the other invocations of its state",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Waiting: {}, Expired: {} } }),
      events: Machine.events({ Go: {} }),
      effects: { work: (name: string) => Effect.orDie(fixture.work(name)) },
      timers: { wait: (seconds: number) => Duration.seconds(seconds) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Waiting" } } },
        Waiting: {
          invoke: [
            {
              src: "work",
              id: "first",
              input: ({ event }) => fixture.mapped("first", event, "first"),
              onDone: { stay: true }
            },
            { src: "wait", input: ({ event }) => fixture.mapped("wait", event, 10), onDone: { target: "Expired" } },
            {
              src: "work",
              id: "last",
              input: ({ event }) => fixture.mapped("last", event, "last"),
              onDone: { stay: true }
            }
          ]
        },
        Expired: {}
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, {
      happens: [{ Waiting: {} }, started("first"), started("last")],
      log: ["first by Go", "wait by Go", "last by Go"]
    }),
    advance("10 seconds", { happens: [{ Expired: {} }], stopped: ["first", "last"] })
  ]
}

const infinite: Scenario = {
  name: "never fires a timer of infinite duration",
  machine: () =>
    Machine.make({ root, events: Events, timers: { wait: Duration.infinity } }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Wait: { target: "Waiting", data: { seconds: 0, notes: 0 } } } },
        Waiting: {
          invoke: { src: "wait", onDone: { target: "Expired" } },
          on: { Cancel: { target: "Idle" } }
        }
      }
    }),
  start,
  steps: [
    send(wait(0), { happens: [waiting(0)] }),
    advance("10 minutes"),
    send({ _tag: "Cancel" }, { happens: [{ Idle: {} }] })
  ]
}

const initialTimer: Scenario = {
  name: "counts the timer of its initial state from its start",
  machine: () =>
    Machine.make({
      root: Machine.state({ states: { Waiting: {}, Expired: {} } }),
      events: Machine.events({ Note: {} }),
      timers: { wait: "10 seconds" }
    }).handle({
      initial: { target: "Waiting" },
      states: { Waiting: { invoke: { src: "wait", onDone: { target: "Expired" } } }, Expired: {} }
    }),
  start: { happens: [{ Waiting: {} }] },
  steps: [
    named("before the first event", advance("6 seconds")),
    send({ _tag: "Note" }),
    named("10 seconds after the start", advance("4 seconds", { happens: [{ Expired: {} }] })),
    named("10 seconds after the first event", advance("6 seconds"))
  ]
}

export const timers: ReadonlyArray<Scenario> = [
  fires,
  cancelled,
  startsOver,
  immediate,
  timerWins,
  effectWins,
  effectStays,
  regions,
  stays,
  periodic,
  unapplicable,
  unevaluable("throws", () => {
    throw new Error("no duration")
  }, "Error: no duration"),
  unnamed,
  evaluation,
  infinite,
  initialTimer
]
