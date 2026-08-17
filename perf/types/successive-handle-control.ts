import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const Flow = Schema.TaggedStruct("Flow", {})
export const Idle = Schema.TaggedStruct("Idle", {})
export const Running = Schema.TaggedStruct("Running", {})
export const Done = Schema.TaggedStruct("Done", { value: Schema.String })
export const Start = Schema.TaggedStruct("Start", {})
export const Finish = Schema.TaggedStruct("Finish", { value: Schema.String })

export const States = Machine.states({
  Flow: {
    schema: Flow,
    initial: "Idle",
    states: {
      Idle,
      Running,
      Done: {
        schema: Done,
        type: "final",
        output: Schema.String
      },
      Route: {
        type: "choice"
      },
      recent: {
        type: "history",
        history: "deep"
      }
    }
  }
})

export const machine = Machine.make({
  states: States.states,
  events: Machine.events(Start, Finish),
  initial: {
    target: (to) => to.Flow.initial(),
    resolve: ({ target }) => target(Flow.make({}), (flow) => flow.Idle(Idle.make({})))
  }
})
