import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Stream } from "effect"
import { Machine } from "../src/index.js"
import * as MachineRuntime from "../src/internal/machineRuntime.js"

describe("machine process lifecycle", () => {
  it.effect("preserves FIFO order while draining a compact compiled mailbox", () =>
    Effect.gen(function*() {
      type Event =
        | { readonly _tag: "Value"; readonly value: number }
        | { readonly _tag: "Done" }
      const observed: Array<number> = []
      const ref = yield* MachineRuntime.startProcess<undefined, Event, never, never, ReadonlyArray<number>>({
        [MachineRuntime.childlessProcess]: true,
        [MachineRuntime.compiledProcess]: true,
        initial: () => Effect.succeed(undefined),
        run: () => Effect.never,
        drain: (context) =>
          Effect.gen(function*() {
            while (true) {
              const event = yield* context.poll!
              if (Option.isNone(event)) {
                return Option.none()
              }
              if (event.value._tag === "Done") {
                return Option.some(observed)
              }
              observed.push(event.value.value)
            }
          })
      })

      for (let value = 0; value < 1_000; value += 1) {
        yield* ref.send({ _tag: "Value", value })
      }
      yield* ref.send({ _tag: "Done" })

      assert.deepStrictEqual(yield* ref.join, Array.from({ length: 1_000 }, (_, value) => value))
      assert.instanceOf(yield* Effect.flip(ref.send({ _tag: "Done" })), Machine.StoppedError)
    }))

  it.effect("wakes an on-demand compiled process across consecutive idle periods", () =>
    Effect.gen(function*() {
      type Event = {
        readonly value: number
        readonly processed: Deferred.Deferred<void>
      }
      const ref = yield* MachineRuntime.startProcess<number, Event>({
        [MachineRuntime.childlessProcess]: true,
        [MachineRuntime.compiledProcess]: true,
        initial: () => Effect.succeed(0),
        run: () => Effect.never,
        drain: (context) =>
          Effect.gen(function*() {
            while (true) {
              const event = yield* context.poll!
              if (Option.isNone(event)) {
                return Option.none()
              }
              yield* context.setState(event.value.value)
              yield* Deferred.succeed(event.value.processed, undefined)
            }
          })
      })

      for (let value = 1; value <= 100; value += 1) {
        const processed = yield* Deferred.make<void>()
        yield* ref.send({ value, processed })
        yield* Deferred.await(processed)
        if (value % 2 === 0) {
          yield* Effect.yieldNow
        }
      }

      assert.strictEqual(yield* ref.state, 100)
      yield* ref.stop
      assert.deepStrictEqual(yield* ref.snapshot, { status: "stopped", state: 100 })
    }))

  it.effect("provides empty child operations for childless process logic", () =>
    Effect.gen(function*() {
      const processScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
      const ref = yield* MachineRuntime.startProcess({
        [MachineRuntime.childlessProcess]: true,
        initial: (scope) => Deferred.succeed(processScope, scope).pipe(Effect.as(0)),
        run: () => Effect.never
      })
      const scope = yield* Deferred.await(processScope)

      assert(Option.isNone(yield* ref.child("missing")))
      assert(Option.isNone(yield* ref.childChanges("missing").pipe(Stream.runHead, Effect.map(Option.flatten))))
      yield* scope.sendTo("missing", undefined)
      yield* scope.stopChild("missing")

      yield* ref.stop
      assert(Option.isNone(yield* ref.child("missing")))
    }))

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

  it.effect("preserves single-owner stop arbitration for compiled processes", () =>
    Effect.gen(function*() {
      const cleanupCount = yield* Ref.make(0)
      const ref = yield* MachineRuntime.startProcess({
        [MachineRuntime.compiledProcess]: true,
        initial: () => Effect.succeed(1),
        run: (context) =>
          Effect.never.pipe(
            Effect.ensuring(
              Ref.update(cleanupCount, (count) => count + 1).pipe(
                Effect.andThen(context.setState(2))
              )
            )
          )
      })

      yield* Effect.all([ref.stop, ref.stop, ref.stop], { concurrency: "unbounded" })

      assert.strictEqual(yield* Ref.get(cleanupCount), 1)
      assert.deepStrictEqual(yield* ref.snapshot, { status: "stopped", state: 1 })
      assert.instanceOf(yield* Effect.flip(ref.join), Machine.StoppedError)
    }))

  it.effect("arbitrates on-demand completion and stop exactly once", () =>
    Effect.gen(function*() {
      yield* Effect.forEach(
        Array.from({ length: 100 }, (_, index) => index),
        (index) =>
          Effect.gen(function*() {
            const started = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const race = yield* Deferred.make<void>()
            const cleanupCount = yield* Ref.make(0)
            const ref = yield* MachineRuntime.startProcess<number, void, never, never, number>({
              [MachineRuntime.childlessProcess]: true,
              [MachineRuntime.compiledProcess]: true,
              initial: () => Effect.succeed(index),
              run: () => Effect.never,
              drain: (context) =>
                Effect.gen(function*() {
                  const event = yield* context.poll!
                  if (Option.isNone(event)) {
                    return Option.none()
                  }
                  yield* Deferred.succeed(started, undefined)
                  return yield* Deferred.await(release).pipe(
                    Effect.as(Option.some(index)),
                    Effect.ensuring(Ref.update(cleanupCount, (count) => count + 1))
                  )
                })
            })

            yield* ref.send(undefined)
            yield* Deferred.await(started)
            const stopFiber = yield* Deferred.await(race).pipe(
              Effect.andThen(ref.stop),
              Effect.forkChild
            )
            const completionFiber = yield* Deferred.await(race).pipe(
              Effect.andThen(Deferred.succeed(release, undefined)),
              Effect.forkChild
            )

            yield* Deferred.succeed(race, undefined)
            yield* Fiber.join(stopFiber)
            yield* Fiber.join(completionFiber)

            const snapshot = yield* ref.snapshot
            const joined = yield* Effect.exit(ref.join)
            assert.strictEqual(yield* Ref.get(cleanupCount), 1)
            assert(snapshot.status === "done" || snapshot.status === "stopped")
            if (snapshot.status === "done") {
              assert.deepStrictEqual(joined, Exit.succeed(index))
            } else {
              assert(Exit.isFailure(joined))
              if (Exit.isFailure(joined)) {
                assert.instanceOf(joined.cause.reasons.find(Cause.isFailReason)?.error, Machine.StoppedError)
              }
            }
          }),
        { concurrency: "unbounded" }
      )
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

  it.effect("interrupts the worker before publishing an externally requested failure", () =>
    Effect.gen(function*() {
      const runtime = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
      const cleanupCount = yield* Ref.make(0)
      const logic: MachineRuntime.ProcessLogic<number, never, string> = {
        initial: (scope) => Deferred.succeed(runtime, scope).pipe(Effect.as(1)),
        run: () =>
          Effect.never.pipe(
            Effect.ensuring(Ref.update(cleanupCount, (count) => count + 1))
          )
      }
      const ref = yield* MachineRuntime.startProcess(
        logic
      )

      yield* (yield* Deferred.await(runtime)).failCause(Cause.fail("external"))
      const joined = yield* Effect.exit(ref.join)

      assert.strictEqual(yield* Ref.get(cleanupCount), 1)
      assert.deepStrictEqual(yield* ref.snapshot, {
        status: "error",
        state: 1,
        cause: Cause.fail("external")
      })
      assert(Exit.isFailure(joined))
      if (Exit.isFailure(joined)) {
        assert.strictEqual(joined.cause.reasons.find(Cause.isFailReason)?.error, "external")
      }
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

  it.effect("does not lose on-demand completion when first observation races publication", () =>
    Effect.gen(function*() {
      yield* Effect.forEach(
        Array.from({ length: 100 }),
        () =>
          Effect.gen(function*() {
            const race = yield* Deferred.make<void>()
            const ref = yield* MachineRuntime.startProcess<number, void, never, never, string>({
              [MachineRuntime.childlessProcess]: true,
              [MachineRuntime.compiledProcess]: true,
              initial: () => Effect.succeed(0),
              run: () => Effect.never,
              drain: (context) =>
                Effect.gen(function*() {
                  const event = yield* context.poll!
                  if (Option.isNone(event)) {
                    return Option.none()
                  }
                  yield* context.setState(1)
                  return Option.some("done")
                })
            })
            const changes = yield* Deferred.await(race).pipe(
              Effect.andThen(Stream.runCollect(ref.changes)),
              Effect.forkChild
            )
            const completion = yield* Deferred.await(race).pipe(
              Effect.andThen(ref.send(undefined)),
              Effect.andThen(ref.join),
              Effect.forkChild
            )

            yield* Deferred.succeed(race, undefined)
            const snapshots = Array.from(yield* Fiber.join(changes))
            assert.strictEqual(yield* Fiber.join(completion), "done")
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

  it.effect("reserves a named child atomically across concurrent spawns", () =>
    Effect.gen(function*() {
      yield* Effect.forEach(
        Array.from({ length: 50 }),
        () =>
          Effect.gen(function*() {
            const parentScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
            const parent = yield* MachineRuntime.startProcess({
              initial: (scope) => Deferred.succeed(parentScope, scope).pipe(Effect.as(undefined)),
              run: () => Effect.never
            })
            const scope = yield* Deferred.await(parentScope)
            const childLogic = Machine.logic({ initial: 0, run: () => Effect.never })

            const exits = yield* Effect.all([
              Effect.exit(scope.spawn(childLogic, { id: "worker" })),
              Effect.exit(scope.spawn(childLogic, { id: "worker" }))
            ], { concurrency: "unbounded" })

            assert.strictEqual(exits.filter(Exit.isSuccess).length, 1)
            assert.strictEqual(exits.filter(Exit.isFailure).length, 1)
            const failure = exits.find(Exit.isFailure)
            if (failure === undefined) {
              throw new Error("concurrent child reservation produced no failure")
            }
            assert.instanceOf(
              failure.cause.reasons.find(Cause.isFailReason)?.error,
              Machine.ChildAlreadyExistsError
            )
            const child = yield* parent.child("worker")
            assert(Option.isSome(child))
            yield* parent.stop
          }),
        { concurrency: 10 }
      )
    }))

  it.effect("publishes every named child replacement in order", () =>
    Effect.gen(function*() {
      const parentScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
      const parent = yield* MachineRuntime.startProcess({
        initial: (scope) => Deferred.succeed(parentScope, scope).pipe(Effect.as(undefined)),
        run: () => Effect.never
      })
      const scope = yield* Deferred.await(parentScope)
      const observeReplacements = parent.childChanges("worker").pipe(
        Stream.map(Option.map((child) => child.sessionId)),
        Stream.take(5),
        Stream.runCollect
      )
      const observers = [
        yield* observeReplacements.pipe(Effect.forkChild),
        yield* observeReplacements.pipe(Effect.forkChild)
      ]
      yield* Effect.yieldNow

      const first = yield* scope.spawn(Machine.logic({ initial: 1, run: () => Effect.never }), { id: "worker" })
      yield* first.stop
      const second = yield* scope.spawn(Machine.logic({ initial: 2, run: () => Effect.never }), { id: "worker" })
      yield* second.stop

      for (const observer of observers) {
        assert.deepStrictEqual(
          Array.from(yield* Fiber.join(observer)).map(Option.getOrElse(() => "none")),
          ["none", first.sessionId, "none", second.sessionId, "none"]
        )
      }
      yield* parent.stop
    }))

  it.effect("preserves registry-wide childChanges emission ticks", () =>
    Effect.gen(function*() {
      const parentScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
      const parent = yield* MachineRuntime.startProcess({
        initial: (scope) => Deferred.succeed(parentScope, scope).pipe(Effect.as(undefined)),
        run: () => Effect.never
      })
      const scope = yield* Deferred.await(parentScope)
      const observed = yield* parent.childChanges("worker").pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.yieldNow

      const unrelated = yield* scope.spawn(
        Machine.logic({ initial: 0, run: () => Effect.never }),
        { id: "unrelated" }
      )
      yield* unrelated.stop

      assert.deepStrictEqual(
        Array.from(yield* Fiber.join(observed)).map(Option.isNone),
        [true, true, true]
      )
      yield* parent.stop
    }))

  it.effect("buffers ordered childChanges while a subscriber is stalled", () =>
    Effect.gen(function*() {
      const parentScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
      const parent = yield* MachineRuntime.startProcess({
        initial: (scope) => Deferred.succeed(parentScope, scope).pipe(Effect.as(undefined)),
        run: () => Effect.never
      })
      const scope = yield* Deferred.await(parentScope)
      const initialObserved = yield* Deferred.make<void>()
      const releaseObserver = yield* Deferred.make<void>()
      const observationCount = yield* Ref.make(0)
      const replacements = 20
      const observed = yield* parent.childChanges("worker").pipe(
        Stream.mapEffect((child) =>
          Ref.getAndUpdate(observationCount, (count) => count + 1).pipe(
            Effect.flatMap((index) =>
              index === 0
                ? Deferred.succeed(initialObserved, void 0).pipe(Effect.as(child))
                : Deferred.await(releaseObserver).pipe(Effect.as(child))
            )
          )
        ),
        Stream.take(1 + replacements * 2),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Deferred.await(initialObserved)

      for (let index = 0; index < replacements; index += 1) {
        const child = yield* scope.spawn(
          Machine.logic({ initial: index, run: () => Effect.never }),
          { id: "worker" }
        )
        yield* child.stop
      }
      yield* Deferred.succeed(releaseObserver, void 0)

      const values = Array.from(yield* Fiber.join(observed))
      assert.strictEqual(values.length, 1 + replacements * 2)
      assert(Option.isNone(values[0]!))
      for (let index = 1; index < values.length; index += 1) {
        assert.strictEqual(Option.isSome(values[index]!), index % 2 === 1)
      }
      yield* parent.stop
    }))

  it.effect("stops named and anonymous children exactly once with their parent", () =>
    Effect.gen(function*() {
      const namedCleanup = yield* Ref.make(0)
      const anonymousCleanup = yield* Ref.make(0)
      const childrenReady = yield* Deferred.make<{
        readonly named: Machine.MachineRef<number, never>
        readonly anonymous: Machine.MachineRef<number, never>
      }>()
      const childLogic = (cleanup: Ref.Ref<number>) =>
        Machine.logic({
          initial: 0,
          run: () =>
            Effect.never.pipe(
              Effect.ensuring(Ref.update(cleanup, (count) => count + 1))
            )
        })
      const parent = yield* MachineRuntime.startProcess(
        Machine.logic({
          initial: undefined,
          run: ({ spawn }) =>
            Effect.gen(function*() {
              const named = yield* spawn(childLogic(namedCleanup), { id: "named" })
              const anonymous = yield* spawn(childLogic(anonymousCleanup))
              yield* Deferred.succeed(childrenReady, { named, anonymous })
              return yield* Effect.never
            })
        })
      )
      const children = yield* Deferred.await(childrenReady)

      yield* parent.stop

      assert.strictEqual(yield* Ref.get(namedCleanup), 1)
      assert.strictEqual(yield* Ref.get(anonymousCleanup), 1)
      assert.deepStrictEqual(yield* children.named.snapshot, { status: "stopped", state: 0 })
      assert.deepStrictEqual(yield* children.anonymous.snapshot, { status: "stopped", state: 0 })
    }))

  it.effect("keeps child interruption parallel with scoped resource finalization", () =>
    Effect.gen(function*() {
      const parentScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
      const childInterrupted = yield* Deferred.make<void>()
      const resourceFinalized = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const parent = yield* MachineRuntime.startProcess({
        initial: (scope) => Deferred.succeed(parentScope, scope).pipe(Effect.as(undefined)),
        run: () => Effect.never
      })
      const child = yield* (yield* Deferred.await(parentScope)).spawn(
        Machine.logic({
          initial: () =>
            Effect.acquireRelease(
              Effect.void,
              () =>
                Deferred.succeed(resourceFinalized, undefined).pipe(
                  Effect.andThen(Deferred.await(release))
                )
            ).pipe(Effect.as(0)),
          run: () =>
            Effect.never.pipe(
              Effect.ensuring(
                Deferred.succeed(childInterrupted, undefined).pipe(
                  Effect.andThen(Deferred.await(release))
                )
              )
            )
        }),
        { id: "child" }
      )
      const stopping = yield* parent.stop.pipe(Effect.forkChild)

      yield* Deferred.await(childInterrupted)
      yield* Deferred.await(resourceFinalized)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(stopping)

      assert.deepStrictEqual(yield* child.snapshot, { status: "stopped", state: 0 })
    }))

  it.effect("does not orphan a child when parent stop races child initialization", () =>
    Effect.gen(function*() {
      const parentScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
      const childInitializing = yield* Deferred.make<void>()
      const releaseChild = yield* Deferred.make<void>()
      const resourceCleanup = yield* Ref.make(0)
      const parentLogic: MachineRuntime.ProcessLogic<undefined, never> = {
        initial: (scope) => Deferred.succeed(parentScope, scope).pipe(Effect.as(undefined)),
        run: () => Effect.never
      }
      const parent = yield* MachineRuntime.startProcess(
        parentLogic
      )
      const scope = yield* Deferred.await(parentScope)
      const childFiber = yield* scope.spawn(
        Machine.logic({
          initial: () =>
            Effect.acquireRelease(
              Effect.void,
              () => Ref.update(resourceCleanup, (count) => count + 1)
            ).pipe(
              Effect.andThen(Deferred.succeed(childInitializing, void 0)),
              Effect.andThen(Deferred.await(releaseChild)),
              Effect.as(0)
            ),
          run: () => Effect.never
        }),
        { id: "racing" }
      ).pipe(Effect.forkChild)

      yield* Deferred.await(childInitializing)
      yield* parent.stop
      yield* Deferred.succeed(releaseChild, void 0)
      const child = yield* Fiber.join(childFiber)
      yield* Effect.exit(child.join)

      assert.strictEqual(yield* Ref.get(resourceCleanup), 1)
      assert.deepStrictEqual(yield* child.snapshot, { status: "stopped", state: 0 })
      assert(Option.isNone(yield* parent.child("racing")))
    }))

  it.effect("does not miss a named child when first observation races registration", () =>
    Effect.gen(function*() {
      yield* Effect.forEach(
        Array.from({ length: 50 }),
        () =>
          Effect.gen(function*() {
            const parentScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
            const race = yield* Deferred.make<void>()
            const parentLogic: MachineRuntime.ProcessLogic<undefined, never> = {
              initial: (scope) => Deferred.succeed(parentScope, scope).pipe(Effect.as(undefined)),
              run: () => Effect.never
            }
            const parent = yield* MachineRuntime.startProcess(
              parentLogic
            )
            const scope = yield* Deferred.await(parentScope)
            const observed = yield* Deferred.await(race).pipe(
              Effect.andThen(
                parent.childChanges("worker").pipe(
                  Stream.filter(Option.isSome),
                  Stream.runHead
                )
              ),
              Effect.forkChild
            )
            const spawned = yield* Deferred.await(race).pipe(
              Effect.andThen(
                scope.spawn(
                  Machine.logic({ initial: 0, run: () => Effect.never }),
                  { id: "worker" }
                )
              ),
              Effect.forkChild
            )

            yield* Deferred.succeed(race, void 0)
            const child = yield* Fiber.join(spawned)
            const observation = yield* Fiber.join(observed)

            assert(Option.isSome(observation))
            if (Option.isSome(observation)) {
              assert.strictEqual(observation.value.value.sessionId, child.sessionId)
            }
            yield* parent.stop
          }),
        { concurrency: 10 }
      )
    }))

  it.effect("delivers done, failure, and stopped child outcomes exactly once", () =>
    Effect.gen(function*() {
      const parentScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
      const outcomes = yield* Ref.make<ReadonlyArray<string>>([])
      const parentLogic: MachineRuntime.ProcessLogic<undefined, never> = {
        initial: (scope) => Deferred.succeed(parentScope, scope).pipe(Effect.as(undefined)),
        run: () => Effect.never
      }
      const parent = yield* MachineRuntime.startProcess(parentLogic)
      const scope = yield* Deferred.await(parentScope)
      const recordOutcome = (id: string) => (outcome: MachineRuntime.RuntimeOutcome<unknown, unknown, unknown>) =>
        Ref.update(outcomes, (current) => [...current, `${id}:${outcome._tag}`])

      const done = yield* scope.spawn(
        Machine.logic({ initial: 0, run: () => Effect.succeed("output") }),
        { id: "done", onOutcome: recordOutcome("done") }
      )
      assert.strictEqual(yield* done.join, "output")

      const failed = yield* scope.spawn(
        Machine.logic({ initial: 0, run: () => Effect.fail("failure") }),
        { id: "failed", onOutcome: recordOutcome("failed") }
      )
      assert.strictEqual(yield* Effect.flip(failed.join), "failure")

      const stopped = yield* scope.spawn(
        Machine.logic({ initial: 0, run: () => Effect.never }),
        { id: "stopped", onOutcome: recordOutcome("stopped") }
      )
      yield* stopped.stop

      assert.deepStrictEqual(yield* Ref.get(outcomes), [
        "done:Done",
        "failed:Failure",
        "stopped:Stopped"
      ])
      yield* parent.stop
    }))

  it.effect("isolates child terminalization from outcome callback defects", () =>
    Effect.gen(function*() {
      const parentScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
      const parentLogic: MachineRuntime.ProcessLogic<undefined, never> = {
        initial: (scope) => Deferred.succeed(parentScope, scope).pipe(Effect.as(undefined)),
        run: () => Effect.never
      }
      const parent = yield* MachineRuntime.startProcess(parentLogic)
      const child = yield* (yield* Deferred.await(parentScope)).spawn(
        Machine.logic({ initial: 0, run: () => Effect.succeed("output") }),
        { id: "child", onOutcome: () => Effect.die("callback defect") }
      )

      assert.strictEqual(yield* child.join, "output")
      assert.deepStrictEqual(yield* child.snapshot, {
        status: "done",
        state: 0,
        output: "output"
      })
      assert.deepStrictEqual(yield* parent.snapshot, { status: "active", state: undefined })
      yield* parent.stop
    }))

  it.effect("delivers committed active child snapshots directly and in order", () =>
    Effect.gen(function*() {
      const parentScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
      const snapshots = yield* Ref.make<ReadonlyArray<number>>([])
      const parent = yield* MachineRuntime.startProcess({
        initial: (scope) => Deferred.succeed(parentScope, scope).pipe(Effect.as(undefined)),
        run: () => Effect.never
      })
      const child = yield* (yield* Deferred.await(parentScope)).spawn(
        Machine.logic({
          initial: 0,
          run: ({ setState }) =>
            setState(1).pipe(
              Effect.andThen(setState(2)),
              Effect.as("output")
            )
        }),
        {
          id: "child",
          [MachineRuntime.activeSnapshotObserver]: (snapshot) =>
            Ref.update(snapshots, (current) => [...current, snapshot.state])
        }
      )

      assert.strictEqual(yield* child.join, "output")
      assert.deepStrictEqual(yield* Ref.get(snapshots), [0, 1, 2])
      yield* parent.stop
    }))

  it.effect("isolates active child state updates from snapshot callback defects", () =>
    Effect.gen(function*() {
      const parentScope = yield* Deferred.make<MachineRuntime.ProcessScope<never>>()
      const parent = yield* MachineRuntime.startProcess({
        initial: (scope) => Deferred.succeed(parentScope, scope).pipe(Effect.as(undefined)),
        run: () => Effect.never
      })
      const child = yield* (yield* Deferred.await(parentScope)).spawn(
        Machine.logic({
          initial: 0,
          run: ({ setState }) => setState(1).pipe(Effect.as("output"))
        }),
        { id: "child", [MachineRuntime.activeSnapshotObserver]: () => Effect.die("callback defect") }
      )

      assert.strictEqual(yield* child.join, "output")
      assert.deepStrictEqual(yield* child.snapshot, {
        status: "done",
        state: 1,
        output: "output"
      })
      assert.deepStrictEqual(yield* parent.snapshot, { status: "active", state: undefined })
      yield* parent.stop
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
