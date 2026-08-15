import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

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
    events: Machine.events(Reset),
    initial: () => initial
  }).handle({
    root: {
      on: {
        Reset: () => undefined
      }
    }
  })

  it("preserves state paths for structural inspection", () => {
    const nodes = Machine.stateNodes(machine)
    expect(nodes[0]!.path).type.toBe<"root" | "root.idle" | "root.recent">()
    expect(nodes.find((node) => node.type === "history")!.path).type.toBe<"root.recent">()
    expect(nodes.find((node) => node.type === "history")!.parent).type.toBe<"root" | "root.idle">()
    expect(nodes.find((node) => node.type === "atomic")!.path).type.toBe<"root" | "root.idle">()
    expect(Machine.configuration(machine, initial)[0]!.path).type.toBe<"root" | "root.idle">()
  })

  it("narrows every compiled state-node property from its type", () => {
    const inspect = (node: Machine.Machine.StateNode<"state">) => {
      switch (node.type) {
        case "atomic":
          expect(node.schema).type.toBe<Machine.Machine.TaggedSchema | undefined>()
          expect(node.output).type.toBe<undefined>()
          expect(node.history).type.toBe<undefined>()
          expect(node.children).type.toBe<readonly []>()
          expect(node.initial).type.toBe<undefined>()
          expect(node.parent).type.toBe<"state" | undefined>()
          break
        case "compound":
          expect(node.schema).type.toBe<Machine.Machine.TaggedSchema | undefined>()
          expect(node.output).type.toBe<undefined>()
          expect(node.history).type.toBe<undefined>()
          expect(node.children).type.toBe<ReadonlyArray<"state">>()
          expect(node.initial).type.toBe<"state">()
          expect(node.parent).type.toBe<"state" | undefined>()
          break
        case "parallel":
          expect(node.schema).type.toBe<Machine.Machine.TaggedSchema | undefined>()
          expect(node.output).type.toBe<Schema.Top | undefined>()
          expect(node.history).type.toBe<undefined>()
          expect(node.children).type.toBe<ReadonlyArray<"state">>()
          expect(node.initial).type.toBe<undefined>()
          expect(node.parent).type.toBe<"state" | undefined>()
          break
        case "final":
          expect(node.schema).type.toBe<Machine.Machine.TaggedSchema | undefined>()
          expect(node.output).type.toBe<Schema.Top | undefined>()
          expect(node.history).type.toBe<undefined>()
          expect(node.children).type.toBe<readonly []>()
          expect(node.initial).type.toBe<undefined>()
          expect(node.parent).type.toBe<"state" | undefined>()
          break
        case "history":
          expect(node.schema).type.toBe<undefined>()
          expect(node.output).type.toBe<undefined>()
          expect(node.history).type.toBe<"shallow" | "deep">()
          expect(node.children).type.toBe<readonly []>()
          expect(node.initial).type.toBe<undefined>()
          expect(node.parent).type.toBe<"state">()
          break
        case "choice":
          expect(node.schema).type.toBe<undefined>()
          expect(node.output).type.toBe<undefined>()
          expect(node.history).type.toBe<undefined>()
          expect(node.children).type.toBe<readonly []>()
          expect(node.initial).type.toBe<undefined>()
          expect(node.parent).type.toBe<"state">()
          break
        default:
          expect(node).type.toBe<never>()
      }
    }

    expect(inspect).type.toBe<(node: Machine.Machine.StateNode<"state">) => void>()
  })

  it("keeps choice initial paths while configuration remains active-only", () => {
    const ChoiceStates = Machine.defineStates({
      Flow: {
        schema: Root,
        initial: "Routing",
        states: {
          Routing: { type: "choice" },
          Ready: Idle
        }
      }
    })
    const choiceMachine = Machine.make({
      states: ChoiceStates.states,
      events: Machine.events(),
      initial: () => ChoiceStates.initial.Flow(new Root({}), (flow) => flow.Routing())
    })
    const flow = Machine.stateNodes(choiceMachine).find((node) => node.type === "compound")!
    const routing = Machine.stateNodes(choiceMachine).find((node) => node.type === "choice")!

    expect(flow.path).type.toBe<"Flow" | "Flow.Ready">()
    expect(flow.initial).type.toBe<"Flow" | "Flow.Ready" | "Flow.Routing">()
    expect<"Flow.Routing">().type.toBeAssignableTo<typeof flow.initial>()
    expect(routing.path).type.toBe<"Flow.Routing">()
    expect(routing.parent).type.toBe<"Flow" | "Flow.Ready">()

    const settled: Machine.Machine.Snapshot<typeof ChoiceStates.states> = {
      path: "Flow",
      value: new Root({}),
      state: { path: "Flow.Ready", value: new Idle({}) }
    }
    const configuration = Machine.configuration(choiceMachine, settled)
    expect<(typeof configuration)[number]["path"]>().type.toBe<"Flow" | "Flow.Ready">()
    expect<(typeof configuration)[number]["type"]>().type.toBe<"atomic" | "compound" | "parallel" | "final">()
    expect<Extract<(typeof configuration)[number], { readonly type: "history" | "choice" }>>().type.toBe<never>()
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
      events: Machine.events(Reset),
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
    expect(flat.handle).type.not.toBeCallableWith(effectful)
    expect(flat.handle).type.toBeCallableWith(constructed)
    expect(flat.handle).type.toBeCallableWith(multiple)
    expect(flat.handle).type.toBeCallableWith(always)
    expect(flat.handle).type.not.toBeCallableWith(onDone)
    expect(flat.handle).type.not.toBeCallableWith(undeclared)
    expect(flat.handle).type.not.toBeCallableWith(partiallyUndeclared)
    expect(flat.handle).type.not.toBeCallableWith(undeclaredAlways)
    expect(flat.handle).type.not.toBeCallableWith(undeclaredOnDone)
  })
})
