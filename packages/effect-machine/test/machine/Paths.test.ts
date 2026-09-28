import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"

describe("declared state paths", () => {
  it("reserves the top-level root name for the root node", () => {
    const root = Machine.state({ states: { root: {}, Idle: {} } })
    assert.throws(() => Machine.make({ root, events: Machine.events({}) } as never), /reserved for the root/)
  })

  it.effect("allows nested states named root", () =>
    Effect.gen(function*() {
      const root = Machine.state({ states: { Slot: { states: { root: {}, Done: {} } } } })
      const machine = Machine.make({ root, events: Machine.events({ Finish: {} }) }).handle({
        initial: { target: "Slot" },
        states: {
          Slot: {
            initial: { target: "Slot.root" },
            states: { root: { on: { Finish: { target: "Slot.Done" } } } }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      assert.strictEqual(initial.state.state.state.path, "Slot.root")
      const finished = yield* Machine.plan(machine, initial.state, { _tag: "Finish" })
      assert.strictEqual(finished.next.state.state.path, "Slot.Done")
    }))

  it("rejects undeclared paths and the root as a destination while capturing handlers", () => {
    const root = Machine.state({ fields: { count: Schema.Number }, states: { Idle: {}, Busy: {} } })
    const definition = Machine.make({ root, events: Machine.events({ Go: {} }) })
    const handle = (on: unknown) =>
      definition.handle({ root: { count: 0 }, initial: { target: "Idle" }, on: { Go: on } } as never)
    assert.throws(() => handle({ target: "Missing" }), /not a declared state path/)
    assert.throws(() => handle({ target: "Idle.Missing" }), /not a declared state path/)
    assert.throws(() => handle({ update: "" }), /not a declared state path/)
    assert.throws(() => handle({ target: "root" }), /use initialize/)
    assert.throws(() => handle({ initialize: {} }), /requires true/)
    assert.throws(() => handle({ initialize: true, target: "Idle" }), /exactly one destination/)
    assert.throws(() => handle({ initialize: true, update: "root" }), /cannot update/)
    assert.throws(() => handle({ initialize: true, data: {} }), /instead of data/)
    assert.doesNotThrow(() => handle({ update: "root", data: { count: 1 } }))
  })

  it("rejects branch declarations that supply initialize input", () => {
    const root = Machine.state({ states: { Idle: {} } })
    assert.throws(
      () =>
        Machine.make({
          root,
          input: Schema.Number,
          events: Machine.events({}),
          branches: { reset: { root: { initialize: 1 } } }
        } as never),
      /initialize: true/
    )
  })

  it.effect("keeps reused subtrees independently addressable", () =>
    Effect.gen(function*() {
      const slot = Machine.state({ states: { Idle: {}, Done: {} } })
      const root = Machine.state({ type: "parallel", states: { Left: slot, Right: slot } })
      const machine = Machine.make({ root, events: Machine.events({ FinishLeft: {} }) }).handle({
        states: {
          Left: { initial: { target: "Left.Idle" }, on: { FinishLeft: { target: "Left.Done" } } },
          Right: { initial: { target: "Right.Idle" } }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const finished = yield* Machine.plan(machine, initial.state, { _tag: "FinishLeft" })
      assert.strictEqual(finished.next.states.Left.state.path, "Left.Done")
      assert.strictEqual(finished.next.states.Right.state.path, "Right.Idle")
    }))

  it.effect("reconstructs a machine without input through initialize: true", () =>
    Effect.gen(function*() {
      const root = Machine.state({ fields: { count: Schema.Number }, states: { Idle: {}, Busy: {} } })
      const machine = Machine.make({ root, events: Machine.events({ Work: {}, Reset: {} }) }).handle({
        root: { count: 0 },
        initial: { target: "Idle" },
        on: { Reset: { initialize: true } },
        states: {
          Idle: { on: { Work: { target: "Busy" } } },
          Busy: { on: { Work: { update: "root", data: ({ root }) => ({ count: root.count + 1 }) } } }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const busy = yield* Machine.plan(machine, initial.state, { _tag: "Work" })
      const counted = yield* Machine.plan(machine, busy.next, { _tag: "Work" })
      assert.deepStrictEqual(counted.next.value, { _tag: "", count: 1 })
      assert.strictEqual(counted.next.state.path, "Busy")
      const reset = yield* Machine.plan(machine, counted.next, { _tag: "Reset" })
      assert.deepStrictEqual(reset.next.value, { _tag: "", count: 0 })
      assert.strictEqual(reset.next.state.path, "Idle")
    }))
})
