import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"

const Root = Machine.state({
  fields: { count: Schema.Number },
  states: {
    Editing: { fields: { complete: Schema.Boolean } },
    Checkout: {
      fields: { total: Schema.Number },
      states: {
        Charging: { fields: { amount: Schema.Number } },
        Route: { type: "choice" },
        Paid: {}
      }
    },
    Archived: {}
  }
})
const Events = Machine.events({
  Bump: { by: Schema.Number },
  Submit: {},
  Cancel: {},
  Pay: { amount: Schema.Number },
  Keep: {},
  Reset: {}
})
const Emits = Machine.emittedEvents({ Cancelled: {} })

const machine = Machine.make({ root: Root, events: Events, emittedEvents: Emits }).handle({
  root: { count: 0 },
  initial: { target: "Editing", data: () => ({ complete: false }) },
  on: {
    Bump: { update: { root: ({ root, event }) => ({ count: root.count + event.by }) } },
    Reset: { update: { root: { decoded: true, data: ({ root }) => ({ ...root, count: 0 }) } } }
  },
  states: {
    Editing: {
      on: {
        Submit: { target: "Archived", guard: ({ state }) => state.complete },
        Cancel: { target: "Archived", commands: (_, enqueue) => enqueue.emit(Emits.Cancelled()) },
        Keep: { stay: true, commands: (_, enqueue) => enqueue.emit(Emits.Cancelled()) },
        Pay: {
          branches: [
            { target: "Checkout" },
            { target: "Archived" },
            { update: "Editing" },
            { stay: true },
            { decline: true }
          ],
          resolve: ({ event, select }) => {
            if (event.amount < 0) return select.decline()
            if (event.amount === 1) return select.update({ Editing: { complete: true } })
            if (event.amount === 2) return select.stay()
            return event.amount === 0
              ? select.target("Archived")
              : select.target("Checkout", {
                data: { total: 0 },
                states: { Charging: { data: { amount: event.amount } } }
              })
          }
        }
      }
    },
    Checkout: {
      initial: { target: "Checkout.Charging", data: { amount: 1 } },
      states: {
        Charging: {
          on: {
            Submit: {
              branches: [{ target: "Checkout.Paid", update: "Checkout" }],
              resolve: ({ state, select }) =>
                select.target("Checkout.Paid", { update: { Checkout: { total: state.amount } } })
            },
            Pay: { target: "Checkout.Route", update: { Checkout: ({ event }) => ({ total: event.amount }) } },
            Keep: { reenter: true, commands: (_, enqueue) => enqueue.emit(Emits.Cancelled()) }
          }
        },
        Route: { choice: { target: "Checkout.Paid" } }
      }
    }
  }
})

