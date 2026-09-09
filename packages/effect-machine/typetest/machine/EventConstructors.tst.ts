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
    label: Schema.String.pipe(Schema.optionalKey, Schema.withConstructorDefault(Effect.succeed("default-label")))
  }) {
  }
  const InternalEvent = Schema.TaggedUnion({
    Loaded: { value: Schema.String },
    Failed: {}
  })
  const FiniteEvent = Schema.Struct({
    _tag: Schema.Union([Schema.Literal("Alpha"), Schema.Literal("Beta")]),
    value: Schema.String
  })
  const states = Machine.state({ states: { Idle: {} } })
  const events = Machine.eventsFromSchemas(PublicEvent, SetLabel, FiniteEvent)
  const internalEvents = Machine.internalEventsFromSchemas(InternalEvent)
  const machine = Machine.make({
    effects: { source1: Effect.suspend(() => Effect.succeed("ready")) },
    timers: { source2: "1 second" },
    root: states,
    events,
    internalEvents
  })
  it("derives public constructors and their schema make inputs", () => {
    expect(events.Increment({ by: 1 })).type.toBe<
      Machine.Machine.EventConstruction<typeof PublicEvent.cases.Increment.Type>
    >()
    expect(events.Reset()).type.toBe<Machine.Machine.EventConstruction<typeof PublicEvent.cases.Reset.Type>>()
    expect(events.SetLabel({ id: "label-1" })).type.toBe<Machine.Machine.EventConstruction<SetLabel>>()
    expect(events.Alpha({ value: "alpha" })).type.toBe<
      Machine.Machine.EventConstruction<{
        readonly _tag: "Alpha"
        readonly value: string
      }>
    >()
    expect(events.Increment()).type.toRaiseError()
    expect(events.Increment({ by: "1" })).type.toRaiseError()
    expect(events.SetLabel({})).type.toRaiseError()
    expect(events.Alpha({ _tag: "Beta", value: "alpha" })).type.toRaiseError()
    expect(events.Loaded).type.toRaiseError()
    expect<Machine.EventOf<typeof events>>().type.toBe<typeof PublicEvent.Type | SetLabel | typeof FiniteEvent.Type>()
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
      root: states,
      events: internalEvents
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root: states,
      events,
      internalEvents: events
    })
    const Reset = Schema.TaggedStruct("Reset", {})
    expect(Machine.events).type.not.toBeCallableWith(Reset, PublicEvent)
  })
  it("keeps open discriminator schemas in the protocol without inventing constructor keys", () => {
    const OpenEvent = Schema.Struct({ _tag: Schema.String, value: Schema.Number })
    const openEvents = Machine.eventsFromSchemas(OpenEvent)
    const openMachine = Machine.make({
      root: states,
      events: openEvents
    }).handle({
      initial: {
        target: Machine.targets(states).root.Idle
      },
      states: { Idle: {} }
    })
    expect(openEvents.Dynamic).type.toRaiseError()
    expect<Machine.Machine.InputEvent<typeof openMachine>>().type.toBe<typeof OpenEvent.Type>()
  })
  it("accepts public constructions at machine delivery boundaries", () => {
    expect(Machine.plan(
      machine.handle({
        initial: {
          target: Machine.targets(states).root.Idle
        },
        states: { Idle: {} }
      }),
      {
        path: "",
        value: undefined,
        state: { path: "Idle", value: undefined }
      },
      events.Reset()
    )).type.not
      .toRaiseError()
  })
  it("accepts internal constructions raised from invocation handlers", () => {
    expect(machine.handle({
      initial: {
        target: Machine.targets(states).root.Idle
      },
      states: {
        Idle: {
          invoke: [{
            src: "source1",
            id: "load",
            onDone: {
              none: true,
              resolve: ({ output }, enqueue) => {
                enqueue.raise(internalEvents.Loaded({ value: output }))
                return undefined
              }
            }
          }, {
            src: "source2",
            id: "timeout",
            onDone: {
              none: true,
              resolve: (_, enqueue) => {
                enqueue.raise(internalEvents.Failed())
                return undefined
              }
            }
          }]
        }
      }
    })).type.not.toRaiseError()
  })
})
