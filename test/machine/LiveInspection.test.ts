import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"

class Idle extends Schema.TaggedClass<Idle>("LiveInspectionIdle")("Idle", {}) {}
class Increment extends Schema.TaggedClass<Increment>("LiveInspectionIncrement")("Increment", {
  by: Schema.Number
}) {}
class Notice extends Schema.TaggedClass<Notice>("LiveInspectionNotice")("Notice", {
  value: Schema.Number
}) {}

const states = Machine.states({ Idle })
const Events = Machine.events(Increment)
const Emissions = Machine.emittedEvents(Notice)

const machine = Machine.make({
  id: "counter",
  states: states.states,
  events: Events,
  emittedEvents: Emissions,
  initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({})))
}).handle({
  Idle: {
    on: {
      Increment: (to) =>
        to.full.Idle().resolve(({ event, target }, enqueue) => {
          enqueue.emit(Emissions.Notice({ value: event.by }))
          return target(new Idle({}))
        })
    }
  }
})

describe("Machine live inspection", () => {
  it.effect("observes a prepared root from creation through termination", () =>
    Effect.scoped(Effect.gen(function*() {
      const prepared = yield* Machine.prepare(machine)
      const collected = yield* prepared.inspection.pipe(
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true })
      )
      yield* Effect.yieldNow

      const ref = yield* prepared.start
      yield* ref.send(Events.Increment({ by: 2 }))
      yield* Effect.yieldNow
      yield* ref.stop

      const records = Array.from(yield* Fiber.join(collected))
      assert.deepStrictEqual(records.map(({ _tag }) => _tag), [
        "Created",
        "Initialized",
        "EventSent",
        "Emitted",
        "EventProcessed",
        "Terminated"
      ])
      assert.deepStrictEqual(records.map(({ sequence }) => sequence), [0, 1, 2, 3, 4, 5])
      assert.ok(records.every(({ rootSessionId }) => rootSessionId === prepared.sessionId))

      const created = records[0]
      assert.strictEqual(created?._tag, "Created")
      if (created?._tag === "Created") {
        assert.deepStrictEqual(created.subject, {
          id: "counter",
          sessionId: prepared.sessionId,
          kind: "Machine"
        })
        assert.deepStrictEqual(created.origin, { _tag: "Root" })
        assert.strictEqual(created.parent, undefined)
        assert.strictEqual(created.definition, machine)
      }

      const processed = records.find((record) => record._tag === "EventProcessed")
      assert.ok(processed !== undefined && processed._tag === "EventProcessed")
      if (processed?._tag === "EventProcessed") {
        assert.strictEqual(processed.handled, true)
        assert.strictEqual(processed.configurationChanged, false)
        assert.strictEqual(processed.microsteps.length, 1)
        assert.deepStrictEqual(processed.microsteps[0]?.transitions, [{
          source: "Idle",
          trigger: { type: "event", event: "Increment" },
          reenter: false,
          branchIndex: 0,
          branchKey: undefined,
          target: "Idle",
          resolvedTarget: "Idle"
        }])
      }

      const emitted = records.find((record) => record._tag === "Emitted")
      assert.ok(emitted !== undefined && emitted._tag === "Emitted")
      if (emitted?._tag === "Emitted") {
        assert.deepStrictEqual(emitted.emission, new Notice({ value: 2 }))
        assert.deepStrictEqual(emitted.causedBy, { _tag: "Macrostep", macrostepId: 0 })
      }
    })))

  it.effect("is hot, non-replayed, and completes when startup fails", () =>
    Effect.scoped(Effect.gen(function*() {
      const invalid = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) =>
          to.Idle().resolve(() => {
            throw new Error("boom")
          })
      }).handle({ Idle: {} })
      const prepared = yield* Machine.prepare(invalid)
      const collected = yield* prepared.inspection.pipe(
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* Effect.exit(prepared.start)

      assert.deepStrictEqual(Array.from(yield* Fiber.join(collected)).map(({ _tag }) => _tag), [
        "Created",
        "StartFailed"
      ])
      assert.deepStrictEqual(Array.from(yield* Stream.runCollect(prepared.inspection)), [])
    })))

  it.effect("represents Effect invokes as owned activities rather than child machines", () =>
    Effect.scoped(Effect.gen(function*() {
      const active = Machine.make({
        id: "activity-root",
        states: states.states,
        events: Machine.events(),
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({})))
      }).handle({
        Idle: {
          invoke: (from) => from.effect("worker", () => Effect.never)
        }
      })
      const prepared = yield* Machine.prepare(active)
      const collected = yield* prepared.inspection.pipe(
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true })
      )
      yield* Effect.yieldNow
      const ref = yield* prepared.start
      yield* Effect.yieldNow
      yield* ref.stop

      const records = Array.from(yield* Fiber.join(collected))
      assert.deepStrictEqual(records.map(({ _tag }) => _tag), [
        "Created",
        "Initialized",
        "ActivityStarted",
        "ActivityStopped",
        "Terminated"
      ])
      const started = records.find((record) => record._tag === "ActivityStarted")
      assert.ok(started !== undefined && started._tag === "ActivityStarted")
      if (started?._tag === "ActivityStarted") {
        assert.deepStrictEqual(started.activity, {
          id: "worker",
          sessionId: "machine:1",
          owner: started.subject,
          ownerPath: "Idle",
          kind: "Effect"
        })
      }
      const stopped = records.find((record) => record._tag === "ActivityStopped")
      assert.ok(stopped !== undefined && stopped._tag === "ActivityStopped")
      if (stopped?._tag === "ActivityStopped") {
        assert.ok(Exit.isFailure(stopped.exit))
        if (Exit.isFailure(stopped.exit)) assert.ok(Cause.hasInterruptsOnly(stopped.exit.cause))
      }
    })))

  it.effect("represents Stream invokes as owned Stream activities", () =>
    Effect.scoped(Effect.gen(function*() {
      const active = Machine.make({
        id: "stream-activity-root",
        states: states.states,
        events: Machine.events(),
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({})))
      }).handle({
        Idle: {
          invoke: (from) => from.stream("updates", () => Stream.never).onDone((to) => to.none)
        }
      })
      const prepared = yield* Machine.prepare(active)
      const collected = yield* prepared.inspection.pipe(
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true })
      )
      yield* Effect.yieldNow
      const ref = yield* prepared.start
      yield* Effect.yieldNow
      yield* ref.stop

      const records = Array.from(yield* Fiber.join(collected))
      const started = records.find((record) => record._tag === "ActivityStarted")
      assert.ok(started !== undefined && started._tag === "ActivityStarted")
      if (started?._tag === "ActivityStarted") {
        assert.strictEqual(started.activity.kind, "Stream")
        assert.strictEqual(started.activity.id, "updates")
        assert.strictEqual(started.activity.ownerPath, "Idle")
      }
    })))

  it.effect("correlates an explicit child-to-parent send with both local subjects", () =>
    Effect.scoped(Effect.gen(function*() {
      class ChildIdle extends Schema.TaggedClass<ChildIdle>("InspectionChildIdle")("ChildIdle", {}) {}
      class Trigger extends Schema.TaggedClass<Trigger>("InspectionChildTrigger")("Trigger", {}) {}
      class ChildReady extends Schema.TaggedClass<ChildReady>("InspectionChildReady")("ChildReady", {}) {}
      class ParentIdle extends Schema.TaggedClass<ParentIdle>("InspectionParentIdle")("ParentIdle", {}) {}
      class ParentDone extends Schema.TaggedClass<ParentDone>("InspectionParentDone")("ParentDone", {}) {}

      const ParentEvents = Machine.events(ChildReady)
      const ChildEvents = Machine.events(Trigger)
      const childStates = Machine.states({ ChildIdle })
      const childMachine = Machine.make({
        id: "child-machine",
        states: childStates.states,
        events: ChildEvents,
        parent: Machine.parent(ParentEvents),
        initial: (to) => to.ChildIdle().resolve(({ target }) => target(new ChildIdle({})))
      }).handle({
        ChildIdle: {
          on: {
            Trigger: (to) =>
              to.none.resolve(({ parent }, enqueue) => {
                enqueue.sendTo(parent, ParentEvents.ChildReady())
                return undefined
              })
          }
        }
      })
      const Child = Machine.child("child", childMachine)
      const parentStates = Machine.states({
        ParentIdle,
        ParentDone: { schema: ParentDone, type: "final" }
      })
      const parentMachine = Machine.make({
        id: "parent-machine",
        states: parentStates.states,
        events: Machine.events(ParentEvents),
        initial: (to) => to.ParentIdle().resolve(({ target }) => target(new ParentIdle({})))
      }).handle({
        ParentIdle: {
          invoke: (from) => from.child(Child),
          on: {
            ChildReady: (to) => to.full.ParentDone().resolve(({ target }) => target(new ParentDone({})))
          }
        },
        ParentDone: {}
      })

      const prepared = yield* Machine.prepare(parentMachine)
      const collected = yield* prepared.inspection.pipe(
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true })
      )
      yield* Effect.yieldNow
      const parent = yield* prepared.start
      yield* Effect.yieldNow
      const child = Option.getOrThrow(yield* parent.child(Child))
      yield* child.send(ChildEvents.Trigger())
      yield* parent.join

      const sent = Array.from(yield* Fiber.join(collected)).filter((record) => record._tag === "EventSent")
      const toParent = sent.find((record) => record.subject.id === "parent-machine")
      assert.ok(toParent !== undefined && toParent._tag === "EventSent")
      if (toParent?._tag === "EventSent") {
        assert.strictEqual(toParent.source?.id, "child")
        assert.strictEqual(toParent.target.id, "parent-machine")
        assert.deepStrictEqual(toParent.causedBy, { _tag: "Macrostep", macrostepId: 0 })
      }
    })))
})
