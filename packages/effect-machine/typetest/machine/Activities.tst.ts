import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
class Loading extends Schema.TaggedClass<Loading>("Loading")("Loading", {}) {}
class Dynamic extends Schema.TaggedClass<Dynamic>("Dynamic")("Dynamic", {}) {}
class TimedOut extends Schema.TaggedClass<TimedOut>("TimedOut")("TimedOut", {}) {}
const States = Machine.state({ states: { Loading, Dynamic } })
const machine = Machine.make({
  timers: { source1: "1 second", source2: (_input: undefined) => ("2 seconds" as const) },
  root: States,
  events: Machine.eventsFromSchemas(TimedOut)
}).handle({
  initial: {
    target: Machine.targets(States).root.Loading,
    decoded: true,
    data: new Loading({})
  },
  states: {
    Loading: { invoke: { src: "source1", id: "timeout", onDone: { none: true } } },
    Dynamic: { invoke: { src: "source2", id: "dynamic", input: () => undefined, onDone: { none: true } } }
  }
})
describe("Machine activity inspection", () => {
  it("preserves source path and activity kind unions", () => {
    const definition = Machine.activityDefinitions(machine)[0]!
    expect(definition.source).type.toBe<"" | "Loading" | "Dynamic">()
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
