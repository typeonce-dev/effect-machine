import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import { verifyPlannerStrategies } from "./support/strategyDifferential.js"

it.effect("compares flat updates and verifies guarded updates retain generic planning", () =>
  Effect.gen(function*() {
    for (const guarded of [false, true]) {
      const events = Machine.events({ Add: { by: Schema.Number }, Refresh: {} })
      const machine = Machine.make({
        root: Machine.state({ fields: { count: Schema.Number } }),
        events,
        initial: (root) => root.from(() => ({ count: 0 }))
      }).handle({
        on: {
          Add: (to) =>
            (guarded ? to.self.update.guard(({ event }) => event.by > 0) : to.self.update).from((
              { current, event }
            ) => ({ count: current.count + event.by })),
          Refresh: (to) =>
            to.none.reenter().resolve((_, enqueue) => {
              enqueue.raise(events.Add({ by: 1 }))
            })
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
      class Root extends Schema.TaggedClass<Root>("Root")("Root", { count: Schema.Number }) {}
      class Saved extends Schema.TaggedClass<Saved>("Saved")("Saved", { text: Schema.String }) {}
      const events = Machine.events({ Save: { allowed: Schema.Boolean }, Decoded: {}, Branch: {}, Finish: {} })
      const machine = Machine.make({
        root: Machine.state({
          schema: Root,
          initial: "Idle",
          states: { Idle: {}, Saved: { schema: Saved }, Done: { type: "final" } }
        }),
        events,
        initial: (root) => root.from(() => ({ count: 0 }))
      }).handle({
        on: { Save: (to) => to.self.update.from(({ current }) => ({ count: current.count + 10 })) },
        states: {
          Idle: {
            on: {
              Save: (to) => {
                const selected = to.local.Saved().updating(to.root)
                return (guarded ? selected.guard(({ event }) => event.allowed) : selected).from(({ current }) => ({
                  target: { text: "saved" },
                  update: { count: current.count + 1 }
                }))
              },
              Decoded: (to) =>
                to.local.Saved().updating(to.root).decoded(({ current }) => ({
                  target: new Saved({ text: "decoded" }),
                  update: new Root({ count: current.count + 2 })
                }))
            }
          },
          Saved: {
            on: {
              Save: (to) => {
                const selected = to.local.Saved().updating(to.root).reenter()
                return (guarded ? selected.guard(({ event }) => event.allowed) : selected).from((
                  { current, state }
                ) => ({
                  target: { text: state.text },
                  update: { count: current.count + 1 }
                }))
              },
              Branch: (to) =>
                to.branches({ saved: { target: to.local.Saved() } }).reenter().resolve(({ state, select }) =>
                  select.saved.decoded(state)
                ),
              Finish: (to) => to.local.Done()
            }
          }
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
