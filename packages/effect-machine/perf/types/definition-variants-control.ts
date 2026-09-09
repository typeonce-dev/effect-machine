import { Schema } from "effect"
import { Machine } from "../../dist/index.js"
export const Flow = Schema.TaggedStruct("Flow", {})
export const Idle = Schema.TaggedStruct("Idle", {})
export const Running = Schema.TaggedStruct("Running", {})
export const Done = Schema.TaggedStruct("Done", { value: Schema.String })
export const Start = Schema.TaggedStruct("Start", {})
export const Finish = Schema.TaggedStruct("Finish", { value: Schema.String })
export const States = Machine.state({
  states: {
    Flow: {
      schema: Flow,
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
  events: Machine.eventsFromSchemas(Start, Finish)
})
