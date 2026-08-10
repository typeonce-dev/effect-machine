import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {}

describe("exact state definitions", () => {
  it("accepts the exact property grammar and preserves schema objects as atomic nodes", () => {
    const AnnotatedIdle = Idle.annotate({
      title: "Idle",
      arbitrarySchemaAnnotation: { owner: "machine-team" }
    })
    const states = Machine.defineStates({
      Atomic: { schema: Idle, type: "active" },
      SchemaAtomic: AnnotatedIdle,
      Final: { schema: Done, type: "final", output: Schema.String },
      Compound: {
        schema: Root,
        initial: "Idle",
        states: {
          Idle,
          Choice: { type: "choice", annotations: { title: "Route" } },
          History: { type: "history", history: "deep", annotations: { description: "Resume" } }
        }
      },
      Parallel: {
        schema: Root,
        type: "parallel",
        output: Schema.String,
        states: { Region: Idle }
      }
    })

    expect<Machine.Machine.StateNodeIdentifier<typeof states.states>>().type.toBe<
      | "Atomic"
      | "SchemaAtomic"
      | "Final"
      | "Compound"
      | "Compound.Idle"
      | "Compound.Choice"
      | "Compound.History"
      | "Parallel"
      | "Parallel.Region"
    >()
  })

  it("rejects unknown properties for every state kind, including nested nodes", () => {
    expect(Machine.defineStates).type.not.toBeCallableWith({
      Idle: { schema: Idle, unknown: true }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      Done: { schema: Done, type: "final", unknown: true }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      Root: { schema: Root, initial: "Idle", states: { Idle }, unknown: true }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      Root: { schema: Root, type: "parallel", states: { Idle }, unknown: true }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      Root: {
        schema: Root,
        initial: "Idle",
        states: {
          Idle,
          History: { type: "history", unknown: true },
          Choice: { type: "choice", unknown: true }
        }
      }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      states: {
        Root: {
          schema: Root,
          initial: "Idle",
          states: { Idle: { schema: Idle, nestedUnknown: true } }
        }
      },
      events: [],
      initial: (): never => {
        throw new Error("unreachable")
      }
    })
  })

  it("rejects empty, dotted, numeric-form, symbol, and __proto__ keys recursively", () => {
    const symbolKey = Symbol("state")

    expect(Machine.defineStates).type.not.toBeCallableWith({ "": Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ "bad.path": Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ 0: Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ "01": Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ "-1": Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ "1e3": Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ "0x10": Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ " 1": Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ "1 ": Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ " ": Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ "\t": Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ [symbolKey]: Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({ __proto__: Idle })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      Root: {
        schema: Root,
        initial: "bad.path",
        states: { "bad.path": Idle }
      }
    })

    type InvalidKey = Machine.Machine.ValidateStateSchemas<{
      readonly Root: {
        readonly schema: typeof Root
        readonly initial: "bad.path"
        readonly states: { readonly "bad.path": typeof Idle }
      }
    }>
    expect<InvalidKey["Root"]["states"]["bad.path"]["path"]>().type.toBe<"Root.bad.path">()
    expect<InvalidKey["Root"]["states"]["bad.path"]["details"]>().type.toBe<"bad.path">()

    type InvalidProperty = Machine.Machine.ValidateStateSchemas<{
      readonly Root: {
        readonly schema: typeof Root
        readonly initial: "Idle"
        readonly states: {
          readonly Idle: { readonly schema: typeof Idle; readonly nestedUnknown: true }
        }
      }
    }>
    expect<InvalidProperty["Root"]["states"]["Idle"]["path"]>().type.toBe<"Root.Idle">()
    expect<InvalidProperty["Root"]["states"]["Idle"]["details"]>().type.toBe<"nestedUnknown">()
  })
})
