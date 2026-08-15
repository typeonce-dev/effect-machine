import { Effect, Schema, Stream } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { AtomMachine } from "../../src/unstable/reactivity/index.js"

describe("machine actor event channels", () => {
  class Idle extends Schema.TaggedClass<Idle>("ActorEventsIdle")("Idle", {}) {}
  class Ping extends Schema.TaggedClass<Ping>("ActorEventsPing")("Ping", {}) {}
  class Local extends Schema.TaggedClass<Local>("ActorEventsLocal")("Local", {}) {}
  class ParentNotice extends Schema.TaggedClass<ParentNotice>("ActorEventsParentNotice")("ParentNotice", {
    value: Schema.Number
  }) {}
  class OtherParentEvent extends Schema.TaggedClass<OtherParentEvent>("ActorEventsOtherParent")(
    "OtherParentEvent",
    {}
  ) {}
  class Published extends Schema.TaggedClass<Published>("ActorEventsPublished")("Published", {}) {}
  class ValuedPublished extends Schema.TaggedClass<ValuedPublished>("ActorEventsValuedPublished")(
    "ValuedPublished",
    { value: Schema.Number }
  ) {}

  const ParentEvents = Machine.events(ParentNotice)
  const Events = Machine.events(Ping)
  const InternalEvents = Machine.internalEvents(Local)
  const Emissions = Machine.emittedEvents(Published, ValuedPublished)
  const states = Machine.defineStates({ Idle })
  const childMachine = Machine.make({
    states: states.states,
    events: Events,
    internalEvents: InternalEvents,
    parentEvents: ParentEvents,
    emittedEvents: Emissions,
    initial: () => states.initial.Idle(new Idle({}))
  }).handle({
    Idle: {
      on: {
        Ping: ({ target }) => target.none()
      }
    }
  })
  const Child = Machine.child("child", childMachine)

  it("types self, parent, raised events, and emissions as separate channels", () => {
    Machine.make({
      states: states.states,
      events: Events,
      internalEvents: InternalEvents,
      parentEvents: ParentEvents,
      emittedEvents: Emissions,
      initial: () => states.initial.Idle(new Idle({}))
    }).handle({
      Idle: {
        on: {
          Ping: ({ parent, self, target }, enqueue) => {
            expect(self.send).type.toBeCallableWith(Events.Ping())
            expect(self.send).type.not.toBeCallableWith(InternalEvents.Local())
            expect(enqueue.sendTo).type.toBeCallableWith(self, Events.Ping())
            expect(enqueue.sendTo).type.not.toBeCallableWith(self, ParentEvents.ParentNotice({ value: 1 }))

            if (parent !== undefined) {
              expect(enqueue.sendTo).type.toBeCallableWith(parent, ParentEvents.ParentNotice({ value: 1 }))
              expect(enqueue.sendTo).type.not.toBeCallableWith(parent, Events.Ping())
            }

            expect(enqueue.raise).type.toBeCallableWith(InternalEvents.Local())
            expect(enqueue.emit).type.toBeCallableWith(Emissions.Published())
            expect(enqueue.emit).type.toBeCallableWith(Emissions.ValuedPublished({ value: 1 }))
            expect(enqueue.emit).type.not.toBeCallableWith(Events.Ping())
            return target.none()
          }
        }
      }
    })
  })

  it("composes builder protocols and checks required parent inputs", () => {
    const compatible = Machine.make({
      states: states.states,
      events: Machine.events(Ping, ParentEvents),
      initial: () => states.initial.Idle(new Idle({}))
    })
    compatible.handle({
      Idle: {
        invoke: {
          child: Child,
          onDone: () => states.initial.Idle(new Idle({})),
          onFailure: () => states.initial.Idle(new Idle({})),
          onSnapshot: () => states.initial.Idle(new Idle({}))
        }
      }
    })

    const incompatible = Machine.make({
      states: states.states,
      events: Machine.events(Ping, OtherParentEvent),
      initial: () => states.initial.Idle(new Idle({}))
    })
    expect(incompatible.handle).type.not.toBeCallableWith({
      Idle: {
        invoke: {
          child: Child,
          onDone: () => states.initial.Idle(new Idle({})),
          onFailure: () => states.initial.Idle(new Idle({})),
          onSnapshot: () => states.initial.Idle(new Idle({}))
        }
      }
    })
  })

  it("infers emitted streams through MachineRef and AtomMachine", () => {
    const started = Machine.start(childMachine)
    type Ref = Effect.Success<typeof started>
    expect<Ref["emissions"]>().type.toBe<Stream.Stream<Published | ValuedPublished>>()

    const atom = AtomMachine.make(childMachine)
    const atomEmissions = AtomMachine.emissions(atom)
    expect<Stream.Success<typeof atomEmissions>>().type.toBe<Published | ValuedPublished>()
    expect<Stream.Services<typeof atomEmissions>>().type.toBe<AtomRegistry.AtomRegistry>()
  })
})
