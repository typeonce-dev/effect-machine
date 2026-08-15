import { Context, Data, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Flow extends Schema.TaggedClass<Flow>("Flow")("Flow", { score: Schema.Number }) {}
class Approved extends Schema.TaggedClass<Approved>("Approved")("Approved", {}) {}
class Rejected extends Schema.TaggedClass<Rejected>("Rejected")("Rejected", {}) {}

const States = Machine.defineStates({
  Flow: {
    schema: Flow,
    initial: "Routing",
    states: {
      Routing: { type: "choice" },
      Approved,
      Rejected
    }
  }
})

describe("Machine choice pseudo-states", () => {
  it("separates active, choice, and state-node identifiers", () => {
    expect<Machine.Machine.StateIdentifier<typeof States.states>>().type.toBe<
      "Flow" | "Flow.Approved" | "Flow.Rejected"
    >()
    expect<Machine.Machine.ChoiceIdentifier<typeof States.states>>().type.toBe<"Flow.Routing">()
    expect<Machine.Machine.StateNodeIdentifier<typeof States.states>>().type.toBe<
      "Flow" | "Flow.Routing" | "Flow.Approved" | "Flow.Rejected"
    >()
    expect<Machine.Machine.Snapshot<typeof States.states>["path"]>().type.not.toBe<"Flow.Routing">()
  })

  it("exposes only choice context and requires implementation before planning", () => {
    const incomplete = Machine.make({
      states: States.states,
      events: Machine.events(),
      initial: () => States.initial.Flow(new Flow({ score: 80 }), (flow) => flow.Routing())
    })
    expect(Machine.planInitial).type.not.toBeCallableWith(incomplete)
    const complete = incomplete.handle({
      Flow: {
        states: {
          Routing: {
            choice: {
              targets: ["Flow.Approved", "Flow.Rejected"],
              transition: (context) => {
                expect(context).type.not.toHaveProperty("state")
                expect(context.parent).type.toBe<Flow>()
                expect(context.parents.Flow).type.toBe<Flow>()
                expect(context.event).type.toBe<Machine.Machine.LifecycleEvent<readonly []>>()
                return context.target.local.Approved(new Approved({}))
              }
            }
          }
        }
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)
  })

  it("rejects Effects returned by choice resolvers", () => {
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(),
      initial: () => States.initial.Flow(new Flow({ score: 80 }), (flow) => flow.Routing())
    })
    expect(machine.handle).type.not.toBeCallableWith({
      Flow: {
        states: {
          Routing: {
            choice: {
              targets: ["Flow.Approved"],
              transition: ({ target }: Machine.Machine.ChoiceContext<
                typeof States.states,
                readonly [],
                readonly [],
                "Flow.Routing"
              >) => Effect.succeed(target.local.Approved(new Approved({})))
            }
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
      expect(Machine.defineStates).type.not.toBeCallableWith({
        Flow: {
          schema: Flow,
          initial: "Approved",
          states: { Approved, choice }
        }
      })
    }

    const base = Machine.make({
      states: States.states,
      events: Machine.events(),
      initial: () => States.initial.Flow(new Flow({ score: 80 }), (flow) => flow.Routing())
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
      expect(base.handle).type.not.toBeCallableWith({ Flow: { states: { Routing: invalid } } })
    }
  })

  it("rejects void and undeclared choice results", () => {
    const base = Machine.make({
      states: States.states,
      events: Machine.events(),
      initial: () => States.initial.Flow(new Flow({ score: 80 }), (flow) => flow.Routing())
    })
    expect(base.handle).type.not.toBeCallableWith({
      Flow: {
        states: {
          Routing: { choice: { targets: ["Flow.Approved"], transition: () => undefined } }
        }
      }
    })
    expect(base.handle).type.not.toBeCallableWith({
      Flow: {
        states: {
          Routing: {
            choice: {
              targets: ["Flow.Approved"],
              transition: (
                { target }: Machine.Machine.ChoiceContext<
                  typeof States.states,
                  readonly [],
                  readonly [],
                  "Flow.Routing"
                >
              ) => target.local.Rejected(new Rejected({}))
            }
          }
        }
      }
    })
  })
})
