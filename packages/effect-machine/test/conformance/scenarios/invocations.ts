import { Cause, Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import type { Fixture } from "../support/fixture.js"
import type { Scenario } from "../support/scenario.js"
import { die, fail, failed, final, interrupt, named, send, started, succeed, together } from "../support/scenario.js"

const load = (id: string) => ({ _tag: "Load", id })

const Events = Machine.events({
  Load: { id: Schema.String },
  Note: {},
  Keep: {},
  Cancel: {},
  Reload: {},
  Finish: {},
  Unknown: {}
})

const root = Machine.state({
  states: {
    Idle: {},
    Loading: { fields: { id: Schema.String, notes: Schema.Number } },
    Loaded: { fields: { result: Schema.String } },
    Failed: { fields: { reason: Schema.String } },
    Finished: { type: "final" }
  }
})

const loading = (id: string, notes = 0) => ({ Loading: { id, notes } })

/** Loads a document in a state that can be left, entered again, and updated. */
const loader = (fixture: Fixture, options?: { readonly uninterruptible?: boolean }) =>
  Machine.make({
    id: "Loader",
    root,
    events: Events,
    effects: { load: (id: string) => fixture.work("load", id, options) }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
      Loading: {
        invoke: {
          src: "load",
          input: ({ event, state }) => fixture.mapped("load", event, state.id),
          onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
          onFailure: { target: "Failed", data: ({ error }) => ({ reason: error.reason }) }
        },
        on: {
          Note: { update: { Loading: ({ state }) => ({ ...state, notes: state.notes + 1 }) } },
          Keep: { stay: true },
          Cancel: { target: "Idle" },
          Reload: { target: "Loading", reenter: true, data: ({ state }) => state },
          Finish: { target: "Finished" }
        }
      },
      Loaded: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
      Failed: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } }
    }
  })

const start = { happens: [{ Idle: {} }] }

const loads = (id: string) => send(load(id), { happens: [loading(id), started("load", id)], log: ["load by Load"] })

const done: Scenario = {
  name: "routes the output of an effect through onDone",
  machine: loader,
  start,
  steps: [
    loads("a"),
    succeed("load", "document a", { happens: [{ Loaded: { result: "document a" } }] }),
    named("load again", loads("b")),
    named("the second result", succeed("load", "document b", { happens: [{ Loaded: { result: "document b" } }] }))
  ]
}

const typedFailure: Scenario = {
  name: "routes the typed failure of an effect through onFailure",
  machine: loader,
  start,
  steps: [
    loads("a"),
    fail("load", "not found", { happens: [{ Failed: { reason: "not found" } }] }),
    named("load again", loads("b")),
    succeed("load", "document b", { happens: [{ Loaded: { result: "document b" } }] })
  ]
}

const keepsRunning: Scenario = {
  name: "does not restart the work of a state that stays active",
  machine: loader,
  start,
  steps: [
    loads("a"),
    named("update once", send({ _tag: "Note" }, { happens: [loading("a", 1)] })),
    send({ _tag: "Keep" }),
    send({ _tag: "Unknown" }),
    named("update twice", send({ _tag: "Note" }, { happens: [loading("a", 2)] })),
    succeed("load", "document a", { happens: [{ Loaded: { result: "document a" } }] })
  ]
}

const stops: Scenario = {
  name: "stops the work of a state it leaves, and starts it anew when it returns",
  machine: loader,
  start,
  steps: [
    loads("a"),
    send({ _tag: "Cancel" }, { happens: [{ Idle: {} }], stopped: ["load(a)"] }),
    named("a late result", succeed("load", "late")),
    named("load again", loads("b")),
    send({ _tag: "Reload" }, { happens: [started("load", "b")], stopped: ["load(b)"], log: ["load by Reload"] }),
    named("a result of the run before", succeed("load", "stale", {}, 1)),
    succeed("load", "fresh", { happens: [{ Loaded: { result: "fresh" } }] })
  ]
}

