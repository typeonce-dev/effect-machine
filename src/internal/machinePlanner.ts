/**
 * Internal machine planning helpers.
 *
 * @since 4.0.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type { Command, Enqueue, InitialEvent as MachineInitialEvent, Machine, Runtime } from "../Machine.js"
import { InfiniteTransitionError, MachineSchemaDecodeError, StartupError } from "./machineErrors.js"
import {
  type ActiveConfiguration,
  captureHistory,
  compareDocumentOrder,
  completeConfigurationEffect,
  completeConfigurationSync,
  configurationFromHistoryRecord,
  decodeEmit,
  decodeEmitSync,
  decodeEvent,
  decodeEventSync,
  decodeInput,
  decodeInputSync,
  decodeStateValue,
  decodeStateValueSync,
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
  normalizeConfigurationSync,
  normalizeTargetConfigurationEffect,
  normalizeTargetConfigurationSync,
  pathDepth,
  snapshotFromConfiguration,
  snapshotFromConfigurationAtPath,
  TargetSnapshotTypeId,
  validateInitialConfiguration
} from "./machineModel.js"
import type { ProcessScope } from "./machineRuntime.js"

export type RuntimeCommand = Command

interface Collected<Event> {
  readonly enqueue: Enqueue<Event, unknown>
  readonly commands: Array<RuntimeCommand>
  readonly raisedEvents: Array<Event>
  readonly emittedEvents: Array<unknown>
}

const targetBuilderCache = new WeakMap<object, Map<string, unknown>>()

const getTargetBuilder = (machine: Machine.Any, path: string): any => {
  let byPath = targetBuilderCache.get(machine)
  if (byPath === undefined) {
    byPath = new Map()
    targetBuilderCache.set(machine, byPath)
  }
  if (byPath.has(path)) {
    return byPath.get(path)
  }
  const builder = machine.makeTargetBuilder(path as any)
  byPath.set(path, builder)
  return builder
}

const makeCollector = <Event>(machine: Machine.Any): Collected<Event> => {
  const commands: Array<RuntimeCommand> = []
  const raisedEvents: Array<Event> = []
  const emittedEvents: Array<unknown> = []
  return {
    commands,
    raisedEvents,
    emittedEvents,
    enqueue: {
      raise: (event) => {
        raisedEvents.push(decodeEventSync(machine, event) as Event)
      },
      emit: (event) => {
        emittedEvents.push(decodeEmitSync(machine, event))
      },
      sendTo: (child: unknown, event: unknown) => {
        commands.push({ _tag: "SendTo", child: child as any, event })
      },
      stop: (child: unknown) => {
        commands.push({ _tag: "Stop", child: child as any })
      }
    }
  }
}

export const makeLiveRuntime = <Events, Emits>(
  machine: Machine.Any,
  scope: ProcessScope<Events>
): Runtime<Events, Emits> => ({
  raise: (event) =>
    decodeEvent(machine, event).pipe(
      Effect.flatMap((event) => scope.self.send(event as Events))
    ),
  sendParent: (event) =>
    decodeEmit(machine, event).pipe(
      Effect.flatMap((event) => scope.sendParent(event))
    )
})

export const runCommands = <Event>(
  commands: Iterable<RuntimeCommand>,
  scope: ProcessScope<Event>
) =>
  Effect.forEach(commands, (command) =>
    command._tag === "SendTo"
      ? scope.sendTo(command.child as never, command.event)
      : scope.stopChild(command.child as never), { discard: true })

export const runEmittedEvents = <Events, Emits>(
  events: Iterable<Emits>,
  runtime: Runtime<Events, Emits>
) =>
  Effect.all(
    Array.from(events, (event) => runtime.sendParent(event)),
    { discard: true }
  )

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
  readonly commands: ReadonlyArray<RuntimeCommand>
  readonly raisedEvents: ReadonlyArray<Event>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly changed: boolean
}

export type MacrostepPlan<State, Event, E, R, Output> =
  & {
    readonly next: State
    readonly commands: ReadonlyArray<RuntimeCommand>
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
  context: Context,
  enqueue: Enqueue<any, any>
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

const collectStateAction = <Context, Event, E, R>(
  machine: Machine.Any,
  handler: ((context: Context, enqueue: Enqueue<any, any>) => Machine.StateActionResult<E, R>) | undefined,
  context: Context
) => {
  const collected = makeCollector<Event>(machine)
  if (handler === undefined) {
    return {
      commands: collected.commands,
      raisedEvents: collected.raisedEvents,
      emittedEvents: collected.emittedEvents
    }
  }
  handler(context, collected.enqueue)
  return {
    commands: collected.commands,
    raisedEvents: collected.raisedEvents,
    emittedEvents: collected.emittedEvents
  }
}

const collectTransition = <
  const States extends Machine.StateSchemas,
  Event,
  E,
  R,
  Context
>(
  machine: Machine.Any,
  transition: TransitionHandler<States, E, R, Context>,
  context: Context
) => {
  const collected = makeCollector<Event>(machine)
  const state = transition(context, collected.enqueue)
  return {
    state,
    commands: collected.commands,
    raisedEvents: collected.raisedEvents,
    emittedEvents: collected.emittedEvents
  }
}

const collectStateInitializer = (
  machine: Machine.Any,
  handler: (context: any, enqueue: Enqueue<any, any>) => unknown,
  context: any
) => {
  const collected = makeCollector<unknown>(machine)
  return {
    value: handler(context, collected.enqueue),
    commands: collected.commands,
    raisedEvents: collected.raisedEvents,
    emittedEvents: collected.emittedEvents
  }
}

/** Completes the intentionally partial configuration held by shallow history.
 * Only a compound node with no remembered child invokes an initializer; deep
 * history never reaches this path. */
