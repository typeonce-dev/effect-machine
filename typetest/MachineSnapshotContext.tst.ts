import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../src/index.js"

class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
class Left extends Schema.TaggedClass<Left>("Left")("Left", {}) {}
class LeftIdle extends Schema.TaggedClass<LeftIdle>("LeftIdle")("LeftIdle", {}) {}
class LeftDone extends Schema.TaggedClass<LeftDone>("LeftDone")("LeftDone", {}) {}
class Right extends Schema.TaggedClass<Right>("Right")("Right", {}) {}
class RightIdle extends Schema.TaggedClass<RightIdle>("RightIdle")("RightIdle", {}) {}
class Advance extends Schema.TaggedClass<Advance>("Advance")("Advance", {}) {}

const States = Machine.defineStates({
  Root: {
    schema: Root,
    type: "parallel",
    states: {
      Left: {
        schema: Left,
        initial: "LeftIdle",
        states: {
          LeftIdle,
          LeftDone: { schema: LeftDone, type: "final" }
        }
      },
      Right: {
        schema: Right,
        initial: "RightIdle",
        states: { RightIdle }
      }
    }
  }
})

describe("Machine transition snapshot context", () => {
  it("infers the complete machine snapshot for event, always, and onDone handlers", () => {
    Machine.make({
      states: States.states,
      events: [Advance],
      initial: () =>
        States.initial.Root(
          new Root({}),
          (root) =>
            root
              .Left(new Left({}), (left) => left.LeftIdle(new LeftIdle({})))
              .Right(new Right({}), (right) => right.RightIdle(new RightIdle({})))
        )
    }).handle({
      Root: {
        states: {
          Left: {
            onDone: ({ snapshot, target }) => {
              expect(snapshot).type.toBe<Machine.Machine.Snapshot<typeof States.states>>()
              expect(States.matches).type.toBeCallableWith(snapshot, "Root.Right.RightIdle")
              expect(States.get).type.toBeCallableWith(snapshot, "Root.Right.RightIdle")
              expect(States.getSnapshot).type.toBeCallableWith(snapshot, "Root.Right.RightIdle")
              return target.local.LeftIdle(new LeftIdle({}))
            },
            states: {
              LeftIdle: {
                always: ({ snapshot }) => {
                  expect(snapshot).type.toBe<Machine.Machine.Snapshot<typeof States.states>>()
                  return undefined
                },
                on: {
                  Advance: ({ snapshot, target }) => {
                    expect(snapshot).type.toBe<Machine.Machine.Snapshot<typeof States.states>>()
                    expect(States.matches(snapshot, "Root.Right.RightIdle")).type.toBe<boolean>()
                    return target.local.LeftDone(new LeftDone({}))
                  }
                }
              }
            }
          }
        }
      }
    })
  })

  it("does not expose a fabricated snapshot to choices or state actions", () => {
    class Flow extends Schema.TaggedClass<Flow>("Flow")("Flow", {}) {}
    class Active extends Schema.TaggedClass<Active>("Active")("Active", {}) {}
    const choiceStates = Machine.defineStates({
      Flow: {
        schema: Flow,
        initial: "Routing",
        states: {
          Routing: { type: "choice" },
          Active
        }
      }
    })
    Machine.make({
      states: choiceStates.states,
      events: [],
      initial: () => choiceStates.initial.Flow(new Flow({}), (flow) => flow.Routing())
    }).handle({
      Flow: {
        entry: (context) => {
          expect(context).type.not.toHaveProperty("snapshot")
        },
        states: {
          Routing: {
            choice: {
              targets: ["Flow.Active"],
              transition: (context) => {
                expect(context).type.not.toHaveProperty("snapshot")
                return context.target.local.Active(new Active({}))
              }
            }
          }
        }
      }
    })
  })
})
