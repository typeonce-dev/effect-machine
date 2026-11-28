import { assert, describe, it } from "@effect/vitest"
import { Cause, Clock, Context, Duration, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../../src/index.js"
import * as ClusterProgress from "../../../src/internal/machine/clusterProgress.js"
import * as ClusterWork from "../../../src/internal/machine/clusterWork.js"
import * as Step from "../../../src/internal/machine/step.js"

const address = {
  entityType: "Worker",
  entityId: "worker-1",
  shardId: { group: "default", id: 1 }
} as any

const self = { id: "Worker", sessionId: "worker", send: () => Effect.void }

/** The work that a state `A`, which invokes `invoke` in order, starts. */
const workOf = (
  sources: {
    readonly effects?: Record<string, Effect.Effect<unknown> | ((input: never) => Effect.Effect<unknown>)>
    readonly timers?: Record<string, Duration.Input | ((input: never) => Duration.Input)>
  },
  invoke: ReadonlyArray<object>
): ReadonlyArray<Step.Work> => {
  const machine = Machine.make({
    root: Machine.state({ states: { A: {} } }),
    events: Machine.events({}),
    effects: sources.effects ?? {},
    timers: sources.timers ?? {}
  } as any).handle({ initial: { target: "A" }, states: { A: { invoke } } } as any)
  const started = Step.make(machine as Machine.Machine.Any, { self }).start()
  if (Exit.isFailure(started)) throw new Error("The machine does not start")
  return started.value.running
}

const effects = (ids: ReadonlyArray<string>, effect: (id: string) => Effect.Effect<unknown>) =>
  workOf(
    { effects: Object.fromEntries(ids.map((id) => [id, effect(id)])) },
    ids.map((src) => ({ src, onDone: { stay: true }, onFailure: { stay: true } }))
  )

/** Work whose interruption is an ordinary success, so nothing but the host tells them apart. */
const stubborn = Effect.interruptible(Effect.never).pipe(Effect.exit, Effect.as("too late"), Effect.uninterruptible)

const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true })

const makeHost = (context: Context.Context<never> = Context.empty()) => {
  const ended: Array<readonly [id: string, exit: Exit.Exit<unknown, unknown>]> = []
  const seen: Array<ClusterWork.Running> = []
  const work = new ClusterWork.ClusterWork<never>({
    definitionId: "Worker",
    address,
    context,
    onEnd: (running, exit) =>
      Effect.sync(() => {
        seen.push(running)
        ended.push([running.work.id, exit])
      })
  })
  return { ended, seen, work }
}

const pending = (work: ClusterWork.ClusterWork<never>) => work.pendingExcept(() => false)

