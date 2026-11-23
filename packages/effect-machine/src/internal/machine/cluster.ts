/**
 * Runs Effect machines as persisted Cluster entities.
 *
 * @since 0.4.0
 */
import { ClusterSchema, Entity, MessageStorage } from "effect/cluster"
import type { EntityAddress, Sharding, Snowflake } from "effect/cluster"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Rpc } from "effect/rpc"
import * as Schema from "effect/Schema"
import type * as Machine from "../../Machine.js"
import type { Checkpoint } from "../../unstable/cluster/ClusterMachine.js"
import type { ClusterMachine } from "../../unstable/cluster/ClusterMachine.js"
import * as ClusterInstance from "./clusterInstance.js"
import { CommitResult, SendResult, Storage } from "./clusterProtocol.js"
import * as Protocol from "./protocol.js"
import type { EnsureExecutable } from "./readiness.js"
import type { ExcludeCompatibleRuntime } from "./requirements.js"

type EntityAddress = EntityAddress.EntityAddress
type Snowflake = Snowflake.Snowflake

type SendRpc<Events extends ReadonlyArray<Machine.Machine.TaggedSchema>> = Rpc.Rpc<
  "send",
  Schema.Union<Events>,
  typeof SendResult
>

type MachineEvents<M extends Machine.Machine.Any> = Machine.Machine.InputEvents<M>

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
        if (checkpoint.revision !== (entry?.checkpoint.revision ?? 0) + 1) {
          return CommitResult.RevisionConflict()
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
    & Machine.Machine.RootCompatible<ParentEvents>,
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
  type Services =
    | ExcludeCompatibleRuntime<
      Machine.ExecutionServices<R | InitialR>,
      Machine.Machine.EventOf<Events>,
      Machine.Machine.EmittedEventOf<Emits>
    >
    | Machine.Machine.SnapshotDecodingServices<States>
    | Machine.Machine.SnapshotEncodingServices<States>
  const eventSchema = Schema.Union(Protocol.inputEventSchemas(machine) as MachineEvents<M>)
  const rpc = Rpc.make("send", {
    payload: eventSchema,
    success: SendResult
  })
    .annotate(ClusterSchema.Persisted, true) as SendRpc<MachineEvents<M>>
  const entity = Entity.make(type, [rpc])
  const machineId = machine.id ?? type

  const toLayer = <EnqueueR = never>(layerOptions?: {
    readonly enqueue?: (event: Machine.Machine.EmittedEventOf<Emits>) => Effect.Effect<void, unknown, EnqueueR>
  }) =>
    // Each live entity builds its own handlers, and so owns its own instance.
    // The cast drops the services of the event schemas, which `ClusterMachine`
    // does not require.
    entity.toLayer(
      Effect.gen(function*() {
        const instance = yield* ClusterInstance.make<Services | EnqueueR>({
          machine,
          machineId,
          version: options.version,
          input,
          address: yield* Entity.CurrentAddress,
          storage: yield* Storage,
          messageStorage: yield* MessageStorage.MessageStorage,
          enqueue: layerOptions?.enqueue
        })
        return entity.of({
          send: (request) => instance.apply({ requestId: request.requestId, event: request.payload })
        })
      })
    ) as Layer.Layer<
      never,
      never,
      Storage | MessageStorage.MessageStorage | Sharding.Sharding | EnqueueR | Services
    >

  return {
    machine,
    entity,
    toLayer
  }
}
