import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

const State = Schema.TaggedUnion({
  Idle: {},
  Running: {},
  Done: { value: Schema.String }
})

const Event = Schema.TaggedUnion({
  Start: {},
  Finish: { value: Schema.String }
})

const States = Machine.states(State.cases)

const machine = Machine.make({
  states: States.states,
  events: Machine.events(Event.cases.Start, Event.cases.Finish),
  initial: {
    target: (to) => to.Idle(),
    resolve: ({ target }) => target(State.cases.Idle.make({}))
  }
})

void machine
