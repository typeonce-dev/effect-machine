import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import { verifyPlannerStrategies } from "./support/strategyDifferential.js"

it.effect("retains independent callback contexts across root, inline, and named transitions", () =>
  Effect.gen(function*() {
    const root = Machine.state({ fields: { count: Schema.Number }, initial: "Idle", states: { Idle: {} } })
    const targets = Machine.targets(root)
    const retained: Array<{ readonly root: { readonly count: number }; readonly snapshot: unknown }> = []
    const machine = Machine.make({
      root,
      events: Machine.events({ Increment: {}, Observe: {}, IncrementRoot: {} }),
      initial: (root) => root.from(() => ({ count: 0 })),
      branches: { observe: { stay: { none: true } } }
    }).handle({
      on: {
        IncrementRoot: {
          update: targets.root,
          from: (context) => {
            retained.push(context)
            return { count: context.root.count + 1 }
          }
        }
      },
      states: {
        Idle: {
          on: {
            Increment: {
              update: targets.root,
              from: (context) => {
                retained.push(context)
                return { count: context.root.count + 1 }
              }
            },
            Observe: {
              branches: "observe",
              resolve: (context) => {
                retained.push(context)
                return context.select.stay()
              }
            }
          }
        }
      }
    })
    yield* verifyPlannerStrategies({
      machine,
      expected: "indexed-hierarchical",
      label: "retained callback contexts",
      events: [{ _tag: "Increment" }, { _tag: "Observe" }, { _tag: "IncrementRoot" }]
    })
    assert.deepStrictEqual(retained.map((context) => context.root.count), [0, 0, 1, 1, 1, 1])
    assert.strictEqual(new Set(retained).size, retained.length)
    for (const context of retained) {
      assert.deepStrictEqual(context.snapshot, {
        path: "",
        value: { _tag: "", count: context.root.count },
        state: { path: "Idle", value: undefined }
      })
    }
  }))

it.effect("constructs schema defaults throughout a parallel root", () => {
  const machine = Machine.make({
    root: Machine.state({
      type: "parallel",
      states: {
        Left: { schema: Schema.TaggedStruct("Left", {}), initial: "Idle", states: { Idle: { fields: {} } } },
        Right: { fields: {} }
      }
    }),
    events: Machine.events({ Noop: {} })
  })
  return verifyPlannerStrategies({
    machine,
    expected: "indexed-hierarchical",
    label: "default construction",
    events: [{ _tag: "Noop" }]
  })
})

it.effect("compares structural leaves, reentry, raised events and completion with generic planning", () => {
  const root1 = Machine.state({ initial: "Idle", states: { Idle: {}, Busy: {}, Done: { type: "final" } } })
  const targets1 = Machine.targets(root1)
  const machine = Machine.make({
    root: root1,
    events: Machine.events({ Begin: {}, Reenter: {}, Finish: {}, Complete: {} })
  }).handle({
    states: {
      Idle: { on: { Begin: { target: targets1.root.Busy } } },
      Busy: {
        on: {
          Reenter: { none: true, reenter: true },
          Finish: {
            none: true,
            resolve: (_, enqueue) => {
              enqueue.raise({ _tag: "Complete" })
            }
          },
          Complete: { target: targets1.root.Done }
        }
      }
    }
  })
  return verifyPlannerStrategies({
    machine,
    expected: "indexed-flat",
    label: "structural leaves",
    events: [
      { _tag: "Begin" },
      { _tag: "Reenter" },
      { _tag: "Finish" }
    ]
  })
})

it.effect("keeps flat root updates and retained snapshots equal to generic planning", () => {
  const root = Machine.state({ fields: { count: Schema.Number } })
  const targets2 = Machine.targets(root)
  const machine = Machine.make({
    root,
    events: Machine.events({ Increment: { by: Schema.Number }, Noop: {}, Reenter: {} }),
    initial: (root) => root.from(() => ({ count: 0 }))
  }).handle({
    on: {
      Increment: { update: targets2.root, from: ({ root: current, event }) => ({ count: current.count + event.by }) },
      Noop: { none: true },
      Reenter: { none: true, reenter: true }
    }
  })
  return verifyPlannerStrategies({
    machine,
    expected: "indexed-flat",
    label: "root updates",
    events: [
      { _tag: "Increment", by: 2 },
      { _tag: "Noop" },
      { _tag: "Reenter" },
      { _tag: "Increment", by: 3 }
    ]
  })
})

it.effect("keeps root values and child transitions equal to generic planning", () => {
  const root = Machine.state({ fields: { count: Schema.Number }, initial: "Idle", states: { Idle: {}, Busy: {} } })
  const targets3 = Machine.targets(root)
  const machine = Machine.make({
    root,
    events: Machine.events({ Increment: { by: Schema.Number }, Start: {}, Stop: {} }),
    initial: (root) => root.from(() => ({ count: 0 }))
  }).handle({
    on: {
      Increment: { update: targets3.root, from: ({ root: current, event }) => ({ count: current.count + event.by }) }
    },
    states: {
      Idle: { on: { Start: { target: targets3.root.Busy } } },
      Busy: { on: { Stop: { target: targets3.root.Idle } } }
    }
  })
  return verifyPlannerStrategies({
    machine,
    expected: "indexed-hierarchical",
    label: "root children",
    events: [
      { _tag: "Increment", by: 2 },
      { _tag: "Start" },
      { _tag: "Increment", by: 3 },
      { _tag: "Stop" }
    ]
  })
})

it.effect("reuses only immutable startup builders and keeps input values independent", () =>
  Effect.gen(function*() {
    const machine = Machine.make({
      root: Machine.state({ initial: "Idle", states: { Idle: { fields: { count: Schema.Number } }, Busy: {} } }),
      input: Schema.Struct({ count: Schema.Number }),
      events: Machine.events({ Noop: {} }),
      initialConfiguration: (root) =>
        root.resolve(({ input, target }) =>
          target.from((tree) => {
            // A retained builder cannot be changed to redirect another startup.
            assert.strictEqual(Reflect.set(tree, "Idle", tree.Busy), false)
            return tree.Idle.from({ count: input.count })
          })
        )
    }).handle({})
    const first = yield* Machine.planInitial(machine, { count: 1 })
    const second = yield* Machine.planInitial(machine, { count: 2 })
    assert.deepStrictEqual(first.state, {
      path: "",
      value: undefined,
      state: { path: "Idle", value: { _tag: "Idle", count: 1 } }
    })
    assert.deepStrictEqual(second.state, {
      path: "",
      value: undefined,
      state: { path: "Idle", value: { _tag: "Idle", count: 2 } }
    })
    for (const count of [3, 4]) {
      yield* verifyPlannerStrategies({
        machine,
        expected: "indexed-flat",
        label: `independent startup ${count}`,
        initialArgs: [{ count }],
        events: [{ _tag: "Noop" }]
      })
    }
  }))
