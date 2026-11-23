/**
 * Runs Effect machines as persisted Cluster entities.
 *
 * Each live entity keeps one machine instance in memory, which applies requests
 * and runs the effects invoked by active states. {@link Storage} holds the
 * truth: every step commits a checkpoint to it, and an entity that comes up
 * anywhere continues from that checkpoint.
 *
 * @since 0.4.0
 */
import type { Entity, MessageStorage, Sharding, Snowflake } from "effect/cluster"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type { Rpc } from "effect/rpc"
import type * as Schema from "effect/Schema"
import * as internal from "../../internal/machine/cluster.js"
import * as Protocol from "../../internal/machine/clusterProtocol.js"
import { Accepted, Rejected, Storage } from "../../internal/machine/clusterProtocol.js"
import type { EnsureExecutable } from "../../internal/machine/readiness.js"
import type { ExcludeCompatibleRuntime } from "../../internal/machine/requirements.js"
import type * as Machine from "../../Machine.js"

type Snowflake = Snowflake.Snowflake

/**
 * Persisted machine checkpoint owned by the Cluster bridge.
 *
 * **Details**
 *
 * Machine identity and deployment version are stored around the generic
 * encoded snapshot. The origin records the input that produced the checkpoint.
 * The revision orders the checkpoints of one entity and decides which
 * checkpoint a commit may replace. The status says whether the machine failed.
 *
 * **Gotchas**
 *
 * Store and return every field unchanged. The bridge assigns them all, and
 * rejects a checkpoint whose revision is not a positive integer, or whose
 * status it does not know, as `InvalidCheckpoint`.
 *
 * @category models
 * @since 0.4.0
 */
export interface Checkpoint {
  /** Stable identity of the machine definition that produced the snapshot. */
  readonly machineId: string

  /** Application-controlled deployment or migration version. */
  readonly version: string

  /**
   * Position in the entity's checkpoint history: `1` for its first checkpoint,
   * then one more than the checkpoint it replaces.
   */
  readonly revision: number

  /** Input whose accepted step produced this checkpoint. */
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
   * Input that produced a checkpoint.
   *
   * **Details**
   *
   * Only a request has an id to deduplicate. A checkpoint that came from an
   * invocation is guarded by its revision alone.
   *
   * @category models
   * @since 0.48.0
   */
  export type Origin = Origin.Request | Origin.Invocation

  /**
   * Types for the input that produced a checkpoint.
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
       * Invocations that ended while their state stayed active. Their work does
       * not run again when the machine is recovered. An entry is removed when
       * its state exits.
       */
      readonly settled: ReadonlyArray<InvocationKey>
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
 *    committed, whatever the revision. A checkpoint whose origin is an
 *    invocation is never a duplicate.
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
 * `PersistenceFailure` reports storage that failed. `RevisionConflict` reports
 * storage that worked and refused the request, because another instance of the
 * entity advanced the checkpoint both times the request was applied.
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
 * The adapter exposes one persisted `send` RPC. Each live entity keeps one
 * machine instance in memory, which applies requests and the outcomes of invoked
 * effects one at a time. Every accepted request advances the checkpoint at most
 * once.
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
   * An `enqueue` that fails rejects the request that emitted. An event emitted
   * by the outcome of an invoked effect has no request to reject, so that step
   * is retried until it is stored. Without `enqueue`, it fails the machine.
   *
   * @since 0.4.0
   */
  readonly toLayer: <R = never>(options?: {
    readonly enqueue?: (
      event: Machine.Machine.EmittedEventOf<MachineEmits<M>>
    ) => Effect.Effect<void, unknown, R>
  }) => Layer.Layer<never, never, Storage | MessageStorage.MessageStorage | Sharding.Sharding | R | Services>
}

type MachineServices<M extends Machine.Machine.Any> =
  | ExcludeCompatibleRuntime<
    Machine.ExecutionServices<Machine.Machine.Services<M> | Machine.Machine.InitialServices<M>>,
    Machine.Machine.Event<M>,
    Machine.Machine.EmittedEvent<M>
  >
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
 * effect whose `enqueue` fails keeps it too, so it is not applied again.
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
 * Cluster brings it up on another runner after a crash.
 *
 * An entity that comes up starts the work of its stored state again. Input
 * mappers run again against that state, with `Machine.InitialEvent` as their
 * event, as they do for `Machine.resume`. An invocation that ended while its
 * state stayed active is not started again until its state is entered again.
 *
 * Work that ends in a way the model does not handle, an outcome that cannot be
 * applied, and a source that cannot be constructed fail the machine, as they do
 * locally. The failure is stored with the last state, and every later request is
 * rejected as `MachineFailed`. There is no retry of failed work: a model that
 * recovers declares `onFailure`.
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
 * Timers, streams, process logic, child machines, spawned children, action-time
 * `runtime.raise`, machine commands, subscriptions, and other process-local
 * state are not durable and are rejected. A machine that declares an unsupported
 * invocation in any state rejects every request as `UnsupportedProcessLocal`.
 * Planning-time raised events remain part of the current macrostep.
 *
 * Machines cannot address each other yet. Input mappers receive a `self` whose
 * `id` names the machine, no `parent`, and a `children` owner. Work that uses
 * `self.send`, `self.sessionId`, an operation of `children`, or an operation that
 * requires the runtime of a local machine, such as `Machine.sendTo`, fails the
 * machine.
 *
 * A deployment that adds an invocation to a state does not wake the entities
 * that are already in it. Their work starts when they come up.
 *
 * A request redelivered to a live entity is planned again before storage
 * recognizes it. The plan is discarded, but its resolvers have run again, so
 * they must not perform effects.
 *
 * A checkpoint changed outside the bridge while an entity is live is noticed
 * through its revision, so such a change must also advance the revision.
 *
 * Arbitrary action effects may run again after a crash before checkpoint
 * commit, so the bridge does not provide exactly-once external effects.
 * State values, completion outputs, and public input events must declare
 * JSON-compatible encoded representations. Local and internal event protocols,
 * and the inputs, outputs, and errors of invoked effects, remain unrestricted
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
      InitialE,
      InitialR,
      FinalStates,
      Output,
      Emits,
      OutputStates,
      InputEvents,
      ParentEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>
    & Machine.Machine.RootCompatible<ParentEvents>
    & EnsureJsonEncoded<States, InputEvents>,
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
    InputEvents,
    ParentEvents
  >,
  | ExcludeCompatibleRuntime<
    Machine.ExecutionServices<R | InitialR>,
    Machine.Machine.EventOf<Events>,
    Machine.Machine.EmittedEventOf<Emits>
  >
  | Machine.Machine.SnapshotDecodingServices<States>
  | Machine.Machine.SnapshotEncodingServices<States>
> = internal.make
