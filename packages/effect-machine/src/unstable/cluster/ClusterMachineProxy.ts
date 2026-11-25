/**
 * Exposes `ClusterMachine` adapters over `effect/rpc` transports, including Web
 * Workers, `SharedWorker`, Node worker threads, WebSockets, and HTTP.
 *
 * A `ClusterMachine.Client` sends through `Sharding` and reads `Storage`
 * directly. When the Cluster runner and its SQL database live in another thread
 * or process — such as a browser Web Worker running `SingleRunner` over
 * SQLite-WASM — callers on the main thread have neither `Sharding` nor
 * `Storage`. `ClusterMachineProxy` bridges `start`, `send`, `snapshot`,
 * `changes`, and `join` over any `RpcServer.Protocol` / `RpcClient.Protocol`.
 *
 * **Example** (Serving and calling a Cluster machine over RPC)
 *
 * ```ts import.meta.vitest
 * import { Machine } from "@typeonce/effect-machine"
 * import { ClusterMachine, ClusterMachineProxy } from "@typeonce/effect-machine/cluster"
 * import { Schema } from "effect"
 *
 * const Counter = ClusterMachine.make(
 *   "Counter",
 *   Machine.make({
 *     root: Machine.state({ states: { Open: { fields: { count: Schema.Number } } } }),
 *     events: Machine.events({ Add: { by: Schema.Number } })
 *   }).handle({
 *     initial: { target: "Open", data: { count: 0 } },
 *     states: {
 *       Open: {
 *         on: { Add: { update: { Open: ({ event, state }) => ({ count: state.count + event.by }) } } }
 *       }
 *     }
 *   }),
 *   { version: "1" }
 * )
 *
 * const rpcs = ClusterMachineProxy.toRpcGroup(Counter)
 *
 * rpcs.requests.size // => 4
 * ```
 *
 * @since 0.48.0
 */
import type { ClusterError, Sharding } from "effect/cluster"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type { Rpc, RpcClient, RpcClientError, RpcGroup, RpcSchema, RpcServer } from "effect/rpc"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import * as internal from "../../internal/machine/clusterProxy.js"
import type * as Machine from "../../Machine.js"
import type * as ClusterMachine from "./ClusterMachine.js"

/**
 * Schema for the validated checkpoint summary sent over an RPC transport by
 * `snapshot` and `changes`.
 *
 * @category schemas
 * @since 0.48.0
 */
export const EncodedSnapshot: typeof internal.EncodedSnapshot = internal.EncodedSnapshot

/**
 * Type of {@link EncodedSnapshot}.
 *
 * @category models
 * @since 0.48.0
 */
export type EncodedSnapshot = typeof EncodedSnapshot.Type

type MachineEvents<M extends Machine.Machine.Any> = Machine.Machine.InputEvents<M>

type StartPayload<M extends Machine.Machine.Any> = Machine.Machine.InputSchema<M> extends typeof Schema.Void
  ? Schema.Struct<{ readonly entityId: typeof Schema.String }>
  : Schema.Struct<{
    readonly entityId: typeof Schema.String
    readonly input: Machine.Machine.InputSchema<M>
  }>

type SendErrorSchema = typeof internal.SendErrorSchema

type ReadErrorSchema = typeof internal.ReadErrorSchema

/**
 * Union of prefixed RPC definitions derived for one `ClusterMachine` adapter:
 * `${Type}.start`, `${Type}.send`, `${Type}.snapshot`, and `${Type}.changes`.
 *
 * @category models
 * @since 0.48.0
 */
export type Rpcs<Type extends string, M extends Machine.Machine.Any> =
  | Rpc.Rpc<
    `${Type}.start`,
    StartPayload<M>,
    typeof Schema.Void,
    SendErrorSchema
  >
  | Rpc.Rpc<
    `${Type}.send`,
    Schema.Struct<{
      readonly entityId: typeof Schema.String
      readonly event: Schema.Union<MachineEvents<M>>
    }>,
    typeof Schema.Void,
    SendErrorSchema
  >
  | Rpc.Rpc<
    `${Type}.snapshot`,
    Schema.Struct<{ readonly entityId: typeof Schema.String }>,
    Schema.Option<typeof EncodedSnapshot>,
    ReadErrorSchema
  >
  | Rpc.Rpc<
    `${Type}.changes`,
    Schema.Struct<{ readonly entityId: typeof Schema.String }>,
    RpcSchema.Stream<typeof EncodedSnapshot, ReadErrorSchema>,
    typeof Schema.Never
  >

