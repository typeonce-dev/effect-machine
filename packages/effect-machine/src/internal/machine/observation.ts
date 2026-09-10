/** Observation of current and subsequent published runtime snapshots. */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import type * as Machine from "../../Machine.js"
import { StoppedError } from "./errors.js"

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
            case "error":
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
