/**
 * Internal state-scoped invocation orchestration.
 *
 * @since 0.4.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import type { ChildMachine, Inspection, Logic, Machine } from "../../Machine.js"
import * as Configuration from "./configuration.js"
import { InfiniteTransitionError, MachineSchemaDecodeError, StoppedError } from "./errors.js"
import * as InvocationEvent from "./invocationEvent.js"
import * as Planner from "./planner.js"
import type * as Runtime from "./runtime.js"
import { ChildMachineLogicTypeId } from "./symbols.js"

/** @internal */
export interface AnyConfig {
  readonly id: string
  readonly address?: string
  readonly descriptor?: ChildMachine.Any
  readonly src: () => Runtime.ProcessLogic<any, any, any, any, any, any>
  readonly onDone?: unknown
  readonly onFailure?: unknown
  readonly onSnapshot?: unknown
  readonly activityKind?: Inspection.Activity["kind"]
}

/** @internal */
export const makeKey = (path: string, id: string): string => `${path.length}:${path}${id}`

/** @internal */
export const makeChildId = (path: string, id: string): string => `Machine.invoke:${makeKey(path, id)}`

const oneShot = (effect: Effect.Effect<any, any, any>): Logic<void, never, any, any, any> => ({
  initial: () => Effect.void,
  run: () => effect
})

const resolveValue = (value: unknown, context: Machine.InvokeContext<any, any, any, any>): unknown =>
  typeof value === "function" ? value(context) : value

const resolveOne = (
  raw: Record<PropertyKey, any>,
  context: Machine.InvokeContext<any, any, any, any>
): AnyConfig => {
  if ("effect" in raw) {
    return {
      id: String(raw.id),
      src: () =>
        oneShot(raw.effect(context) as Effect.Effect<any, any, any>) as unknown as Runtime.ProcessLogic<
          any,
          any,
          any,
          any,
          any,
          any
        >,
      onDone: raw.onDone,
      onFailure: raw.onFailure,
      onSnapshot: raw.onSnapshot,
      activityKind: "Effect"
    }
  }
  if ("after" in raw) {
    return {
      id: String(raw.id),
      src: () =>
        oneShot(Effect.sleep(resolveValue(raw.after, context) as any)) as unknown as Runtime.ProcessLogic<
          any,
          any,
          any,
          any,
          any,
          any
        >,
      onDone: raw.onDone,
      activityKind: "Timer"
    }
  }
  if ("logic" in raw) {
    return {
      id: String(raw.id),
      address: String(raw.address),
      src: () => resolveValue(raw.logic, context) as Runtime.ProcessLogic<any, any, any, any, any, any>,
      onDone: raw.onDone,
      onFailure: raw.onFailure,
      onSnapshot: raw.onSnapshot
    }
  }
  if ("child" in raw) {
    const descriptor = raw.child as ChildMachine.Any
    return {
      id: descriptor.id,
      address: descriptor.id,
      descriptor,
      src: () =>
        descriptor[ChildMachineLogicTypeId](
          "input" in raw ? resolveValue(raw.input, context) : undefined
        ) as Runtime.ProcessLogic<any, any, any, any, any, any>,
      onDone: raw.onDone,
      onFailure: raw.onFailure,
      onSnapshot: raw.onSnapshot
    }
  }
  throw new Error("Machine invoke must define exactly one of effect, after, logic, or child")
}

/** @internal */
const runSequentialDiscard = <E, R>(
  effects: ReadonlyArray<Effect.Effect<void, E, R>>
): Effect.Effect<void, E, R> =>
  effects.length === 0
    ? Effect.void
    : effects.length === 1
    ? effects[0]!
    : Effect.all(effects, { discard: true })

const sendLifecycle = (
  scope: Runtime.ProcessScope<any>,
  event: InvocationEvent.InvocationEvent,
  activitySessionId?: string
): Effect.Effect<void> =>
  (activitySessionId === undefined
    ? scope.self.send(event)
    : scope.self.sendInspected === undefined
    ? scope.self.send(event)
    : scope.self.sendInspected(
      event,
      scope.self.inspectionSubject,
      { _tag: "Activity", activitySessionId }
    )).pipe(Effect.catchTag("StoppedError", () => Effect.void))

