/**
 * Transport-independent RPC proxy for `ClusterMachine`.
 *
 * Exposes `send`, `snapshot`, and `changes` of a `ClusterMachine` as an
 * `effect/rpc` `RpcGroup`, so clients without direct `Sharding` or `Storage`
 * access (such as a browser main thread talking to a Web Worker or
 * `SharedWorker`, a Node worker thread, or a remote HTTP/WebSocket client) can
 * drive and observe Cluster machines with full type safety.
 *
 * @since 0.48.0
 */
import { ClusterError, EntityAddress, EntityId, Sharding } from "effect/cluster"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as Machine from "../../Machine.js"
import type * as ClusterMachine from "../../unstable/cluster/ClusterMachine.js"
import type * as Public from "../../unstable/cluster/ClusterMachineProxy.js"
import * as Cluster from "./cluster.js"
import { ReadError, Rejected } from "./clusterProtocol.js"
import * as ClusterRead from "./clusterRead.js"
import * as Protocol from "./protocol.js"

/** Wire schema for a validated committed checkpoint returned by proxy reads. */
export const EncodedSnapshot = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("active"),
    revision: Schema.Number,
    snapshot: Schema.Unknown
  }),
  Schema.Struct({
    status: Schema.Literal("done"),
    revision: Schema.Number,
    snapshot: Schema.Unknown
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    revision: Schema.Number,
    snapshot: Schema.Unknown,
    failure: Schema.String
  }),
  Schema.Struct({
    status: Schema.Literal("stopped"),
    revision: Schema.Number,
    snapshot: Schema.Unknown
  })
])

export const SendErrorSchema = Schema.Union([
  Rejected,
  ClusterError.MailboxFull,
  ClusterError.AlreadyProcessingMessage,
  ClusterError.PersistenceError,
  ClusterError.EntityNotAssignedToRunner
])

export const ReadErrorSchema = Schema.Union([
  ReadError,
  ClusterError.PersistenceError
])

const rpcGroups = new WeakMap<object, RpcGroup.RpcGroup<any>>()

export const toRpcGroup = <
  const Type extends string,
  M extends Machine.Machine.Any,
  Services
>(
  adapter: ClusterMachine.ClusterMachine<Type, M, Services>
): RpcGroup.RpcGroup<Public.Rpcs<Type, M>> => {
  const cached = rpcGroups.get(adapter)
  if (cached !== undefined) return cached
  const meta = Cluster.getAdapterMeta(adapter)
  const eventSchema = Schema.Union(Protocol.inputEventSchemas(meta.machine))
  const startRpc = Rpc.make(`${meta.type}.start`, {
    payload: meta.machine.input === undefined
      ? Schema.Struct({ entityId: Schema.String })
      : Schema.Struct({
        entityId: Schema.String,
        input: meta.machine.input
      }),
    success: Schema.Void,
    error: SendErrorSchema
  })
  const sendRpc = Rpc.make(`${meta.type}.send`, {
    payload: Schema.Struct({
      entityId: Schema.String,
      event: eventSchema
    }),
    success: Schema.Void,
    error: SendErrorSchema
  })
  const snapshotRpc = Rpc.make(`${meta.type}.snapshot`, {
    payload: Schema.Struct({ entityId: Schema.String }),
    success: Schema.Option(EncodedSnapshot),
    error: ReadErrorSchema
  })
  const changesRpc = Rpc.make(`${meta.type}.changes`, {
    payload: Schema.Struct({ entityId: Schema.String }),
    success: EncodedSnapshot,
    error: ReadErrorSchema,
    stream: true
  })
  const group = RpcGroup.make(startRpc, sendRpc, snapshotRpc, changesRpc)
  rpcGroups.set(adapter, group)
  return group as never
}

export const layerHandlers = <
  const Type extends string,
  M extends Machine.Machine.Any,
  Services
>(
  adapter: ClusterMachine.ClusterMachine<Type, M, Services>
): Layer.Layer<
  Public.RpcHandlers<Type, M>,
  never,
  Sharding.Sharding | ClusterMachine.ReadServices<M>
