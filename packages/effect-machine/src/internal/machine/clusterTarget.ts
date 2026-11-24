/**
 * Targets that name a Cluster machine by its entity type and id, and the
 * messages that carry the events a step sends to them.
 *
 * A step that sends to a target saves the event as a persisted request to the
 * target's entity, in the `MessageStorage` transaction of its checkpoint. The
 * request has an id of its own, which the target records when it applies it, so
 * a request that Cluster delivers again changes nothing.
 *
 * @since 0.48.0
 */
import { Envelope, Message, Sharding } from "effect/cluster"
import type { Entity, EntityAddress, MessageStorage } from "effect/cluster"
import { EntityAddress as Address, EntityId } from "effect/cluster"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Headers from "effect/http/Headers"
import * as Option from "effect/Option"
import type { Rpc } from "effect/rpc"
import * as Schedule from "effect/Schedule"
import type { Machine, MachineTarget } from "../../Machine.js"
import type { Rejected } from "./clusterProtocol.js"
import { StoppedError } from "./errors.js"

/** @internal */
export const TypeId = "~effect/cluster/ClusterMachine/Target"

/**
 * What a target needs from the machine it names.
 *
 * @internal
 */
export interface Protocol {
  // oxlint-disable-next-line typescript/no-explicit-any -- any protocol of a machine
  readonly entity: Entity.Entity<any, any>
  readonly machine: Machine.Any
  readonly definitionId: string
  readonly version: string

  /** Decodes an event as the client of the target does before it sends it. */
  readonly decode: (event: unknown) => Effect.Effect<unknown, Rejected>

  /** Sends through the client of the target, from wherever `Sharding` is. */
  readonly send: (entityId: string, event: unknown) => Effect.Effect<void, Rejected | unknown, Sharding.Sharding>
}

/** @internal */
export class Target implements MachineTarget<any> {
  readonly [TypeId]: typeof TypeId = TypeId

  constructor(readonly protocol: Protocol, readonly entityId: string) {}

  get entityType(): string {
    return this.protocol.entity.type
  }

  get id(): string {
    return this.protocol.definitionId
  }

  /** A Cluster machine has no session, so the address names it. */
  get sessionId(): string {
    return `${this.entityType}/${this.entityId}`
  }

  readonly send = (event: unknown): Effect.Effect<void, StoppedError> =>
    Effect.flatMap(
      Effect.serviceOption(Sharding.Sharding),
      Option.match({
        onNone: () =>
          Effect.die(
            new Error(
              `A ClusterMachine target sends to ${this.sessionId} only where a Cluster runner provides Sharding`
            )
          ),
        onSome: (sharding) =>
          this.protocol.send(this.entityId, event).pipe(
            Effect.provideService(Sharding.Sharding, sharding),
            // A runner that cannot take the request now takes it later.
            Effect.retry({ while: (error) => !isRejected(error), schedule: Schedule.spaced("1 second") }),
            Effect.catch((error) =>
              isRejected(error) && error.reason === "MachineFailed"
                ? Effect.fail(new StoppedError())
                : Effect.die(error)
            )
          )
      })
    )
}

const isRejected = (error: unknown): error is Rejected =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "Rejected"

/** @internal */
export const isTarget = (value: unknown): value is Target => value instanceof Target

/**
 * An event that a step sends, decoded by the protocol of its target.
 *
 * @internal
 */
export interface Sent {
  readonly target: Target
  readonly event: unknown
}

/** @internal */
export const addressOf = (sharding: Sharding.Sharding["Service"], target: Target): EntityAddress.EntityAddress => {
  const id = EntityId.make(target.entityId)
  const { entity } = target.protocol
  return Address.make({
    shardId: sharding.getShardId(id, entity.getShardGroup(id)),
    entityType: entity.type,
    entityId: id
  })
}

/**
 * Saves a persisted request to a target, of one of the RPCs of its entity. It
 * joins an open transaction of `MessageStorage`.
 *
 * @internal
 */
export type Save = (target: Target, tag: string, payload: unknown) => Effect.Effect<void, unknown>

/** @internal */
export const makeSave = (options: {
  readonly messageStorage: MessageStorage.MessageStorage["Service"]
  readonly sharding: Sharding.Sharding["Service"]
}): Save =>
(target, tag, payload) =>
  Effect.flatMap(options.sharding.getSnowflake, (requestId) => {
    const rpc = target.protocol.entity.protocol.requests.get(tag) as Rpc.AnyWithProps
    return options.messageStorage.saveRequest(
      new Message.OutgoingRequest<any>({
        envelope: Envelope.makeRequest<any>({
          requestId,
          address: addressOf(options.sharding, target),
          tag,
          payload,
          headers: Headers.empty
        }),
        context: Context.empty() as Context.Context<unknown>,
        lastReceivedReply: Option.none(),
        rpc,
        respond: () => Effect.void,
        annotations: rpc.annotations
      })
    )
  }).pipe(Effect.asVoid)