const completeHistoryConfiguration = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  event: unknown
) => {
  const active = new Set(configuration.active)
  const values = new Map(configuration.values)
  const commands: Array<RuntimeCommand> = []
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
        const initialized = collectStateInitializer(machine, initializer, {
          state: getActiveValue(current, path),
          parent: getParentValue(machine, current, path),
          parents: getParentValues(machine, current, path),
          event
        })
        const child = getNode(machine, node.initial)
        active.add(child.path)
        values.set(child.path, decodeStateValueSync(machine, child, initialized.value))
        commands.push(...initialized.commands)
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
          const initialized = collectStateInitializer(machine, initializer, {
            state: getActiveValue(current, path),
            parent: getParentValue(machine, current, path),
            parents: getParentValues(machine, current, path),
            event
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
              decodeStateValueSync(machine, child, (initialized.value as Record<string, unknown>)[child.key])
            )
          }
          commands.push(...initialized.commands)
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
    commands,
    raisedEvents,
    emittedEvents
  }
}

const resolveHistoryTarget = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  target: { readonly path: string; readonly parent: string },
  event: unknown
) => {
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
    const completed = completeHistoryConfiguration(machine, restored, event)
    const snapshot = snapshotFromConfigurationAtPath(machine, completed.configuration, target.parent)
    const values = Object.fromEntries(completed.configuration.values)
    return {
      target: makeTarget(target.parent as any, snapshot.value as any, {
        snapshot: snapshot as any,
        values: values as any
      }),
      commands: completed.commands,
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
  const collected = collectTransition(machine, fallback, {
    event,
    target: getTargetBuilder(machine, target.parent).full,
    parent: target.parent
  })
  if (collected.state === undefined || isHistoryTarget(collected.state) || !isSnapshot(collected.state)) {
    throw new Error(`Machine history default for "${target.path}" must return a complete snapshot containing its owner`)
  }
  const fallbackChoice = choiceFromTarget(collected.state)
  const choiceResolution = fallbackChoice === undefined
    ? undefined
    : resolveChoiceTarget(
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
    ? normalizeConfigurationSync(machine, collected.state as any)
    : normalizeTargetConfigurationSync(machine, {
      active: new Set(),
      values: new Map(),
      outputs: new Map(),
      history: configuration.history
    }, choiceResolution.target as any)
  for (const additionalTarget of choiceResolution?.additionalTargets ?? []) {
    fallbackConfiguration = normalizeTargetConfigurationSync(
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
    commands: [...collected.commands, ...(choiceResolution?.commands ?? [])],
    raisedEvents: [...collected.raisedEvents, ...(choiceResolution?.raisedEvents ?? [])],
    emittedEvents: [...collected.emittedEvents, ...(choiceResolution?.emittedEvents ?? [])],
    transitions: choiceResolution?.transitions ?? []
  }
}

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
  readonly commands: ReadonlyArray<RuntimeCommand>
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
  event
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
  target: getTargetBuilder(machine, path)
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
  target: getTargetBuilder(machine, path)
})

const collectStateActions = <
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
) => {
  const commands: Array<RuntimeCommand> = []
  const raisedEvents: Array<Machine.EventOf<Events>> = []
  const emittedEvents: Array<Machine.EmitOf<Emits>> = []
  for (const path of paths) {
    const collected = collectStateAction<
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
    commands.push(...collected.commands)
    raisedEvents.push(...collected.raisedEvents)
    emittedEvents.push(...collected.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>)
  }
  return { commands, emittedEvents, raisedEvents }
}

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
              target: getTargetBuilder(machine, path)
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

