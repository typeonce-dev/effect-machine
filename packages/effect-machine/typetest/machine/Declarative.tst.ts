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
const targets = Machine.targets(root)
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
  timers: { timeout: "1 second" },
  branches: {
    complete: { ready: { target: targets.root.Ready }, failed: { target: targets.root.Failed } },
    nested: { child: { target: targets.root.Nested } }
  }
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
      branches: { bad: { "0": { target: targets.root.Ready } } }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root,
      events: definition.events,
      branches: { bad: { ready: { target: targets.root.Ready, resolve: () => undefined } } }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root,
      events: definition.events,
      branches: { bad: { ready: { target: targets.root.Ready, title: "" } } }
    })
  })
  it("infers events and root data for inline construction", () => {
    definition.handle({
      initial: {
        target: Machine.targets(root).root.Idle
      },
      root: () => ({ revision: 0 }),
      states: {
        Idle: {
          on: {
            Load: {
              target: targets.root.Ready,
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
            target: Machine.targets(root).root.Nested.Child,
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
      initial: { target: Machine.targets(root).root.Idle },
      states: {
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { on: { Load: { target: targets.root.Ready } } },
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { on: { Load: { target: targets.root.Ready, data: () => ({ count: "bad" }) } } },
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { on: { Load: { target: targets.root.Ready, resolve: () => undefined } } },
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      on: { Reset: { target: targets.root } },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle },
      states: {
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      on: { Reset: { update: targets.root, data: () => ({}) } },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle },
      states: {
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { on: { Reset: { update: targets.root.Ready, data: () => ({ count: 1 }) } } },
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
  })
  it("infers named branch constructors without a second target declaration", () => {
    definition.handle({
      initial: {
        target: Machine.targets(root).root.Idle
      },
      root: () => ({ revision: 0 }),
      states: {
        Idle: {
          on: {
            Load: {
              branches: "complete",
              resolve: ({ event, select }) => {
                expect(select.ready.from).type.toBeCallableWith({ count: 1 })
                expect(select.ready.from).type.not.toBeCallableWith({ message: "wrong branch" })
                expect(select.failed.from).type.toBeCallableWith({ message: "failed" })
                return event.count > 0
                  ? select.ready.from({ count: event.count })
                  : select.failed.from({ message: "zero" })
              }
            },
            Reset: {
              branches: "nested",
              resolve: ({ select }) => select.child.from({ name: "nested" }, (child) => child.Child.from({ count: 1 }))
            }
          }
        },
        Ready: {},
        Failed: {},
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
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
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
  })
  it("requires exactly the reachable invocation outcomes", () => {
    definition.handle({
      initial: {
        target: Machine.targets(root).root.Idle
      },
      root: () => ({ revision: 0 }),
      states: {
        Idle: {
          invoke: [
            {
              src: "direct",
              onDone: {
                target: targets.root.Ready,
                data: ({ output }) => {
                  expect(output).type.toBe<number>()
                  return { count: output }
                }
              }
            },
            { src: "empty", onDone: { none: true } },
            { src: "never" },
            {
              src: "failed",
              onFailure: {
                target: targets.root.Failed,
                data: ({ error }) => {
                  expect(error).type.toBe<LoadError>()
                  return { message: error.message }
                }
              }
            },
            {
              src: "values",
              onElement: {
                none: true,
                resolve: ({ element }) => {
                  expect(element).type.toBe<1 | 2>()
                }
              },
              onDone: { none: true }
            },
            { src: "timeout", onDone: { none: true } }
          ]
        },
        Ready: {},
        Failed: {},
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
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
              target: Machine.targets(root).root.Nested.Child,
              data: () => {
                throw new Error("type-only constructor")
              }
            }
          }
        },
        root: () => {
          throw new Error("type-only constructor")
        },
        initial: { target: Machine.targets(root).root.Idle }
      })
    }
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "failed" } },
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "direct", onDone: { none: true }, onFailure: { none: true } } },
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "never", onDone: { none: true } } },
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "values", onDone: { none: true } } },
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
  })
  it("requires input only for input-taking programs and carries used dependencies", () => {
    const machine = definition.handle({
      initial: {
        target: Machine.targets(root).root.Idle
      },
      root: () => ({ revision: 0 }),
      states: {
        Idle: {
          invoke: {
            src: "load",
            input: ({ root }) => root.revision,
            onDone: { target: targets.root.Ready, data: ({ output }) => ({ count: output }) }
          }
        },
        Ready: {},
        Failed: {},
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
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
        Idle: { invoke: { src: "load", onDone: { none: true } } },
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "load", input: () => "bad", onDone: { none: true } } },
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { invoke: { src: "direct", input: () => 1, onDone: { none: true } } },
        Nested: {
          initial: {
            target: Machine.targets(root).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root).root.Idle }
    })
  })
})
