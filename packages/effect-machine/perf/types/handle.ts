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

const States = Machine.state({ initial: "Idle", states: State.cases })

const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Event)
}).handle({
  states: {
    Idle: {
      on: {
        Start: (to) => to.branch.Running().resolve(({ target }) => target.from(State.cases.Running.make({})))
      }
    },
    Running: {
      on: {
        Finish: (to) =>
          to.branch.Done().resolve(({ event, target }) => target.from(State.cases.Done.make({ value: event.value })))
      }
    },
    Done: {}
  }
})

void machine
