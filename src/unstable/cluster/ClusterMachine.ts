/**
 * Runs Effect machines as persisted Cluster entities.
 *
 * @since 0.4.0
 */
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Entity, MessageStorage, Sharding, Snowflake } from "effect/unstable/cluster"
import type { Rpc } from "effect/unstable/rpc"
import * as internal from "../../internal/machine/cluster.js"
import { Accepted, Rejected, Storage } from "../../internal/machine/cluster.js"
import type { EnsureExecutable } from "../../internal/machine/readiness.js"
import type * as Machine from "../../Machine.js"

type Snowflake = Snowflake.Snowflake

/**
 * Persisted machine checkpoint owned by the Cluster bridge.
 *
 * **Details**
 *
 * Machine identity and deployment version are stored around the generic
 * encoded snapshot. The request id records the request that produced the
 * checkpoint.
 *
 * @category models
 * @since 0.4.0
 */
export interface Checkpoint {
  /** Stable identity of the machine definition that produced the snapshot. */
  readonly machineId: string

  /** Application-controlled deployment or migration version. */
  readonly version: string

  /** Cluster request whose accepted transition produced this checkpoint. */
  readonly requestId: Snowflake

  /** Encoded logical machine state and completed outputs. */
  readonly snapshot: Machine.Machine.EncodedSnapshot
}

/**
 * Result of loading a checkpoint for a Cluster machine request.
 *
 * **Details**
 *
 * `processed` reports whether the exact Cluster request id was already
 * committed. Storage implementations must retain enough request ids to detect
 * redelivery even after later requests have advanced the checkpoint.
 *
 * @category models
 * @since 0.4.0
 */
export interface LoadResult {
  /** Latest checkpoint for the entity, when one has been committed. */
  readonly checkpoint: Option.Option<Checkpoint>

  /** Whether the requested id has already been committed. */
  readonly processed: boolean
}

/**
 * Result of atomically committing a Cluster machine request.
 *
 * @category models
 * @since 0.4.0
 */
export type CommitResult = CommitResult.Committed | CommitResult.Duplicate

/**
 * Constructors and types for Cluster machine commit results.
 *
 * @category models
 * @since 0.4.0
 */
export const CommitResult = {
  Committed: (): CommitResult.Committed => ({ _tag: "Committed" }),
  Duplicate: (): CommitResult.Duplicate => ({ _tag: "Duplicate" })
}

/**
 * Types for Cluster machine commit results.
 *
 * @category models
 * @since 0.4.0
 */
export declare namespace CommitResult {
  /**
   * Indicates that the request id and checkpoint were committed atomically.
   *
   * @category models
   * @since 0.4.0
   */
  export interface Committed {
    readonly _tag: "Committed"
  }

  /**
   * Indicates that the request id was already committed.
   *
   * @category models
   * @since 0.4.0
   */
  export interface Duplicate {
    readonly _tag: "Duplicate"
  }
}

/**
 * Checkpoint persistence service used by Cluster machines.
 *
 * **When to use**
 *
 * Use to connect `ClusterMachine` to a durable checkpoint store that can
 * atomically deduplicate request ids and replace the current checkpoint.
 *
 * **Gotchas**
 *
 * For checkpoint and emitted-message persistence to commit atomically, this
 * service must join the transaction opened through the configured
 * `MessageStorage`. The reply is persisted after that transaction; storing the
 * request id with the checkpoint makes a redelivery recover that reply without
 * applying the transition again. A separate transaction or database cannot
 * provide checkpoint-and-emission atomicity.
 *
 * @category services
 * @since 0.4.0
 */
export { Storage }

/**
 * Successful result returned after a Cluster machine request is committed or
 * recognized as a redelivery.
 *
 * @category models
 * @since 0.4.0
 */
export { Accepted }

/**
 * Schema for reasons a Cluster machine request can be rejected without
 * advancing its checkpoint.
 *
 * @category models
 * @since 0.4.0
 */
export const RejectionReason = Schema.Literals([
  "MachineIdMismatch",
  "VersionMismatch",
  "InvalidCheckpoint",
  "UnsupportedProcessLocal",
  "TransitionFailure",
  "PersistenceFailure",
  "EmissionFailure"
])

/**
 * Type of {@link RejectionReason}.
 *
 * @category models
 * @since 0.4.0
 */
export type RejectionReason = typeof RejectionReason.Type

/**
 * Rejected Cluster machine request. Transaction-participating durable storage
 * leaves the previous checkpoint in place and suppresses emitted events.
 *
 * @category models
 * @since 0.4.0
 */
export { Rejected }

/**
 * Schema for Cluster machine request outcomes.
 *
 * @category schemas
 * @since 0.4.0
 */
export const SendResult = Schema.Union([Accepted, Rejected])

type SendRpc<Events extends ReadonlyArray<Machine.Machine.TaggedSchema>> = Rpc.Rpc<
  "send",
  Schema.Union<Events>,
  typeof SendResult
>

type MachineEvents<M extends Machine.Machine.Any> = Machine.Machine.InputEvents<M>

type MachineEmits<M extends Machine.Machine.Any> = Machine.Machine.Emits<M>

/**
 * Cluster adapter for one machine definition and entity type.
 *
 * **Details**
 *
 * The adapter exposes one persisted `send` RPC. Entity requests are serialized
 * by the normal Cluster entity concurrency and every accepted request advances
 * the checkpoint at most once.
 *
 * @category models
 * @since 0.4.0
 */
export interface ClusterMachine<
  in out Type extends string,
  in out M extends Machine.Machine.Any,
  out Services = MachineServices<M>
