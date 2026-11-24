/**
 * Runs Effect machines as persisted Cluster entities.
 *
 * Each live entity keeps one machine instance in memory, which applies requests
 * and runs the effects and timers invoked by active states. {@link Storage} holds
 * the truth: every step commits a checkpoint to it, and an entity that comes up
 * anywhere continues from that checkpoint.
 *
 * @since 0.4.0
 */
import type { ClusterError, Entity, MessageStorage, Sharding, Snowflake } from "effect/cluster"
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type { Rpc } from "effect/rpc"
import type * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import * as internal from "../../internal/machine/cluster.js"
import * as Protocol from "../../internal/machine/clusterProtocol.js"
import { Accepted, MachineFailedError, ReadError, Rejected, Storage } from "../../internal/machine/clusterProtocol.js"
import type { EnsureExecutable } from "../../internal/machine/readiness.js"
import type * as Machine from "../../Machine.js"

type Snowflake = Snowflake.Snowflake

/**
 * Persisted machine checkpoint owned by the Cluster bridge.
 *
 * **Details**
 *
 * The definition id and deployment version are stored around the generic
 * encoded snapshot. The origin records the input that produced the checkpoint.
 * The revision orders the checkpoints of one entity and decides which
 * checkpoint a commit may replace. The status says whether the machine failed.
 *
 * **Gotchas**
 *
 * Store and return every field unchanged. The bridge assigns them all, and
 * rejects a checkpoint whose revision is not a positive integer, or whose
 * status it does not know or contradicts the snapshot or the machine, as
 * `InvalidCheckpoint`.
 *
 * @category models
 * @since 0.4.0
 */
export interface Checkpoint {
  /**
   * Stable id of the machine definition that produced the snapshot: `machine.id`
   * when present, otherwise the Cluster entity type.
   */
  readonly definitionId: string

  /** Application-controlled deployment or migration version. */
  readonly version: string

  /**
   * Position in the entity's checkpoint history: `1` for its first checkpoint,
   * then one more than the checkpoint it replaces.
   */
  readonly revision: number

  /** What produced this checkpoint from the one before it. */
  readonly origin: Checkpoint.Origin

  /**
   * Encoded logical machine state and completed outputs. For a failed machine,
   * the last state before the failure.
   */
  readonly snapshot: Machine.Machine.EncodedSnapshot

  /** Whether the machine can still take steps, or failed. */
  readonly status: Checkpoint.Status
}

/**
 * Types of the parts of a Cluster machine {@link Checkpoint}.
 *
 * @category models
 * @since 0.48.0
 */
export declare namespace Checkpoint {
  /**
   * What produced a checkpoint.
   *
   * **Details**
   *
   * Only a request has an id to deduplicate. A checkpoint of any other origin is
   * guarded by its revision alone.
   *
   * @category models
   * @since 0.48.0
   */
  export type Origin = Origin.Request | Origin.Invocation | Origin.Timers

  /**
   * Types for what produced a checkpoint.
   *
   * @category models
   * @since 0.48.0
   */
  export namespace Origin {
    /**
     * A Cluster request.
     *
     * @category models
     * @since 0.48.0
     */
    export interface Request {
      readonly _tag: "Request"

      /** Id that `Storage.commit` deduplicates. */
      readonly requestId: Snowflake
    }

    /**
     * The end of an invocation, or its failure to start.
     *
     * @category models
     * @since 0.48.0
     */
    export interface Invocation extends InvocationKey {
      readonly _tag: "Invocation"
    }

    /**
     * Due times for timers of the state that was stored without one.
     *
     * **Details**
     *
     * No step was taken, and the snapshot is the one before it. This origin
     * occurs when an entity comes up in a state that was stored before the
     * machine declared one of its timers.
     *
     * @category models
     * @since 0.48.0
     */
    export interface Timers {
      readonly _tag: "Timers"
    }
  }

  /**
   * Names one invocation of a machine.
   *
   * @category models
   * @since 0.48.0
   */
  export interface InvocationKey {
    /** Path of the state that owns the invocation. */
    readonly path: string

    /** Id of the invocation within its state. */
    readonly id: string
  }

  /**
   * Progress of the invocations of active states, by the path of the state and
   * then by the id of the invocation within it.
   *
   * **Details**
   *
   * An effect that should run has no entry. A timer has an entry from the step
   * that enters its state, unless its duration cannot be evaluated, which fails
   * the machine. An entry is removed when its state exits, and no entry is
   * `Waiting` once the machine is final.
   *
   * @category models
   * @since 0.48.0
   */
  export interface Invocations {
    readonly [path: string]: { readonly [id: string]: Progress }
  }