const late = (
  name: string,
  end: (run: number) => ReturnType<typeof succeed>
): Scenario => ({
  name: `ignores ${name} that ends the work of a state while it is left`,
  machine: (fixture) => loader(fixture, { uninterruptible: true }),
  start,
  steps: [
    loads("a"),
    together([send({ _tag: "Cancel" }), end(0)], { happens: [{ Idle: {} }] }),
    named("load again", loads("b")),
    // The same path and id are entered again in the step that leaves them.
    named(
      "left and entered again",
      together([send({ _tag: "Reload" }), end(1)], { happens: [started("load", "b")], log: ["load by Reload"] })
    ),
    succeed("load", "fresh", { happens: [{ Loaded: { result: "fresh" } }] })
  ]
})

const unhandled = (fixture: Fixture) =>
  Machine.make({
    id: "Unhandled",
    root,
    events: Events,
    effects: {
      side: fixture.work("side"),
      load: (id: string) => fixture.work("load", id) as Effect.Effect<never>
    }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
      Loading: {
        invoke: [
          { src: "side", onDone: { stay: true }, onFailure: { stay: true } },
          { src: "load", input: ({ state }) => state.id }
        ],
        on: { Note: { update: { Loading: ({ state }) => ({ ...state, notes: state.notes + 1 }) } } }
      }
    }
  })

const ends = (name: string, end: ReturnType<typeof succeed>, failure: string): Scenario => ({
  name: `fails after ${name}`,
  machine: unhandled,
  start,
  steps: [
    send(load("a"), { happens: [loading("a"), started("side"), started("load", "a")] }),
    send({ _tag: "Note" }, { happens: [loading("a", 1)] }),
    named("the end of the work", { ...end, outcome: failed(failure), stopped: ["side"] }),
    named("an event after it", send({ _tag: "Note" }, { answers: ["Ended"] })),
    named("a late result of other work", succeed("side", "late"))
  ]
})

const unapplicable: Scenario = {
  name: "fails when the result of work cannot be applied",
  machine: (fixture) =>
    Machine.make({
      root,
      events: Events,
      effects: { load: (id: string) => fixture.work("load", id) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
        Loading: {
          invoke: {
            src: "load",
            input: ({ state }) => state.id,
            onDone: {
              branches: [{ target: "Loaded" }],
              resolve: ({ output, select }) => {
                if (output === "poison") throw new Error("cannot apply")
                return select.target("Loaded", { data: { result: output } })
              }
            },
            onFailure: { stay: true }
          }
        },
        Loaded: {}
      }
    }),
  start,
  steps: [
    send(load("a"), { happens: [loading("a"), started("load", "a")] }),
    succeed("load", "poison", { outcome: failed("Error: cannot apply") }),
    send({ _tag: "Note" }, { answers: ["Ended"] })
  ]
}

const unstartable: Scenario = {
  name: "fails when work cannot start, in the state that owns it",
  machine: (fixture) =>
    Machine.make({
      root,
      events: Events,
      effects: {
        first: fixture.work("first"),
        broken: (_: string) => fixture.work("broken"),
        last: fixture.work("last")
      }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
        Loading: {
          invoke: [
            { src: "first", onDone: { stay: true }, onFailure: { stay: true } },
            {
              src: "broken",
              input: ({ state }) => {
                if (state.id === "a") throw new Error("no input")
                return state.id
              },
              onDone: { stay: true },
              onFailure: { stay: true }
            },
            { src: "last", onDone: { stay: true }, onFailure: { stay: true } }
          ]
        }
      }
    }),
  start,
  steps: [
    send(load("a"), {
      happens: [loading("a"), started("first")],
      stopped: ["first"],
      outcome: failed("Error: no input")
    }),
    send({ _tag: "Note" }, { answers: ["Ended"] })
  ]
}

