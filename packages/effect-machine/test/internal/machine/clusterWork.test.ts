import { assert, describe, it } from "@effect/vitest"
import { Cause, Clock, Context, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import * as ClusterProgress from "../../../src/internal/machine/clusterProgress.js"
import * as ClusterWork from "../../../src/internal/machine/clusterWork.js"
import type {
  EffectInvocation,
  InvocationGroup,
  ResolvedInvocation,
  TimerInvocation
} from "../../../src/internal/machine/invocationResolution.js"

const address = {
  entityType: "Worker",
  entityId: "worker-1",
  shardId: { group: "default", id: 1 }
} as any

const invocation = (path: string, id: string, effect: Effect.Effect<unknown, unknown, unknown>): EffectInvocation => ({
  _tag: "Effect",
  path,
  id,
  sourceName: id,
  channels: { done: true, failure: true, element: false, snapshot: false },
  effect: () => effect
})

/** A timer whose duration must not be evaluated again. */
const timer = (path: string, id: string): TimerInvocation => ({
  _tag: "Timer",
  path,
  id,
  sourceName: id,
  channels: { done: true, failure: false, element: false, snapshot: false },
  duration: () => {
    throw new Error("evaluated again")
  }
})

const group = (path: string, ...invocations: ReadonlyArray<ResolvedInvocation>): InvocationGroup => ({
  path,
  invocations
})

/** Work whose interruption is an ordinary success, so nothing but the host tells them apart. */
const stubborn = Effect.interruptible(Effect.never).pipe(Effect.exit, Effect.as("too late"), Effect.uninterruptible)

const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true })

/** What a stored state without progress says. */
const none: ClusterWork.Stored = { progress: ClusterProgress.empty, unscheduled: [] }

const waiting = (dueAt: number): ClusterWork.Stored => ({
  ...none,
  progress: ClusterProgress.wait(ClusterProgress.empty, { path: "A", id: "wait" }, dueAt)
})

const makeHost = (context: Context.Context<never> = Context.empty()) => {
  const ended: Array<readonly [id: string, exit: Exit.Exit<unknown, unknown>]> = []
  const seen: Array<ClusterWork.Work> = []
  const work = new ClusterWork.ClusterWork<never>({
    definitionId: "Worker",
    address,
    context,
    onEnd: (work, exit) =>
      Effect.sync(() => {
        seen.push(work)
        ended.push([work.invocation.id, exit])
      })
  })
  return { ended, seen, work }
}

