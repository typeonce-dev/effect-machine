import { assert, it } from "@effect/vitest"
import { Schema } from "effect"
import { Machine } from "../../src/index.js"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Start extends Schema.TaggedClass<Start>("Start")("Start", {}) {}

it("uses the public pipeable and inspectable prototypes", () => {
  const states = Machine.state({ initial: "Idle", states: { Idle } })
  const machine = Machine.make({
    root: states,
    events: Machine.eventsFromSchemas(Start),
    initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new Idle())))
  })

  assert.strictEqual(machine.pipe((value) => value), machine)
  const inspectable = machine as typeof machine & {
    toJSON(): unknown
    [key: symbol]: () => unknown
  }
  assert.deepStrictEqual(inspectable.toJSON(), { _id: "Machine" })
  assert.strictEqual(JSON.stringify(machine), "{\"_id\":\"Machine\"}")
  assert.strictEqual(String(machine), "{\"_id\":\"Machine\"}")
  assert.deepStrictEqual(inspectable[Symbol.for("nodejs.util.inspect.custom")]!(), { _id: "Machine" })
})
