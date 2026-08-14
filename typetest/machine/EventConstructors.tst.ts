import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

describe("Machine event constructor collections", () => {
  const PublicEvent = Schema.TaggedUnion({
    Increment: { by: Schema.Number },
    Reset: {}
  })

  class SetLabel extends Schema.TaggedClass<SetLabel>("SetLabel")("SetLabel", {
    id: Schema.String,
    label: Schema.String.pipe(
      Schema.optionalKey,
      Schema.withConstructorDefault(Effect.succeed("default-label"))
    )
  }) {}

  const InternalEvent = Schema.TaggedUnion({
    Loaded: { value: Schema.String },
    Failed: {}
  })

  const FiniteEvent = Schema.Struct({
    _tag: Schema.Union([Schema.Literal("Alpha"), Schema.Literal("Beta")]),
    value: Schema.String
  })

  const states = Machine.defineStates({ Idle: {} })
  const machine = Machine.make({
    states: states.states,
    events: [PublicEvent, SetLabel, FiniteEvent],
    internalEvents: [InternalEvent],
    initial: () => states.initial.Idle.from()
  })

  const events = Machine.events(machine)
  const internalEvents = Machine.internalEvents(machine)

  it("derives public constructors and their schema make inputs", () => {
    expect(events.Increment({ by: 1 })).type.toBe<
      Machine.Machine.EventConstruction<typeof PublicEvent.cases.Increment.Type>
    >()
    expect(events.Reset()).type.toBe<Machine.Machine.EventConstruction<typeof PublicEvent.cases.Reset.Type>>()
    expect(events.SetLabel({ id: "label-1" })).type.toBe<Machine.Machine.EventConstruction<SetLabel>>()
    expect(events.Alpha({ value: "alpha" })).type.toBe<
      Machine.Machine.EventConstruction<{ readonly _tag: "Alpha"; readonly value: string }>
    >()

    expect(events.Increment()).type.toRaiseError()
    expect(events.Increment({ by: "1" })).type.toRaiseError()
    expect(events.SetLabel({})).type.toRaiseError()
    expect(events.Alpha({ _tag: "Beta", value: "alpha" })).type.toRaiseError()
    expect(events.Loaded).type.toRaiseError()
  })

  it("keeps internal constructors separate from public constructors", () => {
    expect(internalEvents.Loaded({ value: "ready" })).type.toBe<
      Machine.Machine.EventConstruction<typeof InternalEvent.cases.Loaded.Type>
    >()
    expect(internalEvents.Failed()).type.toBe<
      Machine.Machine.EventConstruction<typeof InternalEvent.cases.Failed.Type>
    >()

    expect(internalEvents.Increment).type.toRaiseError()
    expect(internalEvents.Loaded()).type.toRaiseError()
  })

  it("accepts public constructions at machine delivery boundaries", () => {
    expect(Machine.plan(machine.handle({ Idle: {} }), { path: "Idle", value: undefined }, events.Reset())).type.not
      .toRaiseError()
  })

  it("accepts internal constructions from invokeEffect and after", () => {
    expect(
      machine.handle({
        Idle: {
          invoke: [
            Machine.invokeEffect({
              id: "load",
              effect: Effect.succeed("ready"),
              onSuccess: (value) => internalEvents.Loaded({ value })
            }),
            Machine.after("1 second", internalEvents.Failed())
          ]
        }
      })
    ).type.not.toRaiseError()
  })
})
