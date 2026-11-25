/**
 * Runs Effect machines as persisted Cluster entities.
 *
 * @since 0.4.0
 */
import { ClusterSchema, Entity, EntityAddress, EntityId, MessageStorage, Sharding } from "effect/cluster"
import type { Snowflake } from "effect/cluster"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Rpc } from "effect/rpc"
import * as Schema from "effect/Schema"
import type * as Machine from "../../Machine.js"
import type { Checkpoint } from "../../unstable/cluster/ClusterMachine.js"
import type { Client, ClientError, ClusterMachine } from "../../unstable/cluster/ClusterMachine.js"
import * as ClusterChild from "./clusterChild.js"
import * as ClusterInstance from "./clusterInstance.js"
import { CommitResult, Rejected, SendResult, Storage } from "./clusterProtocol.js"
import * as ClusterRead from "./clusterRead.js"
import * as ClusterTarget from "./clusterTarget.js"
import * as ClusterWake from "./clusterWake.js"
import type { MachineSchemaDecodeError } from "./errors.js"
import { toImpl } from "./implementation.js"
import * as Protocol from "./protocol.js"
import type { EnsureExecutable } from "./readiness.js"

type EntityAddress = EntityAddress.EntityAddress
type Snowflake = Snowflake.Snowflake

const invalidEvent = (error: MachineSchemaDecodeError): Rejected =>
  new Rejected({
    reason: "InvalidEvent",
    message: error.event === undefined
      ? "The event does not match the protocol of the machine"
      : `The event ${error.event} does not match its schema`
  })

/**
 * Decodes an event as `LocalMachine` does before it sends it, so that a client
 * takes what a local reference takes, and refuses only public input events.
 */
const decodeInputEvent = (
  machine: Machine.Machine.Any,
  publicTags: ReadonlySet<PropertyKey>,
  event: unknown
): Effect.Effect<unknown, Rejected> =>
  Protocol.decodeEvent(machine, event).pipe(
    Effect.mapError(invalidEvent),
    Effect.flatMap((decoded) =>
      publicTags.has(decoded._tag)
        ? Effect.succeed(decoded)
        : Effect.fail(
          new Rejected({
            reason: "InvalidEvent",
            message: `The event ${String(decoded._tag)} is not an input event`
          })
        )
    )
  )

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

// `effect` 4.1.3 added the handler, and the published range starts before it.
const KeepAliveHandler: typeof Entity.KeepAliveHandler | undefined = (Entity as Partial<typeof Entity>).KeepAliveHandler

// A `Sharding` runner provides the latch that holds a keep-alive request, and
// another host can provide an `Entity.KeepAliveHandler` instead, which
// `Entity.keepAlive` prefers. `Entity.makeTestClient` provides neither, and has
// no crash to recover from either.
const makeKeepAlive = Effect.gen(function*() {
  const context = yield* Effect.context<Sharding.Sharding | Entity.CurrentAddress>()
  const supported = (KeepAliveHandler !== undefined && Option.isSome(yield* Effect.serviceOption(KeepAliveHandler))) ||
    Option.isSome(yield* Effect.serviceOption(Entity.KeepAliveLatch))
  return (enabled: boolean): Effect.Effect<void> =>
    enabled && !supported
      ? Effect.logWarning("This Cluster runner cannot keep a machine alive, so its work is not recovered after a crash")
      : Effect.provideContext(Entity.keepAlive(enabled), context)
})

/** Internal metadata captured for a `ClusterMachine` adapter, used by sibling internal bridges. */
export interface AdapterMeta {
  readonly type: string
  readonly machine: Machine.Machine.Any
  readonly definitionId: string
  readonly version: string
  readonly readInterval: Duration.Input
  readonly decodeEvent: (event: unknown) => Effect.Effect<unknown, Rejected>
}

const adapterMeta = new WeakMap<object, AdapterMeta>()

