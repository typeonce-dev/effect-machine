import { Effect, Schema, Stream } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"
import { ClusterMachine } from "../../src/unstable/cluster/index.js"
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
    parent: Machine.optionalParent(ParentEvents),
    emittedEvents: Emissions,
    initial: (to) => to.Idle().resolve(({ target }) => (target.decoded(new Idle({}))))
  }).handle({
    Idle: {
      on: {
        Ping: (to) => to.none
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
    expect<keyof Machine.MachineReferences<readonly [typeof Ping], readonly []>>().type.toBe<"self">()
    expect(Machine.parent).type.not.toBeCallableWith(InternalEvents)
    expect(Machine.optionalParent).type.not.toBeCallableWith(InternalEvents)

    const independentMachine = Machine.make({
      states: states.states,
      events: Events,
      initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new Idle({})))
    }).handle({
      Idle: {
        on: {
          Ping: (to) =>
            to.none.resolve((context) => {
              expect<"parent">().type.not.toBeAssignableTo<keyof typeof context>()
              return undefined
            })
        }
      }
    })
    expect(independentMachine.parent).type.toBe<undefined>()

    Machine.make({
      states: states.states,
      events: Events,
      internalEvents: InternalEvents,
      parent: Machine.optionalParent(ParentEvents),
      emittedEvents: Emissions,
      initial: (to) => to.Idle().resolve(({ target }) => (target.decoded(new Idle({}))))
    }).handle({
      Idle: {
        on: {
          Ping: (to) =>
            to.none.resolve(({ parent, self }, enqueue) => {
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
      initial: (to) => to.Idle().resolve(({ target }) => (target.decoded(new Idle({}))))
    })
    compatible.handle({
      Idle: { invoke: (from) => from.child(Child) }
    })

    const incompatible = Machine.make({
      states: states.states,
      events: Machine.events(Ping, OtherParentEvent),
      initial: (to) => to.Idle().resolve(({ target }) => (target.decoded(new Idle({}))))
    })
    expect(incompatible.handle).type.not.toBeCallableWith({
      Idle: {
        invoke: (
          from: Machine.Machine.InvokeSelector<
            typeof states.states,
            readonly [typeof Ping, typeof OtherParentEvent],
            readonly [],
            "Idle"
          >
        ) => from.child(Child)
      }
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

  it("contextually binds invocation self and parent references to the owning machine protocols", () => {
    Machine.make({
      states: states.states,
      events: Events,
      internalEvents: InternalEvents,
      parent: Machine.parent(ParentEvents),
      emittedEvents: Emissions,
      initial: (to) => to.Idle().resolve(({ target }) => (target.decoded(new Idle({}))))
    }).handle({
      Idle: {
        invoke: (from) =>
          from.effect("notify-parent", ({ parent, self }) => {
            expect(self.send).type.toBeCallableWith(Events.Ping())
            expect(self.send).type.not.toBeCallableWith(InternalEvents.Local())
            expect(self.send).type.not.toBeCallableWith(ParentEvents.ParentNotice({ value: 1 }))
            expect(parent.send).type.toBeCallableWith(ParentEvents.ParentNotice({ value: 1 }))
            expect(parent.send).type.not.toBeCallableWith(Events.Ping())
            return Effect.void
          }).onDone((to) =>
            to.none.resolve(({ parent, self }, enqueue) => {
              enqueue.sendTo(self, Events.Ping())
              enqueue.sendTo(parent, ParentEvents.ParentNotice({ value: 1 }))
              expect(enqueue.sendTo).type.not.toBeCallableWith(parent, Events.Ping())
              return undefined
            })
          )
      }
    })

    const requiredParentMachine = Machine.make({
      states: states.states,
      events: Events,
      parent: Machine.parent(ParentEvents),
      initial: (to) => to.Idle().resolve(({ target }) => target.from())
    }).handle({
      Idle: {
        invoke: (from) =>
          from.effect("notify-parent-failure", () => Effect.fail("failed" as const)).onFailure((to) =>
            to.none.resolve(({ parent, self }, enqueue) => {
              enqueue.sendTo(self, Events.Ping())
              enqueue.sendTo(parent, ParentEvents.ParentNotice({ value: 1 }))
              expect(enqueue.sendTo).type.not.toBeCallableWith(parent, Events.Ping())
              return undefined
            })
          )
      }
    })

    expect(Machine.start).type.not.toBeCallableWith(requiredParentMachine)
    expect(Machine.prepare).type.not.toBeCallableWith(requiredParentMachine)
    expect(Machine.planInitial).type.not.toBeCallableWith(requiredParentMachine)
    expect(Machine.plan).type.not.toBeCallableWith(
      requiredParentMachine,
      null as unknown as Machine.Machine.Snapshot<typeof states.states>,
      Events.Ping()
    )
    expect(Machine.can).type.not.toBeCallableWith(requiredParentMachine)
    expect(Machine.can).type.not.toBeCallableWith(
      requiredParentMachine,
      null as unknown as Machine.Machine.Snapshot<typeof states.states>,
      Events.Ping()
    )
    expect(Machine.resume).type.not.toBeCallableWith(
      requiredParentMachine,
      null as unknown as Machine.Machine.Snapshot<typeof states.states>
    )
    expect(AtomMachine.make).type.not.toBeCallableWith(requiredParentMachine)
    expect(AtomMachine.factory).type.not.toBeCallableWith(requiredParentMachine)
    expect(AtomMachine.resume).type.not.toBeCallableWith(
      requiredParentMachine,
      null as unknown as Machine.Machine.Snapshot<typeof states.states>
    )
    expect(ClusterMachine.make).type.not.toBeCallableWith("RequiredParent", requiredParentMachine, { version: "1" })
    expect(MachineTest.run).type.not.toBeCallableWith(requiredParentMachine, { events: [] })
    expect(MachineTest.explore).type.not.toBeCallableWith(requiredParentMachine, {
      events: () => [],
      stateKey: () => "idle"
    })
    expect<Machine.Machine.ParentAvailability<typeof requiredParentMachine>>().type.toBe<"required">()
    expect<Machine.Machine.ParentAvailability<typeof childMachine>>().type.toBe<"optional">()
    expect(requiredParentMachine.parent.mode).type.toBe<"required">()
    expect(childMachine.parent.mode).type.toBe<"optional">()
  })
})
