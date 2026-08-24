import { Schema } from "effect"
import { Machine } from "../../dist/index.js"

export const Flow = Schema.TaggedStruct("Flow", {})
export const Idle = Schema.TaggedStruct("Idle", {})
export const Ready = Schema.TaggedStruct("Ready", {})

export const States = Machine.states({
  Flow: {
    schema: Flow,
    initial: "Idle",
    states: {
      Idle,
      Route: {
        type: "choice"
      },
      recent: {
        type: "history",
        history: "deep"
      }
    }
  },
  Ready
})

export const snapshot = { path: "Ready" as const, value: Ready.make({}) }

export const machine = Machine.make({
  id: "perf-readiness",
  states: States.states,
  events: Machine.events(),
  initial: (to) => to.Ready().resolve(({ target }) => target.from(Ready.make({})))
}).handle({
  Flow: {
    history: {
      recent: {
        default: ({ target }) => target.Flow.from(Flow.make({}), (flow) => flow.Idle.from(Idle.make({})))
      }
    },
    states: {
      Idle: {},
      Route: {
        choice: (to) => to.full.Ready().resolve(({ target }) => target.from(Ready.make({})))
      }
    }
  },
  Ready: {}
})
