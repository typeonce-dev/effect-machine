import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Loading extends Schema.TaggedClass<Loading>("Loading")("Loading", {}) {}
class Dynamic extends Schema.TaggedClass<Dynamic>("Dynamic")("Dynamic", {}) {}
class TimedOut extends Schema.TaggedClass<TimedOut>("TimedOut")("TimedOut", {}) {}

const States = Machine.defineStates({ Loading, Dynamic })
const machine = Machine.make({
  states: States.states,
  events: [TimedOut],
  initial: () => States.initial.Loading(new Loading({}))
}).handle({
  Loading: {
    invoke: Machine.after("1 second", new TimedOut({}), { id: "timeout" })
  },
  Dynamic: {
    invoke: () => Machine.after("2 seconds", new TimedOut({}))
  }
})

describe("Machine activity inspection", () => {
  it("preserves source path and activity kind unions", () => {
    const definition = Machine.activityDefinitions(machine)[0]!

    expect(definition.source).type.toBe<"Loading" | "Dynamic">()
    expect(definition.type).type.toBe<"process" | "effect" | "timer" | "machine" | "dynamic">()
  })

  it("narrows kind-specific descriptive metadata", () => {
    const definition = Machine.activityDefinitions(machine)[0]!

    if (definition.type === "timer") {
      expect(definition.id).type.toBe<string>()
      expect(definition.duration).type.toBe<string>()
      expect(definition.event).type.toBe<string>()
    } else if (definition.type === "dynamic") {
      expect(definition).type.not.toHaveProperty("id")
    }
  })
})
