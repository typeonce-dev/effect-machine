import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import { verifyPlannerStrategies } from "./support/strategyDifferential.js"

it.effect("matches generic startup with constructed and defaulted parallel region data", () => {
  const root = Machine.state({
    type: "parallel",
    states: {
      Required: { fields: { count: Schema.Number } },
      Defaulted: {
        fields: {
          label: Schema.String.pipe(Schema.optionalKey, Schema.withConstructorDefault(Effect.succeed("default")))
        }
      },
      Empty: {}
    }
  })
  const machine = Machine.make({ root, events: Machine.events({ Noop: {} }) }).handle({
    initial: { Required: { count: 1 } }
  })
  return Effect.gen(function*() {
    const initial = yield* Machine.planInitial(machine)
    assert.deepStrictEqual(initial.state.states.Defaulted.value, { _tag: "Defaulted", label: "default" })
    yield* verifyPlannerStrategies({
      machine,
      expected: "indexed-hierarchical",
      label: "mixed explicit and defaulted region construction",
      events: [{ _tag: "Noop" }]
    })
  })
})

it.effect("retains independent callback contexts across root, inline, and named transitions", () =>
  Effect.gen(function*() {
    const root = Machine.state({ fields: { count: Schema.Number }, states: { Idle: {} } })
    const targets = Machine.targets(root)
    const retained: Array<{
      readonly root: {
        readonly count: number
      }
      readonly snapshot: unknown
    }> = []
    const machine = Machine.make({
      root,
      events: Machine.events({ Increment: {}, Observe: {}, IncrementRoot: {} }),
      branches: { observe: { stay: { none: true } } }
    }).handle({
      initial: {
        target: Machine.targets(root).root.Idle
      },
      root: () => ({ count: 0 }),
      on: {
        IncrementRoot: {
          update: targets.root,
          data: (context) => {
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
              data: (context) => {
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
  const InitialRoot1 = Machine.state({
    type: "parallel",
    states: {
      Left: { schema: Schema.TaggedStruct("Left", {}), states: { Idle: { fields: {} } } },
      Right: { fields: {} }
    }
  })
  const machine = Machine.make({
    root: InitialRoot1,
    events: Machine.events({ Noop: {} })
  }).handle({ states: { Left: { initial: { target: Machine.targets(InitialRoot1).root.Left.Idle } } } })
  return verifyPlannerStrategies({
    machine,
    expected: "indexed-hierarchical",
    label: "default construction",
    events: [{ _tag: "Noop" }]
  })
})
it.effect("compares structural leaves, reentry, raised events and completion with generic planning", () => {
  const root1 = Machine.state({ states: { Idle: {}, Busy: {}, Done: { type: "final" } } })
  const targets1 = Machine.targets(root1)
  const machine = Machine.make({
    root: root1,
    events: Machine.events({ Begin: {}, Reenter: {}, Finish: {}, Complete: {} })
  }).handle({
    initial: {
      target: Machine.targets(root1).root.Idle
    },
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
      },
      Done: {}
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
    events: Machine.events({ Increment: { by: Schema.Number }, Noop: {}, Reenter: {} })
  }).handle({
    root: () => ({ count: 0 }),
    on: {
      Increment: { update: targets2.root, data: ({ root: current, event }) => ({ count: current.count + event.by }) },
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
  const root = Machine.state({ fields: { count: Schema.Number }, states: { Idle: {}, Busy: {} } })
  const targets3 = Machine.targets(root)
  const machine = Machine.make({
    root,
    events: Machine.events({ Increment: { by: Schema.Number }, Start: {}, Stop: {} })
  }).handle({
    initial: {
      target: Machine.targets(root).root.Idle
    },
    root: () => ({ count: 0 }),
    on: {
      Increment: { update: targets3.root, data: ({ root: current, event }) => ({ count: current.count + event.by }) }
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
    const InitialRoot2 = Machine.state({
      fields: { count: Schema.Number },
      states: { Idle: { fields: { count: Schema.Number } }, Busy: {} }
    })
    const machine = Machine.make({
      root: InitialRoot2,
      input: Schema.Struct({ count: Schema.Number }),
      events: Machine.events({ Noop: {} })
    }).handle({
      root: ({ input }) => ({ count: input.count }),
      initial: { target: Machine.targets(InitialRoot2).root.Idle, data: ({ root }) => ({ count: root.count }) }
    })
    const targets = Machine.targets(InitialRoot2)
    assert.strictEqual(Reflect.set(targets.root, "Idle", targets.root.Busy), false)
    const first = yield* Machine.planInitial(machine, { count: 1 })
    const second = yield* Machine.planInitial(machine, { count: 2 })
    assert.deepStrictEqual(first.state, {
      path: "",
      value: { _tag: "", count: 1 },
      state: { path: "Idle", value: { _tag: "Idle", count: 1 } }
    })
    assert.deepStrictEqual(second.state, {
      path: "",
      value: { _tag: "", count: 2 },
      state: { path: "Idle", value: { _tag: "Idle", count: 2 } }
    })
    for (const count of [3, 4]) {
      yield* verifyPlannerStrategies({
        machine,
        expected: "indexed-hierarchical",
        label: `independent startup ${count}`,
        initialArgs: [{ count }],
        events: [{ _tag: "Noop" }]
      })
    }
  }))

it.effect("compares fresh root input and parallel initial constructors across planners", () => {
  const root = Machine.state({
    type: "parallel",
    states: {
      Left: { fields: { count: Schema.Number } },
      Right: { fields: { label: Schema.String } }
    }
  })
  const targets = Machine.targets(root)
  const machine = Machine.make({
    root,
    input: Schema.Number,
    events: Machine.events({ Reset: { count: Schema.Number }, Restart: { count: Schema.Number } })
  }).handle({
    initial: { Left: ({ input }) => ({ count: input }), Right: ({ input }) => ({ label: String(input) }) },
    on: {
      Reset: { target: targets.root, input: ({ event }) => event.count },
      Restart: { target: targets.root, input: ({ event }) => event.count, reenter: true }
    }
  })
  return verifyPlannerStrategies({
    machine,
    initialArgs: [1],
    label: "fresh parallel root input",
    events: [{ _tag: "Reset", count: 2 }, { _tag: "Restart", count: 3 }]
  })
})

it.effect("preserves owner updates while resolving compound initial descendants", () => {
  const root = Machine.state({
    fields: { count: Schema.Number },
    states: {
      Idle: {},
      Work: { fields: { title: Schema.String }, states: { Ready: {} } }
    }
  })
  const targets = Machine.targets(root)
  const machine = Machine.make({ root, events: Machine.events({ Open: {} }) }).handle({
    root: { count: 0 },
    initial: { target: targets.root.Idle },
    states: {
      Idle: {
        on: {
          Open: {
            target: targets.root.Work,
            update: targets.root,
            data: { target: { title: "new" }, update: { count: 1 } }
          }
        }
      },
      Work: { initial: { target: targets.root.Work.Ready } }
    }
  })
  return verifyPlannerStrategies({
    machine,
    label: "compound initial with retained owner update",
    events: [{ _tag: "Open" }]
  })
})
