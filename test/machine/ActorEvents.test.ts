import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"

const collectNext = <A>(stream: Stream.Stream<A>) =>
  stream.pipe(Stream.take(1), Stream.runCollect, Effect.map(Array.from), Effect.forkChild({ startImmediately: true }))

describe("actor event channels", () => {
  it.effect("observes initial emissions through a prepared machine", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("PreparedEmissionIdle")("Idle", {}) {}
      class Ready extends Schema.TaggedClass<Ready>("PreparedEmissionReady")("Ready", {}) {}

      const states = Machine.defineStates({ Idle })
      const Emissions = Machine.emittedEvents(Ready)
      let initializations = 0
      const machine = Machine.make({
        id: "prepared-emission",
        states: states.states,
        events: Machine.events(),
        emittedEvents: Emissions,
        initial: () => {
          initializations += 1
          return states.initial.Idle(new Idle({}))
        }
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
      const states = Machine.defineStates({ Idle })
      const Emissions = Machine.emittedEvents(Published)
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        emittedEvents: Emissions,
        initial: () => states.initial.Idle(new Idle({}))
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

      const states = Machine.defineStates({ Idle })
      const Events = Machine.events(Publish)
      const Emissions = Machine.emittedEvents(Published)
      const machine = Machine.make({
        states: states.states,
        events: Events,
        emittedEvents: Emissions,
        initial: () => states.initial.Idle(new Idle({}))
      }).handle({
        Idle: {
          on: {
            Publish: ({ event, target }, enqueue) => {
              enqueue.emit(Emissions.Published({ value: event.value }))
              return target.none()
            }
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

  it.effect("fails the actor with a typed machine error when an emission cannot be decoded", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("InvalidEmissionIdle")("Idle", {}) {}
      class Publish extends Schema.TaggedClass<Publish>("InvalidEmissionPublish")("Publish", {}) {}
      class Published extends Schema.TaggedClass<Published>("InvalidEmissionPublished")("Published", {
        value: Schema.Number
      }) {}

      const states = Machine.defineStates({ Idle })
      const Events = Machine.events(Publish)
      const Emissions = Machine.emittedEvents(Published)
      const machine = Machine.make({
        states: states.states,
        events: Events,
        emittedEvents: Emissions,
        initial: () => states.initial.Idle(new Idle({}))
      }).handle({
        Idle: {
          on: {
            Publish: ({ target }, enqueue) => {
              enqueue.emit(Emissions.Published({ value: "invalid" } as never))
              return target.none()
            }
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

  it.effect("types a child parent reference from parentEvents and keeps emissions external", () =>
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
      const childStates = Machine.defineStates({ Waiting, Reported })
      let rootHadParent = true
      const childMachine = Machine.make({
        states: childStates.states,
        events: ChildEvents,
        parentEvents: ParentEvents,
        emittedEvents: ChildEmissions,
        initial: () => childStates.initial.Waiting(new Waiting({}))
      }).handle({
        Waiting: {
          on: {
            Trigger: ({ parent, target }, enqueue) => {
              rootHadParent = parent !== undefined
              enqueue.emit(ChildEmissions.Notice({ value: 1 }))
              if (parent !== undefined) {
                enqueue.sendTo(parent, ParentEvents.ChildReported({ value: 1 }))
              }
              return target.full.Reported(new Reported({}))
            }
          }
        },
        Reported: {}
      })

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
      const parentStates = Machine.defineStates({
        Awaiting,
        Finished: { schema: Finished, type: "final", output: Schema.String }
      })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: Machine.events(ParentEvents, Notice),
        initial: () => parentStates.initial.Awaiting(new Awaiting({}))
      }).handle({
        Awaiting: {
          invoke: Machine.invoke({ child: Child }),
          on: {
            ChildReported: ({ target }) => target.full.Finished(new Finished({ source: "parent event" })),
            Notice: ({ target }) => target.full.Finished(new Finished({ source: "emission" }))
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

  it.effect("types and delivers parent input from a machine-bound invocation source", () =>
    Effect.gen(function*() {
      class ChildIdle extends Schema.TaggedClass<ChildIdle>("BoundInvokeChildIdle")("ChildIdle", {}) {}
      class ParentWaiting extends Schema.TaggedClass<ParentWaiting>("BoundInvokeParentWaiting")(
        "ParentWaiting",
        {}
      ) {}
      class ParentDone extends Schema.TaggedClass<ParentDone>("BoundInvokeParentDone")("ParentDone", {}) {}
      class ChildReady extends Schema.TaggedClass<ChildReady>("BoundInvokeChildReady")("ChildReady", {}) {}

      const ParentEvents = Machine.events(ChildReady)
      const childStates = Machine.defineStates({ ChildIdle })
      const childDefinition = Machine.make({
        states: childStates.states,
        events: Machine.events(),
        parentEvents: ParentEvents,
        initial: () => childStates.initial.ChildIdle(new ChildIdle({}))
      })
      const childMachine = childDefinition.handle({
        ChildIdle: {
          invoke: childDefinition.invoke({
            id: "notify-ready",
            effect: ({ parent }) => parent === undefined ? Effect.void : parent.send(ParentEvents.ChildReady()),
            onDone: ({ target }) => target.none(),
            onFailure: ({ target }) => target.none()
          })
        }
      })
      const Child = Machine.child("bound-invoke-child", childMachine)
      const parentStates = Machine.defineStates({
        ParentWaiting,
        ParentDone: { schema: ParentDone, type: "final", output: Schema.Void }
      })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: ParentEvents,
        initial: () => parentStates.initial.ParentWaiting(new ParentWaiting({}))
      }).handle({
        ParentWaiting: {
          invoke: Machine.invoke({ child: Child, onFailure: ({ target }) => target.none() }),
          on: {
            ChildReady: ({ target }) => target.full.ParentDone(new ParentDone({}))
          }
        },
        ParentDone: { output: () => undefined }
      })

      const parent = yield* Machine.start(parentMachine)
      assert.strictEqual(yield* parent.join, undefined)
    }) as Effect.Effect<void, unknown, any>)
})
