import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Data, Deferred, Effect, Fiber, Option, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../src/index.js"

class DeferredLog extends Context.Service<DeferredLog, {
  readonly push: (message: string) => Effect.Effect<void>
  readonly read: Effect.Effect<ReadonlyArray<string>>
}>()("test/Machine/DeferredLog") {}

class EntryRequirement extends Context.Service<EntryRequirement, {
  readonly entryMessage: string
}>()("test/Machine/EntryRequirement") {}

class InitialRequirement extends Context.Service<InitialRequirement, {
  readonly initialMessage: string
}>()("test/Machine/InitialRequirement") {}

class ExitRequirement extends Context.Service<ExitRequirement, {
  readonly exitMessage: string
}>()("test/Machine/ExitRequirement") {}

const makeDeferredLog = Effect.gen(function*() {
  const ref = yield* Ref.make<ReadonlyArray<string>>([])
  return DeferredLog.of({
    push: (message) => Ref.update(ref, (messages) => [...messages, message]),
    read: Ref.get(ref)
  })
})

class EntryError extends Data.TaggedError("EntryError")<{
  readonly state: string
}> {}

class InitialError extends Data.TaggedError("InitialError")<{
  readonly state: string
}> {}

class ExitError extends Data.TaggedError("ExitError")<{
  readonly state: string
}> {}

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

  class NonEmptyResolve extends Schema.TaggedClass<NonEmptyResolve>("NonEmptyResolve")("NonEmptyResolve", {
    value: Schema.NonEmptyString
  }) {}

  class NonEmptyEmit extends Schema.TaggedClass<NonEmptyEmit>("NonEmptyEmit")("NonEmptyEmit", {
    value: Schema.NonEmptyString
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

  class ParentRequestProgress extends Schema.TaggedClass<ParentRequestProgress>("ParentRequestProgress")(
    "ParentRequestProgress",
    {
      id: Schema.String,
      loaded: Schema.Number
    }
  ) {}

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
  class ChildPing extends Data.TaggedClass("ChildPing")<{
    readonly reply: Deferred.Deferred<void>
  }> {}

  const FlatInitial = Machine.defineStates({ Idle, Loading, Success, Failed }).initial
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
  const LowercaseInitial = Machine.defineStates({ idle: Idle, loading: Loading, success: Success }).initial
  const DuplicateInitial = Machine.defineStates({ a: Duplicate, b: Duplicate }).initial

  it.effect("make constructs the initial state from input", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({ Idle })
      const machine = Machine.make({
        states: states.states,
        events: [Submit],
        input: Input,
        initial: (input) => states.initial.Idle(new Idle({ userId: input.userId }))
      })

      const planned = yield* Machine.planInitial(machine, { userId: "user-1" })

      assert.strictEqual(Machine.isMachine(machine), true)
      assert.deepStrictEqual(planned.state.value, new Idle({ userId: "user-1" }))
    }))

  it("isMachine requires the machine brand value, not only its property key", () => {
    const states = Machine.defineStates({ Idle })
    const machine = Machine.make({
      states: states.states,
      events: [],
      initial: () => states.initial.Idle(new Idle({ userId: "user-1" }))
    })

    assert.strictEqual(Machine.isMachine(machine), true)
    assert.strictEqual(Machine.isMachine({ [Machine.TypeId]: "not-a-machine" }), false)
  })

  it("retag constructs the target case without copying the source discriminator", () => {
    const result = Machine.retag(RequestSucceeded, new Submit({ value: "loaded" }))

    assert.instanceOf(result, RequestSucceeded)
    assert.deepStrictEqual(result, new RequestSucceeded({ value: "loaded" }))
  })

  it("make stores the machine id", () => {
    const states = Machine.defineStates({ Idle, Loading })
    const machine = Machine.make({
      id: "UserMachine",
      states: states.states,
      events: [Submit],
      input: Input,
      initial: (input) => states.initial.Idle(new Idle({ userId: input.userId }))
    }).handle({
      Idle: {
        on: {
          Submit: ({ target }) => {
            return target.full.Loading(new Loading({ requestId: "request-1" }))
          }
        }
      }
    })

    assert.strictEqual(machine.id, "UserMachine")
  })

  it("identifies the initial lifecycle event", () => {
    assert.strictEqual(Machine.isInitialEvent(Machine.InitialEvent), true)
    assert.strictEqual(Machine.isInitialEvent(new Submit({ value: "request-1" })), false)
  })

  it.effect("defineStates returns states accepted by make", () =>
    Effect.gen(function*() {
      const states = { idle: Idle, loading: Loading }
      const defined = Machine.defineStates(states)
      const machine = Machine.make({
        states: defined.states,
        events: [Submit],
        initial: () => defined.initial.idle(new Idle({ userId: "user-1" }))
      })

      const planned = yield* Machine.planInitial(machine)

      assert.strictEqual(defined.states, states)
      assert.strictEqual(planned.state.path, "idle")
      assert.deepStrictEqual(planned.state.value, new Idle({ userId: "user-1" }))
    }))

  it("defineStates selects active compound and parallel state paths", () => {
    const states = Machine.defineStates({
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
    const snapshot = states.initial.fulfillment(
      fulfillment,
      (fulfillment) =>
        fulfillment
          .inventory(inventory, (inventory) => inventory.checking(checking))
          .shipping(shipping, (shipping) => shipping.quoting(quoting))
    )

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
      Option.some({ path: "fulfillment.inventory.checking", value: checking })
    )
    assert.strictEqual(states.matches(snapshot, "fulfillment.shipping"), true)
    assert.strictEqual(states.matches(snapshot, "fulfillment.shipping.quoted"), false)
  })

  it.effect("initial builder constructs compound initial snapshots", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({
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
        events: [Authorize],
        initial: () =>
          states.initial.payment(
            payment,
            (payment) => payment.entering(entering)
          )
      })

      const planned = yield* Machine.planInitial(machine)

      assertCompoundStateSnapshot(planned.state, "payment", payment, {
        path: "payment.entering",
        value: entering
      })
    }))

  it.effect("initial builder constructs parallel initial snapshots", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({
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
        events: [ReserveInventory],
        initial: () =>
          states.initial.fulfillment(
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
      })

      const planned = yield* Machine.planInitial(machine)

      assertParallelStateSnapshot(planned.state, "fulfillment", fulfillment, {
        inventory: {
          path: "fulfillment.inventory",
          value: inventory,
          state: {
            path: "fulfillment.inventory.checking",
            value: checking
          }
        },
        shipping: {
          path: "fulfillment.shipping",
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting",
            value: quoting
          }
        }
      })
    }))

  describe("event constructor", () => {
    it.effect("validates once and shares trust only with derived machine definitions", () =>
      Effect.gen(function*() {
        let validations = 0
        const Tick = Schema.TaggedStruct("ConstructedTick", { value: Schema.Number }).pipe(
          Schema.refine((event): event is typeof event => {
            validations += 1
            return true
          })
        )
        const AlternateTick = Schema.TaggedStruct("ConstructedTick", { value: Schema.Number })
        const Counter = Schema.TaggedStruct("ConstructedCounter", { value: Schema.Number })
        const states = Machine.defineStates({ Counter })
        const definition = Machine.make({
          states: states.states,
          events: [Tick],
          initial: () => states.initial.Counter.from({ value: 0 })
        })

        const tick = Machine.event(definition, Tick, { value: 1 })
        assert.deepStrictEqual(tick, { _tag: "ConstructedTick", value: 1 })
        assert.strictEqual(validations, 1)

        const machine = definition.handle({
          Counter: {
            on: {
              ConstructedTick: () => undefined
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)
        for (let index = 0; index < 5; index++) {
          yield* Machine.plan(machine, initial.state, tick)
        }
        assert.strictEqual(validations, 1)

        const raw = Tick.make({ value: 2 })
        assert.strictEqual(validations, 2)
        yield* Machine.plan(machine, initial.state, raw)
        assert.strictEqual(validations, 3)

        const unrelated = Machine.make({
          states: states.states,
          events: [Tick],
          initial: () => states.initial.Counter.from({ value: 0 })
        }).handle({
          Counter: {
            on: {
              ConstructedTick: () => undefined
            }
          }
        })
        yield* Machine.plan(unrelated, (yield* Machine.planInitial(unrelated)).state, tick)
        assert.strictEqual(validations, 4)

        assert.throws(
          () => Machine.event(machine, AlternateTick, { value: 1 }),
          "Machine.event expected a schema from the machine event protocol"
        )

        let invalid: unknown
        try {
          Machine.event(definition, Tick, { value: "invalid" } as never)
        } catch (cause) {
          invalid = cause
        }
        assertMachineSchemaDecodeError(invalid, "event")
      }))

    it("constructs configured TaggedUnion cases", () => {
      const Event = Schema.TaggedUnion({
        Ping: { message: Schema.String },
        Stop: {}
      })
      class Defaulted extends Schema.TaggedClass<Defaulted>("ConstructedDefaulted")("Defaulted", {
        id: Schema.String,
        label: Schema.String.pipe(
          Schema.optionalKey,
          Schema.withConstructorDefault(Effect.succeed("default-label"))
        )
      }) {}
      const State = Schema.TaggedStruct("EventConstructorIdle", {})
      const states = Machine.defineStates({ Idle: State })
      const machine = Machine.make({
        states: states.states,
        events: [Event, Defaulted],
        initial: () => states.initial.Idle.from()
      })

      assert.deepStrictEqual(
        Machine.event(machine, Event.cases.Ping, { message: "hello" }),
        { _tag: "Ping", message: "hello" }
      )
      assert.deepStrictEqual(Machine.event(machine, Event.cases.Stop), { _tag: "Stop" })
      const defaulted = Machine.event(machine, Defaulted, { id: "event-1" })
      assert.instanceOf(defaulted, Defaulted)
      assert.deepStrictEqual(defaulted, new Defaulted({ id: "event-1", label: "default-label" }))
    })
  })

  describe("state builder from", () => {
    it.effect("constructs TaggedClass initial state and applies constructor defaults", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({ idle: DefaultedIdle })
        const machine = Machine.make({
          id: "from-default",
          states: states.states,
          events: [],
          initial: () => states.initial.idle.from({ id: "idle-1" })
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
        const states = Machine.defineStates({
          Idle: State.cases.Idle,
          Done: {
            schema: State.cases.Done,
            type: "final"
          }
        })
        const machine = Machine.make({
          states: states.states,
          events: [Event],
          initial: () => states.initial.Idle.from()
        }).handle({
          Idle: {
            on: {
              Submit: ({ event, target }) => target.full.Done.from({ requestId: event.requestId })
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
        const states = Machine.defineStates({ DefaultOnly })
        const machine = Machine.make({
          id: "from-default-only",
          states: states.states,
          events: [],
          initial: () => states.initial.DefaultOnly.from()
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
        const states = Machine.defineStates({
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
          events: [
            Event.cases.Local,
            Event.cases.LocalWith,
            Event.cases.Branch,
            Event.cases.Full,
            Event.cases.Finish
          ],
          initial: () => states.initial.Flow.from((flow) => flow.Idle.from())
        }).handle({
          Flow: {
            states: {
              Idle: {
                on: {
                  Local: ({ target }) => target.local.Running.from(),
                  LocalWith: ({ target }) => target.local.with.from((flow) => flow.Running.from()),
                  Branch: ({ target }) => target.branch.Flow.Nested.from((nested) => nested.NestedIdle.from()),
                  Full: ({ target }) =>
                    target.full.Flow.from((flow) => flow.Nested.from((nested) => nested.NestedIdle.from())),
                  Finish: ({ target }) => target.local.Done.from()
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
        const states = Machine.defineStates({
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
          events: [],
          initial: () =>
            states.initial.Parallel.from((parallel) =>
              parallel
                .left.from((left) => left.LeftIdle.from())
                .right.from((right) => right.RightIdle.from())
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
        const states = Machine.defineStates({ Blocked })
        const invalid = states.initial.Blocked.from()
        const machine = Machine.make({
          id: "from-empty-refinement",
          states: states.states,
          events: [],
          initial: () => invalid
        })

        const error = yield* Effect.flip(Machine.planInitial(machine))

        assertMachineSchemaDecodeError(error, "state", { state: "Blocked" })
        assert.strictEqual((error as Machine.MachineSchemaDecodeError).machineId, "from-empty-refinement")
      }))

    it.effect("fails invalid refinement input through MachineSchemaDecodeError without throwing in the builder", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({ NonEmptyIdle })
        const invalid = states.initial.NonEmptyIdle.from({ userId: "" })
        const machine = Machine.make({
          id: "from-refinement",
          states: states.states,
          events: [],
          initial: () => invalid
        })

        const error = yield* Effect.flip(Machine.planInitial(machine))

        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyIdle" })
        assert.strictEqual((error as Machine.MachineSchemaDecodeError).machineId, "from-refinement")
      }))

    it.effect("fails invalid transition construction in the typed machine error channel", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({ NonEmptyIdle, NonEmptyLoading })
        const machine = Machine.make({
          id: "from-transition-refinement",
          states: states.states,
          events: [NonEmptySubmit],
          initial: () => states.initial.NonEmptyIdle.from({ userId: "user-1" })
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: ({ target }) => target.full.NonEmptyLoading.from({ requestId: "" })
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
        const states = Machine.defineStates({
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
          events: [Submit],
          initial: () => states.initial.idle.from({ userId: "user-1" })
        }).handle({
          idle: {
            on: {
              Submit: ({ event, target }) =>
                target.full.fulfillment.from(
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
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)

        const planned = yield* Machine.plan(machine, initial.state, new Submit({ value: "order-1" }))

        assertParallelStateSnapshot(planned.next as any, "fulfillment", new Fulfillment({ id: "order-1" }), {
          inventory: {
            path: "fulfillment.inventory",
            value: new Inventory({ warehouse: "warehouse-1" }),
            state: {
              path: "fulfillment.inventory.reserved",
              value: new InventoryReserved({ reservationId: "order-1" })
            }
          },
          shipping: {
            path: "fulfillment.shipping",
            value: new Shipping({ address: "Main Street" }),
            state: {
              path: "fulfillment.shipping.quoted",
              value: new ShippingQuoted({ quoteId: "order-1" })
            }
          }
        })
      }))

    it.effect("constructs local parent replacement and leaf targets from schema input", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({
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
          events: [Submit],
          initial: () =>
            states.initial.payment.from(
              { id: "payment-1" },
              (payment) => payment.entering.from({ amount: 1 })
            )
        }).handle({
          payment: {
            states: {
              entering: {
                on: {
                  Submit: ({ event, target }) =>
                    target.local.with.from(
                      { id: "payment-2" },
                      (payment) => payment.authorized.from({ code: event.value })
                    )
                }
              }
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)

        const planned = yield* Machine.plan(machine, initial.state, new Submit({ value: "auth-1" }))

        assertCompoundStateSnapshot(planned.next as any, "payment", new Payment({ id: "payment-2" }), {
          path: "payment.authorized",
          value: new AuthorizedPayment({ code: "auth-1" })
        })
      }))

    it.effect("constructs cross-branch ancestor and leaf values from schema input", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({
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
          events: [Submit],
          initial: () =>
            states.initial.workflow.from(
              { id: "workflow-1" },
              (workflow) => workflow.idle.from({ userId: "user-1" })
            )
        }).handle({
          workflow: {
            states: {
              idle: {
                on: {
                  Submit: ({ event, target }) =>
                    target.branch.workflow.from(
                      { id: "workflow-2" },
                      (workflow) =>
                        workflow.checkout.from(
                          { id: "checkout-1" },
                          (checkout) => checkout.quoted.from({ quoteId: event.value })
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
          path: "workflow.checkout",
          value: new Fulfillment({ id: "checkout-1" }),
          state: {
            path: "workflow.checkout.quoted",
            value: new ShippingQuoted({ quoteId: "quote-1" })
          }
        })
      }))
  })

  describe("runtime schema contracts", () => {
    it.effect("decodes input before initial state construction", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: [NonEmptySubmit],
          input: NonEmptyInput,
          initial: (input) => states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: input.userId }))
        })

        const error = yield* Effect.flip(Machine.planInitial(machine, { userId: "" as any }))

        assertMachineSchemaDecodeError(error, "input")
      }))

    it.effect("decodes initial state snapshots before accepting them", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: [NonEmptySubmit],
          initial: () => states.initial.NonEmptyIdle(unsafeTagged({ _tag: "NonEmptyIdle", userId: "" }))
        })

        const error = yield* Effect.flip(Machine.planInitial(machine))

        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyIdle" })
      }))

    it.effect("decodes incoming events before handler selection", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: [NonEmptySubmit],
          initial: () => states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" }))
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: ({ state, target }) => target.full.NonEmptyIdle(state)
            }
          }
        })

        const error = yield* Effect.flip(
          Machine.plan(
            machine,
            states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" })),
            unsafeTagged({ _tag: "NonEmptySubmit", value: "" })
          )
        )

        assertMachineSchemaDecodeError(error, "event", { event: "NonEmptySubmit" })
      }))

    it.effect("surfaces sent event decode failures through the machine lifecycle", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: [NonEmptySubmit],
          initial: () => states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" }))
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: ({ state, target }) => target.full.NonEmptyIdle(state)
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
        const states = Machine.defineStates({ NonEmptyIdle, NonEmptyLoading })
        const machine = Machine.make({
          states: states.states,
          events: [NonEmptySubmit],
          initial: () => states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" }))
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: ({ target }) =>
                target.full.NonEmptyLoading(unsafeTagged({ _tag: "NonEmptyLoading", requestId: "" }))
            }
          }
        })

        const error = yield* Effect.flip(
          Machine.plan(
            machine,
            states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" })),
            new NonEmptySubmit({ value: "request-1" })
          )
        )

        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyLoading" })
      }))

    it.effect("decodes same-state atomic snapshot targets in the compiled runtime", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: [NonEmptySubmit],
          initial: () => states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" }))
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: ({ target }) =>
                target.full.NonEmptyIdle(unsafeTagged({ _tag: "NonEmptyIdle", userId: "" }))
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
        const states = Machine.defineStates({
          NonEmptyIdle,
          done: {
            schema: NonEmptyDone,
            type: "final",
            output: Schema.NonEmptyString
          }
        })
        const machine = Machine.make({
          states: states.states,
          events: [NonEmptySubmit],
          initial: () => states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" }))
        }).handle({
          NonEmptyIdle: {
            on: {
              NonEmptySubmit: ({ event, target }) => target.full.done(new NonEmptyDone({ requestId: event.value }))
            }
          },
          done: {
            output: () => "" as any
          }
        })

        const error = yield* Effect.flip(
          Machine.plan(
            machine,
            states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" })),
            new NonEmptySubmit({ value: "request-1" })
          )
        )

        assertMachineSchemaDecodeError(error, "output", { state: "done" })
      }))

    it.effect("decodes parallel state output before caching it", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({
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
          events: [],
          initial: () =>
            states.initial.all(
              new ParallelRoot({ id: "all" }),
              (all) =>
                all
                  .left(new ParallelLeftDone({ id: "left" }))
                  .right(new ParallelRightDone({ id: "right" }))
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
        const states = Machine.defineStates({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: [NonEmptySubmit],
          initial: () => states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" }))
        })

        const error = yield* Effect.flip(
          Machine.plan(
            machine,
            { path: "missing", value: new NonEmptyIdle({ userId: "user-1" }) } as any,
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
        const states = Machine.defineStates({ count: EncodedCount })
        const machine = Machine.make({
          id: "Counter",
          states: states.states,
          events: [],
          initial: () => states.initial.count(new EncodedCount({ count: 1 }))
        })
        const planned = yield* Machine.planInitial(machine)

        const encoded = yield* Machine.encodeSnapshot(machine, planned.state)
        const decoded = yield* Machine.decodeSnapshot(machine, JSON.parse(JSON.stringify(encoded)))

        assert.deepStrictEqual(encoded, {
          _tag: "MachineSnapshot",
          active: [{
            path: "count",
            value: { _tag: "EncodedCount", count: "1" }
          }]
        })
        assert.deepStrictEqual(decoded, planned.state)
        assert.instanceOf(decoded.value, EncodedCount)
      }))

    it.effect("round-trips compound and parallel configurations", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({
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
          events: [],
          initial: () =>
            states.initial.fulfillment(
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
        const states = Machine.defineStates({
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
          events: [],
          initial: () =>
            states.initial.all(
              new ParallelRoot({ id: "all" }),
              (all) =>
                all
                  .left(new ParallelLeftDone({ id: "left" }))
                  .right(new ParallelRightDone({ id: "right" }))
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

        assert.deepStrictEqual(encoded.completed, [{ path: "all.left", output: "1" }])
        assert.deepStrictEqual(decoded.completed, [{ path: "all.left", output: 1 }])
      }))

    it.effect("round-trips void completion outputs through JSON", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({
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
          events: [],
          initial: () =>
            states.initial.all(
              new ParallelRoot({ id: "all" }),
              (all) =>
                all
                  .left(new ParallelLeftDone({ id: "left" }))
                  .right(new ParallelRightDone({ id: "right" }))
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

        assert.deepStrictEqual(encoded.completed, [{ path: "all.left" }])
        assert.deepStrictEqual(decoded.completed, [{ path: "all.left", output: undefined }])
      }))

    it.effect("rejects state values that cannot be encoded", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: [],
          initial: () => states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" }))
        })

        const error = yield* Machine.encodeSnapshot(machine, {
          path: "NonEmptyIdle",
          value: unsafeTagged({ _tag: "NonEmptyIdle", userId: "" })
        }).pipe(Effect.flip)

        assertMachineSchemaEncodeError(error, "state", { state: "NonEmptyIdle" })
      }))

    it.effect("rejects invalid completion metadata during encoding", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: [],
          initial: () => states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" }))
        })

        const error = yield* Machine.encodeSnapshot(machine, {
          ...states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" })),
          completed: [{ path: "missing", output: undefined }]
        }).pipe(Effect.flip)

        assert.instanceOf(error, Machine.MachineSchemaEncodeError)
        assert.strictEqual(error.boundary, "configuration")
      }))

    it.effect("rejects encoded values that do not match their state schema", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({ NonEmptyIdle })
        const machine = Machine.make({
          states: states.states,
          events: [],
          initial: () => states.initial.NonEmptyIdle(new NonEmptyIdle({ userId: "user-1" }))
        })

        const error = yield* Machine.decodeSnapshot(machine, {
          _tag: "MachineSnapshot",
          active: [{
            path: "NonEmptyIdle",
            value: { _tag: "NonEmptyIdle", userId: "" }
          }]
        }).pipe(Effect.flip)

        assertMachineSchemaDecodeError(error, "state", { state: "NonEmptyIdle" })
      }))

    it.effect("rejects encoded configurations with invalid state relationships", () =>
      Effect.gen(function*() {
        const states = Machine.defineStates({
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
          events: [],
          initial: () =>
            states.initial.payment(
              new Payment({ id: "payment-1" }),
              (payment) => payment.entering(new EnteringPayment({ amount: 1 }))
            )
        })

        const error = yield* Machine.decodeSnapshot(machine, {
          _tag: "MachineSnapshot",
          active: [{
            path: "payment.entering",
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
        events: [Submit],
        input: Input,
        initial: (input) => LowercaseInitial.idle(new Idle({ userId: input.userId }))
      }).handle({
        idle: {
          on: {
            Submit: ({ event, state, target }) =>
              target.full.loading(new Loading({ requestId: `${state.userId}:${event.value}` }))
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
        events: [Submit, Reset],
        initial: () => DuplicateInitial.a(new Duplicate({ value: "a" }))
      }).handle({
        a: {
          on: {
            Submit: ({ event, target }) => target.full.b(new Duplicate({ value: event.value }))
          }
        },
        b: {
          on: {
            Reset: ({ target }) => target.full.a(new Duplicate({ value: "reset" }))
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      assertStateSnapshot(initial.state, "a", new Duplicate({ value: "a" }))
      assert.deepStrictEqual(Machine.enabled(machine, initial.state), ["Submit"])
      assert.deepStrictEqual(
        Machine.enabled(machine, {
          path: "b",
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
        events: [Submit],
        initial: () => DuplicateInitial.a(new Duplicate({ value: "a" }))
      }).handle({
        a: {
          on: {
            Submit: ({ event, target }) => target.full.b(new Duplicate({ value: event.value }))
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
        events: [Submit],
        initial: () => LowercaseInitial.idle(new Idle({ userId: "user-1" }))
      }).handle({
        idle: {
          on: {
            Submit: ({ event, target }) => target.full.success(new Success({ requestId: event.value }))
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
        events: [Authorize],
        initial: () => ({
          path: "payment",
          value: payment,
          state: {
            path: "payment.entering" as const,
            value: entering
          }
        })
      }).handle({
        payment: {
          on: {
            Authorize: ({ target }) => target.full.failed(new Failed({ message: "parent" }))
          },
          states: {
            entering: {
              on: {
                Authorize: ({ event, parent, parents, target }) => {
                  assert.deepStrictEqual(parent, payment)
                  assert.deepStrictEqual(parents, { payment })
                  return target.local.authorized(new AuthorizedPayment({ code: event.code }))
                }
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
        events: [Authorize, Reset],
        initial: () => ({
          path: "payment",
          value: payment,
          state: {
            path: "payment.entering" as const,
            value: entering
          }
        })
      }).handle({
        payment: {
          on: {
            Reset: ({ target }) => target.full.failed(new Failed({ message: "reset" }))
          },
          states: {
            entering: {
              on: {
                Authorize: ({ event, target }) => target.local.authorized(new AuthorizedPayment({ code: event.code }))
              }
            },
            authorized: {
              output: ({ parents, state }) => {
                assert.deepStrictEqual(parents, { payment })
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
        events: [Reset],
        initial: () => ({
          path: "payment",
          value: payment,
          state: {
            path: "payment.entering" as const,
            value: entering
          }
        })
      }).handle({
        payment: {
          on: {
            Reset: ({ target }) => target.full.idle(new Idle({ userId: "user-1" }))
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
      const states = Machine.defineStates({
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
        events: [Submit],
        initial: () => states.initial.idle(new Idle({ userId: "user-1" }))
      }).handle({
        idle: {
          on: {
            Submit: ({ event, target }) =>
              target.full.fulfillment(
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
          }
        }
      })

      const planned = yield* Machine.plan(
        machine,
        states.initial.idle(new Idle({ userId: "user-1" })),
        new Submit({ value: "order-1" })
      )

      assertParallelStateSnapshot(planned.next as any, "fulfillment", new Fulfillment({ id: "order-1" }), {
        inventory: {
          path: "fulfillment.inventory",
          value: new Inventory({ warehouse: "warehouse-1" }),
          state: {
            path: "fulfillment.inventory.reserved",
            value: new InventoryReserved({ reservationId: "order-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping",
          value: new Shipping({ address: "Main Street" }),
          state: {
            path: "fulfillment.shipping.quoted",
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
      const states = Machine.defineStates({
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
        events: [Submit],
        initial: () =>
          states.initial.workflow(
            workflow,
            (workflow) => workflow.idle(new Idle({ userId: "user-1" }))
          )
      }).handle({
        workflow: {
          states: {
            idle: {
              on: {
                Submit: ({ event, target }) =>
                  target.local.fulfillment(
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
              }
            }
          }
        }
      })

      const planned = yield* Machine.plan(
        machine,
        states.initial.workflow(
          workflow,
          (workflow) => workflow.idle(new Idle({ userId: "user-1" }))
        ),
        new Submit({ value: "order-1" })
      )

      assertCompoundStateSnapshot(planned.next as any, "workflow", workflow, {
        path: "workflow.fulfillment",
        value: new Fulfillment({ id: "order-1" }),
        states: {
          inventory: {
            path: "workflow.fulfillment.inventory",
            value: new Inventory({ warehouse: "warehouse-1" }),
            state: {
              path: "workflow.fulfillment.inventory.reserved",
              value: new InventoryReserved({ reservationId: "order-1" })
            }
          },
          shipping: {
            path: "workflow.fulfillment.shipping",
            value: new Shipping({ address: "Main Street" }),
            state: {
              path: "workflow.fulfillment.shipping.quoted",
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
      const states = Machine.defineStates({
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
      const initial = states.initial.app(
        app,
        (app) =>
          app
            .flow(
              flow,
              (flow) => flow.idle(new Idle({ userId: "user-1" }))
            )
            .monitor(monitor)
      )
      const machine = Machine.make({
        states: states.states,
        events: [Submit],
        initial: () => initial
      }).handle({
        app: {
          states: {
            flow: {
              states: {
                idle: {
                  on: {
                    Submit: ({ event, target }) =>
                      target.branch.app.flow.fulfillment(
                        new Fulfillment({ id: event.value }),
                        (fulfillment) =>
                          fulfillment
                            .inventory(new Inventory({ warehouse: "warehouse-1" }))
                            .shipping(new Shipping({ address: "Main Street" }))
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
          path: "app.flow",
          value: flow,
          state: {
            path: "app.flow.fulfillment",
            value: new Fulfillment({ id: "order-1" }),
            states: {
              inventory: {
                path: "app.flow.fulfillment.inventory",
                value: new Inventory({ warehouse: "warehouse-1" })
              },
              shipping: {
                path: "app.flow.fulfillment.shipping",
                value: new Shipping({ address: "Main Street" })
              }
            }
          }
        },
        monitor: {
          path: "app.monitor",
          value: monitor
        }
      })
    }))

  it.effect("uses target.local to preserve parent and sibling parallel region values", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({
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
        events: [ReserveInventory],
        initial: () =>
          states.initial.fulfillment(
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
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: ({ event, target }) =>
                      target.local.reserved(new InventoryReserved({ reservationId: event.reservationId }))
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
          path: "fulfillment.inventory",
          value: inventory,
          state: {
            path: "fulfillment.inventory.reserved",
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping",
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting",
            value: quoting
          }
        }
      })
    }))

  it.effect("uses target.local.with to replace the local compound value", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({
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
        events: [ReserveInventory],
        initial: () =>
          states.initial.fulfillment(
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
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: ({ event, target }) =>
                      target.local.with(
                        nextInventory,
                        (inventory) => inventory.reserved(new InventoryReserved({ reservationId: event.reservationId }))
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
          path: "fulfillment.inventory",
          value: nextInventory,
          state: {
            path: "fulfillment.inventory.reserved",
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping",
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting",
            value: quoting
          }
        }
      })
    }))

  it.effect("uses target.branch to replace one parallel region while preserving siblings", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({
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
        events: [ReserveInventory],
        initial: () =>
          states.initial.fulfillment(
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
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: ({ event, target }) =>
                      target.branch.fulfillment.inventory(
                        nextInventory,
                        (inventory) => inventory.reserved(new InventoryReserved({ reservationId: event.reservationId }))
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
          path: "fulfillment.inventory",
          value: nextInventory,
          state: {
            path: "fulfillment.inventory.reserved",
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping",
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting",
            value: quoting
          }
        }
      })
    }))

  it.effect("uses target.branch to replace root and nested region values", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({
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
        events: [ReserveInventory],
        initial: () =>
          states.initial.fulfillment(
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
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: ({ event, target }) =>
                      target.branch.fulfillment(
                        nextFulfillment,
                        (fulfillment) =>
                          fulfillment.inventory(
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

      assertParallelStateSnapshot(planned.next as any, "fulfillment", nextFulfillment, {
        inventory: {
          path: "fulfillment.inventory",
          value: nextInventory,
          state: {
            path: "fulfillment.inventory.reserved",
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping",
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting",
            value: quoting
          }
        }
      })
    }))

  it.effect("uses target.branch from a compound descendant to a sibling descendant", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({
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
        events: [ReserveInventory],
        initial: () =>
          states.initial.payment(
            payment,
            (payment) =>
              payment.inventory(
                inventory,
                (inventory) => inventory.checking(new CheckingInventory({ sku: "sku-1" }))
              )
          )
      }).handle({
        payment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: ({ event, target }) =>
                      target.branch.payment.shipping(
                        shipping,
                        (shipping) => shipping.quoted(new ShippingQuoted({ quoteId: event.reservationId }))
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
        path: "payment.shipping",
        value: shipping,
        state: {
          path: "payment.shipping.quoted",
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
        events: [Authorize, Reset],
        initial: () => ({
          path: "payment",
          value: payment,
          state: {
            path: "payment.entering" as const,
            value: new EnteringPayment({ amount: 100 })
          }
        })
      }).handle({
        payment: {
          on: {
            Reset: ({ target }) => target.local.entering(new EnteringPayment({ amount: 0 }))
          },
          states: {
            entering: {
              on: {
                Authorize: ({ event, target }) => target.local.authorized(new AuthorizedPayment({ code: event.code }))
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
        events: [Reset],
        initial: () => ({
          path: "payment",
          value: payment,
          state: {
            path: "payment.authorized" as const,
            value: authorized
          }
        })
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
        events: [Authorize, Reset],
        initial: () => ({
          path: "payment",
          value: payment,
          state: {
            path: "payment.entering" as const,
            value: new EnteringPayment({ amount: 100 })
          }
        })
      }).handle({
        payment: {
          on: {
            Reset: ({ target }) => target.full.idle(new Idle({ userId: "user-1" }))
          },
          states: {
            entering: {
              on: {
                Authorize: ({ event, target }) => target.local.authorized(new AuthorizedPayment({ code: event.code }))
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
          path: "payment",
          value: payment,
          state: {
            path: "payment.authorized",
            value: new AuthorizedPayment({ code: "auth-1" })
          },
          completed: [
            { path: "payment.authorized", output: "auth-1" },
            { path: "payment", output: "auth-1" }
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
        events: [ReserveInventory, Reset],
        initial: () => ({
          path: "checkout",
          value: checkout,
          state: {
            path: "checkout.inventory" as const,
            value: inventory,
            state: {
              path: "checkout.inventory.checking" as const,
              value: new CheckingInventory({ sku: "sku-1" })
            }
          }
        })
      }).handle({
        checkout: {
          on: {
            Reset: ({ target }) => target.full.failed(new Failed({ message: "reset" }))
          },
          states: {
            inventory: {
              onDone: ({ output, target }) =>
                target.branch.checkout.shipped(new ShippingQuoted({ quoteId: String(output) })),
              states: {
                checking: {
                  on: {
                    ReserveInventory: ({ event, target }) =>
                      target.local.reserved(new InventoryReserved({ reservationId: event.reservationId }))
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
        path: "checkout.shipped",
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
        events: [ReserveInventory],
        initial: () => ({
          path: "fulfillment",
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
        })
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: ({ event, target }) =>
                      target.local.reserved(new InventoryReserved({ reservationId: event.reservationId }))
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
          path: "fulfillment.inventory",
          value: inventory,
          state: {
            path: "fulfillment.inventory.reserved",
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping",
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoting",
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
        events: [ReserveInventory],
        initial: () => ({
          path: "fulfillment",
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
        })
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
                    ReserveInventory: ({ event, target }) =>
                      target.local.reserved(new InventoryReserved({ reservationId: event.reservationId }))
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
                    ReserveInventory: ({ event, target }) =>
                      target.local.quoted(new ShippingQuoted({ quoteId: event.reservationId }))
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
          path: "fulfillment.inventory",
          value: inventory,
          state: {
            path: "fulfillment.inventory.reserved",
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping",
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoted",
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
        events: [ReserveInventory, Resolve],
        initial: () => ({
          path: "fulfillment",
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
        })
      }).handle({
        fulfillment: {
          output: ({ outputs }) => outputs,
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: ({ event, target }) =>
                      target.local.reserved(new InventoryReserved({ reservationId: event.reservationId }))
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
                    Resolve: ({ target }) => target.local.quoted(new ShippingQuoted({ quoteId: "quote-1" }))
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
        events: [ReserveInventory],
        initial: () => ({
          path: "fulfillment",
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
        })
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: ({ event, target }) =>
                      target.local.reserved(new InventoryReserved({ reservationId: event.reservationId }))
                  }
                }
              }
            },
            shipping: {
              states: {
                quoting: {
                  on: {
                    ReserveInventory: ({ event, target }) =>
                      target.local.quoted(new ShippingQuoted({ quoteId: event.reservationId }))
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
          path: "fulfillment.inventory",
          value: inventory,
          state: {
            path: "fulfillment.inventory.reserved",
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping",
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoted",
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
        events: [ReserveInventory, Resolve],
        initial: () => ({
          path: "fulfillment",
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
        })
      }).handle({
        fulfillment: {
          states: {
            inventory: {
              states: {
                checking: {
                  on: {
                    ReserveInventory: ({ event, target }, enqueue) => {
                      enqueue.raise(new Resolve({}))
                      return target.local.reserved(
                        new InventoryReserved({
                          reservationId: event.reservationId
                        })
                      )
                    }
                  }
                }
              }
            },
            shipping: {
              states: {
                quoting: {
                  on: {
                    Resolve: ({ target }) => target.local.quoted(new ShippingQuoted({ quoteId: "raised" }))
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
          path: "fulfillment.inventory",
          value: inventory,
          state: {
            path: "fulfillment.inventory.reserved",
            value: new InventoryReserved({ reservationId: "res-1" })
          }
        },
        shipping: {
          path: "fulfillment.shipping",
          value: shipping,
          state: {
            path: "fulfillment.shipping.quoted",
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
        events: [Submit],
        initial: () => FlatInitial.Idle(new Idle({ userId: "user-1" }))
      })

      const actor = yield* Machine.start(machine)

      assert.deepStrictEqual((yield* actor.state).value, new Idle({ userId: "user-1" }))
    }))

  it.effect("handlers can return snapshots directly", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading },
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
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
        state: { path: "Loading", value: new Loading({ requestId: "request-1" }) }
      })
    }))

  it("enabled returns the event tags handled by the current state", () => {
    const machine = Machine.make({
      states: { Idle, Loading },
      events: [Submit, Reset],
      input: Input,
      initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
    }).handle({
      Idle: {
        on: {
          Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
        }
      },
      Loading: {
        on: {
          Reset: () => FlatInitial.Idle(new Idle({ userId: "user-1" }))
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
      events: [Submit],
      input: Input,
      initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
    }).handle({
      Idle: {
        on: {
          Submit: () => FlatInitial.Success(new Success({ requestId: "request-1" }))
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
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Success(new Success({ requestId: "request-1" }))
          }
        },
        Success: {
          output: ({ event, state }) => `${state.requestId}:${String(event._tag)}`
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: { path: "Idle", value: new Idle({ userId: "user-1" }) }
      })

      yield* actor.send(new Submit({ value: "hello" }))

      assert.strictEqual(yield* actor.join, "request-1:Submit")
    }))

  it.effect("plans final state output without running deferred actions", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Success: SuccessOutput },
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Success(new Success({ requestId: "request-1" }))
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
        events: [Submit],
        initial: () => FlatInitial.Success(new Success({ requestId: "request-1" }))
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
          path: "Success",
          value: new Success({ requestId: "request-1" }),
          completed: [{ path: "Success", output: "request-1" }]
        },
        output: "request-1"
      })
    }))

  it.effect("preserves completed output when a terminal snapshot is spread and planned again", () =>
    Effect.gen(function*() {
      let outputCalls = 0
      const machine = Machine.make({
        states: { Success: SuccessOutput },
        events: [Submit],
        initial: () => FlatInitial.Success(new Success({ requestId: "request-1" }))
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
      assert.deepStrictEqual(cloned.completed, [{ path: "Success", output: "request-1" }])
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
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Success(new Success({ requestId: "request-1" }))
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
          path: "Success",
          value: new Success({ requestId: "request-1" }),
          completed: [{ path: "Success", output: undefined }]
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
        events: [Submit, Reset],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Success(new Success({ requestId: "request-1" })),
            Reset: () => FlatInitial.Idle(new Idle({ userId: "user-2" }))
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
          path: "Success",
          value: new Success({ requestId: "request-1" }),
          completed: [{ path: "Success", output: undefined }]
        },
        output: undefined
      })
    }))

  it.effect("start keeps the machine alive after the starting fiber completes", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading },
        events: [Submit],
        initial: () => FlatInitial.Idle(new Idle({ userId: "user-1" }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
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
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
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
        state: { path: "Idle", value: new Idle({ userId: "user-1" }) }
      })
    }))

  it.effect("plans no-op transitions from final states", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: {
          Idle,
          Success: { schema: Success, type: "final" }
        },
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Success: {}
      })

      const state = FlatInitial.Success(new Success({ requestId: "request-1" }))
      const planned = yield* Machine.plan(machine, state, new Submit({ value: "hello" }))

      assert.deepStrictEqual(planned.next.value, state.value)
      assert.deepStrictEqual(planned.commands, [])
      assert.deepStrictEqual(planned.microsteps, [])
    }))

  it.effect("handlers can omit returning a state for self-transitions", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading },
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => {}
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
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
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
        state: { path: "Idle", value: new Idle({ userId: "user-1" }) }
      })

      yield* actor.send(new Submit({ value: "hello" }))

      const snapshots = Array.from(yield* Fiber.join(observer))
      assert.deepStrictEqual(snapshots, [{
        status: "active",
        state: { path: "Loading", value: new Loading({ requestId: "request-1" }) }
      }])
      assert.deepStrictEqual((yield* actor.state).value, new Loading({ requestId: "request-1" }))

      yield* actor.stop
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "stopped",
        state: { path: "Loading", value: new Loading({ requestId: "request-1" }) }
      })
    }))

  it.effect("start completes machine output from a final state", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Success: SuccessOutput },
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Success(new Success({ requestId: "request-1" }))
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
          path: "Success",
          value: new Success({ requestId: "request-1" }),
          completed: [{ path: "Success", output: "request-1" }]
        },
        output: "request-1"
      })
    }))

  it.effect("plan ignores events without an enabled transition", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        id: "UserMachine",
        states: { Idle, Loading },
        events: [Submit, Reset],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
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
      const machine = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: [Submit, RequestSucceeded],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
          }
        },
        Loading: {
          invoke: ({ state }) =>
            Machine.invoke({
              id: "request",
              src: () =>
                Machine.effect(
                  Effect.succeed(new RequestSucceeded({ value: `done:${state.requestId}` }))
                )
            }),
          on: {
            RequestSucceeded: ({ event }) => FlatInitial.Success(new Success({ requestId: event.value }))
          }
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
          path: "Success",
          value: new Success({ requestId: "done:request-1" }),
          completed: [{ path: "Success", output: "done:request-1" }]
        },
        output: "done:request-1"
      })
    }))

  it.effect("start invokes a child process and handles its output event", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: [Submit, RequestSucceeded],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
          }
        },
        Loading: {
          invoke: ({ state }) =>
            Machine.invoke({
              id: "request",
              src: () =>
                Machine.effect(
                  Effect.succeed(new RequestSucceeded({ value: `done:${state.requestId}` }))
                )
            }),
          on: {
            RequestSucceeded: ({ event }) => FlatInitial.Success(new Success({ requestId: event.value }))
          }
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
          path: "Success",
          value: new Success({ requestId: "done:request-1" }),
          completed: [{ path: "Success", output: "done:request-1" }]
        },
        output: "done:request-1"
      })
    }))

  it.effect("isolates invoked children across concurrent zero-input starts", () =>
    Effect.gen(function*() {
      const childStates = Machine.defineStates({ Idle })
      const childMachine = Machine.make({
        states: childStates.states,
        events: [],
        initial: () => childStates.initial.Idle(new Idle({ userId: "child" }))
      })
      const Child = Machine.child("shared-child", childMachine)
      const parentStates = Machine.defineStates({ Loading })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: [],
        initial: () => parentStates.initial.Loading(new Loading({ requestId: "parent" }))
      }).handle({
        Loading: {
          invoke: Machine.invokeMachine({ child: Child })
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
        state: { path: "Loading", value: new Loading({ requestId: "parent" }) }
      })
      assert.deepStrictEqual(yield* secondChild.value.snapshot, {
        status: "active",
        state: { path: "Idle", value: new Idle({ userId: "child" }) }
      })
      yield* second.stop
    }))

  it.effect("stops an idle compiled invoked child with its parent", () =>
    Effect.gen(function*() {
      const childStates = Machine.defineStates({ Idle })
      const childMachine = Machine.make({
        states: childStates.states,
        events: [],
        initial: () => childStates.initial.Idle(new Idle({ userId: "child" }))
      }).handle({ Idle: {} })
      const Child = Machine.child("owned-child", childMachine)
      const parentStates = Machine.defineStates({ Loading })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: [],
        initial: () => parentStates.initial.Loading(new Loading({ requestId: "parent" }))
      }).handle({
        Loading: { invoke: Machine.invokeMachine({ child: Child }) }
      })

      const parent = yield* Machine.start(parentMachine)
      const child = yield* parent.child(Child)
      assert(Option.isSome(child))

      yield* parent.stop

      assert.deepStrictEqual(yield* child.value.snapshot, {
        status: "stopped",
        state: { path: "Idle", value: new Idle({ userId: "child" }) }
      })
      assert.instanceOf(yield* Effect.flip(child.value.join), Machine.StoppedError)
      assert(Option.isNone(yield* parent.child(Child)))
    }))

  it.effect("evaluates precompiled input-bearing invoked children for every start", () =>
    Effect.gen(function*() {
      let starts = 0
      const childStates = Machine.defineStates({ Idle })
      const childMachine = Machine.make({
        states: childStates.states,
        events: [],
        input: Input,
        initial: (input) => {
          starts += 1
          return childStates.initial.Idle(new Idle({ userId: input.userId }))
        }
      }).handle({ Idle: {} })
      const Child = Machine.child("input-child", childMachine)
      const parentStates = Machine.defineStates({ Loading })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: [],
        initial: () => parentStates.initial.Loading(new Loading({ requestId: "parent" }))
      }).handle({
        Loading: {
          invoke: Machine.invokeMachine({ child: Child, input: { userId: "configured" } })
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
        path: "Idle",
        value: new Idle({ userId: "configured" })
      })
      yield* Effect.all([first.stop, second.stop], { concurrency: "unbounded" })
    }))

  it.effect("delivers completion from an initially final compiled child", () =>
    Effect.gen(function*() {
      class ChildFinished extends Schema.TaggedClass<ChildFinished>("ChildFinished")("ChildFinished", {
        output: Schema.String
      }) {}
      const childStates = Machine.defineStates({
        Success: { schema: Success, type: "final", output: Schema.String }
      })
      const childMachine = Machine.make({
        states: childStates.states,
        events: [],
        initial: () => childStates.initial.Success(new Success({ requestId: "child-output" }))
      }).handle({
        Success: { output: ({ state }) => state.requestId }
      })
      const Child = Machine.child("final-child", childMachine)
      const parentStates = Machine.defineStates({
        Loading,
        Success: { schema: Success, type: "final", output: Schema.String }
      })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: [ChildFinished],
        initial: () => parentStates.initial.Loading(new Loading({ requestId: "parent" }))
      }).handle({
        Loading: {
          invoke: Machine.invokeMachine({
            child: Child,
            onDone: ({ output }) => new ChildFinished({ output })
          }),
          on: {
            ChildFinished: ({ event, target }) => target.full.Success(new Success({ requestId: event.output }))
          }
        },
        Success: { output: ({ state }) => state.requestId }
      })

      const parent = yield* Machine.start(parentMachine)

      assert.strictEqual(yield* parent.join, "child-output")
    }))

  it.effect("keeps input-bearing process descriptors instance-specific", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({ Idle })
      const machine = Machine.make({
        states: states.states,
        events: [],
        input: Input,
        initial: (input) => states.initial.Idle(new Idle({ userId: input.userId }))
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
        path: "Idle",
        value: new Idle({ userId: "first" })
      })
      assert.deepStrictEqual(yield* second.state, {
        path: "Idle",
        value: new Idle({ userId: "second" })
      })
      yield* Effect.all([first.stop, second.stop], { concurrency: "unbounded" })
    }))

  it.effect("invokeMachine rejects duplicate active child addresses", () =>
    Effect.gen(function*() {
      const childStates = Machine.defineStates({ Idle })
      const child = Machine.make({
        states: childStates.states,
        events: [],
        initial: () => childStates.initial.Idle(new Idle({ userId: "child" }))
      })
      const Child = Machine.child("child-machine", child)
      const parentStates = Machine.defineStates({ Loading })
      const parent = Machine.make({
        states: parentStates.states,
        events: [],
        initial: () => parentStates.initial.Loading(new Loading({ requestId: "request-1" }))
      }).handle({
        Loading: {
          invoke: [
            Machine.invokeMachine({ child: Child }),
            Machine.invokeMachine({ child: Child })
          ]
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
        return Machine.effect(Effect.never)
      }
      const parentStates = Machine.defineStates({ Loading })
      const parent = Machine.make({
        states: parentStates.states,
        events: [],
        initial: () => parentStates.initial.Loading(new Loading({ requestId: "request-1" }))
      }).handle({
        Loading: {
          invoke: [
            Machine.invoke({
              id: "worker",
              address: First,
              src: source
            }),
            Machine.invoke({
              id: "worker",
              address: Second,
              src: source
            })
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
        events: [Submit, RequestFailed],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
          }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "request",
            src: () =>
              Machine.effect(
                Effect.fail(error).pipe(
                  Effect.catch((error) => Effect.succeed(new RequestFailed({ error, cause: Cause.fail(error) })))
                )
              )
          }),
          on: {
            RequestFailed: ({ event }) => FlatInitial.Failed(new Failed({ message: event.error.message }))
          }
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
          path: "Failed",
          value: new Failed({ message: "boom" }),
          completed: [{ path: "Failed", output: "boom" }]
        },
        output: "boom"
      })
    }))

  it.effect("start delivers internal invoke events without exposing them through send", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: [Submit],
        internalEvents: [RequestSucceeded],
        initial: () => FlatInitial.Idle(new Idle({ userId: "user-1" }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
          }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "request",
            src: () => Machine.effect(Effect.succeed(new RequestSucceeded({ value: "loaded" })))
          }),
          on: {
            RequestSucceeded: ({ event }) => FlatInitial.Success(new Success({ requestId: event.value }))
          }
        },
        Success: {
          output: ({ state }) => state.requestId
        }
      })

      const actor = yield* Machine.start(machine)
      yield* actor.send(new Submit({ value: "start" }))

      assert.strictEqual(yield* actor.join, "loaded")
    }))

  it.effect("routes sendParent from an active invoked machine", () =>
    Effect.gen(function*() {
      const childStarted = yield* Deferred.make<void>()
      const machine = Machine.make({
        states: { Loading, Success: SuccessOutput },
        events: [RequestSucceeded],
        initial: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
      }).handle({
        Loading: {
          invoke: Machine.invoke({
            id: "request",
            src: () =>
              Machine.logic({
                initial: undefined,
                run: ({ sendParent }) =>
                  Deferred.succeed(childStarted, void 0).pipe(
                    Effect.andThen(sendParent(new RequestSucceeded({ value: "child" }))),
                    Effect.andThen(Effect.never)
                  )
              })
          }),
          on: {
            RequestSucceeded: ({ event }) => FlatInitial.Success(new Success({ requestId: event.value }))
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

  it.effect("drops sendParent from a stale invoked machine finalizer", () =>
    Effect.gen(function*() {
      const childStarted = yield* Deferred.make<void>()
      const machine = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: [Resolve, RequestSucceeded],
        initial: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
      }).handle({
        Idle: {
          on: {
            RequestSucceeded: ({ event }) => FlatInitial.Success(new Success({ requestId: event.value }))
          }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "request",
            src: () =>
              Machine.logic({
                initial: undefined,
                run: ({ sendParent }) =>
                  Deferred.succeed(childStarted, void 0).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => sendParent(new RequestSucceeded({ value: "stale" })))
                  )
              })
          }),
          on: {
            Resolve: () => FlatInitial.Idle(new Idle({ userId: "resolved" }))
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
        state: { path: "Idle", value: new Idle({ userId: "resolved" }) }
      })
      yield* actor.stop
    }))

  it.effect("invokeEffect maps typed failures without manual Effect recovery", () =>
    Effect.gen(function*() {
      const failure = new InvokeError({ message: "unavailable" })
      const machine = Machine.make({
        states: { Loading, Failed: FailedOutput },
        events: [],
        internalEvents: [RequestSucceeded, RequestFailed],
        initial: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
      }).handle({
        Loading: {
          invoke: Machine.invokeEffect({
            id: "request",
            effect: Effect.fail(failure),
            onSuccess: (value: string) => new RequestSucceeded({ value }),
            onFailure: (error) => new RequestFailed({ error, cause: Cause.fail(error) })
          }),
          on: {
            RequestSucceeded: ({ event }) => FlatInitial.Failed(new Failed({ message: event.value })),
            RequestFailed: ({ event }) => FlatInitial.Failed(new Failed({ message: event.error.message }))
          }
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
        events: [],
        internalEvents: [RequestSucceeded],
        initial: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
      }).handle({
        Loading: {
          invoke: Machine.invokeEffect({
            id: "request",
            effect: requiredMessage,
            onSuccess: (value: string) => new RequestSucceeded({ value })
          }),
          on: {
            RequestSucceeded: ({ event }) => FlatInitial.Success(new Success({ requestId: event.value }))
          }
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
        events: [],
        internalEvents: [RequestSucceeded],
        initial: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
      }).handle({
        Loading: {
          invoke: Machine.after("1 hour", new RequestSucceeded({ value: "timeout" })),
          on: {
            RequestSucceeded: ({ event }) => FlatInitial.Success(new Success({ requestId: event.value }))
          }
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
      const machine = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: [Submit, RequestProgress],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
          }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "request",
            src: () => Machine.logic({ initial: "pending", run: () => Effect.never }),
            snapshot: ({ id, snapshot }) => new RequestProgress({ id, childState: snapshot.state })
          }),
          on: {
            RequestProgress: ({ event }) =>
              FlatInitial.Success(new Success({ requestId: `${event.id}:${event.childState}` }))
          }
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
          path: "Success",
          value: new Success({ requestId: "request:pending" }),
          completed: [{ path: "Success", output: "request:pending" }]
        },
        output: "request:pending"
      })
    }))

  it.effect("start fails the owning machine when an invoked effect failure is not recovered", () =>
    Effect.gen(function*() {
      const error = new InvokeError({ message: "boom" })
      const machine = Machine.make({
        states: { Idle, Loading },
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
          }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "request",
            src: () => Machine.effect(Effect.fail(error))
          })
        }
      })

      const ref = yield* Machine.start(machine, { userId: "user-1" })
      yield* ref.send(new Submit({ value: "hello" }))

      assert.strictEqual(yield* Effect.flip(ref.join), error)
      const snapshot = yield* ref.snapshot
      assert.strictEqual(snapshot.status, "error")
      assert.deepStrictEqual(snapshot.state, {
        path: "Loading",
        value: new Loading({ requestId: "request-1" })
      })
    }))

  it.effect("start lets invoke snapshot mappers filter with undefined", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const machine = Machine.make({
        states: { Idle, Loading, Success: SuccessOutput },
        events: [Submit, RequestProgress],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
          }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "request",
            src: () =>
              Machine.logic({
                initial: "pending",
                run: ({ setState }) =>
                  Deferred.succeed(started, void 0).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(setState("ready")),
                    Effect.andThen(Effect.never)
                  )
              }),
            snapshot: ({ id, snapshot }) =>
              snapshot.state === "ready" ? new RequestProgress({ id, childState: snapshot.state }) : undefined
          }),
          on: {
            RequestProgress: ({ event }) => FlatInitial.Success(new Success({ requestId: event.childState }))
          }
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
        state: { path: "Loading", value: new Loading({ requestId: "request-1" }) }
      })

      yield* Deferred.succeed(release, void 0)

      assert.strictEqual(yield* actor.join, "ready")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "Success",
          value: new Success({ requestId: "ready" }),
          completed: [{ path: "Success", output: "ready" }]
        },
        output: "ready"
      })
    }))

  it.effect("start allows invoked children without a snapshot mapper", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle, Loading },
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
          }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "request",
            src: () =>
              Machine.logic({
                initial: "pending",
                run: () => Effect.void
              })
          })
        }
      })

      const actor = yield* Machine.start(machine, { userId: "user-1" })

      yield* actor.send(new Submit({ value: "hello" }))
      yield* Effect.yieldNow

      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "active",
        state: { path: "Loading", value: new Loading({ requestId: "request-1" }) }
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
        events: [Submit, Resolve, RequestSucceeded],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
          }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "request",
            src: () => childLogic
          }),
          on: {
            Resolve: () => FlatInitial.Success(new Success({ requestId: "request-1" })),
            RequestSucceeded: ({ event }) => FlatInitial.Success(new Success({ requestId: event.value }))
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
        state: { path: "Loading", value: new Loading({ requestId: "request-1" }) }
      })

      yield* Deferred.succeed(releaseChildStop, void 0)

      assert.strictEqual(yield* Fiber.join(joinFiber), "request-1")
      assert.deepStrictEqual(yield* actor.snapshot, {
        status: "done",
        state: {
          path: "Success",
          value: new Success({ requestId: "request-1" }),
          completed: [{ path: "Success", output: "request-1" }]
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
        events: [Authorize],
        initial: () => ({
          path: "payment",
          value: payment,
          state: {
            path: "payment.entering" as const,
            value: entering
          }
        })
      }).handle({
        payment: {
          invoke: Machine.invoke({
            id: "request",
            src: () => makeInvokeLogic("parent", parentStarted)
          }),
          states: {
            entering: {
              invoke: ({ parents, state }) => {
                assert.deepStrictEqual(state, entering)
                assert.deepStrictEqual(parents, { payment })
                return Machine.invoke({
                  id: "request",
                  src: () => makeInvokeLogic("entering", enteringStarted)
                })
              },
              on: {
                Authorize: ({ event, target }) => target.local.authorized(new AuthorizedPayment({ code: event.code }))
              }
            },
            authorized: {
              invoke: Machine.invoke({
                id: "request",
                src: () => makeInvokeLogic("authorized", authorizedStarted)
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
        events: [ReserveInventory],
        initial: () => ({
          path: "fulfillment",
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
        })
      }).handle({
        fulfillment: {
          invoke: Machine.invoke({
            id: "request",
            src: () => makeInvokeLogic(parentStarted, parentStopping)
          }),
          states: {
            inventory: {
              invoke: Machine.invoke({
                id: "request",
                src: () => makeInvokeLogic(inventoryStarted, inventoryStopping)
              }),
              states: {
                checking: {
                  on: {
                    ReserveInventory: ({ target }) => target.full.success(new Success({ requestId: "done" }))
                  }
                }
              }
            },
            shipping: {
              invoke: Machine.invoke({
                id: "request",
                src: () => makeInvokeLogic(shippingStarted, shippingStopping)
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
        events: [],
        initial: () => {
          throw defect
        }
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
      const states = Machine.defineStates({
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
        path: "payment",
        value: new Payment({ id: "payment-1" }),
        state: {
          path: "payment.authorized",
          value: new AuthorizedPayment({ code: "authorization-1" })
        }
      }
      const machine = Machine.make({
        states: states.states,
        events: [],
        initial: () => invalidInitialState as any
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
        events: [Submit],
        input: Input,
        initial: (input) => FlatInitial.Idle(new Idle({ userId: input.userId }))
      }).handle({
        Idle: {
          always: () => FlatInitial.Loading(new Loading({ requestId: "request-1" })),
          on: {
            Submit: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
          }
        },
        Loading: {
          always: () => FlatInitial.Idle(new Idle({ userId: "user-1" }))
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
        events: [],
        initial: () => FlatInitial.Idle(new Idle({ userId: "user-1" }))
      }).handle({
        Idle: {
          always: () => FlatInitial.Loading(new Loading({ requestId: "request-1" }))
        },
        Loading: {
          always: () => FlatInitial.Idle(new Idle({ userId: "user-1" }))
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
      const states = Machine.defineStates({
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
        events: [Submit],
        initial: () => states.initial.idle(new Idle({ userId: "user-1" }))
      }).handle({
        idle: {
          on: {
            Submit: () =>
              states.initial.flow(
                new Loading({ requestId: "request-1" }),
                (flow) => flow.done(new Success({ requestId: "request-1" }))
              )
          }
        },
        flow: {
          onDone: ({ state, target }) =>
            target.full.flow(
              state,
              (flow) => flow.done(new Success({ requestId: state.requestId }))
            )
        }
      })

      const error = yield* Effect.flip(
        Machine.plan(
          machine,
          states.initial.idle(new Idle({ userId: "user-1" })),
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

  const ParallelCounterStates = Machine.defineStates({
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
      events: [AdvanceCounters],
      initial: () =>
        ParallelCounterStates.initial.running(
          new CounterRunning({}),
          (running) => running.left(new LeftCounter({ value: 0 })).right(new RightCounter({ value: 0 }))
        )
    }).handle({
      running: {
        states: {
          left: {
            on: {
              AdvanceCounters: ({ state, target }) =>
                target.branch.running.left(new LeftCounter({ value: state.value + 1 }))
            }
          },
          right: {
            on: {
              AdvanceCounters: ({ state, target }) =>
                target.branch.running.right(new RightCounter({ value: state.value + 1 }))
            }
          }
        }
      }
    })

  const makeConcurrentMachine = () => {
    const states = Machine.defineStates({ ConcurrentIdle })
    return Machine.make({
      states: states.states,
      events: [ConcurrentPing],
      initial: () => states.initial.ConcurrentIdle(new ConcurrentIdle({}))
    }).handle({
      ConcurrentIdle: {
        on: {
          ConcurrentPing: () => {}
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
        state: { path: "ConcurrentIdle", value: new ConcurrentIdle({}) }
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
