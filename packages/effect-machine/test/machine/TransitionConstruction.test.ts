import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"

class Root extends Schema.TaggedClass<Root>("Root")("Root", { count: Schema.Number }) {}
class Saved extends Schema.TaggedClass<Saved>("Saved")("Saved", { text: Schema.String }) {}

const events = Machine.events({
  Save: { text: Schema.String, count: Schema.Number },
  Reset: {},
  Change: { allowed: Schema.Boolean }
})
const root1 = Machine.state({ schema: Root, initial: "Idle", states: { Idle: {}, Saved: { schema: Saved } } })
const targets1 = Machine.targets(root1)
const definition = Machine.make({
  branches: { rootUpdate: { updated: { update: targets1.root } } },
  root: root1,
  events,
  initial: (root) => root.from(() => ({ count: 0 }))
})

describe("transition construction", () => {
  it.effect("constructs destination and root values atomically before entry", () =>
    Effect.gen(function*() {
      const observations: Array<readonly [number, string]> = []
      const machine = definition.handle({
        states: {
          Idle: {
            on: {
              Save: {
                target: targets1.root.Saved,
                update: targets1.root,
                from: ({ event }) => ({
                  target: { text: event.text },
                  update: { count: event.count }
                })
              }
            }
          },
          Saved: {
            entry: ({ state, containingState }) => {
              observations.push([containingState.count, state.text])
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const plan = yield* Machine.plan(machine, initial.state, events.Save({ text: "saved", count: 4 }))
      assert.deepStrictEqual(observations, [[4, "saved"]])
      assert.strictEqual(plan.next.value.count, 4)
      assert.strictEqual(plan.next.state.path, "Saved")
      assert.strictEqual(initial.state.value.count, 0)
      assert.strictEqual(initial.state.state.path, "Idle")
    }))

  it.effect("preserves decoded classes for both sides of an atomic transition", () =>
    Effect.gen(function*() {
      const targetValue = new Saved({ text: "decoded" })
      const rootValue = new Root({ count: 2 })
      const machine = definition.handle({
        states: {
          Idle: {
            on: {
              Save: {
                target: targets1.root.Saved,
                update: targets1.root,
                decoded: () => ({ target: targetValue, update: rootValue })
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const plan = yield* Machine.plan(machine, initial.state, events.Save({ text: "ignored", count: 0 }))
      assert.instanceOf(plan.next.value, Root)
      assert.instanceOf(plan.next.state.value, Saved)
      assert.strictEqual(plan.next.value, rootValue)
      assert.strictEqual(plan.next.state.value, targetValue)
    }))

  it.effect("constructs a structural destination with an explicit owner replacement", () =>
    Effect.gen(function*() {
      const machine = definition.handle({
        states: {
          Idle: { on: { Save: { target: targets1.root.Saved, from: ({ event }) => ({ text: event.text }) } } },
          Saved: {
            on: {
              Reset: {
                target: targets1.root.Idle,
                update: targets1.root,
                from: () => ({ target: undefined, update: { count: 5 } })
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const saved = yield* Machine.plan(machine, initial.state, events.Save({ text: "saved", count: 0 }))
      const reset = yield* Machine.plan(machine, saved.next, events.Reset())
      assert.strictEqual(reset.next.state.path, "Idle")
      assert.strictEqual(reset.next.value.count, 5)
      assert.strictEqual(saved.next.state.path, "Saved")
    }))

  it.effect("rejects invalid destination or owner values through typed failures before entry", () =>
    Effect.gen(function*() {
      for (const invalidOwner of [false, true]) {
        let entered = false
        const machine = definition.handle({
          states: {
            Idle: {
              on: {
                Save: {
                  target: targets1.root.Saved,
                  update: targets1.root,
                  from: () => ({
                    target: { text: invalidOwner ? "valid" : 42 as unknown as string },
                    update: { count: invalidOwner ? "invalid" as unknown as number : 1 }
                  })
                }
              }
            },
            Saved: {
              entry: () => {
                entered = true
              }
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)
        const failure = yield* Machine.plan(machine, initial.state, events.Save({ text: "", count: 0 })).pipe(
          Effect.flip
        )
        assert.instanceOf(failure, Machine.MachineSchemaDecodeError)
        assert.strictEqual(entered, false)
        assert.strictEqual(initial.state.value.count, 0)
      }
    }))

  it.effect("declines guarded updates and combined transitions before construction and commands", () =>
    Effect.gen(function*() {
      for (const combined of [false, true]) {
        let constructed = 0
        const machine = definition.handle({
          on: { Change: { update: targets1.root, from: ({ root: current }) => ({ count: current.count + 10 }) } },
          states: {
            Idle: {
              on: {
                Change: combined ?
                  {
                    target: targets1.root.Saved,
                    update: targets1.root,
                    guard: ({ root, event }) => root.count === 0 && event.allowed,
                    from: () => {
                      constructed++
                      return { target: { text: "saved" }, update: { count: 1 } }
                    }
                  } :
                  {
                    branches: "rootUpdate",
                    guard: ({ root, event }) => root.count === 0 && event.allowed,
                    resolve: ({ select }, enqueue) => {
                      constructed++
                      enqueue.raise(events.Reset())
                      return select.updated.from({ count: 1 })
                    }
                  }
              }
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)
        assert.isFalse(yield* Machine.can(machine, initial.state, events.Save({ text: "", count: 0 })))
        const declined = yield* Machine.plan(machine, initial.state, events.Change({ allowed: false }))
        assert.strictEqual(constructed, 0)
        assert.strictEqual(declined.next.value.count, 10)
        assert.strictEqual(declined.next.state.path, "Idle")
        assert.deepStrictEqual(declined.microsteps[0]?.raisedEvents, [])
        const accepted = yield* Machine.plan(machine, initial.state, events.Change({ allowed: true }))
        assert.strictEqual(constructed, 1)
        assert.strictEqual(accepted.next.value.count, 1)
        assert.strictEqual(accepted.next.state.path, combined ? "Saved" : "Idle")
      }
    }))

  it.effect("reenters only the source and preserves reentry through atomic construction and guards", () =>
    Effect.gen(function*() {
      const lifecycle: Array<string> = []
      const machine = definition.handle({
        entry: () => {
          lifecycle.push("root")
        },
        states: {
          Idle: { on: { Save: { target: targets1.root.Saved, from: ({ event }) => ({ text: event.text }) } } },
          Saved: {
            entry: () => {
              lifecycle.push("enter")
            },
            exit: () => {
              lifecycle.push("exit")
            },
            on: {
              Change: {
                target: targets1.root.Saved,
                update: targets1.root,
                reenter: true,
                guard: ({ event }) => event.allowed,
                from: ({ root: current, state }) => ({
                  target: { text: state.text },
                  update: { count: current.count + 1 }
                })
              },
              Reset: {
                none: true,
                reenter: true,
                resolve: (_, enqueue) => {
                  enqueue.raise(events.Change({ allowed: false }))
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const saved = yield* Machine.plan(machine, initial.state, events.Save({ text: "saved", count: 0 }))
      lifecycle.length = 0
      const declined = yield* Machine.plan(machine, saved.next, events.Change({ allowed: false }))
      assert.deepStrictEqual(lifecycle, [])
      assert.strictEqual(declined.next.value.count, 0)
      const changed = yield* Machine.plan(machine, saved.next, events.Change({ allowed: true }))
      assert.deepStrictEqual(lifecycle, ["exit", "enter"])
      assert.strictEqual(changed.next.value.count, 1)
      lifecycle.length = 0
      yield* Machine.plan(machine, changed.next, events.Reset())
      assert.deepStrictEqual(lifecycle, ["exit", "enter"])
    }))

  it.effect("guards default targetless reentry without requiring a resolver", () =>
    Effect.gen(function*() {
      let entered = 0
      const machine = definition.handle({
        states: {
          Idle: {
            entry: () => {
              entered++
            },
            on: { Change: { none: true, reenter: true, guard: ({ event }) => event.allowed } }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      assert.strictEqual(entered, 1)
      assert.isFalse(yield* Machine.can(machine, initial.state, events.Change({ allowed: false })))
      assert.isTrue(yield* Machine.can(machine, initial.state, events.Change({ allowed: true })))
      yield* Machine.plan(machine, initial.state, events.Change({ allowed: false }))
      assert.strictEqual(entered, 1)
      const accepted = yield* Machine.plan(machine, initial.state, events.Change({ allowed: true }))
      assert.strictEqual(entered, 2)
      assert.strictEqual(accepted.next.state.path, "Idle")
    }))

  it("rejects conflicting construction methods", () => {
    assert.throws(() =>
      definition.handle({
        states: {
          Idle: {
            on: {
              Reset: { none: true, resolve: () => undefined, from: () => undefined } as any
            }
          }
        }
      }), /construction methods are mutually exclusive/)
  })
})
