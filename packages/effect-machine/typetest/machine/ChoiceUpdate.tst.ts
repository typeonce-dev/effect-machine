import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

const States = Machine.state({
  fields: { count: Schema.Number },
  states: { Idle: {}, Route: { type: "choice" }, Low: {}, High: {} }
})
const Events = Machine.events({ Bump: {} })

const Nested = Machine.state({
  states: {
    Flow: {
      fields: { count: Schema.Number },
      states: { Idle: {}, First: { type: "choice" }, Second: { type: "choice" }, Even: {}, Odd: {}, Done: {} }
    },
    Outside: {}
  }
})
const NestedEvents = Machine.events({ Bump: {} })

describe("Machine target and update into a choice", () => {
  const definition = Machine.make({
    root: States,
    events: Events,
    branches: {
      route: { low: { target: "Low" }, high: { target: "High" } },
      bump: { toRoute: { target: "Route", update: "root" } }
    }
  })

  it("updates the owner while entering a choice with owner construction data", () => {
    const machine = definition.handle({
      root: { count: 0 },
      initial: { target: "Idle" },
      states: {
        Idle: {
          on: {
            Bump: {
              target: "Route",
              update: "root",
              data: ({ root }) => {
                expect(root.count).type.toBe<number>()
                return { count: root.count + 1 }
              }
            }
          }
        },
        Route: {
          choice: {
            branches: "route",
            resolve: ({ containingState, select }) => containingState.count > 0 ? select.high() : select.low()
          }
        },
        Low: {},
        High: {}
      }
    })
    expect(Machine.planInitial(machine)).type.toBeAssignableTo<Effect.Effect<unknown, unknown>>()
    expect(definition.handle({
      root: { count: 0 },
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Bump: { target: "Route", update: "root", decoded: true, data: ({ root }) => root } } },
        Route: {
          choice: {
            branches: "route",
            resolve: ({ containingState, select }) => containingState.count > 0 ? select.high() : select.low()
          }
        },
        Low: {},
        High: {}
      }
    })).type.not.toRaiseError()
  })

  it("requires owner data and rejects choice data", () => {
    expect(definition.handle({
      root: { count: 0 },
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Bump: { target: "Route", update: "root" } } },
        Route: {
          choice: {
            branches: "route",
            resolve: ({ containingState, select }) => containingState.count > 0 ? select.high() : select.low()
          }
        },
        Low: {},
        High: {}
      }
    })).type.toRaiseError()
    expect(definition.handle({
      root: { count: 0 },
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Bump: { target: "Route", update: "root", data: { target: undefined, update: { count: 1 } } } } },
        Route: {
          choice: {
            branches: "route",
            resolve: ({ containingState, select }) => containingState.count > 0 ? select.high() : select.low()
          }
        },
        Low: {},
        High: {}
      }
    })).type.toRaiseError()
  })

  it("rejects destinations that are neither states nor choices", () => {
    expect(definition.handle({
      root: { count: 0 },
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Bump: { target: "Missing", update: "root", data: { count: 1 } } } },
        Route: {
          choice: {
            branches: "route",
            resolve: ({ containingState, select }) => containingState.count > 0 ? select.high() : select.low()
          }
        },
        Low: {},
        High: {}
      }
    })).type.toRaiseError()
  })

  it("constructs only the owner update from a declared branch", () => {
    definition.handle({
      root: { count: 0 },
      initial: { target: "Idle" },
      states: {
        Idle: {
          on: {
            Bump: {
              branches: "bump",
              resolve: ({ root, select }) => {
                expect(select.toRoute).type.not.toBeCallableWith()
                expect(select.toRoute).type.not.toBeCallableWith({ data: { count: 1 }, update: { data: { count: 1 } } })
                return select.toRoute({ update: { data: { count: root.count + 1 } } })
              }
            }
          }
        },
        Route: {
          choice: {
            branches: "route",
            resolve: ({ containingState, select }) => containingState.count > 0 ? select.high() : select.low()
          }
        },
        Low: {},
        High: {}
      }
    })
  })
})

