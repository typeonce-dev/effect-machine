import { Context, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

describe("Machine", () => {
  class Up extends Schema.TaggedClass<Up>("Up")("Up", {
    id: Schema.String
  }) {}

  class Down extends Schema.TaggedClass<Down>("Down")("Down", {}) {}

  class RetaggedUp extends Schema.TaggedClass<RetaggedUp>("RetaggedUp")("RetaggedUp", {
    id: Schema.String,
    attempt: Schema.Number
  }) {}

  class Auth extends Schema.TaggedClass<Auth>("Auth")("Auth", {
    userId: Schema.String
  }) {}

  class SignedOut extends Schema.TaggedClass<SignedOut>("SignedOut")("SignedOut", {}) {}

  class SignedIn extends Schema.TaggedClass<SignedIn>("SignedIn")("SignedIn", {
    userId: Schema.String
  }) {}

  class Sync extends Schema.TaggedClass<Sync>("Sync")("Sync", {
    enabled: Schema.Boolean
  }) {}

  class SyncIdle extends Schema.TaggedClass<SyncIdle>("SyncIdle")("SyncIdle", {}) {}

  class Syncing extends Schema.TaggedClass<Syncing>("Syncing")("Syncing", {
    requestId: Schema.String
  }) {}

  class Payment extends Schema.TaggedClass<Payment>("Payment")("Payment", {}) {}

  class PendingPayment extends Schema.TaggedClass<PendingPayment>("PendingPayment")("PendingPayment", {}) {}

  class ApprovedPayment extends Schema.TaggedClass<ApprovedPayment>("ApprovedPayment")("ApprovedPayment", {
    authId: Schema.String
  }) {}

  class DeclinedPayment extends Schema.TaggedClass<DeclinedPayment>("DeclinedPayment")("DeclinedPayment", {
    reason: Schema.String
  }) {}

  class SignIn extends Schema.TaggedClass<SignIn>("SignIn")("SignIn", {
    userId: Schema.String
  }) {}

  class SignInCompleted extends Schema.TaggedClass<SignInCompleted>("SignInCompleted")("SignInCompleted", {
    userId: Schema.String
  }) {}

  class InitialRequirement extends Context.Service<InitialRequirement, {
    readonly initialMessage: string
  }>()("test/Machine/InitialRequirement") {}

  class EntryRequirement extends Context.Service<EntryRequirement, {
    readonly entryMessage: string
  }>()("test/Machine/EntryRequirement") {}

  class DoneRequirement extends Context.Service<DoneRequirement, {
    readonly doneMessage: string
  }>()("test/Machine/DoneRequirement") {}

  class DeferredRequirement extends Context.Service<DeferredRequirement, {
    readonly deferredMessage: string
  }>()("test/Machine/DeferredRequirement") {}

  const UpStates = Machine.defineStates({
    up: {
      schema: Up,
      type: "parallel",
      states: {
        auth: {
          schema: Auth,
          initial: "signedOut",
          states: {
            signedOut: SignedOut,
            signedIn: SignedIn
          }
        },
        sync: {
          schema: Sync,
          initial: "idle",
          states: {
            idle: SyncIdle,
            syncing: Syncing
          }
        }
      }
    },
    down: Down
  })

  const NestedParallelStates = Machine.defineStates({
    root: {
      schema: Up,
      initial: "idle",
      states: {
        idle: Down,
        work: {
          schema: Payment,
          type: "parallel",
          states: {
            auth: {
              schema: Auth,
              initial: "signedOut",
              states: {
                signedOut: SignedOut,
                signedIn: SignedIn
              }
            },
            sync: {
              schema: Sync,
              initial: "idle",
              states: {
                idle: SyncIdle,
                syncing: Syncing
              }
            }
          }
        }
      }
    }
  })

  type ChildBuilder<Method> = Method extends (value: any, build: (builder: infer Builder) => any) => any ? Builder
    : never
  type IsCallable<A> = A extends (...args: ReadonlyArray<any>) => any ? true : false

  type SignInContext = Machine.Machine.HandlerContext<
    typeof UpStates.states,
    readonly [typeof SignIn],
    [],
    "down",
    "SignIn",
    never,
    never
  >

  type SignedOutContext = Machine.Machine.HandlerContext<
    typeof UpStates.states,
    readonly [typeof SignIn],
    [],
    "up.auth.signedOut",
    "SignIn",
    never,
    never
  >

  type AuthContext = Machine.Machine.HandlerContext<
    typeof UpStates.states,
    readonly [typeof SignIn],
    [],
    "up.auth",
    "SignIn",
    never,
    never
  >

  type NestedIdleContext = Machine.Machine.HandlerContext<
    typeof NestedParallelStates.states,
    readonly [typeof SignIn],
    [],
    "root.idle",
    "SignIn",
    never,
    never
  >

  type NestedActiveContext = Machine.Machine.HandlerContext<
    typeof NestedParallelStates.states,
    readonly [typeof SignIn],
    [],
    "root.work.auth.signedOut",
    "SignIn",
    never,
    never
  >

  it("defineStates preserves literal state paths", () => {
    expect<Machine.Machine.StateIdentifier<typeof UpStates.states>>().type.toBe<
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
    }) {}
    const State = Schema.TaggedStruct("ConstructedEventState", {})
    const States = Machine.defineStates({ State })
    const Events = Machine.events(Event)
    const InternalEvents = Machine.internalEvents(Internal)
    Machine.make({
      states: States.states,
      events: Events,
      internalEvents: InternalEvents,
      initial: () => States.initial.State.from()
    })

    expect(Events.Tick({ amount: 1 })).type.toBe<
      Machine.Machine.EventConstruction<typeof Event.cases.Tick.Type>
    >()
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
        typeof UpStates.states,
        readonly [typeof SignIn],
        [],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()
    expect<
      Machine.Machine.InvokeContext<
        typeof UpStates.states,
        readonly [typeof SignIn],
        [],
        "up.auth.signedOut"
      >["containingState"]
    >().type.toBe<Auth>()
    expect<
      Machine.Machine.InvokeContext<
        typeof UpStates.states,
        readonly [typeof SignIn],
        [],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()
    expect<
      Machine.Machine.AlwaysContext<
        typeof UpStates.states,
        readonly [typeof SignIn],
        [],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()
    expect<
      Machine.Machine.DoneContext<
        typeof UpStates.states,
        readonly [typeof SignIn],
        [],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()
    expect<
      Machine.Machine.FinalOutputContext<
        typeof UpStates.states,
        readonly [typeof SignIn],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()
    expect<
      Machine.Machine.ParallelOutputContext<
        typeof UpStates.states,
        readonly [typeof SignIn],
        "up.auth.signedOut"
      >["ancestors"]
    >().type.toBe<NestedParents>()

    const root = null as unknown as SignInContext
    expect(root.containingState).type.toBe<undefined>()
    expect(root.ancestors).type.toBe<{}>()

    expect<
      Machine.Machine.ParentStateValue<
        typeof UpStates.states,
        "up.auth.signedOut" | "down"
      >
    >().type.toBe<Auth | undefined>()
  })

  it("defineStates selects state values and snapshots with type-safe paths", () => {
    const snapshot = UpStates.initial.up(
      new Up({ id: "up-1" }),
      (up) =>
        up
          .auth(
            new Auth({ userId: "guest" }),
            (auth) => auth.signedOut(new SignedOut({}))
          )
          .sync(
            new Sync({ enabled: true }),
            (sync) => sync.idle(new SyncIdle({}))
          )
    )

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
        | {
          readonly value: SignedOut
          readonly parents: {
            readonly up: Up
            readonly "up.auth": Auth
          }
        }
        | {
          readonly value: Down
          readonly parents: {}
        }
      >
    >()
    expect(UpStates.getSnapshot(snapshot, "up.auth")).type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof UpStates.states, "up.auth">>
    >()
    expect(UpStates.matches(snapshot, "up.sync.idle")).type.toBe<boolean>()
    expect(UpStates.get).type.not.toBeCallableWith(snapshot, "up.missing")
    expect(UpStates.getWithParents).type.not.toBeCallableWith(snapshot, "up.missing")

    const upSnapshot = Option.getOrThrow(UpStates.getSnapshot(snapshot, "up"))
    const authSnapshot = Option.getOrThrow(UpStates.getSnapshot(upSnapshot, "up.auth"))
    expect(UpStates.get(upSnapshot, "up.auth.signedOut")).type.toBe<Option.Option<SignedOut>>()
    expect(UpStates.getSnapshot(upSnapshot, "up.sync")).type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof UpStates.states, "up.sync">>
    >()
    expect(UpStates.matches(authSnapshot, "up.auth.signedIn")).type.toBe<boolean>()
    expect(UpStates.get(authSnapshot, "up.auth")).type.toBe<Option.Option<Auth>>()
    expect(UpStates.get).type.not.toBeCallableWith(authSnapshot, "up.sync.idle")
    expect(UpStates.getSnapshot).type.not.toBeCallableWith(authSnapshot, "up")
    expect(UpStates.matches).type.not.toBeCallableWith(authSnapshot, "signedOut")
    expect(UpStates.matches).type.not.toBeCallableWith(authSnapshot, "down")

    const other = Machine.defineStates({ other: Down })
    expect(UpStates.get).type.not.toBeCallableWith(other.initial.other(new Down({})), "up")
    expect(UpStates.getWithParents).type.not.toBeCallableWith(other.initial.other(new Down({})), "up")
  })

  it("defineStates preserves declared compound initial keys", () => {
    expect<typeof UpStates.states.up.states.auth.initial>().type.toBe<"signedOut">()
    expect<typeof UpStates.states.up.states.sync.initial>().type.toBe<"idle">()
  })

  it("make accepts defined states", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    expect(machine.states).type.toBe<typeof UpStates.states>()
  })

  it("make rejects raw decoded initial states", () => {
    expect(Machine.make).type.not.toBeCallableWith({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => new Down({})
    })
  })

  it("encodes and decodes snapshots with typed effects", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    const encoded = Machine.encodeSnapshot(machine, UpStates.initial.down(new Down({})))
    expect<Effect.Success<typeof encoded>>().type.toBe<Machine.Machine.EncodedSnapshot>()
    expect<Effect.Error<typeof encoded>>().type.toBe<Machine.MachineSchemaEncodeError>()
    expect<Effect.Services<typeof encoded>>().type.toBe<never>()

    const decoded = Machine.decodeSnapshot(machine, {
      _tag: "MachineSnapshot",
      active: [{ path: "down", value: { _tag: "Down" } }]
    })
    expect<Effect.Success<typeof decoded>>().type.toBe<Machine.Machine.Snapshot<typeof UpStates.states>>()
    expect<Effect.Error<typeof decoded>>().type.toBe<Machine.MachineSchemaDecodeError>()
    expect<Effect.Services<typeof decoded>>().type.toBe<never>()
  })

  it("planInitial is synchronous at the transition boundary", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    }).handle({
      down: {
        entry: () => {}
      }
    })

    const planned = Machine.planInitial(machine)

    expect<Effect.Services<typeof planned>>().type.toBe<never>()
    expect<Effect.Success<typeof planned>["commands"]>().type.toBe<ReadonlyArray<Machine.Command>>()

    expect(Machine.make).type.not.toBeCallableWith({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => Effect.succeed(UpStates.initial.down(new Down({})))
    })
    expect(machine.handle).type.not.toBeCallableWith({
      down: { entry: () => Effect.void }
    })
  })

  it("types the closed enqueue protocol without exposing Effects", () => {
    const worker = Machine.childAddress<SignIn>("worker")
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      emittedEvents: Machine.emittedEvents(SignInCompleted),
      initial: () => UpStates.initial.down(new Down({}))
    }).handle({
      down: {
        on: {
          SignIn: ({ event, target }, enqueue) => {
            expect(enqueue.raise).type.toBeCallableWith(event)
            expect(enqueue.raise).type.not.toBeCallableWith(new Down({}))
            expect(enqueue.emit).type.toBeCallableWith(new SignInCompleted({ userId: event.userId }))
            expect(enqueue.emit).type.not.toBeCallableWith(event)
            expect(enqueue.sendTo).type.toBeCallableWith(worker, event)
            expect(enqueue.sendTo).type.not.toBeCallableWith(worker, new Down({}))
            expect(enqueue.stop).type.toBeCallableWith(worker)
            expect(enqueue.stop).type.not.toBeCallableWith("worker")
            return target.full.down(new Down({}))
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
        const child = Machine.transition(0, (_state: number, _event: SignIn) => Effect.succeed(1))

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

  it("invoke handles one-shot outputs directly in the owning state", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    machine.handle({
      down: {
        invoke: Machine.invoke({
          id: "valid",
          effect: Effect.succeed(1),
          onDone: ({ output, state, target }) => {
            expect(output).type.toBe<number>()
            expect(state).type.toBe<Down>()
            return target.full.down(new Down({}))
          }
        })
      }
    })
    expect(Machine.invoke).type.not.toBeCallableWith({
      id: "invalid",
      effect: Effect.succeed(1)
    })
  })

  it("contextually types dynamic Effect sources on direct inline objects", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    machine.handle({
      down: {
        invoke: {
          id: "dynamic",
          effect: ({ state }) => {
            expect(state).type.toBe<Down>()
            return Effect.succeed(state._tag)
          },
          onDone: () => UpStates.initial.down(new Down({}))
        }
      }
    })
  })

  it("infers dynamic Machine.invoke Effect channels from the source return", () => {
    class LoadFailure {
      readonly _tag = "LoadFailure"
    }
    const load = (userId: string) => Effect.fail(new LoadFailure()).pipe(Effect.as({ userId }))
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    machine.handle({
      down: {
        invoke: Machine.invoke({
          id: "dynamic",
          effect: ({ state }) => {
            expect(state).type.toBe<Down>()
            return load(state._tag)
          },
          onDone: ({ output, target }) => {
            expect(output).type.toBe<{ userId: string }>()
            return target.none()
          },
          onFailure: ({ error, target }) => {
            expect(error).type.toBe<LoadFailure>()
            return target.none()
          }
        })
      }
    })
  })

  it("requires only reachable handlers for dynamic Machine.invoke Effects", () => {
    class LoadFailure {
      readonly _tag = "LoadFailure"
    }
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    machine.handle({
      down: {
        invoke: [
          Machine.invoke({
            id: "success",
            effect: ({ state }) => Effect.succeed(state._tag),
            onDone: ({ output, target }) => {
              expect(output).type.toBe<"Down">()
              return target.none()
            }
          }),
          Machine.invoke({
            id: "failure",
            effect: ({ state }) => Effect.fail(new LoadFailure()).pipe(Effect.annotateLogs("state", state._tag)),
            onFailure: ({ error, target }) => {
              expect(error).type.toBe<LoadFailure>()
              return target.none()
            }
          }),
          Machine.invoke({
            id: "never",
            effect: ({ state }) => Effect.never.pipe(Effect.annotateLogs("state", state._tag))
          }),
          Machine.invoke({
            id: "requirements",
            effect: ({ state }) => Effect.as(EntryRequirement, state._tag),
            onDone: ({ output, target }) => {
              expect(output).type.toBe<"Down">()
              return target.none()
            }
          })
        ]
      }
    })

    const requirementsHandled = machine.handle({
      down: {
        invoke: Machine.invoke({
          id: "requirements-only",
          effect: ({ state }) => Effect.as(EntryRequirement, state._tag),
          onDone: ({ output, target }) => {
            expect(output).type.toBe<"Down">()
            return target.none()
          }
        })
      }
    })

    expect<Machine.Machine.Services<typeof requirementsHandled>>().type.not.toBe<any>()
    expect<EntryRequirement>().type.toBeAssignableTo<Machine.Machine.Services<typeof requirementsHandled>>()
    expect<unknown>().type.not.toBeAssignableTo<Machine.Machine.Services<typeof requirementsHandled>>()
  })

  it("rejects unreachable and missing handlers for dynamic Machine.invoke Effects", () => {
    type Context = Machine.Machine.InvokeContext<
      typeof UpStates.states,
      readonly [typeof SignIn],
      readonly [],
      "down"
    >
    const success = (_: Context) => Effect.succeed("user-1")
    const failure = (_: Context) => Effect.fail("unavailable" as const)
    const pending = (_: Context) => Effect.never

    expect(Machine.invoke).type.not.toBeCallableWith({
      id: "missing-done",
      effect: success
    })
    expect(Machine.invoke).type.not.toBeCallableWith({
      id: "unreachable-failure",
      effect: success,
      onDone: () => undefined,
      onFailure: () => undefined
    })
    expect(Machine.invoke).type.not.toBeCallableWith({
      id: "missing-failure",
      effect: failure
    })
    expect(Machine.invoke).type.not.toBeCallableWith({
      id: "unreachable-done",
      effect: failure,
      onDone: () => undefined,
      onFailure: () => undefined
    })
    expect(Machine.invoke).type.not.toBeCallableWith({
      id: "pending-done",
      effect: pending,
      onDone: () => undefined
    })
    expect(Machine.invoke).type.not.toBeCallableWith({
      id: "pending-failure",
      effect: pending,
      onFailure: () => undefined
    })
  })

  it("separates public input events from the complete internal protocol", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      internalEvents: Machine.internalEvents(SignInCompleted),
      initial: () => UpStates.initial.down(new Down({}))
    }).handle({
      down: {
        on: {
          SignIn: ({ event, target }) => {
            expect(event).type.toBe<SignIn>()
            return target.none()
          },
          SignInCompleted: ({ event, target }) => {
            expect(event).type.toBe<SignInCompleted>()
            return target.none()
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
    expect(Machine.plan).type.toBeCallableWith(
      machine,
      UpStates.initial.down(new Down({})),
      new SignIn({ userId: "user-1" })
    )
    expect(Machine.plan).type.not.toBeCallableWith(
      machine,
      UpStates.initial.down(new Down({})),
      new SignInCompleted({ userId: "user-1" })
    )
    const publicEvents = Machine.events(SignIn)
    const overlappingInternalEvents = Machine.internalEvents(SignIn)
    expect(Machine.make).type.not.toBeCallableWith({
      states: UpStates.states,
      events: publicEvents,
      internalEvents: overlappingInternalEvents,
      initial: () => UpStates.initial.down(new Down({}))
    })
    expect(Machine.events).type.not.toBeCallableWith(SignIn, SignIn)
    expect(Machine.internalEvents).type.not.toBeCallableWith(SignInCompleted, SignInCompleted)
  })

  it("invoke requires only the lifecycle handlers reachable from the source type", () => {
    const failure = Effect.fail("unavailable" as const)
    const erasedFailure = failure as Effect.Effect<never, any>
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      internalEvents: Machine.internalEvents(SignInCompleted),
      initial: () => UpStates.initial.down(new Down({}))
    })

    expect(Machine.invoke).type.not.toBeCallableWith({
      id: "missing-failure",
      effect: failure
    })
    expect(Machine.invoke).type.not.toBeCallableWith({
      id: "unreachable-failure",
      effect: Effect.succeed("user-1"),
      onDone: () => undefined,
      onFailure: () => undefined
    })
    expect(Machine.invoke).type.not.toBeCallableWith({
      id: "erased-failure",
      effect: erasedFailure
    })
    machine.handle({
      down: {
        invoke: Machine.invoke({
          id: "erased-failure",
          effect: erasedFailure,
          onFailure: ({ error, target }) => {
            expect(error).type.toBe<any>()
            return target.none()
          }
        })
      }
    })
  })

  it("constructs sibling targets from destructured source fields", () => {
    const states = Machine.defineStates({ source: Up, target: RetaggedUp })
    Machine.make({
      states: states.states,
      events: Machine.events(SignIn),
      initial: () => states.initial.source(new Up({ id: "up-1" }))
    }).handle({
      source: {
        on: {
          SignIn: ({ state, target }) => {
            const { _tag: _, ...fields } = state
            expect(target.full.target.from).type.toBeCallableWith({ ...fields, attempt: 1 })
            expect(target.full.target.from).type.not.toBeCallableWith(fields)
            expect(target.full.target.from).type.not.toBeCallableWith({ ...fields, attempt: "invalid" })
            return target.full.target.from({ ...fields, attempt: 1 })
          }
        }
      }
    })
  })

  it("child invocation composes complete machines with type-safe protocols", () => {
    const ChildInput = Schema.Struct({ userId: Schema.String })
    const childStates = Machine.defineStates({
      done: {
        schema: Down,
        type: "final",
        output: SignIn
      }
    })
    const child = Machine.make({
      states: childStates.states,
      events: Machine.events(SignIn),
      emittedEvents: Machine.emittedEvents(SignIn),
      input: ChildInput,
      initial: () => childStates.initial.done(new Down({}))
    }).handle({
      done: {
        output: () => new SignIn({ userId: "child" })
      }
    })
    const Child = Machine.child("child", child)
    expect(Machine.sendTo).type.toBeCallableWith(Child, new SignIn({ userId: "child" }))
    expect(Machine.sendTo).type.not.toBeCallableWith(Child, new Down({}))
    const parent = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    parent.handle({
      down: {
        invoke: Machine.invoke({
          child: Child,
          input: { userId: "child" },
          onSnapshot: ({ snapshot, target }) => {
            expect(snapshot.state).type.toBe<Machine.Machine.Snapshot<typeof childStates.states>>()
            return target.none()
          },
          onDone: ({ output, state, target }) => {
            expect(output).type.toBe<SignIn>()
            expect(state).type.toBe<Down>()
            return target.none()
          }
        })
      }
    })
    expect(parent.handle).type.not.toBeCallableWith({
      down: { invoke: { child: Child, onDone: () => undefined } }
    })

    const incompatibleEmits = Machine.make({
      states: childStates.states,
      events: Machine.events(SignIn),
      emittedEvents: Machine.emittedEvents(Down),
      input: ChildInput,
      initial: () => childStates.initial.done(new Down({}))
    }).handle({
      done: {
        output: () => new SignIn({ userId: "child" })
      }
    })
    expect(parent.handle).type.not.toBeCallableWith({
      down: {
        invoke: {
          child: Machine.child("incompatible", incompatibleEmits),
          input: { userId: "child" },
          onDone: () => undefined
        }
      }
    })
    expect(parent.handle).type.not.toBeCallableWith({
      down: {
        invoke: {
          child: Child,
          input: { userId: "child" },
          onSnapshot: () => new Down({}),
          onDone: () => undefined
        }
      }
    })
    expect(parent.handle).type.not.toBeCallableWith({
      down: {
        invoke: {
          child: Child,
          input: { userId: "child" },
          onDone: () => new Down({})
        }
      }
    })
  })

  it("types nested invocation output handlers against their owning state", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    machine.handle({
      up: {
        states: {
          auth: {
            states: {
              signedOut: {
                invoke: Machine.invoke({
                  id: "nested",
                  effect: Effect.succeed(Option.some(1)),
                  onDone: ({ output, state, target }) => {
                    expect(output).type.toBe<Option.Option<number>>()
                    expect(state).type.toBe<SignedOut>()
                    return target.none()
                  }
                })
              }
            }
          },
          sync: {}
        }
      }
    })
  })

  it("typed child addresses enforce their event protocol", () => {
    const worker = Machine.childAddress<SignIn>("worker")
    const inert = Machine.childAddress("inert")
    const child = Machine.transition(0, (_state: number, _event: SignIn) => Effect.succeed(1))

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
      Machine.transition(0, (_state: number, _event: Down) => Effect.succeed(1)),
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
    expect<Effect.Error<Effect.Success<typeof spawned>["join"]>>().type.toBe<
      "child-runtime" | Machine.StoppedError
    >()
  })

  it("start exposes machine infrastructure failure channels", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    }).handle({
      down: {
        on: {
          SignIn: ({ target }) => target.full.down(new Down({}))
        }
      }
    })
    const started = Machine.start(machine)

    expect<Effect.Error<typeof started>>().type.toBe<
      | Machine.MachineSchemaDecodeError
      | Machine.StartupError
      | Machine.InfiniteTransitionError
      | Machine.StoppedError
    >()
    expect<Effect.Error<Effect.Success<typeof started>["join"]>>().type.toBe<
      | Machine.InfiniteTransitionError
      | Machine.MachineSchemaDecodeError
      | Machine.StoppedError
    >()

    const Child = Machine.child("failure-child", machine)
    type ChildError = Effect.Error<Machine.ChildMachine.Ref<typeof Child>["join"]>

    expect<ChildError>().type.toBe<
      | Machine.InfiniteTransitionError
      | Machine.MachineSchemaDecodeError
      | Machine.StoppedError
    >()
    const invocation = Machine.invoke({ child: Child, onDone: ({ target }) => target.none() })
    expect<Machine.Machine.InvokeRuntimeError<typeof invocation>>().type.toBe<never>()
  })

  it("plan and getters require snapshots", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    expect(Machine.plan).type.toBeCallableWith(
      machine,
      UpStates.initial.down(new Down({})),
      new SignIn({
        userId: "user-1"
      })
    )
    const planned = Machine.plan(
      machine,
      UpStates.initial.down(new Down({})),
      new SignIn({ userId: "user-1" })
    )
    expect<Effect.Error<typeof planned>>().type.toBe<
      Machine.InfiniteTransitionError | Machine.MachineSchemaDecodeError
    >()
    expect(Machine.enabled).type.toBeCallableWith(machine, UpStates.initial.down(new Down({})))
    expect(Machine.isFinal).type.toBeCallableWith(machine, UpStates.initial.down(new Down({})))

    expect(Machine.plan).type.not.toBeCallableWith(machine, new Down({}), new SignIn({ userId: "user-1" }))
    expect(Machine.enabled).type.not.toBeCallableWith(machine, new Down({}))
    expect(Machine.isFinal).type.not.toBeCallableWith(machine, new Down({}))
  })

  it("handlers reject raw decoded state returns", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    expect<IsCallable<typeof machine.handle>>().type.toBe<true>()
    expect(machine.handle).type.not.toBeCallableWith({
      down: {
        on: {
          SignIn: () => new Down({})
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      down: {
        on: {
          SignIn: () => Effect.succeed(new Down({}))
        }
      }
    })
  })

  it("handle accepts nested states through reserved states objects", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    machine.handle({
      up: {
        states: {
          auth: {
            states: {
              signedOut: {
                on: {
                  SignIn: ({ event, state, target }) => {
                    expect(event).type.toBe<SignIn>()
                    expect(state).type.toBe<SignedOut>()
                    return target.local.signedIn(new SignedIn({ userId: event.userId }))
                  }
                }
              }
            }
          }
        }
      }
    })
  })

  it("handle accepts parent config and child config in the same object", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    machine.handle({
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
        always: ({ event, target }) => {
          expect(event).type.toBe<SignIn | Machine.InitialEvent>()
          return target.none()
        },
        states: {
          auth: {
            states: {
              signedOut: {
                on: {
                  SignIn: ({ event, target }) => target.local.signedIn(new SignedIn({ userId: event.userId }))
                }
              }
            }
          },
          sync: {
            states: {
              idle: {
                entry: ({ state }) => {
                  const tag: "SyncIdle" = state._tag
                  void tag
                }
              }
            }
          }
        }
      }
    })
  })

  it("onDone handlers receive typed state context without Effect requirements", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () =>
        UpStates.initial.up(
          new Up({ id: "up-1" }),
          (up) =>
            up
              .auth(
                new Auth({ userId: "user-1" }),
                (auth) => auth.signedOut(new SignedOut({}))
              )
              .sync(
                new Sync({ enabled: true }),
                (sync) => sync.idle(new SyncIdle({}))
              )
        )
    }).handle({
      up: {
        states: {
          auth: {
            onDone: ({ event, output, state, target }) => {
              expect(event).type.toBe<SignIn | Machine.InitialEvent>()
              expect(output).type.toBe<undefined>()
              expect(state).type.toBe<Auth>()
              return target.full.down(new Down({}))
            },
            states: {
              signedIn: {}
            }
          }
        }
      }
    })

    const planned = Machine.plan(
      machine,
      UpStates.initial.up(
        new Up({ id: "up-1" }),
        (up) =>
          up
            .auth(
              new Auth({ userId: "user-1" }),
              (auth) => auth.signedOut(new SignedOut({}))
            )
            .sync(
              new Sync({ enabled: true }),
              (sync) => sync.idle(new SyncIdle({}))
            )
      ),
      new SignIn({ userId: "user-1" })
    )

    expect<Effect.Services<typeof planned>>().type.toBe<never>()
  })

  it("handle rejects old property and callback APIs", () => {
    const machine = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    expect(machine.handle).type.not.toHaveProperty("up")
    expect(machine.handle).type.not.toBeCallableWith("up.auth.signedOut", {
      on: {}
    })
    expect(machine.handle).type.not.toBeCallableWith((up: unknown) => up)
  })

  it("final output callbacks receive lifecycle events", () => {
    const machine = Machine.make({
      states: {
        down: {
          schema: Down,
          type: "final",
          output: Schema.Void
        }
      },
      events: Machine.events(SignIn),
      initial: () =>
        Machine.defineStates({ down: { schema: Down, type: "final", output: Schema.Void } }).initial.down(
          new Down({})
        )
    }).handle({
      down: {
        output: ({ event }) => {
          expect(event).type.toBe<SignIn | Machine.InitialEvent>()
        }
      }
    })

    expect(machine).type.toBeAssignableTo<Machine.Machine.Any>()
  })

  it("final output callbacks conform to declared output schemas", () => {
    const States = Machine.defineStates({
      signedIn: {
        schema: SignedIn,
        type: "final",
        output: Schema.String
      }
    })

    const machine = Machine.make({
      states: States.states,
      events: Machine.events(SignIn),
      initial: () => States.initial.signedIn(new SignedIn({ userId: "user-1" }))
    }).handle({
      signedIn: {
        output: ({ state }) => state.userId
      }
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
    const States = Machine.defineStates({
      signedIn: {
        schema: SignedIn,
        type: "final",
        output: Schema.String
      }
    })
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(SignIn),
      initial: () => States.initial.signedIn(new SignedIn({ userId: "user-1" }))
    })
    type ForgedCompleteMachine = Machine.Machine<
      typeof States.states,
      readonly [typeof SignIn],
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
      readonly [typeof SignIn]
    >

    expect(machine.handle).type.not.toBeCallableWith({
      signedIn: {
        output: () => 1
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      signedIn: {
        type: "final",
        output: () => "user-1"
      }
    })
    expect(Machine.planInitial).type.not.toBeCallableWith(machine)
    expect(Machine.start).type.not.toBeCallableWith(machine)
    expect(Machine.invoke).type.not.toBeCallableWith({
      child: Machine.child("incomplete", machine),
      onDone: () => undefined
    })
    expect(machine).type.not.toBeAssignableTo<ForgedCompleteMachine>()

    const complete = machine.handle({
      signedIn: {
        output: ({ state }) => state.userId
      }
    })
    expect(Machine.planInitial).type.toBeCallableWith(complete)
    expect(Machine.start).type.toBeCallableWith(complete)
  })

  it("keeps only legitimate undefined values in terminal output", () => {
    const States = Machine.defineStates({
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
    })
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(SignIn),
      initial: () => States.initial.active(new Down({}))
    }).handle({
      succeeded: {
        output: ({ state }) => state.userId
      }
    })
    const started = Machine.start(machine)
    expect<Effect.Success<Effect.Success<typeof started>["join"]>>().type.toBe<string | undefined>()

    const activeOnly = Machine.make({
      states: { active: Down },
      events: Machine.events(SignIn),
      initial: () => Machine.defineStates({ active: Down }).initial.active(new Down({}))
    })
    const activeRef = Machine.start(activeOnly)
    expect<Effect.Success<Effect.Success<typeof activeRef>["join"]>>().type.toBe<never>()
  })

  it("compound onDone receives the declared child final output type", () => {
    const States = Machine.defineStates({
      auth: {
        schema: Auth,
        initial: "signedOut",
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
    })

    const machine = Machine.make({
      states: States.states,
      events: Machine.events(SignIn),
      initial: () => States.initial.auth(new Auth({ userId: "user-1" }), (auth) => auth.signedOut(new SignedOut({})))
    })

    machine.handle({
      auth: {
        onDone: ({ output, target }) => {
          expect(output).type.toBe<string>()
          return target.full.down(new Down({}))
        },
        states: {
          signedIn: {
            output: ({ state }) => state.userId
          }
        }
      }
    })
  })

  it("rejects compound onDone when declared child output is not implemented", () => {
    const States = Machine.defineStates({
      auth: {
        schema: Auth,
        initial: "signedOut",
        states: {
          signedOut: SignedOut,
          signedIn: {
            schema: SignedIn,
            type: "final",
            output: Schema.String
          }
        }
      }
    })
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(SignIn),
      initial: () => States.initial.auth(new Auth({ userId: "user-1" }), (auth) => auth.signedOut(new SignedOut({})))
    })

    expect(machine.handle).type.not.toBeCallableWith({
      auth: {
        onDone: () => undefined
      }
    })
  })

  it("multiple final children produce a discriminated completion output union", () => {
    const States = Machine.defineStates({
      payment: {
        schema: Payment,
        initial: "pending",
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
    })
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(SignIn),
      initial: () => States.initial.payment(new Payment({}), (payment) => payment.pending(new PendingPayment({})))
    })

    machine.handle({
      payment: {
        onDone: ({ output, target }) => {
          expect(output.status).type.toBe<"approved" | "declined">()
          if (output.status === "approved") {
            expect(output.authId).type.toBe<string>()
          } else {
            expect(output.reason).type.toBe<string>()
          }
          return target.none()
        },
        states: {
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
    })
  })

  it("parallel output callbacks receive typed region outputs and conform to declared output schemas", () => {
    const States = Machine.defineStates({
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
            initial: "signedOut",
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
            initial: "idle",
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
    })
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(SignIn),
      initial: () =>
        States.initial.up(
          new Up({ id: "up-1" }),
          (up) =>
            up
              .auth(new Auth({ userId: "user-1" }), (auth) => auth.signedOut(new SignedOut({})))
              .sync(new Sync({ enabled: true }), (sync) => sync.idle(new SyncIdle({})))
        )
    })

    const complete = machine.handle({
      up: {
        output: ({ outputs }) => {
          expect(outputs.auth.userId).type.toBe<string>()
          expect(outputs.sync.requestId).type.toBe<string>()
          return {
            userId: outputs.auth.userId,
            requestId: outputs.sync.requestId
          }
        },
        onDone: ({ output, target }) => {
          expect(output.userId).type.toBe<string>()
          expect(output.requestId).type.toBe<string>()
          return target.none()
        },
        states: {
          auth: {
            states: {
              signedIn: {
                output: ({ state }) => ({ userId: state.userId })
              }
            }
          },
          sync: {
            states: {
              syncing: {
                output: ({ state }) => ({ requestId: state.requestId })
              }
            }
          }
        }
      }
    })
    const started = Machine.start(complete)
    expect<Effect.Success<Effect.Success<typeof started>["join"]>>().type.toBe<
      Machine.Machine.OutputByIdentifier<typeof States.states, "up">
    >()
  })

  it("rejects parallel output callbacks that do not match declared output schemas", () => {
    const States = Machine.defineStates({
      up: {
        schema: Up,
        type: "parallel",
        output: Schema.Struct({
          userId: Schema.String
        }),
        states: {
          auth: {
            schema: Auth,
            initial: "signedOut",
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
    })
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(SignIn),
      initial: () =>
        States.initial.up(
          new Up({ id: "up-1" }),
          (up) => up.auth(new Auth({ userId: "user-1" }), (auth) => auth.signedOut(new SignedOut({})))
        )
    })

    expect(machine.handle).type.not.toBeCallableWith({
      up: {
        output: () => ({
          requestId: "request-1"
        }),
        states: {
          auth: {
            states: {
              signedIn: {
                output: ({ state }: { readonly state: SignedIn }) => ({ userId: state.userId })
              }
            }
          }
        }
      }
    })
  })

  it("initial builder constructs typed initial snapshots", () => {
    const snapshot = UpStates.initial.up(
      new Up({ id: "up-1" }),
      (up) =>
        up
          .auth(
            new Auth({ userId: "guest" }),
            (auth) => auth.signedOut(new SignedOut({}))
          )
          .sync(
            new Sync({ enabled: true }),
            (sync) => sync.idle(new SyncIdle({}))
          )
    )

    expect(snapshot).type.toBeAssignableTo<
      Machine.Machine.SnapshotByIdentifier<typeof UpStates.states, "up">
    >()
    expect(snapshot.path).type.toBe<"up">()
    expect(snapshot.value).type.toBe<Up>()
    expect(snapshot.states.auth.value).type.toBe<Auth>()
    expect(snapshot.states.auth.state.path).type.toBe<"up.auth.signedOut">()
    expect(snapshot.states.sync.value).type.toBe<Sync>()
    expect(snapshot.states.sync.state.path).type.toBe<"up.sync.idle">()
  })

  it("initial builder rejects incomplete parallel callbacks", () => {
    expect(UpStates.initial.up).type.not.toBeCallableWith(
      new Up({ id: "up-1" }),
      (up: ChildBuilder<typeof UpStates.initial.up>) =>
        up.auth(
          new Auth({ userId: "guest" }),
          (auth) => auth.signedOut(new SignedOut({}))
        )
    )
  })

  it("initial builder exposes only the declared compound initial child", () => {
    const up = null as unknown as ChildBuilder<typeof UpStates.initial.up>
    const auth = null as unknown as ChildBuilder<typeof up.auth>

    expect(auth.signedOut).type.toBeCallableWith(new SignedOut({}))
    expect(auth).type.not.toHaveProperty("signedIn")
  })

  it("initial builder checks values at parent and leaf nodes", () => {
    const up = null as unknown as ChildBuilder<typeof UpStates.initial.up>
    const sync = null as unknown as ChildBuilder<typeof up.sync>

    expect(UpStates.initial.down).type.not.toBeCallableWith(new Up({ id: "up-1" }))
    expect(UpStates.initial.up).type.not.toBeCallableWith(
      new Auth({ userId: "guest" }),
      (up: ChildBuilder<typeof UpStates.initial.up>) =>
        up
          .auth(
            new Auth({ userId: "guest" }),
            (auth) => auth.signedOut(new SignedOut({}))
          )
          .sync(
            new Sync({ enabled: true }),
            (sync) => sync.idle(new SyncIdle({}))
          )
    )
    expect(up.auth).type.not.toBeCallableWith(
      new Up({ id: "up-1" }),
      (auth: ChildBuilder<typeof up.auth>) => auth.signedOut(new SignedOut({}))
    )
    expect(sync.idle).type.not.toBeCallableWith(new Syncing({ requestId: "sync-1" }))
  })

  it("initial builder removes parallel region methods after they are called", () => {
    const up = null as unknown as ChildBuilder<typeof UpStates.initial.up>
    const afterAuth = up.auth(
      new Auth({ userId: "guest" }),
      (auth) => auth.signedOut(new SignedOut({}))
    )
    const complete = afterAuth.sync(
      new Sync({ enabled: true }),
      (sync) => sync.idle(new SyncIdle({}))
    )

    expect(afterAuth).type.not.toHaveProperty("auth")
    expect(afterAuth).type.toHaveProperty("sync")
    expect(complete).type.not.toHaveProperty("sync")
    expect(complete).type.not.toHaveProperty("done")
  })

  it("target.full constructs typed full snapshots", () => {
    const context = null as unknown as SignInContext
    const snapshot = context.target.full.up(
      new Up({ id: "up-1" }),
      (up) =>
        up
          .auth(
            new Auth({ userId: "guest" }),
            (auth) => auth.signedIn(new SignedIn({ userId: "user-1" }))
          )
          .sync(
            new Sync({ enabled: true }),
            (sync) => sync.syncing(new Syncing({ requestId: "sync-1" }))
          )
    )

    expect(snapshot).type.toBeAssignableTo<
      Machine.Machine.SnapshotByIdentifier<typeof UpStates.states, "up">
    >()
    expect(snapshot.path).type.toBe<"up">()
    expect(snapshot.states.auth.state.path).type.toBe<"up.auth.signedOut" | "up.auth.signedIn">()
    expect(snapshot.states.sync.state.path).type.toBe<"up.sync.idle" | "up.sync.syncing">()
  })

  it("state builders construct from exact schema make input", () => {
    const initial = UpStates.initial.up.from(
      { id: "up-1" },
      (up) =>
        up
          .auth.from(
            { userId: "guest" },
            (auth) => auth.signedOut.from({})
          )
          .sync.from(
            { enabled: true },
            (sync) => sync.idle.from({})
          )
    )
    const context = null as unknown as SignedOutContext
    const local = context.target.local.signedIn.from({ userId: "user-1" })
    const full = context.target.full.down.from({})
    const localWith = context.target.local.with.from(
      { userId: "user-1" },
      (auth) => auth.signedIn.from({ userId: "user-1" })
    )
    const branch = context.target.branch.up.from(
      { id: "up-2" },
      (up) =>
        up.auth.from(
          { userId: "user-1" },
          (auth) => auth.signedIn.from({ userId: "user-1" })
        )
    )

    expect(initial).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.SnapshotByIdentifier<typeof UpStates.states, "up">
      >
    >()
    expect(local).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<typeof UpStates.states, "up.auth.signedIn">
      >
    >()
    expect(local).type.not.toHaveProperty("path")
    expect(local).type.not.toHaveProperty("value")
    expect(localWith).type.not.toHaveProperty("path")
    expect(branch).type.not.toHaveProperty("path")
    expect(full).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.SnapshotByIdentifier<typeof UpStates.states, "down">
      >
    >()
    expect(full).type.not.toHaveProperty("value")

    expect(UpStates.initial.up.from).type.not.toBeCallableWith(
      { id: 1 },
      (up: ChildBuilder<typeof UpStates.initial.up>) =>
        up
          .auth.from({ userId: "guest" }, (auth) => auth.signedOut.from({}))
          .sync.from({ enabled: true }, (sync) => sync.idle.from({}))
    )
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
      label: Schema.String.pipe(
        Schema.optionalKey,
        Schema.withConstructorDefault(Effect.succeed("default"))
      )
    }) {}
    const States = Machine.defineStates({
      Flow: {
        schema: State.cases.Flow,
        initial: "Idle",
        states: {
          Idle: State.cases.Idle,
          Running: State.cases.Running,
          Nested: {
            schema: State.cases.Nested,
            initial: "NestedIdle",
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
    })
    const ParallelStates = Machine.defineStates({
      Parallel: {
        schema: State.cases.Parallel,
        type: "parallel",
        states: {
          left: {
            schema: State.cases.Left,
            initial: "LeftIdle",
            states: {
              LeftIdle: State.cases.LeftIdle
            }
          },
          right: {
            schema: State.cases.Right,
            initial: "RightIdle",
            states: {
              RightIdle: State.cases.RightIdle
            }
          }
        }
      }
    })
    type Context = Machine.Machine.HandlerContext<
      typeof States.states,
      readonly [typeof SignIn],
      [],
      "Flow.Idle",
      "SignIn",
      never,
      never
    >
    type ParallelContext = Machine.Machine.HandlerContext<
      typeof ParallelStates.states,
      readonly [typeof SignIn],
      [],
      "Parallel.left.LeftIdle",
      "SignIn",
      never,
      never
    >
    const context = null as unknown as Context
    const parallelContext = null as unknown as ParallelContext

    const initial = States.initial.Flow.from((flow) => flow.Idle.from())
    const defaulted = States.initial.DefaultOnly.from()
    const local = context.target.local.Running.from()
    const localWith = context.target.local.with.from((flow) => flow.Running.from())
    const branch = context.target.branch.Flow.Nested.from((nested) => nested.NestedIdle.from())
    const full = context.target.full.Flow.from((flow) => flow.Nested.from((nested) => nested.NestedIdle.from()))
    const final = context.target.local.Done.from()
    const parallel = ParallelStates.initial.Parallel.from((root) =>
      root
        .left.from((left) => left.LeftIdle.from())
        .right.from((right) => right.RightIdle.from())
    )
    const fullParallel = parallelContext.target.full.Parallel.from((root) =>
      root
        .left.from((left) => left.LeftIdle.from())
        .right.from((right) => right.RightIdle.from())
    )

    expect(initial).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<Machine.Machine.Snapshot<typeof States.states>>
    >()
    expect(defaulted).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<Machine.Machine.Snapshot<typeof States.states>>
    >()
    expect(local).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<Machine.Machine.Target<typeof States.states, "Flow.Running">>
    >()
    expect(localWith).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<Machine.Machine.Target<typeof States.states, "Flow.Running">>
    >()
    expect(branch).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<Machine.Machine.Target<typeof States.states, "Flow.Nested.NestedIdle">>
    >()
    expect(full).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<Machine.Machine.SnapshotByIdentifier<typeof States.states, "Flow">>
    >()
    expect(final).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<Machine.Machine.Target<typeof States.states, "Flow.Done">>
    >()
    expect(parallel).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<Machine.Machine.SnapshotByIdentifier<typeof ParallelStates.states, "Parallel">>
    >()
    expect(fullParallel).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<Machine.Machine.SnapshotByIdentifier<typeof ParallelStates.states, "Parallel">>
    >()

    expect(States.initial.Required.from).type.not.toBeCallableWith()
    expect(context.target.full.Required.from).type.not.toBeCallableWith()
    expect(States.initial.Flow.from).type.not.toBeCallableWith()
    expect(ParallelStates.initial.Parallel.from).type.not.toBeCallableWith()

    const requiredContext = null as unknown as SignedOutContext
    expect(UpStates.initial.up.from).type.not.toBeCallableWith(
      (up: ChildBuilder<typeof UpStates.initial.up>) =>
        up
          .auth.from({ userId: "guest" }, (auth) => auth.signedOut.from())
          .sync.from({ enabled: true }, (sync) => sync.idle.from())
    )
    expect(requiredContext.target.full.up.from).type.not.toBeCallableWith(
      (up: ChildBuilder<typeof requiredContext.target.full.up>) =>
        up
          .auth.from({ userId: "guest" }, (auth) => auth.signedOut.from())
          .sync.from({ enabled: true }, (sync) => sync.idle.from())
    )
    expect(requiredContext.target.local.with.from).type.not.toBeCallableWith(
      (auth: ChildBuilder<typeof requiredContext.target.local.with>) => auth.signedOut.from()
    )
    expect(requiredContext.target.branch.up.from).type.not.toBeCallableWith(
      (up: ChildBuilder<typeof requiredContext.target.branch.up>) => up.auth.signedOut.from()
    )
  })

  it("from preserves parallel-region exhaustiveness", () => {
    const context = null as unknown as NestedIdleContext
    const activeContext = null as unknown as NestedActiveContext
    const work = null as unknown as ChildBuilder<typeof context.target.local.work>
    const afterAuth = work.auth.from(
      { userId: "guest" },
      (auth) => auth.signedOut.from({})
    )
    const target = context.target.local.work.from((work) =>
      work
        .auth.from({ userId: "guest" }, (auth) => auth.signedOut.from({}))
        .sync.from({ enabled: true }, (sync) => sync.idle.from({}))
    )
    const branch = context.target.branch.root.work.from((work) =>
      work
        .auth.from({ userId: "guest" }, (auth) => auth.signedOut.from())
        .sync.from({ enabled: true }, (sync) => sync.idle.from())
    )
    const partial = activeContext.target.branch.root.work.sync.from(
      { enabled: true },
      (sync) => sync.syncing.from({ requestId: "sync-1" })
    )

    expect(afterAuth).type.not.toHaveProperty("auth")
    expect(afterAuth).type.toHaveProperty("sync")
    expect(target).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<typeof NestedParallelStates.states, "root.work">
      >
    >()
    expect(target).type.not.toHaveProperty("path")
    expect(branch).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<typeof NestedParallelStates.states, "root.work">
      >
    >()
    expect(partial).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.Target<typeof NestedParallelStates.states, "root.work.sync.syncing">
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
    const States = Machine.defineStates({
      Idle: State.cases.Idle,
      Active: State.cases.Active
    })
    const initial = States.initial.Idle.from({})

    expect(initial).type.toBeAssignableTo<
      Machine.Machine.StateConstruction<
        Machine.Machine.AtomicSnapshot<"Idle", typeof State.cases.Idle.Type>
      >
    >()
    expect(initial).type.not.toHaveProperty("value")
    expect(States.initial.Active.from).type.toBeCallableWith({ requestId: "request-1" })
    expect(States.initial.Active.from).type.not.toBeCallableWith({})
    expect(States.initial.Active.from).type.not.toBeCallableWith({ requestId: 1 })
  })

  it("target.full requires every parallel region", () => {
    const context = null as unknown as SignInContext

    expect(context.target.full.up).type.not.toBeCallableWith(
      new Up({ id: "up-1" }),
      (up: ChildBuilder<typeof context.target.full.up>) =>
        up.auth(
          new Auth({ userId: "guest" }),
          (auth) => auth.signedIn(new SignedIn({ userId: "user-1" }))
        )
    )
  })

  it("target.full exposes every compound child", () => {
    const context = null as unknown as SignInContext
    const up = null as unknown as ChildBuilder<typeof context.target.full.up>
    const auth = null as unknown as ChildBuilder<typeof up.auth>

    expect(auth.signedOut).type.toBeCallableWith(new SignedOut({}))
    expect(auth.signedIn).type.toBeCallableWith(new SignedIn({ userId: "user-1" }))
  })

  it("target.local requires every region when entering an inactive nested parallel state", () => {
    const context = null as unknown as NestedIdleContext
    const target = context.target.local.work(
      new Payment({}),
      (work) =>
        work
          .auth(
            new Auth({ userId: "guest" }),
            (auth) => auth.signedIn(new SignedIn({ userId: "user-1" }))
          )
          .sync(
            new Sync({ enabled: true }),
            (sync) => sync.syncing(new Syncing({ requestId: "sync-1" }))
          )
    )

    expect(target).type.toBeAssignableTo<
      Machine.Machine.Target<typeof NestedParallelStates.states, "root.work">
    >()
    expect(target.path).type.toBe<"root.work">()
    expect(context.target.local.work).type.not.toBeCallableWith(
      new Payment({}),
      (work: ChildBuilder<typeof context.target.local.work>) =>
        work.auth(
          new Auth({ userId: "guest" }),
          (auth) => auth.signedOut(new SignedOut({}))
        )
    )
  })

  it("target.branch requires every region when entering an inactive nested parallel state", () => {
    const context = null as unknown as NestedIdleContext
    const target = context.target.branch.root.work(
      new Payment({}),
      (work) =>
        work
          .auth(
            new Auth({ userId: "guest" }),
            (auth) => auth.signedOut(new SignedOut({}))
          )
          .sync(
            new Sync({ enabled: true }),
            (sync) => sync.idle(new SyncIdle({}))
          )
    )

    expect(target.path).type.toBe<"root.work">()
    expect(context.target.branch.root.work).type.not.toHaveProperty("auth")
    expect(context.target.branch.root.work).type.not.toBeCallableWith(
      new Payment({}),
      (work: ChildBuilder<typeof context.target.branch.root.work>) =>
        work.auth(
          new Auth({ userId: "guest" }),
          (auth) => auth.signedOut(new SignedOut({}))
        )
    )
  })

  it("nested parallel target builders remove regions and validate payloads", () => {
    const context = null as unknown as NestedIdleContext
    const work = null as unknown as ChildBuilder<typeof context.target.local.work>
    const afterAuth = work.auth(
      new Auth({ userId: "guest" }),
      (auth) => auth.signedOut(new SignedOut({}))
    )

    expect(afterAuth).type.not.toHaveProperty("auth")
    expect(afterAuth).type.toHaveProperty("sync")
    expect(work.auth).type.not.toBeCallableWith(
      new Sync({ enabled: true }),
      (auth: ChildBuilder<typeof work.auth>) => auth.signedOut(new SignedOut({}))
    )
  })

  it("target.branch keeps partial navigation for an already-active parallel state", () => {
    const context = null as unknown as NestedActiveContext
    const target = context.target.branch.root.work.sync(
      new Sync({ enabled: true }),
      (sync) => sync.syncing(new Syncing({ requestId: "sync-1" }))
    )

    expect(context.target.branch.root.work).type.toHaveProperty("auth")
    expect(context.target.branch.root.work).type.toHaveProperty("sync")
    expect(target.path).type.toBe<"root.work.sync.syncing">()
  })

  it("target.local constructs typed local leaf targets", () => {
    const context = null as unknown as SignedOutContext
    const target = context.target.local.signedIn(new SignedIn({ userId: "user-1" }))

    expect(target).type.toBeAssignableTo<
      Machine.Machine.Target<typeof UpStates.states, "up.auth.signedIn">
    >()
    expect(target.path).type.toBe<"up.auth.signedIn">()
    expect(target.value).type.toBe<SignedIn>()
  })

  it("target.local exposes the source compound children when the source is compound", () => {
    const context = null as unknown as AuthContext

    expect(context.target.local.signedOut).type.toBeCallableWith(new SignedOut({}))
    expect(context.target.local.signedIn).type.toBeCallableWith(new SignedIn({ userId: "user-1" }))
  })

  it("target.local.with checks the local compound value", () => {
    const context = null as unknown as SignedOutContext
    const target = context.target.local.with(
      new Auth({ userId: "user-1" }),
      (auth) => auth.signedIn(new SignedIn({ userId: "user-1" }))
    )

    expect(target.path).type.toBe<"up.auth.signedIn">()
    expect(context.target.local.with).type.not.toBeCallableWith(
      new Up({ id: "up-1" }),
      (auth: ChildBuilder<typeof context.target.local.with>) => auth.signedIn(new SignedIn({ userId: "user-1" }))
    )
  })

  it("target.local rejects unrelated children and wrong values", () => {
    const context = null as unknown as SignedOutContext

    expect(context.target.local).type.not.toHaveProperty("sync")
    expect(context.target.local).type.not.toHaveProperty("down")
    expect(context.target.local).type.not.toHaveProperty("idle")
    expect(context.target.local.signedIn).type.not.toBeCallableWith(new SignedOut({}))
  })

  it("target.local exposes no methods outside a compound scope", () => {
    const context = null as unknown as SignInContext

    expect(context.target.local).type.not.toHaveProperty("up")
    expect(context.target.local).type.not.toHaveProperty("down")
    expect(context.target.local).type.not.toHaveProperty("with")
  })

  it("target.branch exposes only the source root", () => {
    const context = null as unknown as SignedOutContext
    const downContext = null as unknown as SignInContext

    expect(context.target.branch).type.toHaveProperty("up")
    expect(context.target.branch).type.not.toHaveProperty("down")
    expect(downContext.target.branch).type.toHaveProperty("down")
    expect(downContext.target.branch).type.not.toHaveProperty("up")
  })

  it("target.branch constructs typed partial branch targets", () => {
    const context = null as unknown as SignedOutContext
    const target = context.target.branch.up.sync(
      new Sync({ enabled: true }),
      (sync) => sync.syncing(new Syncing({ requestId: "sync-1" }))
    )

    expect(target).type.toBeAssignableTo<
      Machine.Machine.Target<typeof UpStates.states, "up.sync.syncing">
    >()
    expect(target.path).type.toBe<"up.sync.syncing">()
    expect(target.value).type.toBe<Syncing>()
  })

  it("target.branch can replace ancestors before selecting a leaf", () => {
    const context = null as unknown as SignedOutContext
    const target = context.target.branch.up(
      new Up({ id: "up-2" }),
      (up) =>
        up.auth(
          new Auth({ userId: "user-1" }),
          (auth) => auth.signedIn(new SignedIn({ userId: "user-1" }))
        )
    )

    expect(target.path).type.toBe<"up.auth.signedIn">()
    expect(target.value).type.toBe<SignedIn>()
  })

  it("target.branch rejects non-leaf targets and wrong values", () => {
    const context = null as unknown as SignedOutContext

    expect(context.target.branch.up).type.not.toBeCallableWith(new Up({ id: "up-1" }))
    expect(context.target.branch.up.sync).type.not.toBeCallableWith(new Sync({ enabled: true }))
    expect(context.target.branch.up.sync).type.not.toBeCallableWith(
      new Auth({ userId: "user-1" }),
      (sync: ChildBuilder<typeof context.target.branch.up.sync>) => sync.syncing(new Syncing({ requestId: "sync-1" }))
    )
    expect(context.target.branch.up.auth.signedIn).type.not.toBeCallableWith(new SignedOut({}))
  })

  it("target is not callable", () => {
    const context = null as unknown as SignInContext

    expect<IsCallable<typeof context.target>>().type.toBe<false>()
    expect(context.target.none()).type.toBe<Machine.Machine.NoTarget>()
  })

  it("requires explicit targetless results and permits them with declared targets", () => {
    const definition = Machine.make({
      states: UpStates.states,
      events: Machine.events(SignIn),
      initial: () => UpStates.initial.down(new Down({}))
    })

    expect(definition.handle).type.not.toBeCallableWith({
      down: { on: { SignIn: () => undefined } }
    })
    expect(
      definition.handle({
        down: {
          on: {
            SignIn: {
              targets: ["up.auth.signedIn"],
              transition: ({ target }) => target.none()
            }
          }
        }
      })
    ).type.not.toRaiseError()
  })

  it("rejects invalid compound initial keys", () => {
    expect(Machine.defineStates).type.not.toBeCallableWith({
      up: {
        schema: Up,
        initial: "missing",
        states: {
          signedOut: SignedOut
        }
      }
    })
  })

  it("rejects initial keys on parallel states", () => {
    expect(Machine.defineStates).type.not.toBeCallableWith({
      up: {
        schema: Up,
        type: "parallel",
        initial: "auth",
        states: {
          auth: Auth
        }
      }
    })
  })

  it("rejects invalid nested state definitions", () => {
    expect(Machine.defineStates).type.not.toBeCallableWith({
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
      events: Machine.events(),
      initial: (): never => {
        throw new Error("unreachable")
      }
    })
  })

  it("rejects child states on final states", () => {
    expect(Machine.defineStates).type.not.toBeCallableWith({
      down: {
        schema: Down,
        type: "final",
        states: {
          child: SignedOut
        }
      }
    })
  })
})
