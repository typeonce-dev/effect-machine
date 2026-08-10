/**
 * Runs Effect machines as persisted Cluster entities.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  ClusterError,
  ClusterSchema,
  Entity,
  EntityAddress,
  MessageStorage,
  type Sharding,
  Snowflake
} from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import type * as Machine from "../../Machine.js"
import type { Checkpoint, ClusterMachine, LoadResult } from "../../unstable/cluster/ClusterMachine.js"
import * as internalMachine from "./machine.js"
import type { EnsureExecutable } from "./readiness.js"

type EntityAddress = EntityAddress.EntityAddress
type PersistenceError = ClusterError.PersistenceError
type Snowflake = Snowflake.Snowflake

export type CommitResult = CommitResult.Committed | CommitResult.Duplicate

export const CommitResult = {
  Committed: (): CommitResult.Committed => ({ _tag: "Committed" }),
  Duplicate: (): CommitResult.Duplicate => ({ _tag: "Duplicate" })
}

export declare namespace CommitResult {
  /**
   * Indicates that the request id and checkpoint were committed atomically.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Committed {
    readonly _tag: "Committed"
  }

  /**
   * Indicates that the request id was already committed.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Duplicate {
    readonly _tag: "Duplicate"
  }
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

type SendRpc<Events extends ReadonlyArray<Machine.Machine.TaggedSchema>> = Rpc.Rpc<
  "send",
  Schema.Union<Events>,
  typeof SendResult
>

type MachineEvents<M extends Machine.Machine.Any> = Machine.Machine.InputEvents<M>

type MachineEmits<M extends Machine.Machine.Any> = Machine.Machine.Emits<M>

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

const hasInvokes = (machine: Machine.Machine.Any): boolean =>
  Reflect.ownKeys(machine.handlers).some((key) => machine.handlers[key as string]?.invoke !== undefined)

const reject = (reason: RejectionReason, message: string): Rejected => new Rejected({ reason, message })

const fail = (reason: RejectionReason, message: string): Effect.Effect<never, Rejected> =>
  Effect.fail(reject(reason, message))

const messageFromCause = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause)
  return squashed instanceof globalThis.Error ? squashed.message : String(squashed)
}

const rejectionFromCause = (cause: Cause.Cause<unknown>): Rejected => {
  const error = Cause.findErrorOption(cause)
  if (Option.isSome(error) && error.value instanceof Rejected) {
    return error.value
  }
  if (Option.isSome(error) && error.value instanceof internalMachine.ProcessLocalError) {
    return reject("UnsupportedProcessLocal", `${error.value.operation} is process-local and is not supported`)
  }
  return reject("TransitionFailure", messageFromCause(cause))
}

const addressKey = (address: EntityAddress): string => `${address.entityType}\u0000${address.entityId}`

export const makeMemory: Effect.Effect<Storage["Service"]> = Effect.sync(() => {
  const entries = new Map<string, {
    checkpoint: Checkpoint
    readonly requests: Set<Snowflake>
  }>()
  return Storage.of({
    load: (address, requestId) =>
      Effect.sync(() => {
        const entry = entries.get(addressKey(address))
        return {
          checkpoint: Option.fromNullishOr(entry?.checkpoint),
          processed: entry?.requests.has(requestId) ?? false
        }
      }),
    commit: (address, checkpoint) =>
      Effect.sync(() => {
        const key = addressKey(address)
        const entry = entries.get(key)
        if (entry?.requests.has(checkpoint.requestId)) {
          return CommitResult.Duplicate()
        }
        if (entry === undefined) {
          entries.set(key, {
            checkpoint,
            requests: new Set([checkpoint.requestId])
          })
        } else {
          entry.checkpoint = checkpoint
          entry.requests.add(checkpoint.requestId)
        }
        return CommitResult.Committed()
      })
  })
})

export const layerMemory: Layer.Layer<Storage> = Layer.effect(Storage, makeMemory)

export const make = <
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
): ClusterMachine<
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
> => {
  type M = Machine.Machine<
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
  const eventSchema = Schema.Union(machine.events as MachineEvents<M>)
  const rpc = Rpc.make("send", {
    payload: eventSchema,
    success: SendResult
  })
    .annotate(ClusterSchema.Persisted, true) as SendRpc<MachineEvents<M>>
  const entity = Entity.make(type, [rpc])
  const machineId = machine.id ?? type

  const toLayer: ClusterMachine<
    Type,
    M,
    | ExcludeCompatibleRuntime<
      Machine.ExecutionServices<R | InitialR>,
      Machine.Machine.EventOf<Events>,
      Machine.Machine.EmitOf<Emits>
    >
    | Machine.Machine.SnapshotDecodingServices<States>
    | Machine.Machine.SnapshotEncodingServices<States>
  >["toLayer"] = (layerOptions) =>
    entity.toLayer(
      Effect.gen(function*() {
        const storage = yield* Storage
        const messageStorage = yield* MessageStorage.MessageStorage

        const handle = Effect.fnUntraced(function*(request: Entity.Request<SendRpc<MachineEvents<M>>>) {
          if (hasInvokes(machine)) {
            return yield* fail(
              "UnsupportedProcessLocal",
              "Machine invoke configurations are process-local and cannot be restored"
            )
          }

          const loaded = yield* storage.load(request.address, request.requestId).pipe(
            Effect.mapError((error) => reject("PersistenceFailure", String(error.cause)))
          )
          let current: Machine.Machine.Snapshot<States> | undefined
          const emitted: Array<Machine.Machine.EmitOf<MachineEmits<M>>> = []

          if (Option.isSome(loaded.checkpoint)) {
            const checkpoint = loaded.checkpoint.value
            if (loaded.processed) {
              return new Accepted({})
            }
            if (checkpoint.machineId !== machineId) {
              return yield* fail(
                "MachineIdMismatch",
                `Expected machine id ${machineId}, received ${checkpoint.machineId}`
              )
            }
            if (checkpoint.version !== options.version) {
              return yield* fail(
                "VersionMismatch",
                `Expected version ${options.version}, received ${checkpoint.version}`
              )
            }
            current = yield* internalMachine.decodeSnapshot(machine, checkpoint.snapshot).pipe(
              Effect.mapError((error) => reject("InvalidCheckpoint", String(error.cause)))
            )
          } else if (loaded.processed) {
            return yield* fail("InvalidCheckpoint", "The request was recorded without a checkpoint")
          }

          if (current === undefined) {
            const initial = yield* internalMachine.planInitial(machine, ...input as any)
            if (initial.commands.length > 0) {
              return yield* fail(
                "UnsupportedProcessLocal",
                "Machine actor commands require a managed local process"
              )
            }
            current = initial.state
            emitted.push(...initial.emittedEvents as any)
          }

          if (!internalMachine.isFinal(machine, current)) {
            const planned = yield* internalMachine.plan(machine, current, request.payload)
            if (planned.commands.length > 0) {
              return yield* fail(
                "UnsupportedProcessLocal",
                "Machine actor commands require a managed local process"
              )
            }
            current = planned.next
            emitted.push(...planned.emittedEvents as any)
          }

          const encoded = yield* internalMachine.encodeSnapshot(machine, current)
          if (emitted.length > 0 && layerOptions?.enqueue === undefined) {
            return yield* fail("EmissionFailure", "No durable enqueue handler was configured")
          }
          const committed = yield* storage.commit(request.address, {
            machineId,
            version: options.version,
            requestId: request.requestId,
            snapshot: encoded
          }).pipe(
            Effect.mapError((error) => reject("PersistenceFailure", String(error.cause)))
          )
          if (committed._tag === "Duplicate") {
            return new Accepted({})
          }

          if (layerOptions?.enqueue !== undefined) {
            yield* Effect.forEach(emitted, layerOptions.enqueue, { discard: true }).pipe(
              Effect.mapError((error) => reject("EmissionFailure", String(error)))
            )
          }
          return new Accepted({})
        })

        return entity.of({
          send: (request) =>
            messageStorage.withTransaction(
              handle(request).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.failCause(cause)
                    : Effect.fail(rejectionFromCause(cause))
                )
              )
            ).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterrupts(cause)) {
                  return Effect.failCause(cause)
                }
                const error = Cause.findErrorOption(cause)
                return Effect.succeed(
                  Option.isSome(error) && error.value instanceof Rejected
                    ? error.value
                    : reject("PersistenceFailure", messageFromCause(cause))
                )
              })
            ) as any
        })
      }) as any
    ) as any

  return {
    machine,
    entity,
    toLayer
  }
}
