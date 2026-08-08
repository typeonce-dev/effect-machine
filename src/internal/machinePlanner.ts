/**
 * Internal machine planning helpers.
 *
 * @since 4.0.0
 */

import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type { ActionRequirement, InitialEvent as MachineInitialEvent, Machine, Runtime } from "../Machine.js"
import { InfiniteTransitionError, MachineSchemaDecodeError, StartupError } from "./machineErrors.js"
import {
  type ActiveConfiguration,
  captureHistory,
  compareDocumentOrder,
  completeConfigurationEffect,
  configurationFromHistoryRecord,
  decodeEmit,
  decodeEvent,
  decodeInput,
  decodeStateValue,
  getActiveLeafPathFrom,
  getActiveLeafPaths,
  getActiveValue,
  getHistoryRecord,
  getInitialEntryPaths,
  getLeafPath,
  getNode,
  getParentValue,
  getParentValues,
  getPathToRoot,
  getRootPath,
  isActiveFinalConfiguration,
  isChoiceTarget,
  isDescendantOf,
  isHistoryTarget,
  isPathInSubtree,
  isSnapshot,
  isTarget,
  makeChoiceTarget,
  makeTarget,
  normalizeConfiguration,
  normalizeConfigurationEffect,
  normalizeTargetConfigurationEffect,
  pathDepth,
  snapshotFromConfiguration,
  snapshotFromConfigurationAtPath,
  TargetSnapshotTypeId,
  validateInitialConfiguration
} from "./machineModel.js"
import type { ProcessScope } from "./machineRuntime.js"

type DeferredAction<E = any, R = any> = Effect.Effect<void, E, R>

type IsAny<A> = 0 extends (1 & A) ? true : false

type ExcludeCompatibleRuntime<Requirements, Events, Emits> = Requirements extends Runtime.Requirement<
  infer RequiredEvents,
  infer RequiredEmits
> ? IsAny<Requirements> extends true ? Requirements
  : [RequiredEvents] extends [Events] ? [RequiredEmits] extends [Emits] ? never : Requirements
  : Requirements
  : Requirements

interface DeferredQueue<A> {
  readonly add: (value: A) => Effect.Effect<void>
  readonly read: Effect.Effect<ReadonlyArray<A>>
}

class DeferredActions extends Context.Service<DeferredActions, {
  readonly add: <E, R>(effect: DeferredAction<E, R>) => Effect.Effect<void>
  readonly read: Effect.Effect<ReadonlyArray<DeferredAction>>
}>()("effect/Machine/DeferredActions") {}

class DeferredRaisedEvents extends Context.Service<DeferredRaisedEvents, {
  readonly add: <Event>(event: Event) => Effect.Effect<void>
  readonly addEmitted: <Event>(event: Event) => Effect.Effect<void>
  readonly read: Effect.Effect<ReadonlyArray<any>>
  readonly readEmitted: Effect.Effect<ReadonlyArray<any>>
}>()("effect/Machine/DeferredRaisedEvents") {}

class RuntimeContext extends Context.Service<RuntimeContext, Runtime<any, any>>()(
  "effect/Machine/Runtime"
) {}

const makeDeferredQueue = <A>(): Effect.Effect<DeferredQueue<A>> =>
  Effect.sync(() => {
    const values: Array<A> = []
    return {
      read: Effect.sync(() => values),
      add: (value) =>
        Effect.sync(() => {
          values.push(value)
        })
    }
  })

const makeDeferredActions = Effect.map(
  makeDeferredQueue<DeferredAction>(),
  (queue) =>
    DeferredActions.of({
      read: queue.read,
      add: (effect) => queue.add(effect)
    })
)

const makeDeferredRaisedEvents = Effect.gen(function*() {
  const raised = yield* makeDeferredQueue<any>()
  const emitted = yield* makeDeferredQueue<any>()
  return (
    DeferredRaisedEvents.of({
      read: raised.read,
      readEmitted: emitted.read,
      add: (event) => raised.add(event),
      addEmitted: (event) => emitted.add(event)
    })
  )
})

const provideDeferredServices = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  machine: Machine.Any,
  deferredActions: DeferredActions["Service"],
  deferredRaisedEvents: DeferredRaisedEvents["Service"]
): Effect.Effect<A, E | MachineSchemaDecodeError, R> =>
  effect.pipe(
    Effect.provideService(DeferredActions, deferredActions),
    Effect.provideService(DeferredRaisedEvents, deferredRaisedEvents),
    Effect.provideService(RuntimeContext, makePlanningRuntime(machine, deferredRaisedEvents))
  )

const provideRuntimeContext = <A, E, R, Events, Emits>(
  effect: Effect.Effect<A, E, R>,
  runtime: Runtime<Events, Emits>
): Effect.Effect<A, E, ExcludeCompatibleRuntime<R, Events, Emits>> =>
  Effect.provideService(
    effect as Effect.Effect<A, E, R | RuntimeContext>,
    RuntimeContext,
    runtime as Runtime<any, any>
  ) as Effect.Effect<A, E, ExcludeCompatibleRuntime<R, Events, Emits>>

const makePlanningRuntime = <Events, Emits>(
  machine: Machine.Any,
  deferredRaisedEvents: DeferredRaisedEvents["Service"]
): Runtime<Events, Emits> =>
  RuntimeContext.of({
    raise: (event) =>
      decodeEvent(machine, event).pipe(
        Effect.flatMap((event) => deferredRaisedEvents.add(event))
      ),
    sendParent: (event) =>
      decodeEmit(machine, event).pipe(
        Effect.flatMap((event) => deferredRaisedEvents.addEmitted(event))
      )
  })

export const makeLiveRuntime = <Events, Emits>(
  machine: Machine.Any,
  scope: ProcessScope<Events>
): Runtime<Events, Emits> =>
  RuntimeContext.of({
    raise: (event) =>
      decodeEvent(machine, event).pipe(
        Effect.flatMap((event) => scope.self.send(event as Events))
      ),
    sendParent: (event) =>
      decodeEmit(machine, event).pipe(
        Effect.flatMap((event) => scope.sendParent(event))
      )
  })

export const runActions = <E, R, Events, Emits>(
  actions: Iterable<Effect.Effect<void, E, R>>,
  runtime: Runtime<Events, Emits>
): Effect.Effect<void, E, ExcludeCompatibleRuntime<R, Events, Emits>> =>
  Effect.all(
    Array.from(actions, (action) => provideRuntimeContext(action, runtime)),
    { discard: true }
  )

export const runEmittedEvents = <Events, Emits>(
  events: Iterable<Emits>,
  runtime: Runtime<Events, Emits>
) =>
  Effect.all(
    Array.from(events, (event) => runtime.sendParent(event)),
    { discard: true }
  )

export const runtimeFor = <Events, Emits>(): Effect.Effect<
  Runtime<Events, Emits>,
  never,
  Runtime.Requirement<Events, Emits>
> => runtime<{ readonly events: Events; readonly emits: Emits }>()

export type MicrostepPlan<State, Event, E, R> = {
  readonly next: State
  readonly event: Event | MachineInitialEvent
  readonly transitions: ReadonlyArray<{
    readonly source: string
    readonly trigger: Machine.TransitionTrigger
    readonly reenter: boolean
    readonly target: string | undefined
    readonly resolvedTarget: string | undefined
  }>
  readonly actions: ReadonlyArray<Effect.Effect<void, E, R>>
  readonly raisedEvents: ReadonlyArray<Event>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly changed: boolean
}

export type MacrostepPlan<State, Event, E, R, Output> =
  & {
    readonly next: State
    readonly actions: ReadonlyArray<Effect.Effect<void, E, R>>
    readonly microsteps: ReadonlyArray<MicrostepPlan<State, Event, E, R>>
    readonly emittedEvents: ReadonlyArray<unknown>
  }
  & (
    | {
      readonly done: true
      readonly output: Output
    }
    | {
      readonly done: false
      readonly output: undefined
    }
  )

type TransitionHandler<States extends Machine.StateSchemas, E, R, Context> = (
  context: Context
) => Machine.HandlerResult<States, E, R>

type EventTransition<States extends Machine.StateSchemas, E, R, Context> =
  | TransitionHandler<States, E, R, Context>
  | {
    readonly reenter?: boolean
    readonly targets?: ReadonlyArray<string>
    readonly transition: TransitionHandler<States, E, R, Context>
  }

type MicrostepTransition<States extends Machine.StateSchemas, E, R, Context> = {
  readonly reenter: boolean
  readonly targets: ReadonlyArray<string> | undefined
  readonly transition: TransitionHandler<States, E, R, Context>
}

const normalizeTransition = <States extends Machine.StateSchemas, E, R, Context>(
  transition: EventTransition<States, E, R, Context> | undefined
): MicrostepTransition<States, E, R, Context> | undefined => {
  if (transition === undefined) {
    return undefined
  }
  return typeof transition === "function"
    ? { reenter: false, targets: undefined, transition }
    : {
      reenter: transition.reenter === true,
      targets: transition.targets,
      transition: transition.transition
    }
}

