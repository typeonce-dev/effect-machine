import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
class Left extends Schema.TaggedClass<Left>("Left")("Left", {}) {}
class LeftIdle extends Schema.TaggedClass<LeftIdle>("LeftIdle")("LeftIdle", {}) {}
class LeftDone extends Schema.TaggedClass<LeftDone>("LeftDone")("LeftDone", {}) {}
class Right extends Schema.TaggedClass<Right>("Right")("Right", {}) {}
class RightIdle extends Schema.TaggedClass<RightIdle>("RightIdle")("RightIdle", {}) {}
class Advance extends Schema.TaggedClass<Advance>("Advance")("Advance", {}) {}

const States = Machine.state({
  initial: "Root",
  states: {
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
  }
})

describe("Machine transition snapshot context", () => {
  it("infers the complete machine snapshot for event, always, and onDone handlers", () => {
    const targets1 = Machine.targets(States)
    Machine.make({
      branches: {
        transition1: { destination: { target: targets1.root.Root.Left.LeftIdle } },
        transition2: { destination: { target: targets1.root.Root.Left.LeftDone } }
      },

      root: States,
      events: Machine.eventsFromSchemas(Advance),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => (target.from((to) =>
          to.Root.decoded(new Root({}), (root) =>
            root
              .Left.decoded(new Left({}), (left) => left.LeftIdle.decoded(new LeftIdle({})))
              .Right.decoded(new Right({}), (right) => right.RightIdle.decoded(new RightIdle({}))))
        )))
    }).handle({
      states: {
        Root: {
          states: {
            Left: {
              onDone: {
                branches: "transition1",
                resolve: ({ snapshot, select: { destination: target } }) => {
                  expect(snapshot).type.toBe<Machine.Snapshot<typeof States>>()
                  expect(States.matches).type.toBeCallableWith(snapshot, "Root.Right.RightIdle")
                  expect(States.get).type.toBeCallableWith(snapshot, "Root.Right.RightIdle")
                  expect(States.getSnapshot).type.toBeCallableWith(snapshot, "Root.Right.RightIdle")
                  return target.decoded(new LeftIdle({}))
                }
              },
              states: {
                LeftIdle: {
                  always: {
                    none: true,
                    resolve: ({ snapshot }) => {
                      expect(snapshot).type.toBe<Machine.Snapshot<typeof States>>()
                      return undefined
                    }
                  },
                  on: {
                    Advance: {
                      branches: "transition2",
                      resolve: ({ snapshot, select: { destination: target } }) => {
                        expect(snapshot).type.toBe<Machine.Snapshot<typeof States>>()
                        expect(States.matches(snapshot, "Root.Right.RightIdle")).type.toBe<boolean>()
                        return target.decoded(new LeftDone({}))
                      }
                    }
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
    const choiceStates = Machine.state({
      initial: "Flow",
      states: {
        Flow: {
          schema: Flow,
          initial: "Routing",
          states: {
            Routing: { type: "choice" },
            Active
          }
        }
      }
    })
    const targets2 = Machine.targets(choiceStates)
    Machine.make({
      branches: { transition1: { destination: { target: targets2.root.Flow.Active } } },

      root: choiceStates,
      events: Machine.eventsFromSchemas(),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => (target.from((to) => to.Flow.decoded(new Flow({}), (flow) => flow.Routing()))))
    }).handle({
      states: {
        Flow: {
          entry: (context) => {
            expect(context).type.not.toHaveProperty("snapshot")
          },
          states: {
            Routing: {
              choice: {
                branches: "transition1",
                resolve: (context) => {
                  expect(context).type.not.toHaveProperty("snapshot")
                  return context.select.destination.decoded(new Active({}))
                }
              }
            }
          }
        }
      }
    })
  })
})
