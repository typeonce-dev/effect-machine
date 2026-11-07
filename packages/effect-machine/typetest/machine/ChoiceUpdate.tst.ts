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
    events: Events
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
              update: {
                root: ({ root }) => {
                  expect(root.count).type.toBe<number>()
                  return { count: root.count + 1 }
                }
              }
            }
          }
        },
        Route: {
          choice: {
            branches: [{ target: "Low" }, { target: "High" }],
            resolve: ({ containingState, select }) =>
              containingState.count > 0 ? select.target("High") : select.target("Low")
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
        Idle: {
          on: {
            Bump: { target: "Route", update: { root: { decoded: true, data: ({ root }) => root } } }
          }
        },
        Route: {
          choice: {
            branches: [{ target: "Low" }, { target: "High" }],
            resolve: ({ containingState, select }) =>
              containingState.count > 0 ? select.target("High") : select.target("Low")
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
            branches: [{ target: "Low" }, { target: "High" }],
            resolve: ({ containingState, select }) =>
              containingState.count > 0 ? select.target("High") : select.target("Low")
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
        Idle: { on: { Bump: { target: "Route", data: { count: 1 }, update: { root: { count: 1 } } } } },
        Route: {
          choice: {
            branches: [{ target: "Low" }, { target: "High" }],
            resolve: ({ containingState, select }) =>
              containingState.count > 0 ? select.target("High") : select.target("Low")
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
        Idle: { on: { Bump: { target: "Missing", update: { root: { count: 1 } } } } },
        Route: {
          choice: {
            branches: [{ target: "Low" }, { target: "High" }],
            resolve: ({ containingState, select }) =>
              containingState.count > 0 ? select.target("High") : select.target("Low")
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
              branches: [{ target: "Route", update: "root" }],
              resolve: ({ root, select }) => {
                expect(select.target).type.not.toBeCallableWith("Route", { data: { count: 1 } })
                expect(select.target).type.not.toBeCallableWith("Route", {
                  data: { count: 1 },
                  update: { root: { count: 1 } }
                })
                return select.target("Route", { update: { root: { count: root.count + 1 } } })
              }
            }
          }
        },
        Route: {
          choice: {
            branches: [{ target: "Low" }, { target: "High" }],
            resolve: ({ containingState, select }) =>
              containingState.count > 0 ? select.target("High") : select.target("Low")
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
    events: NestedEvents
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
                  update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 }) }
                }
              }
            },
            First: {
              choice: { branches: [{ target: "Flow.Second" }], resolve: ({ select }) => select.target("Flow.Second") }
            },
            Second: {
              choice: {
                branches: [{ target: "Flow.Even" }, { target: "Flow.Odd" }],
                resolve: ({ containingState, select }) =>
                  containingState.count > 0 ? select.target("Flow.Even") : select.target("Flow.Odd")
              }
            },
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
                  update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 }) }
                }
              }
            },
            First: {
              choice: { branches: [{ target: "Flow.Second" }], resolve: ({ select }) => select.target("Flow.Second") }
            },
            Second: {
              choice: {
                branches: [{ target: "Flow.Even" }, { target: "Outside" }],
                resolve: ({ containingState, select }) =>
                  containingState.count > 0 ? select.target("Flow.Even") : select.target("Outside")
              }
            },
            Even: {},
            Odd: {},
            Done: {}
          }
        },
        Outside: {}
      }
    })).type.toRaiseError(
      "targets 'Outside' outside the updated owner 'Flow'"
    )
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
                  update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 }) }
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
                  branches: [{ target: "Flow.First", update: "Flow" }],
                  resolve: ({ ancestors, select }) => select.target("Flow.First", { update: { Flow: ancestors.Flow } })
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
                onDone: { target: "Flow.First", update: { Flow: ({ output }) => ({ count: output }) } }
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
            states: { Idle: { on: { Bump: { target: "Route", update: { Flow: { count: 1 } } } } } }
          },
          Route: { choice: { target: "Outside" } },
          Outside: {}
        }
      })
    ).type.toRaiseError()
  })
})
