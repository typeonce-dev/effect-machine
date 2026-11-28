/**
 * Due times of the timers of a Cluster machine.
 *
 * A timer waits for an instant that is stored with its state, not for a
 * duration. Its duration is read once, from the timer that a step lists, before
 * the checkpoint that stores the due time is committed. Nothing reads it again
 * while that due time is stored.
 *
 * @since 0.48.0
 */
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as ClusterProgress from "./clusterProgress.js"
import type * as Step from "./step.js"

const dueAt = (now: number, duration: Duration.Duration): number =>
  Math.min(Math.ceil(now + Math.max(Duration.toMillis(duration), 0)), ClusterProgress.maxDueAt)

/**
 * Gives a due time, from now on, to every timer among `running` that has no
 * progress, in start order. A timer whose duration cannot be read keeps none:
 * its host settles it with that failure where it would have started. The
 * progress is returned as it is when no timer needed one.
 *
 * @internal
 */
export const schedule = (
  progress: ClusterProgress.Progress,
  running: ReadonlyArray<Step.Work>,
  now: number
): ClusterProgress.Progress => {
  let scheduled = progress
  for (const work of running) {
    if (work._tag !== "Timer" || ClusterProgress.get(scheduled, work) !== undefined) continue
    const duration = work.duration()
    if (Exit.isSuccess(duration)) {
      scheduled = ClusterProgress.wait(scheduled, work, dueAt(now, duration.value))
    }
  }
  return scheduled
}

/**
 * Waits until the clock has reached a due time, and no longer when it already
 * has. The clock is read again after each sleep, because a wall clock can be set
 * back and a sleep can end early.
 *
 * @internal
 */
export const waitUntil = (dueAt: number): Effect.Effect<void> =>
  Effect.clockWith((clock) => {
    const wait: Effect.Effect<void> = Effect.suspend(() => {
      const remaining = dueAt - clock.currentTimeMillisUnsafe()
      return remaining <= 0 ? Effect.void : Effect.andThen(clock.sleep(Duration.millis(remaining)), wait)
    })
    return wait
  })