describe("transition declarations", () => {
  it.effect("replaces the value named by an update record", () =>
    Effect.gen(function*() {
      const { state: initial } = yield* Machine.planInitial(machine)
      const bumped = yield* Machine.plan(machine, initial, Events.Bump({ by: 2 }))
      assert.strictEqual(bumped.next.value.count, 2)
      assert.strictEqual(bumped.next.state.path, "Editing")
      const reset = yield* Machine.plan(machine, bumped.next, Events.Reset())
      assert.strictEqual(reset.next.value.count, 0)
    }))

  it.effect("evaluates a guard before commands and construction", () =>
    Effect.gen(function*() {
      const { state: initial } = yield* Machine.planInitial(machine)
      assert.isFalse(yield* Machine.can(machine, initial, Events.Submit()))
      const declined = yield* Machine.plan(machine, initial, Events.Submit())
      assert.deepStrictEqual(declined.microsteps, [])
    }))

  it.effect("enqueues commands on a target, on stay, and on reenter", () =>
    Effect.gen(function*() {
      const { state: initial } = yield* Machine.planInitial(machine)
      const cancelled = yield* Machine.plan(machine, initial, Events.Cancel())
      assert.strictEqual(cancelled.next.state.path, "Archived")
      assert.lengthOf(cancelled.emittedEvents, 1)

      const kept = yield* Machine.plan(machine, initial, Events.Keep())
      assert.deepStrictEqual(kept.next, initial)
      assert.lengthOf(kept.emittedEvents, 1)
      assert.deepStrictEqual(kept.microsteps[0]?.exitPaths, [])

      const charging = yield* Machine.plan(machine, initial, Events.Pay({ amount: 5 }))
      const reentered = yield* Machine.plan(machine, charging.next, Events.Keep())
      assert.lengthOf(reentered.emittedEvents, 1)
      assert.deepStrictEqual(reentered.microsteps[0]?.exitPaths, ["Checkout.Charging"])
      assert.deepStrictEqual(reentered.microsteps[0]?.entryPaths, ["Checkout.Charging"])
    }))

  it.effect("selects each declared branch and retains its key", () =>
    Effect.gen(function*() {
      const { state: initial } = yield* Machine.planInitial(machine)
      const keys = (planned: {
        readonly microsteps: ReadonlyArray<
          { readonly transitions: ReadonlyArray<{ readonly branchKey?: string | undefined }> }
        >
      }) => planned.microsteps[0]?.transitions.map(({ branchKey }) => branchKey)

      assert.deepStrictEqual(keys(yield* Machine.plan(machine, initial, Events.Pay({ amount: 5 }))), [
        "target:Checkout"
      ])
      assert.deepStrictEqual(keys(yield* Machine.plan(machine, initial, Events.Pay({ amount: 0 }))), [
        "target:Archived"
      ])
      assert.deepStrictEqual(keys(yield* Machine.plan(machine, initial, Events.Pay({ amount: 1 }))), ["update:Editing"])
      assert.deepStrictEqual(keys(yield* Machine.plan(machine, initial, Events.Pay({ amount: 2 }))), ["stay"])
      assert.deepStrictEqual((yield* Machine.plan(machine, initial, Events.Pay({ amount: -1 }))).microsteps, [])
      assert.isFalse(yield* Machine.can(machine, initial, Events.Pay({ amount: -1 })))
      assert.isTrue(yield* Machine.can(machine, initial, Events.Pay({ amount: 2 })))

      const definition = Machine.transitionDefinitions(machine).find(({ source, trigger }) =>
        source === "Editing" && trigger.type === "event" && trigger.event === "Pay"
      )
      assert.strictEqual(definition?.acceptance, "declinable")
      assert.deepStrictEqual(
        definition?.branches.map((branch) => branch.type === "branch" ? branch.key : undefined),
        ["target:Checkout", "target:Archived", "update:Editing", "stay"]
      )
    }))

  it.effect("updates an owner together with a target and before a choice resolves", () =>
    Effect.gen(function*() {
      const { state: initial } = yield* Machine.planInitial(machine)
      const charging = yield* Machine.plan(machine, initial, Events.Pay({ amount: 5 }))
      const paid = yield* Machine.plan(machine, charging.next, Events.Submit())
      assert.strictEqual(paid.next.state.path, "Checkout")
      if (paid.next.state.path === "Checkout") {
        assert.strictEqual(paid.next.state.value.total, 5)
        assert.strictEqual(paid.next.state.state.path, "Checkout.Paid")
      }
      assert.deepStrictEqual(paid.microsteps[0]?.transitions[0]?.updates, ["Checkout"])

      const routed = yield* Machine.plan(machine, charging.next, Events.Pay({ amount: 7 }))
      if (routed.next.state.path === "Checkout") {
        assert.strictEqual(routed.next.state.value.total, 7)
        assert.strictEqual(routed.next.state.state.path, "Checkout.Paid")
      }
    }))

  it("rejects a select call that the branch list does not declare", () => {
    const undeclared = Machine.make({
      root: Machine.state({ states: { Idle: {}, Done: {} } }),
      events: Machine.events({ Go: {} })
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: {
          on: {
            Go: {
              branches: [{ target: "Done" }],
              resolve: (({ select }: any) => select.stay()) as never
            }
          }
        }
      }
    })
    return Effect.runPromise(Effect.gen(function*() {
      const { state } = yield* Machine.planInitial(undeclared)
      const exit = yield* Effect.exit(Machine.plan(undeclared, state, { _tag: "Go" }))
      assert.strictEqual(exit._tag, "Failure")
    }))
  })

  it("rejects stay and decline where a transition must be selected", () => {
    const handle = (choice: object) => () =>
      Machine.make({
        root: Machine.state({ states: { Idle: {}, Route: { type: "choice" } } }),
        events: Machine.events({})
      }).handle({
        initial: { target: "Idle" },
        states: { Route: { choice: choice as never } }
      })
    assert.throws(handle({ guard: () => true, target: "Idle" }), /guard and decline apply only to on and always/)
    assert.throws(
      handle({ branches: [{ target: "Idle" }, { decline: true }], resolve: ({ select }: any) => select.decline() }),
      /guard and decline apply only to on and always/
    )
  })

  it("rejects a string owner and two owners on a plain transition", () => {
    const handle = (Go: object) => () =>
      Machine.make({
        root: Machine.state({ fields: { count: Schema.Number }, states: { Idle: { fields: { n: Schema.Number } } } }),
        events: Machine.events({ Go: {} })
      }).handle({
        root: { count: 0 },
        initial: { target: "Idle", data: { n: 0 } },
        states: { Idle: { on: { Go: Go as never } } }
      })
    assert.throws(handle({ update: "root", data: { count: 1 } }), /update must be a record with one owner/)
    assert.throws(handle({ update: { root: { count: 1 }, Idle: { n: 1 } } }), /update takes one owner, got: root, Idle/)
    assert.throws(handle({ stay: true, reenter: true }), /stay cannot reenter/)
  })

  it.effect("lets a region's stay preempt its parallel ancestor's handler", () =>
    Effect.gen(function*() {
      const parallel = Machine.make({
        root: Machine.state({
          states: {
            Regions: {
              type: "parallel",
              states: { Left: { states: { A: {} } }, Right: { states: { B: {} } } }
            },
            Closed: {}
          }
        }),
        events: Machine.events({ Close: { handled: Schema.Boolean } })
      }).handle({
        initial: { target: "Regions" },
        states: {
          Regions: {
            on: { Close: { target: "Closed" } },
            states: {
              Left: {
                initial: { target: "Regions.Left.A" },
                states: {
                  A: {
                    on: {
                      Close: {
                        branches: [{ stay: true }, { decline: true }],
                        resolve: ({ event, select }) => event.handled ? select.stay() : select.decline()
                      }
                    }
                  }
                }
              },
              Right: { initial: { target: "Regions.Right.B" }, states: { B: {} } }
            }
          }
        }
      })
      const { state: initial } = yield* Machine.planInitial(parallel)
      const stayed = yield* Machine.plan(parallel, initial, { _tag: "Close", handled: true })
      assert.strictEqual(stayed.next.state.path, "Regions")
      assert.isTrue(yield* Machine.can(parallel, initial, { _tag: "Close", handled: true }))
      const declined = yield* Machine.plan(parallel, initial, { _tag: "Close", handled: false })
      assert.strictEqual(declined.next.state.path, "Closed")
    }))
})