/** Reads the internal metadata of a `ClusterMachine` created by {@link make}. */
export const getAdapterMeta = (adapter: object): AdapterMeta => {
  const meta = adapterMeta.get(adapter)
  if (meta === undefined) {
    throw new Error("Expected a ClusterMachine created by ClusterMachine.make")
  }
  return meta
}

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
    readonly readInterval?: Duration.Input | undefined
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
  | Exclude<R, Machine.InvocationSupport<"Child"> | Machine.ChildMachineRuntime>
  | Machine.Machine.SnapshotDecodingServices<States>
  | Machine.Machine.SnapshotEncodingServices<States>
> => {
  // The public type of the entity leaves out the RPCs that only machines send.
  return build(type, machine, options, input, undefined) as never
}

/** A request to an entity, as its handlers see it. */
interface Request {
  readonly requestId: Snowflake
  readonly payload: any
}

/** The parent of a child adapter. */
interface Parent {
  readonly protocol: ClusterTarget.Protocol
  readonly childId: string
  /** Whether an invocation of the parent takes the snapshots of the child. */
  readonly snapshots: boolean
}

/** An adapter, and the adapters of the child machines that its states invoke. */
interface Built {
  readonly machine: Machine.Machine.Any
  readonly entity: Entity.Entity<string, any>
  readonly protocol: ClusterTarget.Protocol
  readonly client: Effect.Effect<(entityId: string) => Client<any>, never, Sharding.Sharding>
  readonly target: (entityId: string) => ClusterTarget.Target
  readonly toLayer: (layerOptions?: {
    readonly enqueue?: (event: any) => Effect.Effect<void, unknown, any>
  }) => Layer.Layer<never, never, any>
}

