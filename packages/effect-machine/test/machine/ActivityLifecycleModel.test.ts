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
    {
      readonly _tag: "Started"
      readonly owner: string
      readonly epoch: number
    } | {
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
      const samples = lifecycleCommandSamples({ numRuns: 40, maxCommands: 20, seed: 82419 })
      yield* Effect.forEach(samples, (commands) =>
        Effect.gen(function*() {
          const probe = yield* makeActivityProbe
          const states = Machine.state({ states: { Idle, Active } })
          const targets1 = Machine.targets(states)
          const machine = Machine.make({
            logic: { source1: probe.logic("active", { _tag: "Blocked" }) },
            root: states,
            events: Machine.eventsFromSchemas(Enter, Leave, Restart)
          }).handle({
            initial: {
              target: Machine.targets(states).root.Idle,
              decoded: true,
              data: new Idle({})
            },
            states: {
              Idle: {
                on: {
                  Enter: { target: targets1.root.Active, decoded: true, data: () => (new Active({})) }
                }
              },
              Active: {
                invoke: {
                  src: "source1",
                  id: "activity",
                  address: Machine.childAddress("activity"),
                  onDone: { none: true },
                  onFailure: { none: true }
                },
                on: {
                  Leave: { target: targets1.root.Idle, decoded: true, data: () => (new Idle({})) },
                  Restart: { target: targets1.root.Active, reenter: true, decoded: true, data: () => (new Active({})) }
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
                  yield* sendAndWaitForActiveState(actor, new Leave({}), (state) => state.state.path === "Idle")
                  active = false
                } else {
                  yield* actor.send(new Leave({}))
                }
                break
              case "restart":
                yield* actor.send(new Restart({}))
                if (active) {
                  yield* probe.takeStarted
                }
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
        }), { discard: true })
    }))
  it.effect("records immediate invoke completion and cleanup exactly once", () =>
    Effect.gen(function*() {
      const probe = yield* makeActivityProbe
      const states = Machine.state({
        states: {
          Active,
          Done: { schema: Done, type: "final", output: Schema.Number }
        }
      })
      const targets2 = Machine.targets(states)
      const machine = Machine.make({
        logic: { source1: probe.immediate("immediate", (epoch) => new Completed({ epoch })) },
        root: states,
        events: Machine.eventsFromSchemas(),
        internalEvents: Machine.internalEventsFromSchemas(Completed)
      }).handle({
        initial: {
          target: Machine.targets(states).root.Active,
          decoded: true,
          data: new Active({})
        },
        states: {
          Active: {
            invoke: {
              src: "source1",
              id: "immediate",
              address: Machine.childAddress("immediate"),
              onDone: {
                target: targets2.root.Done,
                decoded: true,
                data: ({ output }) => (new Done({ epoch: output.epoch }))
              },
              onFailure: { none: true }
            }
          },
          Done: {
            output: ({ state }) => state.epoch
          }
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
      }) {
      }
      const states = Machine.state({ states: { Active: EpochActive, Done } })
      const targets3 = Machine.targets(states)
      const machine = Machine.make({
        logic: {
          source1: probe.logic("epoch", {
            _tag: "StaleOnCancel",
            event: (epoch) => new Completed({ epoch })
          })
        },
        root: states,
        events: Machine.eventsFromSchemas(Restart, QueueBarrier),
        internalEvents: Machine.internalEventsFromSchemas(Completed)
      }).handle({
        initial: {
          target: Machine.targets(states).root.Active,
          decoded: true,
          data: new EpochActive({ acknowledged: 0 })
        },
        states: {
          Active: {
            invoke: {
              src: "source1",
              id: "epoch",
              address: Machine.childAddress("epoch"),
              onDone: { none: true },
              onFailure: { none: true }
            },
            on: {
              Restart: {
                target: targets3.root.Active,
                reenter: true,
                decoded: true,
                data: ({ state }) => (new EpochActive({ acknowledged: state.acknowledged }))
              },
              QueueBarrier: {
                target: targets3.root.Active,
                decoded: true,
                data: ({ state }) => (new EpochActive({ acknowledged: state.acknowledged + 1 }))
              },
              Completed: {
                target: targets3.root.Done,
                decoded: true,
                data: ({ event }) => (new Done({ epoch: event.epoch }))
              }
            }
          },
          Done: {}
        }
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
      yield* sendAndWaitForActiveState(actor, new QueueBarrier({}), (state) =>
        state.state.path === "Active" && state.state.value.acknowledged === 1)
      const active = yield* actor.snapshot
      assert.strictEqual(active.status, "active")
      if (active.status === "active") {
        assert.strictEqual(active.state.state.path, "Active")
        assert.instanceOf(active.state.state.value, EpochActive)
        if (active.state.state.value instanceof EpochActive) {
          assert.strictEqual(active.state.state.value.acknowledged, 1)
        }
      }
      const beforeStop = yield* probe.records
      assert.deepStrictEqual(
        beforeStop.filter((record) =>
          record._tag === "Started"
        ).map((record) => record.epoch),
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
      class Root extends Schema.TaggedClass<Root>("ActivityRoot")("Root", {}) {
      }
      class Left extends Schema.TaggedClass<Left>("ActivityLeft")("Left", {}) {
      }
      class LeftActive extends Schema.TaggedClass<LeftActive>("ActivityLeftActive")("LeftActive", {}) {
      }
      class LeftIdle extends Schema.TaggedClass<LeftIdle>("ActivityLeftIdle")("LeftIdle", {}) {
      }
      class Right extends Schema.TaggedClass<Right>("ActivityRight")("Right", {}) {
      }
      class RightActive extends Schema.TaggedClass<RightActive>("ActivityRightActive")("RightActive", {}) {
      }
      class LeaveLeft extends Schema.TaggedClass<LeaveLeft>("ActivityLeaveLeft")("LeaveLeft", {}) {
      }
      const root4 = Machine.state({
        states: {
          Root: {
            schema: Root,
            type: "parallel",
            states: {
              left: {
                schema: Left,
                states: { active: LeftActive, idle: LeftIdle }
              },
              right: {
                schema: Right,
                states: { active: RightActive }
              }
            }
          }
        }
      })
      const targets4 = Machine.targets(root4)
      const machine = Machine.make({
        logic: {
          source1: probe.logic("left", { _tag: "Blocked" }),
          source2: probe.logic("right", { _tag: "Blocked" })
        },
        root: root4,
        events: Machine.eventsFromSchemas(LeaveLeft)
      }).handle({
        initial: {
          target: Machine.targets(root4).root.Root,
          decoded: true,
          data: new Root({})
        },
        states: {
          Root: {
            initial: { left: { decoded: true, data: new Left({}) }, right: { decoded: true, data: new Right({}) } },
            states: {
              left: {
                initial: {
                  target: Machine.targets(root4).root.Root.left.active,
                  decoded: true,
                  data: new LeftActive({})
                },
                states: {
                  active: {
                    invoke: {
                      src: "source1",
                      id: "left-activity",
                      address: Machine.childAddress("left-activity"),
                      onDone: { none: true },
                      onFailure: { none: true }
                    },
                    on: {
                      LeaveLeft: { target: targets4.root.Root.left.idle, decoded: true, data: () => (new LeftIdle({})) }
                    }
                  },
                  idle: {}
                }
              },
              right: {
                initial: {
                  target: Machine.targets(root4).root.Root.right.active,
                  decoded: true,
                  data: new RightActive({})
                },
                states: {
                  active: {
                    invoke: {
                      src: "source2",
                      id: "right-activity",
                      address: Machine.childAddress("right-activity"),
                      onDone: { none: true },
                      onFailure: { none: true }
                    }
                  }
                }
              }
            }
          }
        }
      })
      const actor = yield* Machine.start(machine)
      yield* probe.takeStarted
      yield* probe.takeStarted
      yield* sendAndWaitForActiveState(actor, new LeaveLeft({}), (state) =>
        state.state.states.left.state.path === "Root.left.idle")
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
      const states = Machine.state({ states: { Idle, Active, Done } })
      const targets5 = Machine.targets(states)
      const machine = Machine.make({
        timers: { source2: "1 hour" },
        logic: { source1: probe.logic("timed", { _tag: "Blocked" }) },
        root: states,
        events: Machine.eventsFromSchemas(Leave),
        internalEvents: Machine.internalEventsFromSchemas(TimerFired)
      }).handle({
        initial: {
          target: Machine.targets(states).root.Active,
          decoded: true,
          data: new Active({})
        },
        states: {
          Idle: {},
          Active: {
            invoke: [{
              src: "source1",
              id: "timed-activity",
              address: Machine.childAddress("timed-activity"),
              onDone: { none: true },
              onFailure: { none: true }
            }, {
              src: "source2",
              id: "deadline",
              onDone: { target: targets5.root.Done, decoded: true, data: () => (new Done({ epoch: -1 })) }
            }],
            on: {
              Leave: { target: targets5.root.Idle, decoded: true, data: () => (new Idle({})) }
            }
          },
          Done: {}
        }
      })
      const actor = yield* Machine.start(machine)
      yield* probe.takeStarted
      yield* sendAndWaitForActiveState(actor, new Leave({}), (state) => state.state.path === "Idle")
      yield* TestClock.adjust("2 hours")
      const snapshot = yield* actor.snapshot
      assert.strictEqual(snapshot.status, "active")
      if (snapshot.status === "active") {
        assert.strictEqual(snapshot.state.state.path, "Idle")
      }
      const records = yield* probe.records
      assert.strictEqual(countRecords(records, "cancelled", "timed"), 1)
      assertOneExitPerStart(records)
      yield* actor.stop
    }))
  it.effect("cleans sibling activities when an invoked child fails", () =>
    Effect.gen(function*() {
      const probe = yield* makeActivityProbe
      const states = Machine.state({ states: { Active } })
      const machine = Machine.make({
        logic: {
          source1: probe.logic("failing", { _tag: "Failure" }),
          source2: probe.logic("sibling", { _tag: "Blocked" })
        },
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(states).root.Active,
          decoded: true,
          data: new Active({})
        },
        states: {
          Active: {
            invoke: [{
              src: "source1",
              id: "failing",
              address: Machine.childAddress("failing"),
              onDone: { none: true },
              onFailure: {
                none: true,
                resolve: ({ error }) => {
                  throw error
                }
              }
            }, {
              src: "source2",
              id: "sibling",
              address: Machine.childAddress("sibling"),
              onDone: { none: true },
              onFailure: { none: true }
            }]
          }
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
      const states = Machine.state({ states: { Active } })
      const machine = Machine.make({
        logic: {
          source1: probe.logic("first", { _tag: "Blocked" }),
          source2: probe.logic("second", { _tag: "Blocked" })
        },
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(states).root.Active,
          decoded: true,
          data: new Active({})
        },
        states: {
          Active: {
            invoke: [{
              src: "source1",
              id: "first",
              address: Machine.childAddress("first"),
              onDone: { none: true },
              onFailure: { none: true }
            }, {
              src: "source2",
              id: "second",
              address: Machine.childAddress("second"),
              onDone: { none: true },
              onFailure: { none: true }
            }]
          }
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
