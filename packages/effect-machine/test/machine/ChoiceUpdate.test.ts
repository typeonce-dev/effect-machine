import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"
import { makeMermaidRenderer } from "./visualization/mermaid.js"
import { makeTextRenderer } from "./visualization/text.js"

const States = Machine.state({
  fields: { count: Schema.Number },
  states: { Idle: {}, Route: { type: "choice" }, Low: {}, High: {} }
})
const Events = Machine.events({ Bump: {} })
let observed: Array<number> = []
const machine = Machine.make({
  root: States,
  events: Events
}).handle({
  root: { count: 0 },
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Bump: { target: "Route", update: { root: ({ root }) => ({ count: root.count + 1 }) } } } },
    Route: {
      choice: {
        branches: [{ target: "Low" }, { target: "High" }],
        resolve: ({ containingState, ancestors, root, select }) => {
          observed.push(containingState.count, ancestors[""].count, root.count)
          return containingState.count > 0 ? select.target("High") : select.target("Low")
        }
      }
    },
    Low: {},
    High: {}
  }
})

const NestedStates = Machine.state({
  states: {
    Flow: {
      fields: { count: Schema.Number },
      states: { Idle: {}, First: { type: "choice" }, Second: { type: "choice" }, Even: {}, Odd: {} }
    },
    Outside: {}
  }
})
const NestedEvents = Machine.events({ Bump: {}, Stay: {}, Reset: {} })
const makeNested = (second: ReadonlyArray<{ readonly target: string }>) =>
  Machine.make({
    root: NestedStates,
    events: NestedEvents
  }).handle({
    initial: { target: "Flow", data: { count: 0 } },
    states: {
      Flow: {
        on: { Reset: { update: { Flow: () => ({ count: 0 }) } } },
        initial: { target: "Flow.Idle" },
        states: {
          Idle: {
            on: {
              Bump: {
                target: "Flow.First",
                update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 }) }
              }
            }
          },
          First: {
            choice: { branches: [{ target: "Flow.Second" }], resolve: ({ select }) => select.target("Flow.Second") }
          },
          Second: {
            choice: {
              branches: second as readonly [{ readonly target: "Flow.Even" }, { readonly target: "Flow.Odd" }],
              resolve: ({ containingState, select }) =>
                containingState.count % 2 === 0 ? select.target("Flow.Even") : select.target("Flow.Odd")
            }
          },
          Even: {
            on: {
              Stay: {
                target: "Flow.First",
                update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 2 }) },
                reenter: true
              }
            }
          },
          Odd: {
            on: {
              Bump: {
                target: "Flow.First",
                update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 }) }
              }
            }
          }
        }
      },
      Outside: {}
    }
  })
const flowOf = (snapshot: Machine.Snapshot<typeof NestedStates>) => {
  assert.strictEqual(snapshot.state.path, "Flow")
  if (snapshot.state.path !== "Flow") throw new Error("Expected Flow")
  return { count: snapshot.state.value.count, path: snapshot.state.state.path }
}
const nested = makeNested([{ target: "Flow.Even" }, { target: "Flow.Odd" }])