const collectStateAction = Effect.fnUntraced(function*<Context, Event, E, R>(
  machine: Machine.Any,
  handler: ((context: Context) => Machine.StateActionResult<E, R>) | undefined,
  context: Context
) {
  if (handler === undefined) {
    return {
      actions: [] as ReadonlyArray<DeferredAction<E, R>>,
      raisedEvents: [] as ReadonlyArray<Event>,
      emittedEvents: [] as ReadonlyArray<unknown>
    }
  }
  const result = handler(context)
  if (!Effect.isEffect(result)) {
    return {
      actions: [] as ReadonlyArray<DeferredAction<E, R>>,
      raisedEvents: [] as ReadonlyArray<Event>,
      emittedEvents: [] as ReadonlyArray<unknown>
    }
  }
  const deferredActions = yield* makeDeferredActions
  const deferredRaisedEvents = yield* makeDeferredRaisedEvents
  yield* provideDeferredServices(result, machine, deferredActions, deferredRaisedEvents)
  const actions = yield* deferredActions.read
  const raisedEvents = yield* deferredRaisedEvents.read
  const emittedEvents = yield* deferredRaisedEvents.readEmitted
  return {
    actions: actions as ReadonlyArray<DeferredAction<E, R>>,
    raisedEvents: raisedEvents as ReadonlyArray<Event>,
    emittedEvents
  }
})

const collectTransition = Effect.fnUntraced(function*<
  const States extends Machine.StateSchemas,
  Event,
  E,
  R,
  Context
>(
  machine: Machine.Any,
  transition: TransitionHandler<States, E, R, Context>,
  context: Context
) {
  const result = transition(context)
  if (!Effect.isEffect(result)) {
    return {
      state: result,
      actions: [] as ReadonlyArray<DeferredAction<E, R>>,
      raisedEvents: [] as ReadonlyArray<Event>,
      emittedEvents: [] as ReadonlyArray<unknown>
    }
  }
  const deferredActions = yield* makeDeferredActions
  const deferredRaisedEvents = yield* makeDeferredRaisedEvents
  const state = yield* provideDeferredServices(result, machine, deferredActions, deferredRaisedEvents)
  const actions = yield* deferredActions.read
  const raisedEvents = yield* deferredRaisedEvents.read
  const emittedEvents = yield* deferredRaisedEvents.readEmitted
  return {
    state,
    actions: actions as ReadonlyArray<DeferredAction<E, R>>,
    raisedEvents: raisedEvents as ReadonlyArray<Event>,
    emittedEvents
  }
})

const collectStateInitializer = Effect.fnUntraced(function*(
  machine: Machine.Any,
  handler: (context: any) => unknown,
  context: any
) {
  const result = handler(context)
  if (!Effect.isEffect(result)) {
    return {
      value: result,
      actions: [] as ReadonlyArray<DeferredAction>,
      raisedEvents: [] as ReadonlyArray<unknown>,
      emittedEvents: [] as ReadonlyArray<unknown>
    }
  }
  const deferredActions = yield* makeDeferredActions
  const deferredRaisedEvents = yield* makeDeferredRaisedEvents
  const value = yield* provideDeferredServices(result, machine, deferredActions, deferredRaisedEvents)
  return {
    value,
    actions: yield* deferredActions.read,
    raisedEvents: yield* deferredRaisedEvents.read,
    emittedEvents: yield* deferredRaisedEvents.readEmitted
  }
})

/** Completes the intentionally partial configuration held by shallow history.
 * Only a compound node with no remembered child invokes an initializer; deep
 * history never reaches this path. */
const completeHistoryConfiguration = Effect.fnUntraced(function*(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  event: unknown
) {
  const active = new Set(configuration.active)
  const values = new Map(configuration.values)
  const actions: Array<DeferredAction> = []
  const raisedEvents: Array<unknown> = []
  const emittedEvents: Array<unknown> = []

  let changed = true
  while (changed) {
    changed = false
    for (const path of Array.from(active).sort((left, right) => compareDocumentOrder(machine, left, right))) {
      const node = getNode(machine, path)
      if (node.type === "compound" && !node.children.some((child) => active.has(child))) {
        if (node.initial === undefined) {
          throw new Error(`Machine shallow history expected compound state "${path}" to have an initial child`)
        }
        const initializer = machine.handlers[path]?.initial
        if (initializer === undefined) {
          throw new Error(`Machine shallow history requires an initial value implementation for state "${path}"`)
        }
        const current = {
          active,
          values,
          outputs: configuration.outputs,
          history: configuration.history
        } as ActiveConfiguration
        const initialized = yield* collectStateInitializer(machine, initializer, {
          state: getActiveValue(current, path),
          parent: getParentValue(machine, current, path),
          parents: getParentValues(machine, current, path),
          event,
          ...makePlanningCapabilities()
        })
        const child = getNode(machine, node.initial)
        active.add(child.path)
        values.set(child.path, yield* decodeStateValue(machine, child, initialized.value))
        actions.push(...initialized.actions)
        raisedEvents.push(...initialized.raisedEvents)
        emittedEvents.push(...initialized.emittedEvents)
        changed = true
      }
      if (node.type === "parallel") {
        const missing = node.children.filter((childPath) => !active.has(childPath))
        if (missing.length > 0) {
          const initializer = machine.handlers[path]?.initial
          if (initializer === undefined) {
            throw new Error(`Machine shallow history requires an initial value implementation for state "${path}"`)
          }
          const current = {
            active,
            values,
            outputs: configuration.outputs,
            history: configuration.history
          } as ActiveConfiguration
          const initialized = yield* collectStateInitializer(machine, initializer, {
            state: getActiveValue(current, path),
            parent: getParentValue(machine, current, path),
            parents: getParentValues(machine, current, path),
            event,
            ...makePlanningCapabilities()
          })
          if (typeof initialized.value !== "object" || initialized.value === null) {
            throw new Error(`Machine parallel state initializer for "${path}" must return its region values`)
          }
          for (const childPath of missing) {
            const child = getNode(machine, childPath)
            if (!Object.prototype.hasOwnProperty.call(initialized.value, child.key)) {
              throw new Error(`Machine parallel state initializer for "${path}" must return region "${child.key}"`)
            }
            active.add(child.path)
            values.set(
              child.path,
              yield* decodeStateValue(machine, child, (initialized.value as Record<string, unknown>)[child.key])
            )
          }
          actions.push(...initialized.actions)
          raisedEvents.push(...initialized.raisedEvents)
          emittedEvents.push(...initialized.emittedEvents)
          changed = true
        }
      }
    }
  }
  return {
    configuration: {
      active,
      values,
      outputs: new Map<string, unknown>(),
      history: configuration.history
    } as ActiveConfiguration,
    actions,
    raisedEvents,
    emittedEvents
  }
})

const resolveHistoryTarget = Effect.fnUntraced(function*(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  target: { readonly path: string; readonly parent: string },
  event: unknown
) {
  const node = getNode(machine, target.path)
  if (node.type !== "history" || node.parent !== target.parent) {
    throw new Error(`Machine expected history target "${target.path}" to resolve to its declared parent`)
  }
  const record = getHistoryRecord(configuration, target.path)
  if (record !== undefined) {
    const restored = configurationFromHistoryRecord(machine, configuration, record)
    // Deep records are already complete below the history parent. This pass is
    // still required for parallel ancestors outside that parent whose other
    // regions must be initialized when the ancestor is re-entered.
    const completed = yield* completeHistoryConfiguration(machine, restored, event)
    const snapshot = snapshotFromConfigurationAtPath(machine, completed.configuration, target.parent)
    const values = Object.fromEntries(completed.configuration.values)
    return {
      target: makeTarget(target.parent as any, snapshot.value as any, {
        snapshot: snapshot as any,
        values: values as any
      }),
      actions: completed.actions,
      raisedEvents: completed.raisedEvents,
      emittedEvents: completed.emittedEvents,
      transitions: []
    }
  }

  const key = node.key
  const fallback = machine.handlers[target.parent]?.history?.[key]?.default
  if (fallback === undefined) {
    throw new Error(`Machine history state "${target.path}" requires a default implementation`)
  }
  const collected = yield* collectTransition(machine, fallback, {
    event,
    ...makePlanningCapabilities(),
    target: machine.makeTargetBuilder(target.parent).full,
    parent: target.parent
  })
  if (collected.state === undefined || isHistoryTarget(collected.state) || !isSnapshot(collected.state)) {
    throw new Error(`Machine history default for "${target.path}" must return a complete snapshot containing its owner`)
  }
  const fallbackChoice = choiceFromTarget(collected.state)
  const choiceResolution = fallbackChoice === undefined
    ? undefined
    : yield* resolveChoiceTarget(
      machine,
      {
        active: new Set(),
        values: new Map(),
        outputs: new Map(),
        history: configuration.history
      },
      collected.state,
      event
    )
  let fallbackConfiguration = choiceResolution === undefined
    ? yield* normalizeConfigurationEffect(machine, collected.state as any)
    : yield* normalizeTargetConfigurationEffect(machine, {
      active: new Set(),
      values: new Map(),
      outputs: new Map(),
      history: configuration.history
    }, choiceResolution.target as any)
  for (const additionalTarget of choiceResolution?.additionalTargets ?? []) {
    fallbackConfiguration = yield* normalizeTargetConfigurationEffect(
      machine,
      fallbackConfiguration,
      additionalTarget as
        | Machine.Snapshot<any>
        | Machine.Target<any, string>
    )
  }
  if (!fallbackConfiguration.active.has(target.parent)) {
    throw new Error(
      `Machine history default for "${target.path}" returned a configuration that does not contain owner state "${target.parent}"`
    )
  }
  const snapshot = snapshotFromConfigurationAtPath(machine, fallbackConfiguration, target.parent)
  const values = Object.fromEntries(fallbackConfiguration.values)
  return {
    target: makeTarget(target.parent as any, snapshot.value as any, {
      snapshot: snapshot as any,
      values: values as any
    }),
    actions: [...collected.actions, ...(choiceResolution?.actions ?? [])],
    raisedEvents: [...collected.raisedEvents, ...(choiceResolution?.raisedEvents ?? [])],
    emittedEvents: [...collected.emittedEvents, ...(choiceResolution?.emittedEvents ?? [])],
    transitions: choiceResolution?.transitions ?? []
  }
})

