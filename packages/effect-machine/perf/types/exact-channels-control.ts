import { Schema } from "effect"
import { Machine } from "../../dist/index.js"
export const Idle = Schema.TaggedStruct("Idle", { value: Schema.Number })
export const Done = Schema.TaggedStruct("Done", { value: Schema.String })
export const Start = Schema.TaggedStruct("Start", { value: Schema.String })
export const Loaded = Schema.TaggedStruct("Loaded", { value: Schema.String })
export const Notice = Schema.TaggedStruct("Notice", { value: Schema.String })
export const Input = Schema.Struct({ seed: Schema.Number })
export const States = Machine.state({
  fields: {
    input: Schema.toType(Input)
  },
  states: {
    Idle,
    Done: {
      schema: Done,
      type: "final",
      output: Schema.String
    }
  }
})
export const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Start),
  internalEvents: Machine.internalEventsFromSchemas(Loaded),
  emittedEvents: Machine.emittedEventsFromSchemas(Notice),
  input: Input
})
