import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {}

type TeamSlot = 1 | 2 | 3 | 4 | 5 | 6

describe("exact state definitions", () => {
  it("accepts the exact property grammar and preserves schema objects as atomic nodes", () => {
    const AnnotatedIdle = Idle.annotate({
      title: "Idle",
      arbitrarySchemaAnnotation: { owner: "machine-team" }
    })
    const states = Machine.states({
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
    expect(Machine.states).type.not.toBeCallableWith({
      Idle: { schema: Idle, unknown: true }
    })
    expect(Machine.states).type.not.toBeCallableWith({
      Done: { schema: Done, type: "final", unknown: true }
    })
    expect(Machine.states).type.not.toBeCallableWith({
      Root: { schema: Root, initial: "Idle", states: { Idle }, unknown: true }
    })
    expect(Machine.states).type.not.toBeCallableWith({
      Root: { schema: Root, type: "parallel", states: { Idle }, unknown: true }
    })
    expect(Machine.states).type.not.toBeCallableWith({
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
      events: Machine.events(),
      initial: (): never => {
        throw new Error("unreachable")
      }
    })
  })

  it("rejects empty, dotted, numeric-form, symbol, and __proto__ keys recursively", () => {
    const symbolKey = Symbol("state")

    expect(Machine.states).type.not.toBeCallableWith({ "": Idle })
    expect(Machine.states).type.not.toBeCallableWith({ "bad.path": Idle })
    expect(Machine.states).type.not.toBeCallableWith({ 0: Idle })
    expect(Machine.states).type.not.toBeCallableWith({ "01": Idle })
    expect(Machine.states).type.not.toBeCallableWith({ "-1": Idle })
    expect(Machine.states).type.not.toBeCallableWith({ "1e3": Idle })
    expect(Machine.states).type.not.toBeCallableWith({ "0x10": Idle })
    expect(Machine.states).type.not.toBeCallableWith({ " 1": Idle })
    expect(Machine.states).type.not.toBeCallableWith({ "1 ": Idle })
    expect(Machine.states).type.not.toBeCallableWith({ " ": Idle })
    expect(Machine.states).type.not.toBeCallableWith({ "\t": Idle })
    expect(Machine.states).type.not.toBeCallableWith({ [symbolKey]: Idle })
    expect(Machine.states).type.not.toBeCallableWith({ __proto__: Idle })
    expect(Machine.states).type.not.toBeCallableWith({
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

  it("rejects child keys reserved by definition-time target selectors", () => {
    expect(Machine.states).type.not.toBeCallableWith({
      Root: {
        initial: "initial",
        states: { initial: Idle }
      }
    })
    expect(Machine.states).type.not.toBeCallableWith({
      Root: {
        schema: Root,
        initial: "with",
        states: { with: Idle }
      }
    })
  })

  it("checks reusable state definitions and finite path families against the full tree", () => {
    const TradingSlot = Machine.state({
      initial: "Idle",
      states: {
        Idle: {},
        InSession: Idle,
        Applying: Done
      }
    })
    const States = Machine.states({
      root: {
        type: "parallel",
        states: {
          trading: {
            type: "parallel",
            states: {
              slot1: TradingSlot,
              slot2: TradingSlot,
              slot3: TradingSlot,
              slot4: TradingSlot,
              slot5: TradingSlot,
              slot6: TradingSlot
            }
          },
          teamStatus: {
            initial: "TeamLoaded",
            states: {
              TeamLoaded: {
                initial: "SlotSelected",
                states: { SlotSelected: Idle }
              }
            }
          }
        }
      }
    })

    const inSessionPath = <const Slot extends TeamSlot>(slot: Slot) => States.path(`root.trading.slot${slot}.InSession`)
    const applyingPath = <const Slot extends TeamSlot>(slot: Slot) => States.path(`root.trading.slot${slot}.Applying`)
    const offeredIfSlot = (snapshot: Machine.Snapshot<typeof States>, slot: TeamSlot) =>
      States.matches(snapshot, inSessionPath(slot)) ||
      States.matches(snapshot, applyingPath(slot)) ||
      States.matches(snapshot, States.path("root.teamStatus.TeamLoaded.SlotSelected"))

    expect(inSessionPath(3)).type.toBe<"root.trading.slot3.InSession">()
    expect<ReturnType<typeof offeredIfSlot>>().type.toBe<boolean>()
    expect<Machine.Snapshot<typeof States>>().type.toBe<
      Machine.Machine.Snapshot<typeof States.states>
    >()

    const invalidFamily = null as unknown as `root.trading.slot${TeamSlot}.Missing`
    const partlyInvalidFamily = null as unknown as `root.trading.slot${TeamSlot}.${"InSession" | "Missing"}`
    expect(States.path).type.not.toBeCallableWith(invalidFamily)
    expect(States.path).type.not.toBeCallableWith(partlyInvalidFamily)

    expect(Machine.state).type.not.toBeCallableWith({
      initial: "Missing",
      states: { Idle: {}, InSession: Idle }
    })
    expect(Machine.state).type.not.toBeCallableWith({
      states: { Idle: {}, InSession: Idle }
    })
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "Idle",
      states: { Idle: {}, InSession: Idle, Misspelled: { unknown: true } }
    })
  })
})
