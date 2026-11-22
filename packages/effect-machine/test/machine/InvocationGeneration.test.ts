import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../src/index.js"
import {
  prepareResumedWithRuntimeStrategy,
  prepareWithRuntimeStrategy
} from "../internal/machine/support/strategyDifferential.js"

const States = Machine.state({
  states: { Idle: {}, Working: {}, Done: { fields: { result: Schema.Number } } }
})
const Events = Machine.events({ Enter: {}, Exit: {}, Restart: {}, Hold: {}, Fence: {} })
const outcomes = [
  "Effect done",
  "Effect failure",
  "Stream element",
  "Timer",
  "Child done",
  "Child failure",
  "Child snapshot"
] as const

type Outcome = typeof outcomes[number]

const makeFixture = Effect.fn(function*(outcome: Outcome, barrier: Machine.MachineTarget<void>) {
  const old = yield* Deferred.make<number>()
  const fresh = yield* Deferred.make<number>()
  const freshStarted = yield* Deferred.make<void>()
  let attempts = 0
  const work = Effect.suspend(() => {
    attempts += 1
    return attempts === 1
      ? Deferred.await(old)
      : Deferred.succeed(freshStarted, undefined).pipe(Effect.andThen(Deferred.await(fresh)))
  })
  const child = Machine.child(
    "worker",
    Machine.make({
      root: Machine.state({
        states: { Running: {}, Complete: { type: "final", fields: { result: Schema.Number }, output: Schema.Number } }
      }),
      events: Machine.events({}),
      effects: { work }
    }).handle({
      initial: { target: "Running" },
      states: {
        Running: {
          invoke: { src: "work", onDone: { target: "Complete", data: ({ output }) => ({ result: output }) } }
        },
        Complete: { output: ({ state }) => state.result }
      }
    })
  )
  const definition = Machine.make({
    id: "invocation-owner",
    root: States,
    events: Events,
    effects: { success: work, failure: work.pipe(Effect.flatMap(Effect.fail)) },
    streams: { elements: Stream.fromEffect(work).pipe(Stream.concat(Stream.never)) },
    timers: { timeout: "1 second" },
    children: { child },
    logic: {
      logicFailure: Machine.logic({ initial: undefined, run: () => work.pipe(Effect.flatMap(Effect.fail)) }),
      progress: Machine.logic({
        initial: 0,
        run: ({ setState }) => work.pipe(Effect.flatMap(setState), Effect.andThen(Effect.never))
      })
    }
  })
  const machine = definition.handle({
    initial: { target: "Idle" },
    on: {
      Hold: {
        stay: true,
        commands: (_, enqueue) => {
          enqueue.sendTo(barrier, undefined)
        }
      },
      Fence: { stay: true }
    },
    states: {
      Idle: { on: { Enter: { target: "Working" } } },
      Working: {
        invoke: outcome === "Effect done" ?
          {
            src: "success",
            id: "work",
            onDone: { target: "Done", data: ({ output }) => ({ result: output }) }
          } :
          outcome === "Effect failure" ?
          {
            src: "failure",
            id: "work",
            onFailure: { target: "Done", data: ({ error }) => ({ result: error }) }
          } :
          outcome === "Stream element" ?
          {
            src: "elements",
            id: "work",
            onElement: { target: "Done", data: ({ element }) => ({ result: element }) },
            onDone: { stay: true }
          } :
          outcome === "Timer" ?
          {
            src: "timeout",
            id: "work",
            onDone: { target: "Done", data: () => ({ result: 2 }) }
          } :
          outcome === "Child done" ?
          {
            src: "child",
            onDone: { target: "Done", data: ({ output }) => ({ result: output }) }
          } :
          outcome === "Child failure" ?
          {
            src: "logicFailure",
            id: "work",
            address: Machine.childAddress("logic-worker"),
            onFailure: { target: "Done", data: ({ error }) => ({ result: error }) }
          } :
          {
            src: "progress",
            id: "work",
            address: Machine.childAddress("logic-worker"),
            onSnapshot: {
              // The outcome ternary widens an inline list, so keep its literal entries.
              branches: [{ target: "Done" }, { stay: true }] as const,
              resolve: ({ snapshot, select }) =>
                snapshot.state === 0 ? select.stay() : select.target("Done", { data: { result: snapshot.state } })
            }
          },
        on: { Restart: { target: "Working", reenter: true }, Exit: { target: "Idle" } }
      },
      Done: {}
    }
  })
  return {
    machine,
    child,
    releaseOld: outcome === "Timer" ? TestClock.adjust("1 second") : Deferred.succeed(old, 1),
    releaseFresh: outcome === "Timer" ? TestClock.adjust("1 second") : Deferred.succeed(fresh, 2),
    freshStarted: outcome === "Timer" ? Effect.void : Deferred.await(freshStarted),
    channel: outcome === "Effect failure" || outcome === "Child failure" ?
      "failure"
      : outcome === "Stream element" ?
      "element"
      : outcome === "Child snapshot"
      ? "snapshot"
      : "done"
  }
})

