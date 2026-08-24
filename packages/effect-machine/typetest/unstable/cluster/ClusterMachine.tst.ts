import { Context, Effect, type Layer, Option, Schema, SchemaGetter } from "effect"
import { type MessageStorage, type Sharding } from "effect/unstable/cluster"
import type { Rpc, RpcGroup } from "effect/unstable/rpc"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../../src/index.js"
import { ClusterMachine } from "../../../src/unstable/cluster/index.js"

describe("ClusterMachine", () => {
  class Count extends Schema.TaggedClass<Count>("Count")("Count", {
    value: Schema.Number
  }) {}

  class Increment extends Schema.TaggedClass<Increment>("Increment")("Increment", {
    by: Schema.Number
  }) {}

  class Reset extends Schema.TaggedClass<Reset>("Reset")("Reset", {}) {}

  class Done extends Schema.TaggedClass<Done>("Done")("Done", {
    value: Schema.String
  }) {}

  class Input extends Schema.Class<Input>("Input")({
    value: Schema.Number
  }) {}

  interface LocalResource {
    readonly close: () => void
  }

  const LocalResource = Schema.declare<LocalResource>((value): value is LocalResource =>
    typeof value === "object" && value !== null && "close" in value && typeof value.close === "function"
  )

  class ResourceState extends Schema.TaggedClass<ResourceState>("ResourceState")("ResourceState", {
    resource: LocalResource
  }) {}

  class ResourceEvent extends Schema.TaggedClass<ResourceEvent>("ResourceEvent")("ResourceEvent", {
    resource: LocalResource
  }) {}

  class UnknownEvent extends Schema.TaggedClass<UnknownEvent>("UnknownEvent")("UnknownEvent", {
    payload: Schema.Unknown
  }) {}

  class Scheduled extends Schema.TaggedClass<Scheduled>("Scheduled")("Scheduled", {
    at: Schema.Date
  }) {}

  class PlanningService extends Context.Service<PlanningService, {
    readonly value: number
  }>()("test/ClusterMachine/PlanningService") {}

  class ActionService extends Context.Service<ActionService, {
    readonly run: Effect.Effect<void>
  }>()("test/ClusterMachine/ActionService") {}

  class SnapshotDecoding extends Context.Service<SnapshotDecoding, number>()(
    "test/ClusterMachine/SnapshotDecoding"
  ) {}

  class SnapshotEncoding extends Context.Service<SnapshotEncoding, number>()(
    "test/ClusterMachine/SnapshotEncoding"
  ) {}

  const states = Machine.states({ Count })

  const machine = Machine.make({
    id: "Counter",
    states: states.states,
    events: Machine.events(Increment, Reset),
    initial: (to) => to.Count().resolve(({ target }) => (target.decoded(new Count({ value: 0 }))))
  }).handle({
    Count: {
      on: {
        Increment: (to) =>
          to.full.Count().resolve(({ event, state, target }) =>
            target.decoded(new Count({ value: state.value + event.by }))
          ),
        Reset: (to) => to.full.Count().resolve(({ target }) => target.decoded(new Count({ value: 0 })))
      }
    }
  })

  const bridge = ClusterMachine.make("CounterEntity", machine, { version: "1" })

  it("preserves the machine event union in the send RPC", () => {
    type Rpcs = RpcGroup.Rpcs<typeof bridge.entity.protocol>
    expect<Rpc.Payload<Rpcs>>().type.toBe<Increment | Reset>()
    expect<Rpc.Success<Rpcs>>().type.toBe<ClusterMachine.Accepted | ClusterMachine.Rejected>()

    const internalMachine = Machine.make({
      states: states.states,
      events: Machine.events(Increment),
      internalEvents: Machine.internalEvents(Reset),
      initial: (to) => to.Count().resolve(({ target }) => (target.decoded(new Count({ value: 0 }))))
    })
    const internalBridge = ClusterMachine.make("InternalCounterEntity", internalMachine, {
      version: "1"
    })
    type InternalRpcs = RpcGroup.Rpcs<typeof internalBridge.entity.protocol>
    expect<Rpc.Payload<InternalRpcs>>().type.toBe<Increment>()
  })

  it("retains Cluster service requirements", () => {
    const layer = bridge.toLayer()
    expect<Layer.Services<typeof layer>>().type.toBe<
      ClusterMachine.Storage | MessageStorage.MessageStorage | Sharding.Sharding
    >()
  })

  it("captures non-void machine input", () => {
    const inputMachine = Machine.make({
      id: "InputCounter",
      states: states.states,
      events: Machine.events(Reset),
      input: Input,
      initial: (to) =>
        to.Count().resolve(({ input: input, target }) => (target.decoded(new Count({ value: input.value }))))
    })

    expect(ClusterMachine.make).type.not.toBeCallableWith(
      "InputCounterEntity",
      inputMachine,
      { version: "1" }
    )
    expect(ClusterMachine.make).type.toBeCallableWith(
      "InputCounterEntity",
      inputMachine,
      { version: "1" },
      new Input({ value: 1 })
    )
  })

  it("uses encoded Machine snapshots in checkpoints", () => {
    expect<ClusterMachine.Checkpoint["snapshot"]>().type.toBe<Machine.Machine.EncodedSnapshot>()
    expect<Machine.Machine.EncodedSnapshotState["value"]>().type.toBe<Schema.Json | undefined>()
    expect<Machine.Machine.EncodedSnapshotCompletion["output"]>().type.toBe<Schema.Json | undefined>()
    expect<Machine.Machine.EncodedSnapshotHistoryEntry["values"]>().type.toBe<
      Readonly<Record<string, Schema.Json>>
    >()
  })

  it("requires JSON-encoded state, output, and public input schemas", () => {
    const resourceStates = Machine.states({ ResourceState })
    const resourceMachine = Machine.make({
      states: resourceStates.states,
      events: Machine.events(ResourceEvent),
      initial: (to) =>
        to.ResourceState().resolve(({ target }) => target.decoded(new ResourceState({ resource: { close() {} } })))
    })

    expect(ClusterMachine.make).type.not.toBeCallableWith(
      "ResourceEntity",
      resourceMachine,
      { version: "1" }
    )

    const unknownEventMachine = Machine.make({
      states: states.states,
      events: Machine.events(UnknownEvent),
      initial: (to) => to.Count().resolve(({ target }) => target.decoded(new Count({ value: 0 })))
    })

    expect(ClusterMachine.make).type.not.toBeCallableWith(
      "UnknownEventEntity",
      unknownEventMachine,
      { version: "1" }
    )

    const anyOutputStates = Machine.states({
      Done: { schema: Done, type: "final", output: Schema.Any }
    })
    const anyOutputMachine = Machine.make({
      states: anyOutputStates.states,
      events: Machine.events(Reset),
      initial: (to) => to.Done().resolve(({ target }) => target.decoded(new Done({ value: "done" })))
    }).handle({
      Done: { output: () => null }
    })

    expect(ClusterMachine.make).type.not.toBeCallableWith(
      "AnyOutputEntity",
      anyOutputMachine,
      { version: "1" }
    )

    const neverOutputStates = Machine.states({
      Done: { schema: Done, type: "final", output: Schema.Never }
    })
    const neverOutputMachine = Machine.make({
      states: neverOutputStates.states,
      events: Machine.events(Reset),
      initial: (to) => to.Done().resolve(({ target }) => target.decoded(new Done({ value: "done" })))
    }).handle({
      Done: {
        output: () => {
          throw new Error("unreachable")
        }
      }
    })

    expect(ClusterMachine.make).type.not.toBeCallableWith(
      "NeverOutputEntity",
      neverOutputMachine,
      { version: "1" }
    )

    const scheduledStates = Machine.states({ Scheduled: Schema.toCodecJson(Scheduled) })
    const scheduledMachine = Machine.make({
      states: scheduledStates.states,
      events: Machine.events(Reset),
      initial: (to) =>
        to.Scheduled().resolve(({ target }) => target.decoded(new Scheduled({ at: new Date("2026-08-19") })))
    })

    expect(ClusterMachine.make).type.toBeCallableWith(
      "ScheduledEntity",
      scheduledMachine,
      { version: "1" }
    )

    const internalResourceMachine = Machine.make({
      states: states.states,
      events: Machine.events(Reset),
      internalEvents: Machine.internalEvents(ResourceEvent),
      initial: (to) => to.Count().resolve(({ target }) => target.decoded(new Count({ value: 0 })))
    })

    expect(ClusterMachine.make).type.toBeCallableWith(
      "InternalResourceEntity",
      internalResourceMachine,
      { version: "1" }
    )
  })

  it("requires declared output implementations", () => {
    const outputStates = Machine.states({
      Done: {
        schema: Done,
        type: "final",
        output: Schema.String
      }
    })
    const incomplete = Machine.make({
      states: outputStates.states,
      events: Machine.events(Reset),
      initial: (to) => to.Done().resolve(({ target }) => (target.decoded(new Done({ value: "done" }))))
    })

    expect(ClusterMachine.make).type.not.toBeCallableWith(
      "Incomplete",
      incomplete,
      { version: "1" }
    )

    const complete = incomplete.handle({
      Done: {
        output: ({ state }) => state.value
      }
    })
    expect(ClusterMachine.make).type.toBeCallableWith(
      "Complete",
      complete,
      { version: "1" }
    )
  })

  it("retains snapshot codec service requirements", () => {
    const ContextualNumber = Schema.Number.pipe(
      Schema.decode({
        decode: SchemaGetter.onSome((value) => Effect.as(SnapshotDecoding, Option.some(value))),
        encode: SchemaGetter.passthrough()
      }),
      Schema.encode({
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.onSome((value) => Effect.as(SnapshotEncoding, Option.some(value)))
      })
    )
    class ContextualCount extends Schema.TaggedClass<ContextualCount>("ContextualCount")("ContextualCount", {
      value: ContextualNumber
    }) {}
    const contextualStates = Machine.states({ ContextualCount })
    const contextualMachine = Machine.make({
      states: contextualStates.states,
      events: Machine.events(Reset),
      initial: (to) => to.ContextualCount().resolve(({ target }) => (target.decoded(new ContextualCount({ value: 0 }))))
    })
    const layer = ClusterMachine.make("ContextualCounter", contextualMachine, { version: "1" }).toLayer()

    expect<Layer.Services<typeof layer>>().type.toBe<
      | ClusterMachine.Storage
      | MessageStorage.MessageStorage
      | Sharding.Sharding
      | SnapshotDecoding
      | SnapshotEncoding
    >()
  })
})
