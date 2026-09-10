import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"

it.effect("constructs complete parallel subtrees and resolves explicit nested choices", () =>
  Effect.gen(function*() {
    const root = Machine.state({
      states: {
        Idle: {},
        Work: {
          type: "parallel",
          states: {
            Left: {
              fields: { id: Schema.String },
              states: {
                Empty: {},
                Route: { type: "choice" },
                Ready: { fields: { id: Schema.String } }
              }
            },
            Right: { fields: { count: Schema.Number }, states: { Waiting: {} } }
          }
        }
      }
    })
    const targets = Machine.targets(root)
    const machine = Machine.make({
      root,
      events: Machine.events({ Open: {} }),
      branches: { open: { work: { target: targets.root.Work } } }
    }).handle({
      initial: { target: targets.root.Idle },
      states: {
        Idle: {
          on: {
            Open: {
              branches: "open",
              resolve: ({ select }) =>
                select.work({
                  states: {
                    Left: { data: { id: "new" }, states: { Route: {} } },
                    Right: { data: { count: 3 }, states: { Waiting: {} } }
                  }
                })
            }
          }
        },
        Work: {
          initial: { Left: { id: "default" }, Right: { count: 0 } },
          states: {
            Left: {
              initial: { target: targets.root.Work.Left.Empty },
              states: {
                Route: {
                  choice: {
                    target: targets.root.Work.Left.Ready,
                    data: ({ containingState }) => ({ id: containingState.id })
                  }
                }
              }
            },
            Right: { initial: { target: targets.root.Work.Right.Waiting } }
          }
        }
      }
    })
    const initial = yield* Machine.planInitial(machine)
    const next = yield* Machine.plan(machine, initial.state, { _tag: "Open" })
    assert.isTrue(root.matches(next.next, "Work.Left.Ready"))
    assert.isTrue(root.matches(next.next, "Work.Right.Waiting"))
    assert.deepStrictEqual(
      root.get(next.next, "Work.Right").pipe((v) => v._tag === "Some" ? v.value.count : undefined),
      3
    )
  }))

it.effect("enters a compound's default child with a retained-owner replacement", () =>
  Effect.gen(function*() {
    const root = Machine.state({
      fields: { revision: Schema.Number },
      states: {
        Idle: {},
        Flow: {
          fields: { title: Schema.String },
          states: { Editing: { fields: { title: Schema.String, revision: Schema.Number } } }
        }
      }
    })
    const targets = Machine.targets(root)
    const machine = Machine.make({ root, events: Machine.events({ Open: {} }) }).handle({
      root: { revision: 0 },
      initial: { target: targets.root.Idle },
      states: {
        Idle: {
          on: {
            Open: {
              target: targets.root.Flow,
              update: targets.root,
              data: { target: { title: "new" }, update: { revision: 1 } }
            }
          }
        },
        Flow: {
          initial: {
            target: targets.root.Flow.Editing,
            data: ({ state, root }) => ({ title: state.title, revision: root.revision })
          }
        }
      }
    })
    const initial = yield* Machine.planInitial(machine)
    const next = yield* Machine.plan(machine, initial.state, { _tag: "Open" })
    assert.isTrue(root.matches(next.next, "Flow.Editing"))
    assert.deepStrictEqual(next.next.value, { _tag: "", revision: 1 })
    assert.deepStrictEqual(
      root.get(next.next, "Flow.Editing").pipe((value) => value._tag === "Some" ? value.value.revision : undefined),
      1
    )
  }))
