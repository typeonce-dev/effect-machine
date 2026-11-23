/**
 * Keeps one Cluster entity alive while it has work to run.
 *
 * @since 0.48.0
 */
import * as Effect from "effect/Effect"
import type * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"

/** Bounded backoff of everything an instance retries on its own. */
export const retrySchedule = Schedule.min([
  Schedule.exponential("100 millis"),
  Schedule.spaced("10 seconds")
])

/**
 * Runs an attempt until it reports that nothing is left to do.
 *
 * @internal
 */
export const untilDone = <R>(attempt: Effect.Effect<boolean, never, R>): Effect.Effect<void, never, R> =>
  Effect.asVoid(Effect.repeat(attempt, { until: (done) => done, schedule: retrySchedule }))

// A live entity answers its own keep-alive request when message storage delivers
// that request again, which happens once the claim on it expires after ten
// minutes. Nothing would then bring the entity back after a crash, so the
// request is replaced well before that.
const renewInterval = "5 minutes"

/** @internal */
export interface Options {
  /** `Entity.keepAlive` for the entity. */
  readonly set: (enabled: boolean) => Effect.Effect<void>

  /** Forks the renewal, which ends with the instance. */
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<Fiber.Fiber<void>>

  /** Runs one turn of the instance. */
  readonly turn: (effect: Effect.Effect<void>) => Effect.Effect<void>
}

/**
 * The keep-alive request of one entity.
 *
 * While enabled, message storage holds one persisted request of the entity
 * without a reply. That request is what brings the entity up on another runner,
 * and it keeps this runner from passivating the entity. Disabling answers it.
 *
 * Nothing here is synchronized. `switchTo` runs inside a turn of the instance,
 * and the renewal takes a turn of its own.
 *
 * @internal
 */
export class ClusterKeepAlive {
  // Unknown until the first switch, and after one that did not finish.
  private enabled: boolean | undefined = undefined
  private wanted = false
  private renewal: Fiber.Fiber<void> | undefined = undefined

  constructor(private readonly options: Options) {}

  /** Whether the state of the request is unknown. */
  get unknown(): boolean {
    return this.enabled === undefined
  }

  /** Enables or disables the request, until that succeeds. */
  switchTo(enabled: boolean): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.wanted = enabled
      if (this.enabled === enabled) return Effect.void
      // The renewal waits far longer than a switch that is interrupted, and then
      // renews only what is enabled.
      return Effect.andThen(enabled ? this.startRenewal : this.stopRenewal, this.set(enabled))
    })
  }

  private set(enabled: boolean): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.enabled = undefined
      return untilDone(
        this.options.set(enabled).pipe(
          // The entity answers a released request in a later task. A request
          // sent before that is taken for a second one and answered with it.
          Effect.andThen(enabled ? Effect.void : Effect.yieldNow),
          Effect.as(true),
          // Does not run when this fiber is interrupted.
          Effect.catchCause((cause) =>
            Effect.as(Effect.logWarning("Could not switch the keep-alive of a Cluster machine", cause), false)
          )
        )
      ).pipe(
        Effect.andThen(Effect.sync(() => {
          this.enabled = enabled
        }))
      )
    })
  }

  /**
   * Leaves the request in place when the instance ends. A switch that the end
   * interrupted may have released the old request without storing a new one.
   */
  readonly close: Effect.Effect<void> = Effect.suspend(() =>
    this.wanted && this.enabled === undefined
      ? this.options.set(true).pipe(
        Effect.interruptible,
        Effect.timeoutOption("10 seconds"),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not restore the keep-alive of a Cluster machine that ended", cause)
        ),
        Effect.asVoid
      )
      : Effect.void
  )

  private readonly startRenewal: Effect.Effect<void> = Effect.suspend(() =>
    this.renewal !== undefined
      ? Effect.void
      : this.options.fork(
        Effect.sleep(renewInterval).pipe(
          Effect.andThen(this.options.turn(Effect.suspend(() =>
            this.enabled === true ? Effect.andThen(this.set(false), this.set(true)) : Effect.void
          ))),
          Effect.forever
        )
      ).pipe(
        Effect.map((renewal) => {
          this.renewal = renewal
        })
      )
  )

  private readonly stopRenewal: Effect.Effect<void> = Effect.sync(() => {
    this.renewal?.interruptUnsafe()
    this.renewal = undefined
  })
}
