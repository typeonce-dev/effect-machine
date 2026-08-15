import { Context, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Checkout extends Schema.TaggedClass<Checkout>("Checkout")("Checkout", {
  orderId: Schema.String
}) {}

class Shipping extends Schema.TaggedClass<Shipping>("Shipping")("Shipping", {
  address: Schema.String
}) {}

class Payment extends Schema.TaggedClass<Payment>("Payment")("Payment", {
  attempt: Schema.Number
}) {}

class CardEntry extends Schema.TaggedClass<CardEntry>("CardEntry")("CardEntry", {
  cardNumber: Schema.String
}) {}

class Verifying extends Schema.TaggedClass<Verifying>("Verifying")("Verifying", {
  challengeId: Schema.String
}) {}

class Support extends Schema.TaggedClass<Support>("Support")("Support", {}) {}

class Resume extends Schema.TaggedClass<Resume>("Resume")("Resume", {}) {}

class InitialRequirement extends Context.Service<InitialRequirement, {
  readonly cardNumber: string
}>()("test/MachineHistory/InitialRequirement") {}

class FallbackRequirement extends Context.Service<FallbackRequirement, {
  readonly workspaceId: string
}>()("test/MachineHistory/FallbackRequirement") {}

class App extends Schema.TaggedClass<App>("App")("App", {
  session: Schema.String
}) {}
class Workspace extends Schema.TaggedClass<Workspace>("Workspace")("Workspace", {}) {}
class Settings extends Schema.TaggedClass<Settings>("Settings")("Settings", {}) {}
class Closed extends Schema.TaggedClass<Closed>("Closed")("Closed", {}) {}
class Editor extends Schema.TaggedClass<Editor>("Editor")("Editor", {}) {}
class Editing extends Schema.TaggedClass<Editing>("Editing")("Editing", {}) {}
class Sidebar extends Schema.TaggedClass<Sidebar>("Sidebar")("Sidebar", {}) {}

const States = Machine.defineStates({
  checkout: {
    schema: Checkout,
    initial: "shipping",
    states: {
      shipping: Shipping,
      payment: {
        schema: Payment,
        initial: "cardEntry",
        states: {
          cardEntry: CardEntry,
          verifying: Verifying
        }
      },
      recent: {
        type: "history"
      },
      exact: {
        type: "history",
        history: "deep"
      }
    }
  },
  support: Support
})

const NestedStates = Machine.defineStates({
  App: {
    schema: App,
    initial: "Workspace",
    states: {
      Workspace: {
        schema: Workspace,
        type: "parallel",
        states: {
          Editor: {
            schema: Editor,
            initial: "Editing",
            states: {
              Editing
            }
          },
          Sidebar,
          resume: {
            type: "history",
            history: "deep"
          }
        }
      },
      Settings
    }
  },
  Closed
})

const completeNestedFallback = (
  target: Machine.Machine.HistoryDefaultTargetBuilder<typeof NestedStates.states, "App.Workspace">
) =>
  target.App(
    new App({ session: "fallback" }),
    (app) => {
      expect(app).type.not.toHaveProperty("Settings")
      return app.Workspace(
        new Workspace({}),
        (workspace) =>
          workspace
            .Editor(new Editor({}), (editor) => editor.Editing(new Editing({})))
            .Sidebar(new Sidebar({}))
      )
    }
  )

const constructedNestedFallback = (
  target: Machine.Machine.HistoryDefaultTargetBuilder<typeof NestedStates.states, "App.Workspace">,
  session: string
) =>
  target.App.from({ session }, (app) =>
    app.Workspace.from((workspace) =>
      workspace
        .Editor.from((editor) => editor.Editing.from())
        .Sidebar.from()
    ))

describe("Machine history states", () => {
  it("separates active and history identifiers", () => {
    expect<Machine.Machine.StateIdentifier<typeof States.states>>().type.toBe<
      | "checkout"
      | "checkout.shipping"
      | "checkout.payment"
      | "checkout.payment.cardEntry"
      | "checkout.payment.verifying"
      | "support"
    >()
    expect<Machine.Machine.HistoryIdentifier<typeof States.states>>().type.toBe<
      "checkout.recent" | "checkout.exact"
    >()
  })

  it("excludes history pseudo-states from snapshots and initial builders", () => {
    type Snapshot = Machine.Machine.Snapshot<typeof States.states>
    expect<"checkout.recent">().type.not.toBeAssignableTo<Snapshot["path"]>()
    States.initial.checkout(
      new Checkout({ orderId: "order-1" }),
      (checkout) => {
        expect(checkout).type.not.toHaveProperty("recent")
        expect(checkout).type.not.toHaveProperty("exact")
        return checkout.shipping(new Shipping({ address: "Main Street" }))
      }
    )
    expect(States.get).type.not.toBeCallableWith(
      States.initial.support(new Support({})),
      "checkout.recent"
    )
  })

  it("exposes zero-argument history targets without value overrides", () => {
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(Resume),
      initial: () => States.initial.support(new Support({}))
    }).handle({
      support: {
        on: {
          Resume: ({ target }) => {
            expect(target.history.checkout.recent).type.toBeCallableWith()
            expect(target.history.checkout.recent).type.not.toBeCallableWith(new Checkout({ orderId: "new" }))
            expect(target.history.checkout.exact).type.toBeCallableWith()
            expect(target.full).type.not.toHaveProperty("recent")
            expect(target.local).type.not.toHaveProperty("recent")
            expect(target.branch).type.not.toHaveProperty("recent")
            return target.history.checkout.exact()
          }
        }
      }
    })

    expect(machine).type.toBeAssignableTo<Machine.Machine.Any>()
  })

  it("requires typed defaults and only the shallow-dependent initializer", () => {
    expect<Machine.Machine.RequiredHistoryInitializers<typeof States.states>>().type.toBe<"checkout.payment">()

    const machine = Machine.make({
      states: States.states,
      events: Machine.events(Resume),
      initial: () => States.initial.support(new Support({}))
    }).handle({
      support: {
        on: {
          Resume: ({ target }) => target.history.checkout.recent()
        }
      }
    })

    expect(Machine.planInitial).type.not.toBeCallableWith(machine)

    const complete = machine.handle({
      checkout: {
        history: {
          recent: {
            default: ({ owner, target }) => {
              expect(owner).type.toBe<"checkout">()
              expect(target).type.toBe<
                Machine.Machine.HistoryDefaultTargetBuilder<typeof States.states, "checkout">
              >()
              return States.initial.checkout(
                new Checkout({ orderId: "fallback" }),
                (checkout) => checkout.shipping(new Shipping({ address: "" }))
              )
            }
          },
          exact: {
            default: () =>
              States.initial.checkout(
                new Checkout({ orderId: "fallback" }),
                (checkout) => checkout.shipping(new Shipping({ address: "" }))
              )
          }
        },
        states: {
          payment: {
            initial: ({ state, containingState, ancestors }) => {
              expect(state).type.toBe<Payment>()
              expect(containingState).type.toBe<Checkout>()
              expect(ancestors).type.toBe<{ readonly checkout: Checkout }>()
              return new CardEntry({ cardNumber: `attempt-${state.attempt}` })
            }
          }
        }
      }
    })

    expect(Machine.planInitial).type.toBeCallableWith(complete)
  })

  it("rejects defaults outside the history parent and wrong initial child values", () => {
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(Resume),
      initial: () => States.initial.support(new Support({}))
    })

    expect(machine.handle).type.not.toBeCallableWith({
      checkout: {
        history: {
          recent: {
            default: () => States.initial.support(new Support({}))
          },
          exact: {
            default: () => States.initial.support(new Support({}))
          }
        }
      }
    })

    expect(machine.handle).type.not.toBeCallableWith({
      checkout: {
        states: {
          payment: {
            initial: () => new Verifying({ challengeId: "wrong-child" })
          }
        }
      }
    })

    expect(machine.handle).type.not.toBeCallableWith({
      checkout: {
        states: {
          recent: {}
        }
      }
    })
  })

  it("accepts only complete root configurations containing a nested history owner", () => {
    expect<Machine.Machine.CompleteSnapshotContaining<typeof NestedStates.states, "App.Workspace">>().type.toBe<
      ReturnType<typeof completeNestedFallback>
    >()

    const machine = Machine.make({
      states: NestedStates.states,
      events: Machine.events(Resume),
      initial: () => NestedStates.initial.Closed(new Closed({}))
    })

    const complete = machine.handle({
      App: {
        states: {
          Workspace: {
            history: {
              resume: {
                default: ({ owner, target }) => {
                  expect(owner).type.toBe<"App.Workspace">()
                  expect(target).type.toBe<
                    Machine.Machine.HistoryDefaultTargetBuilder<typeof NestedStates.states, "App.Workspace">
                  >()
                  expect(target).type.not.toHaveProperty("Closed")
                  return completeNestedFallback(target)
                }
              }
            }
          }
        }
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)

    expect(machine.handle).type.not.toBeCallableWith({
      App: {
        states: {
          Workspace: {
            history: {
              resume: {
                default: () => ({
                  path: "Closed" as const,
                  value: new Closed({})
                })
              }
            }
          }
        }
      }
    })

    expect(machine.handle).type.not.toBeCallableWith({
      App: {
        states: {
          Workspace: {
            history: {
              resume: {
                default: () => ({
                  path: "App" as const,
                  value: new App({ session: "sibling" }),
                  state: {
                    path: "App.Settings" as const,
                    value: new Settings({})
                  }
                })
              }
            }
          }
        }
      }
    })

    expect(machine.handle).type.not.toBeCallableWith({
      App: {
        states: {
          Workspace: {
            history: {
              resume: {
                default: () => ({
                  path: "App.Workspace" as const,
                  value: new Workspace({}),
                  states: {
                    Editor: {
                      path: "App.Workspace.Editor" as const,
                      value: new Editor({}),
                      state: {
                        path: "App.Workspace.Editor.Editing" as const,
                        value: new Editing({})
                      }
                    },
                    Sidebar: {
                      path: "App.Workspace.Sidebar" as const,
                      value: new Sidebar({})
                    }
                  }
                })
              }
            }
          }
        }
      }
    })

    expect(machine.handle).type.not.toBeCallableWith({
      App: {
        states: {
          Workspace: {
            history: {
              resume: {
                default: () => ({
                  path: "App" as const,
                  value: new App({ session: "missing-region" }),
                  state: {
                    path: "App.Workspace" as const,
                    value: new Workspace({}),
                    states: {
                      Sidebar: {
                        path: "App.Workspace.Sidebar" as const,
                        value: new Sidebar({})
                      }
                    }
                  }
                })
              }
            }
          }
        }
      }
    })
  })

  it("rejects Effects returned by nested history defaults", () => {
    const machine = Machine.make({
      states: NestedStates.states,
      events: Machine.events(Resume),
      initial: () => NestedStates.initial.Closed(new Closed({}))
    })
    expect(machine.handle).type.not.toBeCallableWith({
      App: {
        states: {
          Workspace: {
            history: {
              resume: {
                default: () => Effect.succeed(null)
              }
            }
          }
        }
      }
    })
  })

  it("tracks defaults and shallow initializers across successive handle calls", () => {
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(Resume),
      initial: () => States.initial.support(new Support({}))
    })
    const afterDefaults = machine.handle({
      checkout: {
        history: {
          recent: {
            default: () =>
              States.initial.checkout(
                new Checkout({ orderId: "fallback" }),
                (checkout) => checkout.shipping(new Shipping({ address: "" }))
              )
          },
          exact: {
            default: () =>
              States.initial.checkout(
                new Checkout({ orderId: "fallback" }),
                (checkout) => checkout.shipping(new Shipping({ address: "" }))
              )
          }
        }
      }
    })
    expect(Machine.planInitial).type.not.toBeCallableWith(afterDefaults)

    const complete = afterDefaults.handle({
      checkout: {
        states: {
          payment: {
            initial: ({ state }) => new CardEntry({ cardNumber: String(state.attempt) })
          }
        }
      }
    })

    expect(Machine.planInitial).type.toBeCallableWith(complete)
    expect<Machine.Machine.Services<typeof complete>>().type.toBe<never>()
    expect<Machine.Machine.Error<typeof complete>>().type.toBe<never>()
  })

  it("does not require nested initializers for deep-only history", () => {
    const DeepOnlyStates = Machine.defineStates({
      checkout: {
        schema: Checkout,
        initial: "payment",
        states: {
          payment: {
            schema: Payment,
            initial: "cardEntry",
            states: {
              cardEntry: CardEntry,
              verifying: Verifying
            }
          },
          exact: {
            type: "history",
            history: "deep"
          }
        }
      },
      support: Support
    })
    expect<Machine.Machine.RequiredHistoryInitializers<typeof DeepOnlyStates.states>>().type.toBe<never>()

    const machine = Machine.make({
      states: DeepOnlyStates.states,
      events: Machine.events(Resume),
      initial: () => DeepOnlyStates.initial.support(new Support({}))
    }).handle({
      checkout: {
        history: {
          exact: {
            default: () => ({
              path: "checkout",
              value: new Checkout({ orderId: "fallback" }),
              state: {
                path: "checkout.payment",
                value: new Payment({ attempt: 1 }),
                state: {
                  path: "checkout.payment.cardEntry",
                  value: new CardEntry({ cardNumber: "" })
                }
              }
            })
          }
        }
      }
    })

    expect(Machine.planInitial).type.toBeCallableWith(machine)
  })

  it("requires an exact region-value map when shallow restoration descends through a parallel state", () => {
    const ParallelStates = Machine.defineStates({
      outer: {
        schema: Checkout,
        initial: "all",
        states: {
          all: {
            schema: Payment,
            type: "parallel",
            states: {
              shipping: Shipping,
              card: CardEntry
            }
          },
          recent: {
            type: "history"
          }
        }
      },
      support: Support
    })
    expect<Machine.Machine.RequiredHistoryInitializers<typeof ParallelStates.states>>().type.toBe<"outer.all">()

    const machine = Machine.make({
      states: ParallelStates.states,
      events: Machine.events(Resume),
      initial: () => ParallelStates.initial.support(new Support({}))
    })
    const complete = machine.handle({
      outer: {
        history: {
          recent: {
            default: () =>
              ParallelStates.initial.outer(
                new Checkout({ orderId: "fallback" }),
                (outer) =>
                  outer.all(
                    new Payment({ attempt: 1 }),
                    (all) =>
                      all
                        .shipping(new Shipping({ address: "" }))
                        .card(new CardEntry({ cardNumber: "" }))
                  )
              )
          }
        },
        states: {
          all: {
            initial: ({ state }) => {
              expect(state).type.toBe<Payment>()
              return {
                shipping: new Shipping({ address: `attempt-${state.attempt}` }),
                card: new CardEntry({ cardNumber: "" })
              }
            }
          }
        }
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)

    expect(machine.handle).type.not.toBeCallableWith({
      outer: {
        states: {
          all: {
            initial: () => ({
              shipping: new Shipping({ address: "missing-card" })
            })
          }
        }
      }
    })
  })

  it("rejects root history nodes and active-state properties on history nodes", () => {
    expect(Machine.defineStates).type.not.toBeCallableWith({
      rootHistory: {
        type: "history"
      }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      checkout: {
        schema: Checkout,
        initial: "shipping",
        states: {
          shipping: Shipping,
          history: {
            type: "history",
            schema: Support
          }
        }
      }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      checkout: {
        schema: Checkout,
        initial: "shipping",
        states: {
          shipping: Shipping,
          history: {
            type: "history",
            states: {
              child: Support
            }
          }
        }
      }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      checkout: {
        schema: Checkout,
        initial: "history",
        states: {
          shipping: Shipping,
          history: {
            type: "history"
          }
        }
      }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      checkout: {
        schema: Checkout,
        initial: "shipping",
        states: {
          shipping: Shipping,
          history: {
            type: "history",
            history: "stack"
          }
        }
      }
    })
  })
})
