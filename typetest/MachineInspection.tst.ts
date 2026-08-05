import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../src/index.js"

describe("Machine inspection", () => {
  class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
  class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
  class Reset extends Schema.TaggedClass<Reset>("Reset")("Reset", {}) {}

  const States = Machine.defineStates({
    root: {
      schema: Root,
      initial: "idle",
      states: {
        idle: Idle,
        recent: { type: "history" }
      }
    }
  })
  const initial = States.initial.root(new Root({}), (root) => root.idle(new Idle({})))
  const machine = Machine.make({
    states: States.states,
    events: [Reset],
    initial: () => initial
  }).handle({
    root: {
      on: {
        Reset: () => undefined
      }
    }
  })

  it("preserves state paths for structural inspection", () => {
    expect(Machine.stateNodes(machine)[0]!.path).type.toBe<"root" | "root.idle" | "root.recent">()
    expect(Machine.configuration(machine, initial)[0]!.path).type.toBe<"root" | "root.idle">()
  })

  it("preserves source paths and event tags for transition inspection", () => {
    const definition = Machine.transitionDefinitions(machine)[0]!
    expect(definition.source).type.toBe<"root" | "root.idle">()
    if (definition.trigger.type === "event") {
      expect(definition.trigger.event).type.toBe<"Reset">()
    }
    expect(definition.target.type).type.toBe<"dynamic">()
  })
})
