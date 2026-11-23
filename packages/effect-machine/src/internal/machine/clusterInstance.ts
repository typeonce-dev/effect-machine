/**
 * The live instance behind one active Cluster entity.
 *
 * @since 0.48.0
 */
import * as Cause from "effect/Cause"
import type { EntityAddress, MessageStorage, Snowflake } from "effect/cluster"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Semaphore from "effect/Semaphore"
import type * as Machine from "../../Machine.js"
import type { Checkpoint } from "../../unstable/cluster/ClusterMachine.js"
import { Accepted, Rejected, type RejectionReason, type Storage } from "./clusterProtocol.js"
import { toImpl } from "./implementation.js"
import * as internalMachine from "./machine.js"

type EntityAddress = EntityAddress.EntityAddress
type Snowflake = Snowflake.Snowflake
type Snapshot = Machine.Machine.Snapshot<any>
type SendResult = Accepted | Rejected

/** One event to apply, under the id that deduplicates it in `Storage`. */
export interface Input {
  readonly requestId: Snowflake
  readonly event: unknown
}

/**
 * One live instance of a machine, owned by one set of entity handlers.
 *
 * Cluster builds the handlers when an entity becomes active, and again when a
 * defect restarts it, so an instance lives exactly as long as its handlers.
 *
 * It owns the decoded machine state, as a cache of what `Storage` holds:
 *
 * - Memory is either unknown, or the state of one stored revision. An unknown
 *   memory is loaded by the next input.
 * - `apply` is the only way to advance the instance. Inputs are applied one at
 *   a time by the instance itself, whatever the concurrency of its callers.
 * - Memory is forgotten when an input starts, and set again only by an ending
 *   that proves what `Storage` holds: the whole transaction succeeded, or the
 *   input was refused before a commit was attempted. Every other ending,
 *   including a defect or an interruption, leaves it unknown.
 * - Memory may fall behind `Storage` while another instance still runs during a
 *   shard handover. Nothing is decided from memory alone: an advance is
 *   compared by `Storage.commit`, and a refusal is confirmed with `Storage`.
 *
 * @internal
 */
export interface ClusterInstance<R> {
  /**
   * Applies one input as one step and returns its reply.
   *
   * Only interruption leaves this effect, and it always leaves memory unknown.
   */
  readonly apply: (input: Input) => Effect.Effect<SendResult, never, R>
}

/** @internal */
export interface Options<R> {
  readonly machine: Machine.Machine.Any
  readonly machineId: string
  readonly version: string
  /** Arguments for the initial plan of an entity without a checkpoint. */
  readonly input: ReadonlyArray<unknown>
  readonly address: EntityAddress
  readonly storage: Storage["Service"]
  readonly messageStorage: MessageStorage.MessageStorage["Service"]
  readonly enqueue: ((event: any) => Effect.Effect<void, unknown, R>) | undefined
}

/** The machine state at one stored revision. */
interface Memory {
  /** Revision of the stored checkpoint, or `0` when the entity has none. */
  readonly revision: number

  /** State of the stored checkpoint; without one, the next step plans the initial state. */
  readonly state: Snapshot | undefined
}

/** The part of a machine plan that a step keeps. */
interface PlannedStep {
  readonly state: Snapshot
  readonly emitted: ReadonlyArray<unknown>
}

/** Ends a step, rolling its transaction back. */
class Refused extends Data.TaggedError("Refused")<{
  readonly rejected: Rejected

  /** What memory may hold after the rollback. */
  readonly memory: Memory | undefined

  /**
   * Whether an earlier delivery may have committed this input. `Storage` must
   * then be asked before the rejection is returned.
   */
  readonly confirm: boolean
}> {}

/** Ends a step that was based on a state `Storage` no longer holds. */
class Conflicted extends Data.TaggedError("Conflicted") {}

const reject = (reason: RejectionReason, message: string): Rejected => new Rejected({ reason, message })

const fail = (reason: RejectionReason, message: string): Effect.Effect<never, Rejected> =>
  Effect.fail(reject(reason, message))

const messageFromCause = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause)
  return squashed instanceof globalThis.Error ? squashed.message : String(squashed)
}

const rejectionFromCause = (cause: Cause.Cause<unknown>, reason: RejectionReason): Rejected => {
  const error = Cause.findErrorOption(cause)
  if (Option.isSome(error) && error.value instanceof Rejected) {
    return error.value
  }
  if (Option.isSome(error) && error.value instanceof internalMachine.ProcessLocalError) {
    return reject("UnsupportedProcessLocal", `${error.value.operation} is process-local and is not supported`)
  }
  return reject(reason, messageFromCause(cause))
}