type SelectedTransition<States extends Machine.StateSchemas, E, R, Context> = {
  readonly sourcePath: string
  readonly leafPath: string
  readonly trigger: Machine.TransitionTrigger
  readonly transition: MicrostepTransition<States, E, R, Context>
  readonly context: Context
}

type EvaluatedTransition<States extends Machine.StateSchemas, Event, E, R, Context> = {
  readonly selection: SelectedTransition<States, E, R, Context>
  readonly unresolvedTarget:
    | Machine.Snapshot<States>
    | Machine.Target<States, Machine.StateIdentifier<States>>
    | Machine.HistoryTarget<States, Machine.HistoryIdentifier<States>>
    | Machine.ChoiceTarget<States, Machine.ChoiceIdentifier<States>>
    | undefined
  readonly target:
    | Machine.Snapshot<States>
    | Machine.Target<States, Machine.StateIdentifier<States>>
    | undefined
  readonly actions: ReadonlyArray<Effect.Effect<void, E, R>>
  readonly raisedEvents: ReadonlyArray<Event>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly changed: boolean
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly choiceTransitions: ReadonlyArray<{
    readonly source: string
    readonly trigger: Machine.TransitionTrigger
    readonly reenter: false
    readonly target: string
    readonly resolvedTarget: string
  }>
}

const getCandidatePaths = (machine: Machine.Any, configuration: ActiveConfiguration): ReadonlyArray<string> =>
  Array.from(configuration.active)
    .sort((left, right) => {
      const depth = pathDepth(machine, right) - pathDepth(machine, left)
      return depth === 0 ? compareDocumentOrder(machine, left, right) : depth
    })

const getLeafCandidatePaths = (machine: Machine.Any, leaf: string): ReadonlyArray<string> =>
  [...getPathToRoot(machine, leaf)].reverse()

const getLeastCommonAncestor = (
  machine: Machine.Any,
  left: string,
  right: string
): string | undefined => {
  const leftPath = getPathToRoot(machine, left)
  const rightPath = getPathToRoot(machine, right)
  let ancestor: string | undefined = undefined
  const length = Math.min(leftPath.length, rightPath.length)
  for (let index = 0; index < length; index++) {
    if (leftPath[index] !== rightPath[index]) {
      break
    }
    ancestor = leftPath[index]
  }
  return ancestor
}

const broadenTransitionBoundary = (
  naturalBoundary: string | undefined,
  reentryBoundary: string | undefined
): string | undefined => {
  if (naturalBoundary === undefined || reentryBoundary === undefined) return undefined
  return naturalBoundary === reentryBoundary || isDescendantOf(naturalBoundary, reentryBoundary)
    ? reentryBoundary
    : naturalBoundary
}

const getExitPaths = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  boundary: string | undefined
): ReadonlyArray<string> =>
  sortExitPaths(
    machine,
    Array.from(configuration.active)
      .filter((path) => boundary === undefined || isDescendantOf(path, boundary))
  )

const getEntryPaths = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  boundary: string | undefined
): ReadonlyArray<string> =>
  sortEntryPaths(
    machine,
    Array.from(configuration.active).filter((path) => boundary === undefined || isDescendantOf(path, boundary))
  )

const hasSameActivePaths = (left: ActiveConfiguration, right: ActiveConfiguration): boolean =>
  left.active.size === right.active.size && Array.from(left.active).every((path) => right.active.has(path))

export const sortExitPaths = (machine: Machine.Any, paths: Iterable<string>): ReadonlyArray<string> =>
  Array.from(new Set(paths))
    .sort((left, right) => {
      const depth = getPathToRoot(machine, right).length - getPathToRoot(machine, left).length
      return depth === 0 ? getNode(machine, right).order - getNode(machine, left).order : depth
    })

export const sortEntryPaths = (machine: Machine.Any, paths: Iterable<string>): ReadonlyArray<string> =>
  Array.from(new Set(paths))
    .sort((left, right) => {
      const depth = getPathToRoot(machine, left).length - getPathToRoot(machine, right).length
      return depth === 0 ? compareDocumentOrder(machine, left, right) : depth
    })

const makePlanningCapabilities = <Events, Emits>(): Machine.PlanningCapabilities<Events, Emits> & {
  readonly runtime: Effect.Effect<Runtime<Events, Emits>, never, Runtime.Requirement<Events, Emits>>
} => {
  const runtimeEffect = runtimeFor<Events, Emits>()
  return {
    runtime: runtimeEffect,
    raise: (event) => Effect.flatMap(runtimeEffect, (runtime) => runtime.raise(event)),
    emit: (event) => Effect.flatMap(runtimeEffect, (runtime) => runtime.sendParent(event))
  }
}

const makeStateActionContext = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema>,
  StateId extends Machine.StateIdentifier<States>
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string,
  event: Machine.LifecycleEvent<Events>
): Machine.StateActionContext<States, Events, Emits, StateId> => ({
  state: getActiveValue(configuration, path) as Machine.StateByIdentifier<States, StateId>,
  parent: getParentValue(machine, configuration, path) as Machine.ParentStateValue<States, StateId>,
  parents: getParentValues(machine, configuration, path) as Machine.ParentStateValues<States, StateId>,
  event,
  ...makePlanningCapabilities<Machine.EventOf<Events>, Machine.EmitOf<Emits>>()
})

const makeTransitionContext = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema>,
  StateId extends Machine.StateIdentifier<States>,
  EventTag extends Machine.TagOf<Events[number]>
>(
  machine: Machine<States, Events, any, any, any, any, any, any, any, any, Emits>,
  configuration: ActiveConfiguration,
  path: string,
  event: Machine.EventByTag<Events, EventTag>,
  snapshot: Machine.Snapshot<States>
): Machine.HandlerContext<States, Events, Emits, StateId, EventTag, any, any> => ({
  state: getActiveValue(configuration, path) as Machine.StateByIdentifier<States, StateId>,
  parent: getParentValue(machine, configuration, path) as Machine.ParentStateValue<States, StateId>,
  parents: getParentValues(machine, configuration, path) as Machine.ParentStateValues<States, StateId>,
  event,
  snapshot,
  ...makePlanningCapabilities<Machine.EventOf<Events>, Machine.EmitOf<Emits>>(),
  target: machine.makeTargetBuilder(path as StateId)
})

const makeDoneContext = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema>,
  StateId extends Machine.StateIdentifier<States>
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string,
  event: Machine.LifecycleEvent<Events>,
  output: unknown,
  snapshot: Machine.Snapshot<States>
): Machine.DoneContext<States, Events, Emits, StateId> => ({
  state: getActiveValue(configuration, path) as Machine.StateByIdentifier<States, StateId>,
  parent: getParentValue(machine, configuration, path) as Machine.ParentStateValue<States, StateId>,
  parents: getParentValues(machine, configuration, path) as Machine.ParentStateValues<States, StateId>,
  event,
  output: output as Machine.CompletionOutputByIdentifier<States, StateId>,
  snapshot,
  ...makePlanningCapabilities<Machine.EventOf<Events>, Machine.EmitOf<Emits>>(),
  target: machine.makeTargetBuilder(path as StateId)
})

const collectStateActions = Effect.fnUntraced(function*<
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema>,
  E,
  R
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  paths: ReadonlyArray<string>,
  event: Machine.LifecycleEvent<Events>,
  key: "entry" | "exit"
) {
  const actions: Array<DeferredAction<E, R>> = []
  const raisedEvents: Array<Machine.EventOf<Events>> = []
  const emittedEvents: Array<Machine.EmitOf<Emits>> = []
  for (const path of paths) {
    const collected = yield* collectStateAction<
      Machine.StateActionContext<States, Events, Emits, Machine.StateIdentifier<States>>,
      Machine.EventOf<Events>,
      E,
      R
    >(
      machine,
      machine.handlers[path]?.[key],
      makeStateActionContext<States, Events, Emits, Machine.StateIdentifier<States>>(
        machine,
        configuration,
        path,
        event
      )
    )
    actions.push(...collected.actions)
    raisedEvents.push(...collected.raisedEvents)
    emittedEvents.push(...collected.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>)
  }
  return { actions, emittedEvents, raisedEvents }
})

const selectAlwaysTransitions = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema>,
  E,
  R
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  event: Machine.LifecycleEvent<Events>
): ReadonlyArray<
  SelectedTransition<
    States,
    E,
    R,
    Machine.AlwaysContext<States, Events, Emits, Machine.StateIdentifier<States>>
  >