const several: Scenario = {
  name: "starts the invocations of a state in their order, and ends them on their own",
  machine: (fixture) =>
    Machine.make({
      root,
      events: Events,
      effects: {
        zeta: fixture.work("zeta"),
        update: fixture.work("update"),
        alpha: fixture.work("alpha")
      }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
        Loading: {
          invoke: [
            { src: "zeta", onDone: { stay: true }, onFailure: { stay: true } },
            {
              src: "update",
              onDone: { update: { Loading: ({ state }) => ({ ...state, notes: state.notes + 10 }) } },
              onFailure: { stay: true }
            },
            {
              src: "alpha",
              onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
              onFailure: { stay: true }
            }
          ],
          on: {
            Cancel: { target: "Idle" },
            Reload: { target: "Loading", reenter: true, data: ({ state }) => state }
          }
        },
        Loaded: {}
      }
    }),
  start,
  steps: [
    send(load("a"), { happens: [loading("a"), started("zeta"), started("update"), started("alpha")] }),
    named("an end that stays", succeed("zeta", "done")),
    named("an end that updates", succeed("update", "done", { happens: [loading("a", 10)] })),
    // Work that ended is not started again by a step that stays, nor stopped by one that leaves.
    send({ _tag: "Unknown" }),
    send({ _tag: "Cancel" }, { happens: [{ Idle: {} }], stopped: ["alpha"] }),
    named(
      "enter again",
      send(load("b"), { happens: [loading("b"), started("zeta"), started("update"), started("alpha")] })
    ),
    named("a failure that stays", fail("update", "handled")),
    send({ _tag: "Reload" }, {
      happens: [started("zeta"), started("update"), started("alpha")],
      stopped: ["alpha", "zeta"]
    }),
    named(
      "an end that leaves",
      succeed("alpha", "done", { happens: [{ Loaded: { result: "done" } }], stopped: ["update", "zeta"] })
    )
  ]
}

const parallelRoot = Machine.state({
  states: {
    Idle: {},
    Active: {
      type: "parallel",
      states: {
        left: { states: { Busy: {}, Done: {} } },
        right: { states: { Busy: {}, Done: {} } }
      }
    }
  }
})

const regions: Scenario = {
  name: "runs the work of parallel regions on their own, from the outside in",
  machine: (fixture) => {
    const work = (name: string) => Effect.orDie(fixture.work(name))
    return Machine.make({
      root: parallelRoot,
      events: Machine.events({ Go: {}, Stop: {}, Back: {} }),
      effects: { work }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Active" } } },
        Active: {
          on: { Stop: { target: "Idle" } },
          states: {
            left: {
              initial: { target: "Active.left.Busy" },
              states: {
                Busy: {
                  invoke: [
                    { src: "work", id: "zeta", input: () => "left zeta", onDone: { stay: true } },
                    { src: "work", id: "alpha", input: () => "left alpha", onDone: { target: "Active.left.Done" } }
                  ]
                },
                Done: { on: { Back: { target: "Active.left.Busy" } } }
              }
            },
            right: {
              invoke: { src: "work", id: "region", input: () => "right region", onDone: { stay: true } },
              initial: { target: "Active.right.Busy" },
              states: {
                Busy: {
                  invoke: {
                    src: "work",
                    id: "busy",
                    input: () => "right busy",
                    onDone: { target: "Active.right.Done" }
                  }
                },
                Done: {}
              }
            }
          }
        }
      }
    })
  },
  start,
  steps: [
    send({ _tag: "Go" }, {
      happens: [
        { "Active.left.Busy": {}, "Active.right.Busy": {} },
        started("right region"),
        started("left zeta"),
        started("left alpha"),
        started("right busy")
      ]
    }),
    succeed("left alpha", "done", {
      happens: [{ "Active.left.Done": {}, "Active.right.Busy": {} }],
      stopped: ["left zeta"]
    }),
    send({ _tag: "Back" }, {
      happens: [{ "Active.left.Busy": {}, "Active.right.Busy": {} }, started("left zeta"), started("left alpha")]
    }),
    succeed("right busy", "done", { happens: [{ "Active.left.Busy": {}, "Active.right.Done": {} }] }),
    send({ _tag: "Stop" }, {
      happens: [{ Idle: {} }],
      stopped: ["left alpha", "left zeta", "right region"]
    })
  ]
}

