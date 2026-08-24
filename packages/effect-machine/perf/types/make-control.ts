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

void Event
void States