describe("ClusterWork", () => {
  it.effect("reports how work ended, and keeps it pending until its outcome is applied", () =>
    Effect.gen(function*() {
      const { ended, seen, work } = makeHost()
      assert.isFalse(work.pending)
      yield* work.start(
        [group("A", invocation("A", "ok", Effect.succeed(1)), invocation("A", "on", Effect.never))],
        none
      )
      yield* settle
      assert.deepStrictEqual(ended, [["ok", Exit.succeed(1)]])
      assert.isFalse(seen[0]!.stopped)
      assert.isTrue(seen[0]!.generation.current)
      work.settle(seen[0]!)
      assert.isTrue(work.pending)
      yield* work.stopAll
      assert.isFalse(work.pending)
      // The generation outlives the end of its work, and ends with its state.
      assert.isFalse(seen[0]!.generation.current)
      yield* work.close
    }))

  it.effect("shares one generation within a group, and leaves out settled invocations", () =>
    Effect.gen(function*() {
      const { ended, seen, work } = makeHost()
      const groups = [
        group("A", ...["one", "two", "three"].map((id) => invocation("A", id, Effect.void))),
        group("B", invocation("B", "two", Effect.void))
      ]
      assert.strictEqual(
        yield* work.start(groups, {
          ...none,
          progress: ClusterProgress.settle(ClusterProgress.empty, { path: "A", id: "two" })
        }),
        undefined
      )
      yield* settle
      assert.deepStrictEqual(ended.map(([id]) => id), ["one", "three", "two"])
      assert.strictEqual(seen[0]!.generation, seen[1]!.generation)
      assert.notStrictEqual(seen[0]!.generation, seen[2]!.generation)
      yield* work.close
    }))

  const stops: Record<string, (work: ClusterWork.ClusterWork<never>) => Effect.Effect<void>> = {
    "the exit of its state": (work) => work.stopPaths(["A"]),
    "the end of all work": (work) => work.stopAll,
    "the end of the instance": (work) => work.close
  }
  for (const [name, stop] of Object.entries(stops)) {
    it.effect(`reports nothing about work stopped by ${name}`, () =>
      Effect.gen(function*() {
        const { ended, work } = makeHost()
        const captured: Array<ClusterWork.Work> = []
        const host = new ClusterWork.ClusterWork<never>({
          definitionId: "Worker",
          address,
          context: Context.empty(),
          onEnd: (work) => Effect.sync(() => void captured.push(work))
        })
        // Ended before it is stopped, with an outcome that was not applied yet.
        yield* host.start([group("A", invocation("A", "done", Effect.void))], none)
        yield* settle
        const [done] = captured
        yield* stop(host)
        assert.isTrue(done!.stopped)
        assert.isFalse(done!.generation.current)
        assert.deepStrictEqual(ClusterWork.outcomeOf(done!, { _tag: "Done", output: 1 }), { _tag: "Stopped" })
        assert.isFalse(host.pending)

        // Ends because it is stopped.
        yield* work.start([group("A", invocation("A", "late", stubborn))], none)
        yield* stop(work)
        yield* settle
        assert.deepStrictEqual(ended, [])
        yield* work.close
        yield* host.close
      }))
  }

  it.effect("stops only the work of exited paths", () =>
    Effect.gen(function*() {
      const { ended, work } = makeHost()
      const interrupted: Array<string> = []
      const running = (path: string) =>
        group(
          path,
          invocation(path, path, Effect.onInterrupt(Effect.never, () => Effect.sync(() => void interrupted.push(path))))
        )
      yield* work.start([running("A"), running("B")], none)
      yield* work.stopPaths(["A", "Missing"])
      assert.deepStrictEqual(interrupted, ["A"])
      assert.isTrue(work.pending)
      yield* work.close
      assert.deepStrictEqual(interrupted, ["A", "B"])
      assert.deepStrictEqual(ended, [])
    }))

  it.effect("starts nothing once the instance ended", () =>
    Effect.gen(function*() {
      const { ended, work } = makeHost()
      yield* work.close
      assert.isTrue(work.closed)
      let runs = 0
      yield* work.start([group("A", invocation("A", "late", Effect.sync(() => runs++)))], none)
      yield* Fiber.await(yield* work.fork(Effect.sync(() => void runs++)))
      yield* settle
      assert.strictEqual(runs, 0)
      assert.deepStrictEqual(ended, [])
    }))

  it.effect("reports the first source that cannot be constructed, and starts none after it", () =>
    Effect.gen(function*() {
      const { ended, work } = makeHost()
      const error = new Error("no source")
      const failure = yield* work.start([
        group(
          "A",
          invocation("A", "first", Effect.void),
          {
            ...invocation("A", "second", Effect.void),
            effect: () => {
              throw error
            }
          },
          invocation("A", "third", Effect.void)
        ),
        group("B", invocation("B", "fourth", Effect.void))
      ], none)
      assert.deepStrictEqual(failure?.key, { path: "A", id: "second" })
      yield* settle
      assert.deepStrictEqual(ended.map(([id]) => id), ["first"])
      yield* work.close
    }))

  describe("timers", () => {
    /** A host whose timers wait for the clock of the test. */
    const makeTimed = Effect.map(Clock.Clock, (clock) => makeHost(Context.make(Clock.Clock, clock)))

    it.effect("wait for their stored due time, in the order they were started", () =>
      Effect.gen(function*() {
        const { ended, seen, work } = yield* makeTimed
        yield* TestClock.setTime(5000)
        const progress = ["late", "first", "second", "past"].reduce(
          (progress, id) => ClusterProgress.wait(progress, { path: "A", id }, { late: 9000, past: 1 }[id] ?? 8000),
          ClusterProgress.empty
        )
        const timers = ["late", "first", "second", "past"].map((id) => timer("A", id))
        assert.strictEqual(yield* work.start([group("A", ...timers)], { ...none, progress }), undefined)
        yield* settle
        assert.deepStrictEqual(ended, [["past", Exit.succeed(undefined)]])
        yield* TestClock.adjust(2999)
        assert.strictEqual(ended.length, 1)
        yield* TestClock.adjust(1)
        yield* settle
        assert.deepStrictEqual(ended.map(([id]) => id), ["past", "first", "second"])
        assert.isTrue(seen.every(({ generation }) => generation === seen[0]!.generation))
        for (const ended of seen) work.settle(ended)
        assert.isTrue(work.pending)
        yield* TestClock.adjust(1000)
        yield* settle
        assert.strictEqual(seen.at(-1)!.invocation.id, "late")
        work.settle(seen.at(-1)!)
        assert.isFalse(work.pending)
        yield* work.close
      }))

    it.effect("that are settled do not start", () =>
      Effect.gen(function*() {
        const { ended, work } = yield* makeTimed
        const progress = ClusterProgress.settle(waiting(0).progress, { path: "A", id: "wait" })
        yield* work.start([group("A", timer("A", "wait"))], { ...none, progress })
        yield* settle
        assert.isFalse(work.pending)
        assert.deepStrictEqual(ended, [])
        yield* work.close
      }))

    for (const [name, stop] of Object.entries(stops)) {
      it.effect(`report nothing when stopped by ${name}`, () =>
        Effect.gen(function*() {
          const { ended, work } = yield* makeTimed
          yield* work.start([group("A", timer("A", "wait"))], waiting(1000))
          yield* TestClock.adjust(999)
          assert.isTrue(work.pending)
          yield* stop(work)
          assert.isFalse(work.pending)
          yield* TestClock.adjust("1 minute")
          yield* settle
          assert.deepStrictEqual(ended, [])
          yield* work.close
        }))
    }

    it.effect("without a due time fail where they would have started", () =>
      Effect.gen(function*() {
        const { ended, work } = yield* makeTimed
        const cause = Cause.die(new Error("no duration"))
        const key = { path: "A", id: "wait" }
        const groups = [
          group("A", invocation("A", "first", Effect.void), timer("A", "wait"), invocation("A", "last", Effect.void))
        ]
        // As its own outcome, next to the others.
        assert.strictEqual(
          yield* work.start(groups, { ...none, unscheduled: [{ key, stage: "Outcome", cause }] }),
          undefined
        )
        yield* settle
        assert.deepStrictEqual(
          ended.map(([id, exit]) => [id, Exit.isSuccess(exit) || Cause.squash(exit.cause) === Cause.squash(cause)]),
          [["first", true], ["wait", true], ["last", true]]
        )
        assert.isTrue(Exit.hasDies(ended[1]![1]))
        yield* work.stopAll
        ended.length = 0
        // As a source that ends the start.
        assert.deepStrictEqual(
          yield* work.start(groups, { ...none, unscheduled: [{ key, stage: "Source", cause }] }),
          { key, cause }
        )
        yield* settle
        assert.deepStrictEqual(ended.map(([id]) => id), ["first"])
        yield* work.stopAll
        // A host that says nothing about a timer has a defect.
        const failure = yield* work.start(groups, none)
        assert.deepStrictEqual(failure?.key, key)
        assert.match(String(Cause.squash(failure!.cause)), /has no due time/)
        yield* work.close
      }))
  })
})
