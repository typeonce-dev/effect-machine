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
const states = Machine.state({ states: { Idle } })
const Events = Machine.eventsFromSchemas(Increment)
const Emissions = Machine.emittedEventsFromSchemas(Notice)
const targets1 = Machine.targets(states)
const machine = Machine.make({
  branches: { transition1: { destination: { target: targets1.root.Idle } } },
  id: "counter",
  root: states,
  events: Events,
  emittedEvents: Emissions
}).handle({
  initial: {
    target: Machine.targets(states).root.Idle,
    decoded: true,
    data: new Idle({})
  },
  states: {
    Idle: {
      on: {
        Increment: {
          branches: "transition1",
          resolve: ({ event, select: { destination: target } }, enqueue) => {
            enqueue.emit(Emissions.Notice({ value: event.by }))
            return target({ data: new Idle({}), decoded: true })
          }
        }
      }
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
          branchKey: "destination",
          target: "Idle",
          resolvedTarget: "Idle",
          updates: []
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
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(states).root.Idle,
          data: () => {
            throw new Error("boom")
          }
        },
        states: { Idle: {} }
      })
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
        effects: { source1: Effect.suspend(() => Effect.never) },
        id: "activity-root",
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(states).root.Idle,
          decoded: true,
          data: new Idle({})
        },
        states: {
          Idle: {
            invoke: { src: "source1", id: "worker" }
          }
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
        if (Exit.isFailure(stopped.exit)) {
          assert.ok(Cause.hasInterruptsOnly(stopped.exit.cause))
        }
      }
    })))
  it.effect("represents Stream invokes as owned Stream activities", () =>
    Effect.scoped(Effect.gen(function*() {
      const active = Machine.make({
        streams: { source1: Stream.suspend(() => Stream.never) },
        id: "stream-activity-root",
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(states).root.Idle,
          decoded: true,
          data: new Idle({})
        },
        states: {
          Idle: {
            invoke: { src: "source1", id: "updates", onDone: { none: true } }
          }
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
      class ChildIdle extends Schema.TaggedClass<ChildIdle>("InspectionChildIdle")("ChildIdle", {}) {
      }
      class Trigger extends Schema.TaggedClass<Trigger>("InspectionChildTrigger")("Trigger", {}) {
      }
      class ChildReady extends Schema.TaggedClass<ChildReady>("InspectionChildReady")("ChildReady", {}) {
      }
      class ParentIdle extends Schema.TaggedClass<ParentIdle>("InspectionParentIdle")("ParentIdle", {}) {
      }
      class ParentDone extends Schema.TaggedClass<ParentDone>("InspectionParentDone")("ParentDone", {}) {
      }
      const ParentEvents = Machine.eventsFromSchemas(ChildReady)
      const ChildEvents = Machine.eventsFromSchemas(Trigger)
      const childStates = Machine.state({ states: { ChildIdle } })
      const childMachine = Machine.make({
        id: "child-machine",
        root: childStates,
        events: ChildEvents,
        parent: Machine.parent(ParentEvents)
      }).handle({
        initial: {
          target: Machine.targets(childStates).root.ChildIdle,
          decoded: true,
          data: new ChildIdle({})
        },
        states: {
          ChildIdle: {
            on: {
              Trigger: {
                none: true,
                resolve: ({ parent }, enqueue) => {
                  enqueue.sendTo(parent, ParentEvents.ChildReady())
                  return undefined
                }
              }
            }
          }
        }
      })
      const Child = Machine.child("child", childMachine)
      const parentStates = Machine.state({
        states: {
          ParentIdle,
          ParentDone: { schema: ParentDone, type: "final" }
        }
      })
      const targets5 = Machine.targets(parentStates)
      const parentMachine = Machine.make({
        children: { source1: Child },
        id: "parent-machine",
        root: parentStates,
        events: Machine.eventsFromSchemas(ParentEvents)
      }).handle({
        initial: {
          target: Machine.targets(parentStates).root.ParentIdle,
          decoded: true,
          data: new ParentIdle({})
        },
        states: {
          ParentIdle: {
            invoke: { src: "source1" },
            on: {
              ChildReady: { target: targets5.root.ParentDone, decoded: true, data: () => (new ParentDone({})) }
            }
          },
          ParentDone: {}
        }
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