const instant: Scenario = {
  name: "handles the end of work that does not suspend in a later step",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({
        fields: { hops: Schema.Number },
        states: { Idle: {}, Ticking: {}, Failing: {}, Recovered: { fields: { reason: Schema.String } } }
      }),
      events: Machine.events({ Go: {} }),
      effects: {
        tick: fixture.instant("tick", Effect.void),
        failing: fixture.instant("failing", Effect.fail({ reason: "offline" }))
      }
    }).handle({
      root: () => ({ hops: 0 }),
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Ticking" } } },
        Ticking: {
          invoke: {
            src: "tick",
            onDone: {
              branches: [{ target: "Ticking", update: "root" }, { target: "Failing" }],
              reenter: true,
              resolve: ({ root, select }) =>
                root.hops < 2
                  ? select.target("Ticking", { update: { root: { hops: root.hops + 1 } } })
                  : select.target("Failing")
            }
          }
        },
        Failing: {
          invoke: {
            src: "failing",
            onFailure: { target: "Recovered", data: ({ error }) => ({ reason: error.reason }) }
          }
        },
        Recovered: {}
      }
    }),
  start: { happens: [{ "": { hops: 0 }, Idle: {} }] },
  steps: [
    send({ _tag: "Go" }, {
      happens: [
        { "": { hops: 0 }, Ticking: {} },
        started("tick"),
        { "": { hops: 1 }, Ticking: {} },
        started("tick"),
        { "": { hops: 2 }, Ticking: {} },
        started("tick"),
        { "": { hops: 2 }, Failing: {} },
        started("failing"),
        { "": { hops: 2 }, Recovered: { reason: "offline" } }
      ]
    })
  ]
}

const transient: Scenario = {
  name: "starts no work for a state it only passes through",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Passing: {}, Routing: { type: "choice" }, Settled: {} } }),
      events: Machine.events({ Go: {}, Back: {} }),
      effects: { passing: fixture.work("passing"), settled: fixture.work("settled") }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Passing" } } },
        Passing: {
          invoke: { src: "passing", onDone: { stay: true }, onFailure: { stay: true } },
          always: { target: "Routing" }
        },
        Routing: {
          choice: { branches: [{ target: "Settled" }], resolve: ({ select }) => select.target("Settled") }
        },
        Settled: {
          invoke: { src: "settled", onDone: { target: "Idle" }, onFailure: { target: "Idle" } },
          on: { Back: { target: "Passing" } }
        }
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ Settled: {} }, started("settled")] }),
    // Left and entered again within one step.
    send({ _tag: "Back" }, { happens: [started("settled")], stopped: ["settled"] }),
    succeed("settled", "done", { happens: [{ Idle: {} }] })
  ]
}

const inputs: Scenario = {
  name: "maps the input of work from the state and the event that entered it",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({
        fields: { owner: Schema.String },
        states: { Idle: {}, Outer: { fields: { level: Schema.Number }, states: { First: {}, Second: {} } } }
      }),
      events: Machine.events({ Go: { level: Schema.Number }, Next: {} }),
      internalEvents: Machine.internalEvents({ Raised: {} }),
      effects: {
        outer: (input: string) => fixture.work("outer", input),
        inner: (input: string) => fixture.work("inner", input)
      }
    }).handle({
      root: () => ({ owner: "ada" }),
      initial: { target: "Idle" },
      states: {
        Idle: {
          on: { Go: { target: "Outer", data: ({ event }) => ({ level: event.level }) } }
        },
        Outer: {
          invoke: {
            src: "outer",
            input: ({ event, root, state }) => fixture.mapped("outer", event, `${root.owner} ${state.level}`),
            onDone: { target: "Idle" },
            onFailure: { target: "Idle" }
          },
          initial: { target: "Outer.First" },
          states: {
            First: {
              on: {
                Next: { stay: true, commands: (_, enqueue) => enqueue.raise({ _tag: "Raised" }) },
                Raised: { target: "Outer.Second" }
              }
            },
            Second: {
              invoke: {
                src: "inner",
                input: ({ ancestors, containingState, event }) =>
                  fixture.mapped("inner", event, `${ancestors.Outer.level} ${containingState.level}`),
                onDone: { target: "Idle" },
                onFailure: { target: "Idle" }
              }
            }
          }
        }
      }
    }),
  start: { happens: [{ "": { owner: "ada" }, Idle: {} }] },
  steps: [
    send({ _tag: "Go", level: 3 }, {
      happens: [{ "": { owner: "ada" }, Outer: { level: 3 }, "Outer.First": {} }, started("outer", "ada 3")],
      log: ["outer by Go"]
    }),
    send({ _tag: "Next" }, {
      happens: [{ "": { owner: "ada" }, Outer: { level: 3 }, "Outer.Second": {} }, started("inner", "3 3")],
      log: ["inner by Raised"]
    }),
    succeed("outer", "done", { happens: [{ "": { owner: "ada" }, Idle: {} }], stopped: ["inner(3 3)"] })
  ]
}

