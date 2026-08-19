import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class InSession extends Schema.TaggedClass<InSession>("ConsumerTypesInSession")("InSession", {
  offerId: Schema.String,
  role: Schema.Literals(["offerer", "proposer"])
}) {}

const States = Machine.states({
  root: {
    initial: "Idle",
    states: {
      Idle: {},
      InSession
    }
  }
})

const StartupInput = Schema.Struct({
  offerId: Schema.String,
  role: Schema.Literals(["offerer", "proposer"])
})

const definition = Machine.make({
  states: States.states,
  events: Machine.events(),
  input: StartupInput,
  initial: (to) =>
    to.root.initial.resolve(({ input, target }) => {
      expect(input).type.toBe<typeof StartupInput.Type>()
      return target.from((root) => root.Idle.from())
    })
})

const machine = definition.handle({
  root: {
    states: {
      Idle: {},
      InSession: {}
    }
  }
})

const voidMachine = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: (to) => to.root.initial.resolve(({ target }) => target.from((root) => root.Idle.from()))
})

describe("consumer type extractors", () => {
  it("extracts complete snapshots from defined states and machines", () => {
    expect<Machine.Snapshot<typeof States>>().type.toBe<Machine.Machine.Snapshot<typeof States.states>>()
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
      Machine.Machine.SnapshotByIdentifier<typeof States.states, "root">
    >()
    expect<Machine.SnapshotAt<typeof machine, "root.Idle">>().type.toBe<
      Machine.Machine.SnapshotByIdentifier<typeof States.states, "root.Idle">
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
