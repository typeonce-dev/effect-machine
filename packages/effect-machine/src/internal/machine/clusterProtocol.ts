/** Canonical checkpoint service and wire schemas for the Cluster adapter. */
import type { ClusterError, EntityAddress, Snowflake } from "effect/cluster"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Public from "../../unstable/cluster/ClusterMachine.js"
import type { Checkpoint, LoadResult } from "../../unstable/cluster/ClusterMachine.js"
type EntityAddress = EntityAddress.EntityAddress
type PersistenceError = ClusterError.PersistenceError
type Snowflake = Snowflake.Snowflake

export type CommitResult = Public.CommitResult

export const CommitResult = {
  Committed: (): Public.CommitResult.Committed => ({ _tag: "Committed" }),
  Duplicate: (): Public.CommitResult.Duplicate => ({ _tag: "Duplicate" }),
  RevisionConflict: (): Public.CommitResult.RevisionConflict => ({ _tag: "RevisionConflict" })
}

export class Storage extends Context.Service<Storage, {
  /** Reads the latest checkpoint of an entity. */
  readonly load: (
    address: EntityAddress
  ) => Effect.Effect<Option.Option<Checkpoint>, PersistenceError>
  /**
   * Reads the latest checkpoint of an entity, and whether `requestId` was
   * already committed for it, from one consistent view.
   */
  readonly loadForRequest: (
    address: EntityAddress,
    requestId: Snowflake
  ) => Effect.Effect<LoadResult, PersistenceError>
  /**
   * Replaces the checkpoint of an entity in one atomic decision:
   *
   * 1. `Duplicate` when the origin is a request whose id was already committed,
   *    whatever the revision. A checkpoint from an invocation is never a
   *    duplicate.
   * 2. `RevisionConflict` when the stored revision is not exactly
   *    `checkpoint.revision - 1`, where no stored checkpoint counts as `0`.
   * 3. `Committed` otherwise, with the checkpoint stored, and the request id
   *    recorded when the origin is a request.
   *
   * Only `Committed` writes.
   */
  readonly commit: (
    address: EntityAddress,
    checkpoint: Checkpoint
  ) => Effect.Effect<CommitResult, PersistenceError>
}>()("effect/cluster/ClusterMachine/Storage") {}

export class Accepted extends Schema.TaggedClass<Accepted>("effect/cluster/ClusterMachine/Accepted")(
  "Accepted",
  {}
) {}

export const RejectionReason = Schema.Literals([
  "MachineIdMismatch",
  "VersionMismatch",
  "InvalidCheckpoint",
  "UnsupportedProcessLocal",
  "TransitionFailure",
  "SnapshotEncodeFailure",
  "PersistenceFailure",
  "RevisionConflict",
  "EmissionFailure",
  "MachineFailed"
])

export type RejectionReason = typeof RejectionReason.Type

export class Rejected extends Schema.TaggedClass<Rejected>("effect/cluster/ClusterMachine/Rejected")(
  "Rejected",
  {
    reason: RejectionReason,
    message: Schema.String
  }
) {}

export const SendResult = Schema.Union([Accepted, Rejected])
