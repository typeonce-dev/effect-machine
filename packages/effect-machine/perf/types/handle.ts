import { Schema } from "effect"
import { Machine } from "../../dist/index.js"

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
  initial: (to) => to.Idle().resolve(({ target }) => target.from(State.cases.Idle.make({})))
}).handle({
  Idle: {
    on: {
      Start: (to) => to.full.Running().resolve(({ target }) => target.from(State.cases.Running.make({})))
    }
  },
  Running: {
    on: {
      Finish: (to) =>
        to.full.Done().resolve(({ event, target }) => target.from(State.cases.Done.make({ value: event.value })))
    }
  },
  Done: {}
})

void machine
