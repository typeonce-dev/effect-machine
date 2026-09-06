import { Schema } from "effect"
import { Machine } from "../../dist/index.js"

export const Flow = Schema.TaggedStruct("Flow", {})
export const Idle = Schema.TaggedStruct("Idle", {})
export const Running = Schema.TaggedStruct("Running", {})
export const Done = Schema.TaggedStruct("Done", { value: Schema.String })
export const Start = Schema.TaggedStruct("Start", {})
export const Finish = Schema.TaggedStruct("Finish", { value: Schema.String })

export const States = Machine.state({
  initial: "Flow",
  states: {
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
  }
})

export const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Start, Finish),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) => to.Flow.from(Flow.make({}), (flow) => flow.Idle.from(Idle.make({}))))
    )
})