const hasChannel = (event: unknown, channel: string) =>
  typeof event === "object" && event !== null && "type" in event && event.type === channel &&
  (channel !== "snapshot" ||
    ("snapshot" in event && typeof event.snapshot === "object" && event.snapshot !== null &&
      "state" in event.snapshot && event.snapshot.state === 1))

const isFence = (event: unknown) =>
  typeof event === "object" && event !== null && "_tag" in event && event._tag === "Fence"

describe("queued invocation generations", () => {
  for (const strategy of ["generic", "compiled"] as const) {
    for (const reentry of ["reenter", "exit and enter", "retained"] as const) {
      for (const outcome of outcomes) {
        it.effect(
          reentry === "retained"
            ? `${strategy} accepts queued ${outcome} while its owner is retained`
            : `${strategy} ignores stale ${outcome} after ${reentry} and accepts the fresh result`,
          () =>
            Effect.gen(function*() {
              const holdEntered = yield* Deferred.make<void>()
              const releaseHold = yield* Deferred.make<void>()
              const oldSent = yield* Deferred.make<Machine.Inspection.EventSent>()
              const oldProcessed = yield* Deferred.make<Machine.Inspection.EventProcessed>()
              const fenceProcessed = yield* Deferred.make<void>()
              const barrier: Machine.MachineTarget<void> = {
                id: "barrier",
                sessionId: "barrier-session",
                send: () =>
                  Deferred.succeed(holdEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseHold)),
                    Effect.asVoid
                  )
              }
              const fixture = yield* makeFixture(outcome, barrier)
              const prepared = yield* prepareWithRuntimeStrategy(fixture.machine, strategy)
              let capturingOld = false
              let oldDeliveryId: number | undefined
              yield* prepared.inspection.pipe(
                Stream.runForEach((record) => {
                  if (record.subject.id !== "invocation-owner") return Effect.void
                  if (record._tag === "EventSent" && capturingOld && hasChannel(record.event, fixture.channel)) {
                    oldDeliveryId = record.deliveryId
                    return Deferred.succeed(oldSent, record).pipe(Effect.asVoid)
                  }
                  if (record._tag === "EventProcessed") {
                    if (record.deliveryId === oldDeliveryId) {
                      return Deferred.succeed(oldProcessed, record).pipe(Effect.asVoid)
                    }
                    if (isFence(record.event)) return Deferred.succeed(fenceProcessed, undefined).pipe(Effect.asVoid)
                  }
                  return Effect.void
                }),
                Effect.forkChild({ startImmediately: true })
              )
              const ref = yield* prepared.start
              yield* ref.send(Events.Enter())
              const terminalChild = outcome === "Child done" && reentry === "retained"
                ? Option.getOrThrow(yield* ref.child(fixture.child)) :
                undefined
              yield* ref.send(Events.Hold())
              yield* Deferred.await(holdEntered)
              if (reentry === "reenter") {
                yield* ref.send(Events.Restart())
              } else if (reentry === "exit and enter") {
                yield* ref.send(Events.Exit())
                yield* ref.send(Events.Enter())
              }
              capturingOld = true
              yield* fixture.releaseOld
              const sent = yield* Deferred.await(oldSent)
              assert.strictEqual(sent.target.id, "invocation-owner")
              capturingOld = false
              if (terminalChild !== undefined) {
                assert.strictEqual(yield* terminalChild.join, 1)
                assert.isTrue(Option.isNone(yield* ref.child(fixture.child)), "terminal child has unregistered")
              }
              yield* ref.send(Events.Fence())
              yield* Deferred.succeed(releaseHold, undefined)
              yield* Deferred.await(fenceProcessed)
              const processed = yield* Deferred.await(oldProcessed)
              const afterOld = yield* ref.snapshot
              if (reentry === "retained") {
                assert.isTrue(processed.handled)
                assert.strictEqual(afterOld.state.state.path, "Done")
                assert.deepStrictEqual(afterOld.state.state.value, {
                  _tag: "Done",
                  result: outcome === "Timer" ? 2 : 1
                })
                return
              }
              assert.isFalse(processed.handled, "the stale invocation must not handle the new owner")
              assert.strictEqual(afterOld.status, "active")
              assert.strictEqual(afterOld.state.state.path, "Working")
              assert.strictEqual(afterOld.state.state.value, undefined)
              yield* fixture.freshStarted
              yield* fixture.releaseFresh
              const afterFresh = yield* Machine.waitFor(ref, (snapshot) => snapshot.state.state.path === "Done")
              assert.deepStrictEqual(afterFresh.state.state.value, { _tag: "Done", result: 2 })
            }).pipe(Effect.scoped)
        )
      }
    }
  }
})

