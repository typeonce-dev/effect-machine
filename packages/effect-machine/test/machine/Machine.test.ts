import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Data, Deferred, Effect, Fiber, Option, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../src/index.js"
class InitialRequirement extends Context.Service<InitialRequirement, {
  readonly initialMessage: string
}>()("test/Machine/InitialRequirement") {
}
class InvokeError extends Data.TaggedError("InvokeError")<{
  readonly message: string
}> {
}
const waitForSnapshot = <State, Event, Error, Output>(
  actor: Machine.MachineRef<State, Event, Error, Output>,
  predicate: (snapshot: Machine.RuntimeSnapshot<State, Error, Output>) => boolean
) =>
  actor.changes.pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((snapshots) => Array.from(snapshots)[0] as Machine.RuntimeSnapshot<State, Error, Output>)
  )
const sendAndWaitForSnapshot = <State, Event, Error, Output>(
  actor: Machine.MachineRef<State, Event, Error, Output>,
  event: Event,
  predicate: (snapshot: Machine.RuntimeSnapshot<State, Error, Output>) => boolean
) =>
  Effect.gen(function*() {
    const observer = yield* waitForSnapshot(actor, predicate).pipe(Effect.forkChild)
    yield* actor.send(event)
    return yield* Fiber.join(observer)
  })
const assertStateSnapshot = <Path extends string, Value>(
  actual:
    | Machine.Machine.AtomicSnapshot<Path, Value>
    | Machine.Machine.CompoundSnapshot<"", undefined, Machine.Machine.AtomicSnapshot<Path, Value>>,
  path: Path,
  value: Value
) => {
  if (actual.path === "" && path !== "" && "state" in actual) {
    assert.strictEqual(actual.value, undefined)
    actual = actual.state as unknown as typeof actual
  }
  assert.strictEqual(actual.path, path)
  assert.deepStrictEqual(actual.value, value)
}
const assertCompoundStateSnapshot = <Path extends string, Value, Child>(
  actual:
    | Machine.Machine.CompoundSnapshot<Path, Value, Child>
    | Machine.Machine.CompoundSnapshot<"", undefined, Machine.Machine.CompoundSnapshot<Path, Value, Child>>,
  path: Path,
  value: Value,
  state: Child
) => {
  if (actual.path === "" && path !== "" && "state" in actual) {
    assert.strictEqual(actual.value, undefined)
    actual = actual.state as unknown as typeof actual
  }
  assert.strictEqual(actual.path, path)
  assert.deepStrictEqual(actual.value, value)
  assert.deepStrictEqual((actual as Machine.Machine.CompoundSnapshot<Path, Value, Child>).state, state)
}
const assertParallelStateSnapshot = <Path extends string, Value, States>(
  actual:
    | Machine.Machine.ParallelSnapshot<Path, Value, States>
    | Machine.Machine.CompoundSnapshot<"", undefined, Machine.Machine.ParallelSnapshot<Path, Value, States>>,
  path: Path,
  value: Value,
  states: States
) => {
  if (actual.path === "" && path !== "" && "state" in actual) {
    assert.strictEqual(actual.value, undefined)
    actual = actual.state as unknown as typeof actual
  }
  assert.strictEqual(actual.path, path)
  assert.deepStrictEqual(actual.value, value)
  assert.deepStrictEqual((actual as Machine.Machine.ParallelSnapshot<Path, Value, States>).states, states)
}
const assertMachineSchemaDecodeError = (
  actual: unknown,
  boundary: Machine.MachineSchemaDecodeError["boundary"],
  options?: {
    readonly state?: string
    readonly event?: string
  }
) => {
  assert.instanceOf(actual, Machine.MachineSchemaDecodeError)
  assert.strictEqual(actual.boundary, boundary)
  if (options?.state !== undefined) {
    assert.strictEqual(actual.state, options.state)
  }
  if (options?.event !== undefined) {
    assert.strictEqual(actual.event, options.event)
  }
  assert.isTrue(Schema.isSchemaError(actual.cause))
}
const assertMachineSchemaEncodeError = (
  actual: unknown,
  boundary: Machine.MachineSchemaEncodeError["boundary"],
  options?: {
    readonly state?: string
  }
) => {
  assert.instanceOf(actual, Machine.MachineSchemaEncodeError)
  assert.strictEqual(actual.boundary, boundary)
  if (options?.state !== undefined) {
    assert.strictEqual(actual.state, options.state)
  }
  assert.isTrue(Schema.isSchemaError(actual.cause))
}
const unsafeTagged = <
  const A extends {
    readonly _tag: PropertyKey
  }
