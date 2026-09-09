import { Context, Data, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
class Flow extends Schema.TaggedClass<Flow>("Flow")("Flow", { score: Schema.Number }) {}
class Approved extends Schema.TaggedClass<Approved>("Approved")("Approved", {}) {}
class Rejected extends Schema.TaggedClass<Rejected>("Rejected")("Rejected", {}) {}
const States = Machine.state({
  states: {
    Flow: {
      schema: Flow,
      states: {
        Routing: { type: "choice" },
        Approved,
        Rejected
      }
    }
  }
})
describe("Machine choice pseudo-states", () => {
  it("separates active, choice, and state-node identifiers", () => {
    expect<
      Machine.Machine.StateIdentifier<{
        readonly "": typeof States.node
      }>
    >().type.toBe<"" | "Flow" | "Flow.Approved" | "Flow.Rejected">()
    expect<
      Machine.Machine.ChoiceIdentifier<{
        readonly "": typeof States.node
      }>
    >().type.toBe<"Flow.Routing">()
    expect<
      Machine.Machine.StateNodeIdentifier<{
        readonly "": typeof States.node
      }>
    >().type.toBe<"" | "Flow" | "Flow.Routing" | "Flow.Approved" | "Flow.Rejected">()
    expect<Machine.Snapshot<typeof States>["path"]>().type.not.toBe<"Flow.Routing">()
  })
  it("exposes only choice context and requires implementation before planning", () => {
    const targets1 = Machine.targets(States)
    const incomplete = Machine.make({
      branches: { transition1: { destination: { target: targets1.root.Flow.Approved } } },
      root: States,
      events: Machine.eventsFromSchemas()
    })
    expect(Machine.planInitial).type.not.toBeCallableWith(incomplete)
    const complete = incomplete.handle({
      initial: {
        target: Machine.targets(States).root.Flow,
        decoded: true,
        data: new Flow({ score: 80 })
      },
      states: {
        Flow: {
          initial: {
            target: Machine.targets(States).root.Flow.Routing
          },
          states: {
            Routing: {
              choice: {
                branches: "transition1",
                resolve: (context) => {
                  expect(context.select.destination).type.not.toHaveProperty("reenter")
                  expect(context).type.not.toHaveProperty("state")
                  expect(context.containingState).type.toBe<Flow>()
                  expect(context.ancestors.Flow).type.toBe<Flow>()
                  expect(context.event).type.toBe<Machine.Machine.LifecycleEvent<readonly []>>()
                  return context.select.destination.decoded(new Approved({}))
                }
              }
            },
            Approved: {},
            Rejected: {}
          }
        }
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)
  })
  it("rejects Effects returned by choice resolvers", () => {
    const targets2 = Machine.targets(States)
    const machine = Machine.make({
      branches: { transition1: { destination: { target: targets2.root.Flow.Approved } } },
      root: States,
      events: Machine.eventsFromSchemas()
    })
    machine.handle({
      initial: {
        target: Machine.targets(States).root.Flow,
        decoded: true,
        data: new Flow({ score: 80 })
      },
      states: {
        Flow: {
          initial: {
            target: Machine.targets(States).root.Flow.Routing
          },
          states: {
            Routing: {
              choice: {
                branches: "transition1",
                // @ts-expect-error!
                resolve: ({ select: { destination: target } }) => Effect.succeed(target.decoded(new Approved({})))
              }
            },
            Approved: {},
            Rejected: {}
          }
        }
      }
    })
  })
  it("rejects every active definition and handler property", () => {
    const invalidDefinitions = [
      { type: "choice", schema: Approved },
      { type: "choice", initial: "x" },
      { type: "choice", states: { x: Approved } },
      { type: "choice", history: "deep" },
      { type: "choice", output: Schema.String }
    ] as const
    for (const choice of invalidDefinitions) {
      expect(Machine.state).type.not.toBeCallableWith({
        initial: "Flow",
        states: {
          Flow: {
            schema: Flow,
            initial: "Approved",
            states: { Approved, choice }
          }
        }
      })
    }
    const base = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas()
    })
    const invalidHandlers = [
      { entry: () => undefined },
      { exit: () => undefined },
      { invoke: {} },
      { always: () => undefined },
      { on: {} },
      { onDone: () => undefined },
      { output: () => undefined },
      { initial: () => undefined },
      { history: {} },
      { states: {} }
    ] as const
    for (const invalid of invalidHandlers) {
      expect(base.handle).type.toBeCallableWith({
        initial: {
          target: Machine.targets(States).root.Flow,
          data: () => {
            throw new Error("type-only constructor")
          }
        },
        states: {
          Flow: {
            initial: {
              target: Machine.targets(States).root.Flow.Approved,
              data: () => {
                throw new Error("type-only constructor")
              }
            }
          }
        }
      })
      expect(base.handle).type.not.toBeCallableWith({
        states: {
          Flow: {
            states: { Routing: invalid },
            initial: {
              target: Machine.targets(States).root.Flow.Approved,
              data: () => {
                throw new Error("type-only constructor")
              }
            }
          }
        },
        initial: {
          target: Machine.targets(States).root.Flow,
          data: () => {
            throw new Error("type-only constructor")
          }
        }
      })
    }
  })
  it("validates the selected choice result", () => {
    const targets3 = Machine.targets(States)
    const base = Machine.make({
      branches: { transition1: { destination: { target: targets3.root.Flow.Rejected } } },
      root: States,
      events: Machine.eventsFromSchemas()
    })
    base.handle({
      initial: {
        target: Machine.targets(States).root.Flow,
        decoded: true,
        data: new Flow({ score: 80 })
      },
      states: {
        Flow: {
          initial: {
            target: Machine.targets(States).root.Flow.Routing
          },
          states: {
            Routing: {
              choice: {
                branches: "transition1",
                resolve: ({ select: { destination: selectedTarget } }) => {
                  expect(selectedTarget.decoded).type.not.toBeCallableWith(new Approved({}))
                  return selectedTarget.decoded(new Rejected({}))
                }
              }
            },
            Approved: {},
            Rejected: {}
          }
        }
      }
    })
    expect(base.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(States).root.Flow,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        Flow: {
          initial: {
            target: Machine.targets(States).root.Flow.Approved,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(base.handle).type.not.toBeCallableWith({
      states: {
        Flow: {
          states: { Routing: { choice: () => undefined } },
          initial: {
            target: Machine.targets(States).root.Flow.Approved,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: Machine.targets(States).root.Flow,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(base.handle).type.not.toBeCallableWith({
      states: {
        Flow: {
          states: {
            Routing: {
              choice: {
                branches: "transition1",
                declinable: true,
                resolve: () => undefined
              }
            }
          },
          initial: {
            target: Machine.targets(States).root.Flow.Approved,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: Machine.targets(States).root.Flow,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
})