const build = (
  type: string,
  machine: Machine.Machine.Any,
  options: {
    readonly version: string
    readonly readInterval?: Duration.Input | undefined
  },
  input: ReadonlyArray<unknown>,
  parent: Parent | undefined
): Built => {
  const eventSchema = Schema.Union(Protocol.inputEventSchemas(machine))
  const rpc = Rpc.make("send", {
    payload: eventSchema,
    success: SendResult
  })
    .annotate(ClusterSchema.Persisted, true)
  // An event that another machine sends, which nobody waits for.
  const deliver = Rpc.make("deliver", { payload: eventSchema }).annotate(ClusterSchema.Persisted, true)
  // `deliver` carries an event another machine sends, `wake` is the delayed
  // message of a long timer, `start` and `stop` come from the parent of a
  // child, and `ended` and `snapshot` from a child. Only machines send them.
  const entity = Entity.make(type, [
    rpc,
    deliver,
    ClusterWake.WakeRpc,
    ClusterChild.makeStartRpc(machine.input ?? Schema.Undefined),
    ClusterChild.StopRpc,
    ClusterChild.EndedRpc,
    ClusterChild.SnapshotRpc
  ])
  const definitionId = machine.id ?? type
  const publicTags: ReadonlySet<PropertyKey> = new Set(Reflect.ownKeys(machine.events))

  type EntityClient = ReturnType<Effect.Success<typeof entity.client>>

  const sendThroughClient = (rpc: EntityClient, event: unknown): Effect.Effect<void, Rejected | ClientError> =>
    decodeInputEvent(machine, publicTags, event).pipe(
      // The cast drops the encoding services of the event schemas, as the
      // layer drops their decoding services.
      Effect.flatMap((decoded) => rpc.send(decoded as never) as Effect.Effect<typeof SendResult.Type, ClientError>),
      Effect.flatMap((result) => result._tag === "Accepted" ? Effect.void : Effect.fail(result))
    )

  const protocol: ClusterTarget.Protocol = {
    entity,
    machine,
    definitionId,
    version: options.version,
    decode: (event) => decodeInputEvent(machine, publicTags, event),
    send: (entityId, event) =>
      Effect.flatMap(entity.client, (makeEntityClient) => sendThroughClient(makeEntityClient(entityId), event))
  }
  const target = (entityId: string): ClusterTarget.Target => new ClusterTarget.Target(protocol, entityId)

  // Each child runs as an entity of its own, with the version of its parent.
  const snapshots = ClusterChild.snapshotsOf(toImpl(machine).handlers)
  const children = Array.from(
    ClusterChild.childrenOf(toImpl(machine).handlers),
    ([childId, child]) =>
      [
        childId,
        build(ClusterChild.entityTypeOf(type, childId), child.machine, { version: options.version }, [], {
          protocol,
          childId,
          snapshots: snapshots.has(childId)
        })
      ] as const
  )
  const childProtocols: ReadonlyMap<string, ClusterTarget.Protocol> = new Map(
    children.map(([childId, child]) => [childId, child.protocol])
  )

  const toLayer: Built["toLayer"] = (layerOptions) => {
    // Each live entity builds its own handlers, and so owns its own instance.
    const layer = entity.toLayer(
      Effect.gen(function*() {
        const address = yield* Entity.CurrentAddress
        const messageStorage = yield* MessageStorage.MessageStorage
        const sharding = yield* Sharding.Sharding
        const save = ClusterTarget.makeSave({ messageStorage, sharding })
        const parentEntityId = parent && ClusterChild.parentEntityIdOf(address.entityId, parent.childId)
        const instance = yield* ClusterInstance.make<any>({
          machine,
          definitionId,
          version: options.version,
          input,
          address,
          storage: yield* Storage,
          messageStorage,
          // A child has no observers, so what it emits reaches nobody.
          enqueue: parent === undefined ? layerOptions?.enqueue : () => Effect.void,
          keepAlive: yield* makeKeepAlive,
          wake: {
            threshold: yield* ClusterWake.threshold,
            save: ClusterWake.makeSave({ address, messageStorage, sharding })
          },
          sends: {
            self: target(address.entityId),
            save: (sent) => save(sent.target, "deliver", sent.event),
            poll: sharding.pollStorage
          },
          children: {
            protocols: childProtocols,
            save,
            address: (target) => ClusterTarget.addressOf(sharding, target),
            snapshots: parent?.snapshots ?? false,
            // Saved as a step saves it, so the child takes it after its start.
            dispatch: (target, tag, payload) => Effect.andThen(save(target, tag, payload), sharding.pollStorage),
            parent: parent === undefined || parentEntityId === undefined
              ? undefined
              : new ClusterTarget.Target(parent.protocol, parentEntityId)
          }
        })
        const handlers: Record<string, (request: Request) => Effect.Effect<unknown, never, any>> = {
          send: (request) => instance.apply({ requestId: request.requestId, event: request.payload }),
          deliver: (request) => instance.deliver({ requestId: request.requestId, event: request.payload }),
          wake: (request) => instance.wake(request.payload),
          start: (request) => instance.start({ requestId: request.requestId, input: request.payload.input }),
          stop: (request) => instance.stop(request.requestId),
          ended: (request) => instance.childEnded(request.payload.entityId),
          snapshot: (request) =>
            instance.childSnapshot({
              requestId: request.requestId,
              entityId: request.payload.entityId,
              snapshot: request.payload.snapshot
            })
        }
        return entity.of(handlers as never)
      })
    )
    return children.length === 0
      ? layer
      : Layer.mergeAll(layer, ...children.map(([, child]) => child.toLayer()))
  }

  const client = Effect.gen(function*() {
    const makeEntityClient = yield* entity.client
    const sharding = yield* Sharding.Sharding
    return (entityId: string): Client<any> => {
      const rpc = makeEntityClient(entityId)
      const id = EntityId.make(entityId)
      const reader = ClusterRead.make({
        machine,
        definitionId,
        version: options.version,
        address: EntityAddress.make({
          shardId: sharding.getShardId(id, entity.getShardGroup(id)),
          entityType: entity.type,
          entityId: id
        }),
        interval: options.readInterval ?? "1 second"
      })
      return {
        entityId,
        ...reader,
        send: (event) => sendThroughClient(rpc, event)
      }
    }
  })

  const built: Built = { machine, entity, protocol, client, target, toLayer }
  adapterMeta.set(built, {
    type,
    machine,
    definitionId,
    version: options.version,
    readInterval: options.readInterval ?? "1 second",
    decodeEvent: (event) => decodeInputEvent(machine, publicTags, event)
  })
  return built
}