> => {
  const selected: Array<
    SelectedTransition<
      States,
      E,
      R,
      Machine.AlwaysContext<States, Events, Emits, Machine.StateIdentifier<States>>
    >
  > = []
  const selectedSources = new Set<string>()
  let snapshot: Machine.Snapshot<States> | undefined
  const capturedSnapshot = () => snapshot ??= snapshotFromConfiguration<States>(machine, configuration)
  for (const leaf of getActiveLeafPaths(machine, configuration)) {
    for (const path of getLeafCandidatePaths(machine, leaf)) {
      const always = normalizeTransition(machine.handlers[path]?.always)
      if (always !== undefined) {
        if (!selectedSources.has(path)) {
          selectedSources.add(path)
          selected.push({
            sourcePath: path,
            leafPath: leaf,
            trigger: { type: "always" },
            transition: always as unknown as MicrostepTransition<
              States,
              E,
              R,
              Machine.AlwaysContext<States, Events, Emits, Machine.StateIdentifier<States>>
            >,
            context: {
              state: getActiveValue(configuration, path) as Machine.StateByIdentifier<
                States,
                Machine.StateIdentifier<States>
              >,
              parent: getParentValue(machine, configuration, path) as Machine.ParentStateValue<
                States,
                Machine.StateIdentifier<States>
              >,
              parents: getParentValues(machine, configuration, path) as Machine.ParentStateValues<
                States,
                Machine.StateIdentifier<States>
              >,
              event,
              snapshot: capturedSnapshot(),
              ...makePlanningCapabilities<Machine.EventOf<Events>, Machine.EmitOf<Emits>>(),
              target: machine.makeTargetBuilder(path as Machine.StateIdentifier<States>)
            }
          })
        }
        break
      }
    }
  }
  return selected
}

const selectDoneTransitions = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema>,
  E,
  R
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  event: Machine.LifecycleEvent<Events>,
  completions: ReadonlyArray<{ readonly path: string; readonly output: unknown }>
): ReadonlyArray<
  SelectedTransition<
    States,
    E,
    R,
    Machine.DoneContext<States, Events, Emits, Machine.StateIdentifier<States>>
  >
> => {
  const selected: Array<
    SelectedTransition<
      States,
      E,
      R,
      Machine.DoneContext<States, Events, Emits, Machine.StateIdentifier<States>>
    >
  > = []
  const selectedSources = new Set<string>()
  let snapshot: Machine.Snapshot<States> | undefined
  const capturedSnapshot = () => snapshot ??= snapshotFromConfiguration<States>(machine, configuration)
  for (const completion of completions) {
    const onDone = normalizeTransition(machine.handlers[completion.path]?.onDone)
    if (onDone !== undefined && !selectedSources.has(completion.path)) {
      selectedSources.add(completion.path)
      selected.push({
        sourcePath: completion.path,
        leafPath: getActiveLeafPathFrom(machine, configuration, completion.path),
        trigger: { type: "done" },
        transition: onDone as unknown as MicrostepTransition<
          States,
          E,
          R,
          Machine.DoneContext<States, Events, Emits, Machine.StateIdentifier<States>>
        >,
        context: makeDoneContext<States, Events, Emits, Machine.StateIdentifier<States>>(
          machine,
          configuration,
          completion.path,
          event,
          completion.output,
          capturedSnapshot()
        )
      })
    }
  }
  return selected
}

const selectEventTransitions = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema>,
  E,
  R
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  event: Machine.EventByTag<Events, Machine.TagOf<Events[number]>>
): ReadonlyArray<
  SelectedTransition<
    States,
    E,
    R,
    Machine.HandlerContext<States, Events, Emits, Machine.StateIdentifier<States>, Machine.TagOf<Events[number]>, E, R>
  >
> => {
  const selected: Array<
    SelectedTransition<
      States,
      E,
      R,
      Machine.HandlerContext<
        States,
        Events,
        Emits,
        Machine.StateIdentifier<States>,
        Machine.TagOf<Events[number]>,
        E,
        R
      >
    >
  > = []
  const selectedSources = new Set<string>()
  let snapshot: Machine.Snapshot<States> | undefined
  const capturedSnapshot = () => snapshot ??= snapshotFromConfiguration<States>(machine, configuration)
  for (const leaf of getActiveLeafPaths(machine, configuration)) {
    for (const path of getLeafCandidatePaths(machine, leaf)) {
      const transition = normalizeTransition(machine.handlers[path]?.on?.[event._tag])
      if (transition !== undefined) {
        if (!selectedSources.has(path)) {
          selectedSources.add(path)
          selected.push({
            sourcePath: path,
            leafPath: leaf,
            trigger: { type: "event", event: event._tag },
            transition: transition as unknown as MicrostepTransition<
              States,
              E,
              R,
              Machine.HandlerContext<
                States,
                Events,
                Emits,
                Machine.StateIdentifier<States>,
                Machine.TagOf<Events[number]>,
                E,
                R
              >
            >,
            context: makeTransitionContext<
              States,
              Events,
              Emits,
              Machine.StateIdentifier<States>,
              Machine.TagOf<Events[number]>
            >(machine as any, configuration, path, event, capturedSnapshot())
          })
        }
        break
      }
    }
  }
  return selected
}

const getTargetNodePath = <const States extends Machine.StateSchemas>(
  target:
    | Machine.Snapshot<States>
    | Machine.Target<States, Machine.StateIdentifier<States>>
    | Machine.HistoryTarget<States, Machine.HistoryIdentifier<States>>
    | Machine.ChoiceTarget<States, Machine.ChoiceIdentifier<States>>
): string => {
  if (isHistoryTarget(target) || isChoiceTarget(target)) {
    return String(target.path)
  }
  if (isTarget(target)) {
    return String(target.path)
  }
  if (isSnapshot(target)) {
    return String(target.path)
  }
  throw new Error("Machine expected transition target to be a snapshot or target builder result")
}

const validateDeclaredTransitionTarget = (
  sourcePath: string,
  trigger: Machine.TransitionTrigger,
  declaredTargets: ReadonlyArray<string> | undefined,
  target: unknown
): void => {
  if (declaredTargets === undefined || target === undefined) {
    return
  }
  const actual = typeof target === "object" && target !== null && "path" in target
    ? String(target.path)
    : "<unknown>"
  if (!declaredTargets.some((path) => actual === path || actual.startsWith(`${path}.`))) {
    const triggerLabel = trigger.type === "event" ? String(trigger.event) : trigger.type
    throw new Error(
      `Machine transition from "${sourcePath}" on "${triggerLabel}" returned target "${actual}" outside declared targets: ${
        declaredTargets.length === 0 ? "none" : declaredTargets.map((path) => `"${path}"`).join(", ")
      }`
    )
  }
}

const hasPathIntersection = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  for (const path of left) {
    if (right.includes(path)) {
      return true
    }
  }
  return false
}

const sortEvaluatedTransitions = <
  const States extends Machine.StateSchemas,
  Event,
  E,
  R,
  Context
>(
  machine: Machine.Any,
  transitions: Iterable<EvaluatedTransition<States, Event, E, R, Context>>
): ReadonlyArray<EvaluatedTransition<States, Event, E, R, Context>> =>
  Array.from(transitions)
    .sort((left, right) => compareDocumentOrder(machine, left.selection.sourcePath, right.selection.sourcePath))

const removePreemptedAncestorSelections = <
  const States extends Machine.StateSchemas,
  E,
  R,
  Context
>(
  selections: ReadonlyArray<SelectedTransition<States, E, R, Context>>
): ReadonlyArray<SelectedTransition<States, E, R, Context>> =>
  selections.filter((selection) =>
    !selections.some((other) =>
      other.sourcePath !== selection.sourcePath && isDescendantOf(other.sourcePath, selection.sourcePath)
    )
  )

const removeConflictingTransitions = <
  const States extends Machine.StateSchemas,
  Event,
  E,
  R,
  Context
>(
  machine: Machine.Any,
  transitions: ReadonlyArray<EvaluatedTransition<States, Event, E, R, Context>>
): ReadonlyArray<EvaluatedTransition<States, Event, E, R, Context>> => {
  const filtered: Array<EvaluatedTransition<States, Event, E, R, Context>> = []
  for (const transition of sortEvaluatedTransitions(machine, transitions)) {
    let preempted = false
    const transitionsToRemove = new Set<EvaluatedTransition<States, Event, E, R, Context>>()
    for (const selected of filtered) {
      if (hasPathIntersection(transition.exitPaths, selected.exitPaths)) {
        if (isDescendantOf(transition.selection.sourcePath, selected.selection.sourcePath)) {
          transitionsToRemove.add(selected)
        } else {
          preempted = true
          break
        }
      }
    }
    if (!preempted) {
      for (const removed of transitionsToRemove) {
        const index = filtered.indexOf(removed)
        if (index >= 0) {
          filtered.splice(index, 1)
        }
      }
      filtered.push(transition)
    }
  }
  return filtered
}

