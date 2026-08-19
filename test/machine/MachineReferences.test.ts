import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"

const collectNext = <A>(stream: Stream.Stream<A>) =>
  stream.pipe(Stream.take(1), Stream.runCollect, Effect.map(Array.from), Effect.forkChild({ startImmediately: true }))

describe("machine reference event channels", () => {
  it("constructs immutable required and optional parent declarations", () => {
    class Notice extends Schema.TaggedClass<Notice>("ParentDeclarationNotice")("Notice", {}) {}
    const Events = Machine.events(Notice)
    const required = Machine.parent(Events)
    const optional = Machine.optionalParent(Events)

    assert.deepStrictEqual({ mode: required.mode, events: required.events }, { mode: "required", events: Events })
    assert.deepStrictEqual({ mode: optional.mode, events: optional.events }, { mode: "optional", events: Events })
    assert.isTrue(Object.isFrozen(required))
    assert.isTrue(Object.isFrozen(optional))
  })

  it.effect("observes initial emissions through a prepared machine", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("PreparedEmissionIdle")("Idle", {}) {}
      class Ready extends Schema.TaggedClass<Ready>("PreparedEmissionReady")("Ready", {}) {}

      const states = Machine.states({ Idle })
      const Emissions = Machine.emittedEvents(Ready)
      let initializations = 0
      const machine = Machine.make({
        id: "prepared-emission",
        states: states.states,
        events: Machine.events(),
        emittedEvents: Emissions,
        initial: (to) =>
          to.Idle().resolve(({ target }) => {
            initializations += 1
            return target(new Idle({}))
          })
      }).handle({
        Idle: {
          entry: (_, enqueue) => {
            enqueue.emit(Emissions.Ready())
            return undefined
          }
        }
      })

      const prepared = yield* Machine.prepare(machine)
      assert.strictEqual(initializations, 0)
      assert.strictEqual(prepared.id, "prepared-emission")

      const emitted = yield* collectNext(prepared.emissions)
      const changed = yield* prepared.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      const [first, second] = yield* Effect.all(
        [prepared.start, prepared.start],
        { concurrency: 2 }
      )

      assert.strictEqual(first, second)
      assert.strictEqual(first.id, prepared.id)
      assert.strictEqual(first.sessionId, prepared.sessionId)
      assert.strictEqual(initializations, 1)
      assert.deepStrictEqual(Array.from(yield* Fiber.join(emitted)), [new Ready({})])
      assert.deepStrictEqual(Array.from(yield* Fiber.join(changed)).map(({ state }) => state.path), ["Idle"])

      yield* first.stop
      assert.deepStrictEqual(Array.from(yield* Stream.runCollect(prepared.emissions)), [])
    }))

  it.effect("fails prepared startup when an initial emission is invalid", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("PreparedInvalidIdle")("Idle", {}) {}
      class Published extends Schema.TaggedClass<Published>("PreparedInvalidPublished")("Published", {
        value: Schema.Number
      }) {}
      const states = Machine.states({ Idle })
      const Emissions = Machine.emittedEvents(Published)
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        emittedEvents: Emissions,
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({})))
      }).handle({
        Idle: {
          entry: (_, enqueue) => {
            enqueue.emit(Emissions.Published({ value: "invalid" } as never))
            return undefined
          }
        }
      })

      const prepared = yield* Machine.prepare(machine)
      const observed = yield* prepared.emissions.pipe(
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      const error = yield* Effect.flip(prepared.start)

      assert.instanceOf(error, Machine.MachineSchemaDecodeError)
      assert.strictEqual(error.boundary, "emission")
      assert.deepStrictEqual(Array.from(yield* Fiber.join(observed)), [])
    }))

  it.effect("publishes root emissions as a hot, non-replayed Effect Stream", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("EmissionRootIdle")("Idle", {}) {}
      class Publish extends Schema.TaggedClass<Publish>("EmissionRootPublish")("Publish", {
        value: Schema.Number
      }) {}
      class Published extends Schema.TaggedClass<Published>("EmissionRootPublished")("Published", {
        value: Schema.Number
      }) {}

      const states = Machine.states({ Idle })
      const Events = Machine.events(Publish)
      const Emissions = Machine.emittedEvents(Published)
      const machine = Machine.make({
        states: states.states,
        events: Events,
        emittedEvents: Emissions,
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({})))
      }).handle({
        Idle: {
          on: {
            Publish: (to) =>
              to.none.resolve(({ event }, enqueue) => {
                enqueue.emit(Emissions.Published({ value: event.value }))
                return undefined
              })
          }
        }
      })

      const ref = yield* Machine.start(machine)
      const early = yield* ref.emissions.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.map(Array.from),
        Effect.forkChild({ startImmediately: true })
      )
      const first = yield* collectNext(ref.emissions)
      yield* ref.send(Events.Publish({ value: 1 }))
      yield* Fiber.join(first)

      const late = yield* collectNext(ref.emissions)
      yield* ref.send(Events.Publish({ value: 2 }))

      const earlyValues = yield* Fiber.join(early)
      const lateValues = yield* Fiber.join(late)
      assert.deepStrictEqual((earlyValues as Array<Published>).map(({ value }) => value), [1, 2])
      assert.deepStrictEqual((lateValues as Array<Published>).map(({ value }) => value), [2])

      yield* ref.stop
      assert.deepStrictEqual(Array.from(yield* Stream.runCollect(ref.emissions)), [])
    }))

  it.effect("fails the machine with a typed error when an emission cannot be decoded", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("InvalidEmissionIdle")("Idle", {}) {}
      class Publish extends Schema.TaggedClass<Publish>("InvalidEmissionPublish")("Publish", {}) {}
      class Published extends Schema.TaggedClass<Published>("InvalidEmissionPublished")("Published", {
        value: Schema.Number
      }) {}

      const states = Machine.states({ Idle })
      const Events = Machine.events(Publish)
      const Emissions = Machine.emittedEvents(Published)
      const machine = Machine.make({
        states: states.states,
        events: Events,
        emittedEvents: Emissions,
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({})))
      }).handle({
        Idle: {
          on: {
            Publish: (to) =>
              to.none.resolve((_, enqueue) => {
                enqueue.emit(Emissions.Published({ value: "invalid" } as never))
                return undefined
              })
          }
        }
      })

      const ref = yield* Machine.start(machine)
      const observed = yield* ref.emissions.pipe(
        Stream.runCollect,
        Effect.map(Array.from),
        Effect.forkChild({ startImmediately: true })
      )
      yield* ref.send(Events.Publish())
      const error = yield* Effect.flip(ref.join)

      assert.instanceOf(error, Machine.MachineSchemaDecodeError)
      assert.strictEqual(error.boundary, "emission")
      assert.strictEqual(error.event, "Published")
      assert.deepStrictEqual(yield* Fiber.join(observed), [])
    }))

  it.effect("keeps an optional parent reference available to root and child runtimes", () =>
    Effect.gen(function*() {
      class Waiting extends Schema.TaggedClass<Waiting>("ParentEventsWaiting")("Waiting", {}) {}
      class Reported extends Schema.TaggedClass<Reported>("ParentEventsReported")("Reported", {}) {}
      class Trigger extends Schema.TaggedClass<Trigger>("ParentEventsTrigger")("Trigger", {}) {}
      class ChildReported extends Schema.TaggedClass<ChildReported>("ParentEventsChildReported")("ChildReported", {
        value: Schema.Number
      }) {}
      class Notice extends Schema.TaggedClass<Notice>("ParentEventsNotice")("Notice", {
        value: Schema.Number
      }) {}
      class Awaiting extends Schema.TaggedClass<Awaiting>("ParentEventsAwaiting")("Awaiting", {}) {}
      class Finished extends Schema.TaggedClass<Finished>("ParentEventsFinished")("Finished", {
        source: Schema.String
      }) {}

      const ParentEvents = Machine.events(ChildReported)
      const ChildEvents = Machine.events(Trigger)
      const ChildEmissions = Machine.emittedEvents(Notice)
      const childStates = Machine.states({ Waiting, Reported })
      let rootHadParent = true
      const childMachine = Machine.make({
        states: childStates.states,
        events: ChildEvents,
        parent: Machine.optionalParent(ParentEvents),
        emittedEvents: ChildEmissions,
        initial: (to) => to.Waiting().resolve(({ target }) => target(new Waiting({})))
      }).handle({
        Waiting: {
          on: {
            Trigger: (to) =>
              to.full.Reported().resolve(({ parent, target }, enqueue) => {
                rootHadParent = parent !== undefined
                enqueue.emit(ChildEmissions.Notice({ value: 1 }))
                if (parent !== undefined) {
                  enqueue.sendTo(parent, ParentEvents.ChildReported({ value: 1 }))
                }
                return target(new Reported({}))
              })
          }
        },
        Reported: {}
      })
      assert.strictEqual(childMachine.parent?.mode, "optional")

      const root = yield* Machine.start(childMachine)
      const rootChanged = yield* root.changes.pipe(
        Stream.filter((snapshot) => snapshot.state.path === "Reported"),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild({ startImmediately: true })
      )
      yield* root.send(ChildEvents.Trigger())
      yield* Fiber.join(rootChanged)
      assert.isFalse(rootHadParent)
      yield* root.stop

      const Child = Machine.child("reporter", childMachine)
      const parentStates = Machine.states({
        Awaiting,
        Finished: { schema: Finished, type: "final", output: Schema.String }
      })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: Machine.events(ParentEvents, Notice),
        initial: (to) => to.Awaiting().resolve(({ target }) => target(new Awaiting({})))
      }).handle({
        Awaiting: {
          invoke: (from) => from.child(Child),
          on: {
            ChildReported: (to) =>
              to.full.Finished().resolve(({ target }) => target(new Finished({ source: "parent event" }))),
            Notice: (to) => to.full.Finished().resolve(({ target }) => target(new Finished({ source: "emission" })))
          }
        },
        Finished: { output: ({ state }) => state.source }
      })

      const parent = yield* Machine.start(parentMachine)
      const child = Option.getOrThrow(yield* parent.child(Child))
      const notice = yield* collectNext(child.emissions)
      yield* child.send(ChildEvents.Trigger())

      const notices = yield* Fiber.join(notice)
      assert.deepStrictEqual((notices as Array<Notice>).map(({ value }) => value), [1])
      assert.strictEqual(yield* parent.join, "parent event")
    }))

  it.effect("types and delivers parent input from an invocation source", () =>
    Effect.gen(function*() {
      class ChildIdle extends Schema.TaggedClass<ChildIdle>("BoundInvokeChildIdle")("ChildIdle", {}) {}
      class ParentWaiting extends Schema.TaggedClass<ParentWaiting>("BoundInvokeParentWaiting")(
        "ParentWaiting",
        {}
      ) {}
      class ParentDone extends Schema.TaggedClass<ParentDone>("BoundInvokeParentDone")("ParentDone", {}) {}
      class ChildReady extends Schema.TaggedClass<ChildReady>("BoundInvokeChildReady")("ChildReady", {}) {}

      const ParentEvents = Machine.events(ChildReady)
      const childStates = Machine.states({ ChildIdle })
      const childDefinition = Machine.make({
        states: childStates.states,
        events: Machine.events(),
        parent: Machine.parent(ParentEvents),
        initial: (to) => to.ChildIdle().resolve(({ target }) => target(new ChildIdle({})))
      })
      const childMachine = childDefinition.handle({
        ChildIdle: {
          invoke: (from) =>
            from.effect("notify-ready", ({ parent }) => parent.send(ParentEvents.ChildReady())).onDone((to) => to.none)
              .onFailure((to) => to.none)
        }
      })
      assert.strictEqual(childMachine.parent?.mode, "required")
      const Child = Machine.child("bound-invoke-child", childMachine)
      const parentStates = Machine.states({
        ParentWaiting,
        ParentDone: { schema: ParentDone, type: "final", output: Schema.Void }
      })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: ParentEvents,
        initial: (to) => to.ParentWaiting().resolve(({ target }) => target(new ParentWaiting({})))
      }).handle({
        ParentWaiting: {
          invoke: (from) => from.child(Child).onFailure((to) => to.none),
          on: {
            ChildReady: (to) => to.full.ParentDone().resolve(({ target }) => target(new ParentDone({})))
          }
        },
        ParentDone: { output: () => undefined }
      })

      const parent = yield* Machine.start(parentMachine)
      assert.strictEqual(yield* parent.join, undefined)
    }) as Effect.Effect<void, unknown, any>)
})
