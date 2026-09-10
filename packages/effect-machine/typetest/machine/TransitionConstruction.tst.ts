import { Schema } from "effect"
import { describe, expect, test } from "tstyche"
import { Machine } from "../../src/index.js"
class Root extends Schema.TaggedClass<Root>("Root")("Root", { count: Schema.Number }) {}
class Saved extends Schema.TaggedClass<Saved>("Saved")("Saved", { text: Schema.String }) {}
const root1 = Machine.state({
  schema: Root,
  states: {
    Idle: {},
    Saved: { schema: Saved },
    Nested: {
      fields: { label: Schema.String },
      states: { Child: { fields: { required: Schema.String } } }
    }
  }
})
const targets1 = Machine.targets(root1)
const definition = Machine.make({
  branches: { saved: { ready: { target: targets1.root.Saved } } },
  root: root1,
  events: Machine.events({ Save: { text: Schema.String } })
})
describe("transition construction", () => {
  test("infers both values and preserves explicit construction requirements", () => {
    definition.handle({
      initial: {
        target: Machine.targets(root1).root.Idle
      },
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              reenter: true,
              guard: ({ root, event }) => {
                expect(root).type.toBe<Root>()
                expect(event.text).type.toBe<string>()
                return event.text.length > 0
              },
              data: ({ root, event }) => ({ target: { text: event.text }, update: { count: root.count + 1 } })
            }
          }
        },
        Saved: {},
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { Child: {} }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      }
    })
    expect(definition.handle).type.toBeCallableWith({
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root1).root.Idle },
      states: {
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              data: () => ({ target: {}, update: { count: 1 } })
            }
          }
        },
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root1).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              data: () => ({ target: { text: "" }, update: {} })
            }
          }
        },
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root1).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: {
          on: { Save: { target: targets1.root.Saved, update: targets1.root, data: () => ({ target: { text: "" } }) } }
        },
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root1).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              decoded: true,
              data: () => ({ target: { text: "" }, update: new Root({ count: 1 }) })
            }
          }
        },
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root1).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              decoded: true,
              data: () => ({ target: new Saved({ text: "" }), update: { count: 1 } })
            }
          }
        },
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root1).root.Idle }
    })
    definition.handle({
      initial: {
        target: Machine.targets(root1).root.Idle
      },
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              decoded: true,
              data: () => ({ target: new Saved({ text: "" }), update: new Root({ count: 1 }) })
            }
          }
        },
        Saved: {},
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { Child: {} }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      }
    })
    expect(definition.handle).type.toBeCallableWith({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Nested,
              update: targets1.root,
              data: () => ({ target: { label: "" }, update: { count: 1 } })
            }
          }
        },
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root1).root.Idle }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { on: { Save: { update: targets1.root.Idle, data: () => undefined } } },
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root1).root.Idle }
    })
  })
  test("guards updates without allowing incomplete replacements or implicit reentry", () => {
    definition.handle({
      initial: {
        target: Machine.targets(root1).root.Idle
      },
      on: {
        Save: {
          update: targets1.root,
          guard: ({ root, event }) => root.count > event.text.length,
          decoded: true,
          data: ({ root }) => {
            expect(root).type.toBe<Root>()
            return root
          }
        }
      },
      states: {
        Idle: {},
        Saved: {},
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { Child: {} }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      on: { Save: { update: targets1.root, data: () => ({}) } },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root1).root.Idle },
      states: {
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      on: { Save: { update: targets1.root, reenter: true, data: () => ({ count: 1 }) } },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root1).root.Idle },
      states: {
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
  })
  test("reentry composes with value construction and branch resolution", () => {
    definition.handle({
      initial: {
        target: Machine.targets(root1).root.Idle
      },
      states: {
        Idle: {
          on: {
            Save: {
              branches: "saved",
              reenter: true,
              resolve: ({ event, select }) => {
                expect(event.text).type.toBe<string>()
                return select.ready({ data: { text: event.text } })
              }
            }
          }
        },
        Saved: {},
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { Child: {} }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: { on: { Save: { target: targets1.root.Saved, resolve: () => undefined } } },
        Nested: {
          initial: {
            target: Machine.targets(root1).root.Nested.Child,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      root: () => {
        throw new Error("type-only constructor")
      },
      initial: { target: Machine.targets(root1).root.Idle }
    })
  })
})
