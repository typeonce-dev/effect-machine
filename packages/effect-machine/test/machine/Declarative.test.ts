import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"

const Root = Machine.state({
  initial: "Idle",
  states: {
    Idle: {},
    Ready: Schema.TaggedStruct("Ready", { count: Schema.Number }),
    Checkout: {
      schema: Schema.TaggedStruct("Checkout", { orderId: Schema.String }),
      initial: "Review",
      states: { Review: Schema.TaggedStruct("Review", { total: Schema.Number }) }
    }
  }
})
const targets = Machine.targets(Root)
const events = Machine.events({ Complete: { count: Schema.Number } })

describe("declarative transitions", () => {
  it.effect("accepts a service class as a direct lazy Effect", () =>
    Effect.gen(function*() {
      class Value extends Context.Service<Value, { readonly count: number }>()("test/direct/Value") {}
      const root = Machine.state({
        initial: "Loading",
        states: {
          Loading: {},
          Done: { type: "final", fields: { count: Schema.Number }, output: Schema.Number }
        }
      })
      const refs = Machine.targets(root)
      const machine = Machine.make({ root, events: Machine.events({}), effects: { value: Value } }).handle({
        states: {
          Loading: { invoke: { src: "value", onDone: { target: refs.root.Done, from: ({ output }) => output } } },
          Done: { output: ({ state }) => state.count }
        }
      })
      const count = yield* Effect.gen(function*() {
        const ref = yield* Machine.start(machine)
        return yield* ref.join
      }).pipe(Effect.provideService(Value, { count: 7 }))
      assert.strictEqual(count, 7)
    }))

  it.effect("captures registered values before caller-owned registries change", () =>
    Effect.gen(function*() {
      const root = Machine.state({
        initial: "Loading",
        states: {
          Loading: {},
          Done: { type: "final", fields: { value: Schema.Number }, output: Schema.Number }
        }
      })
      const refs = Machine.targets(root)
      const effects = { load: Effect.succeed(1) }
      const branches = { finish: { done: { target: refs.root.Done } } }
      const definition = Machine.make({ root, events: Machine.events({}), effects, branches })
      effects.load = Effect.succeed(99)
      const machine = definition.handle({
        states: {
          Loading: {
            invoke: {
              src: "load",
              onDone: { branches: "finish", resolve: ({ output, select }) => select.done.from({ value: output }) }
            }
          },
          Done: { output: ({ state }) => state.value }
        }
      })
      const ref = yield* Machine.start(machine)
      assert.strictEqual(yield* ref.join, 1)
    }))

  it.effect("allows inline entry into a choice with inspectable destinations", () =>
    Effect.gen(function*() {
      const root = Machine.state({ initial: "Idle", states: { Idle: {}, Route: { type: "choice" }, Ready: {} } })
      const refs = Machine.targets(root)
      const machine = Machine.make({ root, events: Machine.events({ Go: {} }) }).handle({
        states: {
          Idle: { on: { Go: { target: refs.root.Route } } },
          Route: { choice: { target: refs.root.Ready } }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const next = yield* Machine.plan(machine, initial.state, { _tag: "Go" })
      assert.isTrue(root.matches(next.next, "Ready"))
      assert.strictEqual(Machine.transitionDefinitions(machine)[0]?.branches[0]?.target, "Route")
    }))

  it.effect("captures inline topology without evaluating construction", () =>
    Effect.gen(function*() {
      let calls = 0
      const machine = Machine.make({ root: Root, events }).handle({
        states: {
          Idle: {
            on: {
              Complete: {
                target: targets.root.Ready,
                from: ({ event }) => {
                  calls++
                  return { count: event.count }
                }
              }
            }
          },
          Ready: {},
          Checkout: { states: { Review: {} } }
        }
      })
      assert.strictEqual(calls, 0)
      assert.strictEqual(Machine.transitionDefinitions(machine)[0]?.branches[0]?.target, "Ready")
      const initial = yield* Machine.planInitial(machine)
      const plan = yield* Machine.plan(machine, initial.state, { _tag: "Complete", count: 3 })
      assert.strictEqual(calls, 1)
      assert.deepStrictEqual(plan.next, {
        path: "",
        value: undefined,
        state: { path: "Ready", value: { _tag: "Ready", count: 3 } }
      })
    }))

  it.effect("captures branch topology and constructs nested values lazily", () =>
    Effect.gen(function*() {
      let calls = 0
      const machine = Machine.make({
        root: Root,
        events,
        branches: {
          checkout: { review: { target: targets.root.Checkout } }
        }
      }).handle({
        states: {
          Idle: {
            on: {
              Complete: {
                branches: "checkout",
                resolve: ({ event, select }) => {
                  calls++
                  return select.review.from(
                    { orderId: "order-1" },
                    (child) => child.Review.from({ total: event.count })
                  )
                }
              }
            }
          },
          Ready: {},
          Checkout: { states: { Review: {} } }
        }
      })
      assert.strictEqual(calls, 0)
      assert.strictEqual(Machine.transitionDefinitions(machine)[0]?.branches[0]?.target, "Checkout")
      const initial = yield* Machine.planInitial(machine)
      const plan = yield* Machine.plan(machine, initial.state, { _tag: "Complete", count: 4 })
      assert.strictEqual(calls, 1)
      assert.deepStrictEqual(plan.next, {
        path: "",
        value: undefined,
        state: {
          path: "Checkout",
          value: { _tag: "Checkout", orderId: "order-1" },
          state: {
            path: "Checkout.Review",
            value: { _tag: "Review", total: 4 }
          }
        }
      })
    }))

  it.effect("runs registered input-taking Effects with provided services", () =>
    Effect.gen(function*() {
      class Database extends Context.Service<Database, { readonly count: number }>()("test/declarative/Database") {}
      const root = Machine.state({
        initial: "Idle",
        states: {
          Idle: {},
          Done: { type: "final", schema: Schema.TaggedStruct("Done", { count: Schema.Number }), output: Schema.Number }
        }
      })
      const refs = Machine.targets(root)
      const machine = Machine.make({
        root,
        events: Machine.events({}),
        effects: {
          load: (offset: number) => Effect.map(Database, (db) => db.count + offset)
        }
      }).handle({
        states: {
          Idle: {
            invoke: {
              src: "load",
              input: () => 2,
              onDone: {
                target: refs.root.Done,
                from: ({ output }) => ({ count: output })
              }
            }
          },
          Done: { output: ({ state }) => state.count }
        }
      })
      const value = yield* Effect.gen(function*() {
        const ref = yield* Machine.start(machine)
        return yield* ref.join
      }).pipe(Effect.provideService(Database, { count: 5 }))
      assert.strictEqual(value, 7)
    }))
})
