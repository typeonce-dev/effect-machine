import { Schema } from "effect"
import { Machine } from "../../dist/index.js"

export const State = Schema.TaggedUnion({
  Idle: {},
  Text: { value: Schema.String },
  Count: { value: Schema.Number }
})

export const Route = Schema.TaggedStruct("Route", { value: Schema.String })
export const States = Machine.states(State.cases)

export const machine = Machine.make({
  states: States.states,
  events: Machine.events(Route),
  initial: (to) => to.Idle().resolve(({ target }) => target.from(State.cases.Idle.make({})))
})
