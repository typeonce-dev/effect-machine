import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
class InSession extends Schema.TaggedClass<InSession>("ConsumerTypesInSession")("InSession", {
  offerId: Schema.String,
  role: Schema.Literals(["offerer", "proposer"])
}) {}
const States = Machine.state({
  states: {
    root: {
      states: {
        Idle: {},
        InSession
      }
    }
  }
})
const StartupInput = Schema.Struct({
  offerId: Schema.String,
  role: Schema.Literals(["offerer", "proposer"])
})
const definition = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(),
  input: StartupInput
})
const machine = definition.handle({
  initial: { target: Machine.targets(States).root.root },
  states: {
    root: { initial: { target: Machine.targets(States).root.root.Idle }, states: { Idle: {}, InSession: {} } }
  }
})
const voidMachine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas()
}).handle({
  initial: {
    target: Machine.targets(States).root.root
  },
  states: {
    root: {
      initial: {
        target: Machine.targets(States).root.root.Idle
      },
      states: { Idle: {}, InSession: {} }
    }
  }
})
describe("consumer type extractors", () => {
  it("extracts complete snapshots from defined states and machines", () => {
    expect<Machine.Snapshot<typeof States>>().type.toBe<Machine.Snapshot<typeof States>>()
    expect<Machine.Snapshot<typeof machine>>().type.toBe<Machine.Snapshot<typeof States>>()
  })
  it("extracts schema-backed values from defined states and machines", () => {
    expect<Machine.Value<typeof States, "root.InSession">>().type.toBe<InSession>()
    expect<Machine.Value<typeof machine, "root.InSession">>().type.toBe<InSession>()
    // @ts-expect-error!
    type MissingPath = Machine.Value<typeof States, "root.Missing">
    // @ts-expect-error!
    type StructuralPath = Machine.Value<typeof States, "root.Idle">
  })
  it("extracts path-rooted snapshots including structural states", () => {
    expect<Machine.SnapshotAt<typeof States, "root">>().type.toBe<
      Machine.Machine.SnapshotByIdentifier<{
        readonly "": typeof States.node
      }, "root">
    >()
    expect<Machine.SnapshotAt<typeof machine, "root.Idle">>().type.toBe<
      Machine.Machine.SnapshotByIdentifier<{
        readonly "": typeof States.node
      }, "root.Idle">
    >()
    // @ts-expect-error!
    type MissingPath = Machine.SnapshotAt<typeof machine, "root.Missing">
  })
  it("separates decoded startup input from its schema", () => {
    expect<Machine.Machine.Input<typeof machine>>().type.toBe<typeof StartupInput.Type>()
    expect<Machine.Machine.InputSchema<typeof machine>>().type.toBe<typeof StartupInput>()
    expect<Machine.Machine.Input<typeof voidMachine>>().type.toBe<never>()
    expect<Machine.Machine.InputSchema<typeof voidMachine>>().type.toBe<typeof Schema.Void>()
  })
})