  /**
   * How far one invocation of an active state has come.
   *
   * @category models
   * @since 0.48.0
   */
  export type Progress = Progress.Settled | Progress.Waiting

  /**
   * Types for the progress of an invocation.
   *
   * @category models
   * @since 0.48.0
   */
  export namespace Progress {
    /**
     * The invocation ended while its state stayed active. It does not run again
     * until that state is entered again.
     *
     * @category models
     * @since 0.48.0
     */
    export interface Settled {
      readonly _tag: "Settled"
    }

    /**
     * The invocation is a timer that has not completed.
     *
     * @category models
     * @since 0.48.0
     */
    export interface Waiting {
      readonly _tag: "Waiting"

      /**
       * When the timer completes, in milliseconds since the Unix epoch. An
       * integer that a date can name, which is the last such instant for a
       * duration that ends later or never.
       */
      readonly dueAt: number
    }
  }

  /**
   * Whether the machine can still take steps, or failed.
   *
   * @category models
   * @since 0.48.0
   */
  export type Status = Status.Active | Status.Failed

  /**
   * Types for the status of a checkpoint.
   *
   * @category models
   * @since 0.48.0
   */
  export namespace Status {
    /**
     * The machine has not failed. A machine in a final state is active too: its
     * snapshot says that it is final.
     *
     * @category models
     * @since 0.48.0
     */
    export interface Active {
      readonly _tag: "Active"

      /**
       * Timers that wait, and invocations that ended while their state stayed
       * active.
       */
      readonly invocations: Invocations
    }

    /**
     * The machine failed. It is terminal, runs no work, and rejects every later
     * request as `MachineFailed`.
     *
     * @category models
     * @since 0.48.0
     */
    export interface Failed {
      readonly _tag: "Failed"

      /** Human-readable rendering of the failure, of bounded length. */
      readonly failure: string
    }
  }
}

/**
 * Result of loading a checkpoint for a Cluster machine request.
 *
 * **Details**
 *
 * `processed` reports whether the exact Cluster request id was already
 * committed. Storage implementations must retain enough request ids to detect
 * redelivery even after later requests and invocations have advanced the
 * checkpoint.
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
 * Result of atomically committing a Cluster machine checkpoint.
 *
 * **Details**
 *
 * The results are ordered. `Duplicate` takes precedence over
 * `RevisionConflict`, so a redelivered request is recognized after later
 * checkpoints have advanced the revision. Only a checkpoint whose origin is a
 * request can be a `Duplicate`.
 *
 * @category models
 * @since 0.4.0
 */
export type CommitResult = CommitResult.Committed | CommitResult.Duplicate | CommitResult.RevisionConflict

/**
 * Constructors and types for Cluster machine commit results.
 *
 * @category models
 * @since 0.4.0
 */
export const CommitResult: {
  Committed: () => CommitResult.Committed
  Duplicate: () => CommitResult.Duplicate
  RevisionConflict: () => CommitResult.RevisionConflict
} = Protocol.CommitResult

/**
 * Types for Cluster machine commit results.
 *
 * @category models
 * @since 0.4.0
 */
export declare namespace CommitResult {
  /**
   * Indicates that the checkpoint was committed, atomically with the request id
   * of its origin when it has one. The checkpoint directly followed the stored
   * one.
   *
   * @category models
   * @since 0.4.0
   */
  export interface Committed {
    readonly _tag: "Committed"
  }

  /**
   * Indicates that the request id was already committed, whatever the revision
   * of the checkpoint. Nothing was written.
   *
   * @category models
   * @since 0.4.0
   */
  export interface Duplicate {
    readonly _tag: "Duplicate"
  }

  /**
   * Indicates that the origin was not a request committed before, and that the
   * stored checkpoint is not the one this commit replaces. Nothing was written.
   *
   * @category models
   * @since 0.48.0
   */
  export interface RevisionConflict {
    readonly _tag: "RevisionConflict"
  }
}