// Each run of `work` is one attempt. The test releases attempt `n` with a value
// and can await its start, so every interleaving below is forced, not timed.
const makeAttempts = () => {
  const gates: Array<Deferred.Deferred<number>> = []
  const started: Array<Deferred.Deferred<void>> = []
  const at = (n: number) => {
    while (gates.length <= n) {
      gates.push(Deferred.makeUnsafe())
      started.push(Deferred.makeUnsafe())
    }
  }
  let count = 0
  return {
    work: Effect.suspend(() => {
      const n = count++
      at(n)
      return Deferred.succeed(started[n]!, undefined).pipe(Effect.andThen(Deferred.await(gates[n]!)))
    }),
    count: () => count,
    started: (n: number) => Effect.suspend(() => (at(n), Deferred.await(started[n]!))),
    release: (n: number, value: number) => Effect.suspend(() => (at(n), Deferred.succeed(gates[n]!, value)))
  }
}

// A command that blocks the owner until released, so events sent meanwhile
// and invocation outcomes produced meanwhile queue in its mailbox in order.
const makeGate = Effect.fn(function*() {
  const entered = yield* Deferred.make<void>()
  const released = yield* Deferred.make<void>()
  const target: Machine.MachineTarget<void> = {
    id: "gate",
    sessionId: "gate-session",
    send: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released)), Effect.asVoid)
  }
  return { target, entered: Deferred.await(entered), release: Deferred.succeed(released, undefined) }
})

const makeRecorder = Effect.fn(function*(inspection: Stream.Stream<Machine.Inspection.Event>) {
  const seen: Array<Machine.Inspection.Event> = []
  const waiters: Array<{
    readonly predicate: (event: Machine.Inspection.Event) => boolean
    readonly deferred: Deferred.Deferred<Machine.Inspection.Event>
  }> = []
  yield* inspection.pipe(
    Stream.runForEach((record) => {
      seen.push(record)
      return Effect.forEach(
        waiters.filter((waiter) => waiter.predicate(record)),
        (waiter) => Deferred.succeed(waiter.deferred, record),
        { discard: true }
      )
    }),
    Effect.forkScoped({ startImmediately: true })
  )
  const next = <A extends Machine.Inspection.Event>(predicate: (event: Machine.Inspection.Event) => event is A) =>
    Effect.suspend(() => {
      const found = seen.find(predicate)
      if (found !== undefined) return Effect.succeed(found)
      const deferred = Deferred.makeUnsafe<Machine.Inspection.Event>()
      waiters.push({ predicate, deferred })
      return Deferred.await(deferred) as Effect.Effect<A>
    })
  // The first invocation outcome of `type` from `path` queued after this call.
  const queuedOutcome = (path: string, type: string) => {
    const from = seen.length
    return next((record): record is Machine.Inspection.EventSent =>
      record._tag === "EventSent" && seen.indexOf(record) >= from && isOutcome(record.event, path, type)
    )
  }
  const processed = (sent: Machine.Inspection.EventSent) =>
    next((record): record is Machine.Inspection.EventProcessed =>
      record._tag === "EventProcessed" && record.deliveryId === sent.deliveryId
    )
  return { queuedOutcome, processed }
})

