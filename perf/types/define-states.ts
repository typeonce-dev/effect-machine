import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

const State = Schema.TaggedUnion({
  Idle: {},
  Running: {},
  Done: { value: Schema.String }
})

const States = Machine.states(State.cases)

void States