/**
 * Checkpoint persistence service used by Cluster machines.
 *
 * **When to use**
 *
 * Use to connect `ClusterMachine` to a durable checkpoint store that can
 * atomically deduplicate request ids and compare-and-set the current
 * checkpoint.
 *
 * **Details**
 *
 * `loadForRequest` returns the latest checkpoint of an entity and whether a
 * request id was already committed for it. `load` returns the checkpoint alone,
 * for the inputs that are not requests: an entity that wakes up, and the end of
 * an invocation.
 *
 * `commit` decides and writes atomically, in this order:
 *
 * 1. `Duplicate` when `checkpoint.origin` is a request whose id was already
 *    committed, whatever the revision. A checkpoint of any other origin is never
 *    a duplicate.
 * 2. `RevisionConflict` when the stored revision is not exactly
 *    `checkpoint.revision - 1`. An entity without a checkpoint has revision
 *    `0`, so its first checkpoint has revision `1`.
 * 3. `Committed` otherwise. The checkpoint replaces the stored one, and the
 *    request id of its origin, when it has one, is recorded with it.
 *
 * Each live entity loads its checkpoint once and keeps the decoded state in
 * memory, so most inputs only call `commit`. Storage remains the truth: memory
 * advances only after the whole transaction succeeded, and is loaded again
 * after any other outcome. Before a request is rejected, `loadForRequest` is
 * called to recognize a redelivery that was already committed.
 *
 * The due time of a timer is part of the checkpoint that enters its state, so
 * storing the checkpoint whole is all that timers require. An entity that loads a
 * state with a timer without a due time, which an earlier deployment can leave
 * behind, commits one more checkpoint before it starts any work. Its origin is
 * `Checkpoint.Origin.Timers`, and `commit` treats it as any origin that is not a
 * request.
 *
 * **Gotchas**
 *
 * The revision check is what stops an entity that lost its shard, and still
 * holds an older state, from overwriting a newer checkpoint. It must be part of
 * the same atomic write, such as an update conditional on the stored revision
 * together with an insert that fails when a checkpoint exists. Comparing in a
 * separate read is not enough.
 *
 * For checkpoint and emitted-message persistence to commit atomically, this
 * service must join the transaction opened through the configured
 * `MessageStorage`. The reply is persisted after that transaction; storing the
 * request id with the checkpoint makes a redelivery recover that reply without
 * applying the transition again. A separate transaction or database cannot
 * provide checkpoint-and-emission atomicity.
 *
 * A failed operation never fails the machine. An input that is not a request is
 * retried for as long as the entity lives.
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
 * **Details**
 *
 * `InvalidEvent` reports an event that {@link Client} refused before sending
 * it, because its schema or the protocol of the machine refuses it. The
 * machine never sees such an event.
 *
 * `DefinitionIdMismatch` reports a checkpoint whose `definitionId` is not the id
 * of the machine that loaded it. `PersistenceFailure` reports storage that
 * failed. `RevisionConflict` reports storage that worked and refused the request,
 * because another instance of the entity advanced the checkpoint both times the
 * request was applied.
 * `MachineFailed` reports a machine whose stored status is `Failed`, and its
 * message is the stored failure. A request that was committed before the
 * failure is still answered as accepted.
 *
 * @category models
 * @since 0.4.0
 */
export const RejectionReason: typeof Protocol.RejectionReason = Protocol.RejectionReason

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
 * **Details**
 *
 * It is a yieldable error, which {@link Client} reports in its error channel,
 * and the raw `send` RPC of the entity returns as a value of {@link SendResult}.
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
export const SendResult: typeof Protocol.SendResult = Protocol.SendResult

type SendRpc<Events extends ReadonlyArray<Machine.Machine.TaggedSchema>> = Rpc.Rpc<
  "send",
  Schema.Union<Events>,
  typeof SendResult
>

type MachineEvents<M extends Machine.Machine.Any> = Machine.Machine.InputEvents<M>

type MachineEmits<M extends Machine.Machine.Any> = Machine.Machine.EmittedEvents<M>