const choicesFromTarget = (
  target: unknown,
  inheritedValues: Readonly<Record<string, unknown>> = {}
): ReadonlyArray<{
  readonly target: ReturnType<typeof makeChoiceTarget>
  readonly values: Readonly<Record<string, unknown>>
}> => {
  const values: Record<string, unknown> = { ...inheritedValues }
  const choices: Array<ReturnType<typeof makeChoiceTarget>> = []
  const visit = (current: unknown): void => {
    if (isChoiceTarget(current)) {
      Object.assign(values, current.values ?? {})
      choices.push(current)
      return
    }
    if (typeof current !== "object" || current === null || !("path" in current) || !("value" in current)) return
    values[String(current.path)] = current.value
    if ("state" in current) visit(current.state)
    if ("states" in current && typeof current.states === "object" && current.states !== null) {
      for (const state of Object.values(current.states)) visit(state)
    }
  }
  visit(target)
  return choices.map((choice) => ({
    target: makeChoiceTarget(choice.path, choice.parent, values),
    values
  }))
}

const choiceFromTarget = (
  target: unknown,
  inheritedValues: Readonly<Record<string, unknown>> = {}
) => choicesFromTarget(target, inheritedValues)[0]

const withChoiceValues = (target: unknown, values: Readonly<Record<string, unknown>>): unknown => {
  if (isChoiceTarget(target)) {
    return makeChoiceTarget(target.path, target.parent, { ...values, ...(target.values ?? {}) })
  }
  if (!isTarget(target) || Object.keys(values).length === 0) return target
  return makeTarget(target.path as any, target.value, {
    snapshot: (target as any)[TargetSnapshotTypeId],
    values: { ...values, ...(target.values ?? {}) } as any
  })
}

interface ResolvedChoiceTransition {
  readonly source: string
  readonly trigger: Machine.TransitionTrigger
  readonly reenter: false
  readonly target: string
  readonly resolvedTarget: string
}

const resolveChoiceTarget = Effect.fnUntraced(function*(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  initialTarget: unknown,
  event: unknown
) {
  const pending: Array<unknown> = [initialTarget]
  const resolvedTargets: Array<unknown> = []
  const actions: Array<DeferredAction> = []
  const raisedEvents: Array<unknown> = []
  const emittedEvents: Array<unknown> = []
  const transitions: Array<ResolvedChoiceTransition> = []
  let iterations = 0

  while (pending.length > 0) {
    let current: unknown = pending.shift()
    while (true) {
      const extractedChoices = choicesFromTarget(current)
      const extracted = extractedChoices[0]
      if (extracted === undefined) break
      pending.unshift(...extractedChoices.slice(1).map(({ target }) => target))
      iterations += 1
      if (iterations > MaxMacrostepIterations) {
        return yield* new InfiniteTransitionError({
          machineId: machine.id,
          state: extracted.target.path,
          maxIterations: MaxMacrostepIterations
        })
      }
      const node = getNode(machine, extracted.target.path)
      if (node.type !== "choice" || node.parent !== extracted.target.parent) {
        throw new Error(`Machine expected choice target "${extracted.target.path}" to resolve to its declared parent`)
      }
      const choice = (machine.handlers[node.path] as any)?.choice
      if (choice === undefined || typeof choice.transition !== "function") {
        throw new Error(`Machine choice state "${node.path}" requires an implementation`)
      }
      const provisional: ActiveConfiguration = {
        active: new Set([
          ...configuration.active,
          ...Object.keys(extracted.values)
        ]),
        values: new Map([
          ...configuration.values,
          ...Object.entries(extracted.values)
        ]),
        outputs: configuration.outputs,
        history: configuration.history
      }
      const collected = yield* collectTransition(machine, choice.transition, {
        parent: getParentValue(machine, provisional, node.path),
        parents: getParentValues(machine, provisional, node.path),
        event,
        ...makePlanningCapabilities(),
        target: machine.makeTargetBuilder(node.path as any)
      })
      if (collected.state === undefined) {
        throw new Error(`Machine choice resolver for "${node.path}" must return a target`)
      }
      validateDeclaredTransitionTarget(node.path, { type: "choice" }, choice.targets, collected.state)
      const returnedPath = getTargetNodePath(collected.state as any)
      current = withChoiceValues(collected.state, extracted.values)
      const nested = choiceFromTarget(current)
      transitions.push({
        source: node.path,
        trigger: { type: "choice" },
        reenter: false,
        target: returnedPath,
        resolvedTarget: nested?.target.path ?? returnedPath
      })
      actions.push(...collected.actions)
      raisedEvents.push(...collected.raisedEvents)
      emittedEvents.push(...collected.emittedEvents)
    }

    if (!isTarget(current) && !isSnapshot(current) && !isHistoryTarget(current)) {
      throw new Error("Machine choice resolver must return a concrete typed target")
    }
    resolvedTargets.push(current)
  }

  return {
    target: resolvedTargets[0],
    additionalTargets: resolvedTargets.slice(1),
    actions,
    raisedEvents,
    emittedEvents,
    transitions
  }
})

const collectEvaluatedTransition = Effect.fnUntraced(function*<
  const States extends Machine.StateSchemas,
  Event,
  E,
  R,
  Context
>(
  machine: Machine.Any,
  state: ActiveConfiguration,
  selection: SelectedTransition<States, E, R, Context>
) {
  const stateIdentifier = selection.leafPath
  const transitionResult = yield* collectTransition<States, Event, E, R, Context>(
    machine,
    selection.transition.transition,
    selection.context
  )
  const unresolvedTarget = transitionResult.state === undefined
    ? undefined
    : transitionResult.state as
      | Machine.Snapshot<States>
      | Machine.Target<States, Machine.StateIdentifier<States>>
      | Machine.HistoryTarget<States, Machine.HistoryIdentifier<States>>
      | Machine.ChoiceTarget<States, Machine.ChoiceIdentifier<States>>
  validateDeclaredTransitionTarget(
    selection.sourcePath,
    selection.trigger,
    selection.transition.targets,
    unresolvedTarget
  )
  const choiceResolution = unresolvedTarget === undefined
    ? undefined
    : yield* (resolveChoiceTarget(
      machine,
      state,
      unresolvedTarget,
      (selection.context as any).event
    ) as Effect.Effect<any, E | InfiniteTransitionError | MachineSchemaDecodeError, R>)
  const choiceResolvedTarget = choiceResolution?.target ?? unresolvedTarget
  let historyResolution: {
    readonly target: unknown
    readonly actions: ReadonlyArray<DeferredAction>
    readonly raisedEvents: ReadonlyArray<unknown>
    readonly emittedEvents: ReadonlyArray<unknown>
    readonly transitions: ReadonlyArray<ResolvedChoiceTransition>
  } | undefined
  const reenteredHistoryParent = choiceResolvedTarget !== undefined && isHistoryTarget(choiceResolvedTarget) &&
    selection.transition.reenter && state.active.has(choiceResolvedTarget.parent)
  if (choiceResolvedTarget !== undefined && isHistoryTarget(choiceResolvedTarget)) {
    // A reentering transition may exit the history node's own parent. SCXML
    // history observes that same exit, so resolve against a provisional
    // capture rather than an older record (or the default).
    const provisionalBoundary = selection.transition.reenter
      ? getNode(machine, selection.sourcePath).parent
      : getLeastCommonAncestor(machine, stateIdentifier, choiceResolvedTarget.parent)
    const provisionalExitPaths = reenteredHistoryParent
      ? sortExitPaths(
        machine,
        Array.from(state.active).filter((path) => isPathInSubtree(path, choiceResolvedTarget.parent))
      )
      : getExitPaths(machine, state, provisionalBoundary)
    const stateAtHistoryResolution = provisionalExitPaths.includes(choiceResolvedTarget.parent)
      ? captureHistory(machine, state, state, provisionalExitPaths)
      : state
    historyResolution = yield* resolveHistoryTarget(
      machine,
      stateAtHistoryResolution,
      choiceResolvedTarget,
      (selection.context as any).event
    )
  }
  const target: Machine.Snapshot<States> | Machine.Target<States, Machine.StateIdentifier<States>> | undefined =
    historyResolution === undefined
      ? choiceResolvedTarget as
        | Machine.Snapshot<States>
        | Machine.Target<States, Machine.StateIdentifier<States>>
        | undefined
      : historyResolution.target as
        | Machine.Snapshot<States>
        | Machine.Target<States, Machine.StateIdentifier<States>>
  const additionalHistoryActions: Array<DeferredAction> = []
  const additionalHistoryRaisedEvents: Array<unknown> = []
  const additionalHistoryEmittedEvents: Array<unknown> = []
  const additionalHistoryChoiceTransitions: Array<ResolvedChoiceTransition> = []
  const additionalChoiceTargets: Array<
    Machine.Snapshot<States> | Machine.Target<States, Machine.StateIdentifier<States>>
  > = []
  for (const additionalTarget of choiceResolution?.additionalTargets ?? []) {
    if (!isHistoryTarget(additionalTarget)) {
      additionalChoiceTargets.push(additionalTarget as any)
      continue
    }
    const resolved = yield* resolveHistoryTarget(
      machine,
      state,
      additionalTarget,
      (selection.context as any).event
    )
    additionalChoiceTargets.push(resolved.target as any)
    additionalHistoryActions.push(...resolved.actions)
    additionalHistoryRaisedEvents.push(...resolved.raisedEvents)
    additionalHistoryEmittedEvents.push(...resolved.emittedEvents)
    additionalHistoryChoiceTransitions.push(...resolved.transitions)
  }
  const targetPath = target === undefined
    ? undefined
    : additionalChoiceTargets.length === 0 || unresolvedTarget === undefined
    ? getTargetNodePath(target)
    : getTargetNodePath(unresolvedTarget)
  let stateAfterTransition = target === undefined
    ? state
    : yield* normalizeTargetConfigurationEffect<States>(machine, state, target)
  for (const additionalTarget of additionalChoiceTargets) {
    stateAfterTransition = yield* normalizeTargetConfigurationEffect<States>(
      machine,
      stateAfterTransition,
      additionalTarget
    )
  }
  const changed = selection.transition.reenter || !hasSameActivePaths(state, stateAfterTransition)

  if (!changed) {
    return {
      selection,
      unresolvedTarget,
      target,
      actions: [
        ...transitionResult.actions,
        ...(choiceResolution?.actions ?? []),
        ...(historyResolution?.actions ?? []),
        ...additionalHistoryActions
      ],
      raisedEvents: [
        ...transitionResult.raisedEvents,
        ...(choiceResolution?.raisedEvents ?? []),
        ...(historyResolution?.raisedEvents ?? []),
        ...additionalHistoryRaisedEvents
      ],
      emittedEvents: [
        ...transitionResult.emittedEvents,
        ...(choiceResolution?.emittedEvents ?? []),
        ...(historyResolution?.emittedEvents ?? []),
        ...additionalHistoryEmittedEvents
      ],
      changed,
      exitPaths: [],
      entryPaths: [],
      choiceTransitions: [
        ...(choiceResolution?.transitions ?? []),
        ...(historyResolution?.transitions ?? []),
        ...additionalHistoryChoiceTransitions
      ]
    } as EvaluatedTransition<States, Event, E, R, Context>
  }

  const naturalBoundary = targetPath === undefined
    ? getNode(machine, selection.sourcePath).parent
    : getLeastCommonAncestor(machine, stateIdentifier, targetPath)
  const reentryBoundary = getNode(machine, selection.sourcePath).parent
  const boundary = selection.transition.reenter
    ? broadenTransitionBoundary(naturalBoundary, reentryBoundary)
    : naturalBoundary

  return {
    selection,
    unresolvedTarget,
    target,
    actions: [
      ...transitionResult.actions,
      ...(choiceResolution?.actions ?? []),
      ...(historyResolution?.actions ?? []),
      ...additionalHistoryActions
    ],
    raisedEvents: [
      ...transitionResult.raisedEvents,
      ...(choiceResolution?.raisedEvents ?? []),
      ...(historyResolution?.raisedEvents ?? []),
      ...additionalHistoryRaisedEvents
    ],
    emittedEvents: [
      ...transitionResult.emittedEvents,
      ...(choiceResolution?.emittedEvents ?? []),
      ...(historyResolution?.emittedEvents ?? []),
      ...additionalHistoryEmittedEvents
    ],
    changed,
    exitPaths: reenteredHistoryParent
      ? sortExitPaths(
        machine,
        Array.from(state.active).filter((path) => isPathInSubtree(path, (choiceResolvedTarget as any).parent))
      )
      : getExitPaths(machine, state, boundary),
    entryPaths: reenteredHistoryParent
      ? sortEntryPaths(
        machine,
        Array.from(stateAfterTransition.active).filter((path) =>
          isPathInSubtree(path, (choiceResolvedTarget as any).parent)
        )
      )
      : getEntryPaths(machine, stateAfterTransition, boundary),
    choiceTransitions: [
      ...(choiceResolution?.transitions ?? []),
      ...(historyResolution?.transitions ?? []),
      ...additionalHistoryChoiceTransitions
    ]
  } as EvaluatedTransition<States, Event, E, R, Context>
})