describe("ClusterWork", () => {
  it.effect("reports how work ended, and keeps it pending until its outcome is applied", () =>
    Effect.gen(function*() {
      const { ended, seen, work } = makeHost()
      assert.isFalse(pending(work))
      const [ok, on] = workOf(
        { effects: { ok: Effect.succeed(1), on: Effect.never } },
        [{ src: "ok", onDone: { stay: true } }, { src: "on", onDone: { stay: true } }]
      )
      yield* work.start([ok!, on!], ClusterProgress.empty)
      yield* settle
      assert.deepStrictEqual(ended, [["ok", Exit.succeed(1)]])
      assert.isFalse(seen[0]!.stopped)
      assert.strictEqual(seen[0]!.work, ok)
      work.settle(seen[0]!)
      assert.isTrue(pending(work))
      yield* work.stopAll
      assert.isFalse(pending(work))
      yield* work.close
    }))

  const stops: Record<
    string,
    (work: ClusterWork.ClusterWork<never>, works: ReadonlyArray<Step.Work>) => Effect.Effect<void>
  > = {
    "the step that stops it": (work, works) => work.stop(works),
    "the end of all work": (work) => work.stopAll,
    "the end of the instance": (work) => work.close
  }
  for (const [name, stop] of Object.entries(stops)) {
    it.effect(`reports nothing about work stopped by ${name}`, () =>
      Effect.gen(function*() {
        const { ended, work } = makeHost()
        const captured: Array<ClusterWork.Running> = []
        const host = new ClusterWork.ClusterWork<never>({
          definitionId: "Worker",
          address,
          context: Context.empty(),
          onEnd: (running) => Effect.sync(() => void captured.push(running))
        })
        // Ended before it is stopped, with an outcome that was not applied yet.
        const done = effects(["done"], () => Effect.void)
        yield* host.start(done, ClusterProgress.empty)
        yield* settle
        yield* stop(host, done)
        assert.isTrue(captured[0]!.stopped)
        assert.isFalse(pending(host))

        // Ends because it is stopped.
        const late = effects(["late"], () => stubborn)
        yield* work.start(late, ClusterProgress.empty)
        yield* stop(work, late)
        yield* settle
        assert.deepStrictEqual(ended, [])
        yield* work.close
        yield* host.close
      }))
  }

  it.effect("stops only the work it is given", () =>
    Effect.gen(function*() {
      const { ended, work } = makeHost()
      const interrupted: Array<string> = []
      const [a, b] = effects(
        ["a", "b"],
        (id) => Effect.onInterrupt(Effect.never, () => Effect.sync(() => void interrupted.push(id)))
      )
      yield* work.start([a!, b!], ClusterProgress.empty)
      yield* work.stop([a!, ...effects(["a"], () => Effect.never)])
      assert.deepStrictEqual(interrupted, ["a"])
      assert.isTrue(pending(work))
      yield* work.close
      assert.deepStrictEqual(interrupted, ["a", "b"])
      assert.deepStrictEqual(ended, [])
    }))

  it.effect("starts nothing once the instance ended", () =>
    Effect.gen(function*() {
      const { ended, work } = makeHost()
      yield* work.close
      assert.isTrue(work.closed)
      let runs = 0
      yield* work.start(effects(["late"], () => Effect.sync(() => runs++)), ClusterProgress.empty)
      yield* Fiber.await(yield* work.fork(Effect.sync(() => void runs++)))
      yield* settle
      assert.strictEqual(runs, 0)
      assert.deepStrictEqual(ended, [])
    }))

  it.effect("reports the first work that cannot be evaluated, and starts none after it", () =>
    Effect.gen(function*() {
      const { ended, work } = makeHost()
      const error = new Error("no input")
      const works = workOf(
        { effects: { first: Effect.void, second: (_: never) => Effect.void, third: Effect.void } },
        [
          { src: "first", onDone: { stay: true } },
          {
            src: "second",
            input: () => {
              throw error
            },
            onDone: { stay: true }
          },
          { src: "third", onDone: { stay: true } }
        ]
      )
      const failure = yield* work.start(works, ClusterProgress.empty)
      assert.strictEqual(failure?.work, works[1])
      assert.isTrue(failure !== undefined && Exit.isFailure(failure.exit) && Cause.squash(failure.exit.cause) === error)
      yield* settle
      assert.deepStrictEqual(ended.map(([id]) => id), ["first"])
      yield* work.close
    }))

  describe("timers", () => {
    /** A host whose timers wait for the clock of the test. */
    const makeTimed = Effect.map(Clock.Clock, (clock) => makeHost(Context.make(Clock.Clock, clock)))

    const timers = (ids: ReadonlyArray<string>, duration: (id: string) => Duration.Input | ((_: unknown) => never)) => {
      const sources = Object.fromEntries(ids.map((id) => [id, duration(id)]))
      return workOf(
        { timers: sources },
        // A source that is a function takes the input of its invocation.
        ids.map((src) =>
          typeof sources[src] === "function"
            ? { src, input: () => undefined, onDone: { stay: true } }
            : { src, onDone: { stay: true } }
        )
      )
    }

    const waiting = (dueAt: Record<string, number>) =>
      Object.entries(dueAt).reduce(
        (progress, [id, at]) => ClusterProgress.wait(progress, { path: "A", id }, at),
        ClusterProgress.empty
      )

    it.effect("wait for their stored due time, in the order they were started", () =>
      Effect.gen(function*() {
        const { ended, seen, work } = yield* makeTimed
        yield* TestClock.setTime(5000)
        // Durations that the host never reads again.
        const started = timers(["late", "first", "second", "past"], () => (_) => {
          throw new Error("evaluated again")
        })
        const progress = waiting({ late: 9000, first: 8000, second: 8000, past: 1 })
        assert.strictEqual(yield* work.start(started, progress), undefined)
        yield* settle
        assert.deepStrictEqual(ended, [["past", Exit.succeed(undefined)]])
        yield* TestClock.adjust(2999)
        assert.strictEqual(ended.length, 1)
        yield* TestClock.adjust(1)
        yield* settle
        assert.deepStrictEqual(ended.map(([id]) => id), ["past", "first", "second"])
        for (const ended of seen) work.settle(ended)
        assert.isTrue(pending(work))
        yield* TestClock.adjust(1000)
        yield* settle
        assert.strictEqual(seen.at(-1)!.work.id, "late")
        work.settle(seen.at(-1)!)
        assert.isFalse(pending(work))
        yield* work.close
      }))

    for (const [name, stop] of Object.entries(stops)) {
      it.effect(`report nothing when stopped by ${name}`, () =>
        Effect.gen(function*() {
          const { ended, work } = yield* makeTimed
          const started = timers(["wait"], () => "1 second")
          yield* work.start(started, waiting({ wait: 1000 }))
          yield* TestClock.adjust(999)
          assert.isTrue(pending(work))
          yield* stop(work, started)
          assert.isFalse(pending(work))
          yield* TestClock.adjust("1 minute")
          yield* settle
          assert.deepStrictEqual(ended, [])
          yield* work.close
        }))
    }

    it.effect("without a due time fail where they would have started", () =>
      Effect.gen(function*() {
        const { ended, work } = yield* makeTimed
        // A duration that its input does not name ends the timer, next to the others.
        const named = timers(["first", "invalid", "last"], (id) => id === "invalid" ? "soon" as never : 0)
        assert.strictEqual(yield* work.start(named, waiting({ first: 0, last: 0 })), undefined)
        yield* settle
        assert.deepStrictEqual(ended.map(([id, exit]) => [id, Exit.hasDies(exit)]), [
          ["first", false],
          ["invalid", true],
          ["last", false]
        ])
        yield* work.stopAll
        ended.length = 0
        // A duration that cannot be computed ends the start.
        const error = new Error("no duration")
        const thrown = timers(["first", "throws", "last"], (id) =>
          id === "throws" ?
            (_) => {
              throw error
            } :
            0)
        const failure = yield* work.start(thrown, waiting({ first: 0, last: 0 }))
        assert.strictEqual(failure?.work, thrown[1])
        assert.isTrue(
          failure !== undefined && Exit.isFailure(failure.exit) && Cause.squash(failure.exit.cause) === error
        )
        yield* settle
        assert.deepStrictEqual(ended.map(([id]) => id), ["first"])
        yield* work.stopAll
        // A host that stored no due time for a timer has a defect.
        const unstored = timers(["wait"], () => "1 second")
        const missing = yield* work.start(unstored, ClusterProgress.empty)
        assert.isTrue(missing !== undefined && Exit.isFailure(missing.exit))
        assert.match(String(Cause.squash((missing!.exit as Exit.Failure<unknown, unknown>).cause)), /has no due time/)
        yield* work.close
      }))
  })
})
