import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Option, Stream } from "effect"
import { Machine } from "../../src/index.js"
import { Events, observedMachine, recordingTracer } from "../fixtures/observability.js"

describe("Invocation tracing", () => {
  it.effect("records Effects, Streams and timers without an inspection subscriber", () =>
    Effect.gen(function*() {
      const { spans, tracer } = yield* recordingTracer
      const entered = yield* Deferred.make<void>()
      const work = Effect.withSpan(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        "Application.work"
      )
      const ref = yield* Machine.start(observedMachine(work)).pipe(Effect.withTracer(tracer))
      yield* ref.send(Events.Start())
      yield* Deferred.await(entered)
      yield* ref.send(Events.Finish())
      yield* ref.join
      const invocations = spans.filter((span) => span.name === "Machine.invoke")
      assert.deepStrictEqual(invocations.map((span) => span.attributes.get("machine.invoke.kind")), [
        "Effect",
        "Stream",
        "Timer"
      ])
      for (const span of invocations) {
        assert.strictEqual(span.attributes.get("machine.id"), "Observed")
        assert.strictEqual(span.attributes.get("machine.sessionId"), ref.sessionId)
        assert.strictEqual(span.attributes.get("machine.state.path"), "Active")
        assert.strictEqual(span.status._tag, "Ended")
        if (span.status._tag === "Ended") {
          assert.ok(Exit.isFailure(span.status.exit) && Cause.hasInterruptsOnly(span.status.exit.cause))
        }
      }
      assert.strictEqual(invocations[0]?.attributes.get("machine.invoke.source"), "work")
      assert.strictEqual(invocations[0]?.attributes.get("machine.invoke.id"), "custom-work")
      const child = spans.find((span) => span.name === "Application.work")!
      assert.ok(Option.isSome(child.parent))
      if (Option.isSome(child.parent)) assert.strictEqual(child.parent.value.spanId, invocations[0]?.spanId)
    }))

  it.effect("ends spans after program finalizers and preserves typed failure values", () =>
    Effect.gen(function*() {
      const { spans, tracer } = yield* recordingTracer
      let finalized = false
      const work = Effect.fail("failed" as const).pipe(Effect.ensuring(Effect.gen(function*() {
        const span = yield* Effect.orDie(Effect.currentSpan)
        assert.strictEqual(span.status._tag, "Started")
        finalized = true
      })))
      const ref = yield* Machine.start(observedMachine(work)).pipe(Effect.withTracer(tracer))
      yield* ref.send(Events.Start())
      yield* ref.join
      assert.strictEqual(finalized, true)
      const span = spans.find((span) => span.attributes.get("machine.invoke.source") === "work")!
      assert.strictEqual(span.status._tag, "Ended")
      if (span.status._tag === "Ended") {
        assert.ok(
          Exit.isFailure(span.status.exit) &&
            span.status.exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error === "failed")
        )
      }
    }))

  it.effect("honors disabled tracing and preserves sequential Stream consumption", () =>
    Effect.gen(function*() {
      const { spans, tracer } = yield* recordingTracer
      const consumed = yield* Deferred.make<void>()
      const seen: Array<number> = []
      const stream = Stream.make(1, 2, 3).pipe(
        Stream.tap((n) =>
          Effect.sync(() => {
            seen.push(n)
          })
        ),
        Stream.ensuring(Deferred.succeed(consumed, undefined))
      )
      const ref = yield* Machine.start(observedMachine(Effect.never, stream)).pipe(
        Effect.withTracer(tracer),
        Effect.withTracerEnabled(false)
      )
      yield* ref.send(Events.Start())
      yield* Deferred.await(consumed)
      yield* ref.send(Events.Finish())
      yield* ref.join
      assert.deepStrictEqual(seen, [1, 2, 3])
      assert.deepStrictEqual(spans, [])
    }))
})
