/**
 * Internal state-scoped invocation orchestration.
 *
 * @since 0.4.0
 */

import * as Effect from "effect/Effect"
import type { Machine } from "../../Machine.js"
import * as Configuration from "./configuration.js"
import * as Planner from "./planner.js"
import type * as Runtime from "./runtime.js"

/** @internal */
export type AnyConfig = Machine.InvokeConfig<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>

/** @internal */
export const makeKey = (path: string, id: string): string => `${path.length}:${path}${id}`

/** @internal */
export const makeChildId = (path: string, id: string): string => `Machine.invoke:${makeKey(path, id)}`

const resolve = (
  config: Machine.AnyStateConfig | undefined,
  context: Machine.InvokeContext<any, any, any, any>
): ReadonlyArray<AnyConfig> => {
  const definition = config?.invoke
  const invokes = typeof definition === "function" ? definition(context) : definition
  if (invokes === undefined) return []
  return Array.isArray(invokes) ? invokes as ReadonlyArray<AnyConfig> : [invokes as AnyConfig]
}

const runSequentialDiscard = <E, R>(
  effects: ReadonlyArray<Effect.Effect<void, E, R>>
): Effect.Effect<void, E, R> =>
  effects.length === 0
    ? Effect.void
    : effects.length === 1
    ? effects[0]!
    : Effect.all(effects, { discard: true })

const start = (
  scope: Runtime.ProcessScope<any>,
  ownedChildren: Runtime.OwnedChildRuntime,
  path: string,
  config: AnyConfig
): Effect.Effect<void, any, any> =>
  Effect.suspend(() => {
    const invokeId = String(config.id)
    const key = makeKey(path, invokeId)
    const childId = config.address === undefined ? makeChildId(path, invokeId) : String(config.address)
    return ownedChildren.spawn(config.src as () => Runtime.ProcessLogic<any, any, any, any, any, any>, {
      key,
      path,
      id: childId,
      duplicateId: invokeId,
      ...(config.descriptor === undefined ? undefined : { descriptor: config.descriptor }),
      sendParent: (isCurrent, event) => isCurrent() ? scope.self.send(event) : Effect.void,
      onOutcome: (isCurrent, outcome) => {
        if (outcome._tag === "Stopped" || !isCurrent()) return Effect.void
        if (outcome._tag !== "Done") return scope.failCause(outcome.cause)
        const mappedEvent = config.onDone === undefined
          ? outcome.output
          : config.onDone({ id: config.id, output: outcome.output })
        return mappedEvent === undefined
          ? Effect.void
          : scope.self.send(mappedEvent).pipe(Effect.catchTag("StoppedError", () => Effect.void))
      },
      ...(config.snapshot === undefined ? undefined : {
        onSnapshot: (isCurrent: () => boolean, snapshot: any) => {
          if (!isCurrent()) return Effect.void
          const mappedEvent = config.snapshot!({ id: config.id, snapshot })
          return mappedEvent === undefined
            ? Effect.void
            : scope.self.send(mappedEvent).pipe(Effect.catchTag("StoppedError", () => Effect.void))
        }
      })
    })
  })

/**
 * Starts every invocation owned by active entry paths in deterministic entry
 * order. `undefined` keeps the compiled drain free of empty Effect nodes.
 *
 * @internal
 */
export const startAll = (
  machine: Machine.Any,
  scope: Runtime.ProcessScope<any>,
  ownedChildren: Runtime.OwnedChildRuntime,
  configuration: Configuration.ActiveConfiguration,
  paths: ReadonlyArray<string>,
  event: Machine.LifecycleEvent<any>
): Effect.Effect<void, any, any> | undefined => {
  const effects = Planner.sortEntryPaths(machine, paths)
    .filter((path) => configuration.active.has(path))
    .flatMap((path) =>
      resolve(Configuration.getStateConfigByPath(machine, path), {
        state: configuration.values.get(path),
        parent: Configuration.getParentValue(machine, configuration, path),
        parents: Configuration.getParentValues(machine, configuration, path),
        event
      }).map((config) => start(scope, ownedChildren, path, config))
    )
  return effects.length === 0 ? undefined : runSequentialDiscard(effects)
}