describe("Machine target and update into a choice", () => {
  it.effect("updates the owner before the choice resolves and enters the chosen branch", () =>
    Effect.gen(function*() {
      observed = []
      const initial = yield* Machine.planInitial(machine)
      const plan = yield* Machine.plan(machine, initial.state, Events.Bump())
      assert.deepStrictEqual(observed, [1, 1, 1])
      assert.strictEqual(plan.next.value.count, 1)
      assert.strictEqual(plan.next.state.path, "High")
      assert.deepStrictEqual(plan.microsteps.map(({ transitions }) => transitions), [[
        {
          source: "Idle",
          trigger: { type: "event", event: "Bump" },
          reenter: false,
          branchIndex: 0,
          branchKey: undefined,
          target: "Route",
          resolvedTarget: "High",
          updates: [""]
        },
        {
          source: "Route",
          trigger: { type: "choice" },
          reenter: false,
          branchIndex: 1,
          branchKey: "target:High",
          target: "High",
          resolvedTarget: "High",
          updates: []
        }
      ]])
    }))

  it("inspects the choice selection and its owner update without running resolvers", () => {
    const bump = Machine.transitionDefinitions(machine).find(({ source }) => source === "Idle")
    assert.deepStrictEqual(bump?.branches, [{
      type: "direct",
      target: "Route",
      selection: { path: "Route", kind: "choice", scope: "branch" },
      updates: [""]
    }])
  })

  it.effect("renders the owner update on the edge into the choice", () =>
    Effect.gen(function*() {
      const initial = yield* Machine.planInitial(nested)
      const text = makeTextRenderer<typeof nested, typeof initial.state>(Machine)(nested, initial.state)
      const mermaid = makeMermaidRenderer<typeof nested, typeof initial.state>(Machine)(nested, initial.state)
      assert.include(text, "├─ ● Idle\n   │  │  └─ ◇ on: Bump\n   │  │     └┄ → First / update Flow")
      assert.include(text, "└─ ◇ on: Stay [reenter]\n   │  │     └┄ → First / update Flow")
      assert.include(text, "├─ ○ First [choice]\n   │  │  └─ ◇ choice\n   │  │     └┄ [target:Flow.Second] → Second")
      assert.include(mermaid, "state state_3 <<choice>>")
      assert.include(mermaid, "state_2 --> state_3: Bump / update Flow")
      assert.include(mermaid, "state_5 --> state_3: Stay [reenter] / update Flow")
      assert.include(mermaid, "state_4 --> state_6: choice [target:Flow.Odd]")
    }))

  it.effect("applies the update and the chosen target in a running machine", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(machine)
      yield* ref.send(Events.Bump())
      const { state } = yield* Machine.waitFor(ref, ({ state }) => state.state.path === "High")
      assert.strictEqual(state.value.count, 1)
    }))

  it.effect("resolves nested choices against the updated owner", () =>
    Effect.gen(function*() {
      const initial = yield* Machine.planInitial(nested)
      const first = yield* Machine.plan(nested, initial.state, NestedEvents.Bump())
      assert.deepStrictEqual(flowOf(first.next), { count: 1, path: "Flow.Odd" })
      assert.deepStrictEqual(
        first.microsteps[0]?.transitions.map(({ source, branchKey, target, resolvedTarget, updates }) => ({
          source,
          branchKey,
          target,
          resolvedTarget,
          updates
        })),
        [
          {
            source: "Flow.Idle",
            branchKey: undefined,
            target: "Flow.First",
            resolvedTarget: "Flow.Odd",
            updates: ["Flow"]
          },
          {
            source: "Flow.First",
            branchKey: "target:Flow.Second",
            target: "Flow.Second",
            resolvedTarget: "Flow.Second",
            updates: []
          },
          {
            source: "Flow.Second",
            branchKey: "target:Flow.Odd",
            target: "Flow.Odd",
            resolvedTarget: "Flow.Odd",
            updates: []
          }
        ]
      )
      const second = yield* Machine.plan(nested, first.next, NestedEvents.Bump())
      assert.deepStrictEqual(flowOf(second.next), { count: 2, path: "Flow.Even" })
      assert.deepStrictEqual(second.microsteps[0]?.exitPaths, ["Flow.Odd"])
      assert.deepStrictEqual(second.microsteps[0]?.entryPaths, ["Flow.Even"])
    }))

  it.effect("satisfies MachineTest definition laws for updates entering choices", () =>
    Effect.gen(function*() {
      const events = [NestedEvents.Bump(), NestedEvents.Bump(), NestedEvents.Stay(), NestedEvents.Reset()]
      const trace = yield* MachineTest.run(nested, { events })
      yield* MachineTest.verify(nested, trace)
      const coverage = MachineTest.coverage(nested, trace)
      assert.strictEqual(coverage.microsteps.choiceTriggered, 6)
    }))

  it.effect("reenters the source when a reentering update resolves the choice back to it", () =>
    Effect.gen(function*() {
      const initial = yield* Machine.planInitial(nested)
      const odd = yield* Machine.plan(nested, initial.state, NestedEvents.Bump())
      const even = yield* Machine.plan(nested, odd.next, NestedEvents.Bump())
      const plan = yield* Machine.plan(nested, even.next, NestedEvents.Stay())
      assert.deepStrictEqual(flowOf(plan.next), { count: 4, path: "Flow.Even" })
      assert.strictEqual(plan.microsteps[0]?.transitions[0]?.reenter, true)
      assert.deepStrictEqual(plan.microsteps[0]?.exitPaths, ["Flow.Even"])
      assert.deepStrictEqual(plan.microsteps[0]?.entryPaths, ["Flow.Even"])
    }))

  it.effect("keeps a targetless owner update in place", () =>
    Effect.gen(function*() {
      const initial = yield* Machine.planInitial(nested)
      const odd = yield* Machine.plan(nested, initial.state, NestedEvents.Bump())
      const plan = yield* Machine.plan(nested, odd.next, NestedEvents.Reset())
      assert.deepStrictEqual(flowOf(plan.next), { count: 0, path: "Flow.Odd" })
      assert.deepStrictEqual(plan.microsteps[0]?.exitPaths, [])
      assert.deepStrictEqual(plan.microsteps[0]?.entryPaths, [])
    }))

  it.effect("enters a choice from a declared branch that also updates its owner", () =>
    Effect.gen(function*() {
      const grouped = Machine.make({
        root: States,
        events: Events
      }).handle({
        root: { count: 0 },
        initial: { target: "Idle" },
        states: {
          Idle: {
            on: {
              Bump: {
                branches: [{ target: "Route", update: "root" }],
                resolve: ({ root, select }) => select.target("Route", { update: { root: { count: root.count + 1 } } })
              }
            }
          },
          Route: {
            choice: {
              branches: [{ target: "Low" }, { target: "High" }],
              resolve: ({ containingState, select }) =>
                containingState.count > 0 ? select.target("High") : select.target("Low")
            }
          },
          Low: {},
          High: {}
        }
      })
      assert.deepStrictEqual(
        Machine.transitionDefinitions(grouped).find(({ source }) => source === "Idle")?.branches,
        [{
          type: "branch",
          key: "target:Route+update:root",
          target: "Route",
          selection: { path: "Route", kind: "choice", scope: "branch" },
          updates: [""]
        }]
      )
      const initial = yield* Machine.planInitial(grouped)
      const plan = yield* Machine.plan(grouped, initial.state, Events.Bump())
      assert.strictEqual(plan.next.value.count, 1)
      assert.strictEqual(plan.next.state.path, "High")
      assert.deepStrictEqual(
        plan.microsteps[0]?.transitions.map(({ source, branchKey, updates }) => ({ source, branchKey, updates })),
        [
          { source: "Idle", branchKey: "target:Route+update:root", updates: [""] },
          { source: "Route", branchKey: "target:High", updates: [] }
        ]
      )
    }))

  it("rejects a choice branch that can leave the updated owner", () => {
    assert.throws(
      () => makeNested([{ target: "Outside" }, { target: "Flow.Even" }, { target: "Flow.Odd" }]),
      "Machine transition from \"Flow.Idle\" updates \"Flow\" before choice \"Flow.Second\", whose branch \"target:Outside\" targets \"Outside\" outside that owner"
    )
  })

  it("rejects a direct choice transition that leaves the updated owner", () => {
    const definition = Machine.make({ root: NestedStates, events: NestedEvents })
    assert.throws(
      () =>
        definition.handle({
          initial: { target: "Flow", data: { count: 0 } },
          states: {
            Flow: {
              initial: { target: "Flow.Idle" },
              states: {
                Idle: {
                  on: {
                    Bump: {
                      target: "Flow.First",
                      update: { Flow: ({ ancestors }: any) => ({ count: ancestors.Flow.count + 1 }) }
                    } as any
                  }
                },
                First: { choice: { target: "Outside" } },
                Second: { choice: { target: "Flow.Even" } },
                Even: {},
                Odd: {}
              }
            },
            Outside: {}
          }
        }),
      "Machine transition from \"Flow.Idle\" updates \"Flow\" before choice \"Flow.First\", whose transition targets \"Outside\" outside that owner"
    )
  })

  it("keeps rejecting owners that are not valued retained ancestors", () => {
    const definition = Machine.make({ root: NestedStates, events: NestedEvents })
    assert.throws(
      () =>
        definition.handle({
          initial: { target: "Flow", data: { count: 0 } },
          states: {
            Flow: {
              initial: { target: "Flow.Idle" },
              states: {
                Idle: { on: { Bump: { target: "Flow.First", update: { "Flow.Idle": {} } } as any } },
                First: { choice: { target: "Flow.Even" } },
                Second: { choice: { target: "Flow.Even" } },
                Even: {},
                Odd: {}
              }
            },
            Outside: {}
          }
        }),
      "Machine updating owner \"Flow.Idle\" must be a valued ancestor retained by source \"Flow.Idle\" and target \"Flow.First\""
    )
  })
})