const isFrameworkFailure = (error: unknown): boolean =>
  error instanceof InfiniteTransitionError || error instanceof MachineSchemaDecodeError || error instanceof StoppedError

const startResolved = (
  scope: Runtime.ProcessScope<any>,
  ownedChildren: Runtime.OwnedChildRuntime,
  path: string,
  invokeId: string,
  childId: string,
  descriptor: ChildMachine.Any | undefined,
  src: () => Runtime.ProcessLogic<any, any, any, any, any, any>,
  onDone: unknown,
  onFailure: unknown,
  onSnapshot: unknown,
  activityKind?: Inspection.Activity["kind"]
): Effect.Effect<void, any, any> =>
  Effect.suspend(() => {
    const key = makeKey(path, invokeId)
    return ownedChildren.spawn(src, {
      key,
      path,
      id: childId,
      duplicateId: invokeId,
      ...(descriptor === undefined ? undefined : { descriptor }),
      ...(activityKind === undefined ? undefined : { activityKind }),
      sendParent: (isCurrent, event) => isCurrent() ? scope.self.send(event) : Effect.void,
      onOutcome: (isCurrent, outcome, activitySessionId) => {
        if (outcome._tag === "Stopped" || !isCurrent()) return Effect.void
        if (outcome._tag === "Done") {
          if (onDone === undefined) {
            return scope.failCause(Cause.die(
              new Error(
                `Invocation "${invokeId}" completed without the required onDone handler`
              )
            ))
          }
          return sendLifecycle(
            scope,
            InvocationEvent.done(path, invokeId, outcome.output),
            activityKind === undefined ? undefined : activitySessionId
          )
        }
        if (
          outcome._tag === "Failure" &&
          onFailure !== undefined &&
          (descriptor === undefined || !isFrameworkFailure(outcome.error))
        ) {
          return sendLifecycle(
            scope,
            InvocationEvent.failure(path, invokeId, outcome.error),
            activityKind === undefined ? undefined : activitySessionId
          )
        }
        return scope.failCause(outcome.cause)
      },
      ...(onSnapshot === undefined ? undefined : {
        onSnapshot: (isCurrent: () => boolean, snapshot: any) =>
          isCurrent()
            ? sendLifecycle(scope, InvocationEvent.snapshot(path, invokeId, snapshot))
            : Effect.void
      })
    })
  })

const start = (
  scope: Runtime.ProcessScope<any>,
  ownedChildren: Runtime.OwnedChildRuntime,
  path: string,
  config: AnyConfig
): Effect.Effect<void, any, any> => {
  const invokeId = String(config.id)
  return startResolved(
    scope,
    ownedChildren,
    path,
    invokeId,
    config.address === undefined ? makeChildId(path, invokeId) : String(config.address),
    config.descriptor,
    config.src,
    config.onDone,
    config.onFailure,
    config.onSnapshot,
    config.activityKind
  )
}

const startStaticChild = (
  scope: Runtime.ProcessScope<any>,
  ownedChildren: Runtime.OwnedChildRuntime,
  path: string,
  raw: Record<PropertyKey, any>
): Effect.Effect<void, any, any> => {
  // A zero-input child has no entry-context dependency. Reuse the descriptor's
  // source function so each running parent does not retain a resolved config
  // object and an otherwise redundant source closure.
  const descriptor = raw.child as ChildMachine.Any
  return startResolved(
    scope,
    ownedChildren,
    path,
    descriptor.id,
    descriptor.id,
    descriptor,
    descriptor[ChildMachineLogicTypeId],
    raw.onDone,
    raw.onFailure,
    raw.onSnapshot,
    undefined
  )
}

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
    .flatMap((path) => {
      const context = {
        ...(Configuration.getMachineReferences(configuration) ?? { self: scope.self, parent: scope.parent }),
        state: configuration.values.get(path),
        containingState: Configuration.getParentValue(machine, configuration, path),
        ancestors: Configuration.getParentValues(machine, configuration, path),
        event
      }
      return InvocationEvent.definitions(Configuration.getStateConfigByPath(machine, path)?.invoke).map((definition) =>
        "child" in definition && !("input" in definition)
          ? startStaticChild(scope, ownedChildren, path, definition)
          : start(scope, ownedChildren, path, resolveOne(definition, context))
      )
    })
  return effects.length === 0 ? undefined : runSequentialDiscard(effects)
}
