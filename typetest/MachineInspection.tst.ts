import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../src/index.js"

describe("Machine inspection", () => {
  class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
  class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
  class Running extends Schema.TaggedClass<Running>("Running")("Running", {}) {}
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
    expect(definition.source).type.toBe<"root" | "root.idle" | "root.recent">()
    if (definition.trigger.type === "event") {
      expect(definition.trigger.event).type.toBe<"Reset">()
    }
    expect(definition.targets).type.toBe<
      | { readonly type: "dynamic" }
      | { readonly type: "declared"; readonly paths: ReadonlyArray<"root" | "root.idle" | "root.recent"> }
    >()
  })

  it("checks inferred transition results against declared targets", () => {
    const FlatStates = Machine.defineStates({ idle: Idle, running: Running })
    const flat = Machine.make({
      states: FlatStates.states,
      events: [Reset],
      initial: () => FlatStates.initial.idle(new Idle({}))
    })
    const target = flat.makeTargetBuilder("idle")

    const direct = {
      idle: {
        on: {
          Reset: {
            targets: ["running"],
            transition: () => target.full.running(new Running({}))
          }
        }
      }
    } as const
    const effectful = {
      idle: {
        on: {
          Reset: {
            targets: ["running"],
            transition: () => Effect.succeed(target.full.running(new Running({})))
          }
        }
      }
    } as const
    const constructed = {
      idle: {
        on: {
          Reset: {
            targets: ["running"],
            transition: () => target.full.running.from()
          }
        }
      }
    } as const
    const undeclared = {
      idle: {
        on: {
          Reset: {
            targets: ["idle"],
            transition: () => target.full.running(new Running({}))
          }
        }
      }
    } as const
    const multiple = {
      idle: {
        on: {
          Reset: {
            targets: ["idle", "running"],
            transition: () =>
              Math.random() > 0.5
                ? target.full.idle(new Idle({}))
                : target.full.running(new Running({}))
          }
        }
      }
    } as const
    const partiallyUndeclared = {
      idle: {
        on: {
          Reset: {
            targets: ["running"],
            transition: () =>
              Math.random() > 0.5
                ? target.full.idle(new Idle({}))
                : target.full.running(new Running({}))
          }
        }
      }
    } as const
    const always = {
      idle: {
        always: {
          targets: ["running"],
          transition: () => target.full.running(new Running({}))
        }
      }
    } as const
    const undeclaredAlways = {
      idle: {
        always: {
          targets: ["idle"],
          transition: () => target.full.running(new Running({}))
        }
      }
    } as const
    const onDone = {
      idle: {
        onDone: {
          targets: ["running"],
          transition: () => Effect.succeed(target.full.running(new Running({})))
        }
      }
    } as const
    const undeclaredOnDone = {
      idle: {
        onDone: {
          targets: ["idle"],
          transition: () => target.full.running(new Running({}))
        }
      }
    } as const

    expect(flat.handle).type.toBeCallableWith(direct)
    expect(flat.handle).type.toBeCallableWith(effectful)
    expect(flat.handle).type.toBeCallableWith(constructed)
    expect(flat.handle).type.toBeCallableWith(multiple)
    expect(flat.handle).type.toBeCallableWith(always)
    expect(flat.handle).type.toBeCallableWith(onDone)
    expect(flat.handle).type.not.toBeCallableWith(undeclared)
    expect(flat.handle).type.not.toBeCallableWith(partiallyUndeclared)
    expect(flat.handle).type.not.toBeCallableWith(undeclaredAlways)
    expect(flat.handle).type.not.toBeCallableWith(undeclaredOnDone)
  })
})