/**
 * Cluster adapter for one machine definition and entity type.
 *
 * **Details**
 *
 * The adapter exposes one persisted `send` RPC, and {@link Client}s that send
 * through it as a local reference sends. Each live entity keeps one
 * machine instance in memory, which applies requests and the outcomes of invoked
 * effects and timers one at a time. Every accepted request advances the
 * checkpoint at most once.
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
   * Creates clients for the entities of this machine, one per entity id, like
   * `Entity.client`.
   *
   * **Example** (Sending an event built by a constructor)
   *
   * ```ts import.meta.vitest
   * import { Machine } from "@typeonce/effect-machine"
   * import { ClusterMachine } from "@typeonce/effect-machine/cluster"
   * import { Effect, Schema } from "effect"
   *
   * const Events = Machine.events({ Rename: { name: Schema.NonEmptyString } })
   * const machine = Machine.make({
   *   root: Machine.state({ states: { Draft: { fields: { name: Schema.String } } } }),
   *   events: Events
   * }).handle({
   *   initial: { target: "Draft", data: { name: "untitled" } },
   *   states: { Draft: { on: { Rename: { target: "Draft", data: ({ event }) => ({ name: event.name }) } } } }
   * })
   *
   * const adapter = ClusterMachine.make("Document", machine, { version: "1" })
   *
   * // Run with a Cluster runner, which provides `Sharding`.
   * const rename = Effect.gen(function*() {
   *   const client = (yield* adapter.client)("document-1")
   *   yield* client.send(Events.Rename({ name: "report" })).pipe(
   *     Effect.catchTag("Rejected", (rejected) => Effect.logWarning(rejected.reason))
   *   )
   * })
   *
   * Effect.isEffect(rename) // => true
   * ```
   *
   * @since 0.48.0
   */
  readonly client: Effect.Effect<(entityId: string) => Client<M>, never, Sharding.Sharding>

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
   * An `enqueue` that fails rejects the request that emitted. An event emitted
   * by the outcome of an invoked effect or timer has no request to reject, so
   * that step is retried until it is stored. Without `enqueue`, it fails the
   * machine.
   *
   * @since 0.4.0
   */
  readonly toLayer: <R = never>(options?: {
    readonly enqueue?: (
      event: Machine.Machine.EmittedEventOf<MachineEmits<M>>
    ) => Effect.Effect<void, unknown, R>
  }) => Layer.Layer<never, never, Storage | MessageStorage.MessageStorage | Sharding.Sharding | R | Services>
}

/**
 * Failures of Cluster that keep a request from reaching an entity or its reply
 * from reaching the caller.
 *
 * @category errors
 * @since 0.48.0
 */
export type ClientError =
  | ClusterError.MailboxFull
  | ClusterError.AlreadyProcessingMessage
  | ClusterError.PersistenceError
  | ClusterError.EntityNotAssignedToRunner

/**
 * A client for one Cluster machine, addressed by its entity id.
 *
 * **Details**
 *
 * `send` takes what `send` of a local machine reference takes: an event of the
 * machine's input protocol, as a plain value or as built by a constructor of
 * `Machine.events`. It decodes the event as a local reference does, sends it
 * through the persisted `send` RPC of the entity, and succeeds once the request
 * is committed or recognized as a redelivery.
 *
 * An event that its schema refuses is rejected as `InvalidEvent` before it is
 * sent, and the machine never sees it. A request that the machine rejects fails
 * with the same {@link Rejected}, carrying its reason. A local machine instead
 * fails when it is sent an event that its schema refuses, because a local
 * `send` does not wait for the step.
 *
 * `snapshot`, `changes`, and `join` read the machine from {@link Storage}, which
 * is the truth, and never ask the entity. A read works from any process that
 * reaches the store, whichever runner owns the entity and whether it is in
 * memory or not. It does not wake the entity or keep it alive, so a machine that
 * is passivated, moved, or recovered after a restart is read the same way.
 *
 * **Gotchas**
 *
 * Failures of Cluster itself, such as a full mailbox, are {@link ClientError}s.
 * A request that ended in one may still have been delivered, and is delivered at
 * most once when it is sent again.
 *
 * A remote view is narrower than a local `MachineRef`. Reads see committed
 * checkpoints only, and `changes` reads again after each `readInterval`, so it
 * may skip checkpoints committed between two reads and sees a change up to one
 * interval late. A failed machine carries the text of its failure, not a
 * `Cause`. There is no `stopped` status, since a Cluster machine is not
 * stopped, and nothing is read before the first event is committed.
 *
 * @category models
 * @since 0.48.0
 */
export interface Client<M extends Machine.Machine.Any> {
  /** Entity id of the machine this client addresses. */
  readonly entityId: string

  /** Sends one input event and waits until it is committed or rejected. */
  readonly send: (
    event: Machine.Machine.EventInputOf<MachineEvents<M>>
  ) => Effect.Effect<void, Rejected | ClientError>

  /**
   * Reads the latest committed checkpoint, or `None` when the machine has not
   * committed one yet.
   */
  readonly snapshot: Effect.Effect<
    Option.Option<Snapshot<M>>,
    ReadError | ClusterError.PersistenceError,
    ReadServices<M>
  >

  /**
   * Streams the latest committed checkpoint and the later ones it reads, once
   * each, and ends after a `done` or `failed` one. It waits while the machine
   * has committed none.
   */
  readonly changes: Stream.Stream<Snapshot<M>, ReadError | ClusterError.PersistenceError, ReadServices<M>>

