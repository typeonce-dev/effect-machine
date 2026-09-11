import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../src/index.js"

type Snapshot = Machine.RuntimeSnapshot<number, "failed", string>
const active: Snapshot = { status: "active", state: 1 }
const done: Snapshot = { status: "done", state: 2, output: "ok" }
const stopped: Snapshot = { status: "stopped", state: 1 }
const error: Snapshot = { status: "error", state: 1, cause: Cause.fail("failed") }
const reference = (
  changes: Stream.Stream<Snapshot, never, import("effect/Scope").Scope>
): Machine.MachineRef<number, never, "failed", string> => ({
  id: "test",
  sessionId: "test-1",
  changes: Stream.scoped(changes),
  state: Effect.succeed(1),
  snapshot: Effect.succeed(active),
  emissions: Stream.empty,
  join: Effect.never,
  stop: Effect.die("must not stop the machine"),
  send: () => Effect.die("must not send"),
  child: () => Effect.succeed(Option.none()),
  childChanges: () => Stream.succeed(Option.none())
})

describe("Machine.waitFor", () => {
  it.effect("stops at the first match before a later failure in the same chunk", () =>
    Effect.gen(function*() {
      let calls = 0
      const result = yield* Machine.waitFor(reference(Stream.make(active, error)), (snapshot) => {
        calls++
        return snapshot.state === 1
      })
      assert.strictEqual(result, active)
      assert.strictEqual(calls, 1)
    }))

  it.effect("matches terminal snapshots before classifying them", () =>
    Effect.gen(function*() {
      for (const terminal of [done, stopped, error]) {
        const result = yield* Machine.waitFor(reference(Stream.make(active, terminal)), (snapshot) =>
          snapshot.status === terminal.status)
        assert.strictEqual(result, terminal)
      }
    }))

  it.effect("preserves unmatched failures, defects, and interruption", () =>
    Effect.gen(function*() {
      for (const cause of [Cause.fail("failed" as const), Cause.die("defect"), Cause.interrupt()]) {
        const result = yield* Effect.exit(Machine.waitFor(
          reference(Stream.make({ status: "error", state: 1, cause })),
          () => false
        ))
        assert.ok(Exit.isFailure(result))
        if (Exit.isFailure(result)) assert.deepStrictEqual(result.cause, cause)
      }
    }))

  it.effect("distinguishes stopping from completion without a match", () =>
    Effect.gen(function*() {
      const stopError = yield* Effect.flip(Machine.waitFor(reference(Stream.make(stopped)), () => false))
      assert.ok(stopError instanceof Machine.StoppedError)
      const doneError = yield* Effect.flip(Machine.waitFor(reference(Stream.make(done)), () => false))
      assert.ok(Cause.isNoSuchElementError(doneError))
    }))

  it.effect("is lazy, reusable, and releases each subscription", () =>
    Effect.gen(function*() {
      let opened = 0
      let closed = 0
      const ref = reference(Stream.fromEffect(Effect.acquireRelease(
        Effect.sync(() => {
          opened++
          return active
        }),
        () =>
          Effect.sync(() => {
            closed++
          })
      )))
      const waiting = Machine.waitFor(ref, () => true)
      assert.strictEqual(opened, 0)
      yield* Effect.all([waiting, waiting], { concurrency: "unbounded" })
      assert.strictEqual(opened, 2)
      assert.strictEqual(closed, 2)
    }))

  it.effect("cleans up on timeout without stopping the machine", () =>
    Effect.gen(function*() {
      const subscribed = yield* Deferred.make<void>()
      let closed = false
      const ref = reference(
        Stream.fromEffect(Effect.acquireRelease(
          Deferred.succeed(subscribed, undefined),
          () =>
            Effect.sync(() => {
              closed = true
            })
        )).pipe(Stream.flatMap(() => Stream.never))
      )
      const fiber = yield* Machine.waitFor(ref, () => false).pipe(
        Effect.timeout("1 second"),
        Effect.exit,
        Effect.forkScoped
      )
      yield* Deferred.await(subscribed)
      yield* TestClock.adjust("1 second")
      const result = yield* Fiber.join(fiber)
      assert.ok(Exit.isFailure(result))
      if (Exit.isFailure(result)) {
        assert.ok(
          result.cause.reasons.some((reason) => Cause.isFailReason(reason) && Cause.isTimeoutError(reason.error))
        )
      }
      assert.strictEqual(closed, true)
    }))

  it.effect("turns predicate exceptions into defects and cleans up", () =>
    Effect.gen(function*() {
      const defect = new Error("bad predicate")
      let closed = false
      const ref = reference(Stream.fromEffect(Effect.acquireRelease(Effect.succeed(active), () =>
        Effect.sync(() => {
          closed = true
        }))))
      const result = yield* Effect.exit(Machine.waitFor(ref, () => {
        throw defect
      }))
      assert.ok(Exit.isFailure(result))
      if (Exit.isFailure(result)) {
        assert.ok(result.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect))
      }
      assert.strictEqual(closed, true)
    }))

  it.effect("supports the curried form", () =>
    Effect.gen(function*() {
      const result = yield* Machine.waitFor((snapshot: Snapshot) => snapshot.status === "done")(
        reference(Stream.make(active, done))
      )
      assert.strictEqual(result, done)
    }))
})
