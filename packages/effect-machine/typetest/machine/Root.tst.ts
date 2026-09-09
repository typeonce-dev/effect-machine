import { Schema } from "effect"
import { describe, expect, test } from "tstyche"
import { Machine } from "../../src/index.js"
const root = Machine.state({
  fields: { count: Schema.Number },
  states: {
    Editing: { fields: { draft: Schema.String } },
    Saving: {}
  }
})
const events = Machine.events({ Increment: { by: Schema.Number }, Save: {} })
describe("root contracts", () => {
  test("preserves fields and child paths", () => {
    expect(root.path("")).type.toBe<"">()
    expect(root.path("Editing")).type.toBe<"Editing">()
    expect<Machine.Value<typeof root, "">>().type.toBe<{
      readonly _tag: ""
      readonly count: number
    }>()
    expect<Machine.Value<typeof root, "Editing">>().type.toBe<{
      readonly _tag: "Editing"
      readonly draft: string
    }>()
    expect(root.path).type.not.toBeCallableWith("Missing")
  })
  test("constructs root data and initial children at the handler boundary", () => {
    const definition = Machine.make({ root, events, input: Schema.Number })
    expect(Machine.start).type.not.toBeCallableWith(definition, 1)
    expect(definition).type.not.toHaveProperty("initial")
    expect(definition.handle).type.not.toBeCallableWith({ initial: { target: Machine.targets(root).root.Saving } })
    expect(definition.handle).type.not.toBeCallableWith({
      root: { count: 0 },
      initial: { target: Machine.targets(root).root.Editing }
    })
    const machine = definition.handle({
      root: ({ input }) => {
        expect(input).type.toBe<number>()
        return { count: input }
      },
      initial: {
        target: Machine.targets(root).root.Editing,
        data: ({ root, state }) => {
          expect(root.count).type.toBe<number>()
          expect(state.count).type.toBe<number>()
          return { draft: String(root.count) }
        }
      }
    })
    expect(Machine.start).type.toBeCallableWith(machine, 1)
  })
  test("keeps a reusable root independent from machine initialization", () => {
    const definition = Machine.make({ root, events })
    const editing = definition.handle({
      root: { count: 0 },
      initial: { target: Machine.targets(root).root.Editing, data: { draft: "" } }
    })
    const saving = definition.handle({ root: { count: 1 }, initial: { target: Machine.targets(root).root.Saving } })
    expect(Machine.start).type.toBeCallableWith(editing)
    expect(Machine.start).type.toBeCallableWith(saving)
    expect(root.node).type.not.toHaveProperty("initial")
  })
  test("rejects conflicting schemas and invalid root values", () => {
    // @ts-expect-error not assignable
    Machine.state({ fields: { count: Schema.Number }, schema: Schema.TaggedStruct("Count", { count: Schema.Number }) })
    // @ts-expect-error EventProtocolError
    Machine.events({ Save: { _tag: Schema.String } })
    const definition = Machine.make({ root, events })
    expect(definition.handle).type.not.toBeCallableWith({
      root: { count: "zero" },
      initial: { target: Machine.targets(root).root.Saving }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      root: { decoded: true, data: { count: 0 } },
      initial: { target: Machine.targets(root).root.Saving }
    })
  })
})
