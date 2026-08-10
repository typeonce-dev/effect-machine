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

  const states = Machine.defineStates({ Count })

  const machine = Machine.make({
    id: "Counter",
    states: states.states,
    events: [Increment, Reset],
    initial: () => states.initial.Count(new Count({ value: 0 }))
  }).handle({
    Count: {
      on: {
        Increment: ({ event, state }) => states.initial.Count(new Count({ value: state.value + event.by })),
        Reset: () => states.initial.Count(new Count({ value: 0 }))
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
      events: [Increment],
      internalEvents: [Reset],
      initial: () => states.initial.Count(new Count({ value: 0 }))
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
      events: [Reset],
      input: Input,
      initial: (input) => states.initial.Count(new Count({ value: input.value }))
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
  })

  it("requires declared output implementations", () => {
    const outputStates = Machine.defineStates({
      Done: {
        schema: Done,
        type: "final",
        output: Schema.String
      }
    })
    const incomplete = Machine.make({
      states: outputStates.states,
      events: [Reset],
      initial: () => outputStates.initial.Done(new Done({ value: "done" }))
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
    const contextualStates = Machine.defineStates({ ContextualCount })
    const contextualMachine = Machine.make({
      states: contextualStates.states,
      events: [Reset],
      initial: () => contextualStates.initial.ContextualCount(new ContextualCount({ value: 0 }))
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
