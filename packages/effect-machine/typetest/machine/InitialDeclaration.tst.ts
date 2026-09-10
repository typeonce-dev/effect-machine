import { Effect, Schema } from "effect"
import { describe, expect, test } from "tstyche"
import { Machine } from "../../src/index.js"

describe("handler-owned initial declarations", () => {
  test("keeps input at root construction and narrows parent data", () => {
    const root = Machine.state({
      fields: { seed: Schema.Number },
      states: {
        Session: {
          fields: { count: Schema.Number },
          states: { Ready: { fields: { label: Schema.String } }, Empty: {} }
        },
        Idle: {}
      }
    })
    const targets = Machine.targets(root)
    const definition = Machine.make({ root, input: Schema.Number, events: Machine.events({ Reset: {} }) })
    const nested = { initial: { target: targets.root.Session.Empty } }
    expect(definition.handle).type.not.toBeCallableWith({ root: { seed: 0 }, states: { Session: nested } })
    expect(definition.handle).type.not.toBeCallableWith({
      root: { seed: 0 },
      initial: { target: targets.root.Session.Ready, data: { label: "" } },
      states: { Session: nested }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      root: { seed: 0 },
      initial: { target: targets.root.Idle, data: {} },
      states: { Session: nested }
    })
    const machine = definition.handle({
      root: ({ input }) => ({ seed: input }),
      initial: {
        target: targets.root.Session,
        data: ({ root, state }) => {
          expect(root.seed).type.toBe<number>()
          expect(state.seed).type.toBe<number>()
          return { count: root.seed }
        }
      },
      states: {
        Session: {
          initial: {
            target: targets.root.Session.Ready,
            data: (context) => {
              expect(context.state.count).type.toBe<number>()
              expect(context.root.seed).type.toBe<number>()
              expect(context).type.not.toHaveProperty("input")
              return { label: String(context.state.count) }
            }
          }
        }
      }
    })
    expect(Machine.start).type.toBeCallableWith(machine, 1)
  })

  test("requires valued parallel regions without a regions wrapper", () => {
    const root = Machine.state({
      type: "parallel",
      states: {
        data: { fields: { count: Schema.Number } },
        decoded: {},
        Empty: {}
      }
    })
    const definition = Machine.make({ root, events: Machine.events({}) })
    expect(definition.handle).type.not.toBeCallableWith({})
    expect(definition.handle).type.not.toBeCallableWith({ initial: { data: { count: "bad" } } })
    expect(definition.handle).type.not.toBeCallableWith({ initial: { data: { count: 0 }, Empty: {} } })
    expect(definition.handle).type.not.toBeCallableWith({ initial: { data: { count: 0 }, Unknown: {} } })
    expect(definition.handle).type.not.toBeCallableWith({
      initial: { data: { decoded: true, data: { _tag: "data", count: 0 }, extra: true } }
    })
    const machine = definition.handle({ initial: { data: { count: 0 } } })
    expect(Machine.start).type.toBeCallableWith(machine)
  })

  test("requires construction throughout inactive and history descendants", () => {
    const root = Machine.state({
      states: {
        Idle: {},
        Session: {
          states: {
            recent: { type: "history", history: "shallow" },
            Work: {
              type: "parallel",
              states: {
                Left: { fields: { count: Schema.Number }, states: { Ready: { fields: { label: Schema.String } } } },
                Right: {}
              }
            }
          }
        }
      }
    })
    const targets = Machine.targets(root)
    const definition = Machine.make({ root, events: Machine.events({}) })
    const left = { initial: { target: targets.root.Session.Work.Left.Ready, data: { label: "ready" } } }
    const work = { initial: { Left: { count: 0 } }, states: { Left: left } }
    const session = { initial: { target: targets.root.Session.Work }, states: { Work: work } }
    const baseline = { initial: { target: targets.root.Idle }, states: { Session: session } }
    expect(definition.handle).type.toBeCallableWith(baseline)
    expect(definition.handle).type.not.toBeCallableWith({
      ...baseline,
      initial: { target: targets.root.Idle, resolve: () => ({}) }
    })
    expect(definition.handle).type.not.toBeCallableWith({ target: baseline.initial })
    expect(definition.handle).type.not.toBeCallableWith({ ...baseline, states: { Session: {} } })
    expect(definition.handle).type.not.toBeCallableWith({
      ...baseline,
      states: { Session: { ...session, states: { Work: { states: { Left: left } } } } }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      ...baseline,
      states: {
        Session: {
          ...session,
          states: { Work: { ...work, states: { Left: { initial: { target: targets.root.Session.Work.Left.Ready } } } } }
        }
      }
    })
    expect(Machine.planInitial).type.not.toBeCallableWith(definition)
  })

  test("constructors cannot perform asynchronous work", () => {
    const root = Machine.state({ states: { Ready: { fields: { count: Schema.Number } } } })
    const targets = Machine.targets(root)
    const definition = Machine.make({ root, events: Machine.events({}) })
    expect(definition.handle).type.toBeCallableWith({ initial: { target: targets.root.Ready, data: { count: 0 } } })
    expect(definition.handle).type.not.toBeCallableWith({
      initial: { target: targets.root.Ready, data: () => Effect.succeed({ count: 0 }) }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      initial: { target: targets.root.Ready, data: async () => ({ count: 0 }) }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      initial: { target: targets.root.Ready, data: { count: 0 } },
      initialize: () => ({})
    })
  })

  test("reserves only the direct decoded descriptor shape", () => {
    const root = Machine.state({ fields: { decoded: Schema.Boolean, data: Schema.String } })
    const definition = Machine.make({ root, events: Machine.events({}) })
    expect(definition.handle).type.not.toBeCallableWith({ root: { decoded: true, data: "value" } })
    expect(definition.handle).type.not.toBeCallableWith({ root: { decoded: true as boolean, data: "value" } })
    expect(definition.handle).type.not.toBeCallableWith({
      root: { decoded: true, data: { _tag: "", decoded: true, data: "value" }, extra: true }
    })
    const ordinary = definition.handle({ root: { decoded: false, data: "value" } })
    const callback = definition.handle({ root: () => ({ decoded: true, data: "value" }) })
    const decoded = definition.handle({ root: { decoded: true, data: { _tag: "", decoded: true, data: "value" } } })
    expect(Machine.start).type.toBeCallableWith(ordinary)
    expect(Machine.start).type.toBeCallableWith(callback)
    expect(Machine.start).type.toBeCallableWith(decoded)
  })
})
