import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
class Closed extends Schema.TaggedClass<Closed>("InitialTypeClosed")("Closed", {}) {}
class Opened extends Schema.TaggedClass<Opened>("InitialTypeOpened")("Opened", { id: Schema.String }) {}
class Idle extends Schema.TaggedClass<Idle>("InitialTypeIdle")("Idle", { count: Schema.Number }) {}
class Loading extends Schema.TaggedClass<Loading>("InitialTypeLoading")("Loading", {}) {}
class Open extends Schema.TaggedClass<Open>("InitialTypeOpen")("Open", {}) {}
const States = Machine.state({
  states: {
    closed: Closed,
    opened: {
      schema: Opened,
      states: { idle: Idle, loading: Loading }
    }
  }
})
const targets1 = Machine.targets(States)
const base = Machine.make({
  branches: {
    transition3: { destination: { target: targets1.root.opened } },
    transition4: { destination: { target: targets1.root.opened } }
  },
  root: States,
  events: Machine.eventsFromSchemas(Open)
})
describe("declared initial entry types", () => {
  it("requires data for non-defaultable initial children", () => {
    expect(base.handle).type.not.toBeCallableWith({
      initial: { target: targets1.root.closed },
      states: { opened: { initial: { target: targets1.root.opened.idle } } }
    })
    base.handle({
      initial: {
        target: Machine.targets(States).root.closed,
        decoded: true,
        data: new Closed({})
      },
      states: {
        closed: {
          on: {
            Open: { target: targets1.root.opened, decoded: true, data: () => (new Opened({ id: "team-1" })) }
          }
        },
        opened: {
          initial: {
            target: Machine.targets(States).root.opened.idle,
            data: { count: 0 }
          },
          states: {
            idle: {},
            loading: {}
          }
        }
      }
    })
    base.handle({
      initial: {
        target: Machine.targets(States).root.closed,
        decoded: true,
        data: new Closed({})
      },
      states: {
        closed: {
          on: {
            Open: { target: targets1.root.opened, data: () => ({ id: "team-1" }) }
          }
        },
        opened: {
          initial: {
            target: Machine.targets(States).root.opened.idle,
            data: ({}) => ({ count: 0 })
          },
          states: {
            idle: {},
            loading: {}
          }
        }
      }
    })
    base.handle({
      initial: {
        target: Machine.targets(States).root.closed,
        decoded: true,
        data: new Closed({})
      },
      states: {
        closed: {
          on: {
            Open: {
              branches: "transition3",
              resolve: ({ select: { destination: target } }) =>
                target({
                  data: new Opened({ id: "team-1" }),
                  decoded: true,
                  states: { loading: { data: new Loading({}), decoded: true } }
                })
            }
          }
        },
        opened: {
          initial: {
            target: Machine.targets(States).root.opened.idle,
            data: { count: 0 }
          },
          states: {
            idle: {},
            loading: {}
          }
        }
      }
    })
  })
  it("only exposes initial on compound and parallel state builders", () => {
    base.handle({
      initial: {
        target: Machine.targets(States).root.closed,
        decoded: true,
        data: new Closed({})
      },
      states: {
        closed: {
          on: {
            Open: {
              branches: "transition4",
              resolve: ({ select: { destination: target } }) => {
                expect(target).type.not.toBeCallableWith()
                expect(target).type.not.toHaveProperty("initial")
                expect(target).type.not.toBeCallableWith({ decoded: true })
                expect(target).type.toBeCallableWith({ data: new Opened({ id: "team-1" }), decoded: true })
                expect(target).type.toBeCallableWith({ data: { id: "team-1" } })
                return target({
                  data: new Opened({ id: "team-1" }),
                  decoded: true,
                  states: { loading: { data: new Loading({}), decoded: true } }
                })
              }
            }
          }
        },
        opened: {
          initial: {
            target: Machine.targets(States).root.opened.idle,
            data: { count: 0 }
          },
          states: {
            idle: {},
            loading: {}
          }
        }
      }
    })
  })
})
