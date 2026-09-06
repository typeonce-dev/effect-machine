import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

const State = Schema.TaggedStruct("State", { data: Schema.Unknown })
const Ping = Schema.TaggedStruct("Ping", {})
const make = (data: unknown) =>
  Machine.make({
    root: Machine.state({ initial: "State", states: { State } }),
    events: Machine.eventsFromSchemas(Ping),
    initialConfiguration: (root) =>
      root.resolve(({ target }) => target.from((to) => to.State.decoded({ _tag: "State", data })))
  }).handle({ states: { State: { on: { Ping: (to) => to.none } } } })

describe("trace value verification", () => {
  const different: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["regular expressions", /a/, /b/],
    ["non-finite numbers", NaN, null],
    ["infinities", Infinity, -Infinity],
    ["signed zero", 0, -0],
    ["symbols", Symbol("same"), Symbol("same")],
    ["functions", function same() {}, function same() {}],
    ["binary values", new Uint8Array([1]), new Uint8Array([2])],
    ["map values", new Map([[1, "a"]]), new Map([[1, "b"]])],
    ["set iteration order", new Set([1, 2]), new Set([2, 1])],
    ["opaque state", new WeakMap(), new WeakMap()]
  ]
  for (const [name, before, after] of different) {
    it.effect(`rejects changed ${name}`, () =>
      Effect.gen(function*() {
        const machine = make(before)
        const trace = yield* MachineTest.run(machine, { events: [{ _tag: "Ping" }] })
        const corrupted = {
          ...trace,
          final: { ...trace.final, state: { ...trace.final.state, value: { ...trace.final.state.value, data: after } } }
        }
        const exit = yield* Effect.exit(MachineTest.verify(machine, corrupted))
        assert.isTrue(Exit.isFailure(exit))
      }))
  }

  it.effect("verifies and formats invalid dates without throwing eagerly", () =>
    Effect.gen(function*() {
      const machine = make(new Date(NaN))
      const trace = yield* MachineTest.run(machine, { events: [{ _tag: "Ping" }] })
      const equivalent = {
        ...trace,
        final: {
          ...trace.final,
          state: { ...trace.final.state, value: { ...trace.final.state.value, data: new Date(NaN) } }
        }
      }
      yield* MachineTest.verify(machine, equivalent)
      assert.include(MachineTest.formatTrace(equivalent), "Invalid Date")
    }))

  it.effect("defers verification until the returned Effect runs", () =>
    Effect.gen(function*() {
      const machine = make(1)
      const trace = yield* MachineTest.run(machine, { events: [] })
      let reads = 0
      const observed = {
        ...trace,
        get final() {
          reads++
          return trace.final
        }
      }
      const verify = MachineTest.verify(machine, observed)
      assert.strictEqual(reads, 0)
      yield* verify
      assert.isAbove(reads, 0)
    }))

  it.effect("compares cyclic data while allowing decoded copies of shared values", () =>
    Effect.gen(function*() {
      const cyclic: { value: number; self?: unknown } = { value: 1 }
      cyclic.self = cyclic
      const copy: { value: number; self?: unknown } = { value: 1 }
      copy.self = copy
      const machine = make({ first: cyclic, second: cyclic })
      const trace = yield* MachineTest.run(machine, { events: [] })
      const equivalent = {
        ...trace,
        final: {
          ...trace.final,
          state: { ...trace.final.state, value: { ...trace.final.state.value, data: { first: cyclic, second: copy } } }
        }
      }
      yield* MachineTest.verify(machine, equivalent)
      copy.value = 2
      assert.isTrue(Exit.isFailure(yield* Effect.exit(MachineTest.verify(machine, equivalent))))
    }))
})
