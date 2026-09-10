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
}>()("test/MachineHistory/InitialRequirement") {
}
class FallbackRequirement extends Context.Service<FallbackRequirement, {
  readonly workspaceId: string
}>()("test/MachineHistory/FallbackRequirement") {
}
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
  states: {
    checkout: {
      schema: Checkout,
      states: {
        shipping: Shipping,
        payment: {
          schema: Payment,
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
  states: {
    App: {
      schema: App,
      states: {
        Workspace: {
          schema: Workspace,
          type: "parallel",
          states: {
            Editor: {
              schema: Editor,
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
  target: Machine.Machine.HistoryDefaultTargetBuilder<{
    readonly "": typeof NestedStates.node
  }, "App.Workspace">
) =>
  target({
    states: {
      App: {
        decoded: true,
        data: new App({ session: "fallback" }),
        states: {
          Workspace: {
            decoded: true,
            data: new Workspace({}),
            states: {
              Editor: {
                decoded: true,
                data: new Editor({}),
                states: { Editing: { decoded: true, data: new Editing({}) } }
              },
              Sidebar: { decoded: true, data: new Sidebar({}) }
            }
          }
        }
      }
    }
  })

const constructedNestedFallback = (
  target: Machine.Machine.HistoryDefaultTargetBuilder<{
    readonly "": typeof NestedStates.node
  }, "App.Workspace">,
  session: string
) =>
  target({
    states: {
      App: {
        data: { session },
        states: { Workspace: { states: { Editor: { states: { Editing: {} } }, Sidebar: {} } } }
      }
    }
  })
describe("Machine history states", () => {
  it("separates active and history identifiers", () => {
    expect<
      Machine.Machine.StateIdentifier<{
        readonly "": typeof States.node
      }>
    >().type.toBe<
      | ""
      | "checkout"
      | "checkout.shipping"
      | "checkout.payment"
      | "checkout.payment.cardEntry"
      | "checkout.payment.verifying"
      | "support"
    >()
    expect<
      Machine.Machine.HistoryIdentifier<{
        readonly "": typeof States.node
      }>
    >().type.toBe<"checkout.recent" | "checkout.exact">()
  })
  it("excludes history pseudo-states from initial edges", () => {
    const root = Machine.state({ states: { Idle: {}, recent: { type: "history" } } })
    const targets = Machine.targets(root)
    const definition = Machine.make({ root, events: Machine.events({}) })
    expect(definition.handle).type.toBeCallableWith({ initial: { target: targets.root.Idle } })
    expect(definition.handle).type.not.toBeCallableWith({ initial: { target: targets.root.recent } })
  })
  it("exposes history references without value overrides", () => {
    const targets1 = Machine.targets(States)
    const definition = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(Resume)
    })
    const incomplete = definition.handle({
      initial: {
        target: Machine.targets(States).root.support,
        decoded: true,
        data: new Support({})
      },
      states: {
        checkout: {
          initial: {
            target: Machine.targets(States).root.checkout.shipping,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            shipping: {},
            payment: {
              initial: {
                target: Machine.targets(States).root.checkout.payment.cardEntry,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { cardEntry: {}, verifying: {} }
            }
          }
        },
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
    expect(definition.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(States).root.checkout,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        checkout: {
          initial: {
            target: Machine.targets(States).root.checkout.shipping,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            payment: {
              initial: {
                target: Machine.targets(States).root.checkout.payment.cardEntry,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        support: { on: { Resume: { history: targets1.root.checkout.exact, from: () => ({}) } } },
        checkout: {
          initial: {
            target: Machine.targets(States).root.checkout.shipping,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            payment: {
              initial: {
                target: Machine.targets(States).root.checkout.payment.cardEntry,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(States).root.checkout,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
  it("requires typed defaults and only the shallow-dependent initializer", () => {
    expect<
      Machine.Machine.RequiredHistoryInitializers<{
        readonly "": typeof States.node
      }>
    >().type.toBe<"checkout.payment">()
    const targets2 = Machine.targets(States)
    const definition = Machine.make({
      branches: { transition1: { destination: { history: targets2.root.checkout.recent } } },
      root: States,
      events: Machine.eventsFromSchemas(Resume)
    })
    const incomplete = definition.handle({
      initial: {
        target: Machine.targets(States).root.support,
        decoded: true,
        data: new Support({})
      },
      states: {
        checkout: {
          initial: {
            target: Machine.targets(States).root.checkout.shipping,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            shipping: {},
            payment: {
              initial: {
                target: Machine.targets(States).root.checkout.payment.cardEntry,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { cardEntry: {}, verifying: {} }
            }
          }
        },
        support: {
          on: {
            Resume: { branches: "transition1", resolve: ({ select: { destination: target } }) => target() }
          }
        }
      }
    })
    expect(Machine.planInitial).type.not.toBeCallableWith(incomplete)
    const complete = definition.handle({
      initial: {
        target: Machine.targets(States).root.support,
        decoded: true,
        data: new Support({})
      },
      states: {
        checkout: {
          initial: {
            target: Machine.targets(States).root.checkout.shipping,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          history: {
            recent: {
              default: ({ owner, target }) => {
                expect(owner).type.toBe<"checkout">()
                expect(target).type.toBe<
                  Machine.Machine.HistoryDefaultTargetBuilder<{
                    readonly "": typeof States.node
                  }, "checkout">
                >()
                return target({
                  states: {
                    checkout: {
                      data: new Checkout({ orderId: "fallback" }),
                      decoded: true,
                      states: { shipping: { data: new Shipping({ address: "" }), decoded: true } }
                    }
                  }
                })
              }
            },
            exact: {
              default: ({ target }) =>
                target({
                  states: {
                    checkout: {
                      data: new Checkout({ orderId: "fallback" }),
                      decoded: true,
                      states: { shipping: { data: new Shipping({ address: "" }), decoded: true } }
                    }
                  }
                })
            }
          },
          states: {
            shipping: {},
            payment: {
              initial: {
                target: Machine.targets(States).root.checkout.payment.cardEntry,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { cardEntry: {}, verifying: {} }
            }
          }
        },
        support: {}
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)
  })
  it("rejects defaults outside the history parent and wrong initial child values", () => {
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(Resume)
    })
    machine.handle({
      initial: {
        target: Machine.targets(States).root.support,
        decoded: true,
        data: new Support({})
      },
      states: {
        checkout: {
          initial: {
            target: Machine.targets(States).root.checkout.shipping,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          history: {
            recent: {
              default: ({ target }) => {
                expect(target).type.not.toHaveProperty("support")
                return target({
                  states: {
                    checkout: {
                      data: new Checkout({ orderId: "fallback" }),
                      decoded: true,
                      states: { shipping: { data: new Shipping({ address: "" }), decoded: true } }
                    }
                  }
                })
              }
            },
            exact: {
              default: ({ target }) =>
                target({
                  states: {
                    checkout: {
                      data: new Checkout({ orderId: "fallback" }),
                      decoded: true,
                      states: { shipping: { data: new Shipping({ address: "" }), decoded: true } }
                    }
                  }
                })
            }
          },
          states: {
            shipping: {},
            payment: {
              initial: {
                target: Machine.targets(States).root.checkout.payment.cardEntry,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { cardEntry: {}, verifying: {} }
            }
          }
        },
        support: {}
      }
    })
    machine.handle({
      initial: {
        target: Machine.targets(States).root.support,
        decoded: true,
        data: new Support({})
      },
      states: {
        checkout: {
          initial: {
            target: Machine.targets(States).root.checkout.shipping,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            shipping: {},
            payment: {
              initial: {
                target: Machine.targets(States).root.checkout.payment.cardEntry,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { cardEntry: {}, verifying: {} }
            }
          }
        },
        support: {}
      }
    })
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(States).root.checkout,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        checkout: {
          initial: {
            target: Machine.targets(States).root.checkout.shipping,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            payment: {
              initial: {
                target: Machine.targets(States).root.checkout.payment.cardEntry,
                data: () => {
                  throw new Error("type-only constructor")
                }
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
            recent: {},
            payment: {
              initial: {
                target: Machine.targets(States).root.checkout.payment.cardEntry,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          },
          initial: {
            target: Machine.targets(States).root.checkout.shipping,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: Machine.targets(States).root.checkout,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
  it("accepts only complete root configurations containing a nested history owner", () => {
    expect<
      Machine.Machine.CompleteSnapshotContaining<{
        readonly "": typeof NestedStates.node
      }, "App.Workspace">
    >()
      .type.toBe<
      ReturnType<typeof completeNestedFallback> extends Machine.Machine.StateConstruction<infer Snapshot> ? Snapshot
        : never
    >()
    const machine = Machine.make({
      root: NestedStates,
      events: Machine.eventsFromSchemas(Resume)
    })
    const complete = machine.handle({
      initial: {
        target: Machine.targets(NestedStates).root.Closed,
        decoded: true,
        data: new Closed({})
      },
      states: {
        App: {
          initial: {
            target: Machine.targets(NestedStates).root.App.Workspace,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            Workspace: {
              history: {
                resume: {
                  default: ({ owner, target }) => {
                    expect(owner).type.toBe<"App.Workspace">()
                    expect(target).type.toBe<
                      Machine.Machine.HistoryDefaultTargetBuilder<{
                        readonly "": typeof NestedStates.node
                      }, "App.Workspace">
                    >()
                    expect(target).type.not.toHaveProperty("Closed")
                    return completeNestedFallback(target)
                  }
                }
              },
              states: {
                Editor: {
                  initial: {
                    target: Machine.targets(NestedStates).root.App.Workspace.Editor.Editing,
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  },
                  states: { Editing: {} }
                },
                Sidebar: {}
              },
              initial: {
                Editor: () => {
                  throw new Error("type-only constructor")
                },
                Sidebar: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            Settings: {}
          }
        },
        Closed: {}
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(NestedStates).root.App,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        App: {
          initial: {
            target: Machine.targets(NestedStates).root.App.Workspace,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            Workspace: {
              initial: {
                Editor: () => {
                  throw new Error("type-only constructor")
                },
                Sidebar: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                Editor: {
                  initial: {
                    target: Machine.targets(NestedStates).root.App.Workspace.Editor.Editing,
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
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
                    path: "Closed" as const,
                    value: new Closed({})
                  })
                }
              },
              initial: {
                Editor: () => {
                  throw new Error("type-only constructor")
                },
                Sidebar: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                Editor: {
                  initial: {
                    target: Machine.targets(NestedStates).root.App.Workspace.Editor.Editing,
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              }
            }
          },
          initial: {
            target: Machine.targets(NestedStates).root.App.Workspace,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: Machine.targets(NestedStates).root.App,
        data: () => {
          throw new Error("type-only constructor")
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
              },
              initial: {
                Editor: () => {
                  throw new Error("type-only constructor")
                },
                Sidebar: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                Editor: {
                  initial: {
                    target: Machine.targets(NestedStates).root.App.Workspace.Editor.Editing,
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              }
            }
          },
          initial: {
            target: Machine.targets(NestedStates).root.App.Workspace,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: Machine.targets(NestedStates).root.App,
        data: () => {
          throw new Error("type-only constructor")
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
              },
              initial: {
                Editor: () => {
                  throw new Error("type-only constructor")
                },
                Sidebar: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                Editor: {
                  initial: {
                    target: Machine.targets(NestedStates).root.App.Workspace.Editor.Editing,
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              }
            }
          },
          initial: {
            target: Machine.targets(NestedStates).root.App.Workspace,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: Machine.targets(NestedStates).root.App,
        data: () => {
          throw new Error("type-only constructor")
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
              },
              initial: {
                Editor: () => {
                  throw new Error("type-only constructor")
                },
                Sidebar: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                Editor: {
                  initial: {
                    target: Machine.targets(NestedStates).root.App.Workspace.Editor.Editing,
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              }
            }
          },
          initial: {
            target: Machine.targets(NestedStates).root.App.Workspace,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: Machine.targets(NestedStates).root.App,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
  it("rejects Effects returned by nested history defaults", () => {
    const machine = Machine.make({
      root: NestedStates,
      events: Machine.eventsFromSchemas(Resume)
    })
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(NestedStates).root.App,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        App: {
          initial: {
            target: Machine.targets(NestedStates).root.App.Workspace,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            Workspace: {
              initial: {
                Editor: () => {
                  throw new Error("type-only constructor")
                },
                Sidebar: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                Editor: {
                  initial: {
                    target: Machine.targets(NestedStates).root.App.Workspace.Editor.Editing,
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
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
                  default: () => Effect.succeed(null)
                }
              },
              initial: {
                Editor: () => {
                  throw new Error("type-only constructor")
                },
                Sidebar: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                Editor: {
                  initial: {
                    target: Machine.targets(NestedStates).root.App.Workspace.Editor.Editing,
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              }
            }
          },
          initial: {
            target: Machine.targets(NestedStates).root.App.Workspace,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: Machine.targets(NestedStates).root.App,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
  it("requires defaults and shallow initializers in one handler tree", () => {
    const definition = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(Resume)
    })
    const afterDefaults = definition.handle({
      initial: {
        target: Machine.targets(States).root.support,
        decoded: true,
        data: new Support({})
      },
      states: {
        checkout: {
          initial: {
            target: Machine.targets(States).root.checkout.shipping,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          history: {
            recent: {
              default: ({ target }) =>
                target({
                  states: {
                    checkout: {
                      data: new Checkout({ orderId: "fallback" }),
                      decoded: true,
                      states: { shipping: { data: new Shipping({ address: "" }), decoded: true } }
                    }
                  }
                })
            },
            exact: {
              default: ({ target }) =>
                target({
                  states: {
                    checkout: {
                      data: new Checkout({ orderId: "fallback" }),
                      decoded: true,
                      states: { shipping: { data: new Shipping({ address: "" }), decoded: true } }
                    }
                  }
                })
            }
          },
          states: {
            shipping: {},
            payment: {
              initial: {
                target: Machine.targets(States).root.checkout.payment.cardEntry,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { cardEntry: {}, verifying: {} }
            }
          }
        },
        support: {}
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(afterDefaults)
    const complete = definition.handle({
      initial: {
        target: Machine.targets(States).root.support,
        decoded: true,
        data: new Support({})
      },
      states: {
        checkout: {
          initial: {
            target: Machine.targets(States).root.checkout.shipping,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          history: {
            recent: {
              default: ({ target }) =>
                target({
                  states: {
                    checkout: {
                      data: new Checkout({ orderId: "fallback" }),
                      decoded: true,
                      states: { shipping: { data: new Shipping({ address: "" }), decoded: true } }
                    }
                  }
                })
            },
            exact: {
              default: ({ target }) =>
                target({
                  states: {
                    checkout: {
                      data: new Checkout({ orderId: "fallback" }),
                      decoded: true,
                      states: { shipping: { data: new Shipping({ address: "" }), decoded: true } }
                    }
                  }
                })
            }
          },
          states: {
            shipping: {},
            payment: {
              initial: {
                target: Machine.targets(States).root.checkout.payment.cardEntry,
                decoded: true,
                data: ({ state }) => new CardEntry({ cardNumber: String(state.attempt) })
              },
              states: { cardEntry: {}, verifying: {} }
            }
          }
        },
        support: {}
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)
    expect<Machine.Machine.Services<typeof complete>>().type.toBe<never>()
    expect<Machine.Machine.Error<typeof complete>>().type.toBe<never>()
  })
  it("does not require nested initializers for deep-only history", () => {
    const DeepOnlyStates = Machine.state({
      states: {
        checkout: {
          schema: Checkout,
          states: {
            payment: {
              schema: Payment,
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
    expect<
      Machine.Machine.RequiredHistoryInitializers<{
        readonly "": typeof DeepOnlyStates.node
      }>
    >().type.toBe<never>()
    const machine = Machine.make({
      root: DeepOnlyStates,
      events: Machine.eventsFromSchemas(Resume)
    }).handle({
      initial: {
        target: Machine.targets(DeepOnlyStates).root.support,
        decoded: true,
        data: new Support({})
      },
      states: {
        checkout: {
          initial: {
            target: Machine.targets(DeepOnlyStates).root.checkout.payment,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
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
          },
          states: {
            payment: {
              initial: {
                target: Machine.targets(DeepOnlyStates).root.checkout.payment.cardEntry,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { cardEntry: {}, verifying: {} }
            }
          }
        },
        support: {}
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(machine)
  })
  it("requires an exact region-value map when shallow restoration descends through a parallel state", () => {
    const ParallelStates = Machine.state({
      states: {
        outer: {
          schema: Checkout,
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
    expect<
      Machine.Machine.RequiredHistoryInitializers<{
        readonly "": typeof ParallelStates.node
      }>
    >().type.toBe<"outer.all">()
    const machine = Machine.make({
      root: ParallelStates,
      events: Machine.eventsFromSchemas(Resume)
    })
    const complete = machine.handle({
      initial: {
        target: Machine.targets(ParallelStates).root.support,
        decoded: true,
        data: new Support({})
      },
      states: {
        outer: {
          initial: {
            target: Machine.targets(ParallelStates).root.outer.all,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          history: {
            recent: {
              default: ({ target }) =>
                target({
                  states: {
                    outer: {
                      data: new Checkout({ orderId: "fallback" }),
                      decoded: true,
                      states: {
                        all: {
                          data: new Payment({ attempt: 1 }),
                          decoded: true,
                          states: {
                            shipping: { data: new Shipping({ address: "" }), decoded: true },
                            card: { data: new CardEntry({ cardNumber: "" }), decoded: true }
                          }
                        }
                      }
                    }
                  }
                })
            }
          },
          states: {
            all: {
              states: { shipping: {}, card: {} },
              initial: {
                shipping: ({ state }) => {
                  expect(state).type.toBe<Payment>()
                  return { address: String(state.attempt) }
                },
                card: { cardNumber: "" }
              }
            }
          }
        },
        support: {}
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(ParallelStates).root.outer,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        outer: {
          initial: {
            target: Machine.targets(ParallelStates).root.outer.all,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            all: {
              initial: {
                shipping: () => {
                  throw new Error("type-only constructor")
                },
                card: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        outer: {
          states: {
            all: { initial: { shipping: { address: "missing-card" } } }
          },
          initial: {
            target: Machine.targets(ParallelStates).root.outer.all,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: Machine.targets(ParallelStates).root.outer,
        data: () => {
          throw new Error("type-only constructor")
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
