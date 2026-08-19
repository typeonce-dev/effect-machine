import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Data, Deferred, Effect, Fiber, Option, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../src/index.js"

class InitialRequirement extends Context.Service<InitialRequirement, {
  readonly initialMessage: string
}>()("test/Machine/InitialRequirement") {}

class InvokeError extends Data.TaggedError("InvokeError")<{
  readonly message: string
}> {}

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
  actual: Machine.Machine.AtomicSnapshot<Path, Value>,
  path: Path,
  value: Value
) => {
  assert.strictEqual(actual.path, path)
  assert.deepStrictEqual(actual.value, value)
}

const assertCompoundStateSnapshot = <Path extends string, Value, Child>(
  actual: Machine.Machine.CompoundSnapshot<Path, Value, Child>,
  path: Path,
  value: Value,
  state: Child
) => {
  assert.strictEqual(actual.path, path)
  assert.deepStrictEqual(actual.value, value)
  assert.deepStrictEqual(actual.state, state)
}

const assertParallelStateSnapshot = <Path extends string, Value, States>(
  actual: Machine.Machine.ParallelSnapshot<Path, Value, States>,
  path: Path,
  value: Value,
  states: States
) => {
  assert.strictEqual(actual.path, path)
  assert.deepStrictEqual(actual.value, value)
  assert.deepStrictEqual(actual.states, states)
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

const unsafeTagged = <A extends { readonly _tag: PropertyKey }>(value: A): A => value

describe("Machine", () => {
  it("creates independent one-shot implementations from one definition", () => {
    class Stable extends Schema.TaggedClass<Stable>("OneShotStable")("Stable", {}) {}
    class Ping extends Schema.TaggedClass<Ping>("OneShotPing")("Ping", {}) {}
    const states = Machine.states({ Stable })
    const definition = Machine.make({
      states: states.states,
      events: Machine.events(Ping),
      initial: (to) => to.Stable().resolve(({ target }) => target(new Stable({})))
    })
    const handlingPing = definition.handle({ Stable: { on: { Ping: (to) => to.none } } })
    const ignoringPing = definition.handle({ Stable: {} })

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
      class Stable extends Schema.TaggedClass<Stable>("Stable")("Stable", {}) {}
      class Ping extends Schema.TaggedClass<Ping>("Ping")("Ping", {}) {}
      const states = Machine.states({ Stable })
      let captures = 0
      let resolves = 0
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Ping),
        initial: (to) => to.Stable().resolve(({ target }) => target(new Stable({})))
      }).handle({
        Stable: {
          on: {
            Ping: (to) => {
              captures++
              return to.none.resolve(() => {
                resolves++
              })
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
          selection: { path: undefined, kind: "none", scope: "local" }
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
      class Idle extends Schema.TaggedClass<Idle>("BareTargetIdle")("Idle", {}) {}
      class Done extends Schema.TaggedClass<Done>("BareTargetDone")("Done", {}) {}
      class Finish extends Schema.TaggedClass<Finish>("BareTargetFinish")("Finish", {}) {}
      const machine = Machine.make({
        states: { Idle, Done },
        events: Machine.events(Finish),
        initial: (to) => to.Idle().resolve(({ target }) => target.from())
      }).handle({
        Idle: { on: { Finish: (to) => to.full.Done() } },
        Done: {}
      })

      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Finish({}))

      assert.deepStrictEqual(planned.next, { path: "Done", value: new Done({}) })
      assert.deepStrictEqual(planned.microsteps[0]?.exitPaths, ["Idle"])
      assert.deepStrictEqual(planned.microsteps[0]?.entryPaths, ["Done"])
    }))

  it.effect("reenters a selected target without requiring a resolver", () =>
    Effect.gen(function*() {
      class Stable extends Schema.TaggedClass<Stable>("ResolverFreeReentryStable")("Stable", {}) {}
      class Restart extends Schema.TaggedClass<Restart>("ResolverFreeReentryRestart")("Restart", {}) {}
      const machine = Machine.make({
        states: { Stable },
        events: Machine.events(Restart),
        initial: (to) => to.Stable().resolve(({ target }) => target.from())
      }).handle({
        Stable: { on: { Restart: (to) => to.none.reenter() } }
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
      class Stable extends Schema.TaggedClass<Stable>("NamedBranchStable")("Stable", {}) {}
      class Ping extends Schema.TaggedClass<Ping>("NamedBranchPing")("Ping", { route: Schema.Boolean }) {}
      const states = Machine.states({ Stable })
      let captures = 0
      let declarations: any
      const definition = Machine.make({
        states: states.states,
        events: Machine.events(Ping),
        initial: (to) => to.Stable().resolve(({ target }) => target(new Stable({})))
      })
      const machine = definition.handle({
        Stable: {
          on: {
            Ping: (to) => {
              captures++
              const captured = {
                unchanged: { target: to.none },
                refresh: { title: "Refresh stable state", target: to.full.Stable() }
              }
              declarations = captured
              return to.branches(captured).resolve(({ event, select }) =>
                event.route
                  ? select.refresh(new Stable({}))
                  : select.unchanged(), { reenter: true })
            }
          }
        }
      })

      declarations.refresh.title = "mutated after capture"

      assert.strictEqual(captures, 1)
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
          selection: { path: undefined, kind: "none", scope: "local" }
        }, {
          type: "branch",
          key: "refresh",
          title: "Refresh stable state",
          target: "Stable",
          selection: { path: "Stable", kind: "state", scope: "full" }
        }]
      }])

      const initial = yield* Machine.planInitial(machine)
      const unchanged = yield* Machine.plan(machine, initial.state, new Ping({ route: false }))
      const refresh = yield* Machine.plan(machine, initial.state, new Ping({ route: true }))
      assert.strictEqual(unchanged.microsteps[0]?.transitions[0]?.branchKey, "unchanged")
      assert.strictEqual(refresh.microsteps[0]?.transitions[0]?.branchKey, "refresh")
      assert.deepStrictEqual(unchanged.microsteps[0]?.exitPaths, ["Stable"])
      assert.deepStrictEqual(unchanged.microsteps[0]?.entryPaths, ["Stable"])
      assert.strictEqual(captures, 1)
    }))

  it("rejects branch records without stable string identities", () => {
    class Stable extends Schema.TaggedClass<Stable>("InvalidBranchStable")("Stable", {}) {}
    class Ping extends Schema.TaggedClass<Ping>("InvalidBranchPing")("Ping", {}) {}
    const makeDefinition = () =>
      Machine.make({
        states: { Stable },
        events: Machine.events(Ping),
        initial: (to) => to.Stable().resolve(({ target }) => target(new Stable({})))
      })
    const handle = (branches: (to: any) => object) => () =>
      makeDefinition().handle({
        Stable: {
          on: {
            Ping: ((to: any) => to.branches(branches(to)).resolve((() => undefined) as any)) as any
          }
        }
      })

    assert.throws(handle(() => ({})), /requires a branch/)
    assert.throws(handle((to) => [{ target: to.none }]), /requires a branch record/)
    assert.throws(handle((to) => ({ "": { target: to.none } })), /non-index string branch keys/)
    assert.throws(handle((to) => ({ 0: { target: to.none } })), /non-index string branch keys/)
    assert.throws(handle((to) => ({ invalid: { title: "", target: to.none } })), /non-empty string/)
    assert.throws(handle(() => ({ invalid: { target: undefined } })), /must select exactly one target/)
    assert.throws(
      handle((to) => ({ valid: { target: to.none }, [Symbol("invalid")]: { target: to.none } })),
      /cannot use symbol keys/
    )
  })

  it.effect("rejects selected branch evidence from another transition", () =>
    Effect.gen(function*() {
      class Stable extends Schema.TaggedClass<Stable>("OwnedBranchStable")("Stable", {}) {}
      class Capture extends Schema.TaggedClass<Capture>("OwnedBranchCapture")("Capture", {}) {}
      class Reuse extends Schema.TaggedClass<Reuse>("OwnedBranchReuse")("Reuse", {}) {}
      let captured: unknown
      const machine = Machine.make({
        states: { Stable },
        events: Machine.events(Capture, Reuse),
        initial: (to) => to.Stable().resolve(({ target }) => target(new Stable({})))
      }).handle({
        Stable: {
          on: {
            Capture: (to) =>
              to.branches({ unchanged: { target: to.none } }).resolve(({ select }) => {
                captured = select.unchanged()
                return captured as any
              }),
            Reuse: (to) => to.branches({ unchanged: { target: to.none } }).resolve(() => captured as any)
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
  }) {}

  class NonEmptyIdle extends Schema.TaggedClass<NonEmptyIdle>("NonEmptyIdle")("NonEmptyIdle", {
    userId: Schema.NonEmptyString
  }) {}

  class Loading extends Schema.TaggedClass<Loading>("Loading")("Loading", {
    requestId: Schema.String
  }) {}

  class NonEmptyLoading extends Schema.TaggedClass<NonEmptyLoading>("NonEmptyLoading")("NonEmptyLoading", {
    requestId: Schema.NonEmptyString
  }) {}

  class DefaultedIdle extends Schema.TaggedClass<DefaultedIdle>("DefaultedIdle")("DefaultedIdle", {
    id: Schema.String,
    label: Schema.String.pipe(
      Schema.optionalKey,
      Schema.withConstructorDefault(Effect.succeed("default-label"))
    )
  }) {}

  class Success extends Schema.TaggedClass<Success>("Success")("Success", {
    requestId: Schema.String
  }) {}

  class NonEmptyDone extends Schema.TaggedClass<NonEmptyDone>("NonEmptyDone")("NonEmptyDone", {
    requestId: Schema.NonEmptyString
  }) {}

  class Failed extends Schema.TaggedClass<Failed>("Failed")("Failed", {
    message: Schema.String
  }) {}

  class Duplicate extends Schema.TaggedClass<Duplicate>("Duplicate")("Duplicate", {
    value: Schema.String
  }) {}

  class EncodedCount extends Schema.TaggedClass<EncodedCount>("EncodedCount")("EncodedCount", {
    count: Schema.NumberFromString
  }) {}

  class Payment extends Schema.TaggedClass<Payment>("Payment")("Payment", {
    id: Schema.String
  }) {}

  class EnteringPayment extends Schema.TaggedClass<EnteringPayment>("EnteringPayment")("EnteringPayment", {
    amount: Schema.Number
  }) {}

  class AuthorizedPayment extends Schema.TaggedClass<AuthorizedPayment>("AuthorizedPayment")("AuthorizedPayment", {
    code: Schema.String
  }) {}

  class Fulfillment extends Schema.TaggedClass<Fulfillment>("Fulfillment")("Fulfillment", {
    id: Schema.String
  }) {}

  class Inventory extends Schema.TaggedClass<Inventory>("Inventory")("Inventory", {
    warehouse: Schema.String
  }) {}

  class CheckingInventory extends Schema.TaggedClass<CheckingInventory>("CheckingInventory")("CheckingInventory", {
    sku: Schema.String
  }) {}

  class InventoryReserved extends Schema.TaggedClass<InventoryReserved>("InventoryReserved")("InventoryReserved", {
    reservationId: Schema.String
  }) {}

  class Shipping extends Schema.TaggedClass<Shipping>("Shipping")("Shipping", {
    address: Schema.String
  }) {}

  class QuotingShipping extends Schema.TaggedClass<QuotingShipping>("QuotingShipping")("QuotingShipping", {
    postalCode: Schema.String
  }) {}

  class ShippingQuoted extends Schema.TaggedClass<ShippingQuoted>("ShippingQuoted")("ShippingQuoted", {
    quoteId: Schema.String
  }) {}

  class Submit extends Schema.TaggedClass<Submit>("Submit")("Submit", {
    value: Schema.String
  }) {}

  class NonEmptySubmit extends Schema.TaggedClass<NonEmptySubmit>("NonEmptySubmit")("NonEmptySubmit", {
    value: Schema.NonEmptyString
  }) {}

  class RequestSucceeded extends Schema.TaggedClass<RequestSucceeded>("RequestSucceeded")("RequestSucceeded", {
    value: Schema.String
  }) {}

  class ParallelRoot extends Schema.TaggedClass<ParallelRoot>("ParallelRoot")("ParallelRoot", {
    id: Schema.String
  }) {}

  class ParallelLeftDone extends Schema.TaggedClass<ParallelLeftDone>("ParallelLeftDone")("ParallelLeftDone", {
    id: Schema.String
  }) {}

  class ParallelRightDone extends Schema.TaggedClass<ParallelRightDone>("ParallelRightDone")("ParallelRightDone", {
    id: Schema.String
  }) {}

  class RequestProgress extends Schema.TaggedClass<RequestProgress>("RequestProgress")("RequestProgress", {
    id: Schema.String,
    childState: Schema.String
  }) {}

  class RequestFailed extends Schema.TaggedClass<RequestFailed>("RequestFailed")("RequestFailed", {
    error: Schema.Any,
    cause: Schema.Any
  }) {}

  class Reset extends Schema.TaggedClass<Reset>("Reset")("Reset", {}) {}
  class Resolve extends Schema.TaggedClass<Resolve>("Resolve")("Resolve", {}) {}
  class Authorize extends Schema.TaggedClass<Authorize>("Authorize")("Authorize", {
    code: Schema.String
  }) {}
  class ReserveInventory extends Schema.TaggedClass<ReserveInventory>("ReserveInventory")("ReserveInventory", {
    reservationId: Schema.String
  }) {}
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
      const states = Machine.states({ Idle })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      })

      const planned = yield* Machine.planInitial(machine, { userId: "user-1" })

      assert.strictEqual(Machine.isMachine(machine), true)
      assert.deepStrictEqual(planned.state.value, new Idle({ userId: "user-1" }))
    }))

  it("isMachine requires the machine brand value, not only its property key", () => {
    const states = Machine.states({ Idle })
    const machine = Machine.make({
      states: states.states,
      events: Machine.events(),
      initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
    })

    assert.strictEqual(Machine.isMachine(machine), true)
    assert.strictEqual(Machine.isMachine({ [Machine.TypeId]: "not-a-machine" }), false)
  })

  it.effect("constructs a sibling target by destructuring the source value", () =>
    Effect.gen(function*() {
      class Convert extends Schema.TaggedClass<Convert>("Convert")("Convert", {}) {}
      const states = Machine.states({ Submit, RequestSucceeded })
      const definition = Machine.make({
        states: states.states,
        events: Machine.events(Convert),
        initial: (to) => to.Submit().resolve(({ target }) => target(new Submit({ value: "loaded" })))
      })
      const machine = definition.handle({
        Submit: {
          on: {
            Convert: (to) =>
              to.full.RequestSucceeded().resolve(({ state, target }) => {
                const { _tag: _, ...fields } = state
                return target.from(fields)
              })
          }
        }
      })

      const plan = yield* Machine.plan(
        machine,
        { path: "Submit" as const, value: new Submit({ value: "loaded" }) },
        new Convert({})
      )
      assert.instanceOf(plan.next.value, RequestSucceeded)
      assert.deepStrictEqual(plan.next.value, new RequestSucceeded({ value: "loaded" }))
    }))

  it("make stores the machine id", () => {
    const states = Machine.states({ Idle, Loading })
    const machine = Machine.make({
      id: "UserMachine",
      states: states.states,
      events: Machine.events(Submit),
      input: Input,
      initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
    }).handle({
      Idle: {
        on: {
          Submit: (to) =>
            to.full.Loading().resolve(({ target }) => {
              return target(new Loading({ requestId: "request-1" }))
            })
        }
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
      const defined = Machine.states(states)
      const machine = Machine.make({
        states: defined.states,
        events: Machine.events(Submit),
        initial: (to) => to.idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
      })

      const planned = yield* Machine.planInitial(machine)

      assert.notStrictEqual(defined.states, states)
      assert.deepStrictEqual(defined.states, states)
      assert.isTrue(Object.isFrozen(defined.states))
      assert.strictEqual(planned.state.path, "idle")
      assert.deepStrictEqual(planned.state.value, new Idle({ userId: "user-1" }))
    }))

  it("states selects active compound and parallel state paths", () => {
    const states = Machine.states({
      fulfillment: {
        schema: Fulfillment,
        type: "parallel",
        states: {
          inventory: {
            schema: Inventory,
            initial: "checking",
            states: {
              checking: CheckingInventory,
              reserved: InventoryReserved
            }
          },
          shipping: {
            schema: Shipping,
            initial: "quoting",
            states: {
              quoting: QuotingShipping,
              quoted: ShippingQuoted
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

    const inventorySnapshot = Option.getOrThrow(
      states.getSnapshot(fulfillmentSnapshot, "fulfillment.inventory")
    )
    assert.deepStrictEqual(states.get(inventorySnapshot, "fulfillment.inventory"), Option.some(inventory))
    assert.deepStrictEqual(
      states.get(inventorySnapshot, "fulfillment.inventory.checking"),
      Option.some(checking)
    )
  })

  it.effect("initial builder constructs compound initial snapshots", () =>
    Effect.gen(function*() {
      const states = Machine.states({
        payment: {
          schema: Payment,
          initial: "entering",
          states: {
            entering: EnteringPayment,
            authorized: AuthorizedPayment
          }
        }
      })
      const payment = new Payment({ id: "payment-1" })
      const entering = new EnteringPayment({ amount: 100 })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Authorize),
        initial: (to) =>
          to.payment.initial.resolve(({ target }) =>
            target(
              payment,
              (payment) => payment.entering(entering)
            )
          )
      })

      const planned = yield* Machine.planInitial(machine)

      assertCompoundStateSnapshot(planned.state, "payment", payment, {
        path: "payment.entering" as const,
        value: entering
      })
    }))

  it.effect("initial builder constructs parallel initial snapshots", () =>
    Effect.gen(function*() {
      const states = Machine.states({
        fulfillment: {
          schema: Fulfillment,
          type: "parallel",
          states: {
            inventory: {
              schema: Inventory,
              initial: "checking",
              states: {
                checking: CheckingInventory,
                reserved: InventoryReserved
              }
            },
            shipping: {
              schema: Shipping,
              initial: "quoting",
              states: {
                quoting: QuotingShipping,
                quoted: ShippingQuoted
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
        states: states.states,
        events: Machine.events(ReserveInventory),
        initial: (to) =>
          to.fulfillment.initial.resolve(({ target }) =>
            target(
              fulfillment,
              (fulfillment) =>
                fulfillment
                  .inventory(
                    inventory,
                    (inventory) => inventory.checking(checking)
                  )
                  .shipping(
                    shipping,
                    (shipping) => shipping.quoting(quoting)
                  )
            )
          )
      })

      const planned = yield* Machine.planInitial(machine)

      assertParallelStateSnapshot(planned.state, "fulfillment", fulfillment, {
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
          label: Schema.String.pipe(
            Schema.optionalKey,
            Schema.withConstructorDefault(Effect.succeed("default-label"))
          )
        }) {}
        const InternalEvent = Schema.TaggedUnion({
          Loaded: { value: Schema.String },
          TimedOut: {}
        })
        const State = Schema.TaggedStruct("DeferredEventState", { value: Schema.String })
        const states = Machine.states({ Active: State })
        const events = Machine.events(PublicEvent, Defaulted, FiniteEvent)
        const internalEvents = Machine.internalEvents(InternalEvent)
        const definition = Machine.make({
          states: states.states,
          events,
          internalEvents,
          initial: (to) => to.Active().resolve(({ target }) => target.from({ value: "initial" }))
        })
        const machine = definition.handle({
          Active: {
            on: {
              SetValue: (to) => to.full.Active().resolve(({ event, target }) => target.from({ value: event.value })),
              Reset: (to) =>
                to.none.resolve((_, enqueue) => {
                  enqueue.raise(internalEvents.Loaded({ value: "loaded" }))
                  return undefined
                }),
              Defaulted: (to) =>
                to.full.Active().resolve(({ event, target }) => target.from({ value: event.label ?? "default-label" })),
              Loaded: (to) => to.full.Active().resolve(({ event, target }) => target.from({ value: event.value })),
              TimedOut: (to) => to.full.Active().resolve(({ target }) => target.from({ value: "timed-out" })),
              Alpha: (to) => to.full.Active().resolve(({ event, target }) => target.from({ value: event.value })),
              Beta: (to) => to.full.Active().resolve(({ event, target }) => target.from({ value: event.value }))
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
        assert.deepStrictEqual(set.next, {
          path: "Active" as const,
          value: { _tag: "DeferredEventState", value: "next" }
        })

        const defaulted = yield* Machine.plan(machine, set.next, events.Defaulted({ id: "event-1" }))
        assert.deepStrictEqual(defaulted.next, {
          path: "Active" as const,
          value: { _tag: "DeferredEventState", value: "default-label" }
        })

        const loaded = yield* Machine.plan(machine, defaulted.next, events.Reset())
        assert.deepStrictEqual(loaded.next, {
          path: "Active" as const,
          value: { _tag: "DeferredEventState", value: "loaded" }
        })

        const alpha = yield* Machine.plan(machine, loaded.next, events.Alpha({ value: "alpha" }))
        assert.deepStrictEqual(alpha.next, {
          path: "Active" as const,
          value: { _tag: "DeferredEventState", value: "alpha" }
        })
      }))

    it.effect("reports deferred constructor failures through the running machine", () =>
      Effect.gen(function*() {
        const Event = Schema.TaggedUnion({
          Submit: { value: Schema.NonEmptyString }
        })
        const states = Machine.states({ Idle: {} })
        const definition = Machine.make({
          id: "deferred-event-failure",
          states: states.states,
          events: Machine.events(Event),
          initial: (to) => to.Idle().resolve(({ target }) => target.from())
        })
        const events = definition.events
        const machine = definition.handle({
          Idle: {
            on: {
              Submit: (to) => to.none
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
        const snapshot = yield* sendAndWaitForSnapshot(
          actor,
          construction!,
          (snapshot) => snapshot.status === "error"
        )
        const error = yield* Effect.flip(actor.join)

        assertMachineSchemaDecodeError(error, "event", { event: "Submit" })
        assert.strictEqual(snapshot.status, "error")
      }))

    it.effect("plans inline Effect and timer outcomes", () =>
      Effect.gen(function*() {
        const release = yield* Deferred.make<void>()
        const InternalEvent = Schema.TaggedUnion({ Loaded: {}, TimedOut: {} })
        const states = Machine.states({ Loading: {}, Waiting: {}, Done: {} })
        const definition = Machine.make({
          states: states.states,
          events: Machine.events(),
          internalEvents: Machine.internalEvents(InternalEvent),
          initial: (to) => to.Loading().resolve(({ target }) => target.from())
        })
        const machine = definition.handle({
          Loading: {
            invoke: (from) =>
              from.effect("load", () => Deferred.await(release)).onDone((to) =>
                to.full.Waiting().resolve(({ target }) => target.from())
              )
          },
          Waiting: {
            invoke: (from) =>
              from.timer("timeout", "1 second").onDone((to) => to.full.Done().resolve(({ target }) => target.from()))
          },
          Done: {}
        })

        const actor = yield* Machine.start(machine)
        const waiting = yield* waitForSnapshot(
          actor,
          (snapshot) => snapshot.status === "active" && snapshot.state.path === "Waiting"
        ).pipe(Effect.forkChild)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(waiting)

        const done = yield* waitForSnapshot(
          actor,
          (snapshot) => snapshot.status === "active" && snapshot.state.path === "Done"
        ).pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(done)
        yield* actor.stop
      }))

    it.effect("rejects a construction owned by another machine protocol", () =>
      Effect.gen(function*() {
        const FirstEvent = Schema.TaggedUnion({ Submit: { value: Schema.String } })
        const SecondEvent = Schema.TaggedUnion({ Submit: { value: Schema.String } })
        const states = Machine.states({ Idle: {} })
        const first = Machine.make({
          states: states.states,
          events: Machine.events(FirstEvent),
          initial: (to) => to.Idle().resolve(({ target }) => target.from())
        })
        const second = Machine.make({
          states: states.states,
          events: Machine.events(SecondEvent),
          initial: (to) => to.Idle().resolve(({ target }) => target.from())
        }).handle({
          Idle: {
            on: {
              Submit: (to) => to.none
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
        const states = Machine.states({ idle: DefaultedIdle })
        const machine = Machine.make({
          id: "from-default",
          states: states.states,
          events: Machine.events(),
          initial: (to) => to.idle().resolve(({ target }) => target.from({ id: "idle-1" }))
        })

        const planned = yield* Machine.planInitial(machine)

        assert.instanceOf(planned.state.value, DefaultedIdle)
        assert.deepStrictEqual(planned.state.value, new DefaultedIdle({ id: "idle-1", label: "default-label" }))
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
        const states = Machine.states({
          Idle: State.cases.Idle,
          Done: {
            schema: State.cases.Done,
            type: "final"
          }
        })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(Event),
          initial: (to) => to.Idle().resolve(({ target }) => target.from())
        }).handle({
          Idle: {
            on: {
              Submit: (to) => to.full.Done().resolve(({ event, target }) => target.from({ requestId: event.requestId }))
            }
          },
          Done: {}
        })
        const initial = yield* Machine.planInitial(machine)

        const planned = yield* Machine.plan(
          machine,
          initial.state,
          Event.cases.Submit.make({ requestId: "request-1" })
        )

        assert.deepStrictEqual(initial.state.value, State.cases.Idle.make({}))
        assert.deepStrictEqual(planned.next.value, State.cases.Done.make({ requestId: "request-1" }))
        assert.isTrue(planned.done)
      }))

    it.effect("constructs default-only TaggedClass state without an input argument", () =>
      Effect.gen(function*() {
        class DefaultOnly extends Schema.TaggedClass<DefaultOnly>("DefaultOnly")("DefaultOnly", {
          label: Schema.String.pipe(
            Schema.optionalKey,
            Schema.withConstructorDefault(Effect.succeed("default-label"))
          )
        }) {}
        const states = Machine.states({ DefaultOnly })
        const machine = Machine.make({
          id: "from-default-only",
          states: states.states,
          events: Machine.events(),
          initial: (to) => to.DefaultOnly().resolve(({ target }) => target.from())
        })

        const planned = yield* Machine.planInitial(machine)

        assert.instanceOf(planned.state.value, DefaultOnly)
        assert.strictEqual(planned.state.value.label, "default-label")
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
        const states = Machine.states({
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
          }
        })
        const machine = Machine.make({
          id: "from-empty-targets",
          states: states.states,
          events: Machine.events(
            Event.cases.Local,
            Event.cases.LocalWith,
            Event.cases.Branch,
            Event.cases.Full,
            Event.cases.Finish
          ),
          initial: (to) => to.Flow.initial.resolve(({ target }) => target.from((flow) => flow.Idle.from()))
        }).handle({
          Flow: {
            states: {
              Idle: {
                on: {
                  Local: (to) => to.local.Running().resolve(({ target }) => target.from()),
                  LocalWith: (to) => to.local.Running().resolve(({ target }) => target.from()),
                  Branch: (to) =>
                    to.branch.Flow.Nested().resolve(({ target }) => target.from((nested) => nested.NestedIdle.from())),
                  Full: (to) =>
                    to.full.Flow().resolve(({ target }) =>
                      target.from((flow) => flow.Nested.from((nested) => nested.NestedIdle.from()))
                    ),
                  Finish: (to) => to.local.Done().resolve(({ target }) => target.from())
                }
              },
              Running: {},
              Nested: {
                states: {
                  NestedIdle: {}
                }
              },
              Done: {}
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)

        const local = yield* Machine.plan(machine, initial.state, Event.cases.Local.make({}))
        const localWith = yield* Machine.plan(machine, initial.state, Event.cases.LocalWith.make({}))
        const branch = yield* Machine.plan(machine, initial.state, Event.cases.Branch.make({}))
        const full = yield* Machine.plan(machine, initial.state, Event.cases.Full.make({}))
        const final = yield* Machine.plan(machine, initial.state, Event.cases.Finish.make({}))

        assert.strictEqual((local.next as any).state.path, "Flow.Running")
        assert.strictEqual((localWith.next as any).state.path, "Flow.Running")
        assert.strictEqual((branch.next as any).state.state.path, "Flow.Nested.NestedIdle")
        assert.strictEqual((full.next as any).state.state.path, "Flow.Nested.NestedIdle")
        assert.strictEqual((final.next as any).state.path, "Flow.Done")
        assert.deepStrictEqual((initial.state as any).value, State.cases.Flow.make({}))
        assert.deepStrictEqual((local.next as any).state.value, State.cases.Running.make({}))
        assert.deepStrictEqual((branch.next as any).state.value, State.cases.Nested.make({}))
        assert.deepStrictEqual((final.next as any).state.value, State.cases.Done.make({}))
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
        const states = Machine.states({
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
        const machine = Machine.make({
          id: "from-empty-parallel",
          states: states.states,
          events: Machine.events(),
          initial: (to) =>
            to.Parallel.initial.resolve(({ target }) =>
              target.from((parallel) =>
                parallel
                  .left.from((left) => left.LeftIdle.from())
                  .right.from((right) => right.RightIdle.from())
              )
            )
        })

        const planned = yield* Machine.planInitial(machine)

        assert.strictEqual((planned.state as any).states.left.state.path, "Parallel.left.LeftIdle")
        assert.strictEqual((planned.state as any).states.right.state.path, "Parallel.right.RightIdle")
        assert.deepStrictEqual((planned.state as any).value, State.cases.Parallel.make({}))
        assert.deepStrictEqual((planned.state as any).states.left.value, State.cases.Left.make({}))
        assert.deepStrictEqual((planned.state as any).states.right.value, State.cases.Right.make({}))
      }))

    it.effect("fails an omitted empty input refinement through MachineSchemaDecodeError", () =>
      Effect.gen(function*() {
        const State = Schema.TaggedUnion({ Blocked: {} })
        const Blocked = State.cases.Blocked.check(
          Schema.makeFilter(() => "blocked state cannot be entered")
        )
        const states = Machine.states({ Blocked })
        const machine = Machine.make({
          id: "from-empty-refinement",
          states: states.states,
          events: Machine.events(),
          initial: (to) => to.Blocked().resolve(({ target }) => target.from())
        })

        const error = yield* Effect.flip(Machine.planInitial(machine))

        assertMachineSchemaDecodeError(error, "state", { state: "Blocked" })
        assert.strictEqual((error as Machine.MachineSchemaDecodeError).machineId, "from-empty-refinement")
      }))

    it.effect("fails invalid refinement input through MachineSchemaDecodeError without throwing in the builder", () =>
      Effect.gen(function*() {
        const states = Machine.states({ NonEmptyIdle })
        const machine = Machine.make({
          id: "from-refinement",
          states: states.states,
          events: Machine.events(),
          initial: (to) => to.NonEmptyIdle().resolve(({ target }) => target.from({ userId: "" }))
        })

        const error = yield* Effect.flip(Machine.planInitial(machine))

        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyIdle" })
        assert.strictEqual((error as Machine.MachineSchemaDecodeError).machineId, "from-refinement")
      }))

    it.effect("fails invalid transition construction in the typed machine error channel", () =>
      Effect.gen(function*() {
        const states = Machine.states({ NonEmptyIdle, NonEmptyLoading })
        const machine = Machine.make({
          id: "from-transition-refinement",
          states: states.states,
          events: Machine.events(NonEmptySubmit),
          initial: (to) => to.NonEmptyIdle().resolve(({ target }) => target.from({ userId: "user-1" }))
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: (to) => to.full.NonEmptyLoading().resolve(({ target }) => target.from({ requestId: "" }))
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)

        const error = yield* Effect.flip(
          Machine.plan(
            machine,
            initial.state,
            new NonEmptySubmit({ value: "request-1" })
          )
        )

        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyLoading" })
        assert.strictEqual((error as Machine.MachineSchemaDecodeError).machineId, "from-transition-refinement")
      }))

    it.effect("constructs complete compound and parallel targets from schema input", () =>
      Effect.gen(function*() {
        const states = Machine.states({
          idle: Idle,
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                initial: "checking",
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                initial: "quoting",
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(Submit),
          initial: (to) => to.idle().resolve(({ target }) => target.from({ userId: "user-1" }))
        }).handle({
          idle: {
            on: {
              Submit: (to) =>
                to.full.fulfillment().resolve(({ event, target }) =>
                  target.from(
                    { id: event.value },
                    (fulfillment) =>
                      fulfillment
                        .inventory.from(
                          { warehouse: "warehouse-1" },
                          (inventory) => inventory.reserved.from({ reservationId: event.value })
                        )
                        .shipping.from(
                          { address: "Main Street" },
                          (shipping) => shipping.quoted.from({ quoteId: event.value })
                        )
                  )
                )
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
        const states = Machine.states({
          payment: {
            schema: Payment,
            initial: "entering",
            states: {
              entering: EnteringPayment,
              authorized: AuthorizedPayment
            }
          }
        })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(Submit),
          initial: (to) =>
            to.payment.initial.resolve(({ target }) =>
              target.from(
                { id: "payment-1" },
                (payment) => payment.entering.from({ amount: 1 })
              )
            )
        }).handle({
          payment: {
            states: {
              entering: {
                on: {
                  Submit: (to) =>
                    to.branch.payment().resolve(({ event, target }) =>
                      target.from(
                        { id: "payment-2" },
                        (payment) => payment.authorized.from({ code: event.value })
                      )
                    )
                }
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
        const states = Machine.states({
          workflow: {
            schema: Payment,
            initial: "idle",
            states: {
              idle: Idle,
              checkout: {
                schema: Fulfillment,
                initial: "quoted",
                states: {
                  quoted: ShippingQuoted
                }
              }
            }
          }
        })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(Submit),
          initial: (to) =>
            to.workflow.initial.resolve(({ target }) =>
              target.from(
                { id: "workflow-1" },
                (workflow) => workflow.idle.from({ userId: "user-1" })
              )
            )
        }).handle({
          workflow: {
            states: {
              idle: {
                on: {
                  Submit: (to) =>
                    to.branch.workflow().resolve(({ event, target }) =>
                      target.from(
                        { id: "workflow-2" },
                        (workflow) =>
                          workflow.checkout.from(
                            { id: "checkout-1" },
                            (checkout) => checkout.quoted.from({ quoteId: event.value })
                          )
                      )
                    )
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
        const states = Machine.states({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(NonEmptySubmit),
          input: NonEmptyInput,
          initial: (to) =>
            to.NonEmptyIdle().resolve(({ input: input, target }) => target(new NonEmptyIdle({ userId: input.userId })))
        })

        const error = yield* Effect.flip(Machine.planInitial(machine, { userId: "" as any }))

        assertMachineSchemaDecodeError(error, "input")
      }))

    it.effect("decodes initial state snapshots before accepting them", () =>
      Effect.gen(function*() {
        const states = Machine.states({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(NonEmptySubmit),
          initial: (to) =>
            to.NonEmptyIdle().resolve(({ target }) => target(unsafeTagged({ _tag: "NonEmptyIdle", userId: "" })))
        })

        const error = yield* Effect.flip(Machine.planInitial(machine))

        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyIdle" })
      }))

    it.effect("decodes incoming events before handler selection", () =>
      Effect.gen(function*() {
        const states = Machine.states({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(NonEmptySubmit),
          initial: (to) => to.NonEmptyIdle().resolve(({ target }) => target(new NonEmptyIdle({ userId: "user-1" })))
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: (to) => to.full.NonEmptyIdle().resolve(({ state, target }) => target(state))
            }
          }
        })

        const error = yield* Effect.flip(
          Machine.plan(
            machine,
            { path: "NonEmptyIdle" as const, value: new NonEmptyIdle({ userId: "user-1" }) },
            unsafeTagged({ _tag: "NonEmptySubmit", value: "" })
          )
        )

        assertMachineSchemaDecodeError(error, "event", { event: "NonEmptySubmit" })
      }))

    it.effect("surfaces sent event decode failures through the machine lifecycle", () =>
      Effect.gen(function*() {
        const states = Machine.states({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(NonEmptySubmit),
          initial: (to) => to.NonEmptyIdle().resolve(({ target }) => target(new NonEmptyIdle({ userId: "user-1" })))
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: (to) => to.full.NonEmptyIdle().resolve(({ state, target }) => target(state))
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
        const states = Machine.states({ NonEmptyIdle, NonEmptyLoading })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(NonEmptySubmit),
          initial: (to) => to.NonEmptyIdle().resolve(({ target }) => target(new NonEmptyIdle({ userId: "user-1" })))
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: (to) =>
                to.full.NonEmptyLoading().resolve(({ target }) =>
                  target(unsafeTagged({ _tag: "NonEmptyLoading", requestId: "" }))
                )
            }
          }
        })

        const error = yield* Effect.flip(
          Machine.plan(
            machine,
            { path: "NonEmptyIdle" as const, value: new NonEmptyIdle({ userId: "user-1" }) },
            new NonEmptySubmit({ value: "request-1" })
          )
        )

        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyLoading" })
      }))

    it.effect("decodes same-state atomic snapshot targets in the compiled runtime", () =>
      Effect.gen(function*() {
        const states = Machine.states({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(NonEmptySubmit),
          initial: (to) => to.NonEmptyIdle().resolve(({ target }) => target(new NonEmptyIdle({ userId: "user-1" })))
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: (to) =>
                to.full.NonEmptyIdle().resolve(({ target }) =>
                  target(unsafeTagged({ _tag: "NonEmptyIdle", userId: "" }))
                )
            }
          }
        })
        const actor = yield* Machine.start(machine)

        const snapshot = yield* sendAndWaitForSnapshot(
          actor,
          new NonEmptySubmit({ value: "request-1" }),
          (snapshot) => snapshot.status === "error"
        )
        const error = yield* Effect.flip(actor.join)

        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyIdle" })
        assert.strictEqual(snapshot.status, "error")
      }))

    it.effect("decodes final state output before caching it", () =>
      Effect.gen(function*() {
        const states = Machine.states({
          NonEmptyIdle,
          done: {
            schema: NonEmptyDone,
            type: "final",
            output: Schema.NonEmptyString
          }
        })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(NonEmptySubmit),
          initial: (to) => to.NonEmptyIdle().resolve(({ target }) => target(new NonEmptyIdle({ userId: "user-1" })))
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: (to) =>
                to.full.done().resolve(({ event, target }) => target(new NonEmptyDone({ requestId: event.value })))
            }
          },
          done: {
            output: () => "" as any
          }
        })

        const error = yield* Effect.flip(
          Machine.plan(
            machine,
            { path: "NonEmptyIdle" as const, value: new NonEmptyIdle({ userId: "user-1" }) },
            new NonEmptySubmit({ value: "request-1" })
          )
        )

        assertMachineSchemaDecodeError(error, "output", { state: "done" })
      }))

    it.effect("decodes parallel state output before caching it", () =>
      Effect.gen(function*() {
        const states = Machine.states({
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
        })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(),
          initial: (to) =>
            to.all.initial.resolve(({ target }) =>
              target(
                new ParallelRoot({ id: "all" }),
                (all) =>
                  all
                    .left(new ParallelLeftDone({ id: "left" }))
                    .right(new ParallelRightDone({ id: "right" }))
              )
            )
        }).handle({
          all: {
            output: () => ({ summary: "" as any })
          }
        })

        const error = yield* Effect.flip(Machine.planInitial(machine))

        assertMachineSchemaDecodeError(error, "output", { state: "all" })
      }))

    it.effect("reports malformed snapshots as configuration boundary errors", () =>
      Effect.gen(function*() {
        const states = Machine.states({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(NonEmptySubmit),
          initial: (to) => to.NonEmptyIdle().resolve(({ target }) => target(new NonEmptyIdle({ userId: "user-1" })))
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
        const states = Machine.states({ count: EncodedCount })
        const machine = Machine.make({
          id: "Counter",
          states: states.states,
          events: Machine.events(),
          initial: (to) => to.count().resolve(({ target }) => target(new EncodedCount({ count: 1 })))
        })
        const planned = yield* Machine.planInitial(machine)

        const encoded = yield* Machine.encodeSnapshot(machine, planned.state)
        const decoded = yield* Machine.decodeSnapshot(machine, JSON.parse(JSON.stringify(encoded)))

        assert.deepStrictEqual(encoded, {
          _tag: "MachineSnapshot",
          active: [{
            path: "count" as const,
            value: { _tag: "EncodedCount", count: "1" }
          }]
        })
        assert.deepStrictEqual(decoded, planned.state)
        assert.instanceOf(decoded.value, EncodedCount)
      }))

    it.effect("round-trips compound and parallel configurations", () =>
      Effect.gen(function*() {
        const states = Machine.states({
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                initial: "checking",
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                initial: "quoting",
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(),
          initial: (to) =>
            to.fulfillment.initial.resolve(({ target }) =>
              target(
                new Fulfillment({ id: "fulfillment-1" }),
                (fulfillment) =>
                  fulfillment
                    .inventory(
                      new Inventory({ warehouse: "warehouse-1" }),
                      (inventory) => inventory.checking(new CheckingInventory({ sku: "sku-1" }))
                    )
                    .shipping(
                      new Shipping({ address: "Main Street" }),
                      (shipping) => shipping.quoting(new QuotingShipping({ postalCode: "12345" }))
                    )
              )
            )
        })
        const planned = yield* Machine.planInitial(machine)

        const encoded = yield* Machine.encodeSnapshot(machine, planned.state)
        const decoded = yield* Machine.decodeSnapshot(machine, encoded)

        assert.deepStrictEqual(encoded.active.map(({ path }) => path), [
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
        const states = Machine.states({
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
        })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(),
          initial: (to) =>
            to.all.initial.resolve(({ target }) =>
              target(
                new ParallelRoot({ id: "all" }),
                (all) =>
                  all
                    .left(new ParallelLeftDone({ id: "left" }))
                    .right(new ParallelRightDone({ id: "right" }))
              )
            )
        }).handle({
          all: {
            states: {
              left: {
                output: () => 1
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
        const states = Machine.states({
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
        })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(),
          initial: (to) =>
            to.all.initial.resolve(({ target }) =>
              target(
                new ParallelRoot({ id: "all" }),
                (all) =>
                  all
                    .left(new ParallelLeftDone({ id: "left" }))
                    .right(new ParallelRightDone({ id: "right" }))
              )
            )
        }).handle({
          all: {
            states: {
              left: {}
            }
          }
        })
        const planned = yield* Machine.planInitial(machine)

        const encoded = yield* Machine.encodeSnapshot(machine, planned.state)
        const decoded = yield* Machine.decodeSnapshot(machine, JSON.parse(JSON.stringify(encoded)))

        assert.deepStrictEqual(encoded.completed, [{ path: "all.left" as const }])
        assert.deepStrictEqual(decoded.completed, [{ path: "all.left" as const, output: undefined }])
      }))

    it.effect("rejects state values that cannot be encoded", () =>
      Effect.gen(function*() {
        const states = Machine.states({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(),
          initial: (to) => to.NonEmptyIdle().resolve(({ target }) => target(new NonEmptyIdle({ userId: "user-1" })))
        })

        const error = yield* Machine.encodeSnapshot(machine, {
          path: "NonEmptyIdle" as const,
          value: unsafeTagged({ _tag: "NonEmptyIdle", userId: "" })
        }).pipe(Effect.flip)

        assertMachineSchemaEncodeError(error, "state", { state: "NonEmptyIdle" })
      }))

    it.effect("rejects invalid completion metadata during encoding", () =>
      Effect.gen(function*() {
        const states = Machine.states({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(),
          initial: (to) => to.NonEmptyIdle().resolve(({ target }) => target(new NonEmptyIdle({ userId: "user-1" })))
        })

        const error = yield* Machine.encodeSnapshot(machine, {
          ...{ path: "NonEmptyIdle" as const, value: new NonEmptyIdle({ userId: "user-1" }) },
          completed: [{ path: "missing" as const, output: undefined }]
        }).pipe(Effect.flip)

        assert.instanceOf(error, Machine.MachineSchemaEncodeError)
        assert.strictEqual(error.boundary, "configuration")
      }))

    it.effect("rejects encoded values that do not match their state schema", () =>
      Effect.gen(function*() {
        const states = Machine.states({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(),
          initial: (to) => to.NonEmptyIdle().resolve(({ target }) => target(new NonEmptyIdle({ userId: "user-1" })))
        })

        const error = yield* Machine.decodeSnapshot(machine, {
          _tag: "MachineSnapshot",
          active: [{
            path: "NonEmptyIdle" as const,
            value: { _tag: "NonEmptyIdle", userId: "" }
          }]
        }).pipe(Effect.flip)

        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyIdle" })
      }))

    it.effect("rejects encoded configurations with invalid state relationships", () =>
      Effect.gen(function*() {
        const states = Machine.states({
          payment: {
            schema: Payment,
            initial: "entering",
            states: {
              entering: EnteringPayment,
              authorized: AuthorizedPayment
            }
          }
        })
        const machine = Machine.make({
          states: states.states,
          events: Machine.events(),
          initial: (to) =>
            to.payment.initial.resolve(({ target }) =>
              target(
                new Payment({ id: "payment-1" }),
                (payment) => payment.entering(new EnteringPayment({ amount: 1 }))
              )
            )
        })

        const error = yield* Machine.decodeSnapshot(machine, {
          _tag: "MachineSnapshot",
          active: [{
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
      const machine = Machine.make({
        states: {
          idle: Idle,
          loading: Loading
        },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        idle: {
          on: {
            Submit: (to) =>
              to.full.loading().resolve(({ event, state, target }) =>
                target(new Loading({ requestId: `${state.userId}:${event.value}` }))
              )
          }
        }
      })

      const planned = yield* Machine.plan(
        machine,
        LowercaseInitial.idle(new Idle({ userId: "user-1" })),
        new Submit({ value: "request-1" })
      )

      assert.deepStrictEqual(planned.next.value, new Loading({ requestId: "user-1:request-1" }))
      assert.strictEqual(planned.next.path, "loading")
      assert.deepStrictEqual(Machine.enabled(machine, LowercaseInitial.idle(new Idle({ userId: "user-1" }))), [
        "Submit"
      ])
    }))

  it.effect("uses path identity for duplicate decoded state tags", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: {
          a: Duplicate,
          b: Duplicate
        },
        events: Machine.events(Submit, Reset),
        initial: (to) => to.a().resolve(({ target }) => target(new Duplicate({ value: "a" })))
      }).handle({
        a: {
          on: {
            Submit: (to) => to.full.b().resolve(({ event, target }) => target(new Duplicate({ value: event.value })))
          }
        },
        b: {
          on: {
            Reset: (to) => to.full.a().resolve(({ target }) => target(new Duplicate({ value: "reset" })))
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      assertStateSnapshot(initial.state, "a", new Duplicate({ value: "a" }))
      assert.deepStrictEqual(Machine.enabled(machine, initial.state), ["Submit"])
      assert.deepStrictEqual(
        Machine.enabled(machine, {
          path: "b" as const,
          value: new Duplicate({ value: "b" })
        }),
        ["Reset"]
      )

      const submitted = yield* Machine.plan(machine, initial.state, new Submit({ value: "b" }))
      assertStateSnapshot(submitted.next, "b", new Duplicate({ value: "b" }))

      const reset = yield* Machine.plan(machine, submitted.next, new Reset({}))
      assertStateSnapshot(reset.next, "a", new Duplicate({ value: "reset" }))
    }))

  it.effect("exposes path identity through machine snapshots", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: {
          a: Duplicate,
          b: Duplicate
        },
        events: Machine.events(Submit),
        initial: (to) => to.a().resolve(({ target }) => target(new Duplicate({ value: "a" })))
      }).handle({
        a: {
          on: {
            Submit: (to) => to.full.b().resolve(({ event, target }) => target(new Duplicate({ value: event.value })))
          }
        }
      })

      const actor = yield* Machine.start(machine)
      assertStateSnapshot(yield* actor.state, "a", new Duplicate({ value: "a" }))

      const snapshot = yield* sendAndWaitForSnapshot(
        actor,
        new Submit({ value: "b" }),
        (snapshot) => snapshot.status === "active" && snapshot.state.path === "b"
      )
      assert.strictEqual(snapshot.status, "active")
      assertStateSnapshot(snapshot.state, "b", new Duplicate({ value: "b" }))
    }))

  it.effect("honors final flat object state node configs", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: {
          idle: Idle,
          success: {
            schema: Success,
            type: "final"
          }
        },
        events: Machine.events(Submit),
        initial: (to) => to.idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
      }).handle({
        idle: {
          on: {
            Submit: (to) =>
              to.full.success().resolve(({ event, target }) => target(new Success({ requestId: event.value })))
          }
        }
      })

      const planned = yield* Machine.plan(
        machine,
        LowercaseInitial.idle(new Idle({ userId: "user-1" })),
        new Submit({ value: "request-1" })
      )

      assert.deepStrictEqual(planned.next.value, new Success({ requestId: "request-1" }))
      assert.strictEqual(planned.next.path, "success")
      assert.strictEqual(Machine.isFinal(machine, planned.next), true)
      assert.deepStrictEqual(Machine.enabled(machine, planned.next), [])
    }))

  it.effect("selects child handlers before ancestor handlers", () =>
    Effect.gen(function*() {
      const payment = new Payment({ id: "payment-1" })
      const entering = new EnteringPayment({ amount: 100 })
      const machine = Machine.make({
        states: {
          payment: {
            schema: Payment,
            initial: "entering",
            states: {
              entering: EnteringPayment,
              authorized: AuthorizedPayment
            }
          },
          failed: Failed
        },
        events: Machine.events(Authorize),
        initial: (to) =>
          to.payment.initial.resolve(() => ({
            path: "payment" as const,
            value: payment,
            state: {
              path: "payment.entering" as const,
              value: entering
            }
          }))
      }).handle({
        payment: {
          on: {
            Authorize: (to) => to.full.failed().resolve(({ target }) => target(new Failed({ message: "parent" })))
          },
          states: {
            entering: {
              on: {
                Authorize: (to) =>
                  to.local.authorized().resolve(({ event, containingState, ancestors, target }) => {
                    assert.deepStrictEqual(containingState, payment)
                    assert.deepStrictEqual(ancestors, { payment })
                    return target(new AuthorizedPayment({ code: event.code }))
                  })
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
    }))

  it.effect("lets declinable child handlers yield to ancestors without retaining queued work", () =>
    Effect.gen(function*() {
      class Notice extends Schema.TaggedClass<Notice>("DeclineNotice")("Notice", {}) {}
      const payment = new Payment({ id: "payment-1" })
      const entering = new EnteringPayment({ amount: 100 })
      const machine = Machine.make({
        states: {
          payment: {
            schema: Payment,
            initial: "entering",
            states: {
              entering: EnteringPayment,
              authorized: AuthorizedPayment
            }
          },
          failed: Failed
        },
        events: Machine.events(Authorize),
        emittedEvents: Machine.emittedEvents(Notice),
        initial: (to) =>
          to.payment.initial.resolve(() => ({
            path: "payment" as const,
            value: payment,
            state: {
              path: "payment.entering" as const,
              value: entering
            }
          }))
      }).handle({
        payment: {
          on: {
            Authorize: (to) => to.full.failed().resolve(({ target }) => target(new Failed({ message: "parent" })))
          },
          states: {
            entering: {
              on: {
                Authorize: (to) =>
                  to.branches({
                    authorize: { target: to.local.authorized() },
                    consume: { target: to.none }
                  }).resolve(({ event, select, decline }, enqueue) => {
                    if (event.code === "child") {
                      return select.authorize(new AuthorizedPayment({ code: event.code }))
                    }
                    if (event.code === "consume") return select.consume()
                    enqueue.emit(new Notice({}))
                    return decline()
                  }, { declinable: true })
              }
            }
          }
        }
      })

      assert.strictEqual(
        Machine.transitionDefinitions(machine).find(({ source }) => source === "payment.entering")?.acceptance,
        "declinable"
      )
      const initial = yield* Machine.planInitial(machine)
      const child = yield* Machine.plan(machine, initial.state, new Authorize({ code: "child" }))
      assert.strictEqual(child.next.path, "payment")
      if (child.next.path === "payment") assert.strictEqual(child.next.state.path, "payment.authorized")
      assert.strictEqual(child.microsteps[0]?.transitions[0]?.source, "payment.entering")
      assert.strictEqual(child.microsteps[0]?.transitions[0]?.branchKey, "authorize")

      const consumed = yield* Machine.plan(machine, initial.state, new Authorize({ code: "consume" }))
      assert.deepStrictEqual(consumed.next, initial.state)
      assert.strictEqual(consumed.microsteps[0]?.transitions[0]?.source, "payment.entering")
      assert.strictEqual(consumed.microsteps[0]?.transitions[0]?.branchKey, "consume")
      assert.strictEqual(consumed.microsteps[0]?.transitions[0]?.target, undefined)

      const declined = yield* Machine.plan(machine, initial.state, new Authorize({ code: "parent" }))
      assert.strictEqual(declined.next.path, "failed")
      assert.strictEqual(declined.microsteps[0]?.transitions[0]?.source, "payment")
      assert.deepStrictEqual(declined.emittedEvents, [])
    }))

  it.effect("continues eventless selection at an ancestor when a child declines", () =>
    Effect.gen(function*() {
      class Workflow extends Schema.TaggedClass<Workflow>("DeclineWorkflow")("Workflow", {}) {}
      class Waiting extends Schema.TaggedClass<Waiting>("DeclineWaiting")("Waiting", { ready: Schema.Boolean }) {}
      class Finished extends Schema.TaggedClass<Finished>("DeclineFinished")("Finished", {}) {}
      const states = Machine.states({
        workflow: {
          schema: Workflow,
          initial: "waiting",
          states: { waiting: Waiting }
        },
        finished: Finished
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) =>
          to.workflow.initial.resolve(({ target }) =>
            target(new Workflow({}), (workflow) => workflow.waiting(new Waiting({ ready: false })))
          )
      }).handle({
        workflow: {
          always: (to) => to.full.finished().resolve(({ target }) => target(new Finished({}))),
          states: {
            waiting: {
              always: (to) =>
                to.none.resolve(({ state, decline }) => state.ready ? undefined : decline(), { declinable: true })
            }
          }
        }
      })

      const planned = yield* Machine.planInitial(machine)
      assert.strictEqual(planned.state.path, "finished")
      assert.strictEqual(planned.microsteps[0]?.transitions[0]?.source, "workflow")
    }))

  it.effect("treats an event as unhandled when every candidate declines", () =>
    Effect.gen(function*() {
      class Stable extends Schema.TaggedClass<Stable>("DeclineStable")("Stable", {}) {}
      class Ping extends Schema.TaggedClass<Ping>("DeclinePing")("Ping", {}) {}
      const states = Machine.states({ Stable })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Ping),
        initial: (to) => to.Stable().resolve(({ target }) => target(new Stable({})))
      }).handle({
        Stable: {
          on: {
            Ping: (to) => to.none.resolve(({ decline }) => decline(), { declinable: true })
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      assert.deepStrictEqual(Machine.enabled(machine, initial.state), ["Ping"])
      const planned = yield* Machine.plan(machine, initial.state, new Ping({}))
      assert.deepStrictEqual(planned.next, initial.state)
      assert.deepStrictEqual(planned.microsteps, [])
    }))

  it.effect("leaves a completed compound state active when onDone declines", () =>
    Effect.gen(function*() {
      class Workflow extends Schema.TaggedClass<Workflow>("DeclineDoneWorkflow")("Workflow", {}) {}
      class Complete extends Schema.TaggedClass<Complete>("DeclineDoneComplete")("Complete", {}) {}
      class Finished extends Schema.TaggedClass<Finished>("DeclineDoneFinished")("Finished", {}) {}
      const states = Machine.states({
        workflow: {
          schema: Workflow,
          initial: "complete",
          states: {
            complete: { schema: Complete, type: "final", output: Schema.String }
          }
        },
        finished: Finished
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) =>
          to.workflow.initial.resolve(({ target }) =>
            target(new Workflow({}), (workflow) => workflow.complete(new Complete({})))
          )
      }).handle({
        workflow: {
          onDone: (to) => to.full.finished().resolve(({ decline }) => decline(), { declinable: true }),
          states: {
            complete: { output: () => "complete" }
          }
        }
      })

      const planned = yield* Machine.planInitial(machine)
      assert.isFalse(planned.done)
      assert.strictEqual(planned.state.path, "workflow")
      if (planned.state.path === "workflow") assert.strictEqual(planned.state.state.path, "workflow.complete")
    }))

  it.effect("preserves descendant preemption when parallel candidates decline", () =>
    Effect.gen(function*() {
      class Root extends Schema.TaggedClass<Root>("DeclineParallelRoot")("Root", {}) {}
      class Left extends Schema.TaggedClass<Left>("DeclineParallelLeft")("Left", {}) {}
      class Right extends Schema.TaggedClass<Right>("DeclineParallelRight")("Right", {}) {}
      class Finished extends Schema.TaggedClass<Finished>("DeclineParallelFinished")("Finished", {}) {}
      class Ping extends Schema.TaggedClass<Ping>("DeclineParallelPing")("Ping", {
        handleRight: Schema.Boolean
      }) {}
      const states = Machine.states({
        root: {
          schema: Root,
          type: "parallel",
          states: { left: Left, right: Right }
        },
        finished: Finished
      })
      let parentCalls = 0
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Ping),
        initial: (to) =>
          to.root.initial.resolve(({ target }) =>
            target(new Root({}), (root) => root.left(new Left({})).right(new Right({})))
          )
      }).handle({
        root: {
          on: {
            Ping: (to) =>
              to.full.finished().resolve(({ target }) => {
                parentCalls++
                return target(new Finished({}))
              })
          },
          states: {
            left: {
              on: {
                Ping: (to) => to.none.resolve(({ decline }) => decline(), { declinable: true })
              }
            },
            right: {
              on: {
                Ping: (to) =>
                  to.none.resolve(({ event, decline }) => event.handleRight ? undefined : decline(), {
                    declinable: true
                  })
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      const descendant = yield* Machine.plan(machine, initial.state, new Ping({ handleRight: true }))
      assert.strictEqual(descendant.next.path, "root")
      assert.deepStrictEqual(descendant.microsteps[0]?.transitions.map(({ source }) => source), ["root.right"])
      assert.strictEqual(parentCalls, 0)

      const ancestor = yield* Machine.plan(machine, initial.state, new Ping({ handleRight: false }))
      assert.strictEqual(ancestor.next.path, "finished")
      assert.deepStrictEqual(ancestor.microsteps[0]?.transitions.map(({ source }) => source), ["root"])
      assert.strictEqual(parentCalls, 1)
    }))

  it.effect("handles parent config and nested states in the same object", () =>
    Effect.gen(function*() {
      const payment = new Payment({ id: "payment-1" })
      const entering = new EnteringPayment({ amount: 100 })
      const machine = Machine.make({
        states: {
          payment: {
            schema: Payment,
            initial: "entering",
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
        },
        events: Machine.events(Authorize, Reset),
        initial: (to) =>
          to.payment.initial.resolve(() => ({
            path: "payment" as const,
            value: payment,
            state: {
              path: "payment.entering" as const,
              value: entering
            }
          }))
      }).handle({
        payment: {
          on: {
            Reset: (to) => to.full.failed().resolve(({ target }) => target(new Failed({ message: "reset" })))
          },
          states: {
            entering: {
              on: {
                Authorize: (to) =>
                  to.local.authorized().resolve(({ event, target }) =>
                    target(new AuthorizedPayment({ code: event.code }))
                  )
              }
            },
            authorized: {
              output: ({ ancestors, state }) => {
                assert.deepStrictEqual(ancestors, { payment })
                return state.code
              }
            }
          }
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
      const machine = Machine.make({
        states: {
          idle: Idle,
          payment: {
            schema: Payment,
            initial: "entering",
            states: {
              entering: EnteringPayment,
              authorized: AuthorizedPayment
            }
          }
        },
        events: Machine.events(Reset),
        initial: (to) =>
          to.payment.initial.resolve(() => ({
            path: "payment" as const,
            value: payment,
            state: {
              path: "payment.entering" as const,
              value: entering
            }
          }))
      }).handle({
        payment: {
          on: {
            Reset: (to) => to.full.idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
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
      const states = Machine.states({
        idle: Idle,
        fulfillment: {
          schema: Fulfillment,
          type: "parallel",
          states: {
            inventory: {
              schema: Inventory,
              initial: "checking",
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
              initial: "quoting",
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
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Submit),
        initial: (to) => to.idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
      }).handle({
        idle: {
          on: {
            Submit: (to) =>
              to.full.fulfillment().resolve(({ event, target }) =>
                target(
                  new Fulfillment({ id: event.value }),
                  (fulfillment) =>
                    fulfillment
                      .inventory(
                        new Inventory({ warehouse: "warehouse-1" }),
                        (inventory) => inventory.reserved(new InventoryReserved({ reservationId: event.value }))
                      )
                      .shipping(
                        new Shipping({ address: "Main Street" }),
                        (shipping) => shipping.quoted(new ShippingQuoted({ quoteId: event.value }))
                      )
                )
              )
          }
        }
      })

      const planned = yield* Machine.plan(
        machine,
        { path: "idle" as const, value: new Idle({ userId: "user-1" }) },
        new Submit({ value: "order-1" })
      )

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
      const states = Machine.states({
        workflow: {
          schema: Payment,
          initial: "idle",
          states: {
            idle: Idle,
            fulfillment: {
              schema: Fulfillment,
              type: "parallel",
              states: {
                inventory: {
                  schema: Inventory,
                  initial: "checking",
                  states: {
                    checking: CheckingInventory,
                    reserved: InventoryReserved
                  }
                },
                shipping: {
                  schema: Shipping,
                  initial: "quoting",
                  states: {
                    quoting: QuotingShipping,
                    quoted: ShippingQuoted
                  }
                }
              }
            }
          }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Submit),
        initial: (to) =>
          to.workflow.initial.resolve(({ target }) =>
            target(
              workflow,
              (workflow) => workflow.idle(new Idle({ userId: "user-1" }))
            )
          )
      }).handle({
        workflow: {
          states: {
            idle: {
              on: {
                Submit: (to) =>
                  to.local.fulfillment().resolve(({ event, target }) =>
                    target(
                      new Fulfillment({ id: event.value }),
                      (fulfillment) =>
                        fulfillment
                          .inventory(
                            new Inventory({ warehouse: "warehouse-1" }),
                            (inventory) => inventory.reserved(new InventoryReserved({ reservationId: event.value }))
                          )
                          .shipping(
                            new Shipping({ address: "Main Street" }),
                            (shipping) => shipping.quoted(new ShippingQuoted({ quoteId: event.value }))
                          )
                    )
                  )
              }
            }
          }
        }
      })

      const planned = yield* Machine.plan(
        machine,
        {
          path: "workflow" as const,
          value: workflow,
          state: { path: "workflow.idle" as const, value: new Idle({ userId: "user-1" }) }
        },
        new Submit({ value: "order-1" })
      )

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
      const states = Machine.states({
        app: {
          schema: Fulfillment,
          type: "parallel",
          states: {
            flow: {
              schema: Payment,
              initial: "idle",
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
      })
      const initial = {
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
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Submit),
        initial: (to) => to.app.initial.resolve(() => initial)
      }).handle({
        app: {
          states: {
            flow: {
              states: {
                idle: {
                  on: {
                    Submit: (to) =>
                      to.branch.app.flow.fulfillment().resolve(({ event, target }) =>
                        target(
                          new Fulfillment({ id: event.value }),
                          (fulfillment) =>
                            fulfillment
                              .inventory(new Inventory({ warehouse: "warehouse-1" }))
                              .shipping(new Shipping({ address: "Main Street" }))
                        )
                      )
                  }
                }
              }
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
      const states = Machine.states({
        fulfillment: {
          schema: Fulfillment,
          type: "parallel",
          states: {
            inventory: {
              schema: Inventory,
              initial: "checking",
              states: {
                checking: CheckingInventory,
                reserved: InventoryReserved
              }
            },
            shipping: {
              schema: Shipping,
              initial: "quoting",
              states: {
                quoting: QuotingShipping,
                quoted: ShippingQuoted
              }
            }
          }
        }
      })
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(ReserveInventory),
        initial: (to) =>
          to.fulfillment.initial.resolve(({ target }) =>
            target(
              fulfillment,
              (fulfillment) =>
                fulfillment
                  .inventory(
                    inventory,
                    (inventory) => inventory.checking(new CheckingInventory({ sku: "sku-1" }))
                  )
                  .shipping(
                    shipping,
                    (shipping) => shipping.quoting(quoting)
                  )
            )
          )
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.local.reserved().resolve(({ event, target }) =>
                        target(new InventoryReserved({ reservationId: event.reservationId }))
                      )
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
    }))

  it.effect("uses target.local.with to replace the local compound value", () =>
    Effect.gen(function*() {
      const states = Machine.states({
        fulfillment: {
          schema: Fulfillment,
          type: "parallel",
          states: {
            inventory: {
              schema: Inventory,
              initial: "checking",
              states: {
                checking: CheckingInventory,
                reserved: InventoryReserved
              }
            },
            shipping: {
              schema: Shipping,
              initial: "quoting",
              states: {
                quoting: QuotingShipping,
                quoted: ShippingQuoted
              }
            }
          }
        }
      })
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const nextInventory = new Inventory({ warehouse: "warehouse-2" })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(ReserveInventory),
        initial: (to) =>
          to.fulfillment.initial.resolve(({ target }) =>
            target(
              fulfillment,
              (fulfillment) =>
                fulfillment
                  .inventory(
                    new Inventory({ warehouse: "warehouse-1" }),
                    (inventory) => inventory.checking(new CheckingInventory({ sku: "sku-1" }))
                  )
                  .shipping(
                    shipping,
                    (shipping) => shipping.quoting(quoting)
                  )
            )
          )
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.branch.fulfillment.inventory().resolve(({ event, target }) =>
                        target(
                          nextInventory,
                          (inventory) =>
                            inventory.reserved(new InventoryReserved({ reservationId: event.reservationId }))
                        )
                      )
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
      const states = Machine.states({
        fulfillment: {
          schema: Fulfillment,
          type: "parallel",
          states: {
            inventory: {
              schema: Inventory,
              initial: "checking",
              states: {
                checking: CheckingInventory,
                reserved: InventoryReserved
              }
            },
            shipping: {
              schema: Shipping,
              initial: "quoting",
              states: {
                quoting: QuotingShipping,
                quoted: ShippingQuoted
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
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(ReserveInventory),
        initial: (to) =>
          to.fulfillment.initial.resolve(({ target }) =>
            target(
              fulfillment,
              (fulfillment) =>
                fulfillment
                  .inventory(
                    inventory,
                    (inventory) => inventory.checking(new CheckingInventory({ sku: "sku-1" }))
                  )
                  .shipping(
                    shipping,
                    (shipping) => shipping.quoting(quoting)
                  )
            )
          )
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.branch.fulfillment.inventory().resolve(({ event, target }) =>
                        target(
                          nextInventory,
                          (inventory) =>
                            inventory.reserved(new InventoryReserved({ reservationId: event.reservationId }))
                        )
                      )
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
      const states = Machine.states({
        fulfillment: {
          schema: Fulfillment,
          type: "parallel",
          states: {
            inventory: {
              schema: Inventory,
              initial: "checking",
              states: {
                checking: CheckingInventory,
                reserved: InventoryReserved
              }
            },
            shipping: {
              schema: Shipping,
              initial: "quoting",
              states: {
                quoting: QuotingShipping,
                quoted: ShippingQuoted
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
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(ReserveInventory),
        initial: (to) =>
          to.fulfillment.initial.resolve(({ target }) =>
            target(
              fulfillment,
              (fulfillment) =>
                fulfillment
                  .inventory(
                    inventory,
                    (inventory) => inventory.checking(new CheckingInventory({ sku: "sku-1" }))
                  )
                  .shipping(
                    shipping,
                    (shipping) => shipping.quoting(quoting)
                  )
            )
          )
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.branch.fulfillment().resolve(({ event, target }) =>
                        target(
                          nextFulfillment,
                          (fulfillment) =>
                            fulfillment.inventory(
                              nextInventory,
                              (inventory) =>
                                inventory.reserved(new InventoryReserved({ reservationId: event.reservationId }))
                            )
                        )
                      )
                  }
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
      const states = Machine.states({
        payment: {
          schema: Payment,
          initial: "inventory",
          states: {
            inventory: {
              schema: Inventory,
              initial: "checking",
              states: {
                checking: CheckingInventory,
                reserved: InventoryReserved
              }
            },
            shipping: {
              schema: Shipping,
              initial: "quoting",
              states: {
                quoting: QuotingShipping,
                quoted: ShippingQuoted
              }
            }
          }
        }
      })
      const payment = new Payment({ id: "payment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(ReserveInventory),
        initial: (to) =>
          to.payment.initial.resolve(({ target }) =>
            target(
              payment,
              (payment) =>
                payment.inventory(
                  inventory,
                  (inventory) => inventory.checking(new CheckingInventory({ sku: "sku-1" }))
                )
            )
          )
      }).handle({
        payment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.branch.payment.shipping().resolve(({ event, target }) =>
                        target(
                          shipping,
                          (shipping) => shipping.quoted(new ShippingQuoted({ quoteId: event.reservationId }))
                        )
                      )
                  }
                }
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(
        machine,
        initial.state,
        new ReserveInventory({ reservationId: "quote-1" })
      )

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
      const machine = Machine.make({
        states: {
          payment: {
            schema: Payment,
            initial: "entering",
            states: {
              entering: EnteringPayment,
              authorized: {
                schema: AuthorizedPayment,
                type: "final",
                output: Schema.String
              }
            }
          }
        },
        events: Machine.events(Authorize, Reset),
        initial: (to) =>
          to.payment.initial.resolve(() => ({
            path: "payment" as const,
            value: payment,
            state: {
              path: "payment.entering" as const,
              value: new EnteringPayment({ amount: 100 })
            }
          }))
      }).handle({
        payment: {
          on: {
            Reset: (to) => to.local.entering().resolve(({ target }) => target(new EnteringPayment({ amount: 0 })))
          },
          states: {
            entering: {
              on: {
                Authorize: (to) =>
                  to.local.authorized().resolve(({ event, target }) =>
                    target(new AuthorizedPayment({ code: event.code }))
                  )
              }
            },
            authorized: {
              output: ({ state }) => state.code
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
      const machine = Machine.make({
        states: {
          payment: {
            schema: Payment,
            initial: "authorized",
            states: {
              authorized: {
                schema: AuthorizedPayment,
                type: "final",
                output: Schema.String
              }
            }
          }
        },
        events: Machine.events(Reset),
        initial: (to) =>
          to.payment.initial.resolve(() => ({
            path: "payment" as const,
            value: payment,
            state: {
              path: "payment.authorized" as const,
              value: authorized
            }
          }))
      }).handle({
        payment: {
          states: {
            authorized: {
              output: ({ state }) => state.code
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
      const machine = Machine.make({
        states: {
          idle: Idle,
          payment: {
            schema: Payment,
            initial: "entering",
            states: {
              entering: EnteringPayment,
              authorized: {
                schema: AuthorizedPayment,
                type: "final",
                output: Schema.String
              }
            }
          }
        },
        events: Machine.events(Authorize, Reset),
        initial: (to) =>
          to.payment.initial.resolve(() => ({
            path: "payment" as const,
            value: payment,
            state: {
              path: "payment.entering" as const,
              value: new EnteringPayment({ amount: 100 })
            }
          }))
      }).handle({
        payment: {
          on: {
            Reset: (to) => to.full.idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
          },
          states: {
            entering: {
              on: {
                Authorize: (to) =>
                  to.local.authorized().resolve(({ event, target }) =>
                    target(new AuthorizedPayment({ code: event.code }))
                  )
              }
            },
            authorized: {
              output: ({ state }) => state.code
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
          path: "payment" as const,
          value: payment,
          state: {
            path: "payment.authorized" as const,
            value: new AuthorizedPayment({ code: "auth-1" })
          },
          completed: [
            { path: "payment.authorized" as const, output: "auth-1" },
            { path: "payment" as const, output: "auth-1" }
          ]
        },
        output: "auth-1"
      })
    }))

  it.effect("runs onDone for nested compound completion without completing the root state", () =>
    Effect.gen(function*() {
      const checkout = new Fulfillment({ id: "checkout-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const machine = Machine.make({
        states: {
          checkout: {
            schema: Fulfillment,
            initial: "inventory",
            states: {
              inventory: {
                schema: Inventory,
                initial: "checking",
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
        },
        events: Machine.events(ReserveInventory, Reset),
        initial: (to) =>
          to.checkout.initial.resolve(() => ({
            path: "checkout" as const,
            value: checkout,
            state: {
              path: "checkout.inventory" as const,
              value: inventory,
              state: {
                path: "checkout.inventory.checking" as const,
                value: new CheckingInventory({ sku: "sku-1" })
              }
            }
          }))
      }).handle({
        checkout: {
          on: {
            Reset: (to) => to.full.failed().resolve(({ target }) => target(new Failed({ message: "reset" })))
          },
          states: {
            inventory: {
              onDone: (to) =>
                to.branch.checkout.shipped().resolve(({ output, target }) =>
                  target(new ShippingQuoted({ quoteId: String(output) }))
                ),
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.local.reserved().resolve(({ event, target }) =>
                        target(new InventoryReserved({ reservationId: event.reservationId }))
                      )
                  }
                },
                reserved: {
                  output: ({ state }) => state.reservationId
                }
              }
            }
          }
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
      const machine = Machine.make({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                initial: "checking",
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
                initial: "quoting",
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
        },
        events: Machine.events(ReserveInventory),
        initial: (to) =>
          to.fulfillment.initial.resolve(() => ({
            path: "fulfillment" as const,
            value: fulfillment,
            states: {
              inventory: {
                path: "fulfillment.inventory" as const,
                value: inventory,
                state: {
                  path: "fulfillment.inventory.checking" as const,
                  value: new CheckingInventory({ sku: "sku-1" })
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
            }
          }))
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.local.reserved().resolve(({ event, target }) =>
                        target(new InventoryReserved({ reservationId: event.reservationId }))
                      )
                  }
                }
              }
            },
            shipping: {
              states: {
                quoted: {
                  output: ({ state }) => state.quoteId
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
      const machine = Machine.make({
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
                initial: "checking",
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
                initial: "quoting",
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
        },
        events: Machine.events(ReserveInventory),
        initial: (to) =>
          to.fulfillment.initial.resolve(() => ({
            path: "fulfillment" as const,
            value: fulfillment,
            states: {
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
            }
          }))
      }).handle({
        fulfillment: {
          output: ({ outputs }) => ({
            inventory: outputs.inventory,
            shipping: outputs.shipping
          }),
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.local.reserved().resolve(({ event, target }) =>
                        target(new InventoryReserved({ reservationId: event.reservationId }))
                      )
                  }
                },
                reserved: {
                  output: ({ state }) => state.reservationId
                }
              }
            },
            shipping: {
              states: {
                quoting: {
                  on: {
                    ReserveInventory: (to) =>
                      to.local.quoted().resolve(({ event, target }) =>
                        target(new ShippingQuoted({ quoteId: event.reservationId }))
                      )
                  }
                },
                quoted: {
                  output: ({ state }) => state.quoteId
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
      const machine = Machine.make({
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
                initial: "checking",
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
                initial: "quoting",
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
        },
        events: Machine.events(ReserveInventory, Resolve),
        initial: (to) =>
          to.fulfillment.initial.resolve(() => ({
            path: "fulfillment" as const,
            value: fulfillment,
            states: {
              inventory: {
                path: "fulfillment.inventory" as const,
                value: inventory,
                state: {
                  path: "fulfillment.inventory.checking" as const,
                  value: new CheckingInventory({ sku: "sku-1" })
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
            }
          }))
      }).handle({
        fulfillment: {
          output: ({ outputs }) => outputs,
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.local.reserved().resolve(({ event, target }) =>
                        target(new InventoryReserved({ reservationId: event.reservationId }))
                      )
                  }
                },
                reserved: {
                  output: ({ event, state }) => `${state.reservationId}:${String(event._tag)}`
                }
              }
            },
            shipping: {
              states: {
                quoting: {
                  on: {
                    Resolve: (to) =>
                      to.local.quoted().resolve(({ target }) => target(new ShippingQuoted({ quoteId: "quote-1" })))
                  }
                },
                quoted: {
                  output: ({ event, state }) => `${state.quoteId}:${String(event._tag)}`
                }
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      const reserved = yield* Machine.plan(
        machine,
        initial.state,
        new ReserveInventory({ reservationId: "res-1" })
      )
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
      yield* sendAndWaitForSnapshot(
        actor,
        new ReserveInventory({ reservationId: "res-2" }),
        (snapshot) =>
          snapshot.status === "active" &&
          snapshot.state.path === "fulfillment" &&
          snapshot.state.states.inventory.state.path === "fulfillment.inventory.reserved"
      )
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
      const machine = Machine.make({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                initial: "checking",
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                initial: "quoting",
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        },
        events: Machine.events(ReserveInventory),
        initial: (to) =>
          to.fulfillment.initial.resolve(() => ({
            path: "fulfillment" as const,
            value: fulfillment,
            states: {
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
            }
          }))
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.local.reserved().resolve(({ event, target }) =>
                        target(new InventoryReserved({ reservationId: event.reservationId }))
                      )
                  }
                }
              }
            },
            shipping: {
              states: {
                quoting: {
                  on: {
                    ReserveInventory: (to) =>
                      to.local.quoted().resolve(({ event, target }) =>
                        target(new ShippingQuoted({ quoteId: event.reservationId }))
                      )
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
    }))

  it.effect("processes raised events from one parallel region after the current microstep", () =>
    Effect.gen(function*() {
      const fulfillment = new Fulfillment({ id: "fulfillment-1" })
      const inventory = new Inventory({ warehouse: "warehouse-1" })
      const checking = new CheckingInventory({ sku: "sku-1" })
      const shipping = new Shipping({ address: "Main Street" })
      const quoting = new QuotingShipping({ postalCode: "12345" })
      const machine = Machine.make({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                initial: "checking",
                states: {
                  checking: CheckingInventory,
                  reserved: InventoryReserved
                }
              },
              shipping: {
                schema: Shipping,
                initial: "quoting",
                states: {
                  quoting: QuotingShipping,
                  quoted: ShippingQuoted
                }
              }
            }
          }
        },
        events: Machine.events(ReserveInventory, Resolve),
        initial: (to) =>
          to.fulfillment.initial.resolve(() => ({
            path: "fulfillment" as const,
            value: fulfillment,
            states: {
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
            }
          }))
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.local.reserved().resolve(({ event, target }, enqueue) => {
                        enqueue.raise(new Resolve({}))
                        return target(
                          new InventoryReserved({
                            reservationId: event.reservationId
                          })
                        )
                      })
                  }
                }
              }
            },
            shipping: {
              states: {
                quoting: {
                  on: {
                    Resolve: (to) =>
                      to.local.quoted().resolve(({ target }) => target(new ShippingQuoted({ quoteId: "raised" })))
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
            value: new ShippingQuoted({ quoteId: "raised" })
          }
        }
      })
      assert.strictEqual(planned.microsteps.length, 2)
    }))

  it.effect("starts a machine without input", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle },
        events: Machine.events(Submit),
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
      })

      const actor = yield* Machine.start(machine)

      assert.deepStrictEqual((yield* actor.state).value, new Idle({ userId: "user-1" }))
    }))

  it.effect("handlers can return snapshots directly", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      const snapshot = yield* sendAndWaitForSnapshot(
        actor,
        new Submit({ value: "hello" }),
        (snapshot) => snapshot.state.value._tag === "Loading"
      )

      assert.deepStrictEqual(snapshot, {
        status: "active",
        state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
      })
    }))

  it("enabled returns the event tags handled by the current state", () => {
    const machine = Machine.make({
      states: { Idle, Loading },
      events: Machine.events(Submit, Reset),
      input: Input,
      initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
    }).handle({
      Idle: {
        on: {
          Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
        }
      },
      Loading: {
        on: {
          Reset: (to) => to.full.Idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
        }
      }
    })

    assert.deepStrictEqual(Machine.enabled(machine, FlatInitial.Idle(new Idle({ userId: "user-1" }))), ["Submit"])
    assert.deepStrictEqual(
      Machine.enabled(machine, FlatInitial.Loading(new Loading({ requestId: "request-1" }))),
      ["Reset"]
    )
  })

  it("enabled returns no event tags for final states", () => {
    const machine = Machine.make({
      states: {
        Idle,
        Success: { schema: Success, type: "final" }
      },
      events: Machine.events(Submit),
      input: Input,
      initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
    }).handle({
      Idle: {
        on: {
          Submit: (to) => to.full.Success().resolve(({ target }) => target(new Success({ requestId: "request-1" })))
        }
      },
      Success: {}
    })

    assert.deepStrictEqual(
      Machine.enabled(machine, FlatInitial.Success(new Success({ requestId: "request-1" }))),
      []
    )
  })

  it.effect("exposes final state output from a running machine", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Success: SuccessOutput },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Success().resolve(({ target }) => target(new Success({ requestId: "request-1" })))
          }
        },
        Success: {
          output: ({ event, state }) => `${state.requestId}:${String(event._tag)}`
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: { path: "Idle" as const, value: new Idle({ userId: "user-1" }) }
      })

      yield* actor.send(new Submit({ value: "hello" }))

      assert.strictEqual(yield* actor.join, "request-1:Submit")
    }))

  it.effect("plans final state output without running deferred actions", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Success: SuccessOutput },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Success().resolve(({ target }) => target(new Success({ requestId: "request-1" })))
          }
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const planned = yield* Machine.plan(
        machine,
        FlatInitial.Idle(new Idle({ userId: "user-1" })),
        new Submit({ value: "hello" })
      )

      assert.strictEqual(planned.output, "request-1")
    }))

  it.effect("exposes output when the initial state is final", () =>
    Effect.gen(function*() {
      let outputCalls = 0
      const machine = Machine.make({
        states: { Success: SuccessOutput },
        events: Machine.events(Submit),
        initial: (to) => to.Success().resolve(({ target }) => target(new Success({ requestId: "request-1" })))
      }).handle({
        Success: {
          output: ({ state }) => {
            outputCalls += 1
            return state.requestId
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
          path: "Success" as const,
          value: new Success({ requestId: "request-1" }),
          completed: [{ path: "Success" as const, output: "request-1" }]
        },
        output: "request-1"
      })
    }))

  it.effect("preserves completed output when a terminal snapshot is spread and planned again", () =>
    Effect.gen(function*() {
      let outputCalls = 0
      const machine = Machine.make({
        states: { Success: SuccessOutput },
        events: Machine.events(Submit),
        initial: (to) => to.Success().resolve(({ target }) => target(new Success({ requestId: "request-1" })))
      }).handle({
        Success: {
          output: ({ state }) => {
            outputCalls += 1
            return state.requestId
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      const cloned = { ...initial.state }
      const planned = yield* Machine.plan(machine, cloned, new Submit({ value: "ignored" }))

      assert.strictEqual(initial.done, true)
      assert.deepStrictEqual(cloned.completed, [{ path: "Success" as const, output: "request-1" }])
      assert.strictEqual(planned.done, true)
      assert.strictEqual(planned.output, "request-1")
      assert.strictEqual(outputCalls, 1)
    }))

  it.effect("defaults final state output to undefined", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: {
          Idle,
          Success: { schema: Success, type: "final" }
        },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Success().resolve(({ target }) => target(new Success({ requestId: "request-1" })))
          }
        },
        Success: {}
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))

      assert.strictEqual(yield* actor.join, undefined)
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "Success" as const,
          value: new Success({ requestId: "request-1" }),
          completed: [{ path: "Success" as const, output: undefined }]
        },
        output: undefined
      })
    }))

  it.effect("rejects events after reaching a final state", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: {
          Idle,
          Success: { schema: Success, type: "final" }
        },
        events: Machine.events(Submit, Reset),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Success().resolve(({ target }) => target(new Success({ requestId: "request-1" }))),
            Reset: (to) => to.full.Idle().resolve(({ target }) => target(new Idle({ userId: "user-2" })))
          }
        },
        Success: {}
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })
      yield* actor.send(new Submit({ value: "hello" }))
      yield* actor.join
      assert.instanceOf(yield* Effect.flip(actor.send(new Reset({}))), Machine.StoppedError)

      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "Success" as const,
          value: new Success({ requestId: "request-1" }),
          completed: [{ path: "Success" as const, output: undefined }]
        },
        output: undefined
      })
    }))

  it.effect("start keeps the machine alive after the starting fiber completes", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading },
        events: Machine.events(Submit),
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        }
      })

      const startingFiber = yield* Machine.start(machine).pipe(Effect.forkChild)
      const ref = yield* Fiber.join(startingFiber)
      const snapshot = yield* sendAndWaitForSnapshot(
        ref,
        new Submit({ value: "hello" }),
        (snapshot) => snapshot.status === "active" && snapshot.state.path === "Loading"
      )

      assert.strictEqual(snapshot.status, "active")
      assert.strictEqual(snapshot.state.path, "Loading")
      yield* ref.stop
    }))

  it.effect("start rejects events sent after stop", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        }
      })
      const actor = yield* Machine.start(machine, { userId: "user-1" })

      yield* actor.stop
      assert.instanceOf(
        yield* Effect.flip(actor.send(new Submit({ value: "hello" }))),
        Machine.StoppedError
      )

      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "stopped",
        state: { path: "Idle" as const, value: new Idle({ userId: "user-1" }) }
      })
    }))

  it.effect("plans no-op transitions from final states", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: {
          Idle,
          Success: { schema: Success, type: "final" }
        },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Success: {}
      })

      const state = FlatInitial.Success(new Success({ requestId: "request-1" }))
      const planned = yield* Machine.plan(machine, state, new Submit({ value: "hello" }))

      assert.deepStrictEqual(planned.next.value, state.value)
      assert.deepStrictEqual(planned.commands, [])
      assert.deepStrictEqual(planned.microsteps, [])
    }))

  it.effect("handlers use target.none for explicit targetless transitions", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.none
          }
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      yield* actor.send(new Submit({ value: "hello" }))
      yield* Effect.yieldNow

      assert.deepStrictEqual((yield* actor.state).value, new Idle({ userId: "user-1" }))
    }))

  it.effect("start returns a machine runtime with lifecycle snapshots", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })
      const observer = yield* actor.changes.pipe(
        Stream.filter((snapshot) => snapshot.state.value._tag === "Loading"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild
      )

      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: { path: "Idle" as const, value: new Idle({ userId: "user-1" }) }
      })

      yield* actor.send(new Submit({ value: "hello" }))

      const snapshots = Array.from(yield* Fiber.join(observer))
      assert.deepStrictEqual(snapshots, [{
        status: "active",
        state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
      }])
      assert.deepStrictEqual((yield* actor.state).value, new Loading({ requestId: "request-1" }))

      yield* actor.stop
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "stopped",
        state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
      })
    }))

  it.effect("start completes machine output from a final state", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Success: SuccessOutput },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Success().resolve(({ target }) => target(new Success({ requestId: "request-1" })))
          }
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      yield* actor.send(new Submit({ value: "hello" }))

      assert.strictEqual(yield* actor.join, "request-1")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "Success" as const,
          value: new Success({ requestId: "request-1" }),
          completed: [{ path: "Success" as const, output: "request-1" }]
        },
        output: "request-1"
      })
    }))

  it.effect("plan ignores events without an enabled transition", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        id: "UserMachine",
        states: { Idle, Loading },
        events: Machine.events(Submit, Reset),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        }
      })

      const state = FlatInitial.Idle(new Idle({ userId: "user-1" }))
      const planned = yield* Machine.plan(machine, state, new Reset({}))

      assert.deepStrictEqual(planned.next, state)
      assert.deepStrictEqual(planned.commands, [])
      assert.deepStrictEqual(planned.emittedEvents, [])
      assert.deepStrictEqual(planned.microsteps, [])
    }))

  it.effect("start runs invoke configs", () =>
    Effect.gen(function*() {
      const definition = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: Machine.events(Submit, RequestSucceeded),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      })
      const machine = definition.handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        },
        Loading: {
          invoke: (from) =>
            from.effect("request", () => Effect.succeed("done:request-1")).onDone((to) =>
              to.full.Success().resolve(({ output, target }) => target(new Success({ requestId: output })))
            )
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      yield* actor.send(new Submit({ value: "hello" }))

      assert.strictEqual(yield* actor.join, "done:request-1")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "Success" as const,
          value: new Success({ requestId: "done:request-1" }),
          completed: [{ path: "Success" as const, output: "done:request-1" }]
        },
        output: "done:request-1"
      })
    }))

  it.effect("start invokes a child process and handles its output event", () =>
    Effect.gen(function*() {
      const definition = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: Machine.events(Submit, RequestSucceeded),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      })
      const machine = definition.handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        },
        Loading: {
          invoke: (from) =>
            from.effect("request", () => Effect.succeed("done:request-1")).onDone((to) =>
              to.full.Success().resolve(({ output, target }) => target(new Success({ requestId: output })))
            )
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      yield* actor.send(new Submit({ value: "hello" }))

      assert.strictEqual(yield* actor.join, "done:request-1")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "Success" as const,
          value: new Success({ requestId: "done:request-1" }),
          completed: [{ path: "Success" as const, output: "done:request-1" }]
        },
        output: "done:request-1"
      })
    }))

  it.effect("isolates invoked children across concurrent zero-input starts", () =>
    Effect.gen(function*() {
      const childStates = Machine.states({ Idle })
      const childMachine = Machine.make({
        states: childStates.states,
        events: Machine.events(),
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({ userId: "child" })))
      })
      const Child = Machine.child("shared-child", childMachine)
      const parentStates = Machine.states({ Loading })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: Machine.events(),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ requestId: "parent" })))
      }).handle({
        Loading: {
          invoke: (from) => from.child(Child)
        }
      })

      const [first, second] = yield* Effect.all(
        [Machine.start(parentMachine), Machine.start(parentMachine)],
        { concurrency: "unbounded" }
      )
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
        state: { path: "Loading" as const, value: new Loading({ requestId: "parent" }) }
      })
      assert.deepStrictEqual(yield* secondChild.value.snapshot, {
        status: "active",
        state: { path: "Idle" as const, value: new Idle({ userId: "child" }) }
      })
      yield* second.stop
    }))

  it.effect("stops an idle compiled invoked child with its parent", () =>
    Effect.gen(function*() {
      const childStates = Machine.states({ Idle })
      const childMachine = Machine.make({
        states: childStates.states,
        events: Machine.events(),
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({ userId: "child" })))
      }).handle({ Idle: {} })
      const Child = Machine.child("owned-child", childMachine)
      const parentStates = Machine.states({ Loading })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: Machine.events(),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ requestId: "parent" })))
      }).handle({
        Loading: { invoke: (from) => from.child(Child) }
      })

      const parent = yield* Machine.start(parentMachine)
      const child = yield* parent.child(Child)
      assert(Option.isSome(child))

      yield* parent.stop

      assert.deepStrictEqual(yield* child.value.snapshot, {
        status: "stopped",
        state: { path: "Idle" as const, value: new Idle({ userId: "child" }) }
      })
      assert.instanceOf(yield* Effect.flip(child.value.join), Machine.StoppedError)
      assert(Option.isNone(yield* parent.child(Child)))
    }))

  it.effect("evaluates precompiled input-bearing invoked children for every start", () =>
    Effect.gen(function*() {
      let starts = 0
      const childStates = Machine.states({ Idle })
      const childMachine = Machine.make({
        states: childStates.states,
        events: Machine.events(),
        input: Input,
        initial: (to) =>
          to.Idle().resolve(({ input, target }) => {
            starts += 1
            return target(new Idle({ userId: input.userId }))
          })
      }).handle({ Idle: {} })
      const Child = Machine.child("input-child", childMachine)
      const parentStates = Machine.states({ Loading })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: Machine.events(),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ requestId: "parent" })))
      }).handle({
        Loading: {
          invoke: (from) => from.child(Child, { input: { userId: "configured" } })
        }
      })

      const [first, second] = yield* Effect.all(
        [Machine.start(parentMachine), Machine.start(parentMachine)],
        { concurrency: "unbounded" }
      )
      const [firstChild, secondChild] = yield* Effect.all([first.child(Child), second.child(Child)])

      assert.strictEqual(starts, 2)
      assert(Option.isSome(firstChild))
      assert(Option.isSome(secondChild))
      assert.notStrictEqual(firstChild.value, secondChild.value)
      assert.deepStrictEqual(yield* firstChild.value.state, {
        path: "Idle" as const,
        value: new Idle({ userId: "configured" })
      })
      yield* Effect.all([first.stop, second.stop], { concurrency: "unbounded" })
    }))

  it.effect("delivers completion from an initially final compiled child", () =>
    Effect.gen(function*() {
      class ChildFinished extends Schema.TaggedClass<ChildFinished>("ChildFinished")("ChildFinished", {
        output: Schema.String
      }) {}
      const childStates = Machine.states({
        Success: { schema: Success, type: "final", output: Schema.String }
      })
      const childMachine = Machine.make({
        states: childStates.states,
        events: Machine.events(),
        initial: (to) => to.Success().resolve(({ target }) => target(new Success({ requestId: "child-output" })))
      }).handle({
        Success: { output: ({ state }) => state.requestId }
      })
      const Child = Machine.child("final-child", childMachine)
      const parentStates = Machine.states({
        Loading,
        Success: { schema: Success, type: "final", output: Schema.String }
      })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: Machine.events(ChildFinished),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ requestId: "parent" })))
      }).handle({
        Loading: {
          invoke: (from) =>
            from.child(Child).onDone((to) =>
              to.full.Success().resolve(({ output, target }) => target(new Success({ requestId: output })))
            )
        },
        Success: { output: ({ state }) => state.requestId }
      })

      const parent = yield* Machine.start(parentMachine)

      assert.strictEqual(yield* parent.join, "child-output")
    }))

  it.effect("keeps input-bearing process descriptors instance-specific", () =>
    Effect.gen(function*() {
      const states = Machine.states({ Idle })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {}
      })
      const [first, second] = yield* Effect.all(
        [
          Machine.start(machine, { userId: "first" }),
          Machine.start(machine, { userId: "second" })
        ],
        { concurrency: "unbounded" }
      )

      assert.deepStrictEqual(yield* first.state, {
        path: "Idle" as const,
        value: new Idle({ userId: "first" })
      })
      assert.deepStrictEqual(yield* second.state, {
        path: "Idle" as const,
        value: new Idle({ userId: "second" })
      })
      yield* Effect.all([first.stop, second.stop], { concurrency: "unbounded" })
    }))

  it.effect("child invocation rejects duplicate active child addresses", () =>
    Effect.gen(function*() {
      const childStates = Machine.states({ Idle })
      const child = Machine.make({
        states: childStates.states,
        events: Machine.events(),
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({ userId: "child" })))
      })
      const Child = Machine.child("child-machine", child)
      const parentStates = Machine.states({ Loading })
      const parent = Machine.make({
        states: parentStates.states,
        events: Machine.events(),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
      }).handle({
        Loading: {
          invoke: (from) => [from.child(Child), from.child(Child)]
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
      const source = () => {
        sourceEvaluations += 1
        return Machine.logic({ initial: undefined, run: () => Effect.never })
      }
      const parentStates = Machine.states({ Loading })
      const parent = Machine.make({
        states: parentStates.states,
        events: Machine.events(),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
      }).handle({
        Loading: {
          invoke: (
            from
          ) => [
            from.logic("worker", { address: First, logic: source }),
            from.logic("worker", { address: Second, logic: source })
          ]
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
      const machine = Machine.make({
        states: { Idle, Loading, Failed: FailedOutput },
        events: Machine.events(Submit, RequestFailed),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        },
        Loading: {
          invoke: (from) =>
            from.effect("request", () => Effect.fail(error)).onFailure((to) =>
              to.full.Failed().resolve(({ error, target }) => target(new Failed({ message: error.message })))
            )
        },
        Failed: {
          output: ({ state }) => state.message
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      yield* actor.send(new Submit({ value: "hello" }))

      assert.strictEqual(yield* actor.join, "boom")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "Failed" as const,
          value: new Failed({ message: "boom" }),
          completed: [{ path: "Failed" as const, output: "boom" }]
        },
        output: "boom"
      })
    }))

  it.effect("start delivers internal invoke events without exposing them through send", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: Machine.events(Submit),
        internalEvents: Machine.internalEvents(RequestSucceeded),
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        },
        Loading: {
          invoke: (from) =>
            from.effect("request", () => Effect.succeed("loaded")).onDone((to) =>
              to.full.Success().resolve(({ output, target }) => target(new Success({ requestId: output })))
            )
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine)
      yield* actor.send(new Submit({ value: "start" }))

      assert.strictEqual(yield* actor.join, "loaded")
    }))

  it.effect("routes sendTo(parent) from an active invoked machine", () =>
    Effect.gen(function*() {
      const childStarted = yield* Deferred.make<void>()
      const machine = Machine.make({
        states: { Loading, Success: SuccessOutput },
        events: Machine.events(RequestSucceeded),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
      }).handle({
        Loading: {
          invoke: (from) =>
            from.logic("request", {
              address: Machine.childAddress("request-parent"),
              logic: Machine.logic({
                initial: undefined,
                run: ({ parent, sendTo }) =>
                  parent === undefined ?
                    Effect.die("child expected an owning actor") :
                    Deferred.succeed(childStarted, void 0).pipe(
                      Effect.andThen(sendTo(parent, new RequestSucceeded({ value: "child" }))),
                      Effect.andThen(Effect.never)
                    )
              })
            }).onFailure((to) => to.none),
          on: {
            RequestSucceeded: (to) =>
              to.full.Success().resolve(({ event, target }) => target(new Success({ requestId: event.value })))
          }
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine)
      yield* Deferred.await(childStarted)

      assert.strictEqual(yield* actor.join, "child")
    }))

  it.effect("drops sendTo(parent) from a stale invoked machine finalizer", () =>
    Effect.gen(function*() {
      const childStarted = yield* Deferred.make<void>()
      const machine = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: Machine.events(Resolve, RequestSucceeded),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
      }).handle({
        Idle: {
          on: {
            RequestSucceeded: (to) =>
              to.full.Success().resolve(({ event, target }) => target(new Success({ requestId: event.value })))
          }
        },
        Loading: {
          invoke: (from) =>
            from.logic("request", {
              address: Machine.childAddress("stale-request"),
              logic: Machine.logic({
                initial: undefined,
                run: ({ parent, sendTo }) =>
                  parent === undefined ?
                    Effect.die("child expected an owning actor") :
                    Deferred.succeed(childStarted, void 0).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() => sendTo(parent, new RequestSucceeded({ value: "stale" })))
                    )
              })
            }).onFailure((to) => to.none),
          on: {
            Resolve: (to) => to.full.Idle().resolve(({ target }) => target(new Idle({ userId: "resolved" })))
          }
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine)
      yield* Deferred.await(childStarted)
      yield* sendAndWaitForSnapshot(
        actor,
        new Resolve({}),
        (snapshot) => snapshot.status === "active" && snapshot.state.path === "Idle"
      )
      yield* Effect.yieldNow

      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: { path: "Idle" as const, value: new Idle({ userId: "resolved" }) }
      })
      yield* actor.stop
    }))

  it.effect("inline Effect invocation handles typed failures without manual recovery", () =>
    Effect.gen(function*() {
      const failure = new InvokeError({ message: "unavailable" })
      const machine = Machine.make({
        states: { Loading, Failed: FailedOutput },
        events: Machine.events(),
        internalEvents: Machine.internalEvents(RequestSucceeded, RequestFailed),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
      }).handle({
        Loading: {
          invoke: (from) =>
            from.effect("request", () => Effect.fail(failure)).onFailure((to) =>
              to.full.Failed().resolve(({ error, target }) => target(new Failed({ message: error.message })))
            )
        },
        Failed: {
          output: ({ state }) => state.message
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
      const machine = Machine.make({
        states: { Loading, Success: SuccessOutput },
        events: Machine.events(),
        internalEvents: Machine.internalEvents(RequestSucceeded),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
      }).handle({
        Loading: {
          invoke: (from) =>
            from.effect("request", () => requiredMessage).onDone((to) =>
              to.full.Success().resolve(({ output, target }) => target(new Success({ requestId: output })))
            )
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine).pipe(
        Effect.provideService(
          InitialRequirement,
          InitialRequirement.of({ initialMessage: "from-service" })
        )
      )

      assert.strictEqual(yield* actor.join, "from-service")
    }))

  it.effect("after emits a state-scoped internal event", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Loading, Success: SuccessOutput },
        events: Machine.events(),
        internalEvents: Machine.internalEvents(RequestSucceeded),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
      }).handle({
        Loading: {
          invoke: (from) =>
            from.timer("timeout", "1 hour").onDone((to) =>
              to.full.Success().resolve(({ target }) => target(new Success({ requestId: "timeout" })))
            )
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine)
      const joined = yield* actor.join.pipe(Effect.forkChild)
      yield* TestClock.adjust("1 hour")

      assert.strictEqual(yield* Fiber.join(joined), "timeout")
    }))

  it.effect("start maps invoked child active snapshots to machine events", () =>
    Effect.gen(function*() {
      const definition = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: Machine.events(Submit, RequestProgress),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      })
      const onSnapshot: Machine.Machine.InvokeTransition<
        Machine.Machine.States<typeof definition>,
        Machine.Machine.Events<typeof definition>,
        Machine.Machine.Emits<typeof definition>,
        "Loading",
        Machine.Machine.InvokeSnapshotContext<
          Machine.Machine.States<typeof definition>,
          Machine.Machine.Events<typeof definition>,
          Machine.Machine.Emits<typeof definition>,
          "Loading",
          string,
          never,
          never,
          Machine.Machine.InputEvents<typeof definition>,
          Machine.Machine.ParentEvents<typeof definition>
        >
      > = (to) =>
        to.full.Success().resolve(({ id, snapshot, target }) =>
          target(new Success({ requestId: `${id}:${snapshot.state}` }))
        )
      const machine = definition.handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        },
        Loading: {
          invoke: (from) =>
            from.logic("request", {
              address: Machine.childAddress("progress-request"),
              logic: Machine.logic({ initial: "pending", run: () => Effect.never })
            }).onSnapshot(onSnapshot)
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      yield* actor.send(new Submit({ value: "hello" }))

      assert.strictEqual(yield* actor.join, "request:pending")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "Success" as const,
          value: new Success({ requestId: "request:pending" }),
          completed: [{ path: "Success" as const, output: "request:pending" }]
        },
        output: "request:pending"
      })
    }))

  it.effect("start fails the owning machine when an invoked effect defects", () =>
    Effect.gen(function*() {
      const error = new InvokeError({ message: "boom" })
      const machine = Machine.make({
        states: { Idle, Loading },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        },
        Loading: {
          invoke: (from) => from.effect("request", () => Effect.die(error))
        }
      })

      const ref = yield* Machine.start(machine, { userId: "user-1" })
      const snapshot = yield* sendAndWaitForSnapshot(
        ref,
        new Submit({ value: "hello" }),
        (snapshot) => snapshot.status === "error"
      )
      assert.strictEqual(snapshot.status, "error")
      if (snapshot.status !== "error") return assert.fail("expected an error snapshot")
      assert.strictEqual(Cause.squash(snapshot.cause), error)
      assert.deepStrictEqual(snapshot.state, {
        path: "Loading" as const,
        value: new Loading({ requestId: "request-1" })
      })
    }))

  it.effect("start lets invoke snapshot handlers filter with target.none", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const definition = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: Machine.events(Submit, RequestProgress),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      })
      const onSnapshot: Machine.Machine.InvokeTransition<
        Machine.Machine.States<typeof definition>,
        Machine.Machine.Events<typeof definition>,
        Machine.Machine.Emits<typeof definition>,
        "Loading",
        Machine.Machine.InvokeSnapshotContext<
          Machine.Machine.States<typeof definition>,
          Machine.Machine.Events<typeof definition>,
          Machine.Machine.Emits<typeof definition>,
          "Loading",
          string,
          never,
          never,
          Machine.Machine.InputEvents<typeof definition>,
          Machine.Machine.ParentEvents<typeof definition>
        >
      > = (to) =>
        to.branches({
          ready: { title: "Request is ready", target: to.full.Success() },
          unchanged: { target: to.none }
        }).resolve(({ snapshot, select }) =>
          snapshot.state === "ready"
            ? select.ready(new Success({ requestId: snapshot.state }))
            : select.unchanged()
        )
      const machine = definition.handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        },
        Loading: {
          invoke: (from) =>
            from.logic("request", {
              address: Machine.childAddress("filtered-progress"),
              logic: Machine.logic({
                initial: "pending",
                run: ({ setState }) =>
                  Deferred.succeed(started, void 0).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(setState("ready")),
                    Effect.andThen(Effect.never)
                  )
              })
            }).onSnapshot(onSnapshot)
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      yield* actor.send(new Submit({ value: "hello" }))
      yield* Deferred.await(started)
      yield* Effect.yieldNow

      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
      })

      yield* Deferred.succeed(release, void 0)

      assert.strictEqual(yield* actor.join, "ready")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "Success" as const,
          value: new Success({ requestId: "ready" }),
          completed: [{ path: "Success" as const, output: "ready" }]
        },
        output: "ready"
      })
    }))

  it.effect("start allows invoked children without a snapshot handler", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        },
        Loading: {
          invoke: (from) =>
            from.logic("request", {
              address: Machine.childAddress("void-request"),
              logic: Machine.logic({
                initial: "pending",
                run: () => Effect.void
              })
            }).onDone((to) => to.none)
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      yield* actor.send(new Submit({ value: "hello" }))
      yield* Effect.yieldNow

      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
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
              Deferred.succeed(childStopping, void 0).pipe(
                Effect.andThen(Deferred.await(releaseChildStop))
              )
            )
          )
      })
      const machine = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: Machine.events(Submit, Resolve, RequestSucceeded),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        },
        Loading: {
          invoke: (from) =>
            from.logic("request", { address: Machine.childAddress("stopping-request"), logic: childLogic }),
          on: {
            Resolve: (to) => to.full.Success().resolve(({ target }) => target(new Success({ requestId: "request-1" }))),
            RequestSucceeded: (to) =>
              to.full.Success().resolve(({ event, target }) => target(new Success({ requestId: event.value })))
          }
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })
      const joinFiber = yield* actor.join.pipe(
        Effect.tap(() => Ref.set(joinDone, true)),
        Effect.forkChild
      )

      yield* actor.send(new Submit({ value: "hello" }))
      yield* Deferred.await(childStarted)
      yield* actor.send(new Resolve({}))
      yield* Deferred.await(childStopping)

      assert.strictEqual(yield* Ref.get(joinDone), false)
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: { path: "Loading" as const, value: new Loading({ requestId: "request-1" }) }
      })

      yield* Deferred.succeed(releaseChildStop, void 0)

      assert.strictEqual(yield* Fiber.join(joinFiber), "request-1")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "Success" as const,
          value: new Success({ requestId: "request-1" }),
          completed: [{ path: "Success" as const, output: "request-1" }]
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
      const machine = Machine.make({
        states: {
          payment: {
            schema: Payment,
            initial: "entering",
            states: {
              entering: EnteringPayment,
              authorized: AuthorizedPayment
            }
          }
        },
        events: Machine.events(Authorize),
        initial: (to) =>
          to.payment.initial.resolve(() => ({
            path: "payment" as const,
            value: payment,
            state: {
              path: "payment.entering" as const,
              value: entering
            }
          }))
      }).handle({
        payment: {
          invoke: (from) =>
            from.logic("request", {
              address: Machine.childAddress("payment-parent"),
              logic: makeInvokeLogic("parent", parentStarted)
            }),
          states: {
            entering: {
              entry: ({ ancestors, state }) => {
                assert.deepStrictEqual(state, entering)
                assert.deepStrictEqual(ancestors, { payment })
              },
              invoke: (from) =>
                from.logic("request", {
                  address: Machine.childAddress("payment-entering"),
                  logic: makeInvokeLogic("entering", enteringStarted)
                }),
              on: {
                Authorize: (to) =>
                  to.local.authorized().resolve(({ event, target }) =>
                    target(new AuthorizedPayment({ code: event.code }))
                  )
              }
            },
            authorized: {
              invoke: (from) =>
                from.logic("request", {
                  address: Machine.childAddress("payment-authorized"),
                  logic: makeInvokeLogic("authorized", authorizedStarted)
                })
            }
          }
        }
      })

      const actor = yield* Machine.start(machine)
      yield* Deferred.await(parentStarted)
      yield* Deferred.await(enteringStarted)

      yield* sendAndWaitForSnapshot(
        actor,
        new Authorize({ code: "auth-1" }),
        (snapshot) =>
          snapshot.status === "active" &&
          snapshot.state.path === "payment" &&
          (snapshot.state as any).state.path === "payment.authorized"
      )
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
                Deferred.succeed(stopping, void 0).pipe(
                  Effect.andThen(Deferred.await(releaseStops))
                )
              )
            )
        })
      const machine = Machine.make({
        states: {
          fulfillment: {
            schema: Fulfillment,
            type: "parallel",
            states: {
              inventory: {
                schema: Inventory,
                initial: "checking",
                states: {
                  checking: CheckingInventory
                }
              },
              shipping: {
                schema: Shipping,
                initial: "quoting",
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
        },
        events: Machine.events(ReserveInventory),
        initial: (to) =>
          to.fulfillment.initial.resolve(() => ({
            path: "fulfillment" as const,
            value: fulfillment,
            states: {
              inventory: {
                path: "fulfillment.inventory" as const,
                value: inventory,
                state: {
                  path: "fulfillment.inventory.checking" as const,
                  value: new CheckingInventory({ sku: "sku-1" })
                }
              },
              shipping: {
                path: "fulfillment.shipping" as const,
                value: shipping,
                state: {
                  path: "fulfillment.shipping.quoting" as const,
                  value: new QuotingShipping({ postalCode: "12345" })
                }
              }
            }
          }))
      }).handle({
        fulfillment: {
          invoke: (from) =>
            from.logic("request", {
              address: Machine.childAddress("fulfillment-parent"),
              logic: makeInvokeLogic(parentStarted, parentStopping)
            }),
          states: {
            inventory: {
              invoke: (from) =>
                from.logic("request", {
                  address: Machine.childAddress("fulfillment-inventory"),
                  logic: makeInvokeLogic(inventoryStarted, inventoryStopping)
                }),
              states: {
                checking: {
                  on: {
                    ReserveInventory: (to) =>
                      to.full.success().resolve(({ target }) => target(new Success({ requestId: "done" })))
                  }
                }
              }
            },
            shipping: {
              invoke: (from) =>
                from.logic("request", {
                  address: Machine.childAddress("fulfillment-shipping"),
                  logic: makeInvokeLogic(shippingStarted, shippingStopping)
                })
            }
          }
        },
        success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine)
      const joinFiber = yield* actor.join.pipe(
        Effect.tap(() => Ref.set(joinDone, true)),
        Effect.forkChild
      )
      yield* Deferred.await(parentStarted)
      yield* Deferred.await(inventoryStarted)
      yield* Deferred.await(shippingStarted)

      const sendFiber = yield* actor.send(new ReserveInventory({ reservationId: "res-1" })).pipe(
        Effect.forkChild
      )
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
      const machine = Machine.make({
        states: { Idle },
        events: Machine.events(),
        initial: (to) =>
          to.Idle().resolve(() => {
            throw defect
          })
      })

      const planningError = yield* Effect.flip(Machine.planInitial(machine))
      const startupError = yield* Effect.flip(Machine.start(machine))

      assert.instanceOf(planningError, Machine.StartupError)
      assert(Cause.hasDies(planningError.cause))
      assert.instanceOf(startupError, Machine.StartupError)
      assert(Cause.hasDies(startupError.cause))
    }))

  it.effect("wraps initial configuration validation defects consistently", () =>
    Effect.gen(function*() {
      const states = Machine.states({
        payment: {
          schema: Payment,
          initial: "entering",
          states: {
            entering: EnteringPayment,
            authorized: AuthorizedPayment
          }
        }
      })
      const invalidInitialState = {
        path: "payment" as const,
        value: new Payment({ id: "payment-1" }),
        state: {
          path: "payment.authorized" as const,
          value: new AuthorizedPayment({ code: "authorization-1" })
        }
      }
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) => to.payment.initial.resolve(() => invalidInitialState as any)
      })

      const planningError = yield* Effect.flip(Machine.planInitial(machine))
      const startupError = yield* Effect.flip(Machine.start(machine))

      assert.instanceOf(planningError, Machine.StartupError)
      assert(Cause.hasDies(planningError.cause))
      assert.instanceOf(startupError, Machine.StartupError)
      assert(Cause.hasDies(startupError.cause))
    }))

  it.effect("fails when always transitions do not stabilize", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        id: "LoopMachine",
        states: { Idle, Loading },
        events: Machine.events(Submit),
        input: Input,
        initial: (to) => to.Idle().resolve(({ input: input, target }) => target(new Idle({ userId: input.userId })))
      }).handle({
        Idle: {
          always: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" }))),
          on: {
            Submit: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
          }
        },
        Loading: {
          always: (to) => to.full.Idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
        }
      })

      const error = yield* Effect.flip(
        Machine.plan(machine, FlatInitial.Idle(new Idle({ userId: "user-1" })), new Submit({ value: "hello" }))
      )

      assert.instanceOf(error, Machine.InfiniteTransitionError)
      assert.strictEqual(error._tag, "InfiniteTransitionError")
      assert.strictEqual(error.machineId, "LoopMachine")
      assert.strictEqual(error.maxIterations, 1000)
    }))

  it.effect("fails initial planning and startup when always transitions do not stabilize", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        id: "InitialLoopMachine",
        states: { Idle, Loading },
        events: Machine.events(),
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
      }).handle({
        Idle: {
          always: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({ requestId: "request-1" })))
        },
        Loading: {
          always: (to) => to.full.Idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
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
      const states = Machine.states({
        idle: Idle,
        flow: {
          schema: Loading,
          initial: "done",
          states: {
            done: {
              schema: Success,
              type: "final"
            }
          }
        }
      })
      const machine = Machine.make({
        id: "CompletionLoopMachine",
        states: states.states,
        events: Machine.events(Submit),
        initial: (to) => to.idle().resolve(({ target }) => target(new Idle({ userId: "user-1" })))
      }).handle({
        idle: {
          on: {
            Submit: (to) =>
              to.full.flow().resolve(({ target }) =>
                target(
                  new Loading({ requestId: "request-1" }),
                  (flow) => flow.done(new Success({ requestId: "request-1" }))
                )
              )
          }
        },
        flow: {
          onDone: (to) =>
            to.full.flow().resolve(({ state, target }) =>
              target(
                state,
                (flow) => flow.done(new Success({ requestId: state.requestId }))
              )
            )
        }
      })

      const error = yield* Effect.flip(
        Machine.plan(
          machine,
          { path: "idle" as const, value: new Idle({ userId: "user-1" }) },
          new Submit({ value: "request-1" })
        )
      )

      assert.instanceOf(error, Machine.InfiniteTransitionError)
      assert.strictEqual(error.machineId, "CompletionLoopMachine")
      assert.strictEqual(error.maxIterations, 1000)
    }))

  class CounterRunning extends Schema.TaggedClass<CounterRunning>("CounterRunning")("CounterRunning", {}) {}

  class LeftCounter extends Schema.TaggedClass<LeftCounter>("LeftCounter")("LeftCounter", {
    value: Schema.Number
  }) {}

  class RightCounter extends Schema.TaggedClass<RightCounter>("RightCounter")("RightCounter", {
    value: Schema.Number
  }) {}

  class AdvanceCounters extends Schema.TaggedClass<AdvanceCounters>("AdvanceCounters")("AdvanceCounters", {}) {}

  class ConcurrentIdle extends Schema.TaggedClass<ConcurrentIdle>("ConcurrentIdle")("ConcurrentIdle", {}) {}

  class ConcurrentPing extends Schema.TaggedClass<ConcurrentPing>("ConcurrentPing")("ConcurrentPing", {}) {}

  const ParallelCounterStates = Machine.states({
    running: {
      schema: CounterRunning,
      type: "parallel",
      states: {
        left: LeftCounter,
        right: RightCounter
      }
    }
  })

  const makeParallelCounterMachine = () =>
    Machine.make({
      states: ParallelCounterStates.states,
      events: Machine.events(AdvanceCounters),
      initial: (to) =>
        to.running.initial.resolve(({ target }) =>
          target(
            new CounterRunning({}),
            (running) => running.left(new LeftCounter({ value: 0 })).right(new RightCounter({ value: 0 }))
          )
        )
    }).handle({
      running: {
        states: {
          left: {
            on: {
              AdvanceCounters: (to) =>
                to.branch.running.left().resolve(({ state, target }) =>
                  target(new LeftCounter({ value: state.value + 1 }))
                )
            }
          },
          right: {
            on: {
              AdvanceCounters: (to) =>
                to.branch.running.right().resolve(({ state, target }) =>
                  target(new RightCounter({ value: state.value + 1 }))
                )
            }
          }
        }
      }
    })

  const makeConcurrentMachine = () => {
    const states = Machine.states({ ConcurrentIdle })
    return Machine.make({
      states: states.states,
      events: Machine.events(ConcurrentPing),
      initial: (to) => to.ConcurrentIdle().resolve(({ target }) => target(new ConcurrentIdle({})))
    }).handle({
      ConcurrentIdle: {
        on: {
          ConcurrentPing: (to) => to.none
        }
      }
    })
  }

  it.effect("keeps every parallel state active across repeated transitions", () =>
    Effect.gen(function*() {
      const machine = makeParallelCounterMachine()
      let snapshot: Machine.Machine.Snapshot<typeof ParallelCounterStates.states> =
        (yield* Machine.planInitial(machine)).state

      for (let iteration = 1; iteration <= 32; iteration++) {
        const cloned = {
          ...snapshot,
          states: { ...snapshot.states }
        }
        const planned = yield* Machine.plan(machine, cloned, new AdvanceCounters({}))

        assert.strictEqual(planned.next.path, "running")
        assert.deepStrictEqual(Object.keys(planned.next.states).sort(), ["left", "right"])
        assert.strictEqual(planned.next.states.left.path, "running.left")
        assert.strictEqual(planned.next.states.right.path, "running.right")
        assert.strictEqual(planned.next.states.left.value.value, iteration)
        assert.strictEqual(planned.next.states.right.value.value, iteration)

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
        state: { path: "ConcurrentIdle" as const, value: new ConcurrentIdle({}) }
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