  /**
   * Waits for the output of the machine, or fails with
   * {@link MachineFailedError} when it failed.
   */
  readonly join: Effect.Effect<
    Machine.Machine.Output<M>,
    MachineFailedError | ReadError | ClusterError.PersistenceError,
    ReadServices<M>
  >
}

/**
 * Services that reading a Cluster machine from outside requires: the
 * {@link Storage} that holds its checkpoints, and what its state schemas need
 * to decode.
 *
 * @category models
 * @since 0.48.0
 */
export type ReadServices<M extends Machine.Machine.Any> =
  | Storage
  | Machine.Machine.SnapshotDecodingServices<Machine.Machine.States<M>>

/**
 * A committed checkpoint of a Cluster machine, as a {@link Client} reads it.
 *
 * **Details**
 *
 * `revision` orders the checkpoints of one machine. A `done` machine carries
 * its output, as its final state computes it. A `failed` machine carries the
 * text of the failure that ended it, and the last state it committed before.
 *
 * @category models
 * @since 0.48.0
 */
export type Snapshot<M extends Machine.Machine.Any> =
  | {
    readonly status: "active"
    readonly revision: number
    readonly state: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  }
  | {
    readonly status: "done"
    readonly revision: number
    readonly state: Machine.Machine.Snapshot<Machine.Machine.States<M>>
    readonly output: Machine.Machine.Output<M>
  }
  | {
    readonly status: "failed"
    readonly revision: number
    readonly state: Machine.Machine.Snapshot<Machine.Machine.States<M>>
    readonly failure: string
  }

/**
 * Why a {@link Client} could not read a checkpoint: it was written by another
 * definition or version, or it is not one that this machine can hold.
 *
 * @category errors
 * @since 0.48.0
 */
export { ReadError }

/**
 * Reasons for a {@link ReadError}.
 *
 * @category errors
 * @since 0.48.0
 */
export const ReadFailureReason: typeof Protocol.ReadFailureReason = Protocol.ReadFailureReason

/**
 * Reason for a {@link ReadError}.
 *
 * @category errors
 * @since 0.48.0
 */
export type ReadFailureReason = typeof ReadFailureReason.Type

/**
 * The failure of a Cluster machine that `join` waited for, as the text that
 * the machine stored when it failed.
 *
 * @category errors
 * @since 0.48.0
 */
export { MachineFailedError }

type MachineServices<M extends Machine.Machine.Any> =
  | Machine.Machine.Services<M>
  | Machine.Machine.SnapshotDecodingServices<Machine.Machine.States<M>>
  | Machine.Machine.SnapshotEncodingServices<Machine.Machine.States<M>>

type IsAny<A> = 0 extends (1 & A) ? true : false

type IsNever<A> = [A] extends [never] ? true : false

type IsUnknown<A> = IsAny<A> extends true ? false : unknown extends A ? true : false

type IsJsonEncoded<S extends Schema.Top> = IsAny<S["Encoded"]> extends true ? false
  : IsNever<S["Encoded"]> extends true ? false
  : IsUnknown<S["Encoded"]> extends true ? false
  : [S["Encoded"]] extends [Schema.Json] ? true
  : false

type NonJsonState<States extends Machine.Machine.StateSchemas> = Machine.Machine.ValuedStateIdentifier<States> extends
  infer StateId
  ? StateId extends Machine.Machine.ValuedStateIdentifier<States> ?
    IsJsonEncoded<Machine.Machine.SchemaByIdentifier<States, StateId>> extends true ? never : StateId
  : never
  : never

type NonJsonOutput<States extends Machine.Machine.StateSchemas> = Machine.Machine.DeclaredOutputState<States> extends
  infer StateId
  ? StateId extends Machine.Machine.DeclaredOutputState<States> ?
    Machine.Machine.NodeByIdentifier<States, StateId> extends {
      readonly output: infer Output extends Schema.Top
    } ? IsJsonEncoded<Output> extends true ? never : StateId
    : never
  : never
  : never

type NonJsonInputEvent<Events extends ReadonlyArray<Machine.Machine.TaggedSchema>> = {
  readonly [Index in keyof Events]: Events[Index] extends infer EventSchema extends Machine.Machine.TaggedSchema
    ? IsJsonEncoded<EventSchema> extends true ? never : Machine.Machine.TagOf<EventSchema>
    : never
}[number]

type EnsureJsonEncoded<
  States extends Machine.Machine.StateSchemas,
  InputEvents extends ReadonlyArray<Machine.Machine.TaggedSchema>
