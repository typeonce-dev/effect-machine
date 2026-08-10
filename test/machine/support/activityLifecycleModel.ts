import { Cause, Data, Deferred, Effect, Exit, Queue, Ref } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../../../src/index.js"

export type ActivityOutcome = "succeeded" | "cancelled" | "failed"

export type ActivityRecord =
  | { readonly _tag: "Started"; readonly owner: string; readonly epoch: number }
  | { readonly _tag: "Exited"; readonly owner: string; readonly epoch: number; readonly outcome: ActivityOutcome }

export interface StartedActivity {
  readonly owner: string
  readonly epoch: number
  readonly release: Deferred.Deferred<void>
}

export class ActivityFailure extends Data.TaggedError("ActivityFailure")<{
  readonly owner: string
  readonly epoch: number
}> {}

export type ActivityBehavior =
  | { readonly _tag: "Blocked" }
  | { readonly _tag: "Failure" }
  | { readonly _tag: "StaleOnCancel"; readonly event: (epoch: number) => unknown }

type ActivityState = { readonly epoch: number; readonly release: Deferred.Deferred<void> }

export interface ActivityProbe {
  readonly logic: (
    owner: string,
    behavior: ActivityBehavior
  ) => Machine.Logic<ActivityState, never, ActivityFailure, never, void>
  readonly immediate: <Event>(
    owner: string,
    event: (epoch: number) => Event
  ) => Machine.Logic<ActivityState, never, ActivityFailure, never, Event>
  readonly takeStarted: Effect.Effect<StartedActivity>
  readonly records: Effect.Effect<ReadonlyArray<ActivityRecord>>
}

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): ActivityOutcome => {
  if (Exit.isSuccess(exit)) return "succeeded"
  return exit.cause.reasons.some(Cause.isInterruptReason) ? "cancelled" : "failed"
}

export const makeActivityProbe: Effect.Effect<ActivityProbe> = Effect.gen(function*() {
  const nextEpoch = yield* Ref.make(0)
  const records = yield* Ref.make<ReadonlyArray<ActivityRecord>>([])
  const started = yield* Queue.unbounded<StartedActivity>()
  const append = (record: ActivityRecord) => Ref.update(records, (current) => [...current, record])
  const initial = (owner: string) =>
    Effect.gen(function*() {
      const epoch = yield* Ref.updateAndGet(nextEpoch, (current) => current + 1)
      const release = yield* Deferred.make<void>()
      yield* append({ _tag: "Started", owner, epoch })
      yield* Queue.offer(started, { owner, epoch, release })
      return { epoch, release }
    })
  const recordExit = <A, E>(
    owner: string,
    state: Effect.Effect<{ readonly epoch: number }, never, never>,
    exit: Exit.Exit<A, E>
  ) =>
    state.pipe(
      Effect.flatMap(({ epoch }) => append({ _tag: "Exited", owner, epoch, outcome: outcomeOf(exit) }))
    )
  const immediate = <Event>(
    owner: string,
    event: (epoch: number) => Event
  ): Machine.Logic<ActivityState, never, ActivityFailure, never, Event> =>
    Machine.logic<ActivityState, never, Event, ActivityFailure>({
      initial: () => initial(owner),
      run: ({ state }) =>
        state.pipe(
          Effect.map(({ epoch }) => event(epoch)),
          Effect.onExit((exit) => recordExit(owner, state, exit))
        )
    })

  return {
    logic: (owner, behavior) =>
      Machine.logic<ActivityState, never, void, ActivityFailure>({
        initial: () => initial(owner),
        run: ({ sendParent, state }) =>
          state.pipe(
            Effect.flatMap(({ epoch, release }) => {
              switch (behavior._tag) {
                case "Blocked":
                  return Effect.never.pipe(Effect.asVoid)
                case "Failure":
                  return Deferred.await(release).pipe(
                    Effect.andThen(Effect.fail(new ActivityFailure({ owner, epoch })))
                  )
                case "StaleOnCancel":
                  return Effect.never.pipe(
                    Effect.onInterrupt(() =>
                      sendParent(behavior.event(epoch)).pipe(
                        Effect.catchTag("StoppedError", () => Effect.void)
                      )
                    ),
                    Effect.asVoid
                  )
              }
            }),
            Effect.onExit((exit) => recordExit(owner, state, exit))
          )
      }),
    immediate,
    takeStarted: Queue.take(started),
    records: Ref.get(records)
  }
})

export type LifecycleCommand = "enter" | "leave" | "restart"

export interface LifecycleExpectation {
  readonly starts: number
  readonly cancellations: number
}

export const lifecycleCommandSamples = (options?: {
  readonly numRuns?: number
  readonly seed?: number
  readonly maxCommands?: number
}): ReadonlyArray<ReadonlyArray<LifecycleCommand>> =>
  FastCheck.sample(
    FastCheck.array(
      FastCheck.constantFrom<LifecycleCommand>("enter", "leave", "restart"),
      { minLength: 1, maxLength: options?.maxCommands ?? 24 }
    ),
    { numRuns: options?.numRuns ?? 40, seed: options?.seed ?? 82_419 }
  )

export const expectedLifecycle = (commands: ReadonlyArray<LifecycleCommand>): LifecycleExpectation => {
  let active = false
  let starts = 0
  let cancellations = 0
  for (const command of commands) {
    switch (command) {
      case "enter":
        if (!active) {
          active = true
          starts++
        }
        break
      case "leave":
        if (active) {
          active = false
          cancellations++
        }
        break
      case "restart":
        if (active) {
          cancellations++
          starts++
        }
        break
    }
  }
  if (active) cancellations++
  return { starts, cancellations }
}

export const countRecords = (
  records: ReadonlyArray<ActivityRecord>,
  kind: "starts" | ActivityOutcome,
  owner?: string
): number =>
  records.filter((record) => {
    if (owner !== undefined && record.owner !== owner) return false
    return kind === "starts"
      ? record._tag === "Started"
      : record._tag === "Exited" && record.outcome === kind
  }).length
