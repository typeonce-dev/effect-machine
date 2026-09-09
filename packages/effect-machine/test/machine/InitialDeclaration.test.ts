import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"

describe("handler initial declarations", () => {
  it.effect("selects an initial child and retains inspectable event targets", () =>
    Effect.gen(function*() {
      const root = Machine.state({ states: { Locked: {}, Unlocked: {} } })
      const targets = Machine.targets(root)
      const machine = Machine.make({ root, events: Machine.events({ Coin: {} }) }).handle({
        initial: { target: targets.root.Locked },
        states: {
          Locked: { on: { Coin: { target: targets.root.Unlocked } } },
          Unlocked: {}
        }
      })
      const initial = yield* Machine.planInitial(machine)
      assert.isTrue(root.matches(initial.state, "Locked"))
      const next = yield* Machine.plan(machine, initial.state, { _tag: "Coin" })
      assert.isTrue(root.matches(next.next, "Unlocked"))
    }))

  it.effect("constructs root data before constructing its initial child", () =>
    Effect.gen(function*() {
      const root = Machine.state({
        fields: { query: Schema.String },
        states: { Loading: { fields: { query: Schema.String } } }
      })
      const targets = Machine.targets(root)
      const machine = Machine.make({
        root,
        input: Schema.Struct({ query: Schema.String }),
        events: Machine.events({})
      }).handle({
        root: ({ input }) => ({ query: input.query }),
        initial: { target: targets.root.Loading, data: ({ state }) => ({ query: state.query }) },
        states: { Loading: {} }
      })
      const initial = yield* Machine.planInitial(machine, { query: "hello" })
      assert.strictEqual(
        root.get(initial.state, "Loading").pipe((value) => value._tag === "Some" ? value.value.query : undefined),
        "hello"
      )
    }))
  it.effect("keeps callback results with decoded/data fields as ordinary data", () =>
    Effect.gen(function*() {
      const root = Machine.state({ fields: { decoded: Schema.Boolean, data: Schema.String } })
      const definition = Machine.make({ root, events: Machine.events({}) })
      const ordinary = definition.handle({ root: () => ({ decoded: true, data: "ordinary" }) })
      const explicit = definition.handle({
        root: { decoded: true, data: { _tag: "", decoded: true, data: "decoded" } }
      })
      assert.deepStrictEqual((yield* Machine.planInitial(ordinary)).state.value, {
        _tag: "",
        decoded: true,
        data: "ordinary"
      })
      assert.deepStrictEqual((yield* Machine.planInitial(explicit)).state.value, {
        _tag: "",
        decoded: true,
        data: "decoded"
      })
    }))

  it.effect("reuses a structural root without sharing initial selections", () =>
    Effect.gen(function*() {
      const root = Machine.state({ states: { Left: {}, Right: {} } })
      const targets = Machine.targets(root)
      const definition = Machine.make({ root, events: Machine.events({}) })
      const left = definition.handle({ initial: { target: targets.root.Left } })
      const right = definition.handle({ initial: { target: targets.root.Right } })
      assert.isTrue(root.matches((yield* Machine.planInitial(left)).state, "Left"))
      assert.isTrue(root.matches((yield* Machine.planInitial(right)).state, "Right"))
      assert.isFalse("initial" in root.node)
      assert.isFalse(Machine.isMachine(definition))
    }))

  it.effect("constructs parallel region data before each region's initial child", () =>
    Effect.gen(function*() {
      const root = Machine.state({
        fields: { seed: Schema.Number },
        type: "parallel",
        states: {
          Left: { fields: { count: Schema.Number }, states: { Ready: { fields: { label: Schema.String } } } },
          Right: { fields: { count: Schema.Number } }
        }
      })
      const targets = Machine.targets(root)
      const order: string[] = []
      const machine = Machine.make({ root, input: Schema.Number, events: Machine.events({}) }).handle({
        root: ({ input }) => {
          order.push("root")
          return { seed: input }
        },
        initial: {
          Left: ({ root }) => {
            order.push("Left")
            return { count: root.seed }
          },
          Right: ({ root }) => {
            order.push("Right")
            return { count: root.seed + 1 }
          }
        },
        entry: () => {
          order.push("entry")
        },
        states: {
          Left: {
            initial: {
              target: targets.root.Left.Ready,
              data: ({ state }) => {
                order.push("Ready")
                return { label: String(state.count) }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine, 4)
      assert.deepStrictEqual(initial.state.states.Left.value, { _tag: "Left", count: 4 })
      assert.deepStrictEqual(initial.state.states.Left.state.value, { _tag: "Ready", label: "4" })
      assert.deepStrictEqual(initial.state.states.Right.value, { _tag: "Right", count: 5 })
      assert.strictEqual(order[0], "root")
      assert.isTrue(order.indexOf("Left") < order.indexOf("Ready"))
      assert.isTrue(order.includes("entry"))
    }))

  it("rejects initial targets from another root", () => {
    const root = Machine.state({ states: { Idle: {} } })
    const other = Machine.state({ states: { Idle: {} } })
    const definition = Machine.make({ root, events: Machine.events({}) })
    assert.throws(() => definition.handle({ initial: { target: Machine.targets(other).root.Idle } }), /direct child/)
  })
})