>(value: A): A => value
describe("Machine", () => {
  it("creates independent one-shot implementations from one definition", () => {
    class Stable extends Schema.TaggedClass<Stable>("OneShotStable")("Stable", {}) {
    }
    class Ping extends Schema.TaggedClass<Ping>("OneShotPing")("Ping", {}) {
    }
    const states = Machine.state({ states: { Stable } })
    const definition = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(Ping)
    })
    const handlingPing = definition.handle({
      initial: {
        target: Machine.targets(states).root.Stable,
        decoded: true,
        data: new Stable({})
      },
      states: {
        Stable: { on: { Ping: { none: true } } }
      }
    })
    const ignoringPing = definition.handle({
      initial: {
        target: Machine.targets(states).root.Stable,
        decoded: true,
        data: new Stable({})
      },
      states: {
        Stable: {}
      }
    })
    assert.isFalse("handle" in handlingPing)
    assert.isFalse("handle" in ignoringPing)
    assert.deepStrictEqual(Machine.transitionDefinitions(handlingPing).map(({ trigger }) => trigger), [{
      type: "event",
      event: "Ping"
    }])
    assert.deepStrictEqual(Machine.transitionDefinitions(ignoringPing), [])
  })
  it.effect("captures event dispatch definitions supplied to handle", () =>
    Effect.gen(function*() {
      class Stable extends Schema.TaggedClass<Stable>("Stable")("Stable", {}) {
      }
      class Ping extends Schema.TaggedClass<Ping>("Ping")("Ping", {}) {
      }
      const states = Machine.state({ states: { Stable } })
      let captures = 0
      let resolves = 0
      const transition = {
        none: true as const,
        get resolve() {
          captures++
          return (): undefined => {
            resolves++
            return undefined
          }
        }
      }
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Ping)
      }).handle({
        initial: {
          target: Machine.targets(states).root.Stable,
          decoded: true,
          data: new Stable({})
        },
        states: {
          Stable: {
            on: {
              Ping: transition
            }
          }
        }
      })
      assert.strictEqual(captures, 1)
      assert.strictEqual(resolves, 0)
      assert.deepStrictEqual(Machine.transitionDefinitions(machine), [{
        source: "Stable",
        trigger: { type: "event", event: "Ping" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: undefined,
          selection: { path: undefined, kind: "none", scope: "local" },
          updates: []
        }]
      }])
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Ping({}))
      assert.strictEqual(resolves, 1)
      assert.strictEqual(planned.microsteps.length, 1)
      const step = planned.microsteps[0]!
      assert.isFalse(step.changed)
      assert.deepStrictEqual(step.exitPaths, [])
      assert.deepStrictEqual(step.entryPaths, [])
    }))
  it.effect("uses a bare selected target's default construction", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("BareTargetIdle")("Idle", {}) {
      }
      class Done extends Schema.TaggedClass<Done>("BareTargetDone")("Done", {}) {
      }
      class Finish extends Schema.TaggedClass<Finish>("BareTargetFinish")("Finish", {}) {
      }
      const root3 = Machine.state({ states: { Idle, Done } })
      const targets3 = Machine.targets(root3)
      const machine = Machine.make({
        root: root3,
        events: Machine.eventsFromSchemas(Finish)
      }).handle({
        initial: {
          target: Machine.targets(root3).root.Idle
        },
        states: {
          Idle: { on: { Finish: { target: targets3.root.Done } } },
          Done: {}
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Finish({}))
      assert.deepStrictEqual(planned.next.state, { path: "Done", value: new Done({}) })
      assert.deepStrictEqual(planned.microsteps[0]?.exitPaths, ["Idle"])
      assert.deepStrictEqual(planned.microsteps[0]?.entryPaths, ["Done"])
    }))
  it.effect("reenters a selected target without requiring a resolver", () =>
    Effect.gen(function*() {
      class Stable extends Schema.TaggedClass<Stable>("ResolverFreeReentryStable")("Stable", {}) {
      }
      class Restart extends Schema.TaggedClass<Restart>("ResolverFreeReentryRestart")("Restart", {}) {
      }
      const root4 = Machine.state({ states: { Stable } })
      const machine = Machine.make({
        root: root4,
        events: Machine.eventsFromSchemas(Restart)
      }).handle({
        initial: {
          target: Machine.targets(root4).root.Stable
        },
        states: {
          Stable: { on: { Restart: { none: true, reenter: true } } }
        }
      })
      assert.strictEqual(Machine.transitionDefinitions(machine)[0]?.reenter, true)
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Restart({}))
      assert.deepStrictEqual(planned.next, initial.state)
      assert.deepStrictEqual(planned.microsteps[0]?.exitPaths, ["Stable"])
      assert.deepStrictEqual(planned.microsteps[0]?.entryPaths, ["Stable"])
    }))
  it.effect("captures named branches once with stable semantic keys", () =>
    Effect.gen(function*() {
      class Stable extends Schema.TaggedClass<Stable>("NamedBranchStable")("Stable", {}) {
      }
      class Ping extends Schema.TaggedClass<Ping>("NamedBranchPing")("Ping", { route: Schema.Boolean }) {
      }
      const states = Machine.state({ states: { Stable } })
      const targets5 = Machine.targets(states)
      const declarations = {
        unchanged: { none: true as const },
        refresh: { title: "Refresh stable state", target: targets5.root.Stable }
      }
      const definition = Machine.make({
        branches: { refresh: declarations },
        root: states,
        events: Machine.eventsFromSchemas(Ping)
      })
      const machine = definition.handle({
        initial: {
          target: Machine.targets(states).root.Stable,
          decoded: true,
          data: new Stable({})
        },
        states: {
          Stable: {
            on: {
              Ping: {
                branches: "refresh",
                reenter: true,
                resolve: ({ event, select }) =>
                  event.route ? select.refresh.decoded(new Stable({})) : select.unchanged()
              }
            }
          }
        }
      })
      declarations.refresh.title = "mutated after capture"
      assert.deepStrictEqual(Machine.transitionDefinitions(machine), [{
        source: "Stable",
        trigger: { type: "event", event: "Ping" },
        reenter: true,
        acceptance: "required",
        branches: [{
          type: "branch",
          key: "unchanged",
          title: "unchanged",
          target: undefined,
          selection: { path: undefined, kind: "none", scope: "local" },
          updates: []
        }, {
          type: "branch",
          key: "refresh",
          title: "Refresh stable state",
          target: "Stable",
          selection: { path: "Stable", kind: "state", scope: "branch" },
          updates: []
        }]
      }])
      const initial = yield* Machine.planInitial(machine)
      const unchanged = yield* Machine.plan(machine, initial.state, new Ping({ route: false }))
      const refresh = yield* Machine.plan(machine, initial.state, new Ping({ route: true }))
      assert.strictEqual(unchanged.microsteps[0]?.transitions[0]?.branchKey, "unchanged")
      assert.strictEqual(refresh.microsteps[0]?.transitions[0]?.branchKey, "refresh")
      assert.deepStrictEqual(unchanged.microsteps[0]?.exitPaths, ["Stable"])
      assert.deepStrictEqual(unchanged.microsteps[0]?.entryPaths, ["Stable"])
    }))
  it("rejects branch records without stable string identities", () => {
    class Stable extends Schema.TaggedClass<Stable>("InvalidBranchStable")("Stable", {}) {
    }
    class Ping extends Schema.TaggedClass<Ping>("InvalidBranchPing")("Ping", {}) {
    }
    const InvalidBranchRoot = Machine.state({ states: { Stable } })
    const handle = (group: object) => () =>
      Machine.make({
        root: InvalidBranchRoot,
        events: Machine.eventsFromSchemas(Ping),
        branches: { invalid: group } as any
      }).handle({
        initial: { decoded: true, data: new Stable({}), target: Machine.targets(InvalidBranchRoot).root.Stable },
        states: {
          Stable: { on: { Ping: { branches: "invalid", resolve: () => undefined } as any } }
        }
      })
    assert.throws(handle({}), /requires a branch/)
    assert.throws(handle([{ none: true }]), /branch record/)
    assert.throws(handle({ "": { none: true } }), /non-index string branch keys/)
    assert.throws(handle({ 0: { none: true } }), /non-index string branch keys/)
    assert.throws(handle({ invalid: { title: "", none: true } }), /non-empty string/)
    assert.throws(handle({ invalid: { target: undefined } }), /exactly one destination operation/)
    assert.throws(handle({ valid: { none: true }, [Symbol("invalid")]: { none: true } }), /cannot use symbol keys/)
  })
  it.effect("rejects selected branch evidence from another transition", () =>
    Effect.gen(function*() {
      class Stable extends Schema.TaggedClass<Stable>("OwnedBranchStable")("Stable", {}) {
      }
      class Capture extends Schema.TaggedClass<Capture>("OwnedBranchCapture")("Capture", {}) {
      }
      class Reuse extends Schema.TaggedClass<Reuse>("OwnedBranchReuse")("Reuse", {}) {
      }
      let captured: unknown
      const root6 = Machine.state({ states: { Stable } })
      const machine = Machine.make({
        branches: { transition1: { unchanged: { none: true } }, transition2: { unchanged: { none: true } } },
        root: root6,
        events: Machine.eventsFromSchemas(Capture, Reuse)
      }).handle({
        initial: {
          target: Machine.targets(root6).root.Stable,
          decoded: true,
          data: new Stable({})
        },
        states: {
          Stable: {
            on: {
              Capture: {
                branches: "transition1",
                resolve: ({ select }) => {
                  captured = select.unchanged()
                  return captured as ReturnType<typeof select.unchanged>
                }
              },
              Reuse: {
                branches: "transition2",
                resolve: ({ select }) => captured as ReturnType<typeof select.unchanged>
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const first = yield* Machine.plan(machine, initial.state, new Capture({}))
      const exit = yield* Effect.exit(Machine.plan(machine, first.next, new Reuse({})))
      assert.strictEqual(exit._tag, "Failure")
      if (exit._tag === "Failure") {
        assert(Cause.hasDies(exit.cause))
        assert.match(String(Cause.squash(exit.cause)), /must select one declared branch/)
      }
    }))
  const Input = Schema.Struct({
    userId: Schema.String
  })
  const NonEmptyInput = Schema.Struct({
    userId: Schema.NonEmptyString
  })
  class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {
    userId: Schema.String
  }) {
  }
  class NonEmptyIdle extends Schema.TaggedClass<NonEmptyIdle>("NonEmptyIdle")("NonEmptyIdle", {
    userId: Schema.NonEmptyString
  }) {
  }
  class Loading extends Schema.TaggedClass<Loading>("Loading")("Loading", {
    requestId: Schema.String
  }) {
  }
  class NonEmptyLoading extends Schema.TaggedClass<NonEmptyLoading>("NonEmptyLoading")("NonEmptyLoading", {
    requestId: Schema.NonEmptyString
  }) {
  }
  class DefaultedIdle extends Schema.TaggedClass<DefaultedIdle>("DefaultedIdle")("DefaultedIdle", {
    id: Schema.String,
    label: Schema.String.pipe(Schema.optionalKey, Schema.withConstructorDefault(Effect.succeed("default-label")))
  }) {
  }
  class Success extends Schema.TaggedClass<Success>("Success")("Success", {
    requestId: Schema.String
  }) {
  }
  class NonEmptyDone extends Schema.TaggedClass<NonEmptyDone>("NonEmptyDone")("NonEmptyDone", {
    requestId: Schema.NonEmptyString
  }) {
  }
  class Failed extends Schema.TaggedClass<Failed>("Failed")("Failed", {
    message: Schema.String
  }) {
  }
  class Duplicate extends Schema.TaggedClass<Duplicate>("Duplicate")("Duplicate", {
    value: Schema.String
  }) {
  }
  class EncodedCount extends Schema.TaggedClass<EncodedCount>("EncodedCount")("EncodedCount", {
    count: Schema.NumberFromString
  }) {
  }
  class Payment extends Schema.TaggedClass<Payment>("Payment")("Payment", {
    id: Schema.String
  }) {
  }
  class EnteringPayment extends Schema.TaggedClass<EnteringPayment>("EnteringPayment")("EnteringPayment", {
    amount: Schema.Number
  }) {
  }
  class AuthorizedPayment extends Schema.TaggedClass<AuthorizedPayment>("AuthorizedPayment")("AuthorizedPayment", {
    code: Schema.String
  }) {
  }
  class Fulfillment extends Schema.TaggedClass<Fulfillment>("Fulfillment")("Fulfillment", {
    id: Schema.String
  }) {
  }
  class Inventory extends Schema.TaggedClass<Inventory>("Inventory")("Inventory", {
    warehouse: Schema.String
  }) {
  }
  class CheckingInventory extends Schema.TaggedClass<CheckingInventory>("CheckingInventory")("CheckingInventory", {
    sku: Schema.String
  }) {
  }
  class InventoryReserved extends Schema.TaggedClass<InventoryReserved>("InventoryReserved")("InventoryReserved", {
    reservationId: Schema.String
  }) {
  }
  class Shipping extends Schema.TaggedClass<Shipping>("Shipping")("Shipping", {
    address: Schema.String
  }) {
  }
  class QuotingShipping extends Schema.TaggedClass<QuotingShipping>("QuotingShipping")("QuotingShipping", {
    postalCode: Schema.String
  }) {
  }
  class ShippingQuoted extends Schema.TaggedClass<ShippingQuoted>("ShippingQuoted")("ShippingQuoted", {
    quoteId: Schema.String
  }) {
  }
  class Submit extends Schema.TaggedClass<Submit>("Submit")("Submit", {
    value: Schema.String
  }) {
  }
  class NonEmptySubmit extends Schema.TaggedClass<NonEmptySubmit>("NonEmptySubmit")("NonEmptySubmit", {
    value: Schema.NonEmptyString
  }) {
  }
  class RequestSucceeded extends Schema.TaggedClass<RequestSucceeded>("RequestSucceeded")("RequestSucceeded", {
    value: Schema.String
  }) {
  }
  class ParallelRoot extends Schema.TaggedClass<ParallelRoot>("ParallelRoot")("ParallelRoot", {
    id: Schema.String
  }) {
  }
  class ParallelLeftDone extends Schema.TaggedClass<ParallelLeftDone>("ParallelLeftDone")("ParallelLeftDone", {
    id: Schema.String
  }) {
  }
  class ParallelRightDone extends Schema.TaggedClass<ParallelRightDone>("ParallelRightDone")("ParallelRightDone", {
    id: Schema.String
  }) {
  }
  class RequestProgress extends Schema.TaggedClass<RequestProgress>("RequestProgress")("RequestProgress", {
    id: Schema.String,
    childState: Schema.String
  }) {
  }
  class RequestFailed extends Schema.TaggedClass<RequestFailed>("RequestFailed")("RequestFailed", {
    error: Schema.Any,
    cause: Schema.Any
  }) {
  }
  class Reset extends Schema.TaggedClass<Reset>("Reset")("Reset", {}) {
  }
  class Resolve extends Schema.TaggedClass<Resolve>("Resolve")("Resolve", {}) {
  }
  class Authorize extends Schema.TaggedClass<Authorize>("Authorize")("Authorize", {
    code: Schema.String
  }) {
  }
  class ReserveInventory extends Schema.TaggedClass<ReserveInventory>("ReserveInventory")("ReserveInventory", {
    reservationId: Schema.String
  }) {
  }
  const FlatInitial = {
    Idle: (value: Idle) => ({ path: "Idle" as const, value }),
    Loading: (value: Loading) => ({ path: "Loading" as const, value }),
    Success: (value: Success) => ({ path: "Success" as const, value }),
    Failed: (value: Failed) => ({ path: "Failed" as const, value })
  }
  const SuccessOutput = {
    schema: Success,
    type: "final",
    output: Schema.String
  } as const
  const FailedOutput = {
    schema: Failed,
    type: "final",
    output: Schema.String
  } as const
  const LowercaseInitial = {
    idle: (value: Idle) => ({ path: "idle" as const, value }),
    loading: (value: Loading) => ({ path: "loading" as const, value }),
    success: (value: Success) => ({ path: "success" as const, value })
  }
  it.effect("make constructs the initial state from input", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle }
      })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(states).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {}
        }
      })
      const planned = yield* Machine.planInitial(machine, { userId: "user-1" })
      assert.strictEqual(Machine.isMachine(machine), true)
      assert.deepStrictEqual(planned.state.state.value, new Idle({ userId: "user-1" }))
    }))
  it("isMachine requires the machine brand value, not only its property key", () => {
    const states = Machine.state({ states: { Idle } })
    const machine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas()
    }).handle({
      initial: {
        target: Machine.targets(states).root.Idle,
        decoded: true,
        data: new Idle({ userId: "user-1" })
      },
      states: {
        Idle: {}
      }
    })
    assert.strictEqual(Machine.isMachine(machine), true)
    assert.strictEqual(Machine.isMachine({ [Machine.TypeId]: "not-a-machine" }), false)
  })
  it.effect("constructs a sibling target by destructuring the source value", () =>
    Effect.gen(function*() {
      class Convert extends Schema.TaggedClass<Convert>("Convert")("Convert", {}) {
      }
      const states = Machine.state({ states: { Submit, RequestSucceeded } })
      const targets7 = Machine.targets(states)
      const definition = Machine.make({
        branches: { transition1: { destination: { target: targets7.root.RequestSucceeded } } },
        root: states,
        events: Machine.eventsFromSchemas(Convert)
      })
      const machine = definition.handle({
        initial: {
          target: Machine.targets(states).root.Submit,
          decoded: true,
          data: new Submit({ value: "loaded" })
        },
        states: {
          Submit: {
            on: {
              Convert: {
                branches: "transition1",
                resolve: ({ state, select: { destination: target } }) => {
                  const { _tag: _, ...fields } = state
                  return target.from(fields)
                }
              }
            }
          },
          RequestSucceeded: {}
        }
      })
      const plan = yield* Machine.plan(machine, {
        path: "" as const,
        value: undefined,
        state: { path: "Submit" as const, value: new Submit({ value: "loaded" }) }
      }, new Convert({}))
      assert.instanceOf(plan.next.state.value, RequestSucceeded)
      assert.deepStrictEqual(plan.next.state.value, new RequestSucceeded({ value: "loaded" }))
    }))
  it("make stores the machine id", () => {
    const states = Machine.state({
      fields: {
        input: Schema.toType(Input)
      },
      states: { Idle, Loading }
    })
    const targets8 = Machine.targets(states)
    const machine = Machine.make({
      id: "UserMachine",
      root: states,
      events: Machine.eventsFromSchemas(Submit),
      input: Input
    }).handle({
      initial: {
        target: Machine.targets(states).root.Idle,
        decoded: true,
        data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
      },
      root: ({ input }) => ({ input }),
      states: {
        Idle: {
          on: {
            Submit: {
              target: targets8.root.Loading,
              decoded: true,
              data: () => (new Loading({ requestId: "request-1" }))
            }
          }
        },
        Loading: {}
      }
    })
    assert.strictEqual(machine.id, "UserMachine")
  })
  it("identifies the initial lifecycle event", () => {
    assert.strictEqual(Machine.isInitialEvent(Machine.InitialEvent), true)
    assert.strictEqual(Machine.isInitialEvent(new Submit({ value: "request-1" })), false)
  })
  it.effect("states returns states accepted by make", () =>
    Effect.gen(function*() {
      const states = { idle: Idle, loading: Loading }
      const defined = Machine.state({ states })
      const machine = Machine.make({
        root: defined,
        events: Machine.eventsFromSchemas(Submit)
      }).handle({
        initial: {
          target: Machine.targets(defined).root.idle,
          decoded: true,
          data: new Idle({ userId: "user-1" })
        },
        states: {
          idle: {},
          loading: {}
        }
      })
      const planned = yield* Machine.planInitial(machine)
      assert.notStrictEqual(defined.node.states, states)
      assert.deepStrictEqual(defined.node.states, states)
      assert.isTrue(Object.isFrozen(defined.node.states))
      assert.strictEqual(planned.state.state.path, "idle")
      assert.deepStrictEqual(planned.state.state.value, new Idle({ userId: "user-1" }))
    }))
  it("states selects active compound and parallel state paths", () => {
    const states = Machine.state({
      states: {
        fulfillment: {
          schema: Fulfillment,
          type: "parallel",
          states: {
            inventory: {
              schema: Inventory,
              states: {
                checking: CheckingInventory,
                reserved: InventoryReserved
              }
            },
            shipping: {
              schema: Shipping,
              states: {
                quoting: QuotingShipping,
                quoted: ShippingQuoted
              }
            }
          }
        }
      }
    })
    const fulfillment = new Fulfillment({ id: "fulfillment-1" })
    const inventory = new Inventory({ warehouse: "warehouse-1" })
    const checking = new CheckingInventory({ sku: "sku-1" })
    const shipping = new Shipping({ address: "Main Street" })
    const quoting = new QuotingShipping({ postalCode: "12345" })
    const snapshot = {
      path: "" as const,
      value: undefined,
      state: {
        path: "fulfillment" as const,
        value: fulfillment,
        states: {
          inventory: {
            path: "fulfillment.inventory" as const,
            value: inventory,
            state: { path: "fulfillment.inventory.checking" as const, value: checking }
          },
          shipping: {
            path: "fulfillment.shipping" as const,
            value: shipping,
            state: { path: "fulfillment.shipping.quoting" as const, value: quoting }
          }
        }
      }
    }
    assert.deepStrictEqual(states.get(snapshot, "fulfillment"), Option.some(fulfillment))
    assert.deepStrictEqual(states.get(snapshot, "fulfillment.inventory"), Option.some(inventory))
    assert.deepStrictEqual(states.get(snapshot, "fulfillment.inventory.checking"), Option.some(checking))
    assert.deepStrictEqual(states.get(snapshot, "fulfillment.shipping.quoting"), Option.some(quoting))
    assert.deepStrictEqual(states.get(snapshot, "fulfillment.inventory.reserved"), Option.none())
    assert.deepStrictEqual(
      states.getWithParents(snapshot, "fulfillment.inventory.checking"),
      Option.some({
        value: checking,
        parents: {
          fulfillment,
          "fulfillment.inventory": inventory
        }
      })
    )
    assert.deepStrictEqual(
      states.getWithParents(snapshot, "fulfillment"),
      Option.some({ value: fulfillment, parents: {} })
    )
    assert.deepStrictEqual(states.getWithParents(snapshot, "fulfillment.inventory.reserved"), Option.none())
    assert.deepStrictEqual(
      states.getSnapshot(snapshot, "fulfillment.inventory.checking"),
      Option.some({ path: "fulfillment.inventory.checking" as const, value: checking })
    )
    assert.strictEqual(states.matches(snapshot, "fulfillment.shipping"), true)
    assert.strictEqual(states.matches(snapshot, "fulfillment.shipping.quoted"), false)
    const fulfillmentSnapshot = Option.getOrThrow(states.getSnapshot(snapshot, "fulfillment"))
    assert.deepStrictEqual(states.get(fulfillmentSnapshot, "fulfillment.inventory"), Option.some(inventory))
    assert.deepStrictEqual(
      states.getSnapshot(fulfillmentSnapshot, "fulfillment.shipping"),
      Option.some(fulfillmentSnapshot.states.shipping)
    )
    assert.strictEqual(states.matches(fulfillmentSnapshot, "fulfillment.inventory.checking"), true)
    assert.strictEqual(states.matches(fulfillmentSnapshot, "fulfillment.inventory.reserved"), false)
    const inventorySnapshot = Option.getOrThrow(states.getSnapshot(fulfillmentSnapshot, "fulfillment.inventory"))
    assert.deepStrictEqual(states.get(inventorySnapshot, "fulfillment.inventory"), Option.some(inventory))
    assert.deepStrictEqual(states.get(inventorySnapshot, "fulfillment.inventory.checking"), Option.some(checking))
  })
  it.effect("initial builder constructs compound initial snapshots", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        states: {
          payment: {
            schema: Payment,
            states: {
              entering: EnteringPayment,
              authorized: AuthorizedPayment
            }
          }
        }
      })
      const payment = new Payment({ id: "payment-1" })
      const entering = new EnteringPayment({ amount: 100 })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Authorize)
      }).handle({
        initial: {
          target: Machine.targets(states).root.payment,
          decoded: true,
          data: payment
        },
        states: {
          payment: {
            initial: {
              target: Machine.targets(states).root.payment.entering,
              decoded: true,
              data: entering
            },
            states: {
              entering: {},
              authorized: {}
            }
          }
        }
      })
      const planned = yield* Machine.planInitial(machine)
      assertCompoundStateSnapshot(planned.state.state, "payment", payment, {
        path: "payment.entering" as const,
        value: entering
      })
    }))
  it.effect("initial builder constructs parallel initial snapshots", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        }
      })
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const checking = new CheckingInventory({ sku: "sku-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(ReserveInventory)
      }).handle({
        initial: {
          target: Machine.targets(states).root.fulfillment,
          decoded: true,
          data: fulfillment
        },
        states: {
          fulfillment: {
            initial: { inventory: { decoded: true, data: inventory }, shipping: { decoded: true, data: shipping } },
            states: {
              inventory: {
                initial: {
                  target: Machine.targets(states).root.fulfillment.inventory.checking,
                  decoded: true,
                  data: checking
                },
                states: {
                  checking: {},
                  reserved: {}
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(states).root.fulfillment.shipping.quoting,
                  decoded: true,
                  data: quoting
                },
                states: {
                  quoting: {},
                  quoted: {}
                }
              }
            }
          }
        }
      })
      const planned = yield* Machine.planInitial(machine)
      assertParallelStateSnapshot(planned.state.state, "fulfillment", fulfillment, {
        inventory: {
          path: "fulfillment.inventory" as const,
          value: inventory,
          state: {
            path: "fulfillment.inventory.checking" as const,
            value: checking
          }
        },
        shipping: {
          path: "fulfillment.shipping" as const,
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting" as const,
            value: quoting
          }
        }
      })
    }))
  describe("event constructor", () => {
    it.effect("constructs public and internal events lazily through protocol-bound collections", () =>
      Effect.gen(function*() {
        const PublicEvent = Schema.TaggedUnion({
          SetValue: { value: Schema.NonEmptyString },
          Reset: {}
        })
        const FiniteEvent = Schema.Struct({
          _tag: Schema.Union([Schema.Literal("Alpha"), Schema.Literal("Beta")]),
          value: Schema.String
        })
        class Defaulted extends Schema.TaggedClass<Defaulted>("DeferredDefaulted")("Defaulted", {
          id: Schema.String,
          label: Schema.String.pipe(Schema.optionalKey, Schema.withConstructorDefault(Effect.succeed("default-label")))
        }) {
        }
        const InternalEvent = Schema.TaggedUnion({
          Loaded: { value: Schema.String },
          TimedOut: {}
        })
        const State = Schema.TaggedStruct("DeferredEventState", { value: Schema.String })
        const states = Machine.state({ states: { Active: State } })
        const events = Machine.eventsFromSchemas(PublicEvent, Defaulted, FiniteEvent)
        const internalEvents = Machine.internalEventsFromSchemas(InternalEvent)
        const targets9 = Machine.targets(states)
        const definition = Machine.make({
          root: states,
          events,
          internalEvents
        })
        const machine = definition.handle({
          initial: {
            target: Machine.targets(states).root.Active,
            data: { value: "initial" }
          },
          states: {
            Active: {
              on: {
                SetValue: { target: targets9.root.Active, data: ({ event }) => ({ value: event.value }) },
                Reset: {
                  none: true,
                  resolve: (_, enqueue) => {
                    enqueue.raise(internalEvents.Loaded({ value: "loaded" }))
                    return undefined
                  }
                },
                Defaulted: {
                  target: targets9.root.Active,
                  data: ({ event }) => ({ value: event.label ?? "default-label" })
                },
                Loaded: { target: targets9.root.Active, data: ({ event }) => ({ value: event.value }) },
                TimedOut: { target: targets9.root.Active, data: () => ({ value: "timed-out" }) },
                Alpha: { target: targets9.root.Active, data: ({ event }) => ({ value: event.value }) },
                Beta: { target: targets9.root.Active, data: ({ event }) => ({ value: event.value }) }
              }
            }
          }
        })
        assert.deepStrictEqual(Object.keys(events), ["SetValue", "Reset", "Defaulted", "Alpha", "Beta"])
        assert.deepStrictEqual(Object.keys(internalEvents), ["Loaded", "TimedOut"])
        assert.strictEqual(definition.events, events)
        assert.strictEqual(definition.internalEvents, internalEvents)
        assert.strictEqual(Object.isFrozen(events), true)
        assert.strictEqual(Object.hasOwn(events, "schemas"), false)
        assert.strictEqual(Object.hasOwn(events, "cases"), false)
        const reset = events.Reset()
        assert.strictEqual(Object.isFrozen(reset), true)
        assert.strictEqual(Object.hasOwn(reset, "schema"), false)
        assert.strictEqual(Object.hasOwn(reset, "input"), false)
        const initial = yield* Machine.planInitial(machine)
        const fields = { value: "next" }
        const setValue = events.SetValue(fields)
        fields.value = "mutated"
        const set = yield* Machine.plan(machine, initial.state, setValue)
        assert.deepStrictEqual(set.next.state, {
          path: "Active" as const,
          value: { _tag: "DeferredEventState", value: "next" }
        })
        const defaulted = yield* Machine.plan(machine, set.next, events.Defaulted({ id: "event-1" }))
        assert.deepStrictEqual(defaulted.next.state, {
          path: "Active" as const,
          value: { _tag: "DeferredEventState", value: "default-label" }
        })
        const loaded = yield* Machine.plan(machine, defaulted.next, events.Reset())
        assert.deepStrictEqual(loaded.next.state, {
          path: "Active" as const,
          value: { _tag: "DeferredEventState", value: "loaded" }
        })
        const alpha = yield* Machine.plan(machine, loaded.next, events.Alpha({ value: "alpha" }))
        assert.deepStrictEqual(alpha.next.state, {
          path: "Active" as const,
          value: { _tag: "DeferredEventState", value: "alpha" }
        })
      }))
    it.effect("reports deferred constructor failures through the running machine", () =>
      Effect.gen(function*() {
        const Event = Schema.TaggedUnion({
          Submit: { value: Schema.NonEmptyString }
        })
        const states = Machine.state({ states: { Idle: {} } })
        const definition = Machine.make({
          id: "deferred-event-failure",
          root: states,
          events: Machine.eventsFromSchemas(Event)
        })
        const events = definition.events
        const machine = definition.handle({
          initial: {
            target: Machine.targets(states).root.Idle
          },
          states: {
            Idle: {
              on: {
                Submit: { none: true }
              }
            }
          }
        })
        let construction: ReturnType<typeof events.Submit> | undefined
        assert.doesNotThrow(() => {
          construction = events.Submit({ value: "" })
        })
        const accessorFailure = events.Submit({
          get value(): string {
            throw new Error("accessor failed")
          }
        })
        const initial = yield* Machine.planInitial(machine)
        const planningError = yield* Machine.plan(machine, initial.state, construction!).pipe(Effect.flip)
        assertMachineSchemaDecodeError(planningError, "event", { event: "Submit" })
        const accessorError = yield* Machine.plan(machine, initial.state, accessorFailure).pipe(Effect.flip)
        assert.instanceOf(accessorError, Machine.MachineSchemaDecodeError)
        assert.strictEqual(accessorError.boundary, "event")
        assert.strictEqual(accessorError.event, "Submit")
        assert.isTrue(Cause.isCause(accessorError.cause))
        const actor = yield* Machine.start(machine)
        const snapshot = yield* sendAndWaitForSnapshot(actor, construction!, (snapshot) => snapshot.status === "error")
        const error = yield* Effect.flip(actor.join)
        assertMachineSchemaDecodeError(error, "event", { event: "Submit" })
        assert.strictEqual(snapshot.status, "error")
      }))
    it.effect("plans inline Effect and timer outcomes", () =>
      Effect.gen(function*() {
        const release = yield* Deferred.make<void>()
        const InternalEvent = Schema.TaggedUnion({ Loaded: {}, TimedOut: {} })
        const states = Machine.state({ states: { Loading: {}, Waiting: {}, Done: {} } })
        const targets11 = Machine.targets(states)
        const definition = Machine.make({
          effects: { source1: Effect.suspend(() => Deferred.await(release)) },
          timers: { source2: "1 second" },
          root: states,
          events: Machine.eventsFromSchemas(),
          internalEvents: Machine.internalEventsFromSchemas(InternalEvent)
        })
        const machine = definition.handle({
          initial: {
            target: Machine.targets(states).root.Loading
          },
          states: {
            Loading: {
              invoke: { src: "source1", id: "load", onDone: { target: targets11.root.Waiting } }
            },
            Waiting: {
              invoke: { src: "source2", id: "timeout", onDone: { target: targets11.root.Done } }
            },
            Done: {}
          }
        })
        const actor = yield* Machine.start(machine)
        const waiting = yield* waitForSnapshot(actor, (snapshot) =>
          snapshot.status === "active" && snapshot.state.state.path === "Waiting").pipe(Effect.forkChild)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(waiting)
        const done = yield* waitForSnapshot(actor, (snapshot) =>
          snapshot.status === "active" && snapshot.state.state.path === "Done").pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(done)
        yield* actor.stop
      }))
    it.effect("rejects a construction owned by another machine protocol", () =>
      Effect.gen(function*() {
        const FirstEvent = Schema.TaggedUnion({ Submit: { value: Schema.String } })
        const SecondEvent = Schema.TaggedUnion({ Submit: { value: Schema.String } })
        const states = Machine.state({ states: { Idle: {} } })
        const first = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(FirstEvent)
        }).handle({
          initial: {
            target: Machine.targets(states).root.Idle
          },
          states: {
            Idle: {}
          }
        })
        const second = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(SecondEvent)
        }).handle({
          initial: {
            target: Machine.targets(states).root.Idle
          },
          states: {
            Idle: {
              on: {
                Submit: { none: true }
              }
            }
          }
        })
        const construction = first.events.Submit({ value: "value" })
        const initial = yield* Machine.planInitial(second)
        const error = yield* Machine.plan(second, initial.state, construction).pipe(Effect.flip)
        assert.instanceOf(error, Machine.MachineSchemaDecodeError)
        assert.strictEqual(error.boundary, "event")
        assert.strictEqual(error.event, "Submit")
        assert.isTrue(Cause.isCause(error.cause))
      }))
  })
  describe("state builder from", () => {
    it.effect("constructs TaggedClass initial state and applies constructor defaults", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { idle: DefaultedIdle } })
        const machine = Machine.make({
          id: "from-default",
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.idle,
            data: { id: "idle-1" }
          },
          states: {
            idle: {}
          }
        })
        const planned = yield* Machine.planInitial(machine)
        assert.instanceOf(planned.state.state.value, DefaultedIdle)
        assert.deepStrictEqual(planned.state.state.value, new DefaultedIdle({ id: "idle-1", label: "default-label" }))
      }))
    it.effect("constructs TaggedUnion states without requiring discriminator fields", () =>
      Effect.gen(function*() {
        const State = Schema.TaggedUnion({
          Idle: {},
          Done: { requestId: Schema.String }
        })
        const Event = Schema.TaggedUnion({
          Submit: { requestId: Schema.String }
        })
        const states = Machine.state({
          states: {
            Idle: State.cases.Idle,
            Done: {
              schema: State.cases.Done,
              type: "final"
            }
          }
        })
        const targets13 = Machine.targets(states)
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(Event)
        }).handle({
          initial: {
            target: Machine.targets(states).root.Idle
          },
          states: {
            Idle: {
              on: {
                Submit: { target: targets13.root.Done, data: ({ event }) => ({ requestId: event.requestId }) }
              }
            },
            Done: {}
          }
        })
        const initial = yield* Machine.planInitial(machine)
        const planned = yield* Machine.plan(machine, initial.state, Event.cases.Submit.make({ requestId: "request-1" }))
        assert.deepStrictEqual(initial.state.state.value, State.cases.Idle.make({}))
        assert.deepStrictEqual(planned.next.state.value, State.cases.Done.make({ requestId: "request-1" }))
        assert.isTrue(planned.done)
      }))
    it.effect("constructs default-only TaggedClass state without an input argument", () =>
      Effect.gen(function*() {
        class DefaultOnly extends Schema.TaggedClass<DefaultOnly>("DefaultOnly")("DefaultOnly", {
          label: Schema.String.pipe(Schema.optionalKey, Schema.withConstructorDefault(Effect.succeed("default-label")))
        }) {
        }
        const states = Machine.state({ states: { DefaultOnly } })
        const machine = Machine.make({
          id: "from-default-only",
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.DefaultOnly
          },
          states: {
            DefaultOnly: {}
          }
        })
        const planned = yield* Machine.planInitial(machine)
        assert.instanceOf(planned.state.state.value, DefaultOnly)
        assert.strictEqual(planned.state.state.value.label, "default-label")
      }))
    it.effect("constructs nested empty compound targets across local, branch, and full builders", () =>
      Effect.gen(function*() {
        const State = Schema.TaggedUnion({
          Flow: {},
          Idle: {},
          Running: {},
          Nested: {},
          NestedIdle: {},
          Done: {}
        })
        const Event = Schema.TaggedUnion({
          Local: {},
          LocalWith: {},
          Branch: {},
          Full: {},
          Finish: {}
        })
        const states = Machine.state({
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
            }
          }
        })
        const targets14 = Machine.targets(states)
        const machine = Machine.make({
          branches: {
            transition3: { destination: { target: targets14.root.Flow.Nested } },
            transition4: { destination: { target: targets14.root.Flow } }
          },
          id: "from-empty-targets",
          root: states,
          events: Machine.eventsFromSchemas(
            Event.cases.Local,
            Event.cases.LocalWith,
            Event.cases.Branch,
            Event.cases.Full,
            Event.cases.Finish
          )
        }).handle({
          initial: {
            target: Machine.targets(states).root.Flow
          },
          states: {
            Flow: {
              initial: {
                target: Machine.targets(states).root.Flow.Idle
              },
              states: {
                Idle: {
                  on: {
                    Local: { target: targets14.root.Flow.Running },
                    LocalWith: { target: targets14.root.Flow.Running },
                    Branch: {
                      branches: "transition3",
                      resolve: ({ select: { destination: target } }) =>
                        target.from((nested) => nested.NestedIdle.from())
                    },
                    Full: {
                      branches: "transition4",
                      resolve: ({ select: { destination: target } }) =>
                        target.from((flow) => flow.Nested.from((nested) => nested.NestedIdle.from()))
                    },
                    Finish: { target: targets14.root.Flow.Done }
                  }
                },
                Running: {},
                Nested: {
                  initial: {
                    target: Machine.targets(states).root.Flow.Nested.NestedIdle
                  },
                  states: {
                    NestedIdle: {}
                  }
                },
                Done: {}
              }
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)
        const local = yield* Machine.plan(machine, initial.state, Event.cases.Local.make({}))
        const localWith = yield* Machine.plan(machine, initial.state, Event.cases.LocalWith.make({}))
        const branch = yield* Machine.plan(machine, initial.state, Event.cases.Branch.make({}))
        const full = yield* Machine.plan(machine, initial.state, Event.cases.Full.make({}))
        const final = yield* Machine.plan(machine, initial.state, Event.cases.Finish.make({}))
        assert.strictEqual((local.next as any).state.state.path, "Flow.Running")
        assert.strictEqual((localWith.next as any).state.state.path, "Flow.Running")
        assert.strictEqual((branch.next as any).state.state.state.path, "Flow.Nested.NestedIdle")
        assert.strictEqual((full.next as any).state.state.state.path, "Flow.Nested.NestedIdle")
        assert.strictEqual((final.next as any).state.state.path, "Flow.Done")
        assert.deepStrictEqual((initial.state as any).state.value, State.cases.Flow.make({}))
        assert.deepStrictEqual((local.next as any).state.state.value, State.cases.Running.make({}))
        assert.deepStrictEqual((branch.next as any).state.state.value, State.cases.Nested.make({}))
        assert.deepStrictEqual((final.next as any).state.state.value, State.cases.Done.make({}))
      }))
    it.effect("constructs every empty region of an initial parallel state", () =>
      Effect.gen(function*() {
        const State = Schema.TaggedUnion({
          Parallel: {},
          Left: {},
          LeftIdle: {},
          Right: {},
          RightIdle: {}
        })
        const states = Machine.state({
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
        const machine = Machine.make({
          id: "from-empty-parallel",
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.Parallel
          },
          states: {
            Parallel: {
              states: {
                left: {
                  initial: {
                    target: Machine.targets(states).root.Parallel.left.LeftIdle
                  },
                  states: {
                    LeftIdle: {}
                  }
                },
                right: {
                  initial: {
                    target: Machine.targets(states).root.Parallel.right.RightIdle
                  },
                  states: {
                    RightIdle: {}
                  }
                }
              }
            }
          }
        })
        const planned = yield* Machine.planInitial(machine)
        assert.strictEqual((planned.state as any).state.states.left.state.path, "Parallel.left.LeftIdle")
        assert.strictEqual((planned.state as any).state.states.right.state.path, "Parallel.right.RightIdle")
        assert.deepStrictEqual((planned.state as any).state.value, State.cases.Parallel.make({}))
        assert.deepStrictEqual((planned.state as any).state.states.left.value, State.cases.Left.make({}))
        assert.deepStrictEqual((planned.state as any).state.states.right.value, State.cases.Right.make({}))
      }))
    it.effect("fails an omitted empty input refinement through MachineSchemaDecodeError", () =>
      Effect.gen(function*() {
        const State = Schema.TaggedUnion({ Blocked: {} })
        const Blocked = State.cases.Blocked.check(Schema.makeFilter(() => "blocked state cannot be entered"))
        const states = Machine.state({ states: { Blocked } })
        const machine = Machine.make({
          id: "from-empty-refinement",
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.Blocked
          },
          states: {
            Blocked: {}
          }
        })
        const error = yield* Effect.flip(Machine.planInitial(machine))
        assertMachineSchemaDecodeError(error, "state", { state: "Blocked" })
        assert.strictEqual((error as Machine.MachineSchemaDecodeError).machineId, "from-empty-refinement")
      }))
    it.effect("fails invalid refinement input through MachineSchemaDecodeError without throwing in the builder", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { NonEmptyIdle } })
        const machine = Machine.make({
          id: "from-refinement",
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            data: { userId: "" }
          },
          states: {
            NonEmptyIdle: {}
          }
        })
        const error = yield* Effect.flip(Machine.planInitial(machine))
        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyIdle" })
        assert.strictEqual((error as Machine.MachineSchemaDecodeError).machineId, "from-refinement")
      }))
    it.effect("fails invalid transition construction in the typed machine error channel", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { NonEmptyIdle, NonEmptyLoading } })
        const targets15 = Machine.targets(states)
        const machine = Machine.make({
          id: "from-transition-refinement",
          root: states,
          events: Machine.eventsFromSchemas(NonEmptySubmit)
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            data: { userId: "user-1" }
          },
          states: {
            NonEmptyIdle: {
              on: {
                NonEmptySubmit: { target: targets15.root.NonEmptyLoading, data: () => ({ requestId: "" }) }
              }
            },
            NonEmptyLoading: {}
          }
        })
        const initial = yield* Machine.planInitial(machine)
        const error = yield* Effect.flip(
          Machine.plan(machine, initial.state, new NonEmptySubmit({ value: "request-1" }))
        )
        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyLoading" })
        assert.strictEqual((error as Machine.MachineSchemaDecodeError).machineId, "from-transition-refinement")
      }))
    it.effect("constructs complete compound and parallel targets from schema input", () =>
      Effect.gen(function*() {
        const states = Machine.state({
          states: {
            idle: Idle,
            fulfillment: {
              schema: Fulfillment,
              type: "parallel",
              states: {
                inventory: {
                  schema: Inventory,
                  states: {
                    checking: CheckingInventory,
                    reserved: InventoryReserved
                  }
                },
                shipping: {
                  schema: Shipping,
                  states: {
                    quoting: QuotingShipping,
                    quoted: ShippingQuoted
                  }
                }
              }
            }
          }
        })
        const targets16 = Machine.targets(states)
        const machine = Machine.make({
          branches: { transition1: { destination: { target: targets16.root.fulfillment } } },
          root: states,
          events: Machine.eventsFromSchemas(Submit)
        }).handle({
          initial: {
            target: Machine.targets(states).root.idle,
            data: { userId: "user-1" }
          },
          states: {
            idle: {
              on: {
                Submit: {
                  branches: "transition1",
                  resolve: ({ event, select: { destination: target } }) =>
                    target.from({ id: event.value }, (fulfillment) =>
                      fulfillment
                        .inventory.from(
                          { warehouse: "warehouse-1" },
                          (inventory) => inventory.reserved.from({ reservationId: event.value })
                        )
                        .shipping.from(
                          { address: "Main Street" },
                          (shipping) => shipping.quoted.from({ quoteId: event.value })
                        ))
                }
              }
            },
            fulfillment: {
              initial: { inventory: { warehouse: "warehouse-1" }, shipping: { address: "Main Street" } },
              states: {
                inventory: {
                  initial: {
                    target: Machine.targets(states).root.fulfillment.inventory.checking,
                    data: { sku: "sku-1" }
                  },
                  states: {
                    checking: {},
                    reserved: {}
                  }
                },
                shipping: {
                  initial: {
                    target: Machine.targets(states).root.fulfillment.shipping.quoting,
                    data: { postalCode: "12345" }
                  },
                  states: {
                    quoting: {},
                    quoted: {}
                  }
                }
              }
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)
        const planned = yield* Machine.plan(machine, initial.state, new Submit({ value: "order-1" }))
        assertParallelStateSnapshot(planned.next as any, "fulfillment", new Fulfillment({ id: "order-1" }), {
          inventory: {
            path: "fulfillment.inventory" as const,
            value: new Inventory({ warehouse: "warehouse-1" }),
            state: {
              path: "fulfillment.inventory.reserved" as const,
              value: new InventoryReserved({ reservationId: "order-1" })
            }
          },
          shipping: {
            path: "fulfillment.shipping" as const,
            value: new Shipping({ address: "Main Street" }),
            state: {
              path: "fulfillment.shipping.quoted" as const,
              value: new ShippingQuoted({ quoteId: "order-1" })
            }
          }
        })
      }))
    it.effect("constructs local parent replacement and leaf targets from schema input", () =>
      Effect.gen(function*() {
        const states = Machine.state({
          states: {
            payment: {
              schema: Payment,
              states: {
                entering: EnteringPayment,
                authorized: AuthorizedPayment
              }
            }
          }
        })
        const targets17 = Machine.targets(states)
        const machine = Machine.make({
          branches: { transition1: { destination: { target: targets17.root.payment } } },
          root: states,
          events: Machine.eventsFromSchemas(Submit)
        }).handle({
          initial: {
            target: Machine.targets(states).root.payment,
            data: { id: "payment-1" }
          },
          states: {
            payment: {
              initial: {
                target: Machine.targets(states).root.payment.entering,
                data: { amount: 1 }
              },
              states: {
                entering: {
                  on: {
                    Submit: {
                      branches: "transition1",
                      resolve: ({ event, select: { destination: target } }) =>
                        target.from({ id: "payment-2" }, (payment) => payment.authorized.from({ code: event.value }))
                    }
                  }
                },
                authorized: {}
              }
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)
        const planned = yield* Machine.plan(machine, initial.state, new Submit({ value: "auth-1" }))
        assertCompoundStateSnapshot(planned.next as any, "payment", new Payment({ id: "payment-2" }), {
          path: "payment.authorized" as const,
          value: new AuthorizedPayment({ code: "auth-1" })
        })
      }))
    it.effect("constructs cross-branch ancestor and leaf values from schema input", () =>
      Effect.gen(function*() {
        const states = Machine.state({
          states: {
            workflow: {
              schema: Payment,
              states: {
                idle: Idle,
                checkout: {
                  schema: Fulfillment,
                  states: {
                    quoted: ShippingQuoted
                  }
                }
              }
            }
          }
        })
        const targets18 = Machine.targets(states)
        const machine = Machine.make({
          branches: { transition1: { destination: { target: targets18.root.workflow } } },
          root: states,
          events: Machine.eventsFromSchemas(Submit)
        }).handle({
          initial: {
            target: Machine.targets(states).root.workflow,
            data: { id: "workflow-1" }
          },
          states: {
            workflow: {
              initial: {
                target: Machine.targets(states).root.workflow.idle,
                data: { userId: "user-1" }
              },
              states: {
                idle: {
                  on: {
                    Submit: {
                      branches: "transition1",
                      resolve: ({ event, select: { destination: target } }) =>
                        target.from({ id: "workflow-2" }, (workflow) =>
                          workflow.checkout.from({ id: "checkout-1" }, (checkout) =>
                            checkout.quoted.from({ quoteId: event.value })))
                    }
                  }
                },
                checkout: {
                  initial: {
                    target: Machine.targets(states).root.workflow.checkout.quoted,
                    data: { quoteId: "initial" }
                  },
                  states: {
                    quoted: {}
                  }
                }
              }
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)
        const planned = yield* Machine.plan(machine, initial.state, new Submit({ value: "quote-1" }))
        assertCompoundStateSnapshot(planned.next as any, "workflow", new Payment({ id: "workflow-2" }), {
          path: "workflow.checkout" as const,
          value: new Fulfillment({ id: "checkout-1" }),
          state: {
            path: "workflow.checkout.quoted" as const,
            value: new ShippingQuoted({ quoteId: "quote-1" })
          }
        })
      }))
  })
  describe("runtime schema contracts", () => {
    it.effect("decodes input before initial state construction", () =>
      Effect.gen(function*() {
        const states = Machine.state({
          fields: {
            input: Schema.toType(NonEmptyInput)
          },
          states: { NonEmptyIdle }
        })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(NonEmptySubmit),
          input: NonEmptyInput
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            decoded: true,
            data: ({ root: { input: input } }) => new NonEmptyIdle({ userId: input.userId })
          },
          root: ({ input }) => ({ input }),
          states: {
            NonEmptyIdle: {}
          }
        })
        const error = yield* Effect.flip(Machine.planInitial(machine, { userId: "" as any }))
        assertMachineSchemaDecodeError(error, "input")
      }))
    it.effect("decodes initial state snapshots before accepting them", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { NonEmptyIdle } })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(NonEmptySubmit)
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            decoded: true,
            data: unsafeTagged({ _tag: "NonEmptyIdle", userId: "" })
          },
          states: {
            NonEmptyIdle: {}
          }
        })
        const error = yield* Effect.flip(Machine.planInitial(machine))
        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyIdle" })
      }))
    it.effect("decodes incoming events before handler selection", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { NonEmptyIdle } })
        const targets19 = Machine.targets(states)
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(NonEmptySubmit)
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            decoded: true,
            data: new NonEmptyIdle({ userId: "user-1" })
          },
          states: {
            NonEmptyIdle: {
              on: {
                NonEmptySubmit: { target: targets19.root.NonEmptyIdle, decoded: true, data: ({ state }) => state }
              }
            }
          }
        })
        const error = yield* Effect.flip(Machine.plan(machine, {
          path: "" as const,
          value: undefined,
          state: { path: "NonEmptyIdle" as const, value: new NonEmptyIdle({ userId: "user-1" }) }
        }, unsafeTagged({ _tag: "NonEmptySubmit", value: "" })))
        assertMachineSchemaDecodeError(error, "event", { event: "NonEmptySubmit" })
        const canError = yield* Effect.flip(Machine.can(machine, {
          path: "" as const,
          value: undefined,
          state: { path: "NonEmptyIdle" as const, value: new NonEmptyIdle({ userId: "user-1" }) }
        }, unsafeTagged({ _tag: "NonEmptySubmit", value: "" })))
        assertMachineSchemaDecodeError(canError, "event", { event: "NonEmptySubmit" })
      }))
    it.effect("surfaces sent event decode failures through the machine lifecycle", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { NonEmptyIdle } })
        const targets20 = Machine.targets(states)
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(NonEmptySubmit)
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            decoded: true,
            data: new NonEmptyIdle({ userId: "user-1" })
          },
          states: {
            NonEmptyIdle: {
              on: {
                NonEmptySubmit: { target: targets20.root.NonEmptyIdle, decoded: true, data: ({ state }) => state }
              }
            }
          }
        })
        const actor = yield* Machine.start(machine)
        const snapshot = yield* sendAndWaitForSnapshot(
          actor,
          unsafeTagged({ _tag: "NonEmptySubmit", value: "" }),
          (snapshot) => snapshot.status === "error"
        )
        const error = yield* Effect.flip(actor.join)
        assertMachineSchemaDecodeError(error, "event", { event: "NonEmptySubmit" })
        assert.strictEqual(snapshot.status, "error")
        if (snapshot.status === "error") {
          const reason = snapshot.cause.reasons[0]
          assert.ok(reason !== undefined)
          assert.strictEqual(Cause.isFailReason(reason), true)
          if (Cause.isFailReason(reason)) {
            assertMachineSchemaDecodeError(reason.error, "event", { event: "NonEmptySubmit" })
          }
        }
      }))
    it.effect("decodes transition target values before accepting them", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { NonEmptyIdle, NonEmptyLoading } })
        const targets21 = Machine.targets(states)
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(NonEmptySubmit)
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            decoded: true,
            data: new NonEmptyIdle({ userId: "user-1" })
          },
          states: {
            NonEmptyIdle: {
              on: {
                NonEmptySubmit: {
                  target: targets21.root.NonEmptyLoading,
                  decoded: true,
                  data: () => (unsafeTagged({ _tag: "NonEmptyLoading", requestId: "" }))
                }
              }
            },
            NonEmptyLoading: {}
          }
        })
        const error = yield* Effect.flip(Machine.plan(machine, {
          path: "" as const,
          value: undefined,
          state: { path: "NonEmptyIdle" as const, value: new NonEmptyIdle({ userId: "user-1" }) }
        }, new NonEmptySubmit({ value: "request-1" })))
        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyLoading" })
      }))
    it.effect("decodes same-state atomic snapshot targets in the compiled runtime", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { NonEmptyIdle } })
        const targets22 = Machine.targets(states)
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(NonEmptySubmit)
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            decoded: true,
            data: new NonEmptyIdle({ userId: "user-1" })
          },
          states: {
            NonEmptyIdle: {
              on: {
                NonEmptySubmit: {
                  target: targets22.root.NonEmptyIdle,
                  decoded: true,
                  data: () => (unsafeTagged({ _tag: "NonEmptyIdle", userId: "" }))
                }
              }
            }
          }
        })
        const actor = yield* Machine.start(machine)
        const snapshot = yield* sendAndWaitForSnapshot(actor, new NonEmptySubmit({ value: "request-1" }), (snapshot) =>
          snapshot.status === "error")
        const error = yield* Effect.flip(actor.join)
        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyIdle" })
        assert.strictEqual(snapshot.status, "error")
      }))
    it.effect("decodes final state output before caching it", () =>
      Effect.gen(function*() {
        const states = Machine.state({
          states: {
            NonEmptyIdle,
            done: {
              schema: NonEmptyDone,
              type: "final",
              output: Schema.NonEmptyString
            }
          }
        })
        const targets23 = Machine.targets(states)
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(NonEmptySubmit)
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            decoded: true,
            data: new NonEmptyIdle({ userId: "user-1" })
          },
          states: {
            NonEmptyIdle: {
              on: {
                NonEmptySubmit: {
                  target: targets23.root.done,
                  decoded: true,
                  data: ({ event }) => (new NonEmptyDone({ requestId: event.value }))
                }
              }
            },
            done: {
              output: () => "" as any
            }
          }
        })
        const error = yield* Effect.flip(Machine.plan(machine, {
          path: "" as const,
          value: undefined,
          state: { path: "NonEmptyIdle" as const, value: new NonEmptyIdle({ userId: "user-1" }) }
        }, new NonEmptySubmit({ value: "request-1" })))
        assertMachineSchemaDecodeError(error, "output", { state: "done" })
      }))
    it.effect("decodes parallel state output before caching it", () =>
      Effect.gen(function*() {
        const states = Machine.state({
          states: {
            all: {
              schema: ParallelRoot,
              type: "parallel",
              output: Schema.Struct({ summary: Schema.NonEmptyString }),
              states: {
                left: {
                  schema: ParallelLeftDone,
                  type: "final"
                },
                right: {
                  schema: ParallelRightDone,
                  type: "final"
                }
              }
            }
          }
        })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.all,
            decoded: true,
            data: new ParallelRoot({ id: "all" })
          },
          states: {
            all: {
              initial: {
                left: { decoded: true, data: new ParallelLeftDone({ id: "left" }) },
                right: { decoded: true, data: new ParallelRightDone({ id: "right" }) }
              },
              output: () => ({ summary: "" as any }),
              states: {
                left: {},
                right: {}
              }
            }
          }
        })
        const error = yield* Effect.flip(Machine.planInitial(machine))
        assertMachineSchemaDecodeError(error, "output", { state: "all" })
      }))
    it.effect("reports malformed snapshots as configuration boundary errors", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { NonEmptyIdle } })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(NonEmptySubmit)
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            decoded: true,
            data: new NonEmptyIdle({ userId: "user-1" })
          },
          states: {
            NonEmptyIdle: {}
          }
        })
        const error = yield* Effect.flip(
          Machine.plan(
            machine,
            { path: "missing" as const, value: new NonEmptyIdle({ userId: "user-1" }) } as any,
            new NonEmptySubmit({ value: "request-1" })
          )
        )
        assert.instanceOf(error, Machine.MachineSchemaDecodeError)
        assert.strictEqual(error.boundary, "configuration")
      }))
  })
  describe("snapshot encoding", () => {
    it.effect("round-trips schema encoded state values", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { count: EncodedCount } })
        const machine = Machine.make({
          id: "Counter",
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.count,
            decoded: true,
            data: new EncodedCount({ count: 1 })
          },
          states: {
            count: {}
          }
        })
        const planned = yield* Machine.planInitial(machine)
        const encoded = yield* Machine.encodeSnapshot(machine, planned.state)
        const decoded = yield* Machine.decodeSnapshot(machine, JSON.parse(JSON.stringify(encoded)))
        assert.deepStrictEqual(encoded, {
          version: 2,
          _tag: "MachineSnapshot",
          active: [{ path: "" }, {
            path: "count" as const,
            value: { _tag: "EncodedCount", count: "1" }
          }]
        })
        assert.deepStrictEqual(decoded, planned.state)
        assert.instanceOf(decoded.state.value, EncodedCount)
      }))
    it.effect("round-trips compound and parallel configurations", () =>
      Effect.gen(function*() {
        const states = Machine.state({
          states: {
            fulfillment: {
              schema: Fulfillment,
              type: "parallel",
              states: {
                inventory: {
                  schema: Inventory,
                  states: {
                    checking: CheckingInventory,
                    reserved: InventoryReserved
                  }
                },
                shipping: {
                  schema: Shipping,
                  states: {
                    quoting: QuotingShipping,
                    quoted: ShippingQuoted
                  }
                }
              }
            }
          }
        })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.fulfillment,
            decoded: true,
            data: new Fulfillment({ id: "fulfillment-1" })
          },
          states: {
            fulfillment: {
              initial: {
                inventory: { decoded: true, data: new Inventory({ warehouse: "warehouse-1" }) },
                shipping: { decoded: true, data: new Shipping({ address: "Main Street" }) }
              },
              states: {
                inventory: {
                  initial: {
                    target: Machine.targets(states).root.fulfillment.inventory.checking,
                    decoded: true,
                    data: new CheckingInventory({ sku: "sku-1" })
                  },
                  states: {
                    checking: {},
                    reserved: {}
                  }
                },
                shipping: {
                  initial: {
                    target: Machine.targets(states).root.fulfillment.shipping.quoting,
                    decoded: true,
                    data: new QuotingShipping({ postalCode: "12345" })
                  },
                  states: {
                    quoting: {},
                    quoted: {}
                  }
                }
              }
            }
          }
        })
        const planned = yield* Machine.planInitial(machine)
        const encoded = yield* Machine.encodeSnapshot(machine, planned.state)
        const decoded = yield* Machine.decodeSnapshot(machine, encoded)
        assert.deepStrictEqual(encoded.active.map(({ path }) => path), [
          "",
          "fulfillment",
          "fulfillment.inventory",
          "fulfillment.inventory.checking",
          "fulfillment.shipping",
          "fulfillment.shipping.quoting"
        ])
        assert.deepStrictEqual(decoded, planned.state)
      }))
    it.effect("encodes and decodes partial completion outputs", () =>
      Effect.gen(function*() {
        const states = Machine.state({
          states: {
            all: {
              schema: ParallelRoot,
              type: "parallel",
              states: {
                left: {
                  schema: ParallelLeftDone,
                  type: "final",
                  output: Schema.NumberFromString
                },
                right: ParallelRightDone
              }
            }
          }
        })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.all,
            decoded: true,
            data: new ParallelRoot({ id: "all" })
          },
          states: {
            all: {
              initial: {
                left: { decoded: true, data: new ParallelLeftDone({ id: "left" }) },
                right: { decoded: true, data: new ParallelRightDone({ id: "right" }) }
              },
              states: {
                left: {
                  output: () => 1
                },
                right: {}
              }
            }
          }
        })
        const planned = yield* Machine.planInitial(machine)
        const encoded = yield* Machine.encodeSnapshot(machine, planned.state)
        const decoded = yield* Machine.decodeSnapshot(machine, encoded)
        assert.deepStrictEqual(encoded.completed, [{ path: "all.left" as const, output: "1" }])
        assert.deepStrictEqual(decoded.completed, [{ path: "all.left" as const, output: 1 }])
      }))
    it.effect("round-trips void completion outputs through JSON", () =>
      Effect.gen(function*() {
        const states = Machine.state({
          states: {
            all: {
              schema: ParallelRoot,
              type: "parallel",
              states: {
                left: {
                  schema: ParallelLeftDone,
                  type: "final"
                },
                right: ParallelRightDone
              }
            }
          }
        })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.all,
            decoded: true,
            data: new ParallelRoot({ id: "all" })
          },
          states: {
            all: {
              initial: {
                left: { decoded: true, data: new ParallelLeftDone({ id: "left" }) },
                right: { decoded: true, data: new ParallelRightDone({ id: "right" }) }
              },
              states: {
                left: {},
                right: {}
              }
            }
          }
        })
        const planned = yield* Machine.planInitial(machine)
        const encoded = yield* Machine.encodeSnapshot(machine, planned.state)
        const decoded = yield* Machine.decodeSnapshot(machine, JSON.parse(JSON.stringify(encoded)))
        assert.deepStrictEqual(encoded.completed, [{ path: "all.left" as const }])
        assert.deepStrictEqual(decoded.completed, [{ path: "all.left" as const, output: undefined }])
      }))
    it.effect("distinguishes an omitted output schema from an explicit void codec", () =>
      Effect.gen(function*() {
        const states = Machine.state({
          states: {
            done: {
              schema: ParallelLeftDone,
              type: "final",
              output: Schema.Void
            }
          }
        })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.done,
            decoded: true,
            data: new ParallelLeftDone({ id: "done" })
          },
          states: {
            done: { output: () => undefined }
          }
        })
        const planned = yield* Machine.planInitial(machine)
        const encoded = yield* Machine.encodeSnapshot(machine, planned.state)
        const decoded = yield* Machine.decodeSnapshot(machine, JSON.parse(JSON.stringify(encoded)))
        assert.deepStrictEqual(encoded.completed, [{ path: "" as const, output: null }, {
          path: "done" as const,
          output: null
        }])
        assert.deepStrictEqual(decoded.completed, [{ path: "" as const, output: undefined }, {
          path: "done" as const,
          output: undefined
        }])
      }))
    it.effect("rejects state values that cannot be encoded", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { NonEmptyIdle } })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            decoded: true,
            data: new NonEmptyIdle({ userId: "user-1" })
          },
          states: {
            NonEmptyIdle: {}
          }
        })
        const error = yield* Machine.encodeSnapshot(machine, {
          path: "" as const,
          value: undefined,
          state: {
            path: "NonEmptyIdle" as const,
            value: unsafeTagged({ _tag: "NonEmptyIdle", userId: "" })
          }
        }).pipe(Effect.flip)
        assertMachineSchemaEncodeError(error, "state", { state: "NonEmptyIdle" })
      }))
    it.effect("rejects invalid completion metadata during encoding", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { NonEmptyIdle } })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            decoded: true,
            data: new NonEmptyIdle({ userId: "user-1" })
          },
          states: {
            NonEmptyIdle: {}
          }
        })
        const error = yield* Machine.encodeSnapshot(machine, {
          ...{
            path: "" as const,
            value: undefined,
            state: { path: "NonEmptyIdle" as const, value: new NonEmptyIdle({ userId: "user-1" }) }
          },
          completed: [{ path: "missing" as const, output: undefined }]
        }).pipe(Effect.flip)
        assert.instanceOf(error, Machine.MachineSchemaEncodeError)
        assert.strictEqual(error.boundary, "configuration")
      }))
    it.effect("rejects encoded values that do not match their state schema", () =>
      Effect.gen(function*() {
        const states = Machine.state({ states: { NonEmptyIdle } })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.NonEmptyIdle,
            decoded: true,
            data: new NonEmptyIdle({ userId: "user-1" })
          },
          states: {
            NonEmptyIdle: {}
          }
        })
        const error = yield* Machine.decodeSnapshot(machine, {
          version: 2,
          _tag: "MachineSnapshot",
          active: [{ path: "" }, {
            path: "NonEmptyIdle" as const,
            value: { _tag: "NonEmptyIdle", userId: "" }
          }]
        }).pipe(Effect.flip)
        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyIdle" })
      }))
    it.effect("rejects encoded configurations with invalid state relationships", () =>
      Effect.gen(function*() {
        const states = Machine.state({
          states: {
            payment: {
              schema: Payment,
              states: {
                entering: EnteringPayment,
                authorized: AuthorizedPayment
              }
            }
          }
        })
        const machine = Machine.make({
          root: states,
          events: Machine.eventsFromSchemas()
        }).handle({
          initial: {
            target: Machine.targets(states).root.payment,
            decoded: true,
            data: new Payment({ id: "payment-1" })
          },
          states: {
            payment: {
              initial: {
                target: Machine.targets(states).root.payment.entering,
                decoded: true,
                data: new EnteringPayment({ amount: 1 })
              },
              states: {
                entering: {},
                authorized: {}
              }
            }
          }
        })
        const error = yield* Machine.decodeSnapshot(machine, {
          version: 2,
          _tag: "MachineSnapshot",
          active: [{ path: "" }, {
            path: "payment.entering" as const,
            value: { _tag: "EnteringPayment", amount: 1 }
          }]
        }).pipe(Effect.flip)
        assert.instanceOf(error, Machine.MachineSchemaDecodeError)
        assert.strictEqual(error.boundary, "configuration")
      }))
  })
  it.effect("supports flat object states with path-aware handlers", () =>
    Effect.gen(function*() {
      const root24 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: {
          idle: Idle,
          loading: Loading
        }
      })
      const targets24 = Machine.targets(root24)
      const machine = Machine.make({
        root: root24,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root24).root.idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          idle: {
            on: {
              Submit: {
                target: targets24.root.loading,
                decoded: true,
                data: ({ event, state }) => (new Loading({ requestId: `${state.userId}:${event.value}` }))
              }
            }
          },
          loading: {}
        }
      })
      const planned = yield* Machine.plan(machine, {
        path: "" as const,
        value: { _tag: "", input: { userId: "user-1" } },
        state: LowercaseInitial.idle(new Idle({ userId: "user-1" }))
      }, new Submit({ value: "request-1" }))
      assert.deepStrictEqual(planned.next.state.value, new Loading({ requestId: "user-1:request-1" }))
      assert.strictEqual(planned.next.state.path, "loading")
      assert.deepStrictEqual(
        Machine.enabled(machine, {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: LowercaseInitial.idle(new Idle({ userId: "user-1" }))
        }),
        [
          "Submit"
        ]
      )
    }))
  it.effect("uses path identity for duplicate decoded state tags", () =>
    Effect.gen(function*() {
      const root25 = Machine.state({
        states: {
          a: Duplicate,
          b: Duplicate
        }
      })
      const targets25 = Machine.targets(root25)
      const machine = Machine.make({
        root: root25,
        events: Machine.eventsFromSchemas(Submit, Reset)
      }).handle({
        initial: {
          target: Machine.targets(root25).root.a,
          decoded: true,
          data: new Duplicate({ value: "a" })
        },
        states: {
          a: {
            on: {
              Submit: {
                target: targets25.root.b,
                decoded: true,
                data: ({ event }) => (new Duplicate({ value: event.value }))
              }
            }
          },
          b: {
            on: {
              Reset: { target: targets25.root.a, decoded: true, data: () => (new Duplicate({ value: "reset" })) }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      assertStateSnapshot(initial.state.state, "a", new Duplicate({ value: "a" }))
      assert.deepStrictEqual(Machine.enabled(machine, initial.state), ["Submit"])
      assert.deepStrictEqual(
        Machine.enabled(machine, {
          path: "" as const,
          value: undefined,
          state: {
            path: "b" as const,
            value: new Duplicate({ value: "b" })
          }
        }),
        ["Reset"]
      )
      const submitted = yield* Machine.plan(machine, initial.state, new Submit({ value: "b" }))
      assertStateSnapshot(submitted.next.state, "b", new Duplicate({ value: "b" }))
      const reset = yield* Machine.plan(machine, submitted.next, new Reset({}))
      assertStateSnapshot(reset.next.state, "a", new Duplicate({ value: "reset" }))
    }))
  it.effect("exposes path identity through machine snapshots", () =>
    Effect.gen(function*() {
      const root26 = Machine.state({
        states: {
          a: Duplicate,
          b: Duplicate
        }
      })
      const targets26 = Machine.targets(root26)
      const machine = Machine.make({
        root: root26,
        events: Machine.eventsFromSchemas(Submit)
      }).handle({
        initial: {
          target: Machine.targets(root26).root.a,
          decoded: true,
          data: new Duplicate({ value: "a" })
        },
        states: {
          a: {
            on: {
              Submit: {
                target: targets26.root.b,
                decoded: true,
                data: ({ event }) => (new Duplicate({ value: event.value }))
              }
            }
          },
          b: {}
        }
      })
      const actor = yield* Machine.start(machine)
      assertStateSnapshot((yield* actor.state).state, "a", new Duplicate({ value: "a" }))
      const snapshot = yield* sendAndWaitForSnapshot(actor, new Submit({ value: "b" }), (snapshot) =>
        snapshot.status === "active" && snapshot.state.state.path === "b")
      assert.strictEqual(snapshot.status, "active")
      assertStateSnapshot(snapshot.state.state, "b", new Duplicate({ value: "b" }))
    }))
  it.effect("honors final flat object state node configs", () =>
    Effect.gen(function*() {
      const root27 = Machine.state({
        states: {
          idle: Idle,
          success: {
            schema: Success,
            type: "final"
          }
        }
      })
      const targets27 = Machine.targets(root27)
      const machine = Machine.make({
        root: root27,
        events: Machine.eventsFromSchemas(Submit)
      }).handle({
        initial: {
          target: Machine.targets(root27).root.idle,
          decoded: true,
          data: new Idle({ userId: "user-1" })
        },
        states: {
          idle: {
            on: {
              Submit: {
                target: targets27.root.success,
                decoded: true,
                data: ({ event }) => (new Success({ requestId: event.value }))
              }
            }
          },
          success: {}
        }
      })
      const planned = yield* Machine.plan(machine, {
        path: "" as const,
        value: undefined,
        state: LowercaseInitial.idle(new Idle({ userId: "user-1" }))
      }, new Submit({ value: "request-1" }))
      assert.deepStrictEqual(planned.next.state.value, new Success({ requestId: "request-1" }))
      assert.strictEqual(planned.next.state.path, "success")
      assert.strictEqual(Machine.isFinal(machine, planned.next), true)
      assert.deepStrictEqual(Machine.enabled(machine, planned.next), [])
    }))
  it.effect("selects child handlers before ancestor handlers", () =>
    Effect.gen(function*() {
      const payment = new Payment({ id: "payment-1" })
      const entering = new EnteringPayment({ amount: 100 })
      const root28 = Machine.state({
        states: {
          payment: {
            schema: Payment,
            states: {
              entering: EnteringPayment,
              authorized: AuthorizedPayment
            }
          },
          failed: Failed
        }
      })
      const targets28 = Machine.targets(root28)
      const machine = Machine.make({
        branches: { transition2: { destination: { target: targets28.root.payment.authorized } } },
        root: root28,
        events: Machine.eventsFromSchemas(Authorize)
      }).handle({
        initial: {
          target: Machine.targets(root28).root.payment,
          decoded: true,
          data: payment
        },
        states: {
          payment: {
            initial: {
              target: Machine.targets(root28).root.payment.entering,
              decoded: true,
              data: entering
            },
            on: {
              Authorize: {
                target: targets28.root.failed,
                decoded: true,
                data: () => (new Failed({ message: "parent" }))
              }
            },
            states: {
              entering: {
                on: {
                  Authorize: {
                    branches: "transition2",
                    resolve: ({ event, containingState, ancestors, select: { destination: target } }) => {
                      assert.deepStrictEqual(containingState, payment)
                      assert.deepStrictEqual(ancestors, { payment })
                      return target.decoded(new AuthorizedPayment({ code: event.code }))
                    }
                  }
                }
              },
              authorized: {}
            }
          },
          failed: {}
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Authorize({ code: "auth-1" }))
      assertCompoundStateSnapshot(planned.next as any, "payment", payment, {
        path: "payment.authorized" as const,
        value: new AuthorizedPayment({ code: "auth-1" })
      })
    }))
  it.effect("queries concrete event acceptance without executing required transitions", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("CanIdle")("Idle", {}) {
      }
      class Done extends Schema.TaggedClass<Done>("CanDone")("Done", {}) {
      }
      class Check extends Schema.TaggedClass<Check>("CanCheck")("Check", {
        accept: Schema.Boolean
      }) {
      }
      class Consume extends Schema.TaggedClass<Consume>("CanConsume")("Consume", {}) {
      }
      class Finish extends Schema.TaggedClass<Finish>("CanFinish")("Finish", {}) {
      }
      class Ignore extends Schema.TaggedClass<Ignore>("CanIgnore")("Ignore", {}) {
      }
      class Raised extends Schema.TaggedClass<Raised>("CanRaised")("Raised", {}) {
      }
      const states = Machine.state({
        states: {
          Idle,
          Done: { schema: Done, type: "final" }
        }
      })
      let requiredResolverCalls = 0
      let declinableResolverCalls = 0
      let raisedResolverCalls = 0
      let lifecycleCalls = 0
      const targets29 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets29.root.Done } } },
        root: states,
        events: Machine.eventsFromSchemas(Check, Consume, Finish, Ignore),
        internalEvents: Machine.internalEventsFromSchemas(Raised)
      }).handle({
        initial: {
          target: Machine.targets(states).root.Idle,
          decoded: true,
          data: new Idle({})
        },
        states: {
          Idle: {
            exit: () => {
              lifecycleCalls++
            },
            on: {
              Check: {
                none: true,
                resolve: ({ event, decline }, enqueue) => {
                  declinableResolverCalls++
                  if (!event.accept) {
                    return decline()
                  }
                  enqueue.raise(new Raised({}))
                  return undefined
                },
                declinable: true
              },
              Consume: {
                none: true,
                resolve: () => {
                  requiredResolverCalls++
                  return undefined
                }
              },
              Finish: {
                branches: "transition1",
                resolve: ({ select: { destination: target } }) => {
                  requiredResolverCalls++
                  return target.decoded(new Done({}))
                }
              },
              Raised: {
                none: true,
                resolve: () => {
                  raisedResolverCalls++
                  return undefined
                }
              }
            }
          },
          Done: {
            entry: () => {
              lifecycleCalls++
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const canMachine = Machine.can(machine)
      assert.isTrue(yield* Machine.can(machine, initial.state, new Check({ accept: true })))
      assert.isFalse(yield* canMachine(initial.state, new Check({ accept: false })))
      assert.strictEqual(declinableResolverCalls, 2)
      assert.strictEqual(raisedResolverCalls, 0)
      assert.isTrue(yield* canMachine(initial.state, new Consume({})))
      assert.isTrue(yield* canMachine(initial.state, new Finish({})))
      assert.strictEqual(requiredResolverCalls, 0)
      assert.strictEqual(lifecycleCalls, 0)
      assert.isFalse(yield* canMachine(initial.state, new Ignore({})))
      yield* Machine.plan(machine, initial.state, new Check({ accept: true }))
      assert.strictEqual(raisedResolverCalls, 1)
      const finished = yield* Machine.plan(machine, initial.state, new Finish({}))
      assert.isTrue(finished.done)
      assert.strictEqual(requiredResolverCalls, 1)
      assert.strictEqual(lifecycleCalls, 2)
      assert.isFalse(yield* canMachine(finished.next, new Finish({})))
    }))
  it.effect("lets declinable child handlers yield to ancestors without retaining queued work", () =>
    Effect.gen(function*() {
      class Notice extends Schema.TaggedClass<Notice>("DeclineNotice")("Notice", {}) {
      }
      const payment = new Payment({ id: "payment-1" })
      const entering = new EnteringPayment({ amount: 100 })
      const root30 = Machine.state({
        states: {
          payment: {
            schema: Payment,
            states: {
              entering: EnteringPayment,
              authorized: AuthorizedPayment
            }
          },
          failed: Failed
        }
      })
      const targets30 = Machine.targets(root30)
      const machine = Machine.make({
        branches: {
          transition2: { authorize: { target: targets30.root.payment.authorized }, consume: { none: true } }
        },
        root: root30,
        events: Machine.eventsFromSchemas(Authorize),
        emittedEvents: Machine.emittedEventsFromSchemas(Notice)
      }).handle({
        initial: {
          target: Machine.targets(root30).root.payment,
          decoded: true,
          data: payment
        },
        states: {
          payment: {
            initial: {
              target: Machine.targets(root30).root.payment.entering,
              decoded: true,
              data: entering
            },
            on: {
              Authorize: {
                target: targets30.root.failed,
                decoded: true,
                data: () => (new Failed({ message: "parent" }))
              }
            },
            states: {
              entering: {
                on: {
                  Authorize: {
                    branches: "transition2",
                    resolve: ({ event, select, decline }, enqueue) => {
                      if (event.code === "child") {
                        return select.authorize.decoded(new AuthorizedPayment({ code: event.code }))
                      }
                      if (event.code === "consume") {
                        return select.consume()
                      }
                      enqueue.emit(new Notice({}))
                      return decline()
                    },
                    declinable: true
                  }
                }
              },
              authorized: {}
            }
          },
          failed: {}
        }
      })
      assert.strictEqual(
        Machine.transitionDefinitions(machine).find(({ source }) => source === "payment.entering")?.acceptance,
        "declinable"
      )
      const initial = yield* Machine.planInitial(machine)
      assert.isTrue(yield* Machine.can(machine, initial.state, new Authorize({ code: "child" })))
      assert.isTrue(yield* Machine.can(machine)(initial.state, new Authorize({ code: "consume" })))
      assert.isTrue(yield* Machine.can(machine, initial.state, new Authorize({ code: "parent" })))
      const child = yield* Machine.plan(machine, initial.state, new Authorize({ code: "child" }))
      assert.strictEqual(child.next.state.path, "payment")
      if (child.next.state.path === "payment") {
        assert.strictEqual(child.next.state.state.path, "payment.authorized")
      }
      assert.strictEqual(child.microsteps[0]?.transitions[0]?.source, "payment.entering")
      assert.strictEqual(child.microsteps[0]?.transitions[0]?.branchKey, "authorize")
      const consumed = yield* Machine.plan(machine, initial.state, new Authorize({ code: "consume" }))
      assert.deepStrictEqual(consumed.next, initial.state)
      assert.strictEqual(consumed.microsteps[0]?.transitions[0]?.source, "payment.entering")
      assert.strictEqual(consumed.microsteps[0]?.transitions[0]?.branchKey, "consume")
      assert.strictEqual(consumed.microsteps[0]?.transitions[0]?.target, undefined)
      const declined = yield* Machine.plan(machine, initial.state, new Authorize({ code: "parent" }))
      assert.strictEqual(declined.next.state.path, "failed")
      assert.strictEqual(declined.microsteps[0]?.transitions[0]?.source, "payment")
      assert.deepStrictEqual(declined.emittedEvents, [])
    }))
  it.effect("continues eventless selection at an ancestor when a child declines", () =>
    Effect.gen(function*() {
      class Workflow extends Schema.TaggedClass<Workflow>("DeclineWorkflow")("Workflow", {}) {
      }
      class Waiting extends Schema.TaggedClass<Waiting>("DeclineWaiting")("Waiting", { ready: Schema.Boolean }) {
      }
      class Finished extends Schema.TaggedClass<Finished>("DeclineFinished")("Finished", {}) {
      }
      const states = Machine.state({
        states: {
          workflow: {
            schema: Workflow,
            states: { waiting: Waiting }
          },
          finished: Finished
        }
      })
      const targets31 = Machine.targets(states)
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(states).root.workflow,
          decoded: true,
          data: new Workflow({})
        },
        states: {
          workflow: {
            initial: {
              target: Machine.targets(states).root.workflow.waiting,
              decoded: true,
              data: new Waiting({ ready: false })
            },
            always: { target: targets31.root.finished, decoded: true, data: () => (new Finished({})) },
            states: {
              waiting: {
                always: {
                  none: true,
                  resolve: ({ state, decline }) => state.ready ? undefined : decline(),
                  declinable: true
                }
              }
            }
          },
          finished: {}
        }
      })
      const planned = yield* Machine.planInitial(machine)
      assert.strictEqual(planned.state.state.path, "finished")
      assert.strictEqual(planned.microsteps[0]?.transitions[0]?.source, "workflow")
    }))
  it.effect("treats an event as unhandled when every candidate declines", () =>
    Effect.gen(function*() {
      class Stable extends Schema.TaggedClass<Stable>("DeclineStable")("Stable", {}) {
      }
      class Ping extends Schema.TaggedClass<Ping>("DeclinePing")("Ping", {}) {
      }
      const states = Machine.state({ states: { Stable } })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Ping)
      }).handle({
        initial: {
          target: Machine.targets(states).root.Stable,
          decoded: true,
          data: new Stable({})
        },
        states: {
          Stable: {
            on: {
              Ping: { none: true, resolve: ({ decline }) => decline(), declinable: true }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      assert.deepStrictEqual(Machine.enabled(machine, initial.state), ["Ping"])
      assert.isFalse(yield* Machine.can(machine, initial.state, new Ping({})))
      const planned = yield* Machine.plan(machine, initial.state, new Ping({}))
      assert.deepStrictEqual(planned.next, initial.state)
      assert.deepStrictEqual(planned.microsteps, [])
    }))
  it.effect("leaves a completed compound state active when onDone declines", () =>
    Effect.gen(function*() {
      class Workflow extends Schema.TaggedClass<Workflow>("DeclineDoneWorkflow")("Workflow", {}) {
      }
      class Complete extends Schema.TaggedClass<Complete>("DeclineDoneComplete")("Complete", {}) {
      }
      class Finished extends Schema.TaggedClass<Finished>("DeclineDoneFinished")("Finished", {}) {
      }
      const states = Machine.state({
        states: {
          workflow: {
            schema: Workflow,
            states: {
              complete: { schema: Complete, type: "final", output: Schema.String }
            }
          },
          finished: Finished
        }
      })
      const targets33 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets33.root.finished } } },
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(states).root.workflow,
          decoded: true,
          data: new Workflow({})
        },
        states: {
          workflow: {
            initial: {
              target: Machine.targets(states).root.workflow.complete,
              decoded: true,
              data: new Complete({})
            },
            onDone: { branches: "transition1", resolve: ({ decline }) => decline(), declinable: true },
            states: {
              complete: { output: () => "complete" }
            }
          },
          finished: {}
        }
      })
      const planned = yield* Machine.planInitial(machine)
      assert.isFalse(planned.done)
      assert.strictEqual(planned.state.state.path, "workflow")
      if (planned.state.state.path === "workflow") {
        assert.strictEqual(planned.state.state.state.path, "workflow.complete")
      }
    }))
  it.effect("preserves descendant preemption when parallel candidates decline", () =>
    Effect.gen(function*() {
      class Root extends Schema.TaggedClass<Root>("DeclineParallelRoot")("Root", {}) {
      }
      class Left extends Schema.TaggedClass<Left>("DeclineParallelLeft")("Left", {}) {
      }
      class Right extends Schema.TaggedClass<Right>("DeclineParallelRight")("Right", {}) {
      }
      class Finished extends Schema.TaggedClass<Finished>("DeclineParallelFinished")("Finished", {}) {
      }
      class Ping extends Schema.TaggedClass<Ping>("DeclineParallelPing")("Ping", {
        handleRight: Schema.Boolean
      }) {
      }
      const states = Machine.state({
        states: {
          root: {
            schema: Root,
            type: "parallel",
            states: { left: Left, right: Right }
          },
          finished: Finished
        }
      })
      let parentCalls = 0
      const targets34 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets34.root.finished } } },
        root: states,
        events: Machine.eventsFromSchemas(Ping)
      }).handle({
        initial: {
          target: Machine.targets(states).root.root,
          decoded: true,
          data: new Root({})
        },
        states: {
          root: {
            initial: { left: { decoded: true, data: new Left({}) }, right: { decoded: true, data: new Right({}) } },
            on: {
              Ping: {
                branches: "transition1",
                resolve: ({ select: { destination: target } }) => {
                  parentCalls++
                  return target.decoded(new Finished({}))
                }
              }
            },
            states: {
              left: {
                on: {
                  Ping: { none: true, resolve: ({ decline }) => decline(), declinable: true }
                }
              },
              right: {
                on: {
                  Ping: {
                    none: true,
                    resolve: ({ event, decline }) => event.handleRight ? undefined : decline(),
                    declinable: true
                  }
                }
              }
            }
          },
          finished: {}
        }
      })
      const initial = yield* Machine.planInitial(machine)
      assert.isTrue(yield* Machine.can(machine, initial.state, new Ping({ handleRight: true })))
      assert.strictEqual(parentCalls, 0)
      assert.isTrue(yield* Machine.can(machine, initial.state, new Ping({ handleRight: false })))
      assert.strictEqual(parentCalls, 0)
      const descendant = yield* Machine.plan(machine, initial.state, new Ping({ handleRight: true }))
      assert.strictEqual(descendant.next.state.path, "root")
      assert.deepStrictEqual(descendant.microsteps[0]?.transitions.map(({ source }) => source), ["root.right"])
      assert.strictEqual(parentCalls, 0)
      const ancestor = yield* Machine.plan(machine, initial.state, new Ping({ handleRight: false }))
      assert.strictEqual(ancestor.next.state.path, "finished")
      assert.deepStrictEqual(ancestor.microsteps[0]?.transitions.map(({ source }) => source), ["root"])
      assert.strictEqual(parentCalls, 1)
    }))
  it.effect("handles parent config and nested states in the same object", () =>
    Effect.gen(function*() {
      const payment = new Payment({ id: "payment-1" })
      const entering = new EnteringPayment({ amount: 100 })
      const root35 = Machine.state({
        states: {
          payment: {
            schema: Payment,
            states: {
              entering: EnteringPayment,
              authorized: {
                schema: AuthorizedPayment,
                type: "final",
                output: Schema.String
              }
            }
          },
          failed: Failed
        }
      })
      const targets35 = Machine.targets(root35)
      const machine = Machine.make({
        root: root35,
        events: Machine.eventsFromSchemas(Authorize, Reset)
      }).handle({
        initial: {
          target: Machine.targets(root35).root.payment,
          decoded: true,
          data: payment
        },
        states: {
          payment: {
            initial: {
              target: Machine.targets(root35).root.payment.entering,
              decoded: true,
              data: entering
            },
            on: {
              Reset: { target: targets35.root.failed, decoded: true, data: () => (new Failed({ message: "reset" })) }
            },
            states: {
              entering: {
                on: {
                  Authorize: {
                    target: targets35.root.payment.authorized,
                    decoded: true,
                    data: ({ event }) => (new AuthorizedPayment({ code: event.code }))
                  }
                }
              },
              authorized: {
                output: ({ ancestors, state }) => {
                  assert.deepStrictEqual(ancestors, { payment })
                  return state.code
                }
              }
            }
          },
          failed: {}
        }
      })
      assert.strictEqual("payment" in machine.handlers, true)
      assert.strictEqual("payment.entering" in machine.handlers, true)
      assert.strictEqual("payment.authorized" in machine.handlers, true)
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Authorize({ code: "auth-1" }))
      assertCompoundStateSnapshot(planned.next as any, "payment", payment, {
        path: "payment.authorized" as const,
        value: new AuthorizedPayment({ code: "auth-1" })
      })
      assert.strictEqual(Machine.isFinal(machine, planned.next), true)
      assert.strictEqual(planned.output, "auth-1")
    }))
  it.effect("lets ancestor handlers catch events from active descendants", () =>
    Effect.gen(function*() {
      const payment = new Payment({ id: "payment-1" })
      const entering = new EnteringPayment({ amount: 100 })
      const root36 = Machine.state({
        states: {
          idle: Idle,
          payment: {
            schema: Payment,
            states: {
              entering: EnteringPayment,
              authorized: AuthorizedPayment
            }
          }
        }
      })
      const targets36 = Machine.targets(root36)
      const machine = Machine.make({
        root: root36,
        events: Machine.eventsFromSchemas(Reset)
      }).handle({
        initial: {
          target: Machine.targets(root36).root.payment,
          decoded: true,
          data: payment
        },
        states: {
          idle: {},
          payment: {
            initial: {
              target: Machine.targets(root36).root.payment.entering,
              decoded: true,
              data: entering
            },
            on: {
              Reset: { target: targets36.root.idle, decoded: true, data: () => (new Idle({ userId: "user-1" })) }
            },
            states: {
              entering: {},
              authorized: {}
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      assert.deepStrictEqual(Machine.enabled(machine, initial.state), ["Reset"])
      const planned = yield* Machine.plan(machine, initial.state, new Reset({}))
      assertStateSnapshot(planned.next as any, "idle", new Idle({ userId: "user-1" }))
    }))
  it.effect("uses target.full to enter an inactive parallel root", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        states: {
          idle: Idle,
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: {
                    schema: InventoryReserved,
                    type: "final"
                  }
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: {
                    schema: ShippingQuoted,
                    type: "final"
                  }
                }
              }
            }
          }
        }
      })
      const targets37 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets37.root.fulfillment } } },
        root: states,
        events: Machine.eventsFromSchemas(Submit)
      }).handle({
        initial: {
          target: Machine.targets(states).root.idle,
          decoded: true,
          data: new Idle({ userId: "user-1" })
        },
        states: {
          idle: {
            on: {
              Submit: {
                branches: "transition1",
                resolve: ({ event, select: { destination: target } }) =>
                  target.decoded(new Fulfillment({ id: event.value }), (fulfillment) =>
                    fulfillment
                      .inventory.decoded(
                        new Inventory({ warehouse: "warehouse-1" }),
                        (inventory) => inventory.reserved.decoded(new InventoryReserved({ reservationId: event.value }))
                      )
                      .shipping.decoded(
                        new Shipping({ address: "Main Street" }),
                        (shipping) => shipping.quoted.decoded(new ShippingQuoted({ quoteId: event.value }))
                      ))
              }
            }
          },
          fulfillment: {
            initial: { inventory: { warehouse: "warehouse-1" }, shipping: { address: "Main Street" } },
            states: {
              inventory: {
                initial: {
                  target: Machine.targets(states).root.fulfillment.inventory.checking,
                  data: { sku: "sku-1" }
                },
                states: {
                  checking: {},
                  reserved: {}
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(states).root.fulfillment.shipping.quoting,
                  data: { postalCode: "12345" }
                },
                states: {
                  quoting: {},
                  quoted: {}
                }
              }
            }
          }
        }
      })
      const planned = yield* Machine.plan(machine, {
        path: "" as const,
        value: undefined,
        state: { path: "idle" as const, value: new Idle({ userId: "user-1" }) }
      }, new Submit({ value: "order-1" }))
      assertParallelStateSnapshot(planned.next as any, "fulfillment", new Fulfillment({ id: "order-1" }), {
        inventory: {
          path: "fulfillment.inventory" as const,
          value: new Inventory({ warehouse: "warehouse-1" }),
          state: {
            path: "fulfillment.inventory.reserved" as const,
            value: new InventoryReserved({ reservationId: "order-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping" as const,
          value: new Shipping({ address: "Main Street" }),
          state: {
            path: "fulfillment.shipping.quoted" as const,
            value: new ShippingQuoted({ quoteId: "order-1" })
          }
        }
      })
      assert.deepStrictEqual(planned.microsteps[0]?.entryPaths, [
        "fulfillment",
        "fulfillment.inventory",
        "fulfillment.shipping",
        "fulfillment.inventory.reserved",
        "fulfillment.shipping.quoted"
      ])
    }))
  it.effect("uses target.local to enter an inactive nested parallel state", () =>
    Effect.gen(function*() {
      const workflow = new Payment({ id: "workflow-1" })
      const states = Machine.state({
        states: {
          workflow: {
            schema: Payment,
            states: {
              idle: Idle,
              fulfillment: {
                schema: Fulfillment,
                type: "parallel",
                states: {
                  inventory: {
                    schema: Inventory,
                    states: {
                      checking: CheckingInventory,
                      reserved: InventoryReserved
                    }
                  },
                  shipping: {
                    schema: Shipping,
                    states: {
                      quoting: QuotingShipping,
                      quoted: ShippingQuoted
                    }
                  }
                }
              }
            }
          }
        }
      })
      const targets38 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets38.root.workflow.fulfillment } } },
        root: states,
        events: Machine.eventsFromSchemas(Submit)
      }).handle({
        initial: {
          target: Machine.targets(states).root.workflow,
          decoded: true,
          data: workflow
        },
        states: {
          workflow: {
            initial: {
              target: Machine.targets(states).root.workflow.idle,
              decoded: true,
              data: new Idle({ userId: "user-1" })
            },
            states: {
              idle: {
                on: {
                  Submit: {
                    branches: "transition1",
                    resolve: ({ event, select: { destination: target } }) =>
                      target.decoded(new Fulfillment({ id: event.value }), (fulfillment) =>
                        fulfillment
                          .inventory.decoded(
                            new Inventory({ warehouse: "warehouse-1" }),
                            (inventory) =>
                              inventory.reserved.decoded(new InventoryReserved({ reservationId: event.value }))
                          )
                          .shipping.decoded(
                            new Shipping({ address: "Main Street" }),
                            (shipping) => shipping.quoted.decoded(new ShippingQuoted({ quoteId: event.value }))
                          ))
                  }
                }
              },
              fulfillment: {
                initial: { inventory: { warehouse: "warehouse-1" }, shipping: { address: "Main Street" } },
                states: {
                  inventory: {
                    initial: {
                      target: Machine.targets(states).root.workflow.fulfillment.inventory.checking,
                      data: { sku: "sku-1" }
                    },
                    states: {
                      checking: {},
                      reserved: {}
                    }
                  },
                  shipping: {
                    initial: {
                      target: Machine.targets(states).root.workflow.fulfillment.shipping.quoting,
                      data: { postalCode: "12345" }
                    },
                    states: {
                      quoting: {},
                      quoted: {}
                    }
                  }
                }
              }
            }
          }
        }
      })
      const planned = yield* Machine.plan(machine, {
        path: "" as const,
        value: undefined,
        state: {
          path: "workflow" as const,
          value: workflow,
          state: { path: "workflow.idle" as const, value: new Idle({ userId: "user-1" }) }
        }
      }, new Submit({ value: "order-1" }))
      assertCompoundStateSnapshot(planned.next as any, "workflow", workflow, {
        path: "workflow.fulfillment" as const,
        value: new Fulfillment({ id: "order-1" }),
        states: {
          inventory: {
            path: "workflow.fulfillment.inventory" as const,
            value: new Inventory({ warehouse: "warehouse-1" }),
            state: {
              path: "workflow.fulfillment.inventory.reserved" as const,
              value: new InventoryReserved({ reservationId: "order-1" })
            }
          },
          shipping: {
            path: "workflow.fulfillment.shipping" as const,
            value: new Shipping({ address: "Main Street" }),
            state: {
              path: "workflow.fulfillment.shipping.quoted" as const,
              value: new ShippingQuoted({ quoteId: "order-1" })
            }
          }
        }
      } as any)
      assert.deepStrictEqual(planned.microsteps[0]?.entryPaths, [
        "workflow.fulfillment",
        "workflow.fulfillment.inventory",
        "workflow.fulfillment.shipping",
        "workflow.fulfillment.inventory.reserved",
        "workflow.fulfillment.shipping.quoted"
      ])
    }))
  it.effect("uses target.branch to enter a nested parallel state and preserve outer regions", () =>
    Effect.gen(function*() {
      const app = new Fulfillment({ id: "app-1" })
      const flow = new Payment({ id: "flow-1" })
      const monitor = new QuotingShipping({ postalCode: "12345" })
      const states = Machine.state({
        states: {
          app: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              flow: {
                schema: Payment,
                states: {
                  idle: Idle,
                  fulfillment: {
                    schema: Fulfillment,
                    type: "parallel",
                    states: {
                      inventory: Inventory,
                      shipping: Shipping
                    }
                  }
                }
              },
              monitor: QuotingShipping
            }
          }
        }
      })
      const initial = {
        path: "" as const,
        value: undefined,
        state: {
          path: "app" as const,
          value: app,
          states: {
            flow: {
              path: "app.flow" as const,
              value: flow,
              state: { path: "app.flow.idle" as const, value: new Idle({ userId: "user-1" }) }
            },
            monitor: { path: "app.monitor" as const, value: monitor }
          }
        }
      }
      const targets39 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets39.root.app.flow.fulfillment } } },
        root: states,
        events: Machine.eventsFromSchemas(Submit)
      }).handle({
        initial: {
          target: Machine.targets(states).root.app,
          decoded: true,
          data: app
        },
        states: {
          app: {
            initial: { flow: { decoded: true, data: flow }, monitor: { decoded: true, data: monitor } },
            states: {
              flow: {
                initial: {
                  target: Machine.targets(states).root.app.flow.idle,
                  decoded: true,
                  data: new Idle({ userId: "user-1" })
                },
                states: {
                  idle: {
                    on: {
                      Submit: {
                        branches: "transition1",
                        resolve: ({ event, select: { destination: target } }) =>
                          target.decoded(new Fulfillment({ id: event.value }), (fulfillment) =>
                            fulfillment
                              .inventory.decoded(new Inventory({ warehouse: "warehouse-1" }))
                              .shipping.decoded(new Shipping({ address: "Main Street" })))
                      }
                    }
                  },
                  fulfillment: {
                    initial: { inventory: { warehouse: "warehouse-1" }, shipping: { address: "Main Street" } },
                    states: {
                      inventory: {},
                      shipping: {}
                    }
                  }
                }
              },
              monitor: {}
            }
          }
        }
      })
      const planned = yield* Machine.plan(machine, initial, new Submit({ value: "order-1" }))
      assertParallelStateSnapshot(planned.next as any, "app", app, {
        flow: {
          path: "app.flow" as const,
          value: flow,
          state: {
            path: "app.flow.fulfillment" as const,
            value: new Fulfillment({ id: "order-1" }),
            states: {
              inventory: {
                path: "app.flow.fulfillment.inventory" as const,
                value: new Inventory({ warehouse: "warehouse-1" })
              },
              shipping: {
                path: "app.flow.fulfillment.shipping" as const,
                value: new Shipping({ address: "Main Street" })
              }
            }
          }
        },
        monitor: {
          path: "app.monitor" as const,
          value: monitor
        }
      })
    }))
  it.effect("uses target.local to preserve parent and sibling parallel region values", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        }
      })
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const targets40 = Machine.targets(states)
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(ReserveInventory)
      }).handle({
        initial: {
          target: Machine.targets(states).root.fulfillment,
          decoded: true,
          data: fulfillment
        },
        states: {
          fulfillment: {
            initial: { inventory: { decoded: true, data: inventory }, shipping: { decoded: true, data: shipping } },
            states: {
              inventory: {
                initial: {
                  decoded: true,
                  data: new CheckingInventory({ sku: "sku-1" }),
                  target: Machine.targets(states).root.fulfillment.inventory.checking
                },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        target: targets40.root.fulfillment.inventory.reserved,
                        decoded: true,
                        data: ({ event }) => (new InventoryReserved({ reservationId: event.reservationId }))
                      }
                    }
                  },
                  reserved: {}
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(states).root.fulfillment.shipping.quoting,
                  decoded: true,
                  data: quoting
                },
                states: {
                  quoting: {},
                  quoted: {}
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new ReserveInventory({ reservationId: "res-1" }))
      assertParallelStateSnapshot(planned.next as any, "fulfillment", fulfillment, {
        inventory: {
          path: "fulfillment.inventory" as const,
          value: inventory,
          state: {
            path: "fulfillment.inventory.reserved" as const,
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping" as const,
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting" as const,
            value: quoting
          }
        }
      })
    }))
  it.effect("uses target.local.with to replace the local compound value", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        }
      })
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const nextInventory = new Inventory({ warehouse: "warehouse-2" })
      const targets41 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets41.root.fulfillment.inventory } } },
        root: states,
        events: Machine.eventsFromSchemas(ReserveInventory)
      }).handle({
        initial: {
          target: Machine.targets(states).root.fulfillment,
          decoded: true,
          data: fulfillment
        },
        states: {
          fulfillment: {
            initial: {
              inventory: { decoded: true, data: new Inventory({ warehouse: "warehouse-1" }) },
              shipping: { decoded: true, data: shipping }
            },
            states: {
              inventory: {
                initial: {
                  decoded: true,
                  data: new CheckingInventory({ sku: "sku-1" }),
                  target: Machine.targets(states).root.fulfillment.inventory.checking
                },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        branches: "transition1",
                        resolve: ({ event, select: { destination: target } }) =>
                          target.decoded(
                            nextInventory,
                            (inventory) =>
                              inventory.reserved.decoded(new InventoryReserved({ reservationId: event.reservationId }))
                          )
                      }
                    }
                  },
                  reserved: {}
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(states).root.fulfillment.shipping.quoting,
                  decoded: true,
                  data: quoting
                },
                states: {
                  quoting: {},
                  quoted: {}
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new ReserveInventory({ reservationId: "res-1" }))
      assertParallelStateSnapshot(planned.next as any, "fulfillment", fulfillment, {
        inventory: {
          path: "fulfillment.inventory" as const,
          value: nextInventory,
          state: {
            path: "fulfillment.inventory.reserved" as const,
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping" as const,
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting" as const,
            value: quoting
          }
        }
      })
    }))
  it.effect("uses target.branch to replace one parallel region while preserving siblings", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        }
      })
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const nextInventory = new Inventory({ warehouse: "warehouse-2" })
      const targets42 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets42.root.fulfillment.inventory } } },
        root: states,
        events: Machine.eventsFromSchemas(ReserveInventory)
      }).handle({
        initial: {
          target: Machine.targets(states).root.fulfillment,
          decoded: true,
          data: fulfillment
        },
        states: {
          fulfillment: {
            initial: { inventory: { decoded: true, data: inventory }, shipping: { decoded: true, data: shipping } },
            states: {
              inventory: {
                initial: {
                  decoded: true,
                  data: new CheckingInventory({ sku: "sku-1" }),
                  target: Machine.targets(states).root.fulfillment.inventory.checking
                },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        branches: "transition1",
                        resolve: ({ event, select: { destination: target } }) =>
                          target.decoded(
                            nextInventory,
                            (inventory) =>
                              inventory.reserved.decoded(new InventoryReserved({ reservationId: event.reservationId }))
                          )
                      }
                    }
                  },
                  reserved: {}
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(states).root.fulfillment.shipping.quoting,
                  decoded: true,
                  data: quoting
                },
                states: {
                  quoting: {},
                  quoted: {}
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new ReserveInventory({ reservationId: "res-1" }))
      assertParallelStateSnapshot(planned.next as any, "fulfillment", fulfillment, {
        inventory: {
          path: "fulfillment.inventory" as const,
          value: nextInventory,
          state: {
            path: "fulfillment.inventory.reserved" as const,
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping" as const,
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting" as const,
            value: quoting
          }
        }
      })
    }))
  it.effect("uses target.branch to replace root and nested region values", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        }
      })
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const nextFulfillment = new Fulfillment({ id: "fulfillment-2" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const nextInventory = new Inventory({ warehouse: "warehouse-2" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const targets43 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets43.root.fulfillment } } },
        root: states,
        events: Machine.eventsFromSchemas(ReserveInventory)
      }).handle({
        initial: {
          target: Machine.targets(states).root.fulfillment,
          decoded: true,
          data: fulfillment
        },
        states: {
          fulfillment: {
            initial: { inventory: { decoded: true, data: inventory }, shipping: { decoded: true, data: shipping } },
            states: {
              inventory: {
                initial: {
                  decoded: true,
                  data: new CheckingInventory({ sku: "sku-1" }),
                  target: Machine.targets(states).root.fulfillment.inventory.checking
                },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        branches: "transition1",
                        resolve: ({ event, select: { destination: target } }) =>
                          target.decoded(nextFulfillment, (fulfillment) =>
                            fulfillment.inventory.decoded(nextInventory, (inventory) =>
                              inventory.reserved.decoded(
                                new InventoryReserved({ reservationId: event.reservationId })
                              )))
                      }
                    }
                  },
                  reserved: {}
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(states).root.fulfillment.shipping.quoting,
                  decoded: true,
                  data: quoting
                },
                states: {
                  quoting: {},
                  quoted: {}
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new ReserveInventory({ reservationId: "res-1" }))
      assertParallelStateSnapshot(planned.next as any, "fulfillment", nextFulfillment, {
        inventory: {
          path: "fulfillment.inventory" as const,
          value: nextInventory,
          state: {
            path: "fulfillment.inventory.reserved" as const,
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping" as const,
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting" as const,
            value: quoting
          }
        }
      })
    }))
  it.effect("uses target.branch from a compound descendant to a sibling descendant", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        states: {
          payment: {
            schema: Payment,
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        }
      })
      const payment = new Payment({ id: "payment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const targets44 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets44.root.payment.shipping } } },
        root: states,
        events: Machine.eventsFromSchemas(ReserveInventory)
      }).handle({
        initial: {
          target: Machine.targets(states).root.payment,
          decoded: true,
          data: payment
        },
        states: {
          payment: {
            initial: {
              target: Machine.targets(states).root.payment.inventory,
              decoded: true,
              data: inventory
            },
            states: {
              inventory: {
                initial: {
                  target: Machine.targets(states).root.payment.inventory.checking,
                  decoded: true,
                  data: new CheckingInventory({ sku: "sku-1" })
                },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        branches: "transition1",
                        resolve: ({ event, select: { destination: target } }) =>
                          target.decoded(shipping, (shipping) =>
                            shipping.quoted.decoded(new ShippingQuoted({ quoteId: event.reservationId })))
                      }
                    }
                  },
                  reserved: {}
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(states).root.payment.shipping.quoting,
                  data: { postalCode: "12345" }
                },
                states: {
                  quoting: {},
                  quoted: {}
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new ReserveInventory({ reservationId: "quote-1" }))
      assertCompoundStateSnapshot(planned.next as any, "payment", payment, {
        path: "payment.shipping" as const,
        value: shipping,
        state: {
          path: "payment.shipping.quoted" as const,
          value: new ShippingQuoted({ quoteId: "quote-1" })
        }
      })
    }))
  it.effect("treats compound states as final when their active child is final", () =>
    Effect.gen(function*() {
      const payment = new Payment({ id: "payment-1" })
      const root45 = Machine.state({
        states: {
          payment: {
            schema: Payment,
            states: {
              entering: EnteringPayment,
              authorized: {
                schema: AuthorizedPayment,
                type: "final",
                output: Schema.String
              }
            }
          }
        }
      })
      const targets45 = Machine.targets(root45)
      const machine = Machine.make({
        root: root45,
        events: Machine.eventsFromSchemas(Authorize, Reset)
      }).handle({
        initial: {
          target: Machine.targets(root45).root.payment,
          decoded: true,
          data: payment
        },
        states: {
          payment: {
            initial: {
              target: Machine.targets(root45).root.payment.entering,
              decoded: true,
              data: new EnteringPayment({ amount: 100 })
            },
            on: {
              Reset: {
                target: targets45.root.payment.entering,
                decoded: true,
                data: () => (new EnteringPayment({ amount: 0 }))
              }
            },
            states: {
              entering: {
                on: {
                  Authorize: {
                    target: targets45.root.payment.authorized,
                    decoded: true,
                    data: ({ event }) => (new AuthorizedPayment({ code: event.code }))
                  }
                }
              },
              authorized: {
                output: ({ state }) => state.code
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Authorize({ code: "auth-1" }))
      assertCompoundStateSnapshot(planned.next as any, "payment", payment, {
        path: "payment.authorized" as const,
        value: new AuthorizedPayment({ code: "auth-1" })
      })
      assert.strictEqual(Machine.isFinal(machine, planned.next), true)
      assert.deepStrictEqual(Machine.enabled(machine, planned.next), [])
      assert.strictEqual(planned.output, "auth-1")
    }))
  it.effect("produces output from an initially active nested final state", () =>
    Effect.gen(function*() {
      const payment = new Payment({ id: "payment-1" })
      const authorized = new AuthorizedPayment({ code: "auth-1" })
      const InitialRoot1 = Machine.state({
        states: {
          payment: {
            schema: Payment,
            states: {
              authorized: {
                schema: AuthorizedPayment,
                type: "final",
                output: Schema.String
              }
            }
          }
        }
      })
      const machine = Machine.make({
        root: InitialRoot1,
        events: Machine.eventsFromSchemas(Reset)
      }).handle({
        initial: {
          target: Machine.targets(InitialRoot1).root.payment,
          decoded: true,
          data: payment
        },
        states: {
          payment: {
            initial: {
              target: Machine.targets(InitialRoot1).root.payment.authorized,
              decoded: true,
              data: authorized
            },
            states: {
              authorized: {
                output: ({ state }) => state.code
              }
            }
          }
        }
      })
      const planned = yield* Machine.planInitial(machine)
      assertCompoundStateSnapshot(planned.state as any, "payment", payment, {
        path: "payment.authorized" as const,
        value: authorized
      })
      assert.strictEqual(Machine.isFinal(machine, planned.state), true)
      assert.deepStrictEqual(Machine.enabled(machine, planned.state), [])
      assert.strictEqual(planned.output, "auth-1")
    }))
  it.effect("joins with output from nested final completion and rejects later events", () =>
    Effect.gen(function*() {
      const payment = new Payment({ id: "payment-1" })
      const root46 = Machine.state({
        states: {
          idle: Idle,
          payment: {
            schema: Payment,
            states: {
              entering: EnteringPayment,
              authorized: {
                schema: AuthorizedPayment,
                type: "final",
                output: Schema.String
              }
            }
          }
        }
      })
      const targets46 = Machine.targets(root46)
      const machine = Machine.make({
        root: root46,
        events: Machine.eventsFromSchemas(Authorize, Reset)
      }).handle({
        initial: {
          target: Machine.targets(root46).root.payment,
          decoded: true,
          data: payment
        },
        states: {
          idle: {},
          payment: {
            initial: {
              target: Machine.targets(root46).root.payment.entering,
              decoded: true,
              data: new EnteringPayment({ amount: 100 })
            },
            on: {
              Reset: { target: targets46.root.idle, decoded: true, data: () => (new Idle({ userId: "user-1" })) }
            },
            states: {
              entering: {
                on: {
                  Authorize: {
                    target: targets46.root.payment.authorized,
                    decoded: true,
                    data: ({ event }) => (new AuthorizedPayment({ code: event.code }))
                  }
                }
              },
              authorized: {
                output: ({ state }) => state.code
              }
            }
          }
        }
      })
      const actor = yield* Machine.start(machine)
      yield* actor.send(new Authorize({ code: "auth-1" }))
      assert.strictEqual(yield* actor.join, "auth-1")
      assert.instanceOf(yield* Effect.flip(actor.send(new Reset({}))), Machine.StoppedError)
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: undefined,
          state: {
            path: "payment" as const,
            value: payment,
            state: {
              path: "payment.authorized" as const,
              value: new AuthorizedPayment({ code: "auth-1" })
            }
          },
          completed: [
            { path: "payment.authorized" as const, output: "auth-1" },
            { path: "payment" as const, output: "auth-1" },
            { path: "" as const, output: "auth-1" }
          ]
        },
        output: "auth-1"
      })
    }))
  it.effect("runs onDone for nested compound completion without completing the root state", () =>
    Effect.gen(function*() {
      const checkout = new Fulfillment({ id: "checkout-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const root47 = Machine.state({
        states: {
          checkout: {
            schema: Fulfillment,
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: {
                    schema: InventoryReserved,
                    type: "final",
                    output: Schema.String
                  }
                }
              },
              shipped: ShippingQuoted
            }
          },
          failed: Failed
        }
      })
      const targets47 = Machine.targets(root47)
      const machine = Machine.make({
        root: root47,
        events: Machine.eventsFromSchemas(ReserveInventory, Reset)
      }).handle({
        initial: {
          target: Machine.targets(root47).root.checkout,
          decoded: true,
          data: checkout
        },
        states: {
          checkout: {
            initial: {
              target: Machine.targets(root47).root.checkout.inventory,
              decoded: true,
              data: inventory
            },
            on: {
              Reset: { target: targets47.root.failed, decoded: true, data: () => (new Failed({ message: "reset" })) }
            },
            states: {
              inventory: {
                initial: {
                  target: Machine.targets(root47).root.checkout.inventory.checking,
                  decoded: true,
                  data: new CheckingInventory({ sku: "sku-1" })
                },
                onDone: {
                  target: targets47.root.checkout.shipped,
                  decoded: true,
                  data: ({ output }) => (new ShippingQuoted({ quoteId: String(output) }))
                },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        target: targets47.root.checkout.inventory.reserved,
                        decoded: true,
                        data: ({ event }) => (new InventoryReserved({ reservationId: event.reservationId }))
                      }
                    }
                  },
                  reserved: {
                    output: ({ state }) => state.reservationId
                  }
                }
              },
              shipped: {}
            }
          },
          failed: {}
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new ReserveInventory({ reservationId: "res-1" }))
      assertCompoundStateSnapshot(planned.next as any, "checkout", checkout, {
        path: "checkout.shipped" as const,
        value: new ShippingQuoted({ quoteId: "res-1" })
      })
      assert.strictEqual(Machine.isFinal(machine, planned.next), false)
      assert.deepStrictEqual(Machine.enabled(machine, planned.next), ["Reset"])
      assert.strictEqual(planned.output, undefined)
    }))
  it.effect("updates one parallel region while preserving sibling regions and parent value", () =>
    Effect.gen(function*() {
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const root48 = Machine.state({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: {
                    schema: InventoryReserved,
                    type: "final"
                  }
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: {
                    schema: ShippingQuoted,
                    type: "final",
                    output: Schema.String
                  }
                }
              }
            }
          }
        }
      })
      const targets48 = Machine.targets(root48)
      const machine = Machine.make({
        root: root48,
        events: Machine.eventsFromSchemas(ReserveInventory)
      }).handle({
        initial: {
          target: Machine.targets(root48).root.fulfillment,
          decoded: true,
          data: fulfillment
        },
        states: {
          fulfillment: {
            initial: { inventory: { decoded: true, data: inventory }, shipping: { decoded: true, data: shipping } },
            states: {
              inventory: {
                initial: {
                  target: Machine.targets(root48).root.fulfillment.inventory.checking,
                  decoded: true,
                  data: new CheckingInventory({ sku: "sku-1" })
                },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        target: targets48.root.fulfillment.inventory.reserved,
                        decoded: true,
                        data: ({ event }) => (new InventoryReserved({ reservationId: event.reservationId }))
                      }
                    }
                  },
                  reserved: {}
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(root48).root.fulfillment.shipping.quoting,
                  decoded: true,
                  data: quoting
                },
                states: {
                  quoting: {},
                  quoted: {
                    output: ({ state }) => state.quoteId
                  }
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new ReserveInventory({ reservationId: "res-1" }))
      assertParallelStateSnapshot(planned.next as any, "fulfillment", fulfillment, {
        inventory: {
          path: "fulfillment.inventory" as const,
          value: inventory,
          state: {
            path: "fulfillment.inventory.reserved" as const,
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping" as const,
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting" as const,
            value: quoting
          }
        }
      })
      assert.strictEqual(Machine.isFinal(machine, planned.next), false)
    }))
  it.effect("completes a parallel parent when every region is final and aggregates region outputs", () =>
    Effect.gen(function*() {
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const checking = new CheckingInventory({ sku: "sku-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const root49 = Machine.state({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            output: Schema.Struct({
              inventory: Schema.String,
              shipping: Schema.String
            }),
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: {
                    schema: InventoryReserved,
                    type: "final",
                    output: Schema.String
                  }
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: {
                    schema: ShippingQuoted,
                    type: "final",
                    output: Schema.String
                  }
                }
              }
            }
          }
        }
      })
      const targets49 = Machine.targets(root49)
      const machine = Machine.make({
        root: root49,
        events: Machine.eventsFromSchemas(ReserveInventory)
      }).handle({
        initial: {
          target: Machine.targets(root49).root.fulfillment,
          decoded: true,
          data: fulfillment
        },
        states: {
          fulfillment: {
            initial: { inventory: { decoded: true, data: inventory }, shipping: { decoded: true, data: shipping } },
            output: ({ outputs }) => ({
              inventory: outputs.inventory,
              shipping: outputs.shipping
            }),
            states: {
              inventory: {
                initial: {
                  target: Machine.targets(root49).root.fulfillment.inventory.checking,
                  decoded: true,
                  data: checking
                },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        target: targets49.root.fulfillment.inventory.reserved,
                        decoded: true,
                        data: ({ event }) => (new InventoryReserved({ reservationId: event.reservationId }))
                      }
                    }
                  },
                  reserved: {
                    output: ({ state }) => state.reservationId
                  }
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(root49).root.fulfillment.shipping.quoting,
                  decoded: true,
                  data: quoting
                },
                states: {
                  quoting: {
                    on: {
                      ReserveInventory: {
                        target: targets49.root.fulfillment.shipping.quoted,
                        decoded: true,
                        data: ({ event }) => (new ShippingQuoted({ quoteId: event.reservationId }))
                      }
                    }
                  },
                  quoted: {
                    output: ({ state }) => state.quoteId
                  }
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new ReserveInventory({ reservationId: "res-1" }))
      assertParallelStateSnapshot(planned.next as any, "fulfillment", fulfillment, {
        inventory: {
          path: "fulfillment.inventory" as const,
          value: inventory,
          state: {
            path: "fulfillment.inventory.reserved" as const,
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping" as const,
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoted" as const,
            value: new ShippingQuoted({ quoteId: "res-1" })
          }
        }
      })
      assert.strictEqual(Machine.isFinal(machine, planned.next), true)
      assert.deepStrictEqual(Machine.enabled(machine, planned.next), [])
      assert.deepStrictEqual(planned.output, {
        inventory: "res-1",
        shipping: "res-1"
      })
      const actor = yield* Machine.start(machine)
      yield* actor.send(new ReserveInventory({ reservationId: "res-2" }))
      assert.deepStrictEqual(yield* actor.join, {
        inventory: "res-2",
        shipping: "res-2"
      })
    }))
  it.effect("preserves completed parallel region outputs across separate events", () =>
    Effect.gen(function*() {
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const root50 = Machine.state({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            output: Schema.Struct({
              inventory: Schema.String,
              shipping: Schema.String
            }),
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: {
                    schema: InventoryReserved,
                    type: "final",
                    output: Schema.String
                  }
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: {
                    schema: ShippingQuoted,
                    type: "final",
                    output: Schema.String
                  }
                }
              }
            }
          }
        }
      })
      const targets50 = Machine.targets(root50)
      const machine = Machine.make({
        root: root50,
        events: Machine.eventsFromSchemas(ReserveInventory, Resolve)
      }).handle({
        initial: {
          target: Machine.targets(root50).root.fulfillment,
          decoded: true,
          data: fulfillment
        },
        states: {
          fulfillment: {
            initial: { inventory: { decoded: true, data: inventory }, shipping: { decoded: true, data: shipping } },
            output: ({ outputs }) => outputs,
            states: {
              inventory: {
                initial: {
                  target: Machine.targets(root50).root.fulfillment.inventory.checking,
                  decoded: true,
                  data: new CheckingInventory({ sku: "sku-1" })
                },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        target: targets50.root.fulfillment.inventory.reserved,
                        decoded: true,
                        data: ({ event }) => (new InventoryReserved({ reservationId: event.reservationId }))
                      }
                    }
                  },
                  reserved: {
                    output: ({ event, state }) => `${state.reservationId}:${String(event._tag)}`
                  }
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(root50).root.fulfillment.shipping.quoting,
                  decoded: true,
                  data: quoting
                },
                states: {
                  quoting: {
                    on: {
                      Resolve: {
                        target: targets50.root.fulfillment.shipping.quoted,
                        decoded: true,
                        data: () => (new ShippingQuoted({ quoteId: "quote-1" }))
                      }
                    }
                  },
                  quoted: {
                    output: ({ event, state }) => `${state.quoteId}:${String(event._tag)}`
                  }
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const reserved = yield* Machine.plan(machine, initial.state, new ReserveInventory({ reservationId: "res-1" }))
      const serialized = { ...reserved.next } as typeof reserved.next
      const quoted = yield* Machine.plan(machine, serialized, new Resolve({}))
      assert.strictEqual(Machine.isFinal(machine, reserved.next), false)
      assert.strictEqual(reserved.output, undefined)
      assert.ok(serialized.completed !== undefined)
      assert.strictEqual(Machine.isFinal(machine, quoted.next), true)
      assert.deepStrictEqual(quoted.output, {
        inventory: "res-1:ReserveInventory",
        shipping: "quote-1:Resolve"
      })
      const actor = yield* Machine.start(machine)
      yield* sendAndWaitForSnapshot(actor, new ReserveInventory({ reservationId: "res-2" }), (snapshot) =>
        snapshot.status === "active" &&
        snapshot.state.state.path === "fulfillment" &&
        snapshot.state.state.states.inventory.state.path === "fulfillment.inventory.reserved")
      yield* actor.send(new Resolve({}))
      assert.deepStrictEqual(yield* actor.join, {
        inventory: "res-2:ReserveInventory",
        shipping: "quote-1:Resolve"
      })
    }))
  it.effect("transitions all matching parallel regions for the same event", () =>
    Effect.gen(function*() {
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const checking = new CheckingInventory({ sku: "sku-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const root51 = Machine.state({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        }
      })
      const targets51 = Machine.targets(root51)
      const machine = Machine.make({
        root: root51,
        events: Machine.eventsFromSchemas(ReserveInventory)
      }).handle({
        initial: {
          target: Machine.targets(root51).root.fulfillment,
          decoded: true,
          data: fulfillment
        },
        states: {
          fulfillment: {
            initial: { inventory: { decoded: true, data: inventory }, shipping: { decoded: true, data: shipping } },
            states: {
              inventory: {
                initial: {
                  target: Machine.targets(root51).root.fulfillment.inventory.checking,
                  decoded: true,
                  data: checking
                },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        target: targets51.root.fulfillment.inventory.reserved,
                        decoded: true,
                        data: ({ event }) => (new InventoryReserved({ reservationId: event.reservationId }))
                      }
                    }
                  },
                  reserved: {}
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(root51).root.fulfillment.shipping.quoting,
                  decoded: true,
                  data: quoting
                },
                states: {
                  quoting: {
                    on: {
                      ReserveInventory: {
                        target: targets51.root.fulfillment.shipping.quoted,
                        decoded: true,
                        data: ({ event }) => (new ShippingQuoted({ quoteId: event.reservationId }))
                      }
                    }
                  },
                  quoted: {}
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new ReserveInventory({ reservationId: "res-1" }))
      assertParallelStateSnapshot(planned.next as any, "fulfillment", fulfillment, {
        inventory: {
          path: "fulfillment.inventory" as const,
          value: inventory,
          state: {
            path: "fulfillment.inventory.reserved" as const,
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping" as const,
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoted" as const,
            value: new ShippingQuoted({ quoteId: "res-1" })
          }
        }
      })
    }))
  it.effect("processes raised events from one parallel region after the current microstep", () =>
    Effect.gen(function*() {
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const checking = new CheckingInventory({ sku: "sku-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const root52 = Machine.state({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        }
      })
      const targets52 = Machine.targets(root52)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets52.root.fulfillment.inventory.reserved } } },
        root: root52,
        events: Machine.eventsFromSchemas(ReserveInventory, Resolve)
      }).handle({
        initial: {
          target: Machine.targets(root52).root.fulfillment,
          decoded: true,
          data: fulfillment
        },
        states: {
          fulfillment: {
            initial: { inventory: { decoded: true, data: inventory }, shipping: { decoded: true, data: shipping } },
            states: {
              inventory: {
                initial: {
                  target: Machine.targets(root52).root.fulfillment.inventory.checking,
                  decoded: true,
                  data: checking
                },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        branches: "transition1",
                        resolve: ({ event, select: { destination: target } }, enqueue) => {
                          enqueue.raise(new Resolve({}))
                          return target.decoded(
                            new InventoryReserved({
                              reservationId: event.reservationId
                            })
                          )
                        }
                      }
                    }
                  },
                  reserved: {}
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(root52).root.fulfillment.shipping.quoting,
                  decoded: true,
                  data: quoting
                },
                states: {
                  quoting: {
                    on: {
                      Resolve: {
                        target: targets52.root.fulfillment.shipping.quoted,
                        decoded: true,
                        data: () => (new ShippingQuoted({ quoteId: "raised" }))
                      }
                    }
                  },
                  quoted: {}
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new ReserveInventory({ reservationId: "res-1" }))
      assertParallelStateSnapshot(planned.next as any, "fulfillment", fulfillment, {
        inventory: {
          path: "fulfillment.inventory" as const,
          value: inventory,
          state: {
            path: "fulfillment.inventory.reserved" as const,
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping" as const,
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoted" as const,
            value: new ShippingQuoted({ quoteId: "raised" })
          }
        }
      })
      assert.strictEqual(planned.microsteps.length, 2)
    }))
  it.effect("starts a machine without input", () =>
    Effect.gen(function*() {
      const InitialRoot2 = Machine.state({ states: { Idle } })
      const machine = Machine.make({
        root: InitialRoot2,
        events: Machine.eventsFromSchemas(Submit)
      }).handle({
        initial: {
          target: Machine.targets(InitialRoot2).root.Idle,
          decoded: true,
          data: new Idle({ userId: "user-1" })
        },
        states: {
          Idle: {}
        }
      })
      const actor = yield* Machine.start(machine)
      assert.deepStrictEqual((yield* actor.state).state.value, new Idle({ userId: "user-1" }))
    }))
  it.effect("handlers can return snapshots directly", () =>
    Effect.gen(function*() {
      const root53 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading }
      })
      const targets53 = Machine.targets(root53)
      const machine = Machine.make({
        root: root53,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root53).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets53.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {}
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      const snapshot = yield* sendAndWaitForSnapshot(actor, new Submit({ value: "hello" }), (snapshot) =>
        snapshot.state.state.value._tag === "Loading")
      assert.deepStrictEqual(snapshot, {
        status: "active",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
        }
      })
    }))
  it("enabled returns the event tags handled by the current state", () => {
    const root54 = Machine.state({
      fields: {
        input: Schema.toType(Input)
      },
      states: { Idle, Loading }
    })
    const targets54 = Machine.targets(root54)
    const machine = Machine.make({
      root: root54,
      events: Machine.eventsFromSchemas(Submit, Reset),
      input: Input
    }).handle({
      initial: {
        target: Machine.targets(root54).root.Idle,
        decoded: true,
        data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
      },
      root: ({ input }) => ({ input }),
      states: {
        Idle: {
          on: {
            Submit: {
              target: targets54.root.Loading,
              decoded: true,
              data: () => (new Loading({ requestId: "request-1" }))
            }
          }
        },
        Loading: {
          on: {
            Reset: { target: targets54.root.Idle, decoded: true, data: () => (new Idle({ userId: "user-1" })) }
          }
        }
      }
    })
    assert.deepStrictEqual(
      Machine.enabled(machine, {
        path: "" as const,
        value: { _tag: "", input: { userId: "user-1" } },
        state: FlatInitial.Idle(new Idle({ userId: "user-1" }))
      }),
      ["Submit"]
    )
    assert.deepStrictEqual(
      Machine.enabled(machine, {
        path: "" as const,
        value: { _tag: "", input: { userId: "user-1" } },
        state: FlatInitial.Loading(new Loading({ requestId: "request-1" }))
      }),
      ["Reset"]
    )
  })
  it("enabled returns no event tags for final states", () => {
    const root55 = Machine.state({
      fields: {
        input: Schema.toType(Input)
      },
      states: {
        Idle,
        Success: { schema: Success, type: "final" }
      }
    })
    const targets55 = Machine.targets(root55)
    const machine = Machine.make({
      root: root55,
      events: Machine.eventsFromSchemas(Submit),
      input: Input
    }).handle({
      initial: {
        target: Machine.targets(root55).root.Idle,
        decoded: true,
        data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
      },
      root: ({ input }) => ({ input }),
      states: {
        Idle: {
          on: {
            Submit: {
              target: targets55.root.Success,
              decoded: true,
              data: () => (new Success({ requestId: "request-1" }))
            }
          }
        },
        Success: {}
      }
    })
    assert.deepStrictEqual(
      Machine.enabled(machine, {
        path: "" as const,
        value: { _tag: "", input: { userId: "user-1" } },
        state: FlatInitial.Success(new Success({ requestId: "request-1" }))
      }),
      []
    )
  })
  it.effect("exposes final state output from a running machine", () =>
    Effect.gen(function*() {
      const root56 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Success: SuccessOutput }
      })
      const targets56 = Machine.targets(root56)
      const machine = Machine.make({
        root: root56,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root56).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets56.root.Success,
                decoded: true,
                data: () => (new Success({ requestId: "request-1" }))
              }
            }
          },
          Success: {
            output: ({ event, state }) => `${state.requestId}:${String(event._tag)}`
          }
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: { path: "Idle" as const, value: new Idle({ userId: "user-1" }) }
        }
      })
      yield* actor.send(new Submit({ value: "hello" }))
      assert.strictEqual(yield* actor.join, "request-1:Submit")
    }))
  it.effect("plans final state output without running deferred actions", () =>
    Effect.gen(function*() {
      const root57 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Success: SuccessOutput }
      })
      const targets57 = Machine.targets(root57)
      const machine = Machine.make({
        root: root57,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root57).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets57.root.Success,
                decoded: true,
                data: () => (new Success({ requestId: "request-1" }))
              }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const planned = yield* Machine.plan(machine, {
        path: "" as const,
        value: { _tag: "", input: { userId: "user-1" } },
        state: FlatInitial.Idle(new Idle({ userId: "user-1" }))
      }, new Submit({ value: "hello" }))
      assert.strictEqual(planned.output, "request-1")
    }))
  it.effect("exposes output when the initial state is final", () =>
    Effect.gen(function*() {
      let outputCalls = 0
      const InitialRoot3 = Machine.state({ states: { Success: SuccessOutput } })
      const machine = Machine.make({
        root: InitialRoot3,
        events: Machine.eventsFromSchemas(Submit)
      }).handle({
        initial: {
          target: Machine.targets(InitialRoot3).root.Success,
          decoded: true,
          data: new Success({ requestId: "request-1" })
        },
        states: {
          Success: {
            output: ({ state }) => {
              outputCalls += 1
              return state.requestId
            }
          }
        }
      })
      const planned = yield* Machine.planInitial(machine)
      const actor = yield* Machine.start(machine)
      assert.strictEqual(planned.done, true)
      assert.strictEqual(planned.output, "request-1")
      assert.strictEqual(yield* actor.join, "request-1")
      assert.strictEqual(outputCalls, 2)
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: undefined,
          state: {
            path: "Success" as const,
            value: new Success({ requestId: "request-1" })
          },
          completed: [{ path: "Success" as const, output: "request-1" }, { path: "" as const, output: "request-1" }]
        },
        output: "request-1"
      })
    }))
  it.effect("preserves completed output when a terminal snapshot is spread and planned again", () =>
    Effect.gen(function*() {
      let outputCalls = 0
      const InitialRoot4 = Machine.state({ states: { Success: SuccessOutput } })
      const machine = Machine.make({
        root: InitialRoot4,
        events: Machine.eventsFromSchemas(Submit)
      }).handle({
        initial: {
          target: Machine.targets(InitialRoot4).root.Success,
          decoded: true,
          data: new Success({ requestId: "request-1" })
        },
        states: {
          Success: {
            output: ({ state }) => {
              outputCalls += 1
              return state.requestId
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const cloned = { ...initial.state }
      const planned = yield* Machine.plan(machine, cloned, new Submit({ value: "ignored" }))
      assert.strictEqual(initial.done, true)
      assert.deepStrictEqual(cloned.completed, [{ path: "Success" as const, output: "request-1" }, {
        path: "" as const,
        output: "request-1"
      }])
      assert.strictEqual(planned.done, true)
      assert.strictEqual(planned.output, "request-1")
      assert.strictEqual(outputCalls, 1)
    }))
  it.effect("defaults final state output to undefined", () =>
    Effect.gen(function*() {
      const root58 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: {
          Idle,
          Success: { schema: Success, type: "final" }
        }
      })
      const targets58 = Machine.targets(root58)
      const machine = Machine.make({
        root: root58,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root58).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets58.root.Success,
                decoded: true,
                data: () => (new Success({ requestId: "request-1" }))
              }
            }
          },
          Success: {}
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))
      assert.strictEqual(yield* actor.join, undefined)
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: {
            path: "Success" as const,
            value: new Success({ requestId: "request-1" })
          },
          completed: [{ path: "Success" as const, output: undefined }, { path: "" as const, output: undefined }]
        },
        output: undefined
      })
    }))
  it.effect("rejects events after reaching a final state", () =>
    Effect.gen(function*() {
      const root59 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: {
          Idle,
          Success: { schema: Success, type: "final" }
        }
      })
      const targets59 = Machine.targets(root59)
      const machine = Machine.make({
        root: root59,
        events: Machine.eventsFromSchemas(Submit, Reset),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root59).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets59.root.Success,
                decoded: true,
                data: () => (new Success({ requestId: "request-1" }))
              },
              Reset: { target: targets59.root.Idle, decoded: true, data: () => (new Idle({ userId: "user-2" })) }
            }
          },
          Success: {}
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))
      yield* actor.join
      assert.instanceOf(yield* Effect.flip(actor.send(new Reset({}))), Machine.StoppedError)
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: {
            path: "Success" as const,
            value: new Success({ requestId: "request-1" })
          },
          completed: [{ path: "Success" as const, output: undefined }, { path: "" as const, output: undefined }]
        },
        output: undefined
      })
    }))
  it.effect("start keeps the machine alive after the starting fiber completes", () =>
    Effect.gen(function*() {
      const root60 = Machine.state({ states: { Idle, Loading } })
      const targets60 = Machine.targets(root60)
      const machine = Machine.make({
        root: root60,
        events: Machine.eventsFromSchemas(Submit)
      }).handle({
        initial: {
          target: Machine.targets(root60).root.Idle,
          decoded: true,
          data: new Idle({ userId: "user-1" })
        },
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets60.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {}
        }
      })
      const startingFiber = yield* Machine.start(machine).pipe(Effect.forkChild)
      const ref = yield* Fiber.join(startingFiber)
      const snapshot = yield* sendAndWaitForSnapshot(ref, new Submit({ value: "hello" }), (snapshot) =>
        snapshot.status === "active" && snapshot.state.state.path === "Loading")
      assert.strictEqual(snapshot.status, "active")
      assert.strictEqual(snapshot.state.state.path, "Loading")
      yield* ref.stop
    }))
  it.effect("start rejects events sent after stop", () =>
    Effect.gen(function*() {
      const root61 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading }
      })
      const targets61 = Machine.targets(root61)
      const machine = Machine.make({
        root: root61,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root61).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets61.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {}
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.stop
      assert.instanceOf(yield* Effect.flip(actor.send(new Submit({ value: "hello" }))), Machine.StoppedError)
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "stopped",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: { path: "Idle" as const, value: new Idle({ userId: "user-1" }) }
        }
      })
    }))
  it.effect("plans no-op transitions from final states", () =>
    Effect.gen(function*() {
      const InitialRoot5 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: {
          Idle,
          Success: { schema: Success, type: "final" }
        }
      })
      const machine = Machine.make({
        root: InitialRoot5,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(InitialRoot5).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {},
          Success: {}
        }
      })
      const state = FlatInitial.Success(new Success({ requestId: "request-1" }))
      const planned = yield* Machine.plan(machine, {
        path: "" as const,
        value: { _tag: "", input: { userId: "user-1" } },
        state: state
      }, new Submit({ value: "hello" }))
      assert.deepStrictEqual(planned.next.state.value, state.value)
      assert.deepStrictEqual(planned.commands, [])
      assert.deepStrictEqual(planned.microsteps, [])
    }))
  it.effect("handlers use target.none for explicit targetless transitions", () =>
    Effect.gen(function*() {
      const root62 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading }
      })
      const machine = Machine.make({
        root: root62,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root62).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: { none: true }
            }
          },
          Loading: {}
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))
      yield* Effect.yieldNow
      assert.deepStrictEqual((yield* actor.state).state.value, new Idle({ userId: "user-1" }))
    }))
  it.effect("start returns a machine runtime with lifecycle snapshots", () =>
    Effect.gen(function*() {
      const root63 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading }
      })
      const targets63 = Machine.targets(root63)
      const machine = Machine.make({
        root: root63,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root63).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets63.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {}
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      const observer = yield* actor.changes.pipe(
        Stream.filter((snapshot) => snapshot.state.state.value._tag === "Loading"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild
      )
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: { path: "Idle" as const, value: new Idle({ userId: "user-1" }) }
        }
      })
      yield* actor.send(new Submit({ value: "hello" }))
      const snapshots = Array.from(yield* Fiber.join(observer))
      assert.deepStrictEqual(snapshots, [{
        status: "active",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
        }
      }])
      assert.deepStrictEqual((yield* actor.state).state.value, new Loading({ requestId: "request-1" }))
      yield* actor.stop
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "stopped",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
        }
      })
    }))
  it.effect("start completes machine output from a final state", () =>
    Effect.gen(function*() {
      const root64 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Success: SuccessOutput }
      })
      const targets64 = Machine.targets(root64)
      const machine = Machine.make({
        root: root64,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root64).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets64.root.Success,
                decoded: true,
                data: () => (new Success({ requestId: "request-1" }))
              }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))
      assert.strictEqual(yield* actor.join, "request-1")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: {
            path: "Success" as const,
            value: new Success({ requestId: "request-1" })
          },
          completed: [{ path: "Success" as const, output: "request-1" }, { path: "" as const, output: "request-1" }]
        },
        output: "request-1"
      })
    }))
  it.effect("plan ignores events without an enabled transition", () =>
    Effect.gen(function*() {
      const root65 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading }
      })
      const targets65 = Machine.targets(root65)
      const machine = Machine.make({
        id: "UserMachine",
        root: root65,
        events: Machine.eventsFromSchemas(Submit, Reset),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root65).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets65.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {}
        }
      })
      const state = FlatInitial.Idle(new Idle({ userId: "user-1" }))
      const planned = yield* Machine.plan(machine, {
        path: "" as const,
        value: { _tag: "", input: { userId: "user-1" } },
        state: state
      }, new Reset({}))
      assert.deepStrictEqual(planned.next.state, state)
      assert.deepStrictEqual(planned.commands, [])
      assert.deepStrictEqual(planned.emittedEvents, [])
      assert.deepStrictEqual(planned.microsteps, [])
    }))
  it.effect("start runs invoke configs", () =>
    Effect.gen(function*() {
      const root66 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading, Success: SuccessOutput }
      })
      const targets66 = Machine.targets(root66)
      const definition = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.succeed("done:request-1")) },
        root: root66,
        events: Machine.eventsFromSchemas(Submit, RequestSucceeded),
        input: Input
      })
      const machine = definition.handle({
        initial: {
          target: Machine.targets(root66).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets66.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {
            invoke: {
              src: "source1",
              id: "request",
              onDone: {
                target: targets66.root.Success,
                decoded: true,
                data: ({ output }) => (new Success({ requestId: output }))
              }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))
      assert.strictEqual(yield* actor.join, "done:request-1")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: {
            path: "Success" as const,
            value: new Success({ requestId: "done:request-1" })
          },
          completed: [{ path: "Success" as const, output: "done:request-1" }, {
            path: "" as const,
            output: "done:request-1"
          }]
        },
        output: "done:request-1"
      })
    }))
  it.effect("start invokes a child process and handles its output event", () =>
    Effect.gen(function*() {
      const root67 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading, Success: SuccessOutput }
      })
      const targets67 = Machine.targets(root67)
      const definition = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.succeed("done:request-1")) },
        root: root67,
        events: Machine.eventsFromSchemas(Submit, RequestSucceeded),
        input: Input
      })
      const machine = definition.handle({
        initial: {
          target: Machine.targets(root67).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets67.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {
            invoke: {
              src: "source1",
              id: "request",
              onDone: {
                target: targets67.root.Success,
                decoded: true,
                data: ({ output }) => (new Success({ requestId: output }))
              }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))
      assert.strictEqual(yield* actor.join, "done:request-1")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: {
            path: "Success" as const,
            value: new Success({ requestId: "done:request-1" })
          },
          completed: [{ path: "Success" as const, output: "done:request-1" }, {
            path: "" as const,
            output: "done:request-1"
          }]
        },
        output: "done:request-1"
      })
    }))
  it.effect("isolates invoked children across concurrent zero-input starts", () =>
    Effect.gen(function*() {
      const childStates = Machine.state({ states: { Idle } })
      const childMachine = Machine.make({
        root: childStates,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(childStates).root.Idle,
          decoded: true,
          data: new Idle({ userId: "child" })
        },
        states: {
          Idle: {}
        }
      })
      const Child = Machine.child("shared-child", childMachine)
      const parentStates = Machine.state({ states: { Loading } })
      const parentMachine = Machine.make({
        children: { source1: Child },
        root: parentStates,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(parentStates).root.Loading,
          decoded: true,
          data: new Loading({ requestId: "parent" })
        },
        states: {
          Loading: {
            invoke: { src: "source1" }
          }
        }
      })
      const [first, second] = yield* Effect.all([Machine.start(parentMachine), Machine.start(parentMachine)], {
        concurrency: "unbounded"
      })
      const firstChild = yield* first.childChanges(Child).pipe(
        Stream.filter(Option.isSome),
        Stream.runHead,
        Effect.map(Option.flatten)
      )
      const secondChild = yield* second.childChanges(Child).pipe(
        Stream.filter(Option.isSome),
        Stream.runHead,
        Effect.map(Option.flatten)
      )
      assert(Option.isSome(firstChild))
      assert(Option.isSome(secondChild))
      assert.notStrictEqual(firstChild.value, secondChild.value)
      yield* first.stop
      assert.deepStrictEqual(yield* second.snapshot, {
        status: "active",
        state: {
          path: "" as const,
          value: undefined,
          state: { path: "Loading" as const, value: new Loading({ requestId: "parent" }) }
        }
      })
      assert.deepStrictEqual(yield* secondChild.value.snapshot, {
        status: "active",
        state: {
          path: "" as const,
          value: undefined,
          state: { path: "Idle" as const, value: new Idle({ userId: "child" }) }
        }
      })
      yield* second.stop
    }))
  it.effect("stops an idle compiled invoked child with its parent", () =>
    Effect.gen(function*() {
      const childStates = Machine.state({ states: { Idle } })
      const childMachine = Machine.make({
        root: childStates,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(childStates).root.Idle,
          decoded: true,
          data: new Idle({ userId: "child" })
        },
        states: {
          Idle: {}
        }
      })
      const Child = Machine.child("owned-child", childMachine)
      const parentStates = Machine.state({ states: { Loading } })
      const parentMachine = Machine.make({
        children: { source1: Child },
        root: parentStates,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(parentStates).root.Loading,
          decoded: true,
          data: new Loading({ requestId: "parent" })
        },
        states: {
          Loading: { invoke: { src: "source1" } }
        }
      })
      const parent = yield* Machine.start(parentMachine)
      const child = yield* parent.child(Child)
      assert(Option.isSome(child))
      yield* parent.stop
      assert.deepStrictEqual(yield* child.value.snapshot, {
        status: "stopped",
        state: {
          path: "" as const,
          value: undefined,
          state: { path: "Idle" as const, value: new Idle({ userId: "child" }) }
        }
      })
      assert.instanceOf(yield* Effect.flip(child.value.join), Machine.StoppedError)
      assert(Option.isNone(yield* parent.child(Child)))
    }))
  it.effect("evaluates precompiled input-bearing invoked children for every start", () =>
    Effect.gen(function*() {
      let starts = 0
      const childStates = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle }
      })
      const childMachine = Machine.make({
        root: childStates,
        events: Machine.eventsFromSchemas(),
        input: Input
      }).handle({
        root: ({ input }) => ({ input }),
        initial: {
          target: Machine.targets(childStates).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => {
            starts += 1
            return new Idle({ userId: input.userId })
          }
        },
        states: {
          Idle: {}
        }
      })
      const Child = Machine.child("input-child", childMachine)
      const parentStates = Machine.state({ states: { Loading } })
      const parentMachine = Machine.make({
        children: { source1: Child },
        root: parentStates,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(parentStates).root.Loading,
          decoded: true,
          data: new Loading({ requestId: "parent" })
        },
        states: {
          Loading: {
            invoke: { src: "source1", input: () => ({ userId: "configured" }) }
          }
        }
      })
      const [first, second] = yield* Effect.all([Machine.start(parentMachine), Machine.start(parentMachine)], {
        concurrency: "unbounded"
      })
      const [firstChild, secondChild] = yield* Effect.all([first.child(Child), second.child(Child)])
      assert.strictEqual(starts, 2)
      assert(Option.isSome(firstChild))
      assert(Option.isSome(secondChild))
      assert.notStrictEqual(firstChild.value, secondChild.value)
      assert.deepStrictEqual((yield* firstChild.value.state).state, {
        path: "Idle" as const,
        value: new Idle({ userId: "configured" })
      })
      yield* Effect.all([first.stop, second.stop], { concurrency: "unbounded" })
    }))
  it.effect("delivers completion from an initially final compiled child", () =>
    Effect.gen(function*() {
      class ChildFinished extends Schema.TaggedClass<ChildFinished>("ChildFinished")("ChildFinished", {
        output: Schema.String
      }) {
      }
      const childStates = Machine.state({
        states: {
          Success: { schema: Success, type: "final", output: Schema.String }
        }
      })
      const childMachine = Machine.make({
        root: childStates,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(childStates).root.Success,
          decoded: true,
          data: new Success({ requestId: "child-output" })
        },
        states: {
          Success: { output: ({ state }) => state.requestId }
        }
      })
      const Child = Machine.child("final-child", childMachine)
      const parentStates = Machine.state({
        states: {
          Loading,
          Success: { schema: Success, type: "final", output: Schema.String }
        }
      })
      const targets71 = Machine.targets(parentStates)
      const parentMachine = Machine.make({
        children: { source1: Child },
        root: parentStates,
        events: Machine.eventsFromSchemas(ChildFinished)
      }).handle({
        initial: {
          target: Machine.targets(parentStates).root.Loading,
          decoded: true,
          data: new Loading({ requestId: "parent" })
        },
        states: {
          Loading: {
            invoke: {
              src: "source1",
              onDone: {
                target: targets71.root.Success,
                decoded: true,
                data: ({ output }) => (new Success({ requestId: output }))
              }
            }
          },
          Success: { output: ({ state }) => state.requestId }
        }
      })
      const parent = yield* Machine.start(parentMachine)
      assert.strictEqual(yield* parent.join, "child-output")
    }))
  it.effect("keeps input-bearing process descriptors instance-specific", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle }
      })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(states).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {}
        }
      })
      const [first, second] = yield* Effect.all([
        Machine.start(machine, { userId: "first" }),
        Machine.start(machine, { userId: "second" })
      ], { concurrency: "unbounded" })
      assert.deepStrictEqual((yield* first.state).state, {
        path: "Idle" as const,
        value: new Idle({ userId: "first" })
      })
      assert.deepStrictEqual((yield* second.state).state, {
        path: "Idle" as const,
        value: new Idle({ userId: "second" })
      })
      yield* Effect.all([first.stop, second.stop], { concurrency: "unbounded" })
    }))
  it.effect("child invocation rejects duplicate active child addresses", () =>
    Effect.gen(function*() {
      const childStates = Machine.state({ states: { Idle } })
      const child = Machine.make({
        root: childStates,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(childStates).root.Idle,
          decoded: true,
          data: new Idle({ userId: "child" })
        },
        states: {
          Idle: {}
        }
      })
      const Child = Machine.child("child-machine", child)
      const parentStates = Machine.state({ states: { Loading } })
      const parent = Machine.make({
        children: { source1: Child, source2: Child },
        root: parentStates,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(parentStates).root.Loading,
          decoded: true,
          data: new Loading({ requestId: "request-1" })
        },
        states: {
          Loading: {
            invoke: [{ src: "source1" }, { src: "source2" }]
          }
        }
      })
      const actor = yield* Machine.start(parent)
      const error = yield* Effect.flip(actor.join)
      assert.instanceOf(error, Machine.ChildAlreadyExistsError)
    }))
  it.effect("invokes reject duplicate lifecycle ids even when addresses differ", () =>
    Effect.gen(function*() {
      const First = Machine.childAddress("first")
      const Second = Machine.childAddress("second")
      let sourceEvaluations = 0
      const source = (_input: undefined) => {
        sourceEvaluations += 1
        return Machine.logic({ initial: undefined, run: () => Effect.never })
      }
      const parentStates = Machine.state({ states: { Loading } })
      const parent = Machine.make({
        logic: { source1: source, source2: source },
        root: parentStates,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(parentStates).root.Loading,
          decoded: true,
          data: new Loading({ requestId: "request-1" })
        },
        states: {
          Loading: {
            invoke: [{ src: "source1", id: "worker", address: First, input: () => undefined }, {
              src: "source2",
              id: "worker",
              address: Second,
              input: () => undefined
            }]
          }
        }
      })
      const actor = yield* Machine.start(parent)
      const error = yield* Effect.flip(actor.join)
      assert.instanceOf(error, Machine.ChildAlreadyExistsError)
      assert.strictEqual(error.id, "worker")
      assert.strictEqual(sourceEvaluations, 1)
    }))
  it.effect("start maps invoked child failures to machine events", () =>
    Effect.gen(function*() {
      const error = new InvokeError({ message: "boom" })
      const root74 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading, Failed: FailedOutput }
      })
      const targets74 = Machine.targets(root74)
      const machine = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.fail(error)) },
        root: root74,
        events: Machine.eventsFromSchemas(Submit, RequestFailed),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root74).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets74.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {
            invoke: {
              src: "source1",
              id: "request",
              onFailure: {
                target: targets74.root.Failed,
                decoded: true,
                data: ({ error }) => (new Failed({ message: error.message }))
              }
            }
          },
          Failed: {
            output: ({ state }) => state.message
          }
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))
      assert.strictEqual(yield* actor.join, "boom")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: {
            path: "Failed" as const,
            value: new Failed({ message: "boom" })
          },
          completed: [{ path: "Failed" as const, output: "boom" }, { path: "" as const, output: "boom" }]
        },
        output: "boom"
      })
    }))
  it.effect("start delivers internal invoke events without exposing them through send", () =>
    Effect.gen(function*() {
      const root75 = Machine.state({ states: { Idle, Loading, Success: SuccessOutput } })
      const targets75 = Machine.targets(root75)
      const machine = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.succeed("loaded")) },
        root: root75,
        events: Machine.eventsFromSchemas(Submit),
        internalEvents: Machine.internalEventsFromSchemas(RequestSucceeded)
      }).handle({
        initial: {
          target: Machine.targets(root75).root.Idle,
          decoded: true,
          data: new Idle({ userId: "user-1" })
        },
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets75.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {
            invoke: {
              src: "source1",
              id: "request",
              onDone: {
                target: targets75.root.Success,
                decoded: true,
                data: ({ output }) => (new Success({ requestId: output }))
              }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine)
      yield* actor.send(new Submit({ value: "start" }))
      assert.strictEqual(yield* actor.join, "loaded")
    }))
  it.effect("routes sendTo(parent) from an active invoked machine", () =>
    Effect.gen(function*() {
      const childStarted = yield* Deferred.make<void>()
      const root76 = Machine.state({ states: { Loading, Success: SuccessOutput } })
      const targets76 = Machine.targets(root76)
      const machine = Machine.make({
        logic: {
          source1: Machine.logic({
            initial: undefined,
            run: ({ parent, sendTo }) =>
              parent === undefined ?
                Effect.die("child expected an owning actor") :
                Deferred.succeed(childStarted, void 0).pipe(
                  Effect.andThen(sendTo(parent, new RequestSucceeded({ value: "child" }))),
                  Effect.andThen(Effect.never)
                )
          })
        },
        root: root76,
        events: Machine.eventsFromSchemas(RequestSucceeded)
      }).handle({
        initial: {
          target: Machine.targets(root76).root.Loading,
          decoded: true,
          data: new Loading({ requestId: "request-1" })
        },
        states: {
          Loading: {
            invoke: {
              src: "source1",
              id: "request",
              address: Machine.childAddress("request-parent"),
              onFailure: { none: true }
            },
            on: {
              RequestSucceeded: {
                target: targets76.root.Success,
                decoded: true,
                data: ({ event }) => (new Success({ requestId: event.value }))
              }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine)
      yield* Deferred.await(childStarted)
      assert.strictEqual(yield* actor.join, "child")
    }))
  it.effect("drops sendTo(parent) from a stale invoked machine finalizer", () =>
    Effect.gen(function*() {
      const childStarted = yield* Deferred.make<void>()
      const root77 = Machine.state({ states: { Idle, Loading, Success: SuccessOutput } })
      const targets77 = Machine.targets(root77)
      const machine = Machine.make({
        logic: {
          source1: Machine.logic({
            initial: undefined,
            run: ({ parent, sendTo }) =>
              parent === undefined ?
                Effect.die("child expected an owning actor") :
                Deferred.succeed(childStarted, void 0).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => sendTo(parent, new RequestSucceeded({ value: "stale" })))
                )
          })
        },
        root: root77,
        events: Machine.eventsFromSchemas(Resolve, RequestSucceeded)
      }).handle({
        initial: {
          target: Machine.targets(root77).root.Loading,
          decoded: true,
          data: new Loading({ requestId: "request-1" })
        },
        states: {
          Idle: {
            on: {
              RequestSucceeded: {
                target: targets77.root.Success,
                decoded: true,
                data: ({ event }) => (new Success({ requestId: event.value }))
              }
            }
          },
          Loading: {
            invoke: {
              src: "source1",
              id: "request",
              address: Machine.childAddress("stale-request"),
              onFailure: { none: true }
            },
            on: {
              Resolve: { target: targets77.root.Idle, decoded: true, data: () => (new Idle({ userId: "resolved" })) }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine)
      yield* Deferred.await(childStarted)
      yield* sendAndWaitForSnapshot(actor, new Resolve({}), (snapshot) =>
        snapshot.status === "active" && snapshot.state.state.path === "Idle")
      yield* Effect.yieldNow
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: {
          path: "" as const,
          value: undefined,
          state: { path: "Idle" as const, value: new Idle({ userId: "resolved" }) }
        }
      })
      yield* actor.stop
    }))
  it.effect("inline Effect invocation handles typed failures without manual recovery", () =>
    Effect.gen(function*() {
      const failure = new InvokeError({ message: "unavailable" })
      const root78 = Machine.state({ states: { Loading, Failed: FailedOutput } })
      const targets78 = Machine.targets(root78)
      const machine = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.fail(failure)) },
        root: root78,
        events: Machine.eventsFromSchemas(),
        internalEvents: Machine.internalEventsFromSchemas(RequestSucceeded, RequestFailed)
      }).handle({
        initial: {
          target: Machine.targets(root78).root.Loading,
          decoded: true,
          data: new Loading({ requestId: "request-1" })
        },
        states: {
          Loading: {
            invoke: {
              src: "source1",
              id: "request",
              onFailure: {
                target: targets78.root.Failed,
                decoded: true,
                data: ({ error }) => (new Failed({ message: error.message }))
              }
            }
          },
          Failed: {
            output: ({ state }) => state.message
          }
        }
      })
      const actor = yield* Machine.start(machine)
      assert.strictEqual(yield* actor.join, "unavailable")
    }))
  it.effect("preserves services for an invoke started by compiled initialization", () =>
    Effect.gen(function*() {
      const requiredMessage: Effect.Effect<string, never, InitialRequirement> = Effect.gen(function*() {
        return (yield* InitialRequirement).initialMessage
      })
      const root79 = Machine.state({ states: { Loading, Success: SuccessOutput } })
      const targets79 = Machine.targets(root79)
      const machine = Machine.make({
        effects: { source1: Effect.suspend(() => requiredMessage) },
        root: root79,
        events: Machine.eventsFromSchemas(),
        internalEvents: Machine.internalEventsFromSchemas(RequestSucceeded)
      }).handle({
        initial: {
          target: Machine.targets(root79).root.Loading,
          decoded: true,
          data: new Loading({ requestId: "request-1" })
        },
        states: {
          Loading: {
            invoke: {
              src: "source1",
              id: "request",
              onDone: {
                target: targets79.root.Success,
                decoded: true,
                data: ({ output }) => (new Success({ requestId: output }))
              }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine).pipe(
        Effect.provideService(InitialRequirement, InitialRequirement.of({ initialMessage: "from-service" }))
      )
      assert.strictEqual(yield* actor.join, "from-service")
    }))
  it.effect("after emits a state-scoped internal event", () =>
    Effect.gen(function*() {
      const root80 = Machine.state({ states: { Loading, Success: SuccessOutput } })
      const targets80 = Machine.targets(root80)
      const machine = Machine.make({
        timers: { source1: "1 hour" },
        root: root80,
        events: Machine.eventsFromSchemas(),
        internalEvents: Machine.internalEventsFromSchemas(RequestSucceeded)
      }).handle({
        initial: {
          target: Machine.targets(root80).root.Loading,
          decoded: true,
          data: new Loading({ requestId: "request-1" })
        },
        states: {
          Loading: {
            invoke: {
              src: "source1",
              id: "timeout",
              onDone: {
                target: targets80.root.Success,
                decoded: true,
                data: () => (new Success({ requestId: "timeout" }))
              }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine)
      const joined = yield* actor.join.pipe(Effect.forkChild)
      yield* TestClock.adjust("1 hour")
      assert.strictEqual(yield* Fiber.join(joined), "timeout")
    }))
  it.effect("start maps invoked child active snapshots to machine events", () =>
    Effect.gen(function*() {
      const root81 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading, Success: SuccessOutput }
      })
      const targets81 = Machine.targets(root81)
      const definition = Machine.make({
        logic: { progress: Machine.logic({ initial: "pending", run: () => Effect.never }) },
        root: root81,
        events: Machine.eventsFromSchemas(Submit, RequestProgress),
        input: Input
      })
      const machine = definition.handle({
        initial: {
          target: Machine.targets(root81).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets81.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {
            invoke: {
              src: "progress",
              id: "request",
              address: Machine.childAddress("progress-request"),
              onSnapshot: {
                target: targets81.root.Success,
                decoded: true,
                data: ({ id, snapshot }) => new Success({ requestId: `${id}:${snapshot.state}` })
              }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))
      assert.strictEqual(yield* actor.join, "request:pending")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: {
            path: "Success" as const,
            value: new Success({ requestId: "request:pending" })
          },
          completed: [{ path: "Success" as const, output: "request:pending" }, {
            path: "" as const,
            output: "request:pending"
          }]
        },
        output: "request:pending"
      })
    }))
  it.effect("start fails the owning machine when an invoked effect defects", () =>
    Effect.gen(function*() {
      const error = new InvokeError({ message: "boom" })
      const root82 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading }
      })
      const targets82 = Machine.targets(root82)
      const machine = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.die(error)) },
        root: root82,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root82).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets82.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {
            invoke: { src: "source1", id: "request" }
          }
        }
      })
      const ref = yield* Machine.start(machine, { userId: "user-1" })
      const snapshot = yield* sendAndWaitForSnapshot(ref, new Submit({ value: "hello" }), (snapshot) =>
        snapshot.status === "error")
      assert.strictEqual(snapshot.status, "error")
      if (snapshot.status !== "error") {
        return assert.fail("expected an error snapshot")
      }
      assert.strictEqual(Cause.squash(snapshot.cause), error)
      assert.deepStrictEqual(snapshot.state.state, {
        path: "Loading" as const,
        value: new Loading({ requestId: "request-1" })
      })
    }))
  it.effect("start lets invoke snapshot handlers filter with target.none", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const root83 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading, Success: SuccessOutput }
      })
      const targets83 = Machine.targets(root83)
      const definition = Machine.make({
        logic: {
          progress: Machine.logic({
            initial: "pending",
            run: ({ setState }) =>
              Deferred.succeed(started, void 0).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(setState("ready")),
                Effect.andThen(Effect.never)
              )
          })
        },
        branches: {
          snapshots: { ready: { target: targets83.root.Success, title: "Request is ready" }, unchanged: { none: true } }
        },
        root: root83,
        events: Machine.eventsFromSchemas(Submit, RequestProgress),
        input: Input
      })
      const machine = definition.handle({
        initial: {
          target: Machine.targets(root83).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets83.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {
            invoke: {
              src: "progress",
              id: "request",
              address: Machine.childAddress("filtered-progress"),
              onSnapshot: {
                branches: "snapshots",
                resolve: ({ snapshot, select }) =>
                  snapshot.state === "ready"
                    ? select.ready.decoded(new Success({ requestId: snapshot.state }))
                    : select.unchanged()
              }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))
      yield* Deferred.await(started)
      yield* Effect.yieldNow
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
        }
      })
      yield* Deferred.succeed(release, void 0)
      assert.strictEqual(yield* actor.join, "ready")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: {
            path: "Success" as const,
            value: new Success({ requestId: "ready" })
          },
          completed: [{ path: "Success" as const, output: "ready" }, { path: "" as const, output: "ready" }]
        },
        output: "ready"
      })
    }))
  it.effect("start allows invoked children without a snapshot handler", () =>
    Effect.gen(function*() {
      const root84 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading }
      })
      const targets84 = Machine.targets(root84)
      const machine = Machine.make({
        logic: {
          source1: Machine.logic({
            initial: "pending",
            run: () => Effect.void
          })
        },
        root: root84,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root84).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets84.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {
            invoke: {
              src: "source1",
              id: "request",
              address: Machine.childAddress("void-request"),
              onDone: { none: true }
            }
          }
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))
      yield* Effect.yieldNow
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
        }
      })
      yield* actor.stop
    }))
  it.effect("start stops active invokes before final join completes", () =>
    Effect.gen(function*() {
      const childStarted = yield* Deferred.make<void>()
      const childStopping = yield* Deferred.make<void>()
      const releaseChildStop = yield* Deferred.make<void>()
      const joinDone = yield* Ref.make(false)
      const childLogic = Machine.logic({
        initial: "pending",
        run: () =>
          Deferred.succeed(childStarted, void 0).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Deferred.succeed(childStopping, void 0).pipe(Effect.andThen(Deferred.await(releaseChildStop)))
            )
          )
      })
      const root85 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading, Success: SuccessOutput }
      })
      const targets85 = Machine.targets(root85)
      const machine = Machine.make({
        logic: { source1: childLogic },
        root: root85,
        events: Machine.eventsFromSchemas(Submit, Resolve, RequestSucceeded),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root85).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            on: {
              Submit: {
                target: targets85.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {
            invoke: { src: "source1", id: "request", address: Machine.childAddress("stopping-request") },
            on: {
              Resolve: {
                target: targets85.root.Success,
                decoded: true,
                data: () => (new Success({ requestId: "request-1" }))
              },
              RequestSucceeded: {
                target: targets85.root.Success,
                decoded: true,
                data: ({ event }) => (new Success({ requestId: event.value }))
              }
            }
          },
          Success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })
      const joinFiber = yield* actor.join.pipe(Effect.tap(() => Ref.set(joinDone, true)), Effect.forkChild)
      yield* actor.send(new Submit({ value: "hello" }))
      yield* Deferred.await(childStarted)
      yield* actor.send(new Resolve({}))
      yield* Deferred.await(childStopping)
      assert.strictEqual(yield* Ref.get(joinDone), false)
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
        }
      })
      yield* Deferred.succeed(releaseChildStop, void 0)
      assert.strictEqual(yield* Fiber.join(joinFiber), "request-1")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: { _tag: "", input: { userId: "user-1" } },
          state: {
            path: "Success" as const,
            value: new Success({ requestId: "request-1" })
          },
          completed: [{ path: "Success" as const, output: "request-1" }, { path: "" as const, output: "request-1" }]
        },
        output: "request-1"
      })
    }))
  it.effect("start scopes invokes to entered and exited compound state nodes", () =>
    Effect.gen(function*() {
      const payment = new Payment({ id: "payment-1" })
      const entering = new EnteringPayment({ amount: 100 })
      const parentStarted = yield* Deferred.make<void>()
      const enteringStarted = yield* Deferred.make<void>()
      const authorizedStarted = yield* Deferred.make<void>()
      const stopped = yield* Ref.make<ReadonlyArray<string>>([])
      const makeInvokeLogic = (label: string, started: Deferred.Deferred<void>) =>
        Machine.logic({
          initial: "pending",
          run: () =>
            Deferred.succeed(started, void 0).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Ref.update(stopped, (labels) => [...labels, label]))
            )
        })
      const root86 = Machine.state({
        states: {
          payment: {
            schema: Payment,
            states: {
              entering: EnteringPayment,
              authorized: AuthorizedPayment
            }
          }
        }
      })
      const targets86 = Machine.targets(root86)
      const machine = Machine.make({
        logic: {
          source1: makeInvokeLogic("parent", parentStarted),
          source2: makeInvokeLogic("entering", enteringStarted),
          source3: makeInvokeLogic("authorized", authorizedStarted)
        },
        root: root86,
        events: Machine.eventsFromSchemas(Authorize)
      }).handle({
        initial: {
          target: Machine.targets(root86).root.payment,
          decoded: true,
          data: payment
        },
        states: {
          payment: {
            initial: {
              target: Machine.targets(root86).root.payment.entering,
              decoded: true,
              data: entering
            },
            invoke: { src: "source1", id: "request", address: Machine.childAddress("payment-parent") },
            states: {
              entering: {
                entry: ({ ancestors, state }) => {
                  assert.deepStrictEqual(state, entering)
                  assert.deepStrictEqual(ancestors, { payment })
                },
                invoke: { src: "source2", id: "request", address: Machine.childAddress("payment-entering") },
                on: {
                  Authorize: {
                    target: targets86.root.payment.authorized,
                    decoded: true,
                    data: ({ event }) => (new AuthorizedPayment({ code: event.code }))
                  }
                }
              },
              authorized: {
                invoke: { src: "source3", id: "request", address: Machine.childAddress("payment-authorized") }
              }
            }
          }
        }
      })
      const actor = yield* Machine.start(machine)
      yield* Deferred.await(parentStarted)
      yield* Deferred.await(enteringStarted)
      yield* sendAndWaitForSnapshot(actor, new Authorize({ code: "auth-1" }), (snapshot) =>
        snapshot.status === "active" &&
        snapshot.state.state.path === "payment" &&
        (snapshot.state as any).state.state.path === "payment.authorized")
      yield* Deferred.await(authorizedStarted)
      assert.deepStrictEqual(yield* Ref.get(stopped), ["entering"])
      yield* actor.stop
      const stoppedLabels = yield* Ref.get(stopped)
      assert.deepStrictEqual([...stoppedLabels].sort(), ["authorized", "entering", "parent"])
    }))
  it.effect("start stops parent and parallel region invokes before final completion", () =>
    Effect.gen(function*() {
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const releaseStops = yield* Deferred.make<void>()
      const parentStarted = yield* Deferred.make<void>()
      const inventoryStarted = yield* Deferred.make<void>()
      const shippingStarted = yield* Deferred.make<void>()
      const parentStopping = yield* Deferred.make<void>()
      const inventoryStopping = yield* Deferred.make<void>()
      const shippingStopping = yield* Deferred.make<void>()
      const joinDone = yield* Ref.make(false)
      const makeInvokeLogic = (started: Deferred.Deferred<void>, stopping: Deferred.Deferred<void>) =>
        Machine.logic({
          initial: "pending",
          run: () =>
            Deferred.succeed(started, void 0).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(stopping, void 0).pipe(Effect.andThen(Deferred.await(releaseStops)))
              )
            )
        })
      const root87 = Machine.state({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                states: {
                  checking: CheckingInventory
                }
              },
              shipping: {
                schema: Shipping,
                states: {
                  quoting: QuotingShipping
                }
              }
            }
          },
          success: {
            schema: Success,
            type: "final",
            output: Schema.String
          }
        }
      })
      const targets87 = Machine.targets(root87)
      const machine = Machine.make({
        logic: {
          source1: makeInvokeLogic(parentStarted, parentStopping),
          source2: makeInvokeLogic(inventoryStarted, inventoryStopping),
          source3: makeInvokeLogic(shippingStarted, shippingStopping)
        },
        root: root87,
        events: Machine.eventsFromSchemas(ReserveInventory)
      }).handle({
        initial: {
          target: Machine.targets(root87).root.fulfillment,
          decoded: true,
          data: fulfillment
        },
        states: {
          fulfillment: {
            initial: { inventory: { decoded: true, data: inventory }, shipping: { decoded: true, data: shipping } },
            invoke: { src: "source1", id: "request", address: Machine.childAddress("fulfillment-parent") },
            states: {
              inventory: {
                initial: {
                  target: Machine.targets(root87).root.fulfillment.inventory.checking,
                  decoded: true,
                  data: new CheckingInventory({ sku: "sku-1" })
                },
                invoke: { src: "source2", id: "request", address: Machine.childAddress("fulfillment-inventory") },
                states: {
                  checking: {
                    on: {
                      ReserveInventory: {
                        target: targets87.root.success,
                        decoded: true,
                        data: () => (new Success({ requestId: "done" }))
                      }
                    }
                  }
                }
              },
              shipping: {
                initial: {
                  target: Machine.targets(root87).root.fulfillment.shipping.quoting,
                  decoded: true,
                  data: new QuotingShipping({ postalCode: "12345" })
                },
                invoke: { src: "source3", id: "request", address: Machine.childAddress("fulfillment-shipping") },
                states: {
                  quoting: {}
                }
              }
            }
          },
          success: {
            output: ({ state }) => state.requestId
          }
        }
      })
      const actor = yield* Machine.start(machine)
      const joinFiber = yield* actor.join.pipe(Effect.tap(() => Ref.set(joinDone, true)), Effect.forkChild)
      yield* Deferred.await(parentStarted)
      yield* Deferred.await(inventoryStarted)
      yield* Deferred.await(shippingStarted)
      const sendFiber = yield* actor.send(new ReserveInventory({ reservationId: "res-1" })).pipe(Effect.forkChild)
      yield* Deferred.await(parentStopping)
      yield* Deferred.await(inventoryStopping)
      yield* Deferred.await(shippingStopping)
      assert.strictEqual(yield* Ref.get(joinDone), false)
      yield* Deferred.succeed(releaseStops, void 0)
      yield* Fiber.join(sendFiber)
      assert.strictEqual(yield* Fiber.join(joinFiber), "done")
    }))
  it.effect("wraps initializer defects without losing their cause", () =>
    Effect.gen(function*() {
      const defect = new Error("initializer defect")
      const InitialRoot6 = Machine.state({ states: { Idle } })
      const machine = Machine.make({
        root: InitialRoot6,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(InitialRoot6).root.Idle,
          data: () => {
            throw defect
          }
        },
        states: {
          Idle: {}
        }
      })
      const planningError = yield* Effect.flip(Machine.planInitial(machine))
      const startupError = yield* Effect.flip(Machine.start(machine))
      assert.instanceOf(planningError, Machine.StartupError)
      assert(Cause.hasDies(planningError.cause))
      assert.instanceOf(startupError, Machine.StartupError)
      assert(Cause.hasDies(startupError.cause))
    }))
  it("rejects a foreign initial target while capturing the definition", () => {
    const root = Machine.state({ states: { Idle: {} } })
    const foreign = Machine.state({ states: { Other: {} } })
    const definition = Machine.make({ root, events: Machine.eventsFromSchemas() })
    assert.throws(
      () => definition.handle({ initial: { target: Machine.targets(foreign).root.Other } } as never),
      /direct child/
    )
  })
  it.effect("fails when always transitions do not stabilize", () =>
    Effect.gen(function*() {
      const root88 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { Idle, Loading }
      })
      const targets88 = Machine.targets(root88)
      const machine = Machine.make({
        id: "LoopMachine",
        root: root88,
        events: Machine.eventsFromSchemas(Submit),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(root88).root.Idle,
          decoded: true,
          data: ({ root: { input: input } }) => new Idle({ userId: input.userId })
        },
        root: ({ input }) => ({ input }),
        states: {
          Idle: {
            always: {
              target: targets88.root.Loading,
              decoded: true,
              data: () => (new Loading({ requestId: "request-1" }))
            },
            on: {
              Submit: {
                target: targets88.root.Loading,
                decoded: true,
                data: () => (new Loading({ requestId: "request-1" }))
              }
            }
          },
          Loading: {
            always: { target: targets88.root.Idle, decoded: true, data: () => (new Idle({ userId: "user-1" })) }
          }
        }
      })
      const error = yield* Effect.flip(Machine.plan(machine, {
        path: "" as const,
        value: { _tag: "", input: { userId: "user-1" } },
        state: FlatInitial.Idle(new Idle({ userId: "user-1" }))
      }, new Submit({ value: "hello" })))
      assert.instanceOf(error, Machine.InfiniteTransitionError)
      assert.strictEqual(error._tag, "InfiniteTransitionError")
      assert.strictEqual(error.machineId, "LoopMachine")
      assert.strictEqual(error.maxIterations, 1000)
    }))
  it.effect("fails initial planning and startup when always transitions do not stabilize", () =>
    Effect.gen(function*() {
      const root89 = Machine.state({ states: { Idle, Loading } })
      const targets89 = Machine.targets(root89)
      const machine = Machine.make({
        id: "InitialLoopMachine",
        root: root89,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(root89).root.Idle,
          decoded: true,
          data: new Idle({ userId: "user-1" })
        },
        states: {
          Idle: {
            always: {
              target: targets89.root.Loading,
              decoded: true,
              data: () => (new Loading({ requestId: "request-1" }))
            }
          },
          Loading: {
            always: { target: targets89.root.Idle, decoded: true, data: () => (new Idle({ userId: "user-1" })) }
          }
        }
      })
      const planningError = yield* Effect.flip(Machine.planInitial(machine))
      const startupError = yield* Effect.flip(Machine.start(machine))
      assert.instanceOf(planningError, Machine.InfiniteTransitionError)
      assert.strictEqual(planningError.machineId, "InitialLoopMachine")
      assert.strictEqual(planningError.maxIterations, 1000)
      assert.instanceOf(startupError, Machine.InfiniteTransitionError)
      assert.strictEqual(startupError.machineId, "InitialLoopMachine")
      assert.strictEqual(startupError.maxIterations, 1000)
    }))
  it.effect("fails when completion transitions do not stabilize", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        states: {
          idle: Idle,
          flow: {
            schema: Loading,
            states: {
              done: {
                schema: Success,
                type: "final"
              }
            }
          }
        }
      })
      const targets90 = Machine.targets(states)
      const machine = Machine.make({
        branches: {
          transition1: { destination: { target: targets90.root.flow } },
          transition2: { destination: { target: targets90.root.flow } }
        },
        id: "CompletionLoopMachine",
        root: states,
        events: Machine.eventsFromSchemas(Submit)
      }).handle({
        initial: {
          target: Machine.targets(states).root.idle,
          decoded: true,
          data: new Idle({ userId: "user-1" })
        },
        states: {
          idle: {
            on: {
              Submit: {
                branches: "transition1",
                resolve: ({ select: { destination: target } }) =>
                  target.decoded(new Loading({ requestId: "request-1" }), (flow) =>
                    flow.done.decoded(new Success({ requestId: "request-1" })))
              }
            }
          },
          flow: {
            initial: {
              target: Machine.targets(states).root.flow.done,
              data: { requestId: "initial" }
            },
            onDone: {
              branches: "transition2",
              resolve: ({ state, select: { destination: target } }) =>
                target.decoded(state, (flow) =>
                  flow.done.decoded(new Success({ requestId: state.requestId })))
            },
            states: {
              done: {}
            }
          }
        }
      })
      const error = yield* Effect.flip(Machine.plan(machine, {
        path: "" as const,
        value: undefined,
        state: { path: "idle" as const, value: new Idle({ userId: "user-1" }) }
      }, new Submit({ value: "request-1" })))
      assert.instanceOf(error, Machine.InfiniteTransitionError)
      assert.strictEqual(error.machineId, "CompletionLoopMachine")
      assert.strictEqual(error.maxIterations, 1000)
    }))
  class CounterRunning extends Schema.TaggedClass<CounterRunning>("CounterRunning")("CounterRunning", {}) {
  }
  class LeftCounter extends Schema.TaggedClass<LeftCounter>("LeftCounter")("LeftCounter", {
    value: Schema.Number
  }) {
  }
  class RightCounter extends Schema.TaggedClass<RightCounter>("RightCounter")("RightCounter", {
    value: Schema.Number
  }) {
  }
  class AdvanceCounters extends Schema.TaggedClass<AdvanceCounters>("AdvanceCounters")("AdvanceCounters", {}) {
  }
  class ConcurrentIdle extends Schema.TaggedClass<ConcurrentIdle>("ConcurrentIdle")("ConcurrentIdle", {}) {
  }
  class ConcurrentPing extends Schema.TaggedClass<ConcurrentPing>("ConcurrentPing")("ConcurrentPing", {}) {
  }
  const ParallelCounterStates = Machine.state({
    states: {
      running: {
        schema: CounterRunning,
        type: "parallel",
        states: {
          left: LeftCounter,
          right: RightCounter
        }
      }
    }
  })
  const makeParallelCounterMachine = () => {
    const targets91 = Machine.targets(ParallelCounterStates)
    return Machine.make({
      root: ParallelCounterStates,
      events: Machine.eventsFromSchemas(AdvanceCounters)
    }).handle({
      initial: {
        target: Machine.targets(ParallelCounterStates).root.running,
        decoded: true,
        data: new CounterRunning({})
      },
      states: {
        running: {
          initial: {
            left: { decoded: true, data: new LeftCounter({ value: 0 }) },
            right: { decoded: true, data: new RightCounter({ value: 0 }) }
          },
          states: {
            left: {
              on: {
                AdvanceCounters: {
                  target: targets91.root.running.left,
                  decoded: true,
                  data: ({ state }) => (new LeftCounter({ value: state.value + 1 }))
                }
              }
            },
            right: {
              on: {
                AdvanceCounters: {
                  target: targets91.root.running.right,
                  decoded: true,
                  data: ({ state }) => (new RightCounter({ value: state.value + 1 }))
                }
              }
            }
          }
        }
      }
    })
  }
  const makeConcurrentMachine = () => {
    const states = Machine.state({ states: { ConcurrentIdle } })
    return Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(ConcurrentPing)
    }).handle({
      initial: {
        target: Machine.targets(states).root.ConcurrentIdle,
        decoded: true,
        data: new ConcurrentIdle({})
      },
      states: {
        ConcurrentIdle: {
          on: {
            ConcurrentPing: { none: true }
          }
        }
      }
    })
  }
  it.effect("keeps every parallel state active across repeated transitions", () =>
    Effect.gen(function*() {
      const machine = makeParallelCounterMachine()
      let snapshot: Machine.Snapshot<typeof ParallelCounterStates> = (yield* Machine.planInitial(machine)).state
      for (let iteration = 1; iteration <= 32; iteration++) {
        const cloned = {
          ...snapshot,
          state: { ...snapshot.state, states: { ...snapshot.state.states } }
        }
        const planned = yield* Machine.plan(machine, cloned, new AdvanceCounters({}))
        assert.strictEqual(planned.next.state.path, "running")
        assert.deepStrictEqual(Object.keys(planned.next.state.states).sort(), ["left", "right"])
        assert.strictEqual(planned.next.state.states.left.path, "running.left")
        assert.strictEqual(planned.next.state.states.right.path, "running.right")
        assert.strictEqual(planned.next.state.states.left.value.value, iteration)
        assert.strictEqual(planned.next.state.states.right.value.value, iteration)
        for (const microstep of planned.microsteps) {
          assert.strictEqual(new Set(microstep.exitPaths).size, microstep.exitPaths.length)
          assert.strictEqual(new Set(microstep.entryPaths).size, microstep.entryPaths.length)
        }
        snapshot = planned.next
      }
    }))
  it.effect("reports a schema error when structuredClone removes state class identity", () =>
    Effect.gen(function*() {
      const machine = makeParallelCounterMachine()
      const snapshot = (yield* Machine.planInitial(machine)).state
      const error = yield* Effect.flip(Machine.plan(machine, structuredClone(snapshot), new AdvanceCounters({})))
      assert.instanceOf(error, Machine.MachineSchemaDecodeError)
      assert.strictEqual(error.boundary, "state")
      assert.strictEqual(error.state, "running")
    }))
  it.effect("leaves a machine stopped when it is stopped concurrently", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(makeConcurrentMachine())
      yield* Effect.all([ref.stop, ref.stop, ref.stop], { concurrency: "unbounded" })
      assert.deepStrictEqual(yield* ref.snapshot, {
        status: "stopped",
        state: {
          path: "" as const,
          value: undefined,
          state: { path: "ConcurrentIdle" as const, value: new ConcurrentIdle({}) }
        }
      })
    }))
  it.effect("keeps a machine stopped when sending an event races with stopping it", () =>
    Effect.gen(function*() {
      for (let iteration = 0; iteration < 32; iteration++) {
        const ref = yield* Machine.start(makeConcurrentMachine())
        const send = ref.send(new ConcurrentPing({})).pipe(
          Effect.as("accepted" as const),
          Effect.catchTag("StoppedError", () => Effect.succeed("stopped" as const))
        )
        const [sendResult] = yield* Effect.all([send, ref.stop], { concurrency: "unbounded" })
        assert.strictEqual(sendResult === "accepted" || sendResult === "stopped", true)
        assert.strictEqual((yield* ref.snapshot).status, "stopped")
        assert.instanceOf(yield* Effect.flip(ref.send(new ConcurrentPing({}))), Machine.StoppedError)
      }
    }))
})
