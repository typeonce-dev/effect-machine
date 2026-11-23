/**
 * Due times of the timers of a Cluster machine.
 *
 * A timer waits for an instant that is stored with its state, not for a
 * duration. Its duration is evaluated once, by `schedule`, before the checkpoint
 * that stores the due time is committed. Nothing evaluates it again while that
 * due time is stored.
 *
 * @since 0.48.0
 */
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Machine from "../../Machine.js"
import type { Checkpoint } from "../../unstable/cluster/ClusterMachine.js"
import * as ClusterProgress from "./clusterProgress.js"
import type * as Configuration from "./configuration.js"
import * as InvocationResolution from "./invocationResolution.js"

/**
 * A timer without a due time, because its duration could not be evaluated. The
 * failure is reported when the timer would have started, in the order of the
 * local runtime.
 *
 * @internal
 */
export interface Unscheduled {
  readonly key: Checkpoint.InvocationKey

  /**
   * `Source` is a duration that could not be computed, which ends the start of
   * work. `Outcome` is a value that names no duration, which is how the timer
   * itself ends.
   */
  readonly stage: "Source" | "Outcome"

  readonly cause: Cause.Cause<never>
}

/** @internal */
export interface Schedule {
  readonly progress: ClusterProgress.Progress
  readonly unscheduled: ReadonlyArray<Unscheduled>
}

const dueAt = (now: number, duration: Duration.Duration): number =>
  Math.min(Math.ceil(now + Math.max(Duration.toMillis(duration), 0)), ClusterProgress.maxDueAt)

const evaluate = (timer: InvocationResolution.TimerInvocation): Duration.Duration | Unscheduled => {
  const key = { path: timer.path, id: timer.id }
  try {
    const duration = timer.duration()
    return Exit.isSuccess(duration) ? duration.value : { key, stage: "Outcome", cause: duration.cause }
  } catch (error) {
    return { key, stage: "Source", cause: Cause.die(error) }
  }
}

/**
 * Gives a due time to every timer of an active state that has no progress, in
 * start order. Afterwards each timer of the configuration has progress or is
 * unscheduled. The progress is returned as it is when no timer needed one.
 *
 * @internal
 */
export const schedule = (options: {
  readonly machine: Machine.Machine.Any
  readonly configuration: Configuration.ActiveConfiguration
  /** Every active path, in entry order. */
  readonly paths: ReadonlyArray<string>
  /** The lifecycle event that entered a path. */
  readonly eventOf: (path: string) => Machine.Machine.LifecycleEvent<any>
  readonly capabilities: InvocationResolution.InvocationCapabilities
  readonly progress: ClusterProgress.Progress
  readonly now: number
}): Schedule => {
  let progress = options.progress
  const unscheduled: Array<Unscheduled> = []
  for (const path of options.paths) {
    const groups = InvocationResolution.resolve(
      options.machine,
      options.configuration,
      [path],
      options.eventOf(path),
      options.capabilities
    )
    for (const invocation of groups.flatMap(({ invocations }) => invocations)) {
      if (invocation._tag !== "Timer" || ClusterProgress.get(progress, invocation) !== undefined) continue
      const duration = evaluate(invocation)
      if (Duration.isDuration(duration)) {
        progress = ClusterProgress.wait(progress, invocation, dueAt(options.now, duration))
      } else {
        unscheduled.push(duration)
      }
    }
  }
  return { progress, unscheduled }
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
