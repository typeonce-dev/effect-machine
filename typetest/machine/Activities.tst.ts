import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Loading extends Schema.TaggedClass<Loading>("Loading")("Loading", {}) {}
class Dynamic extends Schema.TaggedClass<Dynamic>("Dynamic")("Dynamic", {}) {}
class TimedOut extends Schema.TaggedClass<TimedOut>("TimedOut")("TimedOut", {}) {}

const States = Machine.states({ Loading, Dynamic })
const machine = Machine.make({
  states: States.states,
  events: Machine.events(TimedOut),
  initial: (to) => to.Loading().resolve(({ target }) => (target(new Loading({}))))
}).handle({
  Loading: {
    invoke: Machine.invoke({
      id: "timeout",
      after: "1 second",
      onDone: (to) => to.none
    })
  },
  Dynamic: {
    invoke: Machine.invoke({
      id: "dynamic",
      after: () => "2 seconds" as const,
      onDone: (to) => to.none
    })
  }
})

describe("Machine activity inspection", () => {
  it("preserves source path and activity kind unions", () => {
    const definition = Machine.activityDefinitions(machine)[0]!

    expect(definition.source).type.toBe<"Loading" | "Dynamic">()
    expect(definition.type).type.toBe<"process" | "effect" | "stream" | "timer" | "machine">()
  })

  it("narrows kind-specific descriptive metadata", () => {
    const definition = Machine.activityDefinitions(machine)[0]!

    if (definition.type === "timer") {
      expect(definition.id).type.toBe<string>()
      expect(definition.duration).type.toBe<string | "dynamic">()
    }
    if (definition.type === "stream") {
      expect(definition.id).type.toBe<string>()
    }
  })
})
