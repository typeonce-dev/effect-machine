import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { Machine } from "../../src/index.js"
import { startWithRuntimeStrategyForTesting } from "../../src/internal/machine/process.js"
import { Events, observedMachine, recordingTracer } from "../fixtures/observability.js"
import { verifyPlannerStrategies } from "./machine/support/strategyDifferential.js"

describe("Observation across runtime strategies", () => {
  it.effect("preserves schema-less self targets in the indexed planner", () =>
    verifyPlannerStrategies({
      machine: observedMachine(Effect.never),
      events: [Events.Start(), Events.Reenter(), Events.Reenter(), Events.Finish()],
      expected: "indexed-flat",
      label: "structural state reentry"
    }))
  for (const strategy of ["generic", "compiled"] as const) {
    it.effect(`${strategy}: preserves waiting and invocation ownership across reentry`, () =>
      Effect.gen(function*() {
        const { spans, tracer } = yield* recordingTracer
        const first = yield* Deferred.make<void>()
        const second = yield* Deferred.make<void>()
        let runs = 0
        const work = Effect.gen(function*() {
          yield* Deferred.succeed(runs++ === 0 ? first : second, undefined)
          return yield* Effect.never
        })
        const ref = yield* startWithRuntimeStrategyForTesting(observedMachine(work), strategy).pipe(
          Effect.withTracer(tracer)
        )
        const initial = yield* Machine.waitFor(ref, () => true)
        assert.strictEqual(initial.status, "active")
        const waiting = yield* Machine.waitFor(ref, (snapshot) => snapshot.status === "done").pipe(
          Effect.forkScoped({ startImmediately: true })
        )
        yield* ref.send(Events.Start())
        yield* Deferred.await(first)
        yield* ref.send(Events.Reenter())
        yield* Effect.raceFirst(
          Deferred.await(second),
          Effect.flatMap(ref.join, () => Effect.die("unexpected completion"))
        )
        yield* ref.send(Events.Finish())
        const terminal = yield* Fiber.join(waiting)
        assert.strictEqual(terminal.status, "done")
        assert.strictEqual((yield* Machine.waitFor(ref, (snapshot) => snapshot.status === "done")).status, "done")
        const absent = yield* Effect.flip(Machine.waitFor(ref, () => false))
        assert.ok(Cause.isNoSuchElementError(absent))
        yield* ref.join
        const workSpans = spans.filter((span) => span.attributes.get("machine.invoke.source") === "work")
        assert.strictEqual(workSpans.length, 2)
        assert.notStrictEqual(
          workSpans[0]?.attributes.get("machine.invoke.sessionId"),
          workSpans[1]?.attributes.get("machine.invoke.sessionId")
        )
        const invocationSpans = spans.filter((span) => span.name === "Machine.invoke")
        assert.strictEqual(invocationSpans.length, 6)
        for (const span of invocationSpans) {
          assert.strictEqual(span.status._tag, "Ended")
          if (span.status._tag === "Ended") {
            assert.ok(Exit.isFailure(span.status.exit) && Cause.hasInterruptsOnly(span.status.exit.cause))
          }
        }
      }))

    it.effect(`${strategy}: stopping settles existing and later waiters`, () =>
      Effect.gen(function*() {
        const ref = yield* startWithRuntimeStrategyForTesting(observedMachine(Effect.never), strategy)
        const waiting = yield* Machine.waitFor(ref, () => false).pipe(
          Effect.exit,
          Effect.forkScoped({ startImmediately: true })
        )
        yield* ref.stop
        const result = yield* Fiber.join(waiting)
        assert.ok(Exit.isFailure(result))
        if (Exit.isFailure(result)) {
          assert.ok(
            result.cause.reasons.some((reason) =>
              Cause.isFailReason(reason) && reason.error instanceof Machine.StoppedError
            )
          )
        }
        const later = yield* Effect.flip(Machine.waitFor(ref, () => false))
        assert.ok(later instanceof Machine.StoppedError)
      }))
  }
})