const nested: Scenario = {
  name: "stops and starts the work of every level that a step exits and enters",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({
        states: { Idle: {}, Outer: { states: { First: {}, Second: {} } } }
      }),
      events: Machine.events({ Go: {}, Next: {}, Again: {}, Leave: {} }),
      effects: { outer: fixture.work("outer"), first: fixture.work("first"), second: fixture.work("second") }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Outer" } } },
        Outer: {
          invoke: { src: "outer", onDone: { stay: true }, onFailure: { stay: true } },
          on: { Again: { target: "Outer", reenter: true }, Leave: { target: "Idle" } },
          initial: { target: "Outer.First" },
          states: {
            First: {
              invoke: { src: "first", onDone: { stay: true }, onFailure: { stay: true } },
              on: { Next: { target: "Outer.Second" } }
            },
            Second: { invoke: { src: "second", onDone: { stay: true }, onFailure: { stay: true } } }
          }
        }
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ "Outer.First": {} }, started("outer"), started("first")] }),
    send({ _tag: "Next" }, { happens: [{ "Outer.Second": {} }, started("second")], stopped: ["first"] }),
    send({ _tag: "Again" }, {
      happens: [{ "Outer.First": {} }, started("outer"), started("first")],
      stopped: ["outer", "second"]
    }),
    send({ _tag: "Leave" }, { happens: [{ Idle: {} }], stopped: ["first", "outer"] })
  ]
}

const finish: Scenario = {
  name: "stops all work when it ends, also that of states that stay active",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Open: {}, Closed: { type: "final", output: Schema.String } } }),
      events: Machine.events({ Note: {}, Finish: {} }),
      effects: { whole: fixture.work("whole"), open: fixture.work("open") }
    }).handle({
      invoke: { src: "whole", onDone: { stay: true }, onFailure: { stay: true } },
      initial: { target: "Open" },
      on: { Finish: { target: "Closed" } },
      states: {
        Open: { invoke: { src: "open", onDone: { stay: true }, onFailure: { stay: true } } },
        Closed: { output: () => "closed" }
      }
    }),
  start: { happens: [{ Open: {} }, started("whole"), started("open")] },
  steps: [
    send({ _tag: "Note" }),
    send({ _tag: "Finish" }, { happens: [{ Closed: {} }], stopped: ["open", "whole"], outcome: final("closed") }),
    named("a late result", succeed("whole", "late")),
    named("another late result", succeed("open", "late"))
  ]
}

const retries: Scenario = {
  name: "retries work through a choice, and finishes with its output",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({
        states: {
          Idle: {},
          Flow: {
            fields: { attempts: Schema.Number },
            states: { Routing: { type: "choice" }, Checking: {}, GivenUp: {} }
          },
          Done: { fields: { result: Schema.String }, type: "final", output: Schema.String }
        }
      }),
      events: Machine.events({ Go: {} }),
      effects: { check: fixture.work("check") }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Flow", data: { attempts: 0 } } } },
        Flow: {
          initial: { target: "Flow.Routing" },
          states: {
            Routing: {
              choice: {
                branches: [{ target: "Flow.Checking" }, { target: "Flow.GivenUp" }],
                resolve: ({ containingState, select }) =>
                  containingState.attempts < 2 ? select.target("Flow.Checking") : select.target("Flow.GivenUp")
              }
            },
            Checking: {
              invoke: {
                src: "check",
                onDone: { target: "Done", data: ({ output }) => ({ result: output }) },
                onFailure: {
                  target: "Flow.Routing",
                  reenter: true,
                  update: { Flow: ({ ancestors }) => ({ attempts: ancestors.Flow.attempts + 1 }) }
                }
              }
            },
            GivenUp: { on: { Go: { target: "Flow", reenter: true, data: { attempts: 1 } } } }
          }
        },
        Done: { output: ({ state }) => state.result }
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ Flow: { attempts: 0 }, "Flow.Checking": {} }, started("check")] }),
    named(
      "the first failure",
      fail("check", "offline", { happens: [{ Flow: { attempts: 1 }, "Flow.Checking": {} }, started("check")] })
    ),
    named(
      "the second failure",
      fail("check", "offline", { happens: [{ Flow: { attempts: 2 }, "Flow.GivenUp": {} }] })
    ),
    named(
      "go again",
      send({ _tag: "Go" }, { happens: [{ Flow: { attempts: 1 }, "Flow.Checking": {} }, started("check")] })
    ),
    succeed("check", "fine", { happens: [{ Done: { result: "fine" } }], outcome: final("fine") })
  ]
}

