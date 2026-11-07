import { Context, Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
class Database extends Context.Service<Database, {
  readonly count: number
}>()("test/Database") {
}
class Unused extends Context.Service<Unused, {
  readonly value: string
}>()("test/Unused") {
}
class LoadError extends Schema.TaggedClass<LoadError>("LoadError")("LoadError", { message: Schema.String }) {}
const root = Machine.state({
  fields: { revision: Schema.Number },
  states: {
    Idle: {},
    Ready: { fields: { count: Schema.Number } },
    Failed: { fields: { message: Schema.String } },
    Nested: {
      fields: { name: Schema.String },
      states: { Child: { fields: { count: Schema.Number } } }
    }
  }
})
const definition = Machine.make({
  root,
  events: Machine.events({ Load: { count: Schema.Number }, Reset: {} }),
  effects: {
    direct: Effect.succeed(1),
    never: Effect.never,
    empty: Effect.void,
    failed: Effect.fail(new LoadError({ message: "failed" })),
    load: (offset: number) => Effect.map(Database, (db) => db.count + offset),
    unused: Unused
  },
  streams: { values: Stream.make(1, 2), emptyStream: Stream.empty },
  timers: { timeout: "1 second" }
})
describe("declarative inference", () => {
  it("rejects ambiguous source inputs and non-topological branch fields", () => {
    expect(Machine.make).type.not.toBeCallableWith({
      root,
      events: definition.events,
      effects: { invalid: () => Effect.void }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root,
      events: definition.events,
      streams: { invalid: (_input?: number) => Stream.empty }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root,
      events: definition.events,
      effects: { same: Effect.void },
      timers: { same: "1 second" }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root,
      events: definition.events,
      branches: { bad: { "0": { target: "Ready" } } }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root,
      events: definition.events,
      branches: { bad: { ready: { target: "Ready", resolve: () => undefined } } }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root,
      events: definition.events,
      branches: { bad: { ready: { target: "Ready", title: "" } } }
    })
  })
  it("infers events and root data for inline construction", () => {
    definition.handle({
      initial: {
        target: "Idle"
      },
      root: () => ({ revision: 0 }),
      states: {
        Idle: {
          on: {
            Load: {
              target: "Ready",
              data: ({ event, root, state }) => {
                expect(event.count).type.toBe<number>()
                expect(root.revision).type.toBe<number>()
                expect(state).type.toBe<undefined>()
                return { count: event.count }
              }
            }
          }
        },
        Ready: {},
        Failed: {},
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { Child: {} }
        }
      }
    })
    expect(definition.handle).type.toBeCallableWith({
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" },
      states: {
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { on: { Load: { target: "Ready" } } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { on: { Load: { target: "Ready", data: () => ({ count: "bad" }) } } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { on: { Load: { target: "Ready", resolve: () => undefined } } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
    expect(definition.handle).type.toBeCallableWith({
      on: { Reset: { initialize: true } },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" },
      states: {
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      on: { Reset: { update: { root: () => ({}) } } },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" },
      states: {
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { on: { Reset: { update: { Ready: () => ({ count: 1 }) } } } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
  })
  it("infers named branch constructors without a second target declaration", () => {
    definition.handle({
      initial: {
        target: "Idle"
      },
      root: () => ({ revision: 0 }),
      states: {
        Idle: {
          on: {
            Load: {
              branches: [{ target: "Ready" }, { target: "Failed" }],
              resolve: ({ event, select }) => {
                expect(select.target).type.toBeCallableWith("Ready", { data: { count: 1 } })
                expect(select.target).type.not.toBeCallableWith("Ready", { data: { message: "wrong branch" } })
                expect(select.target).type.toBeCallableWith("Failed", { data: { message: "failed" } })
                return event.count > 0
                  ? select.target("Ready", { data: { count: event.count } })
                  : select.target("Failed", { data: { message: "zero" } })
              }
            },
            Reset: {
              branches: [{ target: "Nested" }],
              resolve: ({ select }) =>
                select.target("Nested", { data: { name: "nested" }, states: { Child: { data: { count: 1 } } } })
            }
          }
        },
        Ready: {},
        Failed: {},
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { Child: {} }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { on: { Reset: { branches: "missing", resolve: () => undefined } } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
  })
  it("requires exactly the reachable invocation outcomes", () => {
    definition.handle({
      initial: {
        target: "Idle"
      },
      root: () => ({ revision: 0 }),
      states: {
        Idle: {
          invoke: [
            {
              src: "direct",
              onDone: {
                target: "Ready",
                data: ({ output }) => {
                  expect(output).type.toBe<number>()
                  return { count: output }
                }
              }
            },
            { src: "empty", onDone: { stay: true } },
            { src: "never" },
            {
              src: "failed",
              onFailure: {
                target: "Failed",
                data: ({ error }) => {
                  expect(error).type.toBe<LoadError>()
                  return { message: error.message }
                }
              }
            },
            {
              src: "values",
              onElement: {
                stay: true,
                commands: ({ element }) => {
                  expect(element).type.toBe<1 | 2>()
                }
              },
              onDone: { stay: true }
            },
            { src: "timeout", onDone: { stay: true } }
          ]
        },
        Ready: {},
        Failed: {},
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { Child: {} }
        }
      }
    })
    for (const src of ["direct", "empty", "timeout"] as const) {
      expect(definition.handle).type.not.toBeCallableWith({
        states: {
          Idle: { invoke: { src } },
          Nested: {
            initial: {
              target: "Nested.Child",
              data: () => {
                throw new Error("type-only constructor")
              }
            }
          }
        },
        root: () => {
          throw new Error("type-only constructor")
        },
        initial: { target: "Idle" }
      })
    }
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "failed" } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "direct", onDone: { stay: true }, onFailure: { stay: true } } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "never", onDone: { stay: true } } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "values", onDone: { stay: true } } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
  })
  it("requires input only for input-taking programs and carries used dependencies", () => {
    const machine = definition.handle({
      initial: {
        target: "Idle"
      },
      root: () => ({ revision: 0 }),
      states: {
        Idle: {
          invoke: {
            src: "load",
            input: ({ root }) => root.revision,
            onDone: { target: "Ready", data: ({ output }) => ({ count: output }) }
          }
        },
        Ready: {},
        Failed: {},
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { Child: {} }
        }
      }
    })
    expect<Extract<Machine.Machine.Services<typeof machine>, Database>>().type.toBe<Database>()
    expect<Extract<Machine.Machine.Services<typeof machine>, Unused>>().type.toBe<never>()
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "load", onDone: { stay: true } } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "load", input: () => "bad", onDone: { stay: true } } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "direct", input: () => 1, onDone: { stay: true } } },
        Nested: {
          initial: {
            target: "Nested.Child",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: "Idle" }
    })
  })
})
