import { assert, it } from "@effect/vitest"
import { Schema } from "effect"
import { Machine } from "../../src/index.js"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Start extends Schema.TaggedClass<Start>("Start")("Start", {}) {}

it("uses the public pipeable and inspectable prototypes", () => {
  const states = Machine.defineStates({ Idle })
  const machine = Machine.make({
    states: states.states,
    events: [Start],
    initial: () => states.initial.Idle(new Idle())
  })

  assert.strictEqual(machine.pipe((value) => value), machine)
  const inspectable = machine as typeof machine & {
    toJSON(): unknown
    [key: symbol]: () => unknown
  }
  assert.deepStrictEqual(inspectable.toJSON(), { _id: "Machine" })
  assert.strictEqual(JSON.stringify(machine), "{\"_id\":\"Machine\"}")
  assert.strictEqual(String(machine), "{\"_id\":\"Machine\"}")
  assert.deepStrictEqual(inspectable[Symbol.for("nodejs.util.inspect.custom")](), { _id: "Machine" })
})
