import { Effect, Schema, Stream } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { AtomMachine } from "../../src/unstable/reactivity/index.js"

describe("machine reference event channels", () => {
  class Idle extends Schema.TaggedClass<Idle>("MachineReferencesIdle")("Idle", {}) {}
  class Ping extends Schema.TaggedClass<Ping>("MachineReferencesPing")("Ping", {}) {}
  class Local extends Schema.TaggedClass<Local>("MachineReferencesLocal")("Local", {}) {}
  class ParentNotice extends Schema.TaggedClass<ParentNotice>("MachineReferencesParentNotice")("ParentNotice", {
    value: Schema.Number
  }) {}
  class OtherParentEvent extends Schema.TaggedClass<OtherParentEvent>("MachineReferencesOtherParent")(
    "OtherParentEvent",
    {}
  ) {}
  class Published extends Schema.TaggedClass<Published>("MachineReferencesPublished")("Published", {}) {}
  class ValuedPublished extends Schema.TaggedClass<ValuedPublished>("MachineReferencesValuedPublished")(
    "ValuedPublished",
    { value: Schema.Number }
  ) {}

  const ParentEvents = Machine.events(ParentNotice)
  const Events = Machine.events(Ping)
  const InternalEvents = Machine.internalEvents(Local)
  const Emissions = Machine.emittedEvents(Published, ValuedPublished)
  const states = Machine.states({ Idle })
  const childMachine = Machine.make({
    states: states.states,
    events: Events,
    internalEvents: InternalEvents,
    parentEvents: ParentEvents,
    emittedEvents: Emissions,
    initial: {
      target: (to) => to.Idle(),
      resolve: ({ target }) => (target(new Idle({})))
    }
  }).handle({
    Idle: {
      on: {
        Ping: { target: Machine.targetless }
      }
    }
  })
  const Child = Machine.child("child", childMachine)

  it("types self, parent, raised events, and emissions as separate channels", () => {
    expect<Machine.MachineTarget<Ping>["send"]>().type.toBeCallableWith(new Ping({}))
    expect<Machine.MachineReferences<readonly [typeof Ping], readonly [typeof ParentNotice]>["self"]>().type.toBe<
      Machine.MachineTarget<Machine.Machine.EventInputOf<readonly [typeof Ping]>>
    >()
    expect<
      Machine.MachineReferences<readonly [typeof Ping], readonly [typeof ParentNotice]>["parent"]
    >().type.toBe<Machine.MachineTarget<Machine.Machine.EventInputOf<readonly [typeof ParentNotice]>> | undefined>()

    Machine.make({
      states: states.states,
      events: Events,
      internalEvents: InternalEvents,
      parentEvents: ParentEvents,
      emittedEvents: Emissions,
      initial: {
        target: (to) => to.Idle(),
        resolve: ({ target }) => (target(new Idle({})))
      }
    }).handle({
      Idle: {
        on: {
          Ping: (to) =>
            to.none().resolve(({ parent, self }, enqueue) => {
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
              return undefined
            })
        }
      }
    })
  })

  it("composes builder protocols and checks required parent inputs", () => {
    const compatible = Machine.make({
      states: states.states,
      events: Machine.events(Ping, ParentEvents),
      initial: {
        target: (to) => to.Idle(),
        resolve: ({ target }) => (target(new Idle({})))
      }
    })
    compatible.handle({
      Idle: { invoke: Machine.invoke({ child: Child }) }
    })

    const incompatible = Machine.make({
      states: states.states,
      events: Machine.events(Ping, OtherParentEvent),
      initial: {
        target: (to) => to.Idle(),
        resolve: ({ target }) => (target(new Idle({})))
      }
    })
    expect(incompatible.handle).type.not.toBeCallableWith({
      Idle: { invoke: Machine.invoke({ child: Child }) }
    })
  })

  it("infers emitted streams through MachineRef and AtomMachine", () => {
    const preparedEffect = Machine.prepare(childMachine)
    type Prepared = Effect.Success<typeof preparedEffect>
    expect<Prepared["emissions"]>().type.toBe<Stream.Stream<Published | ValuedPublished>>()
    expect<Prepared["changes"]>().type.toBe<
      Stream.Stream<
        Machine.RuntimeSnapshot<
          Machine.Machine.Snapshot<typeof states.states>,
          Machine.InfiniteTransitionError | Machine.MachineSchemaDecodeError | Machine.StoppedError
        >,
        | Machine.InfiniteTransitionError
        | Machine.MachineSchemaDecodeError
        | Machine.StartupError
        | Machine.StoppedError
      >
    >()

    const started = Machine.start(childMachine)
    type Ref = Effect.Success<typeof started>
    expect<Ref["emissions"]>().type.toBe<Stream.Stream<Published | ValuedPublished>>()

    const atom = AtomMachine.make(childMachine)
    const atomEmissions = AtomMachine.emissions(atom)
    expect<Stream.Success<typeof atomEmissions>>().type.toBe<Published | ValuedPublished>()
    expect<Stream.Services<typeof atomEmissions>>().type.toBe<AtomRegistry.AtomRegistry>()
  })

  it("contextually binds Machine.invoke self and parent references to the owning machine protocols", () => {
    Machine.make({
      states: states.states,
      events: Events,
      internalEvents: InternalEvents,
      parentEvents: ParentEvents,
      emittedEvents: Emissions,
      initial: {
        target: (to) => to.Idle(),
        resolve: ({ target }) => (target(new Idle({})))
      }
    }).handle({
      Idle: {
        invoke: Machine.invoke({
          id: "notify-parent",
          effect: ({ parent, self }) => {
            expect(self.send).type.toBeCallableWith(Events.Ping())
            expect(self.send).type.not.toBeCallableWith(InternalEvents.Local())
            expect(self.send).type.not.toBeCallableWith(ParentEvents.ParentNotice({ value: 1 }))
            if (parent !== undefined) {
              expect(parent.send).type.toBeCallableWith(ParentEvents.ParentNotice({ value: 1 }))
              expect(parent.send).type.not.toBeCallableWith(Events.Ping())
            }
            return Effect.void
          },
          onDone: (to) =>
            to.none().resolve(({ parent, self }, enqueue) => {
              enqueue.sendTo(self, Events.Ping())
              if (parent !== undefined) {
                enqueue.sendTo(parent, ParentEvents.ParentNotice({ value: 1 }))
                expect(enqueue.sendTo).type.not.toBeCallableWith(parent, Events.Ping())
              }
              return undefined
            })
        })
      }
    })

    Machine.make({
      states: states.states,
      events: Events,
      parentEvents: ParentEvents,
      initial: {
        target: (to) => to.Idle(),
        resolve: ({ target }) => target.from()
      }
    }).handle({
      Idle: {
        invoke: Machine.invoke({
          id: "notify-parent-failure",
          effect: () => Effect.fail("failed" as const),
          onFailure: (to) =>
            to.none().resolve(({ parent, self }, enqueue) => {
              enqueue.sendTo(self, Events.Ping())
              if (parent !== undefined) {
                enqueue.sendTo(parent, ParentEvents.ParentNotice({ value: 1 }))
                expect(enqueue.sendTo).type.not.toBeCallableWith(parent, Events.Ping())
              }
              return undefined
            })
        })
      }
    })
  })
})