/** Propagates an interruption without the typed failures that accompany it. */
const propagate = (cause: Cause.Cause<unknown>): Effect.Effect<never> =>
  Effect.failCause(
    Cause.fromReasons(
      cause.reasons.filter((reason): reason is Cause.Die | Cause.Interrupt => !Cause.isFailReason(reason))
    )
  )

/** Turns every failure of one stage of a step into a refusal. */
const refuse =
  (options: { readonly memory: Memory | undefined; readonly confirm: boolean }) =>
  <A, E, R>(stage: Effect.Effect<A, E, R>): Effect.Effect<A, Refused, R> =>
    Effect.catchCause(stage, (cause): Effect.Effect<never, Refused> =>
      Cause.hasInterrupts(cause)
        ? propagate(cause)
        : Effect.fail(new Refused({ rejected: rejectionFromCause(cause, "TransitionFailure"), ...options })))

const hasInvokes = (machine: Machine.Machine.Any): boolean =>
  Reflect.ownKeys(toImpl(machine).handlers).some((key) => toImpl(machine).handlers[key as string]?.invoke !== undefined)

const accepted = new Accepted({})

/** @internal */
export const make = <R>(options: Options<R>): Effect.Effect<ClusterInstance<R>> =>
  Effect.sync(() => {
    const { address, enqueue, machine, machineId, messageStorage, storage, version } = options
    const supported = !hasInvokes(machine)
    const semaphore = Semaphore.makeUnsafe(1)

    // Owned by `attempt`, which runs under the semaphore.
    let memory: Memory | undefined

    const load = (input: Input) =>
      storage.load(address, input.requestId).pipe(
        Effect.mapError((error) => reject("PersistenceFailure", String(error.cause))),
        Effect.filterOrFail(
          (loaded) => !loaded.processed || Option.isSome(loaded.checkpoint),
          () => reject("InvalidCheckpoint", "The request was recorded without a checkpoint")
        )
      )

    const decode = Effect.fnUntraced(function*(
      checkpoint: Checkpoint
    ): Effect.fn.Return<Memory, Rejected, R> {
      if (checkpoint.machineId !== machineId) {
        return yield* fail(
          "MachineIdMismatch",
          `Expected machine id ${machineId}, received ${checkpoint.machineId}`
        )
      }
      if (checkpoint.version !== version) {
        return yield* fail(
          "VersionMismatch",
          `Expected version ${version}, received ${checkpoint.version}`
        )
      }
      if (!Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1) {
        return yield* fail(
          "InvalidCheckpoint",
          `Expected a positive integer revision, received ${checkpoint.revision}`
        )
      }
      const state: Snapshot = yield* internalMachine.decodeSnapshot(machine, checkpoint.snapshot).pipe(
        Effect.mapError((error) => reject("InvalidCheckpoint", String(error.cause)))
      )
      return { revision: checkpoint.revision, state }
    })

    const plan = Effect.fnUntraced(function*(base: Memory, event: unknown): Effect.fn.Return<PlannedStep, unknown> {
      let state = base.state
      const emitted: Array<unknown> = []
      if (state === undefined) {
        const initial = yield* internalMachine.planInitial(machine, ...options.input)
        if (initial.commands.length > 0) {
          return yield* fail("UnsupportedProcessLocal", "Machine commands require a managed local process")
        }
        state = initial.state as Snapshot
        emitted.push(...initial.emittedEvents)
      }
      if (!internalMachine.isFinal(machine, state)) {
        const planned = yield* internalMachine.plan(machine, state, event)
        if (planned.commands.length > 0) {
          return yield* fail("UnsupportedProcessLocal", "Machine commands require a managed local process")
        }
        state = planned.next as Snapshot
        emitted.push(...planned.emittedEvents)
      }
      return { state, emitted }
    })

    // Everything a step decides before it changes `Storage`.
    const prepare = Effect.fnUntraced(function*(
      base: Memory,
      input: Input
    ): Effect.fn.Return<PlannedStep & { readonly checkpoint: Checkpoint }, unknown, R> {
      const { emitted, state } = yield* plan(base, input.event)
      const snapshot = yield* internalMachine.encodeSnapshot(machine, state).pipe(
        Effect.mapError((error) => reject("SnapshotEncodeFailure", String(error.cause)))
      )
      if (emitted.length > 0 && enqueue === undefined) {
        return yield* fail("EmissionFailure", "No durable enqueue handler was configured")
      }
      const checkpoint: Checkpoint = {
        machineId,
        version,
        revision: base.revision + 1,
        requestId: input.requestId,
        snapshot
      }
      return { state, emitted, checkpoint }
    })

    // The transaction body. Its value is what memory may hold once the
    // transaction around it has succeeded.
    const step = Effect.fnUntraced(function*(
      input: Input,
      known: Memory | undefined
    ): Effect.fn.Return<Memory | undefined, Refused | Conflicted, R> {
      if (!supported) {
        return yield* fail(
          "UnsupportedProcessLocal",
          "Machine invoke configurations are process-local and cannot be restored"
        ).pipe(refuse({ memory: known, confirm: true }))
      }

      let base = known
      if (base === undefined) {
        // A refusal that follows this answer needs no confirmation.
        const refuseLoad = refuse({ memory: undefined, confirm: false })
        const loaded = yield* refuseLoad(load(input))
        if (loaded.processed) {
          return undefined
        }
        base = Option.isNone(loaded.checkpoint)
          ? { revision: 0, state: undefined }
          : yield* refuseLoad(decode(loaded.checkpoint.value))
      }

      const { checkpoint, emitted, state } = yield* prepare(base, input).pipe(
        refuse({ memory: base, confirm: known !== undefined })
      )
      const committed = yield* storage.commit(address, checkpoint).pipe(
        Effect.mapError((error) => reject("PersistenceFailure", String(error.cause))),
        refuse({ memory: undefined, confirm: true })
      )
      switch (committed._tag) {
        case "Duplicate":
          return base
        case "RevisionConflict":
          return yield* new Conflicted()
        case "Committed": {
          if (enqueue !== undefined) {
            // `Committed` proves that no earlier delivery committed this input.
            yield* Effect.forEach(emitted, enqueue, { discard: true }).pipe(
              Effect.mapError((error) => reject("EmissionFailure", String(error))),
              refuse({ memory: undefined, confirm: false })
            )
          }
          return { revision: checkpoint.revision, state }
        }
      }
    })

    // Runs after the failed transaction, so the answer excludes its writes. A
    // commit whose transaction failed afterwards may still have taken effect.
    const confirm = (
      input: Input,
      refused: { readonly rejected: Rejected; readonly memory: Memory | undefined }
    ): Effect.Effect<SendResult, Conflicted> =>
      messageStorage.withTransaction(load(input)).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Cause.hasInterrupts(cause)
              ? propagate(cause)
              : Effect.succeed(rejectionFromCause(cause, "PersistenceFailure")),
          onSuccess: ({ checkpoint, processed }) => {
            const revision = Option.isNone(checkpoint) ? 0 : checkpoint.value.revision
            const stale = refused.memory !== undefined && refused.memory.revision !== revision
            if (stale && !processed) {
              return Effect.fail(new Conflicted())
            }
            return Effect.sync(() => {
              memory = stale ? undefined : refused.memory
              return processed ? accepted : refused.rejected
            })
          }
        })
      )

    const attempt = (input: Input): Effect.Effect<SendResult, Conflicted, R> =>
      Effect.suspend(() => {
        const known = memory
        memory = undefined
        return messageStorage.withTransaction(step(input, known)).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause): Effect.Effect<SendResult, Conflicted> => {
              if (Cause.hasInterrupts(cause)) {
                return propagate(cause)
              }
              const error = Option.getOrUndefined(Cause.findErrorOption(cause))
              if (error instanceof Conflicted) {
                return Effect.fail(error)
              }
              if (!(error instanceof Refused)) {
                return confirm(input, {
                  rejected: reject("PersistenceFailure", messageFromCause(cause)),
                  memory: undefined
                })
              }
              // A rollback that failed as well says nothing about `Storage`.
              const refused = Cause.hasDies(cause) ? { rejected: error.rejected, memory: undefined } : error
              if (error.confirm) {
                return confirm(input, refused)
              }
              return Effect.sync(() => {
                memory = refused.memory
                return refused.rejected
              })
            },
            onSuccess: (next) =>
              Effect.sync(() => {
                memory = next
                return accepted
              })
          })
        )
      })

    return {
      apply: (input) =>
        attempt(input).pipe(
          // A conflict leaves memory unknown, so the retry loads.
          Effect.catchTag("Conflicted", () => attempt(input)),
          Effect.catchTag("Conflicted", () =>
            Effect.succeed(reject(
              "RevisionConflict",
              "Another instance advanced the checkpoint while this request was applied"
            ))),
          Semaphore.withPermit(semaphore)
        )
    }
  })
