import { Schema } from "effect"
import { describe, expect, test } from "tstyche"
import { Machine } from "../../src/index.js"

class Root extends Schema.TaggedClass<Root>("Root")("Root", { count: Schema.Number }) {}
class Saved extends Schema.TaggedClass<Saved>("Saved")("Saved", { text: Schema.String }) {}
const definition = Machine.make({
  root: Machine.state({
    schema: Root,
    initial: "Idle",
    states: {
      Idle: {},
      Saved: { schema: Saved },
      Nested: {
        fields: { label: Schema.String },
        initial: "Child",
        states: { Child: { fields: { required: Schema.String } } }
      }
    }
  }),
  events: Machine.events({ Save: { text: Schema.String } }),
  initial: (root) => {
    expect(root).type.not.toHaveProperty("guard")
    expect(root).type.not.toHaveProperty("reenter")
    return root.from(() => ({ count: 0 }))
  }
})

describe("transition construction", () => {
  test("infers both values and preserves explicit construction requirements", () => {
    definition.handle({
      states: {
        Idle: {
          on: {
            Save: (to) => {
              const combined = to.local.Saved().updating(to.root)
              expect(combined).type.toHaveProperty("from")
              expect(combined).type.toHaveProperty("decoded")
              expect(combined).type.toHaveProperty("guard")
              expect(to.local.Nested().updating(to.root)).type.not.toHaveProperty("from")
              expect(to.self).type.not.toHaveProperty("update")
              // @ts-expect-error Property 'text' is missing
              combined.from(() => ({ target: {}, update: { count: 1 } }))
              // @ts-expect-error Property 'count' is missing
              combined.from(() => ({ target: { text: "" }, update: {} }))
              // @ts-expect-error Property 'update' is missing
              combined.from(() => ({ target: { text: "" } }))
              // @ts-expect-error Property '_tag' is missing
              combined.decoded(() => ({ target: { text: "" }, update: new Root({ count: 1 }) }))
              // @ts-expect-error Property '_tag' is missing
              combined.decoded(() => ({ target: new Saved({ text: "" }), update: { count: 1 } }))
              combined.decoded(() => ({ target: new Saved({ text: "" }), update: new Root({ count: 1 }) }))
              return combined.reenter().guard(({ current, event }) => {
                expect(current).type.toBe<Root>()
                expect(event.text).type.toBe<string>()
                return event.text.length > 0
              }).from(({ current, event }) => ({ target: { text: event.text }, update: { count: current.count + 1 } }))
            }
          }
        }
      }
    })
  })

  test("guards updates without allowing incomplete replacements or implicit reentry", () => {
    definition.handle({
      on: {
        Save: (to) => {
          expect(to.self.update).type.not.toHaveProperty("reenter")
          const guarded = to.self.update.guard(({ current, event }) => current.count > event.text.length)
          // @ts-expect-error Property 'count' is missing
          guarded.from(() => ({}))
          return guarded.decoded(({ current }) => current)
        }
      }
    })
  })

  test("reentry composes with value construction and branch resolution", () => {
    definition.handle({
      states: {
        Idle: {
          on: {
            Save: (to) => {
              // @ts-expect-error No overload matches this call
              to.local.Saved().resolve(({ target }) => target.from({ text: "" }), { reenter: true })
              const target = to.local.Saved().reenter()
              expect(target).type.toHaveProperty("from")
              expect(target).type.toHaveProperty("decoded")
              expect(target).type.toHaveProperty("resolve")
              // @ts-expect-error Property '[Topology.TargetSelectionTypeId]' is missing
              to.branches({ saved: { target } })
              return to.branches({ saved: { target: to.local.Saved() } }).reenter().resolve(({ event, select }) =>
                select.saved.from({ text: event.text })
              )
            }
          }
        }
      }
    })
  })
})
