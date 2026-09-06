/** Canonical checkpoint service and wire schemas for the Cluster adapter. */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ClusterError, EntityAddress, Snowflake } from "effect/unstable/cluster"
import type * as Public from "../../unstable/cluster/ClusterMachine.js"
import type { Checkpoint, LoadResult } from "../../unstable/cluster/ClusterMachine.js"
type EntityAddress = EntityAddress.EntityAddress
type PersistenceError = ClusterError.PersistenceError
type Snowflake = Snowflake.Snowflake

export type CommitResult = Public.CommitResult

export const CommitResult = {
  Committed: (): Public.CommitResult.Committed => ({ _tag: "Committed" }),
  Duplicate: (): Public.CommitResult.Duplicate => ({ _tag: "Duplicate" })
}

export class Storage extends Context.Service<Storage, {
  readonly load: (
    address: EntityAddress,
    requestId: Snowflake
  ) => Effect.Effect<LoadResult, PersistenceError>
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
  "EmissionFailure"
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