/**
 * Union of RPC handler services provided by {@link layerHandlers}.
 *
 * @category services
 * @since 0.48.0
 */
export type RpcHandlers<Type extends string, M extends Machine.Machine.Any> = Rpc.ToHandler<Rpcs<Type, M>>

/**
 * Services required to encode startup input sent by a remote {@link Client}.
 *
 * @category models
 * @since 0.49.0
 */
export type StartServices<M extends Machine.Machine.Any> = Machine.Machine.InputSchema<M> extends typeof Schema.Void
  ? never
  : Machine.Machine.InputSchema<M>["EncodingServices"]

/**
 * Services required to encode events sent by a remote {@link Client}.
 *
 * @category models
 * @since 0.48.0
 */
export type SendServices<M extends Machine.Machine.Any> = MachineEvents<M>[number]["EncodingServices"]

/**
 * Services required to decode snapshots read by a remote {@link Client}.
 *
 * **Details**
 *
 * Unlike `ClusterMachine.ReadServices`, this does not include
 * `ClusterMachine.Storage` because reads travel over the RPC protocol.
 *
 * @category models
 * @since 0.48.0
 */
export type ReadServices<M extends Machine.Machine.Any> = Machine.Machine.SnapshotDecodingServices<
  Machine.Machine.States<M>
>

/**
 * Event and startup input decoding services required by an RPC server hosting
 * a proxy for `M`.
 *
 * @category models
 * @since 0.48.0
 */
export type ServerServices<M extends Machine.Machine.Any> =
  | MachineEvents<M>[number]["DecodingServices"]
  | (Machine.Machine.InputSchema<M> extends typeof Schema.Void ? never
    : Machine.Machine.InputSchema<M>["DecodingServices"])

/**
 * Options passed through to `RpcServer.layer` by {@link toLayer}.
 *
 * @category models
 * @since 0.48.0
 */
export interface ServerOptions {
  readonly disableTracing?: boolean | undefined
  readonly spanPrefix?: string | undefined
  readonly spanAttributes?: Record<string, unknown> | undefined
  readonly concurrency?: number | "unbounded" | undefined
  readonly disableFatalDefects?: boolean | undefined
}

/**
 * A client for one `ClusterMachine` entity accessed over an `effect/rpc`
 * transport.
 *
 * **Details**
 *
 * Mirrors `ClusterMachine.Client` (`send`, `snapshot`, `changes`, `join`)
 * without requiring `Sharding` or `ClusterMachine.Storage` in the caller's
 * environment. Transport failures from the underlying RPC channel are reported
 * as `RpcClientError.RpcClientError`.
 *
 * **Gotchas**
 *
 * When running over a single Web Worker with `RpcClient.layerProtocolWorker`,
 * pass a `concurrency` greater than `1` (for example
 * `{ size: 1, concurrency: 100 }`) so streaming `changes` or `join` calls do
 * not occupy the worker pool's only slot and block concurrent `send` calls.
 *
 * @category models
 * @since 0.48.0
 */
export interface Client<M extends Machine.Machine.Any> {
  /** Entity id of the machine this client addresses. */
  readonly entityId: string

  /**
   * Starts the entity with its initial input, committing its initial state when
   * it has no checkpoint yet.
   */
  readonly start: (
    ...input: [...Machine.Machine.InputArgs<Machine.Machine.InputSchema<M>>]
  ) => Effect.Effect<
    void,
    ClusterMachine.Rejected | ClusterMachine.ClientError | RpcClientError.RpcClientError,
    StartServices<M>
  >

  /** Sends one input event and waits until it is committed or rejected. */
  readonly send: (
    event: Machine.Machine.EventInputOf<MachineEvents<M>>
  ) => Effect.Effect<
    void,
    ClusterMachine.Rejected | ClusterMachine.ClientError | RpcClientError.RpcClientError,
    SendServices<M>
  >

  /**
   * Reads the latest committed checkpoint, or `None` when the machine has not
   * committed one yet.
   */
  readonly snapshot: Effect.Effect<
    Option.Option<ClusterMachine.Snapshot<M>>,
    ClusterMachine.ReadError | ClusterError.PersistenceError | RpcClientError.RpcClientError,
    ReadServices<M>
  >