const effects: Scenario = {
  name: "emits and raises events from the outcome of work",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Loading: {}, Loaded: {}, Published: {} } }),
      events: Machine.events({ Go: {} }),
      internalEvents: Machine.internalEvents({ Publish: {} }),
      emittedEvents: Machine.emittedEvents({ Changed: { to: Schema.String } }),
      effects: { load: fixture.work("load") }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Loading" } } },
        Loading: {
          invoke: {
            src: "load",
            onDone: {
              branches: [{ target: "Loaded" }],
              resolve: ({ output, select }, enqueue) => {
                enqueue.emit({ _tag: "Changed", to: output })
                enqueue.raise({ _tag: "Publish" })
                return select.target("Loaded")
              }
            },
            onFailure: { stay: true }
          }
        },
        Loaded: {
          on: {
            Publish: { target: "Published", commands: (_, enqueue) => enqueue.emit({ _tag: "Changed", to: "all" }) }
          }
        },
        Published: {}
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ Loading: {} }, started("load")] }),
    succeed("load", "document", {
      happens: [{ Published: {} }],
      emits: [{ _tag: "Changed", to: "document" }, { _tag: "Changed", to: "all" }]
    })
  ]
}

const initialWork: Scenario = {
  name: "starts the work of its initial state before any event",
  machine: (fixture) => {
    const work = (name: string) => fixture.work(name)
    return Machine.make({
      root: Machine.state({
        states: { Loading: { states: { Routing: { type: "choice" }, Inner: {}, Skipped: {} } }, Loaded: {} }
      }),
      events: Machine.events({ Note: {} }),
      effects: { work }
    }).handle({
      initial: { target: "Loading" },
      states: {
        Loading: {
          invoke: {
            src: "work",
            id: "outer",
            input: ({ event }) => fixture.mapped("outer", event, "outer"),
            onDone: { target: "Loaded" },
            onFailure: { stay: true }
          },
          initial: { target: "Loading.Routing" },
          states: {
            Routing: {
              choice: {
                branches: [{ target: "Loading.Inner" }],
                resolve: ({ select }) => select.target("Loading.Inner")
              }
            },
            Skipped: {},
            Inner: {
              invoke: {
                src: "work",
                id: "inner",
                input: ({ event }) => fixture.mapped("inner", event, "inner"),
                onDone: { stay: true },
                onFailure: { stay: true }
              }
            }
          }
        },
        Loaded: {}
      }
    })
  },
  start: {
    happens: [{ "Loading.Inner": {} }, started("outer"), started("inner")],
    log: ["outer by initial", "inner by initial"]
  },
  steps: [
    send({ _tag: "Note" }),
    succeed("outer", "done", { happens: [{ Loaded: {} }], stopped: ["inner"] })
  ]
}