describe("choice branches entered with an owner update", () => {
  const definition = Machine.make({
    root: Nested,
    events: NestedEvents,
    branches: {
      first: { next: { target: "Flow.Second" } },
      contained: { even: { target: "Flow.Even" }, odd: { target: "Flow.Odd" } },
      escaping: { even: { target: "Flow.Even" }, out: { target: "Outside" } },
      bump: { toFirst: { target: "Flow.First", update: "Flow" } }
    }
  })

  it("accepts nested choices whose reachable branches stay below the owner", () => {
    expect(definition.handle({
      initial: { target: "Flow", data: { count: 0 } },
      states: {
        Flow: {
          initial: { target: "Flow.Idle" },
          states: {
            Idle: {
              on: {
                Bump: {
                  target: "Flow.First",
                  update: "Flow",
                  data: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 })
                }
              }
            },
            First: { choice: { branches: "first", resolve: ({ select }) => select.next() } },
            Second: { choice: { branches: "contained", resolve: ({ select }) => select.even() } },
            Even: {},
            Odd: {},
            Done: {}
          }
        },
        Outside: {}
      }
    })).type.not.toRaiseError()
  })

  it("names the nested choice branch that leaves the owner", () => {
    expect(definition.handle({
      initial: { target: "Flow", data: { count: 0 } },
      states: {
        Flow: {
          initial: { target: "Flow.Idle" },
          states: {
            Idle: {
              on: {
                Bump: {
                  target: "Flow.First",
                  update: "Flow",
                  data: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 })
                }
              }
            },
            First: { choice: { branches: "first", resolve: ({ select }) => select.next() } },
            Second: { choice: { branches: "escaping", resolve: ({ select }) => select.even() } },
            Even: {},
            Odd: {},
            Done: {}
          }
        },
        Outside: {}
      }
    })).type.toRaiseError("Choice 'Flow.Second' branch 'out' targets 'Outside' outside the updated owner 'Flow'")
  })

  it("checks direct choice transitions, declared branches, and invocation outcomes", () => {
    expect(definition.handle({
      initial: { target: "Flow", data: { count: 0 } },
      states: {
        Flow: {
          initial: { target: "Flow.Idle" },
          states: {
            Idle: {
              on: {
                Bump: {
                  target: "Flow.First",
                  update: "Flow",
                  data: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 })
                }
              }
            },
            First: { choice: { target: "Outside" } },
            Second: { choice: { target: "Flow.Even" } },
            Even: {},
            Odd: {},
            Done: {}
          }
        },
        Outside: {}
      }
    })).type.toRaiseError("Choice 'Flow.First' transition targets 'Outside' outside the updated owner 'Flow'")
    expect(definition.handle({
      initial: { target: "Flow", data: { count: 0 } },
      states: {
        Flow: {
          initial: { target: "Flow.Idle" },
          states: {
            Idle: {
              on: {
                Bump: {
                  branches: "bump",
                  resolve: ({ ancestors, select }) => select.toFirst({ update: { data: ancestors.Flow } })
                }
              }
            },
            First: { choice: { target: "Outside" } },
            Second: { choice: { target: "Flow.Even" } },
            Even: {},
            Odd: {},
            Done: {}
          }
        },
        Outside: {}
      }
    })).type.toRaiseError("Choice 'Flow.First' transition targets 'Outside' outside the updated owner 'Flow'")
    const withEffects = Machine.make({
      effects: { load: Effect.succeed(1) },
      root: Nested,
      events: NestedEvents
    })
    expect(withEffects.handle({
      initial: { target: "Flow", data: { count: 0 } },
      states: {
        Flow: {
          initial: { target: "Flow.Idle" },
          states: {
            Idle: {
              invoke: {
                src: "load",
                onDone: { target: "Flow.First", update: "Flow", data: ({ output }) => ({ count: output }) }
              }
            },
            First: { choice: { target: "Outside" } },
            Second: { choice: { target: "Flow.Even" } },
            Even: {},
            Odd: {},
            Done: {}
          }
        },
        Outside: {}
      }
    })).type.toRaiseError("Choice 'Flow.First' transition targets 'Outside' outside the updated owner 'Flow'")
  })

  it("rejects an owner that does not contain the choice as an invalid destination", () => {
    const Sibling = Machine.state({
      states: {
        Flow: { fields: { count: Schema.Number }, states: { Idle: {} } },
        Route: { type: "choice" },
        Outside: {}
      }
    })
    expect(
      Machine.make({ root: Sibling, events: NestedEvents }).handle({
        initial: { target: "Flow", data: { count: 0 } },
        states: {
          Flow: {
            initial: { target: "Flow.Idle" },
            states: { Idle: { on: { Bump: { target: "Route", update: "Flow", data: { count: 1 } } } } }
          },
          Route: { choice: { target: "Outside" } },
          Outside: {}
        }
      })
    ).type.toRaiseError()
  })
})
