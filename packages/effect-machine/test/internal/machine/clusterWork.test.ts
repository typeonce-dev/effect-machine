import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Fiber } from "effect"
import * as ClusterWork from "../../../src/internal/machine/clusterWork.js"
import type { EffectInvocation, InvocationGroup } from "../../../src/internal/machine/invocationResolution.js"

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

const group = (path: string, ...invocations: ReadonlyArray<EffectInvocation>): InvocationGroup => ({
  path,
  invocations
})

/** Work whose interruption is an ordinary success, so nothing but the host tells them apart. */
const stubborn = Effect.interruptible(Effect.never).pipe(Effect.exit, Effect.as("too late"), Effect.uninterruptible)

const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true })

const makeHost = () => {
  const ended: Array<readonly [id: string, exit: Exit.Exit<unknown, unknown>]> = []
  const seen: Array<ClusterWork.Work> = []
  const work = new ClusterWork.ClusterWork<never>({
    machineId: "Worker",
    address,
    context: Context.empty(),
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
      yield* work.start([group("A", invocation("A", "ok", Effect.succeed(1)), invocation("A", "on", Effect.never))], [])
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
      assert.strictEqual(yield* work.start(groups, [{ path: "A", id: "two" }]), undefined)
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
          machineId: "Worker",
          address,
          context: Context.empty(),
          onEnd: (work) => Effect.sync(() => void captured.push(work))
        })
        // Ended before it is stopped, with an outcome that was not applied yet.
        yield* host.start([group("A", invocation("A", "done", Effect.void))], [])
        yield* settle
        const [done] = captured
        yield* stop(host)
        assert.isTrue(done!.stopped)
        assert.isFalse(done!.generation.current)
        assert.deepStrictEqual(ClusterWork.outcomeOf(done!, { _tag: "Done", output: 1 }), { _tag: "Stopped" })
        assert.isFalse(host.pending)

        // Ends because it is stopped.
        yield* work.start([group("A", invocation("A", "late", stubborn))], [])
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
      yield* work.start([running("A"), running("B")], [])
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
      yield* work.start([group("A", invocation("A", "late", Effect.sync(() => runs++)))], [])
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
      ], [])
      assert.deepStrictEqual(failure?.key, { path: "A", id: "second" })
      yield* settle
      assert.deepStrictEqual(ended.map(([id]) => id), ["first"])
      yield* work.close
    }))
})