const sendsToItself: Scenario = {
  name: "takes the events that its own work sends to it",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Working: { fields: { progress: Schema.Number } } } }),
      events: Machine.events({ Go: {}, Progress: { by: Schema.Number } }),
      effects: {
        work: (report: (by: number) => Effect.Effect<unknown>) =>
          fixture.work("work").pipe(Effect.flatMap(() => report(5)), Effect.orDie)
      }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Working", data: { progress: 0 } } } },
        Working: {
          invoke: {
            src: "work",
            input: ({ self }) => (by: number) => Effect.orDie(self.send({ _tag: "Progress", by })),
            onDone: { stay: true }
          },
          on: { Progress: { update: { Working: ({ event, state }) => ({ progress: state.progress + event.by }) } } }
        }
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ Working: { progress: 0 } }, started("work")] }),
    succeed("work", "report", { happens: [{ Working: { progress: 5 } }] }),
    named("an event after it", send({ _tag: "Progress", by: 1 }, { happens: [{ Working: { progress: 6 } }] }))
  ]
}

const race: Scenario = {
  name: "lets the first of two ends that come together win",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Racing: {}, First: {}, Second: {} } }),
      events: Machine.events({ Go: {} }),
      effects: { first: fixture.instant("first", Effect.void), second: fixture.instant("second", Effect.void) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Racing" } } },
        Racing: {
          invoke: [{ src: "first", onDone: { target: "First" } }, { src: "second", onDone: { target: "Second" } }]
        },
        First: {},
        Second: {}
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ Racing: {} }, started("first"), started("second"), { First: {} }] })
  ]
}

const precedence: Scenario = {
  name: "prefers the typed failure of work that also dies",
  machine: (fixture) =>
    Machine.make({
      root,
      events: Events,
      effects: {
        load: fixture.instant(
          "load",
          Effect.failCause(Cause.combine(Cause.die(new Error("broken")), Cause.fail({ reason: "not found" })))
        )
      }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
        Loading: {
          invoke: { src: "load", onFailure: { target: "Failed", data: ({ error }) => ({ reason: error.reason }) } }
        },
        Failed: {}
      }
    }),
  start,
  steps: [
    send(load("a"), { happens: [loading("a"), started("load"), { Failed: { reason: "not found" } }] })
  ]
}

const scoped: Scenario = {
  name: "closes the scope of work with its end, and with its stop",
  machine: (fixture) =>
    Machine.make({
      root,
      events: Events,
      effects: {
        load: (id: string) =>
          Effect.andThen(
            Effect.addFinalizer(() => Effect.sync(() => fixture.note(`release ${id}`))),
            fixture.work("load", id)
          )
      }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
        Loading: {
          invoke: {
            src: "load",
            input: ({ state }) => state.id,
            onDone: { update: { Loading: ({ state }) => ({ ...state, notes: state.notes + 1 }) } },
            onFailure: { stay: true }
          },
          on: { Cancel: { target: "Idle" } }
        }
      }
    }),
  start,
  steps: [
    send(load("a"), { happens: [loading("a"), started("load", "a")] }),
    succeed("load", "document a", { happens: [loading("a", 1)], log: ["release a"] }),
    named("cancel", send({ _tag: "Cancel" }, { happens: [{ Idle: {} }] })),
    named("load again", send(load("b"), { happens: [loading("b"), started("load", "b")] })),
    named(
      "cancel again",
      send({ _tag: "Cancel" }, { happens: [{ Idle: {} }], stopped: ["load(b)"], log: ["release b"] })
    )
  ]
}

const outcomeInput: Scenario = {
  name: "maps the input of work that the outcome of other work starts",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, First: {}, Second: {}, Third: {} } }),
      events: Machine.events({ Go: {} }),
      effects: {
        first: fixture.work("first"),
        second: (name: string) => fixture.work("second", name),
        third: (name: string) => fixture.work("third", name)
      }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "First" } } },
        First: { invoke: { src: "first", onDone: { target: "Second" }, onFailure: { stay: true } } },
        Second: {
          invoke: {
            src: "second",
            input: ({ event }) => fixture.mapped("second", event, "x"),
            onDone: { stay: true },
            onFailure: { target: "Third" }
          }
        },
        Third: {
          invoke: {
            src: "third",
            input: ({ event }) => fixture.mapped("third", event, "y"),
            onDone: { stay: true },
            onFailure: { stay: true }
          }
        }
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ First: {} }, started("first")] }),
    succeed("first", "done", {
      happens: [{ Second: {} }, started("second", "x")],
      log: ["second by Done of First/first"]
    }),
    fail("second", "no", {
      happens: [{ Third: {} }, started("third", "y")],
      log: ["third by Failure of Second/second"]
    })
  ]
}

