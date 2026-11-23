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
    readonly checkpoint: Checkpoint
    readonly requests: Set<Snowflake>
  }>()
  return Storage.of({
    load: (address) => Effect.sync(() => Option.fromNullishOr(entries.get(addressKey(address))?.checkpoint)),
    loadForRequest: (address, requestId) =>
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
        const { origin, revision } = checkpoint
        const stored = entries.get(key)
        if (origin._tag === "Request" && stored?.requests.has(origin.requestId)) {
          return CommitResult.Duplicate()
        }
        if (revision !== (stored?.checkpoint.revision ?? 0) + 1) {
          return CommitResult.RevisionConflict()
        }
        const requests = stored?.requests ?? new Set()
        if (origin._tag === "Request") {
          requests.add(origin.requestId)
        }
        entries.set(key, { checkpoint, requests })
        return CommitResult.Committed()
      })
  })
})

export const layerMemory: Layer.Layer<Storage> = Layer.effect(Storage, makeMemory)

// `Entity.keepAlive` does nothing where Cluster provides no latch, as in
// `Entity.makeTestClient`, which has no crash to recover from either.
const makeKeepAlive = Effect.gen(function*() {
  const context = yield* Effect.context<Sharding.Sharding | Entity.CurrentAddress>()
  const latch = yield* Effect.serviceOption(Entity.KeepAliveLatch)
  return (enabled: boolean): Effect.Effect<void> =>
    enabled && Option.isNone(latch)
      ? Effect.logWarning("This Cluster runner cannot keep a machine alive, so its work is not recovered after a crash")
      : Effect.provideContext(Entity.keepAlive(enabled), context)
})

export const make = <
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
> => {
  type M = Machine.Machine<
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
    InputEvents
  >
  type Services =
    | R
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
          enqueue: layerOptions?.enqueue,
          keepAlive: yield* makeKeepAlive
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
