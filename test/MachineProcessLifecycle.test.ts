import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Ref, Stream } from "effect"
import { Machine } from "../src/index.js"
import * as MachineRuntime from "../src/internal/machineRuntime.js"

describe("machine process lifecycle", () => {
  it.effect("allows initialization to request and await self-stop before a run fiber exists", () =>
    Effect.gen(function*() {
      const initializedAfterStop = yield* Ref.make(false)
      const runCount = yield* Ref.make(0)
      const ref = yield* MachineRuntime.startProcess(
        Machine.logic({
          initial: ({ self }) =>
            self.stop.pipe(
              Effect.andThen(Ref.set(initializedAfterStop, true)),
              Effect.as(1)
            ),
          run: () => Ref.update(runCount, (count) => count + 1).pipe(Effect.andThen(Effect.never))
        })
      )

      const joined = yield* Effect.exit(ref.join)

      assert.strictEqual(yield* Ref.get(initializedAfterStop), true)
      assert.strictEqual(yield* Ref.get(runCount), 0)
      assert.deepStrictEqual(yield* ref.snapshot, { status: "stopped", state: 1 })
      assert(Exit.isFailure(joined))
      if (Exit.isFailure(joined)) {
        assert.instanceOf(joined.cause.reasons.find(Cause.isFailReason)?.error, Machine.StoppedError)
      }
    }))

  it.effect("allows the run fiber to await self-stop without joining itself", () =>
    Effect.gen(function*() {
      const continuedAfterStop = yield* Ref.make(false)
      const ref = yield* MachineRuntime.startProcess(
        Machine.logic({
          initial: 1,
          run: ({ self }) =>
            self.stop.pipe(
              Effect.andThen(Ref.set(continuedAfterStop, true)),
              Effect.andThen(Effect.succeed("unexpected"))
            )
        })
      )

      const joined = yield* Effect.exit(ref.join)

      assert.strictEqual(yield* Ref.get(continuedAfterStop), false)
      assert.deepStrictEqual(yield* ref.snapshot, { status: "stopped", state: 1 })
      assert(Exit.isFailure(joined))
      if (Exit.isFailure(joined)) {
        assert.instanceOf(joined.cause.reasons.find(Cause.isFailReason)?.error, Machine.StoppedError)
      }
    }))

  it.effect("terminalizes once when concurrent callers stop the same process", () =>
    Effect.gen(function*() {
      const cleanupCount = yield* Ref.make(0)
      const ref = yield* MachineRuntime.startProcess(
        Machine.logic({
          initial: 1,
          run: () =>
            Effect.never.pipe(
              Effect.ensuring(Ref.update(cleanupCount, (count) => count + 1))
            )
        })
      )

      yield* Effect.all([ref.stop, ref.stop, ref.stop], { concurrency: "unbounded" })
      yield* Effect.yieldNow

      assert.strictEqual(yield* Ref.get(cleanupCount), 1)
      assert.deepStrictEqual(yield* ref.snapshot, { status: "stopped", state: 1 })
      assert.instanceOf(yield* Effect.flip(ref.join), Machine.StoppedError)
      assert.instanceOf(yield* Effect.flip(ref.send(undefined as never)), Machine.StoppedError)

      const stopAgain = yield* ref.stop.pipe(Effect.forkChild)
      yield* Fiber.join(stopAgain)
      assert.strictEqual(yield* Ref.get(cleanupCount), 1)
    }))

  it.effect("freezes the stopped snapshot before interrupted worker finalizers run", () =>
    Effect.gen(function*() {
      const finalizerRan = yield* Ref.make(false)
      const updateEvaluated = yield* Ref.make(false)
      const ref = yield* MachineRuntime.startProcess(
        Machine.logic({
          initial: 1,
          run: (context) =>
            Effect.never.pipe(
              Effect.ensuring(
                Ref.set(finalizerRan, true).pipe(
                  Effect.andThen(context.setState(2)),
                  Effect.andThen(
                    context.updateState((state) => Ref.set(updateEvaluated, true).pipe(Effect.as(state + 10)))
                  )
                )
              )
            )
        })
      )
      const publications = yield* ref.changes.pipe(Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow

      yield* ref.stop

      assert.strictEqual(yield* Ref.get(finalizerRan), true)
      assert.strictEqual(yield* Ref.get(updateEvaluated), false)
      assert.deepStrictEqual(Array.from(yield* Fiber.join(publications)), [
        { status: "active", state: 1 },
        { status: "stopped", state: 1 }
      ])
      assert.deepStrictEqual(yield* ref.snapshot, { status: "stopped", state: 1 })
    }))

  it.effect("completes a first changes subscription started after terminalization", () =>
    Effect.gen(function*() {
      const ref = yield* MachineRuntime.startProcess(
        Machine.logic({
          initial: 1,
          run: () => Effect.never
        })
      )

      yield* ref.stop

      assert.deepStrictEqual(Array.from(yield* Stream.runCollect(ref.changes)), [
        { status: "stopped", state: 1 }
      ])
    }))

  it.effect("does not lose completion when a first changes subscription races terminal publication", () =>
    Effect.gen(function*() {
      yield* Effect.forEach(
        Array.from({ length: 100 }),
        () =>
          Effect.gen(function*() {
            const release = yield* Deferred.make<void>()
            const race = yield* Deferred.make<void>()
            const ref = yield* MachineRuntime.startProcess(
              Machine.logic({
                initial: 0,
                run: (context) =>
                  Deferred.await(release).pipe(
                    Effect.andThen(context.setState(1)),
                    Effect.as("done")
                  )
              })
            )
            const changes = yield* Deferred.await(race).pipe(
              Effect.andThen(Stream.runCollect(ref.changes)),
              Effect.forkChild
            )
            const completion = yield* Deferred.await(race).pipe(
              Effect.andThen(Deferred.succeed(release, void 0)),
              Effect.forkChild
            )

            yield* Deferred.succeed(race, void 0)
            const snapshots = Array.from(yield* Fiber.join(changes))
            yield* Fiber.join(completion)

            assert.deepStrictEqual(snapshots.at(-1), {
              status: "done",
              state: 1,
              output: "done"
            })
            assert.strictEqual(snapshots.filter((snapshot) => snapshot.status === "done").length, 1)
          }),
        { concurrency: "unbounded" }
      )
    }))

  it.effect("releases a child id after that child requests self-stop during initialization", () =>
    Effect.gen(function*() {
      const firstRunCount = yield* Ref.make(0)
      const replacementReady = yield* Deferred.make<Machine.MachineRef<number, never>>()
      const parent = yield* MachineRuntime.startProcess(
        Machine.logic({
          initial: undefined,
          run: ({ spawn }) =>
            Effect.gen(function*() {
              const first = yield* spawn(
                Machine.logic({
                  initial: ({ self }) => self.stop.pipe(Effect.as(1)),
                  run: () => Ref.update(firstRunCount, (count) => count + 1).pipe(Effect.andThen(Effect.never))
                }),
                { id: "worker" }
              )
              yield* Effect.exit(first.join)

              const replacement = yield* spawn(
                Machine.logic({
                  initial: 2,
                  run: () => Effect.never
                }),
                { id: "worker" }
              )
              yield* Deferred.succeed(replacementReady, replacement)
              return yield* Effect.never
            })
        })
      )

      const replacement = yield* Deferred.await(replacementReady)

      assert.strictEqual(yield* Ref.get(firstRunCount), 0)
      assert.deepStrictEqual(yield* replacement.snapshot, { status: "active", state: 2 })

      yield* parent.stop

      assert.deepStrictEqual(yield* replacement.snapshot, { status: "stopped", state: 2 })
    }))

  it.effect("publishes and cleans up exactly once when stop races process completion", () =>
    Effect.gen(function*() {
      const cleanupCount = yield* Ref.make(0)
      const release = yield* Deferred.make<void>()
      const race = yield* Deferred.make<void>()
      const ref = yield* MachineRuntime.startProcess(
        Machine.logic({
          initial: 1,
          run: () =>
            Deferred.await(release).pipe(
              Effect.as("done"),
              Effect.ensuring(Ref.update(cleanupCount, (count) => count + 1))
            )
        })
      )
      const terminalSnapshots = yield* ref.changes.pipe(
        Stream.filter((snapshot) => snapshot.status !== "active"),
        Stream.runCollect,
        Effect.forkChild
      )
      const stopFiber = yield* Deferred.await(race).pipe(
        Effect.andThen(ref.stop),
        Effect.forkChild
      )
      const completionFiber = yield* Deferred.await(race).pipe(
        Effect.andThen(Deferred.succeed(release, void 0)),
        Effect.forkChild
      )

      yield* Deferred.succeed(race, void 0)
      yield* Fiber.join(stopFiber)
      yield* Fiber.join(completionFiber)
      const published = Array.from(yield* Fiber.join(terminalSnapshots))
      const snapshot = yield* ref.snapshot
      const joined = yield* Effect.exit(ref.join)

      assert.strictEqual(yield* Ref.get(cleanupCount), 1)
      assert.strictEqual(published.length, 1)
      assert.deepStrictEqual(published[0], snapshot)
      assert(snapshot.status === "done" || snapshot.status === "stopped")
      if (snapshot.status === "done") {
        assert.deepStrictEqual(joined, Exit.succeed("done"))
      } else {
        assert(Exit.isFailure(joined))
        if (Exit.isFailure(joined)) {
          assert.instanceOf(joined.cause.reasons.find(Cause.isFailReason)?.error, Machine.StoppedError)
        }
      }
    }))

  it.effect("publishes and cleans up exactly once when stop races process failure", () =>
    Effect.gen(function*() {
      const cleanupCount = yield* Ref.make(0)
      const release = yield* Deferred.make<void>()
      const race = yield* Deferred.make<void>()
      const ref = yield* MachineRuntime.startProcess(
        Machine.logic({
          initial: 1,
          run: () =>
            Deferred.await(release).pipe(
              Effect.andThen(Effect.fail("failed")),
              Effect.ensuring(Ref.update(cleanupCount, (count) => count + 1))
            )
        })
      )
      const terminalSnapshots = yield* ref.changes.pipe(
        Stream.filter((snapshot) => snapshot.status !== "active"),
        Stream.runCollect,
        Effect.forkChild
      )
      const stopFiber = yield* Deferred.await(race).pipe(
        Effect.andThen(ref.stop),
        Effect.forkChild
      )
      const failureFiber = yield* Deferred.await(race).pipe(
        Effect.andThen(Deferred.succeed(release, void 0)),
        Effect.forkChild
      )

      yield* Deferred.succeed(race, void 0)
      yield* Fiber.join(stopFiber)
      yield* Fiber.join(failureFiber)
      const published = Array.from(yield* Fiber.join(terminalSnapshots))
      const snapshot = yield* ref.snapshot
      const joined = yield* Effect.exit(ref.join)

      assert.strictEqual(yield* Ref.get(cleanupCount), 1)
      assert.strictEqual(published.length, 1)
      assert.deepStrictEqual(published[0], snapshot)
      assert(snapshot.status === "error" || snapshot.status === "stopped")
      assert(Exit.isFailure(joined))
      if (Exit.isFailure(joined)) {
        const failure = joined.cause.reasons.find(Cause.isFailReason)
        if (snapshot.status === "error") {
          assert.strictEqual(failure?.error, "failed")
        } else {
          assert.instanceOf(failure?.error, Machine.StoppedError)
        }
      }
    }))

  it.effect("does not abandon terminalization across repeated stop-versus-worker races", () =>
    Effect.gen(function*() {
      yield* Effect.forEach(
        Array.from({ length: 100 }, (_, index) => index),
        (index) =>
          Effect.gen(function*() {
            const cleanupCount = yield* Ref.make(0)
            const release = yield* Deferred.make<void>()
            const race = yield* Deferred.make<void>()
            const ref = yield* MachineRuntime.startProcess(
              Machine.logic({
                initial: index,
                run: () =>
                  Deferred.await(release).pipe(
                    Effect.andThen(
                      index % 2 === 0
                        ? Effect.succeed(index)
                        : Effect.fail(`failure-${index}`)
                    ),
                    Effect.ensuring(Ref.update(cleanupCount, (count) => count + 1))
                  )
              })
            )
            const stopFiber = yield* Deferred.await(race).pipe(
              Effect.andThen(ref.stop),
              Effect.forkChild
            )
            const workerFiber = yield* Deferred.await(race).pipe(
              Effect.andThen(Deferred.succeed(release, void 0)),
              Effect.forkChild
            )

            yield* Deferred.succeed(race, void 0)
            yield* Fiber.join(stopFiber)
            yield* Fiber.join(workerFiber)

            const snapshot = yield* ref.snapshot
            const joined = yield* Effect.exit(ref.join)
            assert.strictEqual(yield* Ref.get(cleanupCount), 1)
            assert.notStrictEqual(snapshot.status, "active")
            switch (snapshot.status) {
              case "done":
                assert.strictEqual(index % 2, 0)
                assert.deepStrictEqual(joined, Exit.succeed(index))
                break
              case "error":
                assert.strictEqual(index % 2, 1)
                assert(Exit.isFailure(joined))
                break
              case "stopped":
                assert(Exit.isFailure(joined))
                if (Exit.isFailure(joined)) {
                  assert.instanceOf(joined.cause.reasons.find(Cause.isFailReason)?.error, Machine.StoppedError)
                }
                break
            }
          }),
        { concurrency: "unbounded" }
      )
    }))
})
