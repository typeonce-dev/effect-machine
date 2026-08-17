import { Context, Data, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Flow extends Schema.TaggedClass<Flow>("Flow")("Flow", { score: Schema.Number }) {}
class Approved extends Schema.TaggedClass<Approved>("Approved")("Approved", {}) {}
class Rejected extends Schema.TaggedClass<Rejected>("Rejected")("Rejected", {}) {}

const States = Machine.states({
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
      initial: {
        target: (to) => to.Flow.initial(),
        resolve: ({ target }) => (target(new Flow({ score: 80 }), (flow) => flow.Routing()))
      }
    })
    expect(Machine.planInitial).type.not.toBeCallableWith(incomplete)
    const complete = incomplete.handle({
      Flow: {
        states: {
          Routing: {
            choice: Machine.transition({
              target: (to) => to.local.Approved(),
              resolve: (context) => {
                expect(context).type.not.toHaveProperty("state")
                expect(context.containingState).type.toBe<Flow>()
                expect(context.ancestors.Flow).type.toBe<Flow>()
                expect(context.event).type.toBe<Machine.Machine.LifecycleEvent<readonly []>>()
                return context.target(new Approved({}))
              }
            })
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
      initial: {
        target: (to) => to.Flow.initial(),
        resolve: ({ target }) => (target(new Flow({ score: 80 }), (flow) => flow.Routing()))
      }
    })
    const target = (to: Machine.Machine.TargetSelector<typeof States.states, "Flow.Routing">) => to.local.Approved()
    expect(Machine.transition).type.not.toBeCallableWith({
      target,
      resolve: (
        { target: selectedTarget }: Machine.Machine.TransitionResolveContext<
          Machine.Machine.ChoiceContext<typeof States.states, readonly [], readonly [], "Flow.Routing">,
          ReturnType<typeof target>
        >
      ) => Effect.succeed(selectedTarget(new Approved({})))
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
      expect(Machine.states).type.not.toBeCallableWith({
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
      initial: {
        target: (to) => to.Flow.initial(),
        resolve: ({ target }) => (target(new Flow({ score: 80 }), (flow) => flow.Routing()))
      }
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

  it("requires Machine.transition and validates the selected result", () => {
    const base = Machine.make({
      states: States.states,
      events: Machine.events(),
      initial: {
        target: (to) => to.Flow.initial(),
        resolve: ({ target }) => (target(new Flow({ score: 80 }), (flow) => flow.Routing()))
      }
    })
    const target = (to: Machine.Machine.TargetSelector<typeof States.states, "Flow.Routing">) => to.local.Rejected()
    base.handle({
      Flow: {
        states: {
          Routing: {
            choice: Machine.transition({
              target,
              resolve: ({ target: selectedTarget }) => {
                expect(selectedTarget).type.not.toBeCallableWith(new Approved({}))
                return selectedTarget(new Rejected({}))
              }
            })
          }
        }
      }
    })
    expect(base.handle).type.not.toBeCallableWith({
      Flow: {
        states: {
          Routing: { choice: () => undefined }
        }
      }
    })
  })
})
