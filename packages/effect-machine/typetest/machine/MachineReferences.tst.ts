import { Effect, Schema, Stream } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"
import { ClusterMachine } from "../../src/unstable/cluster/index.js"
import { AtomMachine } from "../../src/unstable/reactivity/index.js"
describe("machine reference event channels", () => {
  class Idle extends Schema.TaggedClass<Idle>("MachineReferencesIdle")("Idle", {}) {
  }
  class Ping extends Schema.TaggedClass<Ping>("MachineReferencesPing")("Ping", {}) {
  }
  class Local extends Schema.TaggedClass<Local>("MachineReferencesLocal")("Local", {}) {
  }
  class ParentNotice extends Schema.TaggedClass<ParentNotice>("MachineReferencesParentNotice")("ParentNotice", {
    value: Schema.Number
  }) {
  }
  class OtherParentEvent
    extends Schema.TaggedClass<OtherParentEvent>("MachineReferencesOtherParent")("OtherParentEvent", {})
  {
  }
  class Published extends Schema.TaggedClass<Published>("MachineReferencesPublished")("Published", {}) {
  }
  class ValuedPublished
    extends Schema.TaggedClass<ValuedPublished>("MachineReferencesValuedPublished")("ValuedPublished", {
      value: Schema.Number
    })
  {
  }
  const ParentEvents = Machine.eventsFromSchemas(ParentNotice)
  const Events = Machine.eventsFromSchemas(Ping)
  const InternalEvents = Machine.internalEventsFromSchemas(Local)
  const Emissions = Machine.emittedEventsFromSchemas(Published, ValuedPublished)
  const states = Machine.state({ states: { Idle } })
  const childMachine = Machine.make({
    root: states,
    events: Events,
    internalEvents: InternalEvents,
    parent: Machine.optionalParent(ParentEvents),
    emittedEvents: Emissions
  }).handle({
    initial: {
      target: Machine.targets(states).root.Idle,
      decoded: true,
      data: new Idle({})
    },
    states: {
      Idle: {
        on: {
          Ping: { none: true }
        }
      }
    }
  })
  const Child = Machine.child("child", childMachine)
  it("types self, parent, raised events, and emissions as separate channels", () => {
    expect<Machine.MachineTarget<Ping>["send"]>().type.toBeCallableWith(new Ping({}))
    expect<
      Machine.MachineReferences<
        readonly [
          typeof Ping
        ],
        readonly [
          typeof ParentNotice
        ]
      >["self"]
    >().type.toBe<
      Machine.MachineTarget<
        Machine.Machine.EventInputOf<
          readonly [
            typeof Ping
          ]
        >
      >
    >()
    expect<
      Machine.MachineReferences<
        readonly [
          typeof Ping
        ],
        readonly [
          typeof ParentNotice
        ]
      >["parent"]
    >().type.toBe<
      Machine.MachineTarget<
        Machine.Machine.EventInputOf<
          readonly [
            typeof ParentNotice
          ]
        >
      > | undefined
    >()
    expect<
      keyof Machine.MachineReferences<
        readonly [
          typeof Ping
        ],
        readonly []
      >
    >().type.toBe<"self">()
    expect(Machine.parent).type.not.toBeCallableWith(InternalEvents)
    expect(Machine.optionalParent).type.not.toBeCallableWith(InternalEvents)
    const independentMachine = Machine.make({
      root: states,
      events: Events
    }).handle({
      initial: {
        target: Machine.targets(states).root.Idle,
        decoded: true,
        data: new Idle({})
      },
      states: {
        Idle: {
          on: {
            Ping: {
              none: true,
              resolve: (context) => {
                expect<"parent">().type.not.toBeAssignableTo<keyof typeof context>()
                return undefined
              }
            }
          }
        }
      }
    })
    expect(independentMachine.parent).type.toBe<undefined>()
    Machine.make({
      root: states,
      events: Events,
      internalEvents: InternalEvents,
      parent: Machine.optionalParent(ParentEvents),
      emittedEvents: Emissions
    }).handle({
      initial: {
        target: Machine.targets(states).root.Idle,
        decoded: true,
        data: new Idle({})
      },
      states: {
        Idle: {
          on: {
            Ping: {
              none: true,
              resolve: ({ parent, self }, enqueue) => {
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
              }
            }
          }
        }
      }
    })
  })
  it("composes builder protocols and checks required parent inputs", () => {
    const compatible = Machine.make({
      children: { source1: Child },
      root: states,
      events: Machine.eventsFromSchemas(Ping, ParentEvents)
    })
    compatible.handle({
      initial: {
        target: Machine.targets(states).root.Idle,
        decoded: true,
        data: new Idle({})
      },
      states: { Idle: { invoke: { src: "source1" } } }
    })
    const incompatible = Machine.make({
      children: { worker: Child },
      root: states,
      events: Machine.eventsFromSchemas(Ping, OtherParentEvent)
    })
    expect(incompatible.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(states).root.Idle,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(incompatible.handle).type.not.toBeCallableWith({
      states: { Idle: { invoke: { src: "worker" } } },
      initial: {
        target: Machine.targets(states).root.Idle,
        data: () => {
          throw new Error("type-only constructor")
        }
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
          Machine.Snapshot<typeof states>,
          Machine.InfiniteTransitionError | Machine.MachineSchemaDecodeError | Machine.StoppedError
        >,
        Machine.InfiniteTransitionError | Machine.MachineSchemaDecodeError | Machine.StartupError | Machine.StoppedError
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
      effects: {
        source1: ({ parent, self }: Machine.Machine.InvokeContext<
          {
            readonly "": {
              readonly initial: "Idle"
              readonly states: {
                readonly Idle: typeof Idle
              }
            } & {
              readonly "~effect/Machine/ExplicitInitial": true
            }
          },
          readonly [
            typeof Ping,
            typeof Local
          ],
          readonly [
            typeof Published,
            typeof ValuedPublished
          ],
          "Idle",
          readonly [
            typeof Ping
          ],
          Machine.Machine.ParentEventSchemas<
            "required",
            readonly [
              typeof ParentNotice
            ]
          >
        >) => {
          expect(self.send).type.toBeCallableWith(Events.Ping())
          expect(self.send).type.not.toBeCallableWith(InternalEvents.Local())
          expect(self.send).type.not.toBeCallableWith(ParentEvents.ParentNotice({ value: 1 }))
          expect(parent.send).type.toBeCallableWith(ParentEvents.ParentNotice({ value: 1 }))
          expect(parent.send).type.not.toBeCallableWith(Events.Ping())
          return Effect.void
        }
      },
      root: states,
      events: Events,
      internalEvents: InternalEvents,
      parent: Machine.parent(ParentEvents),
      emittedEvents: Emissions
    }).handle({
      initial: {
        target: Machine.targets(states).root.Idle,
        decoded: true,
        data: new Idle({})
      },
      states: {
        Idle: {
          invoke: {
            src: "source1",
            id: "notify-parent",
            input: (context) => context,
            onDone: {
              none: true,
              resolve: ({ parent, self }, enqueue) => {
                enqueue.sendTo(self, Events.Ping())
                enqueue.sendTo(parent, ParentEvents.ParentNotice({ value: 1 }))
                expect(enqueue.sendTo).type.not.toBeCallableWith(parent, Events.Ping())
                return undefined
              }
            }
          }
        }
      }
    })
    const requiredParentMachine = Machine.make({
      effects: { source1: Effect.suspend(() => Effect.fail("failed" as const)) },
      root: states,
      events: Events,
      parent: Machine.parent(ParentEvents)
    }).handle({
      initial: {
        target: Machine.targets(states).root.Idle,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        Idle: {
          invoke: {
            src: "source1",
            id: "notify-parent-failure",
            onFailure: {
              none: true,
              resolve: ({ parent, self }, enqueue) => {
                enqueue.sendTo(self, Events.Ping())
                enqueue.sendTo(parent, ParentEvents.ParentNotice({ value: 1 }))
                expect(enqueue.sendTo).type.not.toBeCallableWith(parent, Events.Ping())
                return undefined
              }
            }
          }
        }
      }
    })
    expect(Machine.start).type.not.toBeCallableWith(requiredParentMachine)
    expect(Machine.prepare).type.not.toBeCallableWith(requiredParentMachine)
    expect(Machine.planInitial).type.not.toBeCallableWith(requiredParentMachine)
    expect(Machine.plan).type.not.toBeCallableWith(
      requiredParentMachine,
      null as unknown as Machine.Snapshot<typeof states>,
      Events.Ping()
    )
    expect(Machine.can).type.not.toBeCallableWith(requiredParentMachine)
    expect(Machine.can).type.not.toBeCallableWith(
      requiredParentMachine,
      null as unknown as Machine.Snapshot<typeof states>,
      Events.Ping()
    )
    expect(Machine.resume).type.not.toBeCallableWith(
      requiredParentMachine,
      null as unknown as Machine.Snapshot<typeof states>
    )
    expect(AtomMachine.make).type.not.toBeCallableWith(requiredParentMachine)
    expect(AtomMachine.factory).type.not.toBeCallableWith(requiredParentMachine)
    expect(AtomMachine.resume).type.not.toBeCallableWith(
      requiredParentMachine,
      null as unknown as Machine.Snapshot<typeof states>
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
