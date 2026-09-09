import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import { verifyPlannerStrategies } from "./support/strategyDifferential.js"
it.effect("compares flat updates and verifies guarded updates retain generic planning", () =>
  Effect.gen(function*() {
    for (const guarded of [false, true]) {
      const events = Machine.events({ Add: { by: Schema.Number }, Refresh: {} })
      const root1 = Machine.state({ fields: { count: Schema.Number } })
      const targets1 = Machine.targets(root1)
      const machine = Machine.make({
        root: root1,
        events
      }).handle({
        root: () => ({ count: 0 }),
        on: {
          Add: {
            update: targets1.root,
            guard: guarded
              ? ({ event }) => event.by > 0
              : undefined,
            data: ({ root, event }) => ({ count: root.count + event.by })
          },
          Refresh: {
            none: true,
            reenter: true,
            resolve: (_, enqueue) => {
              enqueue.raise(events.Add({ by: 1 }))
            }
          }
        }
      })
      yield* verifyPlannerStrategies({
        machine,
        expected: guarded ? "generic" : "indexed-flat",
        label: "guarded flat construction",
        events: [
          { _tag: "Add", by: -1 },
          { _tag: "Add", by: 2 },
          { _tag: "Refresh" }
        ]
      })
    }
  }))
it.effect("compares atomic construction and verifies guards retain generic planning", () =>
  Effect.gen(function*() {
    for (const guarded of [false, true]) {
      class Root extends Schema.TaggedClass<Root>("Root")("Root", { count: Schema.Number }) {
      }
      class Saved extends Schema.TaggedClass<Saved>("Saved")("Saved", { text: Schema.String }) {
      }
      const events = Machine.events({ Save: { allowed: Schema.Boolean }, Decoded: {}, Branch: {}, Finish: {} })
      const root2 = Machine.state({
        schema: Root,
        states: { Idle: {}, Saved: { schema: Saved }, Done: { type: "final" } }
      })
      const targets2 = Machine.targets(root2)
      const machine = Machine.make({
        branches: { transition1: { saved: { target: targets2.root.Saved } } },
        root: root2,
        events
      }).handle({
        initial: {
          target: Machine.targets(root2).root.Idle
        },
        root: () => ({ count: 0 }),
        on: { Save: { update: targets2.root, data: ({ root: current }) => ({ count: current.count + 10 }) } },
        states: {
          Idle: {
            on: {
              Save: {
                target: targets2.root.Saved,
                update: targets2.root,
                guard: guarded
                  ? ({ event }) => event.allowed
                  : undefined,
                data: ({ root }) => ({ target: { text: "saved" }, update: { count: root.count + 1 } })
              },
              Decoded: {
                target: targets2.root.Saved,
                update: targets2.root,
                decoded: true,
                data: ({ root: current }) => ({
                  target: new Saved({ text: "decoded" }),
                  update: new Root({ count: current.count + 2 })
                })
              }
            }
          },
          Saved: {
            on: {
              Save: {
                target: targets2.root.Saved,
                update: targets2.root,
                reenter: true,
                guard: guarded
                  ? ({ event }) => event.allowed
                  : undefined,
                data: ({ root, state }) => ({ target: { text: state.text }, update: { count: root.count + 1 } })
              },
              Branch: {
                branches: "transition1",
                reenter: true,
                resolve: ({ state, select }) => select.saved.decoded(state)
              },
              Finish: { target: targets2.root.Done }
            }
          },
          Done: {}
        }
      })
      yield* verifyPlannerStrategies({
        machine,
        expected: guarded ? "generic" : "indexed-hierarchical",
        label: "atomic construction",
        events: [
          { _tag: "Decoded" },
          { _tag: "Save", allowed: false },
          { _tag: "Save", allowed: true },
          { _tag: "Branch" },
          { _tag: "Finish" }
        ]
      })
    }
  }))