const MaxMacrostepIterations = 1000
export const InitialEventTypeId: unique symbol = Symbol("effect/Machine/InitialEvent")
export const InitialEvent: MachineInitialEvent = { _tag: InitialEventTypeId }

const catchStartup = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | StartupError, R> =>
  Effect.catchCause(effect, (cause): Effect.Effect<never, E | StartupError> => {
    if (Cause.hasDies(cause)) {
      return Effect.fail(new StartupError({ cause }))
    }
    return Effect.failCause(cause)
  })

export const isFinalState = (
  machine: Machine.Any,
  state: Machine.Snapshot<any>
): boolean => isActiveFinalConfiguration(machine, normalizeConfiguration(machine, state))

export const getFinalOutputEffect = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  Output
>(
  machine: Machine.Any,
  state: Machine.Snapshot<States>,
  event: Machine.LifecycleEvent<Events>
): Effect.Effect<Output, MachineSchemaDecodeError> =>
  normalizeConfigurationEffect(machine, state).pipe(
    Effect.flatMap((configuration) => completeConfigurationEffect(machine, configuration, event)),
    Effect.flatMap((completed): Effect.Effect<Output> => {
      const root = getRootPath(machine, completed.configuration)
      if (
        !isActiveFinalConfiguration(machine, completed.configuration)
        || !completed.configuration.outputs.has(root)
      ) {
        return Effect.die(
          new Error("Machine attempted to read terminal output from a non-terminal configuration")
        )
      }
      return Effect.succeed(completed.configuration.outputs.get(root) as Output)
    })
  )

export const isFinal = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema>,
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never
>(
  machine: Machine<
    States,
    Events,
    Input,
    UnhandledStates,
    E,
    R,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    Emits,
    OutputStates
  >,
  state: Machine.Snapshot<States>
): state is Machine.SnapshotContainingFinal<States, FinalStates> => isFinalState(machine, state)

export const planInitial: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  ...args: [...Machine.InputArgs<Input>]
) => Effect.Effect<
  & {
    readonly state: Machine.Snapshot<States>
    readonly actions: ReadonlyArray<
      Effect.Effect<void, InitialE | MachineSchemaDecodeError | StartupError, InitialR | R>
    >
    readonly emittedEvents: ReadonlyArray<Machine.EmitOf<Emits>>
  }
  & (
    | {
      readonly done: true
      readonly output: Output
    }
    | {
      readonly done: false
      readonly output: undefined
    }
  ),
  InitialE | E | InfiniteTransitionError | MachineSchemaDecodeError | StartupError,
  ExcludeCompatibleRuntime<InitialR | R, Machine.EventOf<Events>, Machine.EmitOf<Emits>>