> {
  /** Machine definition executed by each entity instance. */
  readonly machine: M

  /** Cluster entity exposing the persisted, schema-validated `send` RPC. */
  readonly entity: Entity.Entity<Type, SendRpc<MachineEvents<M>>>

  /**
   * Creates the Cluster entity layer for this machine.
   *
   * **Gotchas**
   *
   * `enqueue` runs after the checkpoint write in the same `MessageStorage`
   * transaction. It must durably enqueue emitted events in that transaction;
   * arbitrary external effects are not atomic with the checkpoint. The reply
   * is persisted after commit and recovered through request-id deduplication if
   * delivery is interrupted. Machines that never emit may omit `enqueue`.
   *
   * @since 0.4.0
   */
  readonly toLayer: <R = never>(options?: {
    readonly enqueue?: (
      event: Machine.Machine.EmitOf<MachineEmits<M>>
    ) => Effect.Effect<void, unknown, R>
  }) => Layer.Layer<never, never, Storage | MessageStorage.MessageStorage | Sharding.Sharding | R | Services>
}

type MachineServices<M extends Machine.Machine.Any> =
  | ExcludeCompatibleRuntime<
    Machine.ExecutionServices<Machine.Machine.Services<M> | Machine.Machine.InitialServices<M>>,
    Machine.Machine.Event<M>,
    Machine.Machine.Emit<M>
  >
  | Machine.Machine.SnapshotDecodingServices<Machine.Machine.States<M>>
  | Machine.Machine.SnapshotEncodingServices<Machine.Machine.States<M>>

type IsAny<A> = 0 extends (1 & A) ? true : false

type ExcludeCompatibleRuntime<Requirements, Events, Emits> = Requirements extends Machine.Runtime.Requirement<
  infer RequiredEvents,
  infer RequiredEmits
> ? IsAny<Requirements> extends true ? Requirements
  : [RequiredEvents] extends [Events] ? [RequiredEmits] extends [Emits] ? never : Requirements
  : Requirements
  : Requirements

/**
 * Creates an in-memory Cluster machine checkpoint store.
 *
 * **When to use**
 *
 * Use when you test or run a local process that does not require checkpoints
 * to survive a restart.
 *
 * **Gotchas**
 *
 * This store is not durable and does not provide rollback with the in-memory
 * `MessageStorage` transaction marker.
 *
 * @category constructors
 * @since 0.4.0
 */
export const makeMemory: Effect.Effect<Storage["Service"]> = internal.makeMemory

/**
 * Layer providing the in-memory Cluster machine checkpoint store.
 *
 * @category layers
 * @since 0.4.0
 */
export const layerMemory: Layer.Layer<Storage> = internal.layerMemory

/**
 * Creates a persisted Cluster entity adapter for a machine.
 *
 * **When to use**
 *
 * Use when each Cluster entity id should own one durable machine snapshot and
 * accept schema-validated machine events through a persisted `send` RPC.
 *
 * **Details**
 *
 * A missing checkpoint runs initial planning before the first event. Existing
 * checkpoints are identity-checked, version-checked, decoded, and resumed
 * without rerunning initial entry behavior. Final checkpoints accept later
 * requests as no-ops. The stable bridge identity is `machine.id` when present,
 * otherwise the Cluster entity type.
 *
 * **Gotchas**
 *
 * Invoked processes, spawned children, action-time `runtime.raise`, timers,
 * subscriptions, and other process-local state are not durable and are
 * rejected. Planning-time raised events remain part of the current macrostep.
 * Arbitrary action effects may run again after a crash before checkpoint
 * commit, so the bridge does not provide exactly-once external effects.
 *
 * **Example**
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 * import { ClusterMachine } from "@typeonce/effect-machine/cluster"
 *
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
 * const States = Machine.defineStates({ Idle })
 * const machine = Machine.make({
 *   states: States.states,
 *   events: [],
 *   initial: () => States.initial.Idle.from()
 * }).handle({ Idle: {} })
 *
 * const adapter = ClusterMachine.make("IdleMachine", machine, { version: "1" })
 * ```
 *
 * @category constructors
 * @since 0.4.0
 */
export const make: <
  const Type extends string,
  States extends Machine.Machine.StateSchemas,
  Events extends ReadonlyArray<Machine.Machine.TaggedSchema>,
  Input extends Schema.Top,
  UnhandledStates extends Machine.Machine.StateIdentifier<States>,
  E,
  R,
  InitialE,
  InitialR,
  FinalStates extends Machine.Machine.StateIdentifier<States>,
  Output,
  Emits extends ReadonlyArray<Machine.Machine.TaggedSchema>,
  OutputStates extends Machine.Machine.StateIdentifier<States>,
  InputEvents extends ReadonlyArray<Machine.Machine.TaggedSchema> = Events
>(
  type: Type,
  machine:
    & Machine.Machine<
      States,
      Events,
      Input,
      UnhandledStates,
      E,
      R,
      InitialE,
      InitialR,
      FinalStates,
      Output,
      Emits,
      OutputStates,
      InputEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>,
  options: {
    readonly version: string
  },
  ...input: [...Machine.Machine.InputArgs<Input>]
) => ClusterMachine<
  Type,
  Machine.Machine<
    States,
    Events,
    Input,
    UnhandledStates,
    E,
    R,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    Emits,
    OutputStates,
    InputEvents
  >,
  | ExcludeCompatibleRuntime<
    Machine.ExecutionServices<R | InitialR>,
    Machine.Machine.EventOf<Events>,
    Machine.Machine.EmitOf<Emits>
  >
  | Machine.Machine.SnapshotDecodingServices<States>
  | Machine.Machine.SnapshotEncodingServices<States>
> = internal.make
