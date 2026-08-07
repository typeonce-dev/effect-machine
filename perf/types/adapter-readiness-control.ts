import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const Flow = Schema.TaggedStruct("Flow", {})
export const Idle = Schema.TaggedStruct("Idle", {})
export const Ready = Schema.TaggedStruct("Ready", {})

export const States = Machine.defineStates({
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

export const snapshot = States.initial.Ready(Ready.make({}))

export const machine = Machine.make({
  id: "perf-readiness",
  states: States.states,
  events: [],
  initial: () => snapshot
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
        choice: {
          targets: ["Ready"],
          transition: ({ target }) => target.full.Ready(Ready.make({}))
        }
      }
    }
  },
  Ready: {}
})
