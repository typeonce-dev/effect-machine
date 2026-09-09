import { Context, Effect, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
describe("Machine", () => {
  class Up extends Schema.TaggedClass<Up>("Up")("Up", {
    id: Schema.String
  }) {
  }
  class Down extends Schema.TaggedClass<Down>("Down")("Down", {}) {
  }
  class RetaggedUp extends Schema.TaggedClass<RetaggedUp>("RetaggedUp")("RetaggedUp", {
    id: Schema.String,
    attempt: Schema.Number
  }) {
  }
  class Auth extends Schema.TaggedClass<Auth>("Auth")("Auth", {
    userId: Schema.String
  }) {
  }
  class SignedOut extends Schema.TaggedClass<SignedOut>("SignedOut")("SignedOut", {}) {
  }
  class SignedIn extends Schema.TaggedClass<SignedIn>("SignedIn")("SignedIn", {
    userId: Schema.String
  }) {
  }
  class Sync extends Schema.TaggedClass<Sync>("Sync")("Sync", {
    enabled: Schema.Boolean
  }) {
  }
  class SyncIdle extends Schema.TaggedClass<SyncIdle>("SyncIdle")("SyncIdle", {}) {
  }
  class Syncing extends Schema.TaggedClass<Syncing>("Syncing")("Syncing", {
    requestId: Schema.String
  }) {
  }
  class Payment extends Schema.TaggedClass<Payment>("Payment")("Payment", {}) {
  }
  class PendingPayment extends Schema.TaggedClass<PendingPayment>("PendingPayment")("PendingPayment", {}) {
  }
  class ApprovedPayment extends Schema.TaggedClass<ApprovedPayment>("ApprovedPayment")("ApprovedPayment", {
    authId: Schema.String
  }) {
  }
  class DeclinedPayment extends Schema.TaggedClass<DeclinedPayment>("DeclinedPayment")("DeclinedPayment", {
    reason: Schema.String
  }) {
  }
  class SignIn extends Schema.TaggedClass<SignIn>("SignIn")("SignIn", {
    userId: Schema.String
  }) {
  }
  class SignInCompleted extends Schema.TaggedClass<SignInCompleted>("SignInCompleted")("SignInCompleted", {
    userId: Schema.String
  }) {
  }
  class InitialRequirement extends Context.Service<InitialRequirement, {
    readonly initialMessage: string
  }>()("test/Machine/InitialRequirement") {
  }
  class EntryRequirement extends Context.Service<EntryRequirement, {
    readonly entryMessage: string
  }>()("test/Machine/EntryRequirement") {
  }
  class DoneRequirement extends Context.Service<DoneRequirement, {
    readonly doneMessage: string
  }>()("test/Machine/DoneRequirement") {
  }
  class DeferredRequirement extends Context.Service<DeferredRequirement, {
    readonly deferredMessage: string
  }>()("test/Machine/DeferredRequirement") {
  }
  const UpStates = Machine.state({
    states: {
      up: {
        schema: Up,
        type: "parallel",
        states: {
          auth: {
            schema: Auth,
            states: {
              signedOut: SignedOut,
              signedIn: SignedIn
            }
          },
          sync: {
            schema: Sync,
            states: {
              idle: SyncIdle,
              syncing: Syncing
            }
          }
        }
      },
      down: Down
    }
  })
  const NestedParallelStates = Machine.state({
    states: {
      root: {
        schema: Up,

        states: {
          idle: Down,
          work: {
            schema: Payment,
            type: "parallel",
            states: {
              auth: {
                schema: Auth,

                states: {
                  signedOut: SignedOut,
                  signedIn: SignedIn
                }
              },
              sync: {
                schema: Sync,

                states: {
                  idle: SyncIdle,
                  syncing: Syncing
                }
              }
            }
          }
        }
      }
    }
  })
  type ChildBuilder<Method> = Method extends {
    readonly decoded: (value: any, build: (builder: infer Builder) => any) => any
  } ? Builder :
    never
  type IsCallable<A> = A extends (...args: ReadonlyArray<any>) => any ? true : false
  const UpInitial = null as unknown as Machine.Machine.FullTargetBuilder<typeof UpStates.node.states>["up"]
  const DownInitial = null as unknown as Machine.Machine.FullTargetBuilder<typeof UpStates.node.states>["down"]
  type SignInContext = Machine.Machine.HandlerContext<
    {
      readonly "": typeof UpStates.node
    },
    readonly [
      typeof SignIn
    ],
    [],
    "down",
    "SignIn",
    never,
    never
  >
  type SignedOutContext = Machine.Machine.HandlerContext<
    {
      readonly "": typeof UpStates.node
    },
    readonly [
      typeof SignIn
    ],
    [],
    "up.auth.signedOut",
    "SignIn",
    never,
    never
  >
  type AuthContext = Machine.Machine.HandlerContext<
    {
      readonly "": typeof UpStates.node
    },
    readonly [
      typeof SignIn
    ],
    [],
    "up.auth",
    "SignIn",
    never,
    never
  >
  type NestedIdleContext = Machine.Machine.HandlerContext<
    {
      readonly "": typeof NestedParallelStates.node
    },
    readonly [
      typeof SignIn
    ],
    [],
    "root.idle",
    "SignIn",
    never,
    never
  >
  type NestedActiveContext = Machine.Machine.HandlerContext<
    {
      readonly "": typeof NestedParallelStates.node
    },
    readonly [
      typeof SignIn
    ],
    [],
    "root.work.auth.signedOut",
    "SignIn",
    never,
    never
  >
  it("states preserves literal state paths", () => {
    expect<
      Machine.Machine.StateIdentifier<{
        readonly "": typeof UpStates.node
      }>
    >().type.toBe<
      | ""
      | "up"
      | "up.auth"
      | "up.auth.signedOut"
      | "up.auth.signedIn"
      | "up.sync"
      | "up.sync.idle"
      | "up.sync.syncing"
      | "down"
    >()
  })
  it("constructs exact public and internal event instructions from protocol descriptors", () => {
    const Event = Schema.TaggedUnion({
      Tick: { amount: Schema.Number },
      Stop: {}
    })
    class Internal extends Schema.TaggedClass<Internal>("ConstructedInternal")("ConstructedInternal", {
      id: Schema.String
    }) {
    }
    const State = Schema.TaggedStruct("ConstructedEventState", {})
    const States = Machine.state({ states: { State } })
    const Events = Machine.eventsFromSchemas(Event)
    const InternalEvents = Machine.internalEventsFromSchemas(Internal)
    Machine.make({
      root: States,
      events: Events,
      internalEvents: InternalEvents
    }).handle({
      initial: {
        target: Machine.targets(States).root.State,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: { State: {} }
    })
    expect(Events.Tick({ amount: 1 })).type.toBe<Machine.Machine.EventConstruction<typeof Event.cases.Tick.Type>>()
    expect(Events.Stop()).type.toBe<Machine.Machine.EventConstruction<typeof Event.cases.Stop.Type>>()
    expect(InternalEvents.ConstructedInternal({ id: "internal-1" })).type.toBe<
      Machine.Machine.EventConstruction<Internal>
    >()
    expect<Machine.EventOf<typeof Events>>().type.toBe<typeof Event.Type>()
    expect(Events.Tick).type.not.toBeCallableWith()
    expect(Events.Tick).type.not.toBeCallableWith({ amount: "1" })
    expect(InternalEvents.ConstructedInternal).type.not.toBeCallableWith({})
  })
  it("machine contexts expose type-safe parent state values", () => {
    const nested = null as unknown as SignedOutContext
    expect(nested.containingState).type.toBe<Auth>()
    expect(nested.ancestors).type.toBe<{
      readonly up: Up
      readonly "up.auth": Auth
    }>()
    expect(nested.ancestors.up).type.toBe<Up>()
    expect(nested.ancestors["up.auth"]).type.toBe<Auth>()
    expect(nested.ancestors).type.not.toHaveProperty("up.sync")
    expect(nested).type.not.toHaveProperty("action")
    type NestedParents = {
      readonly up: Up
      readonly "up.auth": Auth
    }
    expect<
      Machine.Machine.StateActionContext<
        {
          readonly "": typeof UpStates.node
        },
        readonly [
          typeof SignIn
        ],
        [],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()
    expect<
      Machine.Machine.InvokeContext<
        {
          readonly "": typeof UpStates.node
        },
        readonly [
          typeof SignIn
        ],
        [],
        "up.auth.signedOut"
      >["containingState"]
    >().type.toBe<Auth>()
    expect<
      Machine.Machine.InvokeContext<
        {
          readonly "": typeof UpStates.node
        },
        readonly [
          typeof SignIn
        ],
        [],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()
    expect<
      Machine.Machine.AlwaysContext<
        {
          readonly "": typeof UpStates.node
        },
        readonly [
          typeof SignIn
        ],
        [],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()
    expect<
      Machine.Machine.DoneContext<
        {
          readonly "": typeof UpStates.node
        },
        readonly [
          typeof SignIn
        ],
        [],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()
    expect<
      Machine.Machine.FinalOutputContext<
        {
          readonly "": typeof UpStates.node
        },
        readonly [
          typeof SignIn
        ],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()
    expect<
      Machine.Machine.ParallelOutputContext<
        {
          readonly "": typeof UpStates.node
        },
        readonly [
          typeof SignIn
        ],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()
    const root = null as unknown as SignInContext
    expect(root.containingState).type.toBe<undefined>()
    expect(root.ancestors).type.toBe<{}>()
    expect<
      Machine.Machine.ParentStateValue<{
        readonly "": typeof UpStates.node
      }, "up.auth.signedOut" | "down">
    >().type.toBe<Auth | undefined>()
  })
  it("states selects state values and snapshots with type-safe paths", () => {
    const childSnapshot = UpInitial.decoded(new Up({ id: "up-1" }), (up) =>
      up
        .auth.decoded(new Auth({ userId: "guest" }), (auth) => auth.signedOut.decoded(new SignedOut({})))
        .sync.decoded(new Sync({ enabled: true }), (sync) => sync.idle.decoded(new SyncIdle({}))))
    const snapshot = { path: "" as const, value: undefined, state: childSnapshot }
    expect(UpStates.get(snapshot, "up")).type.toBe<Option.Option<Up>>()
    expect(UpStates.get(snapshot, "up.auth.signedOut")).type.toBe<Option.Option<SignedOut>>()
    expect(UpStates.getWithParents(snapshot, "up.auth.signedOut")).type.toBe<
      Option.Option<{
        readonly value: SignedOut
        readonly parents: {
          readonly up: Up
          readonly "up.auth": Auth
        }
      }>
    >()
    expect(UpStates.getWithParents(snapshot, "up")).type.toBe<
      Option.Option<{
        readonly value: Up
        readonly parents: {}
      }>
    >()
    const path = "down" as "up.auth.signedOut" | "down"
    expect(UpStates.getWithParents(snapshot, path)).type.toBe<
      Option.Option<
        {
          readonly value: SignedOut
          readonly parents: {
            readonly up: Up
            readonly "up.auth": Auth
          }
        } | {
          readonly value: Down
          readonly parents: {}
        }
      >
    >()
    expect(UpStates.getSnapshot(snapshot, "up.auth")).type.toBe<
      Option.Option<
        Machine.Machine.SnapshotByIdentifier<{
          readonly "": typeof UpStates.node
        }, "up.auth">
      >
    >()
    expect(UpStates.matches(snapshot, "up.sync.idle")).type.toBe<boolean>()
    expect(UpStates.get).type.not.toBeCallableWith(snapshot, "up.missing")
    expect(UpStates.getWithParents).type.not.toBeCallableWith(snapshot, "up.missing")
    const upSnapshot = Option.getOrThrow(UpStates.getSnapshot(snapshot, "up"))
    const authSnapshot = Option.getOrThrow(UpStates.getSnapshot(upSnapshot, "up.auth"))
    expect(UpStates.get(upSnapshot, "up.auth.signedOut")).type.toBe<Option.Option<SignedOut>>()
    expect(UpStates.getSnapshot(upSnapshot, "up.sync")).type.toBe<
      Option.Option<
        Machine.Machine.SnapshotByIdentifier<{
          readonly "": typeof UpStates.node
        }, "up.sync">
      >
    >()
    expect(UpStates.matches(authSnapshot, "up.auth.signedIn")).type.toBe<boolean>()
    expect(UpStates.get(authSnapshot, "up.auth")).type.toBe<Option.Option<Auth>>()
    expect(UpStates.get).type.not.toBeCallableWith(authSnapshot, "up.sync.idle")
    expect(UpStates.getSnapshot).type.not.toBeCallableWith(authSnapshot, "up")
    expect(UpStates.matches).type.not.toBeCallableWith(authSnapshot, "signedOut")
    expect(UpStates.matches).type.not.toBeCallableWith(authSnapshot, "down")
    const other = { path: "other" as const, value: new Down({}) }
    expect(UpStates.get).type.not.toBeCallableWith(other, "up")
    expect(UpStates.getWithParents).type.not.toBeCallableWith(other, "up")
  })
  it("states preserves declared compound initial keys", () => {
    expect(UpStates.node.states.up.states.auth).type.not.toHaveProperty("initial")
    expect(UpStates.node.states.up.states.sync).type.not.toHaveProperty("initial")
  })
  it("make accepts defined states", () => {
    const machine = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    }).handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {}
      }
    })
    expect(machine.root).type.toBe<typeof UpStates>()
  })
  it("make rejects raw decoded initial states", () => {
    expect(Machine.make).type.not.toBeCallableWith({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn),
      initial: () => new Down({})
    })
  })
  it("encodes and decodes snapshots with typed effects", () => {
    const machine = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    }).handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {}
      }
    })
    const encoded = Machine.encodeSnapshot(machine, {
      path: "" as const,
      value: undefined,
      state: DownInitial.decoded(new Down({}))
    })
    expect<Effect.Success<typeof encoded>>().type.toBe<Machine.Machine.EncodedSnapshot>()
    expect<Effect.Error<typeof encoded>>().type.toBe<Machine.MachineSchemaEncodeError>()
    expect<Effect.Services<typeof encoded>>().type.toBe<never>()
    const decoded = Machine.decodeSnapshot(machine, {
      version: 2,
      _tag: "MachineSnapshot",
      active: [{ path: "" }, { path: "down", value: { _tag: "Down" } }]
    })
    expect<Effect.Success<typeof decoded>>().type.toBe<Machine.Snapshot<typeof UpStates>>()
    expect<Effect.Error<typeof decoded>>().type.toBe<Machine.MachineSchemaDecodeError>()
    expect<Effect.Services<typeof decoded>>().type.toBe<never>()
  })
  it("planInitial is synchronous at the transition boundary", () => {
    const definition = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    const machine = definition.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: { entry: () => {} }
      }
    })
    const planned = Machine.planInitial(machine)
    expect<Effect.Services<typeof planned>>().type.toBe<never>()
    expect<Effect.Success<typeof planned>["commands"]>().type.toBe<ReadonlyArray<Machine.Command>>()
    expect(definition.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
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
        down: { entry: () => Effect.void },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine).type.not.toHaveProperty("handle")
  })
  it("types the closed enqueue protocol without exposing Effects", () => {
    const worker = Machine.childAddress<SignIn>("worker")
    const targets1 = Machine.targets(UpStates)
    const machine = Machine.make({
      branches: { transition1: { destination: { target: targets1.root.down } } },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn),
      emittedEvents: Machine.emittedEventsFromSchemas(SignInCompleted)
    }).handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            SignIn: {
              branches: "transition1",
              resolve: ({ event, select: { destination: target } }, enqueue) => {
                expect(enqueue.raise).type.toBeCallableWith(event)
                expect(enqueue.raise).type.not.toBeCallableWith(new Down({}))
                expect(enqueue.emit).type.toBeCallableWith(new SignInCompleted({ userId: event.userId }))
                expect(enqueue.emit).type.not.toBeCallableWith(event)
                expect(enqueue.sendTo).type.toBeCallableWith(worker, event)
                expect(enqueue.sendTo).type.not.toBeCallableWith(worker, new Down({}))
                expect(enqueue.stop).type.toBeCallableWith(worker)
                expect(enqueue.stop).type.not.toBeCallableWith("worker")
                return target.decoded(new Down({}))
              }
            }
          }
        }
      }
    })
    expect<Machine.Machine.Error<typeof machine>>().type.toBe<never>()
    expect<Machine.Machine.Services<typeof machine>>().type.toBe<never>()
  })
  it("spawn accepts reusable logic rather than one-shot Effects", () => {
    const logic = Machine.logic({
      initial: undefined,
      run: () => Effect.as(DeferredRequirement, 1 as const)
    })
    expect(Machine.spawn).type.toBeCallableWith(logic)
    expect(Machine.spawn).type.not.toBeCallableWith(Effect.succeed(1))
  })
  it("logic exposes public machine-scoped context types", () => {
    Machine.logic<number, SignIn>({
      initial: (scope) => {
        const worker = Machine.childAddress<SignIn>("worker")
        const incompatibleWorker = Machine.childAddress<Down>("incompatible-worker")
        const child = Machine.logic<number, SignIn>({ initial: 0, run: () => Effect.never })
        expect(scope).type.toBe<Machine.Logic.Scope<SignIn>>()
        expect(scope.self).type.toBe<Machine.Logic.Address<SignIn>>()
        expect(scope.spawn).type.toBeCallableWith(child, { id: worker })
        expect(scope.spawn).type.not.toBeCallableWith(child, { id: incompatibleWorker })
        expect(scope.sendTo).type.toBeCallableWith(worker, new SignIn({ userId: "user-1" }))
        expect(scope.sendTo).type.not.toBeCallableWith(worker, new Down({}))
        expect(scope.sendTo).type.not.toBeCallableWith("worker", new SignIn({ userId: "user-1" }))
        expect(scope.stopChild).type.toBeCallableWith(worker)
        expect(scope.stopChild).type.not.toBeCallableWith("worker")
        return Effect.succeed(0)
      },
      run: (context) => {
        expect(context).type.toBe<Machine.Logic.Context<number, SignIn>>()
        return Effect.void
      }
    })
  })
  it("invoke infers one-shot outputs from factories in the owning state", () => {
    expect(Machine).type.not.toHaveProperty("invoke")
    const targets2 = Machine.targets(UpStates)
    const machine = Machine.make({
      effects: { source1: Effect.suspend(() => Effect.succeed(1)) },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          invoke: {
            src: "source1",
            id: "valid",
            onDone: { target: targets2.root.down, decoded: true, data: () => (new Down({})) }
          }
        }
      }
    })
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
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
        down: { invoke: { src: "source1" } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    // Lazy Effects are valid registered values; a value source forbids an input mapper.
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        down: { invoke: { src: "source1", input: () => undefined, onDone: { none: true } } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
  it("contextually types dynamic Effect sources through registered invocation sources", () => {
    const targets3 = Machine.targets(UpStates)
    const machine = Machine.make({
      effects: {
        source1: ({ state }: Machine.Machine.InvokeContext<
          {
            readonly "": typeof UpStates.node
          },
          readonly [
            typeof SignIn
          ],
          readonly [],
          "down",
          readonly [
            typeof SignIn
          ],
          readonly []
        >) => {
          expect(state).type.toBe<Down>()
          return Effect.succeed(state._tag)
        }
      },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          invoke: {
            src: "source1",
            id: "dynamic",
            input: (context) => context,
            onDone: { target: targets3.root.down, decoded: true, data: () => (new Down({})) }
          }
        }
      }
    })
  })
  it("infers Stream elements, failures, and services through registered invocation sources", () => {
    class StreamFailure {
      readonly _tag = "StreamFailure"
    }
    const updates: Stream.Stream<1, StreamFailure, EntryRequirement> = Stream.fromEffect(
      Effect.as(EntryRequirement, 1 as const)
    ).pipe(Stream.concat(Stream.fail(new StreamFailure())))
    const machine = Machine.make({
      streams: {
        source1: ({ state }: Machine.Machine.InvokeContext<
          {
            readonly "": typeof UpStates.node
          },
          readonly [
            typeof SignIn
          ],
          readonly [],
          "down",
          readonly [
            typeof SignIn
          ],
          readonly []
        >) => {
          expect(state).type.toBe<Down>()
          return updates
        },
        source2: ({ state }: Machine.Machine.InvokeContext<
          {
            readonly "": typeof UpStates.node
          },
          readonly [
            typeof SignIn
          ],
          readonly [],
          "down",
          readonly [
            typeof SignIn
          ],
          readonly []
        >) => {
          expect(state).type.toBe<Down>()
          return updates
        }
      },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    const handled = machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          invoke: {
            src: "source1",
            id: "updates",
            input: (context) => context,
            onElement: {
              none: true,
              resolve: ({ element }) => {
                expect(element).type.toBe<1>()
              }
            },
            onDone: { none: true },
            onFailure: {
              none: true,
              resolve: ({ error }) => {
                expect(error).type.toBe<StreamFailure>()
              }
            }
          }
        }
      }
    })
    expect<EntryRequirement>().type.toBeAssignableTo<Machine.Machine.Services<typeof handled>>()
    expect<Machine.Machine.Error<typeof handled>>().type.not.toBe<any>()
    const staticHandled = machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          invoke: {
            src: "source2",
            id: "static-updates",
            input: (context) => context,
            onElement: {
              none: true,
              resolve: ({ element }) => {
                expect(element).type.toBe<1>()
              }
            },
            onDone: { none: true },
            onFailure: {
              none: true,
              resolve: ({ error }) => {
                expect(error).type.toBe<StreamFailure>()
              }
            }
          }
        }
      }
    })
    expect<EntryRequirement>().type.toBeAssignableTo<Machine.Machine.Services<typeof staticHandled>>()
    expect<Machine.Machine.Error<typeof staticHandled>>().type.not.toBe<any>()
  })
  it("requires only reachable Stream handlers", () => {
    const machine = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn),
      streams: { values: Stream.make(1), failure: Stream.fail("unavailable" as const) }
    })
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
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
        down: { invoke: { src: "values", onDone: { none: true } } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        down: { invoke: { src: "values", onElement: { none: true } } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        down: { invoke: { src: "failure", onDone: { none: true } } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        down: {
          invoke: { src: "failure", onDone: { none: true }, onFailure: { none: true }, onElement: { none: true } }
        },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
  it("infers dynamic Effect invocation channels from the source return", () => {
    class LoadFailure {
      readonly _tag = "LoadFailure"
    }
    const load = (userId: string) => Effect.fail(new LoadFailure()).pipe(Effect.as({ userId }))
    const machine = Machine.make({
      effects: {
        source1: ({ state }: Machine.Machine.InvokeContext<
          {
            readonly "": typeof UpStates.node
          },
          readonly [
            typeof SignIn
          ],
          readonly [],
          "down",
          readonly [
            typeof SignIn
          ],
          readonly []
        >) => {
          expect(state).type.toBe<Down>()
          return load(state._tag)
        }
      },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          invoke: {
            src: "source1",
            id: "dynamic",
            input: (context) => context,
            onDone: { none: true },
            onFailure: { none: true }
          }
        }
      }
    })
  })
  it("requires only reachable handlers for dynamic Effect invocations", () => {
    class LoadFailure {
      readonly _tag = "LoadFailure"
    }
    const machine = Machine.make({
      effects: {
        source1: ({ state }: Machine.Machine.InvokeContext<
          {
            readonly "": typeof UpStates.node
          },
          readonly [
            typeof SignIn
          ],
          readonly [],
          "down",
          readonly [
            typeof SignIn
          ],
          readonly []
        >) => Effect.succeed(state._tag),
        source2: ({ state }: Machine.Machine.InvokeContext<
          {
            readonly "": typeof UpStates.node
          },
          readonly [
            typeof SignIn
          ],
          readonly [],
          "down",
          readonly [
            typeof SignIn
          ],
          readonly []
        >) => Effect.fail(new LoadFailure()).pipe(Effect.annotateLogs("state", state._tag)),
        source3: ({ state }: Machine.Machine.InvokeContext<
          {
            readonly "": typeof UpStates.node
          },
          readonly [
            typeof SignIn
          ],
          readonly [],
          "down",
          readonly [
            typeof SignIn
          ],
          readonly []
        >) => Effect.never.pipe(Effect.annotateLogs("state", state._tag)),
        source4: ({ state }: Machine.Machine.InvokeContext<
          {
            readonly "": typeof UpStates.node
          },
          readonly [
            typeof SignIn
          ],
          readonly [],
          "down",
          readonly [
            typeof SignIn
          ],
          readonly []
        >) => Effect.as(EntryRequirement, state._tag),
        source5: ({ state }: Machine.Machine.InvokeContext<
          {
            readonly "": typeof UpStates.node
          },
          readonly [
            typeof SignIn
          ],
          readonly [],
          "down",
          readonly [
            typeof SignIn
          ],
          readonly []
        >) => Effect.as(EntryRequirement, state._tag)
      },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          invoke: [
            { src: "source1", id: "success", input: (context) => context, onDone: { none: true } },
            {
              src: "source2",
              id: "failure",
              input: (context) => context,
              onFailure: { none: true }
            },
            { src: "source3", id: "never", input: (context) => context },
            { src: "source4", id: "requirements", input: (context) => context, onDone: { none: true } }
          ]
        }
      }
    })
    const requirementsHandled = machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          invoke: { src: "source5", id: "requirements-only", input: (context) => context, onDone: { none: true } }
        }
      }
    })
    expect<Machine.Machine.Services<typeof requirementsHandled>>().type.not.toBe<any>()
    expect<EntryRequirement>().type.toBeAssignableTo<Machine.Machine.Services<typeof requirementsHandled>>()
    expect<unknown>().type.not.toBeAssignableTo<Machine.Machine.Services<typeof requirementsHandled>>()
  })
  it("rejects unreachable and missing handlers for dynamic Effect invocations", () => {
    const machine = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn),
      effects: {
        success: (_: string) => Effect.succeed("user-1"),
        failure: (_: string) => Effect.fail("unavailable" as const),
        pending: (_: string) => Effect.never
      }
    })
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
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
        down: { invoke: { src: "success", input: () => "id" } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        down: { invoke: { src: "failure", input: () => "id" } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        down: {
          invoke: {
            src: "success",
            input: () => "id",
            onDone: { none: true },
            onFailure: { none: true }
          }
        },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        down: {
          invoke: {
            src: "failure",
            input: () => "id",
            onFailure: { none: true },
            onDone: { none: true }
          }
        },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        down: { invoke: { src: "pending", input: () => "id", onDone: { none: true } } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        down: { invoke: { src: "pending", input: () => "id", onFailure: { none: true } } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: { invoke: { src: "pending", input: () => "id" } }
      }
    })
  })
  it("separates public input events from the complete internal protocol", () => {
    const machine = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn),
      internalEvents: Machine.internalEventsFromSchemas(SignInCompleted)
    }).handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            SignIn: {
              none: true,
              resolve: ({ event }) => {
                expect(event).type.toBe<SignIn>()
                return undefined
              }
            },
            SignInCompleted: {
              none: true,
              resolve: ({ event }) => {
                expect(event).type.toBe<SignInCompleted>()
                return undefined
              }
            }
          }
        }
      }
    })
    const started = Machine.start(machine)
    type Ref = Effect.Success<typeof started>
    expect(machine).type.not.toHaveProperty("eventSchemas")
    const anyMachine: Machine.Machine.Any = machine
    expect(anyMachine).type.not.toHaveProperty("eventSchemas")
    expect<Machine.Machine.InputEvent<typeof machine>>().type.toBe<SignIn>()
    expect<Machine.Machine.Event<typeof machine>>().type.toBe<SignIn | SignInCompleted>()
    expect<Parameters<Ref["send"]>[0]>().type.toBe<Machine.Machine.EventInput<SignIn>>()
    expect(Machine.plan).type.toBeCallableWith(machine, {
      path: "" as const,
      value: undefined,
      state: DownInitial.decoded(new Down({}))
    }, new SignIn({ userId: "user-1" }))
    expect(Machine.plan).type.not.toBeCallableWith(machine, {
      path: "" as const,
      value: undefined,
      state: DownInitial.decoded(new Down({}))
    }, new SignInCompleted({ userId: "user-1" }))
    expect(Machine.can).type.toBeCallableWith(machine, {
      path: "" as const,
      value: undefined,
      state: DownInitial.decoded(new Down({}))
    }, new SignInCompleted({ userId: "user-1" }))
    expect(Machine.can(machine)).type.toBeCallableWith({
      path: "" as const,
      value: undefined,
      state: DownInitial.decoded(new Down({}))
    }, new SignInCompleted({ userId: "user-1" }))
    expect(Machine.can(machine)).type.not.toBeCallableWith({
      path: "" as const,
      value: undefined,
      state: DownInitial.decoded(new Down({}))
    }, { _tag: "Undeclared" })
    const publicEvents = Machine.eventsFromSchemas(SignIn)
    const overlappingInternalEvents = Machine.internalEventsFromSchemas(SignIn)
    expect(Machine.make).type.not.toBeCallableWith({
      root: UpStates,
      events: publicEvents,
      internalEvents: overlappingInternalEvents
    })
    expect(Machine.events).type.not.toBeCallableWith(SignIn, SignIn)
    expect(Machine.internalEvents).type.not.toBeCallableWith(SignInCompleted, SignInCompleted)
  })
  it("invoke requires only the lifecycle handlers reachable from the source type", () => {
    const erasedFailure = () => Effect.fail("unavailable" as const) as Effect.Effect<never, any>
    const machine = Machine.make({
      effects: { source1: Effect.suspend(erasedFailure) },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn),
      internalEvents: Machine.internalEventsFromSchemas(SignInCompleted)
    })
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
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
        down: { invoke: { src: "source1" } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        down: { invoke: { src: "source1", onDone: { none: true } } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: { invoke: { src: "source1", id: "erased-failure", onFailure: { none: true } } }
      }
    })
  })
  it("constructs sibling targets from destructured source fields", () => {
    const states = Machine.state({ states: { source: Up, target: RetaggedUp } })
    const targets9 = Machine.targets(states)
    Machine.make({
      branches: { transition1: { destination: { target: targets9.root.target } } },
      root: states,
      events: Machine.eventsFromSchemas(SignIn)
    }).handle({
      initial: {
        target: Machine.targets(states).root.source,
        decoded: true,
        data: new Up({ id: "up-1" })
      },
      states: {
        source: {
          on: {
            SignIn: {
              branches: "transition1",
              resolve: ({ state, select: { destination: target } }) => {
                const { _tag: _, ...fields } = state
                expect(target.from).type.toBeCallableWith({ ...fields, attempt: 1 })
                expect(target.from).type.not.toBeCallableWith(fields)
                expect(target.from).type.not.toBeCallableWith({ ...fields, attempt: "invalid" })
                return target.from({ ...fields, attempt: 1 })
              }
            }
          }
        },
        target: {}
      }
    })
  })
  it("child invocation composes complete machines with type-safe protocols", () => {
    const ChildInput = Schema.Struct({ userId: Schema.String })
    const childStates = Machine.state({
      states: {
        done: {
          schema: Down,
          type: "final",
          output: SignIn
        }
      }
    })
    const child = Machine.make({
      root: childStates,
      events: Machine.eventsFromSchemas(SignIn),
      emittedEvents: Machine.emittedEventsFromSchemas(SignIn),
      input: ChildInput
    }).handle({
      initial: {
        target: Machine.targets(childStates).root.done,
        decoded: true,
        data: new Down({})
      },
      states: { done: { output: () => new SignIn({ userId: "child" }) } }
    })
    const Child = Machine.child("child", child)
    expect(Machine.sendTo).type.toBeCallableWith(Child, new SignIn({ userId: "child" }))
    expect(Machine.sendTo).type.not.toBeCallableWith(Child, new Down({}))
    const parent = Machine.make({
      children: { source1: Child },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    parent.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          invoke: {
            src: "source1",
            input: () => ({ userId: "child" }),
            onSnapshot: {
              none: true,
              resolve: ({ snapshot }) => {
                expect(snapshot.state).type.toBe<Machine.Snapshot<typeof childStates>>()
                return undefined
              }
            },
            onDone: {
              none: true,
              resolve: ({ output, state }) => {
                expect(output).type.toBe<SignIn>()
                expect(state).type.toBe<Down>()
                return undefined
              }
            }
          }
        }
      }
    })
    expect(parent.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      }
    })
    expect(parent.handle).type.not.toBeCallableWith({
      states: {
        down: { invoke: { child: Child, onDone: () => undefined } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(parent.handle).type.not.toBeCallableWith({
      states: {
        down: { invoke: { src: "source1", input: () => ({ userId: "child" }), onDone: () => new Down({}) } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(parent.handle).type.not.toBeCallableWith({
      states: {
        down: {
          invoke: {
            src: "source1",
            input: () => ({ userId: "child" }),
            onDone: { none: true },
            onSnapshot: () => new Down({})
          }
        },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
  it("types nested invocation output handlers against their owning state", () => {
    const machine = Machine.make({
      effects: { source1: Effect.suspend(() => Effect.succeed(Option.some(1))) },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                signedOut: { invoke: { src: "source1", id: "nested", onDone: { none: true } } },
                signedIn: {}
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {}
      }
    })
  })
  it("typed child addresses enforce their event protocol", () => {
    const worker = Machine.childAddress<SignIn>("worker")
    const inert = Machine.childAddress("inert")
    const child = Machine.logic<number, SignIn>({ initial: 0, run: () => Effect.never })
    expect(Machine.child).type.not.toBeCallableWith("worker")
    expect<Machine.ChildAddress.Event<typeof inert>>().type.toBe<never>()
    expect(Machine.sendTo).type.toBeCallableWith(worker, new SignIn({ userId: "user-1" }))
    expect(Machine.sendTo).type.not.toBeCallableWith(worker, new Down({}))
    expect(Machine.sendTo).type.not.toBeCallableWith(inert, new SignIn({ userId: "user-1" }))
    expect(Machine.sendTo).type.not.toBeCallableWith("worker", new SignIn({ userId: "user-1" }))
    expect(Machine.stopChild).type.toBeCallableWith(worker)
    expect(Machine.stopChild).type.not.toBeCallableWith("worker")
    expect(Machine.spawn).type.toBeCallableWith(child, { id: worker })
    expect(Machine.spawn).type.not.toBeCallableWith(
      Machine.logic<number, Down>({ initial: 0, run: () => Effect.never }),
      { id: worker }
    )
  })
  it("keeps child startup failures out of successfully spawned refs", () => {
    const child = Machine.logic<number, SignIn, void, "child-runtime", never, "child-start">({
      initial: () => Effect.fail("child-start" as const),
      run: () => Effect.fail("child-runtime" as const)
    })
    const spawned = Machine.spawn(child)
    expect<Effect.Error<typeof spawned>>().type.toBe<"child-start">()
    expect<Effect.Error<Effect.Success<typeof spawned>["join"]>>().type.toBe<"child-runtime" | Machine.StoppedError>()
  })
  it("start exposes machine infrastructure failure channels", () => {
    const targets12 = Machine.targets(UpStates)
    const machine = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    }).handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            SignIn: { target: targets12.root.down, decoded: true, data: () => (new Down({})) }
          }
        }
      }
    })
    const started = Machine.start(machine)
    expect<Effect.Error<typeof started>>().type.toBe<
      Machine.MachineSchemaDecodeError | Machine.StartupError | Machine.InfiniteTransitionError | Machine.StoppedError
    >()
    expect<Effect.Error<Effect.Success<typeof started>["join"]>>().type.toBe<
      Machine.InfiniteTransitionError | Machine.MachineSchemaDecodeError | Machine.StoppedError
    >()
    const Child = Machine.child("failure-child", machine)
    type ChildError = Effect.Error<Machine.ChildMachine.Ref<typeof Child>["join"]>
    expect<ChildError>().type.toBe<
      Machine.InfiniteTransitionError | Machine.MachineSchemaDecodeError | Machine.StoppedError
    >()
    expect<
      Machine.Machine.InvokeRuntimeError<{
        readonly child: typeof Child
      }>
    >().type.toBe<Machine.InfiniteTransitionError | Machine.MachineSchemaDecodeError | Machine.StoppedError>()
  })
  it("plan and getters require snapshots", () => {
    const machine = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    }).handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {}
      }
    })
    expect(Machine.plan).type.toBeCallableWith(
      machine,
      { path: "" as const, value: undefined, state: DownInitial.decoded(new Down({})) },
      new SignIn({
        userId: "user-1"
      })
    )
    const planned = Machine.plan(machine, {
      path: "" as const,
      value: undefined,
      state: DownInitial.decoded(new Down({}))
    }, new SignIn({ userId: "user-1" }))
    expect<Effect.Error<typeof planned>>().type.toBe<
      Machine.InfiniteTransitionError | Machine.MachineSchemaDecodeError
    >()
    expect(Machine.enabled).type.toBeCallableWith(machine, {
      path: "" as const,
      value: undefined,
      state: DownInitial.decoded(new Down({}))
    })
    expect(Machine.isFinal).type.toBeCallableWith(machine, {
      path: "" as const,
      value: undefined,
      state: DownInitial.decoded(new Down({}))
    })
    const can = Machine.can(
      machine,
      { path: "" as const, value: undefined, state: DownInitial.decoded(new Down({})) },
      new SignIn({ userId: "user-1" })
    )
    const canMachine = Machine.can(machine)
    expect<Effect.Success<typeof can>>().type.toBe<boolean>()
    expect<Effect.Error<typeof can>>().type.toBe<Machine.MachineSchemaDecodeError>()
    expect(canMachine).type.toBeCallableWith({
      path: "" as const,
      value: undefined,
      state: DownInitial.decoded(new Down({}))
    }, new SignIn({ userId: "user-1" }))
    expect(Machine.plan).type.not.toBeCallableWith(machine, new Down({}), new SignIn({ userId: "user-1" }))
    expect(Machine.can).type.not.toBeCallableWith(machine, new Down({}), new SignIn({ userId: "user-1" }))
    expect(canMachine).type.not.toBeCallableWith(new Down({}), new SignIn({ userId: "user-1" }))
    expect(Machine.enabled).type.not.toBeCallableWith(machine, new Down({}))
    expect(Machine.isFinal).type.not.toBeCallableWith(machine, new Down({}))
  })
  it("handlers reject raw decoded state returns", () => {
    const machine = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    expect<IsCallable<typeof machine.handle>>().type.toBe<true>()
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
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
        down: {
          on: {
            SignIn: () => new Down({})
          }
        },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        down: {
          on: {
            SignIn: () => Effect.succeed(new Down({}))
          }
        },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
  it("branching transitions infer unbounded named targets", () => {
    const targets13 = Machine.targets(UpStates)
    const machine = Machine.make({
      branches: {
        transition1: {
          recognized: { target: targets13.root.down, title: "recognized user" },
          measured: { none: true, title: "measured user id" },
          named: { target: targets13.root.down, title: "named user" },
          active: { none: true, title: "active user" }
        },
        transition2: { accepted: { target: targets13.root.down }, consumed: { none: true } },
        transition3: { ignored: { none: true } }
      },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            SignIn: {
              branches: "transition1",
              reenter: true,
              resolve: ({ event, select, state }) => {
                expect(event).type.toBe<SignIn>()
                expect(state).type.toBe<Down>()
                expect(select.recognized.decoded).type.toBeCallableWith(new Down({}))
                expect(select.measured).type.toBeCallableWith()
                switch (event.userId.length) {
                  case 0:
                    return select.measured()
                  case 1:
                    return select.named.decoded(new Down({}))
                  case 2:
                    return select.active()
                  default:
                    return select.recognized.decoded(new Down({}))
                }
              }
            }
          }
        }
      }
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            SignIn: { none: true, reenter: true }
          },
          // @ts-expect-error! Unconditional eventless reentry cannot stabilize.
          always: { none: true, reenter: true }
        }
      }
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            // @ts-expect-error!
            SignIn: { target: targets13.root.up }
          }
        }
      }
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            SignIn: {
              branches: "transition2",
              resolve: (context) => {
                expect(context.decline()).type.toBe<Machine.Machine.Declined>()
                if (context.event.userId === "decline") {
                  return context.decline()
                }
                if (context.event.userId === "consume") {
                  return context.select.consumed()
                }
                return context.select.accepted.decoded(new Down({}))
              },
              declinable: true
            }
          }
        }
      }
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            SignIn: {
              none: true,
              resolve: (context) => {
                expect(context.decline).type.toBeCallableWith()
              }
            }
          }
        }
      }
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            // @ts-expect-error!
            SignIn: { none: true, resolve: ({ decline }) => decline() }
          }
        }
      }
    })
    const widenedDeclinable = true as boolean
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            // @ts-expect-error!
            SignIn: { none: true, resolve: () => undefined, declinable: widenedDeclinable }
          }
        }
      }
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            // @ts-expect-error!
            SignIn: { branches: "transition3", resolve: () => undefined }
          }
        }
      }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn),
      branches: { invalid: {} }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn),
      branches: { invalid: { "": { none: true } } }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn),
      branches: { invalid: { 0: { none: true } } }
    })
    const symbolBranch = Symbol("branch")
    expect(Machine.make).type.not.toBeCallableWith({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn),
      branches: { invalid: { valid: { none: true }, [symbolBranch]: { none: true } } }
    })
  })
  it("handle accepts nested states through reserved states objects", () => {
    const targets14 = Machine.targets(UpStates)
    const machine = Machine.make({
      branches: { transition1: { destination: { target: targets14.root.up.auth.signedIn } } },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                signedOut: {
                  on: {
                    SignIn: {
                      branches: "transition1",
                      resolve: ({ event, state, select: { destination: target } }) => {
                        expect(event).type.toBe<SignIn>()
                        expect(state).type.toBe<SignedOut>()
                        return target.decoded(new SignedIn({ userId: event.userId }))
                      }
                    }
                  }
                },
                signedIn: {}
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {}
      }
    })
  })
  it("handle accepts parent config and child config in the same object", () => {
    const targets15 = Machine.targets(UpStates)
    const machine = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    machine.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          entry: ({ event, state }) => {
            const id: string = state.id
            expect(event).type.toBe<SignIn | Machine.InitialEvent>()
            if (Machine.isInitialEvent(event)) {
              expect(event._tag).type.toBe<typeof Machine.InitialEventTypeId>()
            } else {
              expect(event.userId).type.toBe<string>()
            }
            void id
          },
          always: {
            none: true,
            resolve: ({ event }) => {
              expect(event).type.toBe<SignIn | Machine.InitialEvent>()
              return undefined
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                signedOut: {
                  on: {
                    SignIn: {
                      target: targets15.root.up.auth.signedIn,
                      decoded: true,
                      data: ({ event }) => (new SignedIn({ userId: event.userId }))
                    }
                  }
                },
                signedIn: {}
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                idle: {
                  entry: ({ state }) => {
                    const tag: "SyncIdle" = state._tag
                    void tag
                  }
                },
                syncing: {}
              }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {}
      }
    })
  })
  it("onDone handlers receive typed state context without Effect requirements", () => {
    const targets16 = Machine.targets(UpStates)
    const machine = Machine.make({
      branches: { transition1: { destination: { target: targets16.root.down } } },
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    }).handle({
      initial: {
        target: Machine.targets(UpStates).root.up,
        decoded: true,
        data: new Up({ id: "up-1" })
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              onDone: {
                branches: "transition1",
                resolve: ({ event, output, state, select: { destination: target } }) => {
                  expect(event).type.toBe<SignIn | Machine.InitialEvent>()
                  expect(output).type.toBe<undefined>()
                  expect(state).type.toBe<Auth>()
                  return target.decoded(new Down({}))
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                decoded: true,
                data: new SyncIdle({})
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {}
      }
    })
    const planned = Machine.plan(machine, {
      path: "" as const,
      value: undefined,
      state: UpInitial.decoded(new Up({ id: "up-1" }), (up) =>
        up
          .auth.decoded(new Auth({ userId: "user-1" }), (auth) => auth.signedOut.decoded(new SignedOut({})))
          .sync.decoded(new Sync({ enabled: true }), (sync) => sync.idle.decoded(new SyncIdle({}))))
    }, new SignIn({ userId: "user-1" }))
    expect<Effect.Services<typeof planned>>().type.toBe<never>()
  })
  it("handle rejects old property and callback APIs", () => {
    const machine = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    expect(machine.handle).type.not.toHaveProperty("up")
    expect(machine.handle).type.not.toBeCallableWith("up.auth.signedOut", {
      on: {}
    })
    expect(machine.handle).type.not.toBeCallableWith((up: unknown) => up)
  })
  it("allows independent implementations but removes handle from each result", () => {
    const definition = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    const first = definition.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {}
      }
    })
    const second = definition.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {}
      }
    })
    expect(definition).type.toHaveProperty("handle")
    expect(first).type.not.toHaveProperty("handle")
    expect(second).type.not.toHaveProperty("handle")
  })
  it("final output callbacks receive lifecycle events", () => {
    const InitialRoot1 = Machine.state({
      states: {
        down: {
          schema: Down,
          type: "final",
          output: Schema.Void
        }
      }
    })
    const machine = Machine.make({
      root: InitialRoot1,
      events: Machine.eventsFromSchemas(SignIn)
    }).handle({
      initial: {
        target: Machine.targets(InitialRoot1).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        down: {
          output: ({ event }) => {
            expect(event).type.toBe<SignIn | Machine.InitialEvent>()
          }
        }
      }
    })
    expect(machine).type.toBeAssignableTo<Machine.Machine.Any>()
  })
  it("final output callbacks conform to declared output schemas", () => {
    const States = Machine.state({
      states: {
        signedIn: {
          schema: SignedIn,
          type: "final",
          output: Schema.String
        }
      }
    })
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(SignIn)
    }).handle({
      initial: {
        target: Machine.targets(States).root.signedIn,
        decoded: true,
        data: new SignedIn({ userId: "user-1" })
      },
      states: { signedIn: { output: ({ state }) => state.userId } }
    })
    const planned = Machine.planInitial(machine)
    const started = Machine.start(machine)
    expect<Effect.Success<typeof planned>["output"]>().type.toBe<string | undefined>()
    expect<Effect.Success<Effect.Success<typeof started>["join"]>>().type.toBe<string>()
    const result = null as unknown as Effect.Success<typeof planned>
    if (result.done) {
      expect(result.output).type.toBe<string>()
    } else {
      expect(result.output).type.toBe<undefined>()
    }
  })
  it("requires one definition-led final output contract before execution", () => {
    const States = Machine.state({
      states: {
        signedIn: {
          schema: SignedIn,
          type: "final",
          output: Schema.String
        }
      }
    })
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(SignIn)
    })
    type ForgedCompleteMachine = Machine.Machine<
      {
        readonly "": typeof States.node
      },
      readonly [
        typeof SignIn
      ],
      typeof Schema.Void,
      "signedIn",
      never,
      never,
      never,
      never,
      "signedIn",
      string,
      readonly [],
      "signedIn",
      readonly [
        typeof SignIn
      ]
    >
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(States).root.signedIn,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: { signedIn: { output: () => 1 } },
      initial: {
        target: Machine.targets(States).root.signedIn,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: { signedIn: { type: "final", output: () => "user-1" } },
      initial: {
        target: Machine.targets(States).root.signedIn,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(Machine.planInitial).type.not.toBeCallableWith(machine)
    expect(Machine.start).type.not.toBeCallableWith(machine)
    const parent = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn),
      children: {
        incomplete: Machine.child(
          "incomplete",
          machine.handle({ initial: { target: Machine.targets(States).root.signedIn, data: { userId: "user-1" } } })
        )
      }
    })
    expect(parent.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      }
    })
    expect(parent.handle).type.not.toBeCallableWith({
      states: {
        down: { invoke: { src: "incomplete", onDone: { none: true } } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine).type.not.toBeAssignableTo<ForgedCompleteMachine>()
    const complete = machine.handle({
      initial: {
        target: Machine.targets(States).root.signedIn,
        decoded: true,
        data: new SignedIn({ userId: "user-1" })
      },
      states: { signedIn: { output: ({ state }) => state.userId } }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)
    expect(Machine.start).type.toBeCallableWith(complete)
  })
  it("keeps only legitimate undefined values in terminal output", () => {
    const States = Machine.state({
      states: {
        active: Down,
        succeeded: {
          schema: SignedIn,
          type: "final",
          output: Schema.String
        },
        cancelled: {
          schema: SignedOut,
          type: "final"
        }
      }
    })
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(SignIn)
    }).handle({
      initial: {
        target: Machine.targets(States).root.active,
        decoded: true,
        data: new Down({})
      },
      states: { active: {}, succeeded: { output: ({ state }) => state.userId }, cancelled: {} }
    })
    const started = Machine.start(machine)
    expect<Effect.Success<Effect.Success<typeof started>["join"]>>().type.toBe<string | undefined>()
    const InitialRoot2 = Machine.state({ states: { active: Down } })
    const activeOnly = Machine.make({
      root: InitialRoot2,
      events: Machine.eventsFromSchemas(SignIn)
    }).handle({
      initial: {
        target: Machine.targets(InitialRoot2).root.active,
        decoded: true,
        data: new Down({})
      },
      states: { active: {} }
    })
    const activeRef = Machine.start(activeOnly)
    expect<Effect.Success<Effect.Success<typeof activeRef>["join"]>>().type.toBe<never>()
  })
  it("compound onDone receives the declared child final output type", () => {
    const States = Machine.state({
      states: {
        auth: {
          schema: Auth,
          states: {
            signedOut: SignedOut,
            signedIn: {
              schema: SignedIn,
              type: "final",
              output: Schema.String
            }
          }
        },
        down: Down
      }
    })
    const targets17 = Machine.targets(States)
    const machine = Machine.make({
      branches: { transition1: { destination: { target: targets17.root.down } } },
      root: States,
      events: Machine.eventsFromSchemas(SignIn)
    })
    machine.handle({
      initial: {
        target: Machine.targets(States).root.auth,
        decoded: true,
        data: new Auth({ userId: "user-1" })
      },
      states: {
        auth: {
          initial: {
            target: Machine.targets(States).root.auth.signedOut,
            decoded: true,
            data: new SignedOut({})
          },
          onDone: {
            branches: "transition1",
            resolve: ({ output, select: { destination: target } }) => {
              expect(output).type.toBe<string>()
              return target.decoded(new Down({}))
            }
          },
          states: { signedOut: {}, signedIn: { output: ({ state }) => state.userId } }
        },
        down: {}
      }
    })
  })
  it("rejects compound onDone when declared child output is not implemented", () => {
    const States = Machine.state({
      states: {
        auth: {
          schema: Auth,
          states: {
            signedOut: SignedOut,
            signedIn: {
              schema: SignedIn,
              type: "final",
              output: Schema.String
            }
          }
        }
      }
    })
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(SignIn)
    })
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(States).root.auth,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        auth: {
          initial: {
            target: Machine.targets(States).root.auth.signedOut,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        auth: {
          onDone: () => undefined,
          initial: {
            target: Machine.targets(States).root.auth.signedOut,
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: Machine.targets(States).root.auth,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
  it("multiple final children produce a discriminated completion output union", () => {
    const States = Machine.state({
      states: {
        payment: {
          schema: Payment,
          states: {
            pending: PendingPayment,
            approved: {
              schema: ApprovedPayment,
              type: "final",
              output: Schema.Struct({
                status: Schema.Literal("approved"),
                authId: Schema.String
              })
            },
            declined: {
              schema: DeclinedPayment,
              type: "final",
              output: Schema.Struct({
                status: Schema.Literal("declined"),
                reason: Schema.String
              })
            }
          }
        }
      }
    })
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(SignIn)
    })
    machine.handle({
      initial: {
        target: Machine.targets(States).root.payment,
        decoded: true,
        data: new Payment({})
      },
      states: {
        payment: {
          initial: {
            target: Machine.targets(States).root.payment.pending,
            decoded: true,
            data: new PendingPayment({})
          },
          onDone: {
            none: true,
            resolve: ({ output }) => {
              expect(output.status).type.toBe<"approved" | "declined">()
              if (output.status === "approved") {
                expect(output.authId).type.toBe<string>()
              } else {
                expect(output.reason).type.toBe<string>()
              }
              return undefined
            }
          },
          states: {
            pending: {},
            approved: {
              output: ({ state }) => ({
                status: "approved" as const,
                authId: state.authId
              })
            },
            declined: {
              output: ({ state }) => ({
                status: "declined" as const,
                reason: state.reason
              })
            }
          }
        }
      }
    })
  })
  it("parallel output callbacks receive typed region outputs and conform to declared output schemas", () => {
    const States = Machine.state({
      states: {
        up: {
          schema: Up,
          type: "parallel",
          output: Schema.Struct({
            userId: Schema.String,
            requestId: Schema.String
          }),
          states: {
            auth: {
              schema: Auth,
              states: {
                signedOut: SignedOut,
                signedIn: {
                  schema: SignedIn,
                  type: "final",
                  output: Schema.Struct({ userId: Schema.String })
                }
              }
            },
            sync: {
              schema: Sync,
              states: {
                idle: SyncIdle,
                syncing: {
                  schema: Syncing,
                  type: "final",
                  output: Schema.Struct({ requestId: Schema.String })
                }
              }
            }
          }
        }
      }
    })
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(SignIn)
    })
    const complete = machine.handle({
      initial: {
        target: Machine.targets(States).root.up,
        decoded: true,
        data: new Up({ id: "up-1" })
      },
      states: {
        up: {
          output: ({ outputs }) => {
            expect(outputs.auth.userId).type.toBe<string>()
            expect(outputs.sync.requestId).type.toBe<string>()
            return {
              userId: outputs.auth.userId,
              requestId: outputs.sync.requestId
            }
          },
          onDone: {
            none: true,
            resolve: ({ output }) => {
              expect(output.userId).type.toBe<string>()
              expect(output.requestId).type.toBe<string>()
              return undefined
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(States).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: { output: ({ state }) => ({ userId: state.userId }) } }
            },
            sync: {
              initial: {
                target: Machine.targets(States).root.up.sync.idle,
                decoded: true,
                data: new SyncIdle({})
              },
              states: { idle: {}, syncing: { output: ({ state }) => ({ requestId: state.requestId }) } }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    const started = Machine.start(complete)
    expect<Effect.Success<Effect.Success<typeof started>["join"]>>().type.toBe<
      Machine.Machine.OutputByIdentifier<{
        readonly "": typeof States.node
      }, "up">
    >()
  })
  it("rejects parallel output callbacks that do not match declared output schemas", () => {
    const States = Machine.state({
      states: {
        up: {
          schema: Up,
          type: "parallel",
          output: Schema.Struct({
            userId: Schema.String
          }),
          states: {
            auth: {
              schema: Auth,
              states: {
                signedOut: SignedOut,
                signedIn: {
                  schema: SignedIn,
                  type: "final",
                  output: Schema.Struct({ userId: Schema.String })
                }
              }
            }
          }
        }
      }
    })
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(SignIn)
    })
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(States).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        up: {
          output: () => ({ userId: "user-1" }),
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              states: { signedIn: { output: () => ({ userId: "user-1" }) } },
              initial: {
                target: Machine.targets(States).root.up.auth.signedOut,
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
        up: {
          output: () => ({
            requestId: "request-1"
          }),
          states: {
            auth: {
              states: {
                signedIn: {
                  output: ({ state }: {
                    readonly state: SignedIn
                  }) => ({ userId: state.userId })
                }
              },
              initial: {
                target: Machine.targets(States).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: Machine.targets(States).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
  it("initial builder constructs typed initial snapshots", () => {
    const snapshot = UpInitial.decoded(new Up({ id: "up-1" }), (up) =>
      up
        .auth.decoded(new Auth({ userId: "guest" }), (auth) => auth.signedOut.decoded(new SignedOut({})))
        .sync.decoded(new Sync({ enabled: true }), (sync) => sync.idle.decoded(new SyncIdle({}))))
    expect(snapshot).type.toBeAssignableTo<
      Machine.Machine.SnapshotByIdentifier<{
        readonly "": typeof UpStates.node
      }, "up">
    >()
    expect(snapshot.path).type.toBe<"up">()
    expect(snapshot.value).type.toBe<Up>()
    expect(snapshot.states.auth.value).type.toBe<Auth>()
    expect(snapshot.states.auth.state.path).type.toBe<"up.auth.signedOut" | "up.auth.signedIn">()
    expect(snapshot.states.sync.value).type.toBe<Sync>()
    expect(snapshot.states.sync.state.path).type.toBe<"up.sync.idle" | "up.sync.syncing">()
  })
  it("initial builder rejects incomplete parallel callbacks", () => {
    expect(UpInitial.decoded).type.not.toBeCallableWith(
      new Up({ id: "up-1" }),
      (up: ChildBuilder<typeof UpInitial>) =>
        up.auth.decoded(new Auth({ userId: "guest" }), (auth) => auth.signedOut.decoded(new SignedOut({})))
    )
  })
  it("initial builder exposes only the declared compound initial child", () => {
    const up = null as unknown as ChildBuilder<typeof UpInitial>
    const auth = null as unknown as ChildBuilder<typeof up.auth>
    expect(auth.signedOut.decoded).type.toBeCallableWith(new SignedOut({}))
    expect(auth).type.toHaveProperty("signedIn")
  })
  it("initial builder checks values at parent and leaf nodes", () => {
    const up = null as unknown as ChildBuilder<typeof UpInitial>
    const sync = null as unknown as ChildBuilder<typeof up.sync>
    expect(DownInitial.decoded).type.not.toBeCallableWith(new Up({ id: "up-1" }))
    expect(UpInitial.decoded).type.not.toBeCallableWith(
      new Auth({ userId: "guest" }),
      (up: ChildBuilder<typeof UpInitial>) =>
        up
          .auth.decoded(new Auth({ userId: "guest" }), (auth) => auth.signedOut.decoded(new SignedOut({})))
          .sync.decoded(new Sync({ enabled: true }), (sync) => sync.idle.decoded(new SyncIdle({})))
    )
    expect(up.auth.decoded).type.not.toBeCallableWith(
      new Up({ id: "up-1" }),
      (auth: ChildBuilder<typeof up.auth>) => auth.signedOut.decoded(new SignedOut({}))
    )
    expect(sync.idle.decoded).type.not.toBeCallableWith(new Syncing({ requestId: "sync-1" }))
  })
  it("initial builder removes parallel region methods after they are called", () => {
    const up = null as unknown as ChildBuilder<typeof UpInitial>
    const afterAuth = up.auth.decoded(
      new Auth({ userId: "guest" }),
      (auth) => auth.signedOut.decoded(new SignedOut({}))
    )
    const complete = afterAuth.sync.decoded(new Sync({ enabled: true }), (sync) => sync.idle.decoded(new SyncIdle({})))
    expect(afterAuth).type.not.toHaveProperty("auth")
    expect(afterAuth).type.toHaveProperty("sync")
    expect(complete).type.not.toHaveProperty("sync")
    expect(complete).type.not.toHaveProperty("done")
  })
  it("internal target constructors: target.full constructs typed full snapshots", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "down">
    }
    const full = null as unknown as Machine.Machine.FullTargetBuilder<typeof UpStates.node.states>
    const snapshot = full.up.decoded(new Up({ id: "up-1" }), (up) =>
      up
        .auth.decoded(
          new Auth({ userId: "guest" }),
          (auth) => auth.signedIn.decoded(new SignedIn({ userId: "user-1" }))
        )
        .sync.decoded(
          new Sync({ enabled: true }),
          (sync) => sync.syncing.decoded(new Syncing({ requestId: "sync-1" }))
        ))
    expect(snapshot).type.toBeAssignableTo<
      Machine.Machine.SnapshotByIdentifier<{
        readonly "": typeof UpStates.node
      }, "up">
    >()
    expect(snapshot.path).type.toBe<"up">()
    expect(snapshot.states.auth.state.path).type.toBe<"up.auth.signedOut" | "up.auth.signedIn">()
    expect(snapshot.states.sync.state.path).type.toBe<"up.sync.idle" | "up.sync.syncing">()
  })
  it("state builders construct from exact schema make input", () => {
    const initial = UpInitial.from({ id: "up-1" }, (up) =>
      up
        .auth.from({ userId: "guest" }, (auth) => auth.signedOut.from({}))
        .sync.from({ enabled: true }, (sync) => sync.idle.from({})))
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "up.auth.signedOut">
    }
    const local = context.target.local.signedIn.from({ userId: "user-1" })
    const full = context.target.branch[""].down.from({})
    const localWith = context.target.local.with.from(
      { userId: "user-1" },
      (auth) => auth.signedIn.from({ userId: "user-1" })
    )
    const branch = context.target.branch[""].up.from(
      { id: "up-2" },
      (up) => up.auth.from({ userId: "user-1" }, (auth) => auth.signedIn.from({ userId: "user-1" }))
    )
    expect(initial).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.SnapshotByIdentifier<{
          readonly "": typeof UpStates.node
        }, "up">
      >
    >()
    expect(local).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<{
          readonly "": typeof UpStates.node
        }, "up.auth.signedIn">
      >
    >()
    expect(local).type.not.toHaveProperty("path")
    expect(local).type.not.toHaveProperty("value")
    expect(localWith).type.not.toHaveProperty("path")
    expect(branch).type.not.toHaveProperty("path")
    expect(full).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.SnapshotByIdentifier<{
          readonly "": typeof UpStates.node
        }, "down">
      >
    >()
    expect(full).type.not.toHaveProperty("value")
    expect(UpInitial.from).type.not.toBeCallableWith({ id: 1 }, (up: ChildBuilder<typeof UpInitial>) =>
      up
        .auth.from({ userId: "guest" }, (auth) => auth.signedOut.from({}))
        .sync.from({ enabled: true }, (sync) => sync.idle.from({})))
    expect(context.target.local.signedIn.from).type.not.toBeCallableWith({})
    expect(context.target.local.signedIn.from).type.not.toBeCallableWith({ userId: 1 })
    expect(context.target.local.with.from).type.not.toBeCallableWith(
      { id: "wrong-parent" },
      (auth: ChildBuilder<typeof context.target.local.with>) => auth.signedOut.from({})
    )
  })
  it("state builders omit empty constructor inputs across every target surface", () => {
    const State = Schema.TaggedUnion({
      Flow: {},
      Idle: {},
      Running: {},
      Nested: {},
      NestedIdle: {},
      Done: {},
      Required: { value: Schema.String },
      Parallel: {},
      Left: {},
      LeftIdle: {},
      Right: {},
      RightIdle: {}
    })
    class DefaultOnly extends Schema.TaggedClass<DefaultOnly>("DefaultOnly")("DefaultOnly", {
      label: Schema.String.pipe(Schema.optionalKey, Schema.withConstructorDefault(Effect.succeed("default")))
    }) {
    }
    const States = Machine.state({
      states: {
        Flow: {
          schema: State.cases.Flow,

          states: {
            Idle: State.cases.Idle,
            Running: State.cases.Running,
            Nested: {
              schema: State.cases.Nested,

              states: {
                NestedIdle: State.cases.NestedIdle
              }
            },
            Done: {
              schema: State.cases.Done,
              type: "final"
            }
          }
        },
        Required: State.cases.Required,
        DefaultOnly
      }
    })
    const ParallelStates = Machine.state({
      states: {
        Parallel: {
          schema: State.cases.Parallel,
          type: "parallel",
          states: {
            left: {
              schema: State.cases.Left,

              states: {
                LeftIdle: State.cases.LeftIdle
              }
            },
            right: {
              schema: State.cases.Right,

              states: {
                RightIdle: State.cases.RightIdle
              }
            }
          }
        }
      }
    })
    type Context = {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof States.node
      }, "Flow.Idle">
    }
    type ParallelContext = {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof ParallelStates.node
      }, "Parallel.left.LeftIdle">
    }
    const context = null as unknown as Context
    const parallelContext = null as unknown as ParallelContext
    const FlowInitial = null as unknown as Machine.Machine.FullTargetBuilder<typeof States.node.states>["Flow"]
    const RequiredInitial = null as unknown as Machine.Machine.FullTargetBuilder<typeof States.node.states>["Required"]
    const DefaultOnlyInitial = null as unknown as Machine.Machine.FullTargetBuilder<
      typeof States.node.states
    >["DefaultOnly"]
    const ParallelInitial = null as unknown as Machine.Machine.FullTargetBuilder<
      typeof ParallelStates.node.states
    >["Parallel"]
    const initial = FlowInitial.from((flow) => flow.Idle.from())
    const defaulted = DefaultOnlyInitial.from()
    const local = context.target.local.Running.from()
    const localWith = context.target.local.with.from((flow) => flow.Running.from())
    const branch = context.target.branch[""].Flow.Nested.from((nested) => nested.NestedIdle.from())
    const fullBuilder = null as unknown as Machine.Machine.FullTargetBuilder<typeof States.node.states>
    const full = fullBuilder.Flow.from((flow) => flow.Nested.from((nested) => nested.NestedIdle.from()))
    const final = context.target.local.Done.from()
    const parallel = ParallelInitial.from((root) =>
      root
        .left.from((left) => left.LeftIdle.from())
        .right.from((right) => right.RightIdle.from())
    )
    const parallelBuilder = null as unknown as Machine.Machine.FullTargetBuilder<typeof ParallelStates.node.states>
    const fullParallel = parallelBuilder.Parallel.from((root) =>
      root
        .left.from((left) => left.LeftIdle.from())
        .right.from((right) => right.RightIdle.from())
    )
    expect(initial).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.SnapshotByIdentifier<{
          readonly "": typeof States.node
        }, "Flow">
      >
    >()
    expect(defaulted).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.SnapshotByIdentifier<{
          readonly "": typeof States.node
        }, "DefaultOnly">
      >
    >()
    expect(local).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<{
          readonly "": typeof States.node
        }, "Flow.Running">
      >
    >()
    expect(localWith).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<{
          readonly "": typeof States.node
        }, "Flow.Running">
      >
    >()
    expect(branch).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<{
          readonly "": typeof States.node
        }, "Flow.Nested.NestedIdle">
      >
    >()
    expect(full).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.SnapshotByIdentifier<{
          readonly "": typeof States.node
        }, "Flow">
      >
    >()
    expect(final).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<{
          readonly "": typeof States.node
        }, "Flow.Done">
      >
    >()
    expect(parallel).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.SnapshotByIdentifier<{
          readonly "": typeof ParallelStates.node
        }, "Parallel">
      >
    >()
    expect(fullParallel).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.SnapshotByIdentifier<{
          readonly "": typeof ParallelStates.node
        }, "Parallel">
      >
    >()
    expect(RequiredInitial.from).type.not.toBeCallableWith()
    expect(context.target.branch[""].Required.from).type.not.toBeCallableWith()
    expect(FlowInitial.from).type.not.toBeCallableWith()
    expect(ParallelInitial.from).type.not.toBeCallableWith()
    const requiredContext = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "up.auth.signedOut">
    }
    expect(UpInitial.from).type.not.toBeCallableWith((up: ChildBuilder<typeof UpInitial>) =>
      up
        .auth.from({ userId: "guest" }, (auth) => auth.signedOut.from())
        .sync.from({ enabled: true }, (sync) => sync.idle.from())
    )
    const requiredFull = null as unknown as Machine.Machine.FullTargetBuilder<typeof UpStates.node.states>
    expect(requiredFull.up.from).type.not.toBeCallableWith((up: ChildBuilder<typeof requiredFull.up>) =>
      up
        .auth.from({ userId: "guest" }, (auth) => auth.signedOut.from())
        .sync.from({ enabled: true }, (sync) => sync.idle.from())
    )
    expect(requiredContext.target.local.with.from).type.not.toBeCallableWith((
      auth: ChildBuilder<typeof requiredContext.target.local.with>
    ) => auth.signedOut.from())
    expect(requiredContext.target.branch[""].up.from).type.not.toBeCallableWith((
      up: ChildBuilder<typeof requiredContext.target.branch[""]["up"]>
    ) => up.auth.signedOut.from())
  })
  it("from preserves parallel-region exhaustiveness", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof NestedParallelStates.node
      }, "root.idle">
    }
    const activeContext = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof NestedParallelStates.node
      }, "root.work.auth.signedOut">
    }
    const work = null as unknown as ChildBuilder<typeof context.target.local.work>
    const afterAuth = work.auth.from({ userId: "guest" }, (auth) => auth.signedOut.from({}))
    const target = context.target.local.work.from((work) =>
      work
        .auth.from({ userId: "guest" }, (auth) => auth.signedOut.from({}))
        .sync.from({ enabled: true }, (sync) => sync.idle.from({}))
    )
    const branch = context.target.branch[""].root.work.from((work) =>
      work
        .auth.from({ userId: "guest" }, (auth) => auth.signedOut.from())
        .sync.from({ enabled: true }, (sync) => sync.idle.from())
    )
    const partial = activeContext.target.branch[""].root.work.sync.from(
      { enabled: true },
      (sync) => sync.syncing.from({ requestId: "sync-1" })
    )
    expect(afterAuth).type.not.toHaveProperty("auth")
    expect(afterAuth).type.toHaveProperty("sync")
    expect(target).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<{
          readonly "": typeof NestedParallelStates.node
        }, "root.work">
      >
    >()
    expect(target).type.not.toHaveProperty("path")
    expect(branch).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<{
          readonly "": typeof NestedParallelStates.node
        }, "root.work">
      >
    >()
    expect(partial).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<{
          readonly "": typeof NestedParallelStates.node
        }, "root.work.sync.syncing">
      >
    >()
    expect(context.target.local.work.from).type.not.toBeCallableWith(
      {},
      (work: ChildBuilder<typeof context.target.local.work>) =>
        work.auth.from({ userId: "guest" }, (auth) => auth.signedOut.from({}))
    )
  })
  it("from supports TaggedUnion constructor inputs without a tag", () => {
    const State = Schema.TaggedUnion({
      Idle: {},
      Active: { requestId: Schema.String }
    })
    const States = Machine.state({
      states: {
        Idle: State.cases.Idle,
        Active: State.cases.Active
      }
    })
    const IdleInitial = null as unknown as Machine.Machine.FullTargetBuilder<typeof States.node.states>["Idle"]
    const ActiveInitial = null as unknown as Machine.Machine.FullTargetBuilder<typeof States.node.states>["Active"]
    const initial = IdleInitial.from({})
    expect(initial).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<Machine.Machine.AtomicSnapshot<"Idle", typeof State.cases.Idle.Type>>
    >()
    expect(initial).type.not.toHaveProperty("value")
    expect(ActiveInitial.from).type.toBeCallableWith({ requestId: "request-1" })
    expect(ActiveInitial.from).type.not.toBeCallableWith({})
    expect(ActiveInitial.from).type.not.toBeCallableWith({ requestId: 1 })
  })
  it("internal target constructors: target.full requires every parallel region", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "down">
    }
    expect(context.target.branch[""].up.decoded).type.not.toBeCallableWith(
      new Up({ id: "up-1" }),
      (up: ChildBuilder<typeof context.target.branch[""]["up"]>) =>
        up.auth.decoded(
          new Auth({ userId: "guest" }),
          (auth) => auth.signedIn.decoded(new SignedIn({ userId: "user-1" }))
        )
    )
  })
  it("internal target constructors: target.full exposes every compound child", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "down">
    }
    const up = null as unknown as ChildBuilder<typeof context.target.branch[""]["up"]>
    const auth = null as unknown as ChildBuilder<typeof up.auth>
    expect(auth.signedOut.decoded).type.toBeCallableWith(new SignedOut({}))
    expect(auth.signedIn.decoded).type.toBeCallableWith(new SignedIn({ userId: "user-1" }))
  })
  it("internal target constructors: target.local requires every region when entering an inactive nested parallel state", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof NestedParallelStates.node
      }, "root.idle">
    }
    const target = context.target.local.work.decoded(new Payment({}), (work) =>
      work
        .auth.decoded(
          new Auth({ userId: "guest" }),
          (auth) => auth.signedIn.decoded(new SignedIn({ userId: "user-1" }))
        )
        .sync.decoded(
          new Sync({ enabled: true }),
          (sync) => sync.syncing.decoded(new Syncing({ requestId: "sync-1" }))
        ))
    expect(target).type.toBeAssignableTo<
      Machine.Machine.Target<{
        readonly "": typeof NestedParallelStates.node
      }, "root.work">
    >()
    expect(target.path).type.toBe<"root.work">()
    expect(context.target.local.work.decoded).type.not.toBeCallableWith(
      new Payment({}),
      (work: ChildBuilder<typeof context.target.local.work>) =>
        work.auth.decoded(new Auth({ userId: "guest" }), (auth) => auth.signedOut.decoded(new SignedOut({})))
    )
  })
  it("internal target constructors: target.branch requires every region when entering an inactive nested parallel state", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof NestedParallelStates.node
      }, "root.idle">
    }
    const target = context.target.branch[""].root.work.decoded(new Payment({}), (work) =>
      work
        .auth.decoded(new Auth({ userId: "guest" }), (auth) => auth.signedOut.decoded(new SignedOut({})))
        .sync.decoded(new Sync({ enabled: true }), (sync) => sync.idle.decoded(new SyncIdle({}))))
    expect(target.path).type.toBe<"root.work">()
    expect(context.target.branch[""].root.work).type.not.toHaveProperty("auth")
    expect(context.target.branch[""].root.work.decoded).type.not.toBeCallableWith(
      new Payment({}),
      (work: ChildBuilder<typeof context.target.branch[""]["root"]["work"]>) =>
        work.auth.decoded(new Auth({ userId: "guest" }), (auth) => auth.signedOut.decoded(new SignedOut({})))
    )
  })
  it("nested parallel target builders remove regions and validate payloads", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof NestedParallelStates.node
      }, "root.idle">
    }
    const work = null as unknown as ChildBuilder<typeof context.target.local.work>
    const afterAuth = work.auth.decoded(
      new Auth({ userId: "guest" }),
      (auth) => auth.signedOut.decoded(new SignedOut({}))
    )
    expect(afterAuth).type.not.toHaveProperty("auth")
    expect(afterAuth).type.toHaveProperty("sync")
    expect(work.auth.decoded).type.not.toBeCallableWith(
      new Sync({ enabled: true }),
      (auth: ChildBuilder<typeof work.auth>) => auth.signedOut.decoded(new SignedOut({}))
    )
  })
  it("internal target constructors: target.branch keeps partial navigation for an already-active parallel state", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof NestedParallelStates.node
      }, "root.work.auth.signedOut">
    }
    const target = context.target.branch[""].root.work.sync.decoded(
      new Sync({ enabled: true }),
      (sync) => sync.syncing.decoded(new Syncing({ requestId: "sync-1" }))
    )
    expect(context.target.branch[""].root.work).type.toHaveProperty("auth")
    expect(context.target.branch[""].root.work).type.toHaveProperty("sync")
    expect(target.path).type.toBe<"root.work.sync.syncing">()
  })
  it("internal target constructors: target.local constructs typed local leaf targets", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "up.auth.signedOut">
    }
    const target = context.target.local.signedIn.decoded(new SignedIn({ userId: "user-1" }))
    expect(target).type.toBeAssignableTo<
      Machine.Machine.Target<{
        readonly "": typeof UpStates.node
      }, "up.auth.signedIn">
    >()
    expect(target.path).type.toBe<"up.auth.signedIn">()
    expect(target.value).type.toBe<SignedIn>()
  })
  it("internal target constructors: target.local exposes the source compound children when the source is compound", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "up.auth">
    }
    expect(context.target.local.signedOut.decoded).type.toBeCallableWith(new SignedOut({}))
    expect(context.target.local.signedIn.decoded).type.toBeCallableWith(new SignedIn({ userId: "user-1" }))
  })
  it("internal target constructors: target.local.with checks the local compound value", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "up.auth.signedOut">
    }
    const target = context.target.local.with.decoded(
      new Auth({ userId: "user-1" }),
      (auth) => auth.signedIn.decoded(new SignedIn({ userId: "user-1" }))
    )
    expect(target.path).type.toBe<"up.auth.signedIn">()
    expect(context.target.local.with.decoded).type.not.toBeCallableWith(
      new Up({ id: "up-1" }),
      (auth: ChildBuilder<typeof context.target.local.with>) =>
        auth.signedIn.decoded(new SignedIn({ userId: "user-1" }))
    )
  })
  it("internal target constructors: target.local rejects unrelated children and wrong values", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "up.auth.signedOut">
    }
    expect(context.target.local).type.not.toHaveProperty("sync")
    expect(context.target.local).type.not.toHaveProperty("down")
    expect(context.target.local).type.not.toHaveProperty("idle")
    expect(context.target.local.signedIn.decoded).type.not.toBeCallableWith(new SignedOut({}))
  })
  it("internal target constructors: target.local exposes the root compound children", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "down">
    }
    expect(context.target.local).type.toHaveProperty("up")
    expect(context.target.local).type.toHaveProperty("down")
    expect(context.target.local).type.not.toHaveProperty("with")
  })
  it("internal target constructors: target.branch starts at the shared machine root", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "up.auth.signedOut">
    }
    const downContext = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "down">
    }
    expect(context.target.branch[""]).type.toHaveProperty("up")
    expect(context.target.branch[""]).type.toHaveProperty("down")
    expect(downContext.target.branch[""]).type.toHaveProperty("down")
    expect(downContext.target.branch[""]).type.toHaveProperty("up")
  })
  it("internal target constructors: target.branch constructs typed partial branch targets", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "up.auth.signedOut">
    }
    const target = context.target.branch[""].up.sync.decoded(
      new Sync({ enabled: true }),
      (sync) => sync.syncing.decoded(new Syncing({ requestId: "sync-1" }))
    )
    expect(target).type.toBeAssignableTo<
      Machine.Machine.Target<{
        readonly "": typeof UpStates.node
      }, "up.sync.syncing">
    >()
    expect(target.path).type.toBe<"up.sync.syncing">()
    expect(target.value).type.toBe<Syncing>()
  })
  it("internal target constructors: target.branch can replace ancestors before selecting a leaf", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "up.auth.signedOut">
    }
    const target = context.target.branch[""].up.decoded(
      new Up({ id: "up-2" }),
      (up) =>
        up.auth.decoded(
          new Auth({ userId: "user-1" }),
          (auth) => auth.signedIn.decoded(new SignedIn({ userId: "user-1" }))
        )
    )
    expect(target.path).type.toBe<"up.auth.signedIn">()
    expect(target.value).type.toBe<SignedIn>()
  })
  it("internal target constructors: target.branch rejects non-leaf targets and wrong values", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "up.auth.signedOut">
    }
    expect(context.target.branch[""].up.decoded).type.not.toBeCallableWith(new Up({ id: "up-1" }))
    expect(context.target.branch[""].up.sync.decoded).type.not.toBeCallableWith(new Sync({ enabled: true }))
    expect(context.target.branch[""].up.sync.decoded).type.not.toBeCallableWith(
      new Auth({ userId: "user-1" }),
      (sync: ChildBuilder<typeof context.target.branch[""]["up"]["sync"]>) =>
        sync.syncing.decoded(new Syncing({ requestId: "sync-1" }))
    )
    expect(context.target.branch[""].up.auth.signedIn.decoded).type.not.toBeCallableWith(new SignedOut({}))
  })
  it("internal target constructor containers are not callable", () => {
    const context = null as unknown as {
      readonly target: Machine.Machine.TargetBuilder<{
        readonly "": typeof UpStates.node
      }, "down">
    }
    expect<IsCallable<typeof context.target>>().type.toBe<false>()
    expect(context.target.none()).type.toBe<Machine.Machine.NoTarget>()
  })
  it("requires explicit targetless transitions", () => {
    expect(Machine).type.not.toHaveProperty("targetless")
    const definition = Machine.make({
      root: UpStates,
      events: Machine.eventsFromSchemas(SignIn)
    })
    expect(definition.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
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
        down: { on: { SignIn: () => undefined } },
        up: {
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        }
      },
      initial: {
        target: Machine.targets(UpStates).root.up,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(definition.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            SignIn: {
              none: true,
              resolve: ({ event }, enqueue) => {
                expect(event).type.toBe<SignIn>()
                expect(enqueue.raise).type.toBeCallableWith(event)
              }
            }
          }
        }
      }
    })).type.not.toRaiseError()
    definition.handle({
      initial: {
        target: Machine.targets(UpStates).root.down,
        decoded: true,
        data: new Down({})
      },
      states: {
        up: {
          states: {
            auth: {
              initial: {
                target: Machine.targets(UpStates).root.up.auth.signedOut,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { signedOut: {}, signedIn: {} }
            },
            sync: {
              initial: {
                target: Machine.targets(UpStates).root.up.sync.idle,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: { idle: {}, syncing: {} }
            }
          },
          initial: {
            auth: () => {
              throw new Error("type-only constructor")
            },
            sync: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        down: {
          on: {
            // @ts-expect-error! Targetless resolvers cannot return unrelated values.
            SignIn: { none: true, resolve: () => 1 }
          }
        }
      }
    })
  })
  it("rejects invalid compound initial keys", () => {
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "up",
      states: {
        up: {
          schema: Up,
          initial: "missing",
          states: {
            signedOut: SignedOut
          }
        }
      }
    })
  })
  it("rejects initial keys on parallel states", () => {
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "up",
      states: {
        up: {
          schema: Up,
          type: "parallel",
          initial: "auth",
          states: {
            auth: Auth
          }
        }
      }
    })
  })
  it("rejects invalid nested state definitions", () => {
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "up",
      states: {
        up: {
          schema: Up,
          type: "parallel",
          states: {
            auth: {
              schema: Auth,
              initial: "missing",
              states: {
                signedOut: SignedOut
              }
            }
          }
        }
      }
    })
  })
  it("make validates raw state trees", () => {
    expect(Machine.make).type.not.toBeCallableWith({
      states: {
        up: {
          schema: Up,
          initial: "missing",
          states: {
            auth: Auth
          }
        }
      },
      events: Machine.eventsFromSchemas(),
      initial: (): never => {
        throw new Error("unreachable")
      }
    })
  })
  it("rejects child states on final states", () => {
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "down",
      states: {
        down: {
          schema: Down,
          type: "final",
          states: {
            child: SignedOut
          }
        }
      }
    })
  })
})