> => {
  const meta = Cluster.getAdapterMeta(adapter)
  const group = toRpcGroup(adapter)
  return group.toLayer(
    Effect.gen(function*() {
      const makeClient = yield* adapter.client
      const sharding = yield* Sharding.Sharding
      const context = yield* Effect.context<ClusterMachine.ReadServices<M>>()

      const readerOf = (entityId: string) => {
        const id = EntityId.make(entityId)
        return ClusterRead.makeEncoded<M>({
          machine: meta.machine,
          definitionId: meta.definitionId,
          version: meta.version,
          address: EntityAddress.make({
            shardId: sharding.getShardId(id, adapter.entity.getShardGroup(id)),
            entityType: adapter.entity.type,
            entityId: id
          }),
          interval: meta.readInterval
        })
      }

      return {
        [`${meta.type}.start`]: (payload: { readonly entityId: string; readonly input?: unknown }) =>
          meta.machine.input === undefined
            ? (makeClient(payload.entityId).start as () => Effect.Effect<void, any>)()
            : (makeClient(payload.entityId).start as (input: unknown) => Effect.Effect<void, any>)(payload.input),
        [`${meta.type}.send`]: ({ entityId, event }: { readonly entityId: string; readonly event: never }) =>
          makeClient(entityId).send(event),
        [`${meta.type}.snapshot`]: ({ entityId }: { readonly entityId: string }) =>
          readerOf(entityId).snapshot.pipe(Effect.provideContext(context)),
        [`${meta.type}.changes`]: ({ entityId }: { readonly entityId: string }) =>
          readerOf(entityId).changes.pipe(Stream.provideContext(context))
      } as never
    })
  )
}

export const toLayer = <
  const Type extends string,
  M extends Machine.Machine.Any,
  Services
>(
  adapter: ClusterMachine.ClusterMachine<Type, M, Services>,
  options?: Public.ServerOptions
): Layer.Layer<
  never,
  never,
  | RpcServer.Protocol
  | Sharding.Sharding
  | ClusterMachine.ReadServices<M>
  | Public.ServerServices<M>
> =>
  RpcServer.layer(toRpcGroup(adapter), options).pipe(
    Layer.provide(layerHandlers(adapter))
  )

export const client = <
  const Type extends string,
  M extends Machine.Machine.Any,
  Services
>(
  adapter: ClusterMachine.ClusterMachine<Type, M, Services>
): Effect.Effect<
  (entityId: string) => Public.Client<M>,
  never,
  RpcClient.Protocol | Scope.Scope
> =>
  Effect.gen(function*() {
    const meta = Cluster.getAdapterMeta(adapter)
    const group = toRpcGroup(adapter)
    const rpc = (yield* RpcClient.make(group)) as Record<string, (payload: any) => any>
    const startTag = `${meta.type}.start`
    const sendTag = `${meta.type}.send`
    const snapshotTag = `${meta.type}.snapshot`
    const changesTag = `${meta.type}.changes`

    return (entityId: string): Public.Client<M> => {
      const start = (...args: ReadonlyArray<unknown>) =>
        meta.decodeInput(args[0]).pipe(
          Effect.flatMap((decoded) =>
            rpc[startTag]!(meta.machine.input === undefined ? { entityId } : { entityId, input: decoded })
          )
        )

      const send = (event: unknown) =>
        meta.decodeEvent(event).pipe(
          Effect.flatMap((decoded) => rpc[sendTag]!({ entityId, event: decoded }))
        )

      const snapshot = (rpc[snapshotTag]!({ entityId }) as Effect.Effect<
        Option.Option<ClusterRead.WireSnapshot>,
        any
      >).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (wire) => Effect.asSome(ClusterRead.decodeWire<M>(meta.machine as M, wire))
        }))
      )

      const changes = (rpc[changesTag]!({ entityId }) as Stream.Stream<ClusterRead.WireSnapshot, any>).pipe(
        Stream.mapEffect((wire) => ClusterRead.decodeWire<M>(meta.machine as M, wire))
      )

      const join = ClusterRead.joinChanges<M, any, any>(changes)

      return { entityId, start, send, snapshot, changes, join } as Public.Client<M>
    }
  })