> = Effect.fnUntraced(function*<
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  ...args: [...Machine.InputArgs<Input>]
) {
  return yield* catchStartup(Effect.gen(function*() {
    const deferredActions = yield* makeDeferredActions
    const deferredRaisedEvents = yield* makeDeferredRaisedEvents
    const inputArgs = machine.input === undefined
      ? args
      : args.length === 0
      ? (yield* decodeInput(machine, machine.input, undefined), args)
      : [yield* decodeInput(machine, machine.input, args[0])] as [...Machine.InputArgs<Input>]
    const result = machine.initial(...inputArgs)
    const state = Effect.isEffect(result)
      ? yield* (provideDeferredServices(
        result as unknown as Effect.Effect<Machine.InitialSnapshot<States>, InitialE, InitialR>,
        machine,
        deferredActions,
        deferredRaisedEvents
      ) as unknown as Effect.Effect<
        Machine.InitialSnapshot<States>,
        InitialE | MachineSchemaDecodeError,
        ExcludeCompatibleRuntime<InitialR, Machine.EventOf<Events>, Machine.EmitOf<Emits>>
      >)
      : result
    const emptyConfiguration: ActiveConfiguration = {
      active: new Set(),
      values: new Map(),
      outputs: new Map(),
      history: new Map()
    }
    const initialChoice = choiceFromTarget(state)
    const choiceResolution = initialChoice === undefined
      ? undefined
      : yield* (resolveChoiceTarget(
        machine,
        emptyConfiguration,
        state,
        InitialEvent
      ) as Effect.Effect<
        any,
        E | InfiniteTransitionError | MachineSchemaDecodeError,
        ExcludeCompatibleRuntime<R, Machine.EventOf<Events>, Machine.EmitOf<Emits>>
      >)
    const initialHistoryActions: Array<DeferredAction> = []
    const initialHistoryRaisedEvents: Array<unknown> = []
    const initialHistoryEmittedEvents: Array<unknown> = []
    const initialHistoryChoiceTransitions: Array<ResolvedChoiceTransition> = []
    const resolvedInitialTargets: Array<unknown> = []
    for (
      const target of choiceResolution === undefined
        ? []
        : [choiceResolution.target, ...choiceResolution.additionalTargets]
    ) {
      if (!isHistoryTarget(target)) {
        resolvedInitialTargets.push(target)
        continue
      }
      const history = yield* resolveHistoryTarget(machine, emptyConfiguration, target, InitialEvent)
      resolvedInitialTargets.push(history.target)
      initialHistoryActions.push(...history.actions)
      initialHistoryRaisedEvents.push(...history.raisedEvents)
      initialHistoryEmittedEvents.push(...history.emittedEvents)
      initialHistoryChoiceTransitions.push(...history.transitions)
    }
    let resolvedConfiguration = choiceResolution === undefined
      ? yield* normalizeConfigurationEffect<States>(machine, state as Machine.Snapshot<States>)
      : yield* normalizeTargetConfigurationEffect<States>(
        machine,
        emptyConfiguration,
        resolvedInitialTargets[0] as
          | Machine.Snapshot<States>
          | Machine.Target<States, Machine.StateIdentifier<States>>
      )
    for (const additionalTarget of resolvedInitialTargets.slice(1)) {
      resolvedConfiguration = yield* normalizeTargetConfigurationEffect<States>(
        machine,
        resolvedConfiguration,
        additionalTarget as Machine.Snapshot<States> | Machine.Target<States, Machine.StateIdentifier<States>>
      )
    }
    const configuration: ActiveConfiguration = resolvedConfiguration
    validateInitialConfiguration(machine, configuration)
    const startingState = snapshotFromConfiguration<States>(machine, configuration)
    const initialEntryPaths = getInitialEntryPaths(machine, configuration)
    const actions = [
      ...yield* deferredActions.read,
      ...(choiceResolution?.actions ?? []),
      ...initialHistoryActions
    ]
    const raisedEvents = [
      ...yield* deferredRaisedEvents.read,
      ...(choiceResolution?.raisedEvents ?? []),
      ...initialHistoryRaisedEvents
    ]
    const emittedEvents = [
      ...yield* deferredRaisedEvents.readEmitted,
      ...(choiceResolution?.emittedEvents ?? []),
      ...initialHistoryEmittedEvents
    ]
    const settled = yield* (Effect.gen(function*() {
      const entry = yield* collectStateActions<States, Events, Emits, E, R>(
        machine,
        configuration,
        initialEntryPaths,
        InitialEvent,
        "entry"
      )
      return yield* (settle(
        machine,
        configuration,
        InitialEvent,
        [...entry.actions] as Array<Effect.Effect<void, E, R>>,
        [...raisedEvents, ...entry.raisedEvents] as Array<Machine.EventOf<Events>>,
        [...emittedEvents, ...entry.emittedEvents],
        choiceResolution === undefined ? [] : [{
          next: configuration,
          event: InitialEvent,
          transitions: [...choiceResolution.transitions, ...initialHistoryChoiceTransitions],
          actions: [...choiceResolution.actions, ...initialHistoryActions] as ReadonlyArray<Effect.Effect<void, E, R>>,
          raisedEvents: [
            ...choiceResolution.raisedEvents,
            ...initialHistoryRaisedEvents
          ] as ReadonlyArray<Machine.EventOf<Events>>,
          emittedEvents: [...choiceResolution.emittedEvents, ...initialHistoryEmittedEvents],
          exitPaths: [],
          entryPaths: [],
          changed: false
        }]
      ) as Effect.Effect<MacrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R, Output>>)
    }) as Effect.Effect<
      MacrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R, Output>,
      E | InfiniteTransitionError | MachineSchemaDecodeError,
      ExcludeCompatibleRuntime<R, Machine.EventOf<Events>, Machine.EmitOf<Emits>>
    >)

    const planned = {
      startingState,
      initialEntryPaths,
      state: snapshotFromConfiguration<States>(machine, settled.next),
      actions: [
        ...actions,
        ...settled.actions
      ] as ReadonlyArray<Effect.Effect<void, InitialE | MachineSchemaDecodeError | StartupError, InitialR | R>>,
      emittedEvents: settled.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>,
      microsteps: settled.microsteps.map((step) => ({
        next: snapshotFromConfiguration<States>(machine, step.next),
        event: step.event,
        transitions: step.transitions,
        actions: step.actions,
        raisedEvents: step.raisedEvents,
        emittedEvents: step.emittedEvents,
        exitPaths: step.exitPaths,
        entryPaths: step.entryPaths,
        changed: step.changed
      }))
    }
    return settled.done
      ? { ...planned, done: true as const, output: settled.output }
      : { ...planned, done: false as const, output: undefined }
  }))
})

export const enabled = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema>,
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never
>(
  machine: Machine<
    States,
    Events,
    Input,
    UnhandledStates,
    E,
    R,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    Emits,
    OutputStates
  >,
  state: Machine.Snapshot<States>
): ReadonlyArray<Machine.TagOf<Events[number]>> => {
  if (isFinalState(machine, state)) {
    return []
  }
  const configuration = normalizeConfiguration(machine, state)
  const tags: Array<Machine.TagOf<Events[number]>> = []
  const seen = new Set<PropertyKey>()
  for (const path of getCandidatePaths(machine, configuration)) {
    for (const tag of Reflect.ownKeys(machine.handlers[path]?.on ?? {})) {
      if (!seen.has(tag)) {
        seen.add(tag)
        tags.push(tag as Machine.TagOf<Events[number]>)
      }
    }
  }
  return tags
}

const microstep: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  Context = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  state: ActiveConfiguration,
  event: Machine.LifecycleEvent<Events>,
  selections: ReadonlyArray<SelectedTransition<States, E, R, Context>>
) => Effect.Effect<
  MicrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R>,
  E | MachineSchemaDecodeError,
  R
> = Effect.fnUntraced(function*<
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  Context = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  state: ActiveConfiguration,
  event: Machine.LifecycleEvent<Events>,
  selections: ReadonlyArray<SelectedTransition<States, E, R, Context>>
) {
  if (selections.length === 0) {
    return {
      next: state,
      event,
      transitions: [],
      actions: [],
      raisedEvents: [],
      emittedEvents: [],
      exitPaths: [],
      entryPaths: [],
      changed: false
    }
  }

  const activeSelections = removePreemptedAncestorSelections(selections)
  const evaluatedTransitions: Array<EvaluatedTransition<States, Machine.EventOf<Events>, E, R, Context>> = []
  for (const selection of activeSelections) {
    evaluatedTransitions.push(
      yield* collectEvaluatedTransition<States, Machine.EventOf<Events>, E, R, Context>(
        machine,
        state,
        selection
      )
    )
  }

  const transitions = removeConflictingTransitions(machine, evaluatedTransitions)
  const sortedTransitions = sortEvaluatedTransitions(machine, transitions)
  const retainedTransitions = sortedTransitions.flatMap((transition) => [
    {
      source: transition.selection.sourcePath,
      trigger: transition.selection.trigger,
      reenter: transition.selection.transition.reenter,
      target: transition.unresolvedTarget === undefined ? undefined : getTargetNodePath(transition.unresolvedTarget),
      resolvedTarget: transition.target === undefined ? undefined : getTargetNodePath(transition.target)
    },
    ...transition.choiceTransitions
  ])
  let stateAfterTransition = state
  // Value-only targets are evaluated against the original configuration. If
  // one is applied after a control-changing transition, it can resurrect a
  // branch that the changing transition exited. Apply value-only updates
  // first so later control targets remain authoritative while still
  // preserving updates made in unaffected parallel regions.
  const targetApplicationOrder = [
    ...sortedTransitions.filter((transition) => !transition.changed),
    ...sortedTransitions.filter((transition) => transition.changed)
  ]
  for (const transition of targetApplicationOrder) {
    if (transition.target !== undefined) {
      stateAfterTransition = yield* normalizeTargetConfigurationEffect<States>(
        machine,
        stateAfterTransition,
        transition.target
      )
    }
  }

  const changed = transitions.some((transition) => transition.changed)
  const transitionActions = sortedTransitions
    .flatMap((transition) => transition.actions)
  const transitionRaisedEvents = sortedTransitions
    .flatMap((transition) => transition.raisedEvents)
  const transitionEmittedEvents = sortedTransitions
    .flatMap((transition) => transition.emittedEvents)

  if (!changed) {
    return {
      next: stateAfterTransition,
      event,
      transitions: retainedTransitions,
      actions: transitionActions,
      raisedEvents: transitionRaisedEvents,
      emittedEvents: transitionEmittedEvents,
      exitPaths: [],
      entryPaths: [],
      changed: false
    }
  }

  const exitPaths = sortExitPaths(machine, sortedTransitions.flatMap((transition) => transition.exitPaths))
  const entryPaths = sortEntryPaths(machine, sortedTransitions.flatMap((transition) => transition.entryPaths))
  stateAfterTransition = captureHistory(machine, state, stateAfterTransition, exitPaths)
  const exit = yield* collectStateActions<States, Events, Emits, E, R>(
    machine,
    state,
    exitPaths,
    event,
    "exit"
  )
  const entry = yield* collectStateActions<States, Events, Emits, E, R>(
    machine,
    stateAfterTransition,
    entryPaths,
    event,
    "entry"
  )

  return {
    next: stateAfterTransition,
    event,
    transitions: retainedTransitions,
    actions: [...exit.actions, ...transitionActions, ...entry.actions] as ReadonlyArray<
      Effect.Effect<void, E, R>
    >,
    raisedEvents: [...exit.raisedEvents, ...transitionRaisedEvents, ...entry.raisedEvents] as ReadonlyArray<
      Machine.EventOf<Events>
    >,
    emittedEvents: [...exit.emittedEvents, ...transitionEmittedEvents, ...entry.emittedEvents],
    exitPaths,
    entryPaths,
    changed: true
  }
})

