import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"

it.effect("passes fresh input only through root initialization without retaining it in root data", () =>
  Effect.gen(function*() {
    const root = Machine.state({
      fields: { locale: Schema.String },
      states: { Loading: { fields: { request: Schema.String } }, Idle: {} }
    })
    const targets = Machine.targets(root)
    const machine = Machine.make({
      root,
      input: Schema.Struct({ locale: Schema.String, request: Schema.String }),
      events: Machine.events({ Finish: {}, Reload: { request: Schema.String } }),
      branches: { reload: { root: { target: targets.root } } }
    }).handle({
      root: ({ input }) => ({ locale: input.locale }),
      initial: { target: targets.root.Loading, data: ({ input }) => ({ request: input.request }) },
      on: {
        Reload: {
          branches: "reload",
          resolve: ({ event, select }) => select.root({ input: { locale: "it", request: event.request } })
        }
      },
      states: { Loading: { on: { Finish: { target: targets.root.Idle } } } }
    })
    const initial = yield* Machine.planInitial(machine, { locale: "en", request: "first" })
    assert.deepStrictEqual(initial.state.value, { _tag: "", locale: "en" })
    assert.deepStrictEqual(initial.state.state.value, { _tag: "Loading", request: "first" })
    const idle = yield* Machine.plan(machine, initial.state, { _tag: "Finish" })
    const reloaded = yield* Machine.plan(machine, idle.next, { _tag: "Reload", request: "second" })
    assert.deepStrictEqual(reloaded.next.value, { _tag: "", locale: "it" })
    assert.deepStrictEqual(reloaded.next.state.value, { _tag: "Loading", request: "second" })
  }))

it.effect("restarts root lifecycle only with reenter and validates fresh input before committing", () =>
  Effect.gen(function*() {
    const root = Machine.state({
      fields: { count: Schema.Number },
      states: { Loading: { fields: { id: Schema.String } }, Idle: {} }
    })
    const targets = Machine.targets(root)
    const machine = Machine.make({
      root,
      input: Schema.Struct({ id: Schema.NonEmptyString, count: Schema.Number }),
      events: Machine.events({ Finish: {}, Reset: { id: Schema.String }, Restart: { id: Schema.String } })
    }).handle({
      root: ({ input }) => ({ count: input.count }),
      initial: { target: targets.root.Loading, data: ({ input }) => ({ id: input.id }) },
      on: {
        Reset: { target: targets.root, input: ({ event }) => ({ id: event.id, count: 2 }) },
        Restart: { target: targets.root, input: ({ event }) => ({ id: event.id, count: 3 }), reenter: true }
      },
      states: { Loading: { on: { Finish: { target: targets.root.Idle } } } }
    })
    const initial = yield* Machine.planInitial(machine, { id: "one", count: 1 })
    const idle = yield* Machine.plan(machine, initial.state, { _tag: "Finish" })
    const reset = yield* Machine.plan(machine, idle.next, { _tag: "Reset", id: "two" })
    assert.isFalse(reset.microsteps[0]!.exitPaths.includes(""))
    assert.isFalse(reset.microsteps[0]!.entryPaths.includes(""))
    const restarted = yield* Machine.plan(machine, reset.next, { _tag: "Restart", id: "three" })
    assert.isTrue(restarted.microsteps[0]!.exitPaths.includes(""))
    assert.isTrue(restarted.microsteps[0]!.entryPaths.includes(""))
    const invalid = yield* Machine.plan(machine, restarted.next, { _tag: "Reset", id: "" }).pipe(Effect.result)
    assert.strictEqual(invalid._tag, "Failure")
    assert.deepStrictEqual(restarted.next.value, { _tag: "", count: 3 })
    assert.deepStrictEqual(restarted.next.state.value, { _tag: "Loading", id: "three" })
  }))
