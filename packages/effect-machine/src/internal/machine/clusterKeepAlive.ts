/**
 * Keeps one Cluster entity alive while it has work to run.
 *
 * @since 0.48.0
 */
import * as Effect from "effect/Effect"
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

/**
 * The keep-alive request of one entity.
 *
 * While enabled, message storage holds one persisted request of the entity
 * without a reply. That request is what brings the entity up on another runner,
 * and it keeps this runner from passivating the entity. Disabling answers it.
 *
 * Nothing here is synchronized. `switchTo` runs inside a turn of the instance,
 * and `close` after its last one.
 *
 * @internal
 */
export class ClusterKeepAlive {
  // Unknown until the first switch, and after one that did not finish.
  private enabled: boolean | undefined = undefined
  private wanted = false

  constructor(
    /** `Entity.keepAlive` for the entity. */
    private readonly set: (enabled: boolean) => Effect.Effect<void>
  ) {}

  /** Whether the state of the request is unknown. */
  get unknown(): boolean {
    return this.enabled === undefined
  }

  /** Enables or disables the request, until that succeeds. */
  switchTo(enabled: boolean): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.wanted = enabled
      if (this.enabled === enabled) return Effect.void
      this.enabled = undefined
      return untilDone(
        this.set(enabled).pipe(
          // The entity lets go of a released request in a later task. It answers
          // a request that reaches it before that as a second one, and would
          // then hold none.
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
   * Stores the request when the instance ends before a switch that enables it
   * has finished. A stored step whose caller was interrupted is not delivered
   * again, so nothing else would bring the entity up.
   */
  readonly close: Effect.Effect<void> = Effect.suspend(() =>
    this.wanted && this.enabled === undefined
      ? this.set(true).pipe(
        Effect.interruptible,
        Effect.timeoutOption("10 seconds"),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not restore the keep-alive of a Cluster machine that ended", cause)
        ),
        Effect.asVoid
      )
      : Effect.void
  )
}