const isOutcome = (event: unknown, path: string, type: string): boolean =>
  typeof event === "object" && event !== null && "path" in event && event.path === path && "type" in event &&
  event.type === type

// Holds the owner, runs `whileHeld`, then lets `produce` queue an outcome from
// `path` behind those events, and returns how the owner processed it.
const queueBehindHold = Effect.fn(function*(options: {
  readonly ref: Machine.MachineRef<any, any, any, any>
  readonly recorder: Effect.Success<ReturnType<typeof makeRecorder>>
  readonly gate: Effect.Success<ReturnType<typeof makeGate>>
  readonly whileHeld: Effect.Effect<void, unknown>
  readonly path: string
  readonly type: string
  readonly produce: Effect.Effect<unknown>
}) {
  yield* options.ref.send({ _tag: "Hold" })
  yield* options.gate.entered
  yield* options.whileHeld
  const queued = options.recorder.queuedOutcome(options.path, options.type)
  yield* options.produce
  const sent = yield* queued
  yield* options.gate.release
  return yield* options.recorder.processed(sent)
})

const Result = { fields: { result: Schema.Number } }

describe("invocation generations at owner boundaries", () => {
  for (const strategy of ["generic", "compiled"] as const) {
    it.effect(`${strategy} keeps a parallel sibling's queued result when another region reenters`, () =>
      Effect.gen(function*() {
        const gate = yield* makeGate()
        const left = makeAttempts()
        const right = makeAttempts()
        const Region = { states: { Working: {}, Done: { fields: { result: Schema.Number } } } }
        const machine = Machine.make({
          id: "parallel-owner",
          root: Machine.state({ states: { Active: { type: "parallel", states: { left: Region, right: Region } } } }),
          events: Machine.events({ Hold: {}, RestartLeft: {} }),
          effects: { left: left.work, right: right.work }
        }).handle({
          initial: { target: "Active" },
          on: { Hold: { stay: true, commands: (_, enqueue) => enqueue.sendTo(gate.target, undefined) } },
          states: {
            Active: {
              states: {
                left: {
                  initial: { target: "Active.left.Working" },
                  states: {
                    Working: {
                      // The same invocation id as the sibling region's.
                      invoke: {
                        src: "left",
                        id: "work",
                        onDone: { target: "Active.left.Done", data: ({ output }) => ({ result: output }) }
                      },
                      on: { RestartLeft: { target: "Active.left.Working", reenter: true } }
                    },
                    Done: {}
                  }
                },
                right: {
                  initial: { target: "Active.right.Working" },
                  states: {
                    Working: {
                      invoke: {
                        src: "right",
                        id: "work",
                        onDone: { target: "Active.right.Done", data: ({ output }) => ({ result: output }) }
                      }
                    },
                    Done: {}
                  }
                }
              }
            }
          }
        })
        const prepared = yield* prepareWithRuntimeStrategy(machine, strategy)
        const recorder = yield* makeRecorder(prepared.inspection)
        const ref = yield* prepared.start
        yield* left.started(0)
        yield* right.started(0)
        yield* ref.send({ _tag: "Hold" })
        yield* gate.entered
        yield* ref.send({ _tag: "RestartLeft" })
        const leftQueued = recorder.queuedOutcome("Active.left.Working", "done")
        yield* left.release(0, 1)
        const staleLeft = yield* leftQueued
        const rightQueued = recorder.queuedOutcome("Active.right.Working", "done")
        yield* right.release(0, 10)
        const sibling = yield* rightQueued
        yield* gate.release
        assert.isFalse((yield* recorder.processed(staleLeft)).handled, "the reentered region ignores its stale result")
        assert.isTrue((yield* recorder.processed(sibling)).handled, "the retained sibling accepts its queued result")
        yield* left.started(1)
        yield* left.release(1, 2)
        const done = yield* Machine.waitFor(
          ref,
          (snapshot) => snapshot.state.state.states.left.state.path === "Active.left.Done"
        )
        assert.deepStrictEqual(done.state.state.states.left.state.value, { _tag: "Done", result: 2 })
        assert.deepStrictEqual(done.state.state.states.right.state.value, { _tag: "Done", result: 10 })
        assert.strictEqual(left.count(), 2)
        assert.strictEqual(right.count(), 1)
      }).pipe(Effect.scoped))

    it.effect(`${strategy} does not route a result to another owner that reuses its invocation id`, () =>
      Effect.gen(function*() {
        const gate = yield* makeGate()
        const first = makeAttempts()
        const second = makeAttempts()
        const machine = Machine.make({
          id: "reused-id-owner",
          root: Machine.state({ states: { First: {}, Second: {}, Done: Result } }),
          events: Machine.events({ Hold: {}, Next: {} }),
          effects: { first: first.work, second: second.work }
        }).handle({
          initial: { target: "First" },
          on: { Hold: { stay: true, commands: (_, enqueue) => enqueue.sendTo(gate.target, undefined) } },
          states: {
            First: {
              invoke: {
                src: "first",
                id: "work",
                onDone: { target: "Done", data: ({ output }) => ({ result: output }) }
              },
              on: { Next: { target: "Second" } }
            },
            Second: {
              invoke: {
                src: "second",
                id: "work",
                onDone: { target: "Done", data: ({ output }) => ({ result: output }) }
              }
            },
            Done: {}
          }
        })
        const prepared = yield* prepareWithRuntimeStrategy(machine, strategy)
        const recorder = yield* makeRecorder(prepared.inspection)
        const ref = yield* prepared.start
        yield* first.started(0)
        const processed = yield* queueBehindHold({
          ref,
          recorder,
          gate,
          whileHeld: ref.send({ _tag: "Next" }),
          path: "First",
          type: "done",
          produce: first.release(0, 1)
        })
        assert.isFalse(processed.handled)
        yield* second.started(0)
        yield* second.release(0, 2)
        const done = yield* Machine.waitFor(ref, (snapshot) => snapshot.state.state.path === "Done")
        assert.deepStrictEqual(done.state.state.value, { _tag: "Done", result: 2 })
      }).pipe(Effect.scoped))

    for (
      const boundary of [
        { name: "reentering an ancestor", event: "RestartOuter", stale: true },
        { name: "a targetless reentry", event: "Again", stale: true },
        { name: "a transition between descendants", event: "Step", stale: false },
        { name: "a targetless stay", event: "Touch", stale: false }
      ] as const
    ) {
      it.effect(
        `${strategy} ${boundary.stale ? "ignores" : "accepts"} a queued result after ${boundary.name}`,
        () =>
          Effect.gen(function*() {
            const gate = yield* makeGate()
            const attempts = makeAttempts()
            const machine = Machine.make({
              id: "nested-owner",
              root: Machine.state({
                states: {
                  Outer: { states: { Working: { states: { A: {}, B: {} } } } },
                  Done: Result
                }
              }),
              events: Machine.events({ Hold: {}, RestartOuter: {}, Again: {}, Step: {}, Touch: {} }),
              effects: { work: attempts.work }
            }).handle({
              initial: { target: "Outer" },
              on: { Hold: { stay: true, commands: (_, enqueue) => enqueue.sendTo(gate.target, undefined) } },
              states: {
                Outer: {
                  initial: { target: "Outer.Working" },
                  on: { RestartOuter: { target: "Outer", reenter: true } },
                  states: {
                    Working: {
                      initial: { target: "Outer.Working.A" },
                      invoke: {
                        src: "work",
                        id: "work",
                        onDone: { target: "Done", data: ({ output }) => ({ result: output }) }
                      },
                      on: { Again: { reenter: true }, Touch: { stay: true } },
                      states: {
                        A: { on: { Step: { target: "Outer.Working.B" } } },
                        B: {}
                      }
                    }
                  }
                },
                Done: {}
              }
            })
            const prepared = yield* prepareWithRuntimeStrategy(machine, strategy)
            const recorder = yield* makeRecorder(prepared.inspection)
            const ref = yield* prepared.start
            yield* attempts.started(0)
            const processed = yield* queueBehindHold({
              ref,
              recorder,
              gate,
              whileHeld: ref.send({ _tag: boundary.event }),
              path: "Outer.Working",
              type: "done",
              produce: attempts.release(0, 1)
            })
            if (!boundary.stale) {
              assert.isTrue(processed.handled, "the retained owner accepts its queued result")
              assert.deepStrictEqual((yield* ref.snapshot).state.state.value, { _tag: "Done", result: 1 })
              assert.strictEqual(attempts.count(), 1)
              return
            }
            assert.isFalse(processed.handled, "the exited owner's result is ignored")
            yield* attempts.started(1)
            yield* attempts.release(1, 2)
            const done = yield* Machine.waitFor(ref, (snapshot) => snapshot.state.state.path === "Done")
            assert.deepStrictEqual(done.state.state.value, { _tag: "Done", result: 2 })
            assert.strictEqual(attempts.count(), 2)
          }).pipe(Effect.scoped)
      )
    }

    it.effect(`${strategy} ignores a queued result after raised events reenter its owner twice in one turn`, () =>
      Effect.gen(function*() {
        const gate = yield* makeGate()
        const attempts = makeAttempts()
        const Internal = Machine.internalEvents({ Again: {} })
        const machine = Machine.make({
          id: "raised-owner",
          root: Machine.state({ states: { Working: {}, Done: Result } }),
          events: Machine.events({ Hold: {}, Restart: {} }),
          internalEvents: Internal,
          effects: { work: attempts.work }
        }).handle({
          initial: { target: "Working" },
          on: { Hold: { stay: true, commands: (_, enqueue) => enqueue.sendTo(gate.target, undefined) } },
          states: {
            Working: {
              invoke: {
                src: "work",
                id: "work",
                onDone: { target: "Done", data: ({ output }) => ({ result: output }) }
              },
              on: {
                Restart: {
                  target: "Working",
                  reenter: true,
                  commands: (_, enqueue) => {
                    enqueue.raise(Internal.Again())
                  }
                },
                Again: { target: "Working", reenter: true }
              }
            },
            Done: {}
          }
        })
        const prepared = yield* prepareWithRuntimeStrategy(machine, strategy)
        const recorder = yield* makeRecorder(prepared.inspection)
        const ref = yield* prepared.start
        yield* attempts.started(0)
        const processed = yield* queueBehindHold({
          ref,
          recorder,
          gate,
          whileHeld: ref.send({ _tag: "Restart" }),
          path: "Working",
          type: "done",
          produce: attempts.release(0, 1)
        })
        assert.isFalse(processed.handled)
        // The owner is entered once for the whole turn, so exactly one fresh
        // attempt starts.
        yield* attempts.started(1)
        yield* attempts.release(1, 2)
        const done = yield* Machine.waitFor(ref, (snapshot) => snapshot.state.state.path === "Done")
        assert.deepStrictEqual(done.state.state.value, { _tag: "Done", result: 2 })
        assert.strictEqual(attempts.count(), 2)
      }).pipe(Effect.scoped))

    it.effect(`${strategy} ignores a synchronously completed child's result queued behind a reentry`, () =>
      Effect.gen(function*() {
        const gate = yield* makeGate()
        let starts = 0
        // A childless compiled child that is final on entry completes while it
        // is spawned, so its outcome is queued before the owner can react.
        const instant = Machine.child(
          "instant",
          Machine.make({
            root: Machine.state({
              states: { Complete: { type: "final", fields: { result: Schema.Number }, output: Schema.Number } }
            }),
            events: Machine.events({})
          }).handle({
            initial: { target: "Complete", data: () => ({ result: ++starts }) },
            states: { Complete: { output: ({ state }) => state.result } }
          })
        )
        const machine = Machine.make({
          id: "instant-owner",
          root: Machine.state({ states: { Idle: {}, Working: {}, Done: Result } }),
          events: Machine.events({ Hold: {}, Enter: {}, Restart: {} }),
          children: { instant }
        }).handle({
          initial: { target: "Idle" },
          on: { Hold: { stay: true, commands: (_, enqueue) => enqueue.sendTo(gate.target, undefined) } },
          states: {
            Idle: { on: { Enter: { target: "Working" } } },
            Working: {
              invoke: { src: "instant", onDone: { target: "Done", data: ({ output }) => ({ result: output }) } },
              on: { Restart: { target: "Working", reenter: true } }
            },
            Done: {}
          }
        })
        const prepared = yield* prepareWithRuntimeStrategy(machine, strategy)
        const ref = yield* prepared.start
        yield* ref.send({ _tag: "Hold" })
        yield* gate.entered
        yield* ref.send({ _tag: "Enter" })
        yield* ref.send({ _tag: "Restart" })
        yield* gate.release
        const done = yield* Machine.waitFor(ref, (snapshot) => snapshot.state.state.path === "Done")
        assert.deepStrictEqual(done.state.state.value, { _tag: "Done", result: 2 })
        assert.strictEqual(starts, 2)
      }).pipe(Effect.scoped))

    it.effect(`${strategy} begins a generation for invocations restarted by resume`, () =>
      Effect.gen(function*() {
        const gate = yield* makeGate()
        const attempts = makeAttempts()
        const machine = Machine.make({
          id: "resumed-owner",
          root: Machine.state({ states: { Working: {}, Done: Result } }),
          events: Machine.events({ Hold: {}, Restart: {} }),
          effects: { work: attempts.work }
        }).handle({
          initial: { target: "Working" },
          on: { Hold: { stay: true, commands: (_, enqueue) => enqueue.sendTo(gate.target, undefined) } },
          states: {
            Working: {
              invoke: {
                src: "work",
                id: "work",
                onDone: { target: "Done", data: ({ output }) => ({ result: output }) }
              },
              on: { Restart: { target: "Working", reenter: true } }
            },
            Done: {}
          }
        })
        const original = yield* (yield* prepareWithRuntimeStrategy(machine, strategy)).start
        yield* attempts.started(0)
        const encoded = yield* Machine.encodeSnapshot(machine, (yield* original.snapshot).state)
        yield* original.stop
        const decoded = yield* Machine.decodeSnapshot(machine, encoded)
        const prepared = yield* prepareResumedWithRuntimeStrategy(machine, decoded, strategy)
        const recorder = yield* makeRecorder(prepared.inspection)
        const ref = yield* prepared.start
        yield* attempts.started(1)
        const processed = yield* queueBehindHold({
          ref,
          recorder,
          gate,
          whileHeld: ref.send({ _tag: "Restart" }),
          path: "Working",
          type: "done",
          produce: attempts.release(1, 1)
        })
        assert.isFalse(processed.handled, "the resumed attempt's result is stale after reentry")
        yield* attempts.started(2)
        yield* attempts.release(2, 2)
        const done = yield* Machine.waitFor(ref, (snapshot) => snapshot.state.state.path === "Done")
        assert.deepStrictEqual(done.state.state.value, { _tag: "Done", result: 2 })
      }).pipe(Effect.scoped))

    it.effect(`${strategy} keeps the generation out of inspected invocation events`, () =>
      Effect.gen(function*() {
        const attempts = makeAttempts()
        const machine = Machine.make({
          id: "inspected-owner",
          root: Machine.state({ states: { Working: {}, Done: Result } }),
          events: Machine.events({}),
          effects: { work: attempts.work }
        }).handle({
          initial: { target: "Working" },
          states: {
            Working: {
              invoke: {
                src: "work",
                id: "work",
                onDone: { target: "Done", data: ({ output }) => ({ result: output }) }
              }
            },
            Done: {}
          }
        })
        const prepared = yield* prepareWithRuntimeStrategy(machine, strategy)
        const recorder = yield* makeRecorder(prepared.inspection)
        const ref = yield* prepared.start
        yield* attempts.started(0)
        const queued = recorder.queuedOutcome("Working", "done")
        yield* attempts.release(0, 1)
        const sent = yield* queued
        const processed = yield* recorder.processed(sent)
        assert.isTrue(processed.handled)
        for (const event of [sent.event, processed.event]) {
          assert.deepStrictEqual(Object.keys(event as object), ["path", "id", "type", "output"])
          assert.deepStrictEqual(JSON.parse(JSON.stringify(event)), {
            path: "Working",
            id: "work",
            type: "done",
            output: 1
          })
        }
        const encoded = yield* Machine.encodeSnapshot(machine, (yield* ref.snapshot).state)
        assert.notInclude(JSON.stringify(encoded), "current", "the encoded snapshot carries no generation")
      }).pipe(Effect.scoped))
  }
})
