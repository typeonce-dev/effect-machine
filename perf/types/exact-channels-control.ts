import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const Idle = Schema.TaggedStruct("Idle", { value: Schema.Number })
export const Done = Schema.TaggedStruct("Done", { value: Schema.String })
export const Start = Schema.TaggedStruct("Start", { value: Schema.String })
export const Loaded = Schema.TaggedStruct("Loaded", { value: Schema.String })
export const Notice = Schema.TaggedStruct("Notice", { value: Schema.String })
export const Input = Schema.Struct({ seed: Schema.Number })

export const States = Machine.defineStates({
  Idle,
  Done: {
    schema: Done,
    type: "final",
    output: Schema.String
  }
})

export const machine = Machine.make({
  states: States.states,
  events: Machine.events(Start),
  internalEvents: Machine.internalEvents(Loaded),
  emits: [Notice],
  input: Input,
  initial: (input) => States.initial.Idle(Idle.make({ value: input.seed }))
})
