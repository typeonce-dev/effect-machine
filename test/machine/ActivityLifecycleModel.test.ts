import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../src/index.js"
import {
  ActivityFailure,
  countRecords,
  expectedLifecycle,
  lifecycleCommandSamples,
  makeActivityProbe
} from "./support/activityLifecycleModel.js"

class Idle extends Schema.TaggedClass<Idle>("ActivityIdle")("Idle", {}) {}
class Active extends Schema.TaggedClass<Active>("ActivityActive")("Active", {}) {}
class Done extends Schema.TaggedClass<Done>("ActivityDone")("Done", { epoch: Schema.Number }) {}

class Enter extends Schema.TaggedClass<Enter>("ActivityEnter")("Enter", {}) {}
class Leave extends Schema.TaggedClass<Leave>("ActivityLeave")("Leave", {}) {}
class Restart extends Schema.TaggedClass<Restart>("ActivityRestart")("Restart", {}) {}
class QueueBarrier extends Schema.TaggedClass<QueueBarrier>("ActivityQueueBarrier")("QueueBarrier", {}) {}
class Completed extends Schema.TaggedClass<Completed>("ActivityCompleted")("Completed", { epoch: Schema.Number }) {}
class TimerFired extends Schema.TaggedClass<TimerFired>("ActivityTimerFired")("TimerFired", {}) {}

const sendAndWaitForActiveState = <State, Event, Error, Output>(
  actor: Machine.MachineRef<State, Event, Error, Output>,
  event: Event,
  predicate: (state: State) => boolean
) =>
  Effect.gen(function*() {
    const observed = yield* actor.changes.pipe(
      Stream.filter((snapshot) => snapshot.status === "active" && predicate(snapshot.state)),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkChild
    )
    yield* actor.send(event)
    yield* Fiber.join(observed)
  })

const assertOneExitPerStart = (
  records: ReadonlyArray<
    | { readonly _tag: "Started"; readonly owner: string; readonly epoch: number }
    | {
      readonly _tag: "Exited"
      readonly owner: string
      readonly epoch: number
      readonly outcome: "succeeded" | "cancelled" | "failed"
    }
  >
) => {
  const starts = records.filter((record) => record._tag === "Started")
  for (const start of starts) {
    assert.strictEqual(
      records.filter((record) =>
        record._tag === "Exited" && record.owner === start.owner && record.epoch === start.epoch
      ).length,
      1,
      `activity ${start.owner} epoch ${start.epoch} must exit exactly once`
    )
  }
}

