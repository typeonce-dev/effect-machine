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

const States = Machine.state({
  initial: "support",
  states: {
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
  }
})

const NestedStates = Machine.state({
  initial: "Closed",
  states: {
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
  }
})

const completeNestedFallback = (
  target: Machine.Machine.HistoryDefaultTargetBuilder<{ readonly "": typeof NestedStates.node }, "App.Workspace">
) =>
  target.from((tree) =>
    tree.App.decoded(
      new App({ session: "fallback" }),
      (app) => {
        expect(app).type.not.toHaveProperty("Settings")
        return app.Workspace.decoded(
          new Workspace({}),
          (workspace) =>
            workspace
              .Editor.decoded(new Editor({}), (editor) => editor.Editing.decoded(new Editing({})))
              .Sidebar.decoded(new Sidebar({}))
        )
      }
    )
  )

const constructedNestedFallback = (
  target: Machine.Machine.HistoryDefaultTargetBuilder<{ readonly "": typeof NestedStates.node }, "App.Workspace">,
  session: string
) =>
  target.from((tree) =>
    tree.App.from({ session }, (app) =>
      app.Workspace.from((workspace) =>
        workspace
          .Editor.from((editor) => editor.Editing.from())
          .Sidebar.from()
      ))
  )

describe("Machine history states", () => {
  it("separates active and history identifiers", () => {
    expect<Machine.Machine.StateIdentifier<{ readonly "": typeof States.node }>>().type.toBe<
      | ""
      | "checkout"
      | "checkout.shipping"
      | "checkout.payment"
      | "checkout.payment.cardEntry"
      | "checkout.payment.verifying"
      | "support"
    >()
    expect<Machine.Machine.HistoryIdentifier<{ readonly "": typeof States.node }>>().type.toBe<
      "checkout.recent" | "checkout.exact"
    >()
  })

  it("excludes history pseudo-states from snapshots and initial selectors", () => {
    type Snapshot = Machine.Snapshot<typeof States>
    expect<"checkout.recent">().type.not.toBeAssignableTo<Snapshot["path"]>()
    Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(),
      initialConfiguration: (to) => {
        expect(to).type.not.toHaveProperty("recent")
        expect(to).type.not.toHaveProperty("exact")
        return to.resolve(({ target }) =>
          target.from((to) =>
            to.checkout.decoded(
              new Checkout({ orderId: "order-1" }),
              (checkout) => checkout.shipping.decoded(new Shipping({ address: "Main Street" }))
            )
          )
        )
      }
    })
    expect(States.get).type.not.toBeCallableWith(
      { path: "support" as const, value: new Support({}) },
      "checkout.recent"
    )
  })

  it("exposes history references without value overrides", () => {
    const targets1 = Machine.targets(States)

    const definition = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(Resume),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => (target.from((to) => to.support.decoded(new Support({})))))
    })
    const incomplete = definition.handle({
      states: {
        support: {
          on: {
            Resume: { history: targets1.root.checkout.exact }
          }
        }
      }
    })

    expect(incomplete).type.toBeAssignableTo<Machine.Machine.Any>()
    expect(targets1.root.checkout.exact).type.not.toBeAssignableTo<() => unknown>()
    expect(targets1.root.checkout.exact).type.not.toHaveProperty("from")
    expect(definition.handle).type.not.toBeCallableWith({
      states: { support: { on: { Resume: { history: targets1.root.checkout.exact, from: () => ({}) } } } }
    })
  })

  it("requires typed defaults and only the shallow-dependent initializer", () => {
    expect<Machine.Machine.RequiredHistoryInitializers<{ readonly "": typeof States.node }>>().type.toBe<
      "checkout.payment"
    >()

    const targets2 = Machine.targets(States)
    const definition = Machine.make({
      branches: { transition1: { destination: { history: targets2.root.checkout.recent } } },

      root: States,
      events: Machine.eventsFromSchemas(Resume),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => (target.from((to) => to.support.decoded(new Support({})))))
    })
    const incomplete = definition.handle({
      states: {
        support: {
          on: {
            Resume: { branches: "transition1", resolve: ({ select: { destination: target } }) => target() }
          }
        }
      }
    })

    expect(Machine.planInitial).type.not.toBeCallableWith(incomplete)

    const complete = definition.handle({
      states: {
        checkout: {
          history: {
            recent: {
              default: ({ owner, target }) => {
                expect(owner).type.toBe<"checkout">()
                expect(target).type.toBe<
                  Machine.Machine.HistoryDefaultTargetBuilder<{ readonly "": typeof States.node }, "checkout">
                >()
                return target.from((tree) =>
                  tree.checkout.decoded(
                    new Checkout({ orderId: "fallback" }),
                    (checkout) => checkout.shipping.decoded(new Shipping({ address: "" }))
                  )
                )
              }
            },
            exact: {
              default: ({ target }) =>
                target.from((tree) =>
                  tree.checkout.decoded(
                    new Checkout({ orderId: "fallback" }),
                    (checkout) => checkout.shipping.decoded(new Shipping({ address: "" }))
                  )
                )
            }
          },
          states: {
            payment: {
              initialize: ({ state, containingState, ancestors, builder }) => {
                expect(state).type.toBe<Payment>()
                expect(containingState).type.toBe<Checkout>()
                expect(ancestors).type.toBe<{ readonly checkout: Checkout }>()
                return builder.decoded(new CardEntry({ cardNumber: `attempt-${state.attempt}` }))
              }
            }
          }
        }
      }
    })

    expect(Machine.planInitial).type.toBeCallableWith(complete)
  })

  it("rejects defaults outside the history parent and wrong initial child values", () => {
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(Resume),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => (target.from((to) => to.support.decoded(new Support({})))))
    })

    machine.handle({
      states: {
        checkout: {
          history: {
            recent: {
              default: ({ target }) => {
                expect(target).type.not.toHaveProperty("support")
                return target.from((tree) =>
                  tree.checkout.decoded(
                    new Checkout({ orderId: "fallback" }),
                    (checkout) => checkout.shipping.decoded(new Shipping({ address: "" }))
                  )
                )
              }
            },
            exact: {
              default: ({ target }) =>
                target.from((tree) =>
                  tree.checkout.decoded(
                    new Checkout({ orderId: "fallback" }),
                    (checkout) => checkout.shipping.decoded(new Shipping({ address: "" }))
                  )
                )
            }
          }
        }
      }
    })

    machine.handle({
      states: {
        checkout: {
          states: {
            payment: {
              initialize: ({ builder }) => {
                expect(builder.decoded).type.not.toBeCallableWith(new Verifying({ challengeId: "wrong-child" }))
                return builder.decoded(new CardEntry({ cardNumber: "" }))
              }
            }
          }
        }
      }
    })

    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        checkout: {
          states: {
            recent: {}
          }
        }
      }
    })
  })

  it("accepts only complete root configurations containing a nested history owner", () => {
    expect<Machine.Machine.CompleteSnapshotContaining<{ readonly "": typeof NestedStates.node }, "App.Workspace">>()
      .type.toBe<
      ReturnType<typeof completeNestedFallback> extends Machine.Machine.StateConstruction<infer Snapshot> ? Snapshot
        : never
    >()

    const machine = Machine.make({
      root: NestedStates,
      events: Machine.eventsFromSchemas(Resume),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => (target.from((to) => to.Closed.decoded(new Closed({})))))
    })

    const complete = machine.handle({
      states: {
        App: {
          states: {
            Workspace: {
              history: {
                resume: {
                  default: ({ owner, target }) => {
                    expect(owner).type.toBe<"App.Workspace">()
                    expect(target).type.toBe<
                      Machine.Machine.HistoryDefaultTargetBuilder<
                        { readonly "": typeof NestedStates.node },
                        "App.Workspace"
                      >
                    >()
                    expect(target).type.not.toHaveProperty("Closed")
                    return completeNestedFallback(target)
                  }
                }
              }
            }
          }
        }
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)

    expect(machine.handle).type.not.toBeCallableWith({
      states: {
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
      }
    })

    expect(machine.handle).type.not.toBeCallableWith({
      states: {
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
      }
    })

    expect(machine.handle).type.not.toBeCallableWith({
      states: {
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
      }
    })

    expect(machine.handle).type.not.toBeCallableWith({
      states: {
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
      }
    })
  })

  it("rejects Effects returned by nested history defaults", () => {
    const machine = Machine.make({
      root: NestedStates,
      events: Machine.eventsFromSchemas(Resume),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => (target.from((to) => to.Closed.decoded(new Closed({})))))
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
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
      }
    })
  })

  it("requires defaults and shallow initializers in one handler tree", () => {
    const definition = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(Resume),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => (target.from((to) => to.support.decoded(new Support({})))))
    })
    const afterDefaults = definition.handle({
      states: {
        checkout: {
          history: {
            recent: {
              default: ({ target }) =>
                target.from((tree) =>
                  tree.checkout.decoded(
                    new Checkout({ orderId: "fallback" }),
                    (checkout) => checkout.shipping.decoded(new Shipping({ address: "" }))
                  )
                )
            },
            exact: {
              default: ({ target }) =>
                target.from((tree) =>
                  tree.checkout.decoded(
                    new Checkout({ orderId: "fallback" }),
                    (checkout) => checkout.shipping.decoded(new Shipping({ address: "" }))
                  )
                )
            }
          }
        }
      }
    })
    expect(Machine.planInitial).type.not.toBeCallableWith(afterDefaults)

    const complete = definition.handle({
      states: {
        checkout: {
          history: {
            recent: {
              default: ({ target }) =>
                target.from((tree) =>
                  tree.checkout.decoded(
                    new Checkout({ orderId: "fallback" }),
                    (checkout) => checkout.shipping.decoded(new Shipping({ address: "" }))
                  )
                )
            },
            exact: {
              default: ({ target }) =>
                target.from((tree) =>
                  tree.checkout.decoded(
                    new Checkout({ orderId: "fallback" }),
                    (checkout) => checkout.shipping.decoded(new Shipping({ address: "" }))
                  )
                )
            }
          },
          states: {
            payment: {
              initialize: ({ state, builder }) => builder.decoded(new CardEntry({ cardNumber: String(state.attempt) }))
            }
          }
        }
      }
    })

    expect(Machine.planInitial).type.toBeCallableWith(complete)
    expect<Machine.Machine.Services<typeof complete>>().type.toBe<never>()
    expect<Machine.Machine.Error<typeof complete>>().type.toBe<never>()
  })

  it("does not require nested initializers for deep-only history", () => {
    const DeepOnlyStates = Machine.state({
      initial: "support",
      states: {
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
      }
    })
    expect<Machine.Machine.RequiredHistoryInitializers<{ readonly "": typeof DeepOnlyStates.node }>>().type.toBe<
      never
    >()

    const machine = Machine.make({
      root: DeepOnlyStates,
      events: Machine.eventsFromSchemas(Resume),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => (target.from((to) => to.support.decoded(new Support({})))))
    }).handle({
      states: {
        checkout: {
          history: {
            exact: {
              default: () => ({
                path: "",
                value: undefined,
                state: {
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
                }
              })
            }
          }
        }
      }
    })

    expect(Machine.planInitial).type.toBeCallableWith(machine)
  })

  it("requires an exact region-value map when shallow restoration descends through a parallel state", () => {
    const ParallelStates = Machine.state({
      initial: "support",
      states: {
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
      }
    })
    expect<Machine.Machine.RequiredHistoryInitializers<{ readonly "": typeof ParallelStates.node }>>().type.toBe<
      "outer.all"
    >()

    const machine = Machine.make({
      root: ParallelStates,
      events: Machine.eventsFromSchemas(Resume),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => (target.from((to) => to.support.decoded(new Support({})))))
    })
    const complete = machine.handle({
      states: {
        outer: {
          history: {
            recent: {
              default: ({ target }) =>
                target.from((tree) =>
                  tree.outer.decoded(
                    new Checkout({ orderId: "fallback" }),
                    (outer) =>
                      outer.all.decoded(
                        new Payment({ attempt: 1 }),
                        (all) =>
                          all
                            .shipping.decoded(new Shipping({ address: "" }))
                            .card.decoded(new CardEntry({ cardNumber: "" }))
                      )
                  )
                )
            }
          },
          states: {
            all: {
              initialize: ({ state, builder }) => {
                expect(state).type.toBe<Payment>()
                return builder
                  .shipping.decoded(new Shipping({ address: `attempt-${state.attempt}` }))
                  .card.decoded(new CardEntry({ cardNumber: "" }))
              }
            }
          }
        }
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)

    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        outer: {
          states: {
            all: {
              initialize: ({ builder }: Machine.Machine.StateInitializeContext<
                { readonly "": typeof ParallelStates.node },
                readonly [typeof Resume],
                readonly [],
                "outer.all"
              >) => builder.shipping.decoded(new Shipping({ address: "missing-card" }))
            }
          }
        }
      }
    })
  })

  it("rejects root history nodes and active-state properties on history nodes", () => {
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "rootHistory",
      states: {
        rootHistory: {
          type: "history"
        }
      }
    })
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "checkout",
      states: {
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
      }
    })
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "checkout",
      states: {
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
      }
    })
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "checkout",
      states: {
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
      }
    })
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "checkout",
      states: {
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
      }
    })
  })
})
