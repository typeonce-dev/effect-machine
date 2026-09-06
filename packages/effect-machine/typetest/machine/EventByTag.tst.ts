import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

describe("Machine.EventByTag", () => {
  class Idle extends Schema.TaggedClass<Idle>("EventByTagIdle")("EventByTagIdle", {}) {}
  class Single extends Schema.TaggedClass<Single>("Single")("Single", {
    value: Schema.Number
  }) {}

  const FiniteUnion = Schema.Struct({
    _tag: Schema.Union([Schema.Literal("Alpha"), Schema.Literal("Beta")]),
    payload: Schema.String,
    count: Schema.Number
  })

  it("narrows each member of a finite tag union and preserves its payload", () => {
    type Alpha = Machine.Machine.EventByTag<readonly [typeof FiniteUnion], "Alpha">
    type Beta = Machine.Machine.EventByTag<readonly [typeof FiniteUnion], "Beta">

    expect<Alpha>().type.toBe<{
      readonly _tag: "Alpha"
      readonly payload: string
      readonly count: number
    }>()
    expect<Beta>().type.toBe<{
      readonly _tag: "Beta"
      readonly payload: string
      readonly count: number
    }>()
  })

  it("narrows handler contexts for every finite tag", () => {
    const states = Machine.state({ initial: "Idle", states: { Idle } })
    Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(FiniteUnion),
      initialConfiguration: (root) => root.resolve(({ target }) => (target.from((to) => to.Idle.decoded(new Idle({})))))
    }).handle({
      states: {
        Idle: {
          on: {
            Alpha: (to) =>
              to.none.resolve(({ event }) => {
                expect(event).type.toBe<{
                  readonly _tag: "Alpha"
                  readonly payload: string
                  readonly count: number
                }>()
                return undefined
              }),
            Beta: (to) =>
              to.none.resolve(({ event }) => {
                expect(event).type.toBe<{
                  readonly _tag: "Beta"
                  readonly payload: string
                  readonly count: number
                }>()
                return undefined
              })
          }
        }
      }
    })
  })

  it("preserves ordinary tagged-class event types", () => {
    expect<Machine.Machine.EventByTag<readonly [typeof Single], "Single">>().type.toBe<Single>()
  })
})
