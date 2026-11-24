/**
 * Reads the stored state of a Cluster machine from outside its entity.
 *
 * A read goes to `Storage`, which is the truth, and never to the live instance,
 * so it does not depend on which runner owns the entity, does not wake it, and
 * does not keep it alive. Changes are observed by reading again, so a reader
 * sees committed checkpoints and may skip the ones committed between two reads.
 */
import type { ClusterError, EntityAddress } from "effect/cluster"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import type * as Machine from "../../Machine.js"
import type { Checkpoint, Snapshot } from "../../unstable/cluster/ClusterMachine.js"
import { readStatus } from "./clusterInstance.js"
import { MachineFailedError, ReadError, Storage } from "./clusterProtocol.js"
import * as internalMachine from "./machine.js"
import * as Planner from "./planner.js"

type PersistenceError = ClusterError.PersistenceError

type Services<M extends Machine.Machine.Any> =
  | Storage
  | Machine.Machine.SnapshotDecodingServices<Machine.Machine.States<M>>

export interface Reader<M extends Machine.Machine.Any> {
  readonly snapshot: Effect.Effect<Option.Option<Snapshot<M>>, ReadError | PersistenceError, Services<M>>
  readonly changes: Stream.Stream<Snapshot<M>, ReadError | PersistenceError, Services<M>>
  readonly join: Effect.Effect<
    Machine.Machine.Output<M>,
    MachineFailedError | ReadError | PersistenceError,
    Services<M>
  >
}

export interface Options {
  readonly machine: Machine.Machine.Any
  readonly definitionId: string
  readonly version: string
  readonly address: EntityAddress.EntityAddress
  readonly interval: Duration.Input
}

const invalid = (message: string) => new ReadError({ reason: "InvalidCheckpoint", message })

// Validates a checkpoint as an entity does when it loads one, so that a reader
// refuses what the entity would refuse.
const decode = Effect.fnUntraced(function*(
  options: Options,
  checkpoint: Checkpoint
): Effect.fn.Return<Snapshot<Machine.Machine.Any>, ReadError, any> {
  const { definitionId, machine, version } = options
  if (checkpoint.definitionId !== definitionId) {
    return yield* new ReadError({
      reason: "DefinitionIdMismatch",
      message: `Expected machine definition id ${definitionId}, received ${checkpoint.definitionId}`
    })
  }
  if (checkpoint.version !== version) {
    return yield* new ReadError({
      reason: "VersionMismatch",
      message: `Expected version ${version}, received ${checkpoint.version}`
    })
  }
  const { revision } = checkpoint
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return yield* invalid(`Expected a positive integer revision, received ${revision}`)
  }
  const status = readStatus(checkpoint.status)
  if (status === undefined) return yield* invalid("Expected an active or failed status")
  const state = yield* internalMachine.decodeSnapshot(machine, checkpoint.snapshot).pipe(
    Effect.mapError((error) => invalid(String(error.cause)))
  )
  if (status._tag === "Failed") return { status: "failed", revision, state, failure: status.failure }
  if (status._tag === "Stopped") return { status: "stopped", revision, state }
  if (!internalMachine.isFinal(machine, state)) return { status: "active", revision, state }
  const output = yield* Planner.getFinalOutputEffect(machine, state, Planner.InitialEvent).pipe(
    Effect.mapError((error) => invalid(String(error.cause)))
  )
  return { status: "done", revision, state, output }
})

export const make = <M extends Machine.Machine.Any>(options: Options): Reader<M> => {
  const snapshot = Effect.gen(function*() {
    const storage = yield* Storage
    return yield* storage.load(options.address)
  }).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.succeedNone,
      onSome: (checkpoint) => Effect.asSome(decode(options, checkpoint))
    }))
  ) as Reader<M>["snapshot"]

  // Reads again after each interval and emits every revision it has not seen,
  // ending after a terminal one. Reading again is also how a reader follows an
  // entity that is passivated or moves: there is no subscription to lose.
  const changes: Reader<M>["changes"] = Stream.fromEffectSchedule(
    snapshot,
    Schedule.spaced(Duration.fromInputUnsafe(options.interval))
  ).pipe(
    Stream.filter(Option.isSome),
    Stream.map((read) => read.value),
    Stream.changesWith((left, right) => left.revision === right.revision),
    Stream.takeUntil((read) => read.status !== "active")
  )

  const join: Reader<M>["join"] = changes.pipe(
    Stream.filter((read) => read.status !== "active"),
    Stream.runHead,
    Effect.flatMap((read) =>
      Option.isNone(read)
        ? Effect.die(new Error("A reader of a Cluster machine ended without a terminal checkpoint"))
        : read.value.status === "failed"
        ? Effect.fail(new MachineFailedError({ failure: read.value.failure }))
        : read.value.status === "stopped"
        ? Effect.fail(new MachineFailedError({ failure: "The child machine was stopped by its parent" }))
        : Effect.succeed(read.value.output)
    )
  )

  return { snapshot, changes, join }
}
