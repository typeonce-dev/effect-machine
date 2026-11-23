import { assert, describe, it } from "@effect/vitest"
import type { Duration } from "effect"
import { Cause, Effect } from "effect"
import { Machine } from "../../../src/index.js"
import { openWithRuntimeStrategy } from "./support/strategyDifferential.js"

const makeMachine = (steps: Array<string>, duration: (seconds: number) => Duration.Input) =>
  Machine.make({
    root: Machine.state({ states: { Idle: {}, Working: {}, Done: {} } }),
    events: Machine.events({ Go: {} }),
    effects: {
      first: Effect.suspend(() => {
        steps.push("first started")
        return Effect.never
      })
    },
    timers: { timer: duration }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Go: { target: "Working" } } },
      Working: {
        invoke: [
          { src: "first" },
          {
            src: "timer",
            input: () => {
              steps.push("timer mapped")
              return NaN
            },
            onDone: { target: "Done" }
          }
        ]
      },
      Done: {}
    }
  })

const status = (ref: Machine.MachineRef<any, any, any, any>) => Effect.runSync(ref.snapshot).status

describe("local timer invocations", () => {
  for (const strategy of ["generic", "compiled"] as const) {
    describe(`${strategy} runtime`, () => {
      it.effect("constructs a timer after the state is entered and earlier invocations have started", () =>
        Effect.gen(function*() {
          const steps: Array<string> = []
          const ref = yield* openWithRuntimeStrategy(
            makeMachine(steps, () => {
              throw new Error("timer source")
            }),
            strategy
          )
          Effect.runSync(ref.send({ _tag: "Go" }))
          assert.deepStrictEqual(steps, ["first started", "timer mapped"])
          const snapshot = Effect.runSync(ref.snapshot)
          if (snapshot.status !== "error") throw new Error(`Unexpected ${snapshot.status}`)
          assert.strictEqual(snapshot.state.state.path, "Working")
          assert.strictEqual((Cause.squash(snapshot.cause) as Error).message, "timer source")
        }).pipe(Effect.scoped))

      it.effect("reports an input that names no duration as the timer's outcome in a later turn", () =>
        Effect.gen(function*() {
          const steps: Array<string> = []
          const ref = yield* openWithRuntimeStrategy(makeMachine(steps, (seconds) => `${seconds} seconds`), strategy)
          Effect.runSync(ref.send({ _tag: "Go" }))
          assert.deepStrictEqual(steps, ["first started", "timer mapped"])
          assert.strictEqual(status(ref), "active")
          const cause = yield* Effect.flip(Effect.sandbox(ref.join))
          assert.isTrue(Cause.hasDies(cause))
          assert.strictEqual(status(ref), "error")
        }).pipe(Effect.scoped))
    })
  }
})