  /**
   * Streams the latest committed checkpoint and later committed revisions, once
   * each, ending after a terminal checkpoint.
   */
  readonly changes: Stream.Stream<
    ClusterMachine.Snapshot<M>,
    ClusterMachine.ReadError | ClusterError.PersistenceError | RpcClientError.RpcClientError,
    ReadServices<M>
  >

  /**
   * Waits for the output of the machine, or fails with
   * `ClusterMachine.MachineFailedError` when it failed or was stopped.
   */
  readonly join: Effect.Effect<
    Machine.Machine.Output<M>,
    | ClusterMachine.MachineFailedError
    | ClusterMachine.ReadError
    | ClusterError.PersistenceError
    | RpcClientError.RpcClientError,
    ReadServices<M>
  >
}

/**
 * Derives an `RpcGroup` exposing `${Type}.start`, `${Type}.send`,
 * `${Type}.snapshot`, and `${Type}.changes` for one `ClusterMachine` adapter.
 *
 * **When to use**
 *
 * Use to compose multiple Cluster machines onto one RPC server (such as a
 * single Web Worker or `SharedWorker`) via `groupA.merge(groupB)`, or to attach
 * RPC middleware before passing the group to `RpcServer.layer`.
 *
 * @see {@link layerHandlers} to provide the handlers for a merged group.
 * @see {@link toLayer} for serving a single machine directly.
 * @category constructors
 * @since 0.48.0
 */
export const toRpcGroup: <
  const Type extends string,
  M extends Machine.Machine.Any,
  Services
>(
  adapter: ClusterMachine.ClusterMachine<Type, M, Services>
) => RpcGroup.RpcGroup<Rpcs<Type, M>> = internal.toRpcGroup

/**
 * Provides the RPC handlers for the group created by {@link toRpcGroup}.
 *
 * **When to use**
 *
 * Use alongside `RpcServer.layer` when serving one or more merged Cluster
 * machine groups from a worker or server that hosts `Sharding` and
 * `ClusterMachine.Storage`.
 *
 * @category layers
 * @since 0.48.0
 */
export const layerHandlers: <
  const Type extends string,
  M extends Machine.Machine.Any,
  Services
>(
  adapter: ClusterMachine.ClusterMachine<Type, M, Services>
) => Layer.Layer<
  RpcHandlers<Type, M>,
  never,
  Sharding.Sharding | ClusterMachine.ReadServices<M>
> = internal.layerHandlers

/**
 * Serves one `ClusterMachine` adapter over the provided `RpcServer.Protocol`.
 *
 * **When to use**
 *
 * Use as a one-step server layer when a worker or endpoint serves a single
 * Cluster machine. Combine with `RpcServer.layerProtocolWorkerRunner` for a Web
 * Worker or `SharedWorker`, or with an HTTP/WebSocket server protocol.
 *
 * @category layers
 * @since 0.48.0
 */
export const toLayer: <
  const Type extends string,
  M extends Machine.Machine.Any,
  Services
>(
  adapter: ClusterMachine.ClusterMachine<Type, M, Services>,
  options?: ServerOptions
) => Layer.Layer<
  never,
  never,
  | RpcServer.Protocol
  | Sharding.Sharding
  | ClusterMachine.ReadServices<M>
  | ServerServices<M>
> = internal.toLayer

/**
 * Creates a factory of remote {@link Client}s for one `ClusterMachine` adapter
 * over the provided `RpcClient.Protocol`.
 *
 * **When to use**
 *
 * Use on a browser main thread (with `RpcClient.layerProtocolWorker`) or any
 * remote process that talks to a Cluster runner over `effect/rpc` without
 * direct access to `Sharding` or `ClusterMachine.Storage`.
 *
 * **Details**
 *
 * `send` validates input events locally before sending them over the wire, so
 * events constructed by `Machine.events` work as they do locally and invalid
 * events fail with `ClusterMachine.Rejected("InvalidEvent")` without reaching
 * the server.
 *
 * @category constructors
 * @since 0.48.0
 */
export const client: <
  const Type extends string,
  M extends Machine.Machine.Any,
  Services
>(
  adapter: ClusterMachine.ClusterMachine<Type, M, Services>
) => Effect.Effect<
  (entityId: string) => Client<M>,
  never,
  RpcClient.Protocol | Scope.Scope
> = internal.client
