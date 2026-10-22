import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Stream } from "effect"
import { Machine } from "../../../src/index.js"
import * as Process from "../../../src/internal/machine/process.js"
import type * as Runtime from "../../../src/internal/machine/runtime.js"

const makeWatcher = (released: Ref.Ref<boolean>) =>
  Machine.make({
    root: Machine.state({ states: { Watching: {} } }),
    events: Machine.events({}),
    streams: { watch: Stream.never.pipe(Stream.ensuring(Ref.set(released, true))) }
  }).handle({
    initial: { target: "Watching" },
    states: { Watching: { invoke: { src: "watch", onDone: { none: true } } } }
  })

const strategies: ReadonlyArray<Runtime.ProcessRuntimeStrategy> = ["generic", "compiled"]

describe("Machine scoped lifetime strategies", () => {
  for (const strategy of strategies) {
    it.effect(`${strategy} runtime releases state-owned work on scope closure`, () =>
      Effect.gen(function*() {
        const released = yield* Ref.make(false)
        const machine = makeWatcher(released)
        const ref = yield* Effect.scoped(Process.startWithRuntimeStrategyForTesting(machine, strategy))
        assert.strictEqual(yield* Ref.get(released), true)
        assert.strictEqual((yield* ref.snapshot).status, "stopped")

        const prepared = yield* Process.prepareWithRuntimeStrategyForTesting(makeWatcher(released), strategy)
        yield* Ref.set(released, false)
        yield* Effect.scoped(prepared.start)
        assert.strictEqual(yield* Ref.get(released), true)
      }))
  }
})
