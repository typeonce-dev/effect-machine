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
const States = Machine.state({ states: State.cases })
const targets1 = Machine.targets(States)
const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Event)
}).handle({
  initial: { target: targets1.root.Idle },
  states: {
    Idle: {
      on: {
        Start: { target: targets1.root.Running, data: () => (State.cases.Running.make({})) }
      }
    },
    Running: {
      on: {
        Finish: { target: targets1.root.Done, data: ({ event }) => (State.cases.Done.make({ value: event.value })) }
      }
    },
    Done: {}
  }
})
void machine
