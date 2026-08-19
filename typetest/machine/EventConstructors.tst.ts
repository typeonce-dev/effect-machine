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

  const states = Machine.states({ Idle: {} })
  const events = Machine.events(PublicEvent, SetLabel, FiniteEvent)
  const internalEvents = Machine.internalEvents(InternalEvent)
  const machine = Machine.make({
    states: states.states,
    events,
    internalEvents,
    initial: (to) => to.Idle().resolve(({ target }) => (target.from()))
  })

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
    expect<Machine.EventOf<typeof events>>().type.toBe<
      typeof PublicEvent.Type | SetLabel | typeof FiniteEvent.Type
    >()
    expect(machine.events).type.toBe<typeof events>()
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
    expect(machine.internalEvents).type.toBe<typeof internalEvents>()
  })

  it("keeps public and internal protocol descriptors nominally separate", () => {
    expect(Machine.make).type.not.toBeCallableWith({
      states: states.states,
      events: internalEvents,
      initial: (to: Machine.Machine.InitialSelector<typeof states.states>) => to.Idle()
    })
    expect(Machine.make).type.not.toBeCallableWith({
      states: states.states,
      events,
      internalEvents: events,
      initial: (to: Machine.Machine.InitialSelector<typeof states.states>) => to.Idle()
    })

    const Reset = Schema.TaggedStruct("Reset", {})
    expect(Machine.events).type.not.toBeCallableWith(Reset, PublicEvent)
  })

  it("keeps open discriminator schemas in the protocol without inventing constructor keys", () => {
    const OpenEvent = Schema.Struct({ _tag: Schema.String, value: Schema.Number })
    const openEvents = Machine.events(OpenEvent)
    const openMachine = Machine.make({
      states: states.states,
      events: openEvents,
      initial: (to) => to.Idle().resolve(({ target }) => (target.from()))
    })

    expect(openEvents.Dynamic).type.toRaiseError()
    expect<Machine.Machine.InputEvent<typeof openMachine>>().type.toBe<typeof OpenEvent.Type>()
  })

  it("accepts public constructions at machine delivery boundaries", () => {
    expect(Machine.plan(machine.handle({ Idle: {} }), { path: "Idle", value: undefined }, events.Reset())).type.not
      .toRaiseError()
  })

  it("accepts internal constructions raised from invocation handlers", () => {
    expect(
      machine.handle({
        Idle: {
          invoke: [
            Machine.invoke({
              id: "load",
              effect: () => Effect.succeed("ready"),
              onDone: (to) =>
                to.none.resolve(({ output }, enqueue) => {
                  enqueue.raise(internalEvents.Loaded({ value: output }))
                  return undefined
                })
            }),
            Machine.invoke({
              id: "timeout",
              after: "1 second",
              onDone: (to) =>
                to.none.resolve((_, enqueue) => {
                  enqueue.raise(internalEvents.Failed())
                  return undefined
                })
            })
          ]
        }
      })
    ).type.not.toRaiseError()
  })
})
