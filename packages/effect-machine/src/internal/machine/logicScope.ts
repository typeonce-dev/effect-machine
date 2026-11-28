/**
 * The `Scope` that a `Logic` process owns, for every host that runs one.
 *
 * @since 0.48.0
 */

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"

/** The members of process logic that run, whatever else a host attaches to it. */
interface Runnable {
  initial(context: never): Effect.Effect<unknown, unknown, unknown>
  run(context: never): Effect.Effect<unknown, unknown, unknown>
}

/**
 * Gives a `Logic` process one `Scope` from its `initial` through the end of its
 * `run`. The scope is forked from the one that `initial` runs in, so a process
 * stopped before its `run` starts is still released when that scope closes.
 *
 * Each call returns logic for one process: its `initial` and `run` share the
 * scope of that process.
 *
 * @internal
 */
export const scoped = <L extends Runnable>(logic: L): L => {
  let scope: Scope.Closeable | undefined
  return {
    ...logic,
    initial: (context: never) =>
      Effect.flatMap(Effect.scope, (owner) => {
        const own = scope = Scope.forkUnsafe(owner, "sequential")
        return logic.initial(context).pipe(
          Scope.provide(own),
          Effect.onError((cause) => Scope.close(own, Exit.failCause(cause)))
        )
      }),
    run: (context: never) => {
      const own = scope!
      return logic.run(context).pipe(
        Scope.provide(own),
        Effect.onExit((exit) => Scope.close(own, exit))
      )
    }
  }
}