const inOrder: Scenario = {
  name: "starts work in the order in which one step enters states",
  machine: (fixture) =>
    Machine.make({
      root: Machine.state({
        states: {
          Idle: {},
          Both: {
            type: "parallel",
            states: { left: { states: { A: {}, B: {} } }, right: { states: { A: {}, B: {} } } }
          }
        }
      }),
      events: Machine.events({ Go: {}, Next: {} }),
      internalEvents: Machine.internalEvents({ Then: {} }),
      effects: { work: (name: string) => Effect.orDie(fixture.work(name)) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Both" } } },
        Both: {
          states: {
            left: {
              initial: { target: "Both.left.A" },
              states: {
                // Entered by the raised event, after the other region.
                A: { on: { Then: { target: "Both.left.B" } } },
                B: { invoke: { src: "work", input: () => "left", onDone: { stay: true } } }
              }
            },
            right: {
              initial: { target: "Both.right.A" },
              states: {
                A: {
                  on: { Next: { target: "Both.right.B", commands: (_, enqueue) => enqueue.raise({ _tag: "Then" }) } }
                },
                B: { invoke: { src: "work", input: () => "right", onDone: { stay: true } } }
              }
            }
          }
        }
      }
    }),
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ "Both.left.A": {}, "Both.right.A": {} }] }),
    send({ _tag: "Next" }, {
      happens: [{ "Both.left.B": {}, "Both.right.B": {} }, started("right"), started("left")]
    })
  ]
}

const handover: Scenario = {
  name: "has released the work of the states it leaves before it starts that of the states it enters",
  machine: (fixture) => {
    const work = (name: string) =>
      Effect.andThen(
        Effect.sync(() => fixture.note(`acquire ${name}`)),
        Effect.onInterrupt(
          Effect.orDie(fixture.work(name)),
          // Releasing takes a while.
          () => Effect.andThen(Effect.yieldNow, Effect.sync(() => fixture.note(`release ${name}`)))
        )
      )
    return Machine.make({
      root: Machine.state({ states: { Idle: {}, First: {}, Second: {} } }),
      events: Machine.events({ Go: {}, Next: {}, Again: {} }),
      effects: { work }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "First" } } },
        First: {
          invoke: { src: "work", input: () => "first", onDone: { stay: true } },
          on: { Next: { target: "Second" } }
        },
        Second: {
          invoke: { src: "work", input: () => "second", onDone: { stay: true } },
          on: { Again: { reenter: true } }
        }
      }
    })
  },
  start,
  steps: [
    send({ _tag: "Go" }, { happens: [{ First: {} }, started("first")], log: ["acquire first"] }),
    send({ _tag: "Next" }, {
      happens: [{ Second: {} }, started("second")],
      stopped: ["first"],
      log: ["release first", "acquire second"]
    }),
    send({ _tag: "Again" }, {
      happens: [started("second")],
      stopped: ["second"],
      log: ["release second", "acquire second"]
    })
  ]
}

export const invocations: ReadonlyArray<Scenario> = [
  done,
  typedFailure,
  keepsRunning,
  stops,
  late("a result", (run) => succeed("load", "stale", {}, run)),
  late("a typed failure", (run) => fail("load", "stale", {}, run)),
  late("a defect", (run) => die("load", new Error("stale"), {}, run)),
  ends("a typed failure without onFailure", fail("load", "not found"), "{\"reason\":\"not found\"}"),
  ends("a defect of its work", die("load", new TypeError("broken")), "TypeError: broken"),
  ends("an interruption of its work", interrupt("load"), "Interrupted"),
  ends(
    "an output without onDone",
    succeed("load", "unexpected"),
    "Error: Invocation \"load\" completed without the required onDone handler"
  ),
  unapplicable,
  unstartable,
  several,
  regions,
  instant,
  transient,
  inputs,
  nested,
  finish,
  retries,
  effects,
  initialWork,
  sendsToItself,
  race,
  precedence,
  scoped,
  outcomeInput,
  inOrder,
  handover
]
