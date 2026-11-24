/**
 * Delayed messages that bring a Cluster machine back for a long timer.
 *
 * A timer that waits longer than the in-memory threshold of `DurableClock` does
 * not keep its entity alive. The step that stores its due time also saves a
 * message to the entity, delivered by Cluster at that time through `DeliverAt`,
 * so the entity may leave memory and returns when the timer is due, here or on
 * another runner.
 *
 * @since 0.48.0
 */
import { ClusterSchema, DeliverAt, Envelope, Message } from "effect/cluster"
import type { EntityAddress, MessageStorage, Sharding } from "effect/cluster"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Headers from "effect/http/Headers"
import * as Option from "effect/Option"
import * as PrimaryKey from "effect/PrimaryKey"
import { Rpc } from "effect/rpc"
import * as Schema from "effect/Schema"
import * as DurableClock from "effect/workflow/DurableClock"
import type { Timer } from "./clusterInstance.js"

/**
 * The payload of the message that wakes an entity for one timer. Its path, id,
 * and due time name one activation of the timer, so the message of an
 * activation that ended is recognized and ignored, and saving it again is a
 * duplicate.
 *
 * @internal
 */
export class Wake extends Schema.Class<Wake>("effect/cluster/ClusterMachine/Wake")({
  path: Schema.String,
  id: Schema.String,
  dueAt: Schema.Number
}) {
  [PrimaryKey.symbol]() {
    return JSON.stringify([this.path, this.id, this.dueAt])
  }
  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.dueAt)
  }
}

/** @internal */
export const WakeRpc = Rpc.make("wake", { payload: Wake })
  .annotate(ClusterSchema.Persisted, true)
  .annotate(ClusterSchema.Uninterruptible, true)

/** @internal */
export type WakeRpc = typeof WakeRpc

// `effect` 4.1 added the reference, and the published range starts before it.
const InMemoryThreshold: typeof DurableClock.InMemoryThreshold | undefined =
  (DurableClock as Partial<typeof DurableClock>).InMemoryThreshold

/**
 * The longest wait that stays in memory, in milliseconds, as `DurableClock`
 * decides it for a workflow.
 *
 * @internal
 */
export const threshold: Effect.Effect<number> = InMemoryThreshold === undefined
  ? Effect.succeed(60_000)
  : Effect.gen(function*() {
    return Duration.toMillis(yield* InMemoryThreshold)
  })

/**
 * Saves the message that wakes an entity for a timer. It joins an open
 * transaction of `MessageStorage`, and a message that is already saved is a
 * duplicate that changes nothing.
 *
 * @internal
 */
export const makeSave = (options: {
  readonly address: EntityAddress.EntityAddress
  readonly messageStorage: MessageStorage.MessageStorage["Service"]
  readonly sharding: Sharding.Sharding["Service"]
}) =>
(timer: Timer): Effect.Effect<void, unknown> =>
  Effect.flatMap(options.sharding.getSnowflake, (requestId) =>
    options.messageStorage.saveRequest(
      new Message.OutgoingRequest({
        envelope: Envelope.makeRequest<WakeRpc>({
          requestId,
          address: options.address,
          tag: WakeRpc._tag,
          payload: new Wake(timer),
          headers: Headers.empty
        }),
        context: Context.empty() as never,
        lastReceivedReply: Option.none(),
        rpc: WakeRpc,
        respond: () => Effect.void,
        annotations: WakeRpc.annotations
      })
    )).pipe(Effect.asVoid)
