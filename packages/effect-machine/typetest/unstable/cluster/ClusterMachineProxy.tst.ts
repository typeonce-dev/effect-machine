import type { Effect, Layer, Option, Scope, Stream } from "effect"
import { Schema } from "effect"
import type { ClusterError, Sharding } from "effect/cluster"
import type { RpcClient, RpcClientError, RpcGroup, RpcServer } from "effect/rpc"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../../src/index.js"
import { ClusterMachine, ClusterMachineProxy } from "../../../src/unstable/cluster/index.js"
import type { Rebuilt } from "../../support/rebuilt.js"

const Events = Machine.events({
  Add: { by: Schema.Number },
  Finish: {}
})

const counter = Machine.make({
  id: "Counter",
  root: Machine.state({
    states: {
      Counting: { fields: { count: Schema.Number } },
      Done: { type: "final", fields: { count: Schema.Number }, output: Schema.Number }
    }
  }),
  events: Events
}).handle({
  initial: { target: "Counting", data: { count: 0 } },
  states: {
    Counting: {
      on: {
        Add: { target: "Counting", data: ({ event, state }) => ({ count: state.count + event.by }) },
        Finish: { target: "Done", data: ({ state }) => ({ count: state.count }) }
      }
    },
    Done: { output: ({ state }) => state.count }
  }
})

const Counter = ClusterMachine.make("Counter", counter, { version: "1" })

describe("ClusterMachineProxy", () => {
  it("derives an RpcGroup, handler layer, and server layer", () => {
    const group = ClusterMachineProxy.toRpcGroup(Counter)
    expect(group).type.toBe<RpcGroup.RpcGroup<ClusterMachineProxy.Rpcs<"Counter", typeof counter>>>()

    const handlers = ClusterMachineProxy.layerHandlers(Counter)
    expect(handlers).type.toBe<
      Layer.Layer<
        ClusterMachineProxy.RpcHandlers<"Counter", typeof counter>,
        never,
        Sharding.Sharding | ClusterMachine.ReadServices<typeof counter>
      >
    >()

    const server = ClusterMachineProxy.toLayer(Counter)
    expect(server).type.toBe<
      Layer.Layer<
        never,
        never,
        RpcServer.Protocol | Sharding.Sharding | ClusterMachine.ReadServices<typeof counter>
      >
    >()
  })

  it("exposes a remote client requiring only RpcClient.Protocol and Scope", () => {
    const makeClient = ClusterMachineProxy.client(Counter)
    expect(makeClient).type.toBe<
      Effect.Effect<
        (entityId: string) => ClusterMachineProxy.Client<Rebuilt<typeof counter>>,
        never,
        RpcClient.Protocol | Scope.Scope
      >
    >()

    const client = null! as ClusterMachineProxy.Client<typeof counter>

    expect(client.start()).type.toBe<
      Effect.Effect<
        void,
        ClusterMachine.Rejected | ClusterMachine.ClientError | RpcClientError.RpcClientError
      >
    >()
    expect(client.start).type.not.toBeCallableWith(1)

    expect(client.send(Events.Add({ by: 1 }))).type.toBe<
      Effect.Effect<
        void,
        ClusterMachine.Rejected | ClusterMachine.ClientError | RpcClientError.RpcClientError
      >
    >()
    expect(client.send).type.not.toBeCallableWith({ _tag: "Add", by: "1" })
    expect(client.send).type.not.toBeCallableWith({ _tag: "Unknown" })

    expect(client.snapshot).type.toBe<
      Effect.Effect<
        Option.Option<ClusterMachine.Snapshot<typeof counter>>,
        ClusterMachine.ReadError | ClusterError.PersistenceError | RpcClientError.RpcClientError
      >
    >()

    expect(client.changes).type.toBe<
      Stream.Stream<
        ClusterMachine.Snapshot<typeof counter>,
        ClusterMachine.ReadError | ClusterError.PersistenceError | RpcClientError.RpcClientError
      >
    >()

    expect(client.join).type.toBe<
      Effect.Effect<
        number,
        | ClusterMachine.MachineFailedError
        | ClusterMachine.ReadError
        | ClusterError.PersistenceError
        | RpcClientError.RpcClientError
      >
    >()
  })

  it("types per-entity start input on proxy clients", () => {
    const inputMachine = Machine.make({
      id: "ProxyInput",
      root: Machine.state({ states: { Open: { fields: { count: Schema.Number } } } }),
      input: Schema.Number,
      events: Events
    }).handle({
      initial: { target: "Open", data: ({ input }) => ({ count: input }) },
      states: { Open: {} }
    })
    const InputAdapter = ClusterMachine.make("ProxyInput", inputMachine, { version: "1" })
    const makeClient = ClusterMachineProxy.client(InputAdapter)
    const client = null! as Effect.Success<typeof makeClient> extends (id: string) => infer C ? C : never
    expect(client.start(42)).type.toBe<
      Effect.Effect<
        void,
        ClusterMachine.Rejected | ClusterMachine.ClientError | RpcClientError.RpcClientError
      >
    >()
    expect(client.start).type.not.toBeCallableWith()
    expect(client.start).type.not.toBeCallableWith("42")
  })
})
