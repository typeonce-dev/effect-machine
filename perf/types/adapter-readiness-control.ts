import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

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
  initial: {
    target: (to) => to.Ready(),
    resolve: ({ target }) => target(Ready.make({}))
  }
}).handle({
  Flow: {
    history: {
      recent: {
        default: ({ target }) => target.Flow(Flow.make({}), (flow) => flow.Idle(Idle.make({})))
      }
    },
    states: {
      Idle: {},
      Route: {
        choice: (to) => to.full.Ready().resolve(({ target }) => target(Ready.make({})))
      }
    }
  },
  Ready: {}
})
