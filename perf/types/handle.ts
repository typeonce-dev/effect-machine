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

const States = Machine.defineStates(State.cases)

const machine = Machine.make({
  states: States.states,
  events: Machine.events(Event.cases.Start, Event.cases.Finish),
  initial: () => States.initial.Idle(State.cases.Idle.make({}))
}).handle({
  Idle: {
    on: {
      Start: ({ target }) => target.full.Running(State.cases.Running.make({}))
    }
  },
  Running: {
    on: {
      Finish: ({ event, target }) => target.full.Done(State.cases.Done.make({ value: event.value }))
    }
  },
  Done: {}
})

void machine
