import { Schema } from "effect"
import { expect } from "tstyche"
import { Machine } from "../../effect-machine/src/index.js"
import { AtomMachine } from "../../effect-machine/src/unstable/reactivity/index.js"
import { useMachineAtom } from "../src/index.js"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Continue extends Schema.TaggedClass<Continue>("Continue")("Continue", {}) {}

const States = Machine.states({ Idle })
const machine = Machine.make({
  states: States.states,
  events: Machine.events(Continue),
  initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new Idle({})))
}).handle({
  Idle: {
    on: {
      Continue: (to) => to.none
    }
  }
})
const expected = AtomMachine.make(machine)

const owned = useMachineAtom(() => AtomMachine.make(machine))

expect(owned).type.toBe<typeof expected>()
