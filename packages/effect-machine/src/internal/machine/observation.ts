/** Observation of the snapshots and outcomes published through the reference contract. */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import type * as Machine from "../../Machine.js"
import { StoppedError } from "./errors.js"

export const classifyOutcome = <State, Error, Output>(
  snapshot: Machine.RuntimeSnapshot<State, Error, Output>
): Machine.RuntimeOutcome<State, Error, Output> | undefined => {
  switch (snapshot.status) {
    case "active": {
      return undefined
    }
    case "done": {
      return {
        _tag: "Done",
        output: snapshot.output,
        snapshot
      }
    }
    case "failed": {
      const failure = snapshot.cause.reasons.find(Cause.isFailReason)
      if (failure !== undefined) {
        return {
          _tag: "Failure",
          error: failure.error,
          cause: snapshot.cause,
          snapshot
        }
      }
      const defect = snapshot.cause.reasons.find(Cause.isDieReason)
      if (defect !== undefined) {
        return {
          _tag: "Defect",
          defect: defect.defect,
          cause: snapshot.cause,
          snapshot
        }
      }
      const interrupted = snapshot.cause.reasons.find(Cause.isInterruptReason)
      if (interrupted !== undefined) {
        return {
          _tag: "Interrupted",
          cause: snapshot.cause,
          snapshot
        }
      }
      return {
        _tag: "Cause",
        cause: snapshot.cause,
        snapshot
      }
    }
    case "stopped": {
      return {
        _tag: "Stopped",
        snapshot
      }
    }
  }
}

export const watch = <State, Event, Error = never, Output = never>(
  ref: Machine.MachineRef<State, Event, Error, Output>
): Stream.Stream<Machine.RuntimeOutcome<State, Error, Output>> =>
  ref.changes.pipe(
    Stream.filter((snapshot) => snapshot.status !== "active"),
    Stream.map((snapshot) => classifyOutcome(snapshot)!),
    Stream.take(1)
  )

export const waitFor: typeof Machine.waitFor = dual(2, <State, Event, Error, Output, Emitted>(
  ref: Machine.MachineRef<State, Event, Error, Output, Emitted>,
  predicate: (snapshot: Machine.RuntimeSnapshot<State, Error, Output>) => boolean
): Effect.Effect<Machine.RuntimeSnapshot<State, Error, Output>, Error | StoppedError | Cause.NoSuchElementError> =>
  Effect.suspend(() => {
    let result = Option.none<Machine.RuntimeSnapshot<State, Error, Output>>()
    const absent = () => new Cause.NoSuchElementError(`Machine "${ref.id}" ended without a matching snapshot`)
    return Stream.runForEachWhile(
      ref.changes,
      (snapshot) =>
        Effect.suspend((): Effect.Effect<boolean, Error | StoppedError | Cause.NoSuchElementError> => {
          if (predicate(snapshot)) {
            result = Option.some(snapshot)
            return Effect.succeed(false)
          }
          switch (snapshot.status) {
            case "active":
              return Effect.succeed(true)
            case "failed":
              return Effect.failCause(snapshot.cause)
            case "stopped":
              return Effect.fail(new StoppedError())
            case "done":
              return Effect.fail(absent())
          }
        })
    ).pipe(
      Effect.flatMap(() => Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(absent()))
    )
  }))