describe("machine activity lifecycle model", () => {
  it.effect("matches exactly-once start and cancellation across generated lifecycle commands", () =>
    Effect.gen(function*() {
      const samples = lifecycleCommandSamples({ numRuns: 40, maxCommands: 20, seed: 82_419 })
      yield* Effect.forEach(
        samples,
        (commands) =>
          Effect.gen(function*() {
            const probe = yield* makeActivityProbe
            const states = Machine.defineStates({ Idle, Active })
            const machine = Machine.make({
              states: states.states,
              events: Machine.events(Enter, Leave, Restart),
              initial: () => states.initial.Idle(new Idle({}))
            }).handle({
              Idle: {
                on: {
                  Enter: ({ target }) => target.full.Active(new Active({}))
                }
              },
              Active: {
                invoke: Machine.invoke({
                  id: "activity",
                  address: Machine.childAddress("activity"),
                  logic: probe.logic("active", { _tag: "Blocked" }),
                  onDone: ({ target }) => target.none(),
                  onFailure: ({ target }) => target.none()
                }),
                on: {
                  Leave: ({ target }) => target.full.Idle(new Idle({})),
                  Restart: {
                    reenter: true,
                    transition: ({ target }) => target.full.Active(new Active({}))
                  }
                }
              }
            })
            const actor = yield* Machine.start(machine)
            let active = false

            for (const command of commands) {
              switch (command) {
                case "enter":
                  yield* actor.send(new Enter({}))
                  if (!active) {
                    yield* probe.takeStarted
                    active = true
                  }
                  break
                case "leave":
                  if (active) {
                    yield* sendAndWaitForActiveState(actor, new Leave({}), (state) => state.path === "Idle")
                    active = false
                  } else {
                    yield* actor.send(new Leave({}))
                  }
                  break
                case "restart":
                  yield* actor.send(new Restart({}))
                  if (active) yield* probe.takeStarted
                  break
              }
            }
            yield* actor.stop

            const expected = expectedLifecycle(commands)
            const records = yield* probe.records
            assert.strictEqual(countRecords(records, "starts"), expected.starts)
            assert.strictEqual(countRecords(records, "cancelled"), expected.cancellations)
            assert.strictEqual(countRecords(records, "succeeded"), 0)
            assert.strictEqual(countRecords(records, "failed"), 0)
            assertOneExitPerStart(records)
          }),
        { discard: true }
      )
    }))

  it.effect("records immediate invoke completion and cleanup exactly once", () =>
    Effect.gen(function*() {
      const probe = yield* makeActivityProbe
      const states = Machine.defineStates({
        Active,
        Done: { schema: Done, type: "final", output: Schema.Number }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        internalEvents: Machine.internalEvents(Completed),
        initial: () => states.initial.Active(new Active({}))
      }).handle({
        Active: {
          invoke: Machine.invoke({
            id: "immediate",
            address: Machine.childAddress("immediate"),
            logic: probe.immediate("immediate", (epoch) => new Completed({ epoch })),
            onDone: ({ output, target }) => target.full.Done(new Done({ epoch: output.epoch })),
            onFailure: ({ target }) => target.none()
          })
        },
        Done: {
          output: ({ state }) => state.epoch
        }
      })

      const actor = yield* Machine.start(machine)
      assert.strictEqual(yield* actor.join, 1)

      const records = yield* probe.records
      assert.strictEqual(countRecords(records, "starts", "immediate"), 1)
      assert.strictEqual(countRecords(records, "succeeded", "immediate"), 1)
      assertOneExitPerStart(records)
    }))

  it.effect("rejects stale cancellation completion from a previous re-entry epoch", () =>
    Effect.gen(function*() {
      const probe = yield* makeActivityProbe
      class EpochActive extends Schema.TaggedClass<EpochActive>("ActivityEpochActive")("EpochActive", {
        acknowledged: Schema.Number
      }) {}
      const states = Machine.defineStates({ Active: EpochActive, Done })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Restart, QueueBarrier),
        internalEvents: Machine.internalEvents(Completed),
        initial: () => states.initial.Active(new EpochActive({ acknowledged: 0 }))
      }).handle({
        Active: {
          invoke: Machine.invoke({
            id: "epoch",
            address: Machine.childAddress("epoch"),
            logic: probe.logic("epoch", {
              _tag: "StaleOnCancel",
              event: (epoch) => new Completed({ epoch })
            }),
            onDone: ({ target }) => target.none(),
            onFailure: ({ target }) => target.none()
          }),
          on: {
            Restart: {
              reenter: true,
              transition: ({ state, target }) =>
                target.full.Active(new EpochActive({ acknowledged: state.acknowledged }))
            },
            QueueBarrier: ({ state, target }) =>
              target.full.Active(new EpochActive({ acknowledged: state.acknowledged + 1 })),
            Completed: ({ event, target }) => target.full.Done(new Done({ epoch: event.epoch }))
          }
        },
        Done: {}
      })
      const actor = yield* Machine.start(machine)
      yield* probe.takeStarted

      yield* actor.send(new Restart({}))
      yield* probe.takeStarted
      yield* actor.send(new Restart({}))
      yield* probe.takeStarted

      // The invoke token should suppress the old completion before enqueue.
      // If it leaked, FIFO ordering would process it before this barrier and
      // transition to Done, so the acknowledged Active publication could not
      // occur.
      yield* sendAndWaitForActiveState(
        actor,
        new QueueBarrier({}),
        (state) => state.path === "Active" && state.value.acknowledged === 1
      )

      const active = yield* actor.snapshot
      assert.strictEqual(active.status, "active")
      if (active.status === "active") {
        assert.strictEqual(active.state.path, "Active")
        assert.instanceOf(active.state.value, EpochActive)
        if (active.state.value instanceof EpochActive) {
          assert.strictEqual(active.state.value.acknowledged, 1)
        }
      }
      const beforeStop = yield* probe.records
      assert.deepStrictEqual(
        beforeStop.filter((record) => record._tag === "Started").map((record) => record.epoch),
        [1, 2, 3]
      )
      assert.strictEqual(countRecords(beforeStop, "cancelled", "epoch"), 2)

      yield* actor.stop

      const records = yield* probe.records
      assert.strictEqual(countRecords(records, "cancelled", "epoch"), 3)
      assertOneExitPerStart(records)
    }))

  it.effect("cancels only the activity owned by an exited parallel region", () =>
    Effect.gen(function*() {
      const probe = yield* makeActivityProbe
      class Root extends Schema.TaggedClass<Root>("ActivityRoot")("Root", {}) {}
      class Left extends Schema.TaggedClass<Left>("ActivityLeft")("Left", {}) {}
      class LeftActive extends Schema.TaggedClass<LeftActive>("ActivityLeftActive")("LeftActive", {}) {}
      class LeftIdle extends Schema.TaggedClass<LeftIdle>("ActivityLeftIdle")("LeftIdle", {}) {}
      class Right extends Schema.TaggedClass<Right>("ActivityRight")("Right", {}) {}
      class RightActive extends Schema.TaggedClass<RightActive>("ActivityRightActive")("RightActive", {}) {}
      class LeaveLeft extends Schema.TaggedClass<LeaveLeft>("ActivityLeaveLeft")("LeaveLeft", {}) {}
      const machine = Machine.make({
        states: {
          Root: {
            schema: Root,
            type: "parallel",
            states: {
              left: {
                schema: Left,
                initial: "active",
                states: { active: LeftActive, idle: LeftIdle }
              },
              right: {
                schema: Right,
                initial: "active",
                states: { active: RightActive }
              }
            }
          }
        },
        events: Machine.events(LeaveLeft),
        initial: () => ({
          path: "Root" as const,
          value: new Root({}),
          states: {
            left: {
              path: "Root.left" as const,
              value: new Left({}),
              state: { path: "Root.left.active" as const, value: new LeftActive({}) }
            },
            right: {
              path: "Root.right" as const,
              value: new Right({}),
              state: { path: "Root.right.active" as const, value: new RightActive({}) }
            }
          }
        })
      }).handle({
        Root: {
          states: {
            left: {
              states: {
                active: {
                  invoke: Machine.invoke({
                    id: "left-activity",
                    address: Machine.childAddress("left-activity"),
                    logic: probe.logic("left", { _tag: "Blocked" }),
                    onDone: ({ target }) => target.none(),
                    onFailure: ({ target }) => target.none()
                  }),
                  on: {
                    LeaveLeft: ({ target }) => target.local.idle(new LeftIdle({}))
                  }
                }
              }
            },
            right: {
              states: {
                active: {
                  invoke: Machine.invoke({
                    id: "right-activity",
                    address: Machine.childAddress("right-activity"),
                    logic: probe.logic("right", { _tag: "Blocked" }),
                    onDone: ({ target }) => target.none(),
                    onFailure: ({ target }) => target.none()
                  })
                }
              }
            }
          }
        }
      })
      const actor = yield* Machine.start(machine)
      yield* probe.takeStarted
      yield* probe.takeStarted

      yield* sendAndWaitForActiveState(
        actor,
        new LeaveLeft({}),
        (state) => state.states.left.state.path === "Root.left.idle"
      )

      const afterLeftExit = yield* probe.records
      assert.strictEqual(countRecords(afterLeftExit, "starts", "left"), 1)
      assert.strictEqual(countRecords(afterLeftExit, "starts", "right"), 1)
      assert.strictEqual(countRecords(afterLeftExit, "cancelled", "left"), 1)
      assert.strictEqual(countRecords(afterLeftExit, "cancelled", "right"), 0)

      yield* actor.stop

      const records = yield* probe.records
      assert.strictEqual(countRecords(records, "cancelled", "left"), 1)
      assert.strictEqual(countRecords(records, "cancelled", "right"), 1)
      assertOneExitPerStart(records)
    }))

  it.effect("cancels a state-owned timer before virtual time advances", () =>
    Effect.gen(function*() {
      const probe = yield* makeActivityProbe
      const states = Machine.defineStates({ Idle, Active, Done })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Leave),
        internalEvents: Machine.internalEvents(TimerFired),
        initial: () => states.initial.Active(new Active({}))
      }).handle({
        Idle: {},
        Active: {
          invoke: [
            Machine.invoke({
              id: "timed-activity",
              address: Machine.childAddress("timed-activity"),
              logic: probe.logic("timed", { _tag: "Blocked" }),
              onDone: ({ target }) => target.none(),
              onFailure: ({ target }) => target.none()
            }),
            Machine.invoke({
              id: "deadline",
              after: "1 hour",
              onDone: ({ target }) => target.full.Done(new Done({ epoch: -1 }))
            })
          ],
          on: {
            Leave: ({ target }) => target.full.Idle(new Idle({}))
          }
        },
        Done: {}
      })
      const actor = yield* Machine.start(machine)
      yield* probe.takeStarted

      yield* sendAndWaitForActiveState(actor, new Leave({}), (state) => state.path === "Idle")
      yield* TestClock.adjust("2 hours")

      const snapshot = yield* actor.snapshot
      assert.strictEqual(snapshot.status, "active")
      if (snapshot.status === "active") assert.strictEqual(snapshot.state.path, "Idle")
      const records = yield* probe.records
      assert.strictEqual(countRecords(records, "cancelled", "timed"), 1)
      assertOneExitPerStart(records)
      yield* actor.stop
    }))

  it.effect("cleans sibling activities when an invoked child fails", () =>
    Effect.gen(function*() {
      const probe = yield* makeActivityProbe
      const states = Machine.defineStates({ Active })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: () => states.initial.Active(new Active({}))
      }).handle({
        Active: {
          invoke: [
            Machine.invoke({
              id: "failing",
              address: Machine.childAddress("failing"),
              logic: probe.logic("failing", { _tag: "Failure" }),
              onDone: ({ target }) => target.none(),
              onFailure: ({ error }) => {
                throw error
              }
            }),
            Machine.invoke({
              id: "sibling",
              address: Machine.childAddress("sibling"),
              logic: probe.logic("sibling", { _tag: "Blocked" }),
              onDone: ({ target }) => target.none(),
              onFailure: ({ target }) => target.none()
            })
          ]
        }
      })
      const actor = yield* Machine.start(machine)
      const first = yield* probe.takeStarted
      const second = yield* probe.takeStarted
      const failing = first.owner === "failing" ? first : second

      yield* Deferred.succeed(failing.release, void 0)
      const failed = yield* Effect.exit(actor.join)

      assert(Exit.isFailure(failed))
      if (Exit.isFailure(failed)) {
        assert.instanceOf(failed.cause.reasons.find((reason) => reason._tag === "Die")?.defect, ActivityFailure)
      }
      const records = yield* probe.records
      assert.strictEqual(countRecords(records, "failed", "failing"), 1)
      assert.strictEqual(countRecords(records, "cancelled", "sibling"), 1)
      assertOneExitPerStart(records)
    }))

  it.effect("waits for every activity cleanup before parent stop completes", () =>
    Effect.gen(function*() {
      const probe = yield* makeActivityProbe
      const states = Machine.defineStates({ Active })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: () => states.initial.Active(new Active({}))
      }).handle({
        Active: {
          invoke: [
            Machine.invoke({
              id: "first",
              address: Machine.childAddress("first"),
              logic: probe.logic("first", { _tag: "Blocked" }),
              onDone: ({ target }) => target.none(),
              onFailure: ({ target }) => target.none()
            }),
            Machine.invoke({
              id: "second",
              address: Machine.childAddress("second"),
              logic: probe.logic("second", { _tag: "Blocked" }),
              onDone: ({ target }) => target.none(),
              onFailure: ({ target }) => target.none()
            })
          ]
        }
      })
      const actor = yield* Machine.start(machine)
      yield* probe.takeStarted
      yield* probe.takeStarted

      yield* actor.stop

      const records = yield* probe.records
      assert.strictEqual(countRecords(records, "cancelled", "first"), 1)
      assert.strictEqual(countRecords(records, "cancelled", "second"), 1)
      assertOneExitPerStart(records)
      assert.strictEqual((yield* actor.snapshot).status, "stopped")

      yield* actor.stop
      assert.deepStrictEqual(yield* probe.records, records)
    }))
})
