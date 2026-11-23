import { Cause, Data, Deferred, Effect, Exit, Queue, Ref } from "effect"
import * as Arbitrary from "effect/Arbitrary"
import * as Schema from "effect/Schema"
import { Machine } from "../../../src/index.js"

export type InvocationOutcome = "succeeded" | "cancelled" | "failed"

export type InvocationRecord =
  | { readonly _tag: "Started"; readonly owner: string; readonly epoch: number }
  | { readonly _tag: "Exited"; readonly owner: string; readonly epoch: number; readonly outcome: InvocationOutcome }

export interface StartedInvocation {
  readonly owner: string
  readonly epoch: number
  readonly release: Deferred.Deferred<void>
}

export class InvocationFailure extends Data.TaggedError("InvocationFailure")<{
  readonly owner: string
  readonly epoch: number
}> {}

export type InvocationBehavior =
  | { readonly _tag: "Blocked" }
  | { readonly _tag: "Failure" }
  | { readonly _tag: "StaleOnCancel"; readonly event: (epoch: number) => unknown }

type InvocationState = { readonly epoch: number; readonly release: Deferred.Deferred<void> }

export interface InvocationProbe {
  readonly logic: (
    owner: string,
    behavior: InvocationBehavior
  ) => Machine.Logic<InvocationState, never, InvocationFailure, never, void>
  readonly immediate: <Event>(
    owner: string,
    event: (epoch: number) => Event
  ) => Machine.Logic<InvocationState, never, InvocationFailure, never, Event>
  readonly takeStarted: Effect.Effect<StartedInvocation>
  readonly records: Effect.Effect<ReadonlyArray<InvocationRecord>>
}

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): InvocationOutcome => {
  if (Exit.isSuccess(exit)) return "succeeded"
  return exit.cause.reasons.some(Cause.isInterruptReason) ? "cancelled" : "failed"
}

export const makeInvocationProbe: Effect.Effect<InvocationProbe> = Effect.gen(function*() {
  const nextEpoch = yield* Ref.make(0)
  const records = yield* Ref.make<ReadonlyArray<InvocationRecord>>([])
  const started = yield* Queue.unbounded<StartedInvocation>()
  const append = (record: InvocationRecord) => Ref.update(records, (current) => [...current, record])
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
  ): Machine.Logic<InvocationState, never, InvocationFailure, never, Event> =>
    Machine.logic<InvocationState, never, Event, InvocationFailure>({
      initial: () => initial(owner),
      run: ({ state }) =>
        state.pipe(
          Effect.map(({ epoch }) => event(epoch)),
          Effect.onExit((exit) => recordExit(owner, state, exit))
        )
    })

  return {
    logic: (owner, behavior) =>
      Machine.logic<InvocationState, never, void, InvocationFailure>({
        initial: () => initial(owner),
        run: ({ parent, sendTo, state }) =>
          parent === undefined ? Effect.die("invocation expected an owning machine") : state.pipe(
            Effect.flatMap(({ epoch, release }) => {
              switch (behavior._tag) {
                case "Blocked":
                  return Effect.never.pipe(Effect.asVoid)
                case "Failure":
                  return Deferred.await(release).pipe(
                    Effect.andThen(Effect.fail(new InvocationFailure({ owner, epoch })))
                  )
                case "StaleOnCancel":
                  return Effect.never.pipe(
                    Effect.onInterrupt(() =>
                      sendTo(parent, behavior.event(epoch)).pipe(
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
  Effect.runSync(
    Arbitrary.sampleEffect(
      Arbitrary.array(Arbitrary.schema(Schema.Literals(["enter", "leave", "restart"])), {
        minLength: 1,
        maxLength: options?.maxCommands ?? 24
      }),
      { count: options?.numRuns ?? 40, seed: options?.seed ?? 82_419 }
    )
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
  records: ReadonlyArray<InvocationRecord>,
  kind: "starts" | InvocationOutcome,
  owner?: string
): number =>
  records.filter((record) => {
    if (owner !== undefined && record.owner !== owner) return false
    return kind === "starts"
      ? record._tag === "Started"
      : record._tag === "Exited" && record.outcome === kind
  }).length