> = [NonJsonState<States> | NonJsonOutput<States> | NonJsonInputEvent<InputEvents>] extends [never] ? unknown
  : {
    readonly "~effect/ClusterMachine/NonJsonEncoded": {
      readonly states: NonJsonState<States>
      readonly outputs: NonJsonOutput<States>
      readonly inputEvents: NonJsonInputEvent<InputEvents>
    }
  }

type UnsupportedInvocation<R> = R extends Machine.InvocationSupport<infer Kind> ? Kind : never

type UnsupportedCapability<R> = R extends Machine.MachineRuntime ? "MachineRuntime" : never

// This host supports no kind that `InvocationSupport` names, so a kind added to
// it is refused until this host states that it runs it.
type EnsureSupported<R> = IsAny<R> extends true ? unknown
  : [UnsupportedInvocation<R> | UnsupportedCapability<R>] extends [never] ? unknown
  : {
    readonly "~effect/ClusterMachine/UnsupportedProcessLocal": {
      readonly invocations: UnsupportedInvocation<R>
      readonly capabilities: UnsupportedCapability<R>
    }
  }

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
 * `MessageStorage` transaction marker. A request rejected as `EmissionFailure`
 * keeps the checkpoint it had already committed. The outcome of an invoked
 * effect or timer whose `enqueue` fails keeps it too, so it is not applied again.
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
 * checkpoints are checked for their definition id and version, decoded, and
 * resumed without rerunning initial entry behavior. Final checkpoints accept
 * later requests as no-ops. The definition id is `machine.id` when present,
 * otherwise the Cluster entity type.
 *
 * A live entity loads its checkpoint when it comes up, or for its first request
 * when the machine invokes nothing, and then keeps the decoded state in memory
 * until the entity is passivated or restarted. Storage remains the truth. A
 * request whose state turns out to be behind storage is applied again to the
 * stored state, and is rejected as `RevisionConflict` when storage has moved
 * again.
 *
 * Effects invoked by active states run in the live entity. Work starts once the
 * step that entered its state is stored, and stops once the step that exited it
 * is stored. The end of the work is applied as a step of its own, in order with
 * requests, and only the state it leads to is stored, never the result itself.
 * While work should run the entity is kept alive, so it is not passivated, and
 * Cluster brings it up on another runner after a crash. It is kept alive through
 * `Entity.keepAlive`, so a host that provides an `Entity.KeepAliveHandler` is
 * told when to keep it, and when to let it go.
 *
 * An entity that comes up starts the work of its stored state again. Input
 * mappers run again against that state, with `Machine.InitialEvent` as their
 * event, as they do for `LocalMachine.resume`. An invocation that ended while its
 * state stayed active is not started again until its state is entered again.
 *
 * A timer is stored as the time at which it is due, in the same checkpoint as the
 * step that enters its state. The live entity waits for that time and then
 * applies the completion as a step of its own. An entity that comes up again,
 * here or on another runner, waits only for the time that remains, and completes
 * a timer whose time has passed at once. Leaving the state cancels the timer, and
 * entering it again stores a new due time. `LocalMachine.resume` differs: it starts the
 * full duration again.
 *
 * The duration of a timer is evaluated after the step that enters its state is
 * planned and before that step is stored, and not again while its due time is
 * stored. The local runtime evaluates it once the state is entered, in order with
 * the other invocations of the state. A duration that cannot be evaluated does
 * not reject the request. The step is stored, and the machine then fails as it
 * does locally.
 *
 * Work that ends in a way the model does not handle, an outcome that cannot be
 * applied, and a source that cannot be constructed fail the machine, as they do
 * locally. The failure is stored with the last state, and every later request is
 * rejected as `MachineFailed`. There is no retry of failed work: a model that
 * recovers declares `onFailure`.
 *
 * A machine that this host cannot run does not compile: one whose states invoke a
 * Stream, a `Logic`, or a child machine, or whose invoked work requires
 * `Machine.MachineRuntime`, as `Machine.spawn`, `Machine.sendTo`, and
 * `Machine.stopChild` do. The error names the property
 * `~effect/ClusterMachine/UnsupportedProcessLocal`, and lists there every
 * invocation kind and capability to replace with an Effect or a timer. A source
 * that is registered and never invoked is accepted.
 *
 * **Gotchas**
 *
 * Work runs at least once and must be safe to repeat. It runs again after a
 * crash, a move to another runner, a restart of the entity, and when another
 * instance advanced the checkpoint, and it can run twice at the same time while
 * a shard moves. One result is applied. Results are not stored, so a result that
 * was not applied before a crash is computed again.
 *
 * A storage or `enqueue` failure never fails the machine. An outcome that cannot
 * be stored is retried for as long as the entity lives.
 *
 * Use `effect` 4.1.5 or later. Earlier versions answer the keep-alive request
 * of an entity after about ten minutes, so a machine whose work runs or whose
 * timer waits longer would not come up again after a crash.
 *
 * An entity stays in memory while a timer waits, so a very long timer holds
 * memory for as long as it waits. Due times are read from the wall clock of the
 * runner, so runners whose clocks differ complete a timer that moves between them
 * that much earlier or later.
 *
 * A state that was stored before the machine declared one of its timers has no
 * due time for it. The entity evaluates the duration when it comes up, with
 * `Machine.InitialEvent`, and stores the due time before it starts any work. A
 * state that was stored with a timer the machine no longer declares is rejected
 * as `InvalidCheckpoint`, so migrate such checkpoints.
 *
 * The compiler reads only the requirements of a machine, so these uses of a local
 * process compile and fail at run time:
 *
 * - A step whose plan contains a command, from `enqueue.sendTo` or
 *   `enqueue.stop`, and an action-time `runtime.raise`. They reject the request as
 *   `UnsupportedProcessLocal`, or fail the machine when the step applies an
 *   outcome. Planning-time raised events remain part of the current macrostep.
 * - Work that uses `self.send`, `self.sessionId`, or an operation of `children`
 *   from the context of its input mapper. It fails the machine. Machines cannot
 *   address each other yet: that `self` only names the machine, and there is no
 *   `parent`.
 * - A machine whose requirements are `any`, such as an erased one. When any of its
 *   states declares an unsupported invocation, it rejects every request as
 *   `UnsupportedProcessLocal`. Work of such a machine that requires
 *   `Machine.MachineRuntime` fails the machine.
 *
 * A deployment that adds an invocation to a state does not wake the entities
 * that are already in it. Their work starts when they come up.
 *
 * A request redelivered to a live entity is planned again before storage
 * recognizes it. The plan is discarded, but its resolvers have run again, and so
 * have the input mappers and sources of the timers it enters, so they must not
 * perform effects.
 *
 * A checkpoint changed outside the bridge while an entity is live is noticed
 * through its revision, so such a change must also advance the revision.
 *
 * Arbitrary action effects may run again after a crash before checkpoint
 * commit, so the bridge does not provide exactly-once external effects.
 * State values, completion outputs, and public input events must declare
 * JSON-compatible encoded representations. Local and internal event protocols,
 * and the inputs, outputs, and errors of invoked work, remain unrestricted
 * because they do not cross the Cluster boundary.
 *
 * **Example** (Adapting a machine to an entity)
 *
 * ```ts import.meta.vitest
 * import { Machine } from "@typeonce/effect-machine"
 * import { ClusterMachine } from "@typeonce/effect-machine/cluster"
 *
 * const machine = Machine.make({
 *   root: Machine.state({ states: { Idle: {} } }),
 *   events: Machine.events({})
 * }).handle({
 *   initial: { target: "Idle" }
 * })
 *
 * const adapter = ClusterMachine.make("IdleMachine", machine, { version: "1" })
 *
 * adapter.entity.type // => "IdleMachine"
 * ```
 *
 * **Example** (Running an invoked effect in an entity)
 *
 * ```ts import.meta.vitest
 * import { Machine } from "@typeonce/effect-machine"
 * import { ClusterMachine } from "@typeonce/effect-machine/cluster"
 * import { Effect, Schema } from "effect"
 *
 * const machine = Machine.make({
 *   id: "Invoice",
 *   root: Machine.state({
 *     states: {
 *       Draft: {},
 *       Sending: { fields: { invoiceId: Schema.String } },
 *       Sent: { fields: { receipt: Schema.String } },
 *       Rejected: { fields: { reason: Schema.String } }
 *     }
 *   }),
 *   events: Machine.events({ Send: { invoiceId: Schema.String } }),
 *   effects: {
 *     // Can run more than once, so the invoice id makes it safe to repeat.
 *     send: (invoiceId: string) =>
 *       invoiceId === "" ? Effect.fail({ reason: "No invoice" }) : Effect.succeed(`receipt-${invoiceId}`)
 *   }
 * }).handle({
 *   initial: { target: "Draft" },
 *   states: {
 *     Draft: { on: { Send: { target: "Sending", data: ({ event }) => ({ invoiceId: event.invoiceId }) } } },
 *     Sending: {
 *       invoke: {
 *         src: "send",
 *         input: ({ state }) => state.invoiceId,
 *         onDone: { target: "Sent", data: ({ output }) => ({ receipt: output }) },
 *         onFailure: { target: "Rejected", data: ({ error }) => ({ reason: error.reason }) }
 *       }
 *     }
 *   }
 * })
 *
 * const adapter = ClusterMachine.make("Invoice", machine, { version: "1" })
 *
 * // Provide the layer with a Cluster runner and a durable `ClusterMachine.Storage`.
 * const layer = adapter.toLayer()
 *
 * adapter.entity.type // => "Invoice"
 * ```
 *
 * **Example** (Waiting for a timer that survives its runner)
 *
 * ```ts import.meta.vitest
 * import { Machine } from "@typeonce/effect-machine"
 * import { ClusterMachine } from "@typeonce/effect-machine/cluster"
 * import { Schema } from "effect"
 *
 * const machine = Machine.make({
 *   id: "Trial",
 *   root: Machine.state({
 *     states: {
 *       Inactive: {},
 *       Running: { fields: { days: Schema.Number } },
 *       Expired: {}
 *     }
 *   }),
 *   events: Machine.events({ Start: { days: Schema.Number }, Cancel: {} }),
 *   timers: { trial: (days: number) => ({ days }) }
 * }).handle({
 *   initial: { target: "Inactive" },
 *   states: {
 *     Inactive: { on: { Start: { target: "Running", data: ({ event }) => ({ days: event.days }) } } },
 *     Running: {
 *       invoke: { src: "trial", input: ({ state }) => state.days, onDone: { target: "Expired" } },
 *       on: { Cancel: { target: "Inactive" } }
 *     }
 *   }
 * })
 *
 * const adapter = ClusterMachine.make("Trial", machine, { version: "1" })
 *
 * adapter.entity.type // => "Trial"
 * ```
 *
 * **Example** (Refusing a machine that Cluster cannot run)
 *
 * ```ts import.meta.vitest
 * import { Machine } from "@typeonce/effect-machine"
 * import { ClusterMachine } from "@typeonce/effect-machine/cluster"
 * import { Effect, Stream } from "effect"
 *
 * const definition = Machine.make({
 *   id: "Sensor",
 *   root: Machine.state({ states: { Reading: {}, Read: {} } }),
 *   events: Machine.events({}),
 *   effects: { read: Effect.succeed(20) },
 *   streams: { readings: Stream.make(20, 21) }
 * })
 *
 * const streaming = definition.handle({
 *   initial: { target: "Reading" },
 *   states: {
 *     Reading: { invoke: { src: "readings", onElement: { stay: true }, onDone: { target: "Read" } } }
 *   }
 * })
 *
 * // @ts-expect-error Invokes a Stream: { invocations: "Stream"; capabilities: never }
 * ClusterMachine.make("Sensor", streaming, { version: "1" })
 *
 * const reading = definition.handle({
 *   initial: { target: "Reading" },
 *   states: {
 *     Reading: { invoke: { src: "read", onDone: { target: "Read" } } }
 *   }
 * })
 *
 * const adapter = ClusterMachine.make("Sensor", reading, { version: "1" })
 *
 * adapter.entity.type // => "Sensor"
 * ```
 *
 * @see {@link Machine.InvocationSupport} for the requirement of each invocation kind.
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
  FinalStates extends Machine.Machine.StateIdentifier<States>,
  Output,
  Emits extends ReadonlyArray<Machine.Machine.TaggedSchema>,
  OutputStates extends Machine.Machine.StateIdentifier<States>,
  InputEvents extends ReadonlyArray<Machine.Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.Machine.TaggedSchema> = readonly []
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
      FinalStates,
      Output,
      Emits,
      OutputStates,
      InputEvents,
      ParentEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>
    & Machine.Machine.RootCompatible<ParentEvents>
    & EnsureJsonEncoded<States, InputEvents>
    & EnsureSupported<R>,
  options: {
    readonly version: string
    /**
     * How long `changes` and `join` of a {@link Client} wait between two reads.
     * Defaults to one second.
     */
    readonly readInterval?: Duration.Input | undefined
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
    FinalStates,
    Output,
    Emits,
    OutputStates,
    InputEvents,
    ParentEvents
  >,
  | R
  | Machine.Machine.SnapshotDecodingServices<States>
  | Machine.Machine.SnapshotEncodingServices<States>
> = internal.make