const settle: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  state: ActiveConfiguration,
  event: Machine.LifecycleEvent<Events>,
  actions: Array<Effect.Effect<void, E, R>>,
  raisedEvents: Array<Machine.EventOf<Events>>,
  emittedEvents: Array<unknown>,
  microsteps: Array<MicrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R>>
) => Effect.Effect<
  MacrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R, Output>,
  E | InfiniteTransitionError | MachineSchemaDecodeError,
  R
> = Effect.fnUntraced(function*<
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  state: ActiveConfiguration,
  event: Machine.LifecycleEvent<Events>,
  actions: Array<Effect.Effect<void, E, R>>,
  raisedEvents: Array<Machine.EventOf<Events>>,
  emittedEvents: Array<unknown>,
  microsteps: Array<MicrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R>>
) {
  let currentState = state
  let currentEvent = event
  let shouldRunAlways = true
  let iterations = 0
  let raisedEventIndex = 0
  let completedTerminal = false
  let finalOutput: Output | undefined = undefined
  const pendingCompletions: Array<{ readonly path: string; readonly output: unknown }> = []

  while (true) {
    iterations += 1
    if (iterations > MaxMacrostepIterations) {
      return yield* new InfiniteTransitionError({
        machineId: machine.id,
        state: String(getLeafPath(machine, currentState)),
        maxIterations: MaxMacrostepIterations
      })
    }

    const completed = yield* completeConfigurationEffect(machine, currentState, currentEvent)
    currentState = completed.configuration
    pendingCompletions.push(
      ...completed.completions.filter((completion) => machine.handlers[completion.path]?.onDone !== undefined)
    )
    while (pendingCompletions.length > 0 && !currentState.active.has(pendingCompletions[0].path)) {
      pendingCompletions.shift()
    }
    const done = selectDoneTransitions<States, Events, Emits, E, R>(
      machine,
      currentState,
      currentEvent,
      pendingCompletions.length === 0 ? [] : [pendingCompletions.shift()!]
    )
    if (done.length > 0) {
      const doneStep: MicrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R> = yield* microstep(
        machine,
        currentState,
        currentEvent,
        done
      )
      actions.push(...doneStep.actions)
      raisedEvents.push(...doneStep.raisedEvents)
      emittedEvents.push(...doneStep.emittedEvents)
      microsteps.push(doneStep)
      currentState = doneStep.next
      shouldRunAlways = doneStep.changed
      continue
    }
    if (isActiveFinalConfiguration(machine, currentState)) {
      const root = getRootPath(machine, currentState)
      if (!currentState.outputs.has(root)) {
        return yield* Effect.die(
          new Error("Machine reached a terminal configuration without a completed root output")
        )
      }
      completedTerminal = true
      finalOutput = currentState.outputs.get(root) as Output
      break
    }

    const always = shouldRunAlways
      ? selectAlwaysTransitions<States, Events, Emits, E, R>(machine, currentState, currentEvent)
      : []
    if (always.length > 0) {
      const alwaysStep: MicrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R> = yield* microstep(
        machine,
        currentState,
        currentEvent,
        always
      )
      actions.push(...alwaysStep.actions)
      raisedEvents.push(...alwaysStep.raisedEvents)
      emittedEvents.push(...alwaysStep.emittedEvents)
      microsteps.push(alwaysStep)
      currentState = alwaysStep.next
      shouldRunAlways = alwaysStep.changed
      continue
    }

    const raisedEventValue = raisedEvents[raisedEventIndex]
    if (raisedEventValue === undefined) {
      break
    }
    raisedEventIndex += 1

    // Planning runtime validates and normalizes every event before it enters this
    // internal queue, so decoding it again here only repeats schema work.
    const raisedEvent = raisedEventValue
    currentEvent = raisedEvent
    const raisedSelections = selectEventTransitions<States, Events, Emits, E, R>(
      machine,
      currentState,
      raisedEvent as Machine.EventByTag<Events, Machine.TagOf<Events[number]>>
    )
    if (raisedSelections.length === 0) {
      shouldRunAlways = true
      continue
    }
    const raisedStep = yield* microstep(
      machine,
      currentState,
      raisedEvent,
      raisedSelections
    )
    actions.push(...raisedStep.actions)
    raisedEvents.push(...raisedStep.raisedEvents)
    emittedEvents.push(...raisedStep.emittedEvents)
    microsteps.push(raisedStep)
    currentState = raisedStep.next
    shouldRunAlways = true
  }

  const result = {
    next: currentState,
    actions,
    emittedEvents,
    microsteps
  }
  return completedTerminal
    ? { ...result, done: true, output: finalOutput as Output }
    : { ...result, done: false, output: undefined }
})

const macrostepConfiguration: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  configuration: ActiveConfiguration,
  event: Machine.EventOf<Events>
) => Effect.Effect<
  MacrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R, Output>,
  E | InfiniteTransitionError | MachineSchemaDecodeError,
  R
> = Effect.fnUntraced(function*<
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  configuration: ActiveConfiguration,
  event: Machine.EventOf<Events>
) {
  const decodedEvent = yield* decodeEvent<Events>(machine, event)
  if (isActiveFinalConfiguration(machine, configuration)) {
    const completed = yield* completeConfigurationEffect(machine, configuration, decodedEvent)
    const root = getRootPath(machine, completed.configuration)
    if (!completed.configuration.outputs.has(root)) {
      return yield* Effect.die(
        new Error("Machine reached a terminal configuration without a completed root output")
      )
    }
    return {
      next: completed.configuration,
      actions: [],
      emittedEvents: [],
      microsteps: [],
      done: true,
      output: completed.configuration.outputs.get(root) as Output
    }
  }

  const selections = selectEventTransitions<States, Events, Emits, E, R>(
    machine,
    configuration,
    decodedEvent as Machine.EventByTag<Events, Machine.TagOf<Events[number]>>
  )
  if (selections.length === 0) {
    return {
      next: configuration,
      actions: [],
      emittedEvents: [],
      microsteps: [],
      done: false,
      output: undefined
    }
  }
  const step = yield* microstep(
    machine,
    configuration,
    decodedEvent,
    selections
  )
  const actions = [...step.actions]
  const raisedEvents = [...step.raisedEvents]
  const emittedEvents = [...step.emittedEvents]
  const microsteps = [step]
  return yield* settle(machine, step.next, decodedEvent, actions, raisedEvents, emittedEvents, microsteps)
})

const snapshotMacrostep = <
  const States extends Machine.StateSchemas,
  Event,
  E,
  R,
  Output
>(
  machine: Machine.Any,
  settled: MacrostepPlan<ActiveConfiguration, Event, E, R, Output>
): MacrostepPlan<Machine.Snapshot<States>, Event, E, R, Output> => {
  const planned = {
    next: snapshotFromConfiguration<States>(machine, settled.next),
    actions: settled.actions,
    emittedEvents: settled.emittedEvents,
    microsteps: settled.microsteps.map((step) => ({
      next: snapshotFromConfiguration<States>(machine, step.next),
      event: step.event,
      transitions: step.transitions,
      actions: step.actions,
      raisedEvents: step.raisedEvents,
      emittedEvents: step.emittedEvents,
      exitPaths: step.exitPaths,
      entryPaths: step.entryPaths,
      changed: step.changed
    }))
  }
  return settled.done
    ? { ...planned, done: true, output: settled.output }
    : { ...planned, done: false, output: undefined }
}

const macrostep: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  state: Machine.Snapshot<States>,
  event: Machine.EventOf<Events>
) => Effect.Effect<
  MacrostepPlan<Machine.Snapshot<States>, Machine.EventOf<Events>, E, R, Output>,
  E | InfiniteTransitionError | MachineSchemaDecodeError,
  R
> = Effect.fnUntraced(function*<
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  state: Machine.Snapshot<States>,
  event: Machine.EventOf<Events>
) {
  const configuration = yield* normalizeConfigurationEffect<States>(machine, state)
  const settled = yield* macrostepConfiguration(machine, configuration, event)
  return snapshotMacrostep<States, Machine.EventOf<Events>, E, R, Output>(machine, settled)
})

export const plan = macrostep

export const planConfiguration = macrostepConfiguration

const actionUnsafe = Effect.fnUntraced(function*<E, R>(
  effect: Effect.Effect<void, E, R>
) {
  const actions = yield* DeferredActions
  yield* actions.add(effect)
})

/**
 * Defers an effectful action until the current machine step is planned.
 *
 * @category combinators
 * @since 4.0.0
 */
export const action = <E, R>(
  effect: Effect.Effect<void, E, R>
): Effect.Effect<void, never, ActionRequirement<E, R>> =>
  actionUnsafe(effect) as unknown as Effect.Effect<void, never, ActionRequirement<E, R>>

/**
 * Returns the typed runtime capability for the current machine.
 *
 * @category combinators
 * @since 4.0.0
 */
export const runtime = <const Protocol extends Runtime.Protocol = {}>(): Effect.Effect<
  Runtime<Runtime.Events<Protocol>, Runtime.Emits<Protocol>>,
  never,
  Runtime.Requirement<Runtime.Events<Protocol>, Runtime.Emits<Protocol>>
> =>
  RuntimeContext as unknown as Effect.Effect<
    Runtime<Runtime.Events<Protocol>, Runtime.Emits<Protocol>>,
    never,
    Runtime.Requirement<Runtime.Events<Protocol>, Runtime.Emits<Protocol>>
  >