const resolveChoiceTarget = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  initialTarget: unknown,
  event: unknown
) => {
  const pending: Array<unknown> = [initialTarget]
  const resolvedTargets: Array<unknown> = []
  const commands: Array<RuntimeCommand> = []
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
        throw new InfiniteTransitionError({
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
      const collected = collectTransition(machine, choice.transition, {
        parent: getParentValue(machine, provisional, node.path),
        parents: getParentValues(machine, provisional, node.path),
        event,
        target: getTargetBuilder(machine, node.path)
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
      commands.push(...collected.commands)
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
    commands,
    raisedEvents,
    emittedEvents,
    transitions
  }
}

const collectEvaluatedTransition = <
  const States extends Machine.StateSchemas,
  Event,
  E,
  R,
  Context
>(
  machine: Machine.Any,
  state: ActiveConfiguration,
  selection: SelectedTransition<States, E, R, Context>
) => {
  const stateIdentifier = selection.leafPath
  const transitionResult = collectTransition<States, Event, E, R, Context>(
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
    : resolveChoiceTarget(
      machine,
      state,
      unresolvedTarget,
      (selection.context as any).event
    )
  const choiceResolvedTarget = choiceResolution?.target ?? unresolvedTarget
  let historyResolution: {
    readonly target: unknown
    readonly commands: ReadonlyArray<RuntimeCommand>
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
    historyResolution = resolveHistoryTarget(
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
  const additionalHistoryActions: Array<RuntimeCommand> = []
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
    const resolved = resolveHistoryTarget(
      machine,
      state,
      additionalTarget,
      (selection.context as any).event
    )
    additionalChoiceTargets.push(resolved.target as any)
    additionalHistoryActions.push(...resolved.commands)
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
    : normalizeTargetConfigurationSync<States>(machine, state, target)
  for (const additionalTarget of additionalChoiceTargets) {
    stateAfterTransition = normalizeTargetConfigurationSync<States>(
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
      commands: [
        ...transitionResult.commands,
        ...(choiceResolution?.commands ?? []),
        ...(historyResolution?.commands ?? []),
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
    commands: [
      ...transitionResult.commands,
      ...(choiceResolution?.commands ?? []),
      ...(historyResolution?.commands ?? []),
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
}

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

export const planInitialSync = <
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
) => {
  const inputArgs = machine.input === undefined
    ? args
    : args.length === 0
    ? (decodeInputSync(machine, machine.input, undefined), args)
    : [decodeInputSync(machine, machine.input, args[0])] as [...Machine.InputArgs<Input>]
  const state = machine.initial(...inputArgs)
  const emptyConfiguration: ActiveConfiguration = {
    active: new Set(),
    values: new Map(),
    outputs: new Map(),
    history: new Map()
  }
  const initialChoice = choiceFromTarget(state)
  const choiceResolution = initialChoice === undefined
    ? undefined
    : resolveChoiceTarget(
      machine,
      emptyConfiguration,
      state,
      InitialEvent
    )
  const initialHistoryActions: Array<RuntimeCommand> = []
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
    const history = resolveHistoryTarget(machine, emptyConfiguration, target, InitialEvent)
    resolvedInitialTargets.push(history.target)
    initialHistoryActions.push(...history.commands)
    initialHistoryRaisedEvents.push(...history.raisedEvents)
    initialHistoryEmittedEvents.push(...history.emittedEvents)
    initialHistoryChoiceTransitions.push(...history.transitions)
  }
  let resolvedConfiguration = choiceResolution === undefined
    ? normalizeConfigurationSync<States>(machine, state as Machine.Snapshot<States>)
    : normalizeTargetConfigurationSync<States>(
      machine,
      emptyConfiguration,
      resolvedInitialTargets[0] as
        | Machine.Snapshot<States>
        | Machine.Target<States, Machine.StateIdentifier<States>>
    )
  for (const additionalTarget of resolvedInitialTargets.slice(1)) {
    resolvedConfiguration = normalizeTargetConfigurationSync<States>(
      machine,
      resolvedConfiguration,
      additionalTarget as Machine.Snapshot<States> | Machine.Target<States, Machine.StateIdentifier<States>>
    )
  }
  const configuration: ActiveConfiguration = resolvedConfiguration
  validateInitialConfiguration(machine, configuration)
  const startingState = snapshotFromConfiguration<States>(machine, configuration)
  const initialEntryPaths = getInitialEntryPaths(machine, configuration)
  const commands = [
    ...(choiceResolution?.commands ?? []),
    ...initialHistoryActions
  ]
  const raisedEvents = [
    ...(choiceResolution?.raisedEvents ?? []),
    ...initialHistoryRaisedEvents
  ]
  const emittedEvents = [
    ...(choiceResolution?.emittedEvents ?? []),
    ...initialHistoryEmittedEvents
  ]
  const entry = collectStateActions<States, Events, Emits, E, R>(
    machine,
    configuration,
    initialEntryPaths,
    InitialEvent,
    "entry"
  )
  const settled = settle(
    machine,
    configuration,
    InitialEvent,
    [...entry.commands],
    [...raisedEvents, ...entry.raisedEvents] as Array<Machine.EventOf<Events>>,
    [...emittedEvents, ...entry.emittedEvents],
    choiceResolution === undefined ? [] : [{
      next: configuration,
      event: InitialEvent,
      transitions: [...choiceResolution.transitions, ...initialHistoryChoiceTransitions],
      commands: [...choiceResolution.commands, ...initialHistoryActions],
      raisedEvents: [
        ...choiceResolution.raisedEvents,
        ...initialHistoryRaisedEvents
      ] as ReadonlyArray<Machine.EventOf<Events>>,
      emittedEvents: [...choiceResolution.emittedEvents, ...initialHistoryEmittedEvents],
      exitPaths: [],
      entryPaths: [],
      changed: false
    }]
  )

  const planned = {
    startingState,
    initialEntryPaths,
    state: snapshotFromConfiguration<States>(machine, settled.next),
    commands: [
      ...commands,
      ...settled.commands
    ],
    emittedEvents: settled.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>,
    microsteps: settled.microsteps.map((step) => ({
      next: snapshotFromConfiguration<States>(machine, step.next),
      event: step.event,
      transitions: step.transitions,
      commands: step.commands,
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
}

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

const microstep = <
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
) => {
  if (selections.length === 0) {
    return {
      next: state,
      event,
      transitions: [],
      commands: [],
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
      collectEvaluatedTransition<States, Machine.EventOf<Events>, E, R, Context>(
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
      stateAfterTransition = normalizeTargetConfigurationSync<States>(
        machine,
        stateAfterTransition,
        transition.target
      )
    }
  }

  const changed = transitions.some((transition) => transition.changed)
  const transitionActions = sortedTransitions
    .flatMap((transition) => transition.commands)
  const transitionRaisedEvents = sortedTransitions
    .flatMap((transition) => transition.raisedEvents)
  const transitionEmittedEvents = sortedTransitions
    .flatMap((transition) => transition.emittedEvents)

  if (!changed) {
    return {
      next: stateAfterTransition,
      event,
      transitions: retainedTransitions,
      commands: transitionActions,
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
  const exit = collectStateActions<States, Events, Emits, E, R>(
    machine,
    state,
    exitPaths,
    event,
    "exit"
  )
  const entry = collectStateActions<States, Events, Emits, E, R>(
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
    commands: [...exit.commands, ...transitionActions, ...entry.commands],
    raisedEvents: [...exit.raisedEvents, ...transitionRaisedEvents, ...entry.raisedEvents] as ReadonlyArray<
      Machine.EventOf<Events>
    >,
    emittedEvents: [...exit.emittedEvents, ...transitionEmittedEvents, ...entry.emittedEvents],
    exitPaths,
    entryPaths,
    changed: true
  }
}

const settle = <
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
  commands: Array<RuntimeCommand>,
  raisedEvents: Array<Machine.EventOf<Events>>,
  emittedEvents: Array<unknown>,
  microsteps: Array<MicrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R>>
) => {
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
      throw new InfiniteTransitionError({
        machineId: machine.id,
        state: String(getLeafPath(machine, currentState)),
        maxIterations: MaxMacrostepIterations
      })
    }

    const completed = completeConfigurationSync(machine, currentState, currentEvent)
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
      const doneStep: MicrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R> = microstep(
        machine,
        currentState,
        currentEvent,
        done
      )
      commands.push(...doneStep.commands)
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
        throw new Error("Machine reached a terminal configuration without a completed root output")
      }
      completedTerminal = true
      finalOutput = currentState.outputs.get(root) as Output
      break
    }

    const always = shouldRunAlways
      ? selectAlwaysTransitions<States, Events, Emits, E, R>(machine, currentState, currentEvent)
      : []
    if (always.length > 0) {
      const alwaysStep: MicrostepPlan<ActiveConfiguration, Machine.EventOf<Events>, E, R> = microstep(
        machine,
        currentState,
        currentEvent,
        always
      )
      commands.push(...alwaysStep.commands)
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
    const raisedStep = microstep(
      machine,
      currentState,
      raisedEvent,
      raisedSelections
    )
    commands.push(...raisedStep.commands)
    raisedEvents.push(...raisedStep.raisedEvents)
    emittedEvents.push(...raisedStep.emittedEvents)
    microsteps.push(raisedStep)
    currentState = raisedStep.next
    shouldRunAlways = true
  }

  const result = {
    next: currentState,
    commands,
    emittedEvents,
    microsteps
  }
  return completedTerminal
    ? { ...result, done: true as const, output: finalOutput as Output }
    : { ...result, done: false as const, output: undefined }
}

const macrostepConfiguration = <
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
) => {
  const decodedEvent = decodeEventSync<Events>(machine, event)
  if (isActiveFinalConfiguration(machine, configuration)) {
    const completed = completeConfigurationSync(machine, configuration, decodedEvent)
    const root = getRootPath(machine, completed.configuration)
    if (!completed.configuration.outputs.has(root)) {
      throw new Error("Machine reached a terminal configuration without a completed root output")
    }
    return {
      next: completed.configuration,
      commands: [],
      emittedEvents: [],
      microsteps: [],
      done: true as const,
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
      commands: [],
      emittedEvents: [],
      microsteps: [],
      done: false as const,
      output: undefined
    }
  }
  const step = microstep(
    machine,
    configuration,
    decodedEvent,
    selections
  )
  const commands = [...step.commands]
  const raisedEvents = [...step.raisedEvents]
  const emittedEvents = [...step.emittedEvents]
  const microsteps = [step]
  return settle(machine, step.next, decodedEvent, commands, raisedEvents, emittedEvents, microsteps)
}

interface FlatExecutionDescriptor {
  readonly paths: ReadonlySet<string>
}

const compileFlatExecutionDescriptor = (machine: Machine.Any): FlatExecutionDescriptor | undefined => {
  const paths = new Set<string>()
  for (const node of machine.stateNodes.byPath.values() as Iterable<Machine.StateNode>) {
    if (node.parent !== undefined || (node.type !== "atomic" && node.type !== "final")) {
      return undefined
    }
    const config = machine.handlers[node.path] as Machine.AnyStateConfig | undefined
    if (
      config?.entry !== undefined || config?.exit !== undefined || config?.always !== undefined ||
      config?.onDone !== undefined || config?.invoke !== undefined
    ) {
      return undefined
    }
    paths.add(node.path)
  }
  return paths.size === 0 ? undefined : { paths }
}

const planFlatConfiguration = (
  machine: Machine.Any,
  descriptor: FlatExecutionDescriptor,
  configuration: ActiveConfiguration,
  input: unknown
): MacrostepPlan<ActiveConfiguration, any, any, any, any> => {
  const decoded = decodeEventSync(machine, input) as { readonly _tag: PropertyKey }
  if (isActiveFinalConfiguration(machine, configuration)) {
    const completed = completeConfigurationSync(machine, configuration, decoded)
    const root = getRootPath(machine, completed.configuration)
    if (!completed.configuration.outputs.has(root)) {
      throw new Error("Machine reached a terminal configuration without a completed root output")
    }
    return {
      next: completed.configuration,
      commands: [],
      emittedEvents: [],
      microsteps: [],
      done: true,
      output: completed.configuration.outputs.get(root)
    }
  }

  let current = configuration
  let event: any = decoded
  const pending: Array<any> = []
  let pendingIndex = 0
  const commands: Array<RuntimeCommand> = []
  const emittedEvents: Array<unknown> = []
  const microsteps: Array<MicrostepPlan<ActiveConfiguration, any, any, any>> = []
  let iterations = 0

  while (true) {
    iterations += 1
    if (iterations > MaxMacrostepIterations) {
      throw new InfiniteTransitionError({
        machineId: machine.id,
        state: String(getLeafPath(machine, current)),
        maxIterations: MaxMacrostepIterations
      })
    }

    const source = getRootPath(machine, current)
    const transition = normalizeTransition(machine.handlers[source]?.on?.[event._tag])
    if (transition !== undefined) {
      const snapshot = snapshotFromConfiguration(machine, current)
      const collected = collectTransition(machine, transition.transition, {
        state: getActiveValue(current, source),
        parent: undefined,
        parents: {},
        event,
        snapshot,
        target: getTargetBuilder(machine, source)
      })
      validateDeclaredTransitionTarget(
        source,
        { type: "event", event: event._tag },
        transition.targets,
        collected.state
      )

      let next = current
      let targetPath: string | undefined
      if (collected.state !== undefined) {
        if (!isTarget(collected.state) && !isSnapshot(collected.state)) {
          throw new Error("Machine expected transition target to be a snapshot or target builder result")
        }
        targetPath = getTargetNodePath(collected.state)
        if (!descriptor.paths.has(targetPath)) {
          throw new Error(`Machine expected flat transition target "${targetPath}" to be a root state`)
        }
        next = normalizeTargetConfigurationSync(machine, current, collected.state as any)
      }
      const changed = transition.reenter || source !== targetPath && targetPath !== undefined
      const exitPaths = changed ? [source] : []
      const entryPaths = changed ? [getRootPath(machine, next)] : []
      const step = {
        next,
        event,
        transitions: [{
          source,
          trigger: { type: "event" as const, event: event._tag },
          reenter: transition.reenter,
          target: targetPath,
          resolvedTarget: targetPath
        }],
        commands: collected.commands,
        raisedEvents: collected.raisedEvents,
        emittedEvents: collected.emittedEvents,
        exitPaths,
        entryPaths,
        changed
      }
      current = next
      commands.push(...collected.commands)
      pending.push(...collected.raisedEvents)
      emittedEvents.push(...collected.emittedEvents)
      microsteps.push(step)

      if (isActiveFinalConfiguration(machine, current)) {
        const completed = completeConfigurationSync(machine, current, event)
        const root = getRootPath(machine, completed.configuration)
        if (!completed.configuration.outputs.has(root)) {
          throw new Error("Machine reached a terminal configuration without a completed root output")
        }
        return {
          next: completed.configuration,
          commands,
          emittedEvents,
          microsteps,
          done: true,
          output: completed.configuration.outputs.get(root)
        }
      }
    }

    if (pendingIndex >= pending.length) {
      return {
        next: current,
        commands,
        emittedEvents,
        microsteps,
        done: false,
        output: undefined
      }
    }
    event = pending[pendingIndex++]
  }
}

export interface CompiledExecutionPlan {
  readonly plan: (
    configuration: ActiveConfiguration,
    event: unknown
  ) => MacrostepPlan<ActiveConfiguration, any, any, any, any>
}

const executionPlanCache = new WeakMap<Machine.Any, CompiledExecutionPlan>()

export const compileExecutionPlan = (machine: Machine.Any): CompiledExecutionPlan => {
  const cached = executionPlanCache.get(machine)
  if (cached !== undefined) {
    return cached
  }
  const flat = compileFlatExecutionDescriptor(machine)
  const compiled: CompiledExecutionPlan = flat === undefined
    ? { plan: (configuration, event) => planConfiguration(machine as any, configuration, event as any) }
    : { plan: (configuration, event) => planFlatConfiguration(machine, flat, configuration, event) }
  executionPlanCache.set(machine, compiled)
  return compiled
}

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
    commands: settled.commands,
    emittedEvents: settled.emittedEvents,
    microsteps: settled.microsteps.map((step) => ({
      next: snapshotFromConfiguration<States>(machine, step.next),
      event: step.event,
      transitions: step.transitions,
      commands: step.commands,
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

const macrostep = <
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
) => {
  const configuration = normalizeConfigurationSync<States>(machine, state)
  const settled = macrostepConfiguration(machine, configuration, event)
  return snapshotMacrostep<States, Machine.EventOf<Events>, E, R, Output>(machine, settled)
}

export const planSync = macrostep

export const planConfiguration = macrostepConfiguration

const planningEffect = <A>(thunk: () => A): Effect.Effect<A, InfiniteTransitionError | MachineSchemaDecodeError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(thunk())
    } catch (error) {
      return error instanceof InfiniteTransitionError || error instanceof MachineSchemaDecodeError
        ? Effect.fail(error)
        : Effect.die(error)
    }
  })

export const plan = (machine: Machine.Any, state: Machine.Snapshot<any>, event: unknown) =>
  planningEffect(() => planSync(machine as any, state, event as any))

export const planInitial = (
  machine: Machine.Any,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<any, InfiniteTransitionError | MachineSchemaDecodeError | StartupError> =>
  Effect.try({
    try: () => (planInitialSync as any)(machine, ...args),
    catch: (error) => {
      return error instanceof InfiniteTransitionError || error instanceof MachineSchemaDecodeError
        ? error
        : new StartupError({ cause: Cause.die(error) })
    }
  })
