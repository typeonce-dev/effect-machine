/**
 * Internal machine planning helpers.
 *
 * @since 4.0.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type { Command, Enqueue, InitialEvent as MachineInitialEvent, Machine, Runtime } from "../../Machine.js"
import { InfiniteTransitionError, MachineSchemaDecodeError, StartupError } from "./errors.js"
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
} from "./model.js"
import type { ProcessScope } from "./runtime.js"

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

interface IndexedExecutionDescriptor {
  readonly flat: boolean
  readonly nodes: ReadonlyArray<Machine.StateNode>
  readonly indexByPath: ReadonlyMap<string, number>
  readonly parentIndices: ReadonlyArray<number>
  readonly childIndices: ReadonlyArray<ReadonlyArray<number>>
  readonly ancestorIndices: ReadonlyArray<ReadonlyArray<number>>
  readonly rootIndices: ReadonlyArray<number>
  readonly leafIndices: ReadonlyArray<number>
  readonly finalIndices: ReadonlyArray<number>
  readonly dispatchByLeaf: ReadonlyMap<
    number,
    ReadonlyMap<PropertyKey, {
      readonly sourceIndex: number
      readonly transition: MicrostepTransition<any, any, any, any>
    }>
  >
}

const compileIndexedExecutionDescriptor = (
  machine: Machine.Any
): IndexedExecutionDescriptor | undefined => {
  const nodes: Array<Machine.StateNode> = []
  const leafPaths: Array<string> = []
  const finalPaths: Array<string> = []
  const transitionsByPath = new Map<
    PropertyKey,
    ReadonlyMap<PropertyKey, MicrostepTransition<any, any, any, any>>
  >()

  for (const node of machine.stateNodes.byPath.values() as Iterable<Machine.StateNode>) {
    nodes.push(node)
    if (node.type === "choice" || node.type === "history") {
      return undefined
    }
    if (node.type === "atomic" || node.type === "final") {
      leafPaths.push(node.path)
    }
    if (node.type === "final") {
      finalPaths.push(node.path)
    }

    const config = machine.handlers[node.path] as Machine.AnyStateConfig | undefined
    if (
      config?.entry !== undefined || config?.exit !== undefined || config?.always !== undefined ||
      config?.onDone !== undefined || (config as any)?.choice !== undefined ||
      (config as any)?.history !== undefined
    ) {
      return undefined
    }
    if (config?.on === undefined) {
      continue
    }
    const byEvent = new Map<PropertyKey, MicrostepTransition<any, any, any, any>>()
    for (const tag of Reflect.ownKeys(config.on)) {
      const transition = normalizeTransition(config.on[tag])
      if (transition !== undefined) {
        byEvent.set(tag, transition)
      }
    }
    if (byEvent.size > 0) {
      transitionsByPath.set(node.path, byEvent)
    }
  }

  leafPaths.sort((left, right) => compareDocumentOrder(machine, left, right))
  finalPaths.sort((left, right) => compareDocumentOrder(machine, left, right))
  nodes.sort((left, right) => left.order - right.order)
  const indexByPath = new Map(nodes.map((node, index) => [node.path, index]))
  const indexOf = (path: string): number => {
    const index = indexByPath.get(path)
    if (index === undefined) {
      throw new Error(`Machine expected compiled state path "${path}"`)
    }
    return index
  }
  const leafIndices = leafPaths.map(indexOf)
  const parentIndices = nodes.map((node) => node.parent === undefined ? -1 : indexOf(node.parent))
  const childIndices = nodes.map((node) => node.children.map(indexOf))
  const ancestorIndices = nodes.map((node) => getPathToRoot(machine, node.path).slice(0, -1).map(indexOf))
  const transitionsByIndex = nodes.map((node) => transitionsByPath.get(node.path))
  const dispatchByLeaf = new Map<
    number,
    ReadonlyMap<PropertyKey, {
      readonly sourceIndex: number
      readonly transition: MicrostepTransition<any, any, any, any>
    }>
  >()
  for (const leafIndex of leafIndices) {
    const dispatch = new Map<PropertyKey, {
      readonly sourceIndex: number
      readonly transition: MicrostepTransition<any, any, any, any>
    }>()
    const candidates = [leafIndex, ...ancestorIndices[leafIndex]!.slice().reverse()]
    for (const sourceIndex of candidates) {
      for (const [tag, transition] of transitionsByIndex[sourceIndex] ?? []) {
        if (!dispatch.has(tag)) dispatch.set(tag, { sourceIndex, transition })
      }
    }
    dispatchByLeaf.set(leafIndex, dispatch)
  }
  return {
    flat: nodes.every((node) => node.parent === undefined && (node.type === "atomic" || node.type === "final")),
    nodes,
    indexByPath,
    parentIndices,
    childIndices,
    ancestorIndices,
    rootIndices: nodes.flatMap((node, index) => node.parent === undefined ? [index] : []),
    leafIndices,
    finalIndices: finalPaths.map(indexOf),
    dispatchByLeaf
  }
}

interface IndexedConfiguration {
  readonly active: Uint8Array
  readonly activeLeaves: ReadonlyArray<number>
  // The compiled process fiber owns this slot table. Flat same-state updates
  // may replace one value in place after eagerly detaching the handler's
  // public snapshot; hierarchical microsteps retain immutable copies so
  // simultaneous transition contexts continue to share their starting state.
  readonly values: Array<unknown>
  readonly completed: Uint8Array
  readonly outputs: ReadonlyArray<unknown>
  readonly completedOrder: ReadonlyArray<number>
}

const indexedConfigurationFromActive = (
  descriptor: IndexedExecutionDescriptor,
  configuration: ActiveConfiguration
): IndexedConfiguration => {
  const active = new Uint8Array(descriptor.nodes.length)
  const values: Array<unknown> = new Array(descriptor.nodes.length)
  const completed = new Uint8Array(descriptor.nodes.length)
  const outputs: Array<unknown> = new Array(descriptor.nodes.length)
  const completedOrder: Array<number> = []
  for (const path of configuration.active) {
    const index = descriptor.indexByPath.get(path)
    if (index === undefined) throw new Error(`Machine expected indexed active path "${path}"`)
    active[index] = 1
    values[index] = configuration.values.get(path)
  }
  for (const [path, output] of configuration.outputs) {
    const index = descriptor.indexByPath.get(path)
    if (index === undefined) throw new Error(`Machine expected indexed completed path "${path}"`)
    completed[index] = 1
    outputs[index] = output
    completedOrder.push(index)
  }
  return {
    active,
    activeLeaves: descriptor.leafIndices.filter((index) => active[index] === 1),
    values,
    completed,
    outputs,
    completedOrder
  }
}

const activeConfigurationFromIndexed = (
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedConfiguration
): ActiveConfiguration => {
  const active = new Set<string>()
  const values = new Map<string, unknown>()
  const outputs = new Map<string, unknown>()
  for (let index = 0; index < descriptor.nodes.length; index++) {
    if (configuration.active[index] !== 1) continue
    const path = descriptor.nodes[index]!.path
    active.add(path)
    values.set(path, configuration.values[index])
  }
  for (const index of configuration.completedOrder) {
    if (configuration.completed[index] === 1) {
      outputs.set(descriptor.nodes[index]!.path, configuration.outputs[index])
    }
  }
  return { active, values, outputs, history: new Map() }
}

const snapshotFromIndexedPath = (
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedConfiguration,
  index: number
): Machine.AtomicSnapshot<string, unknown> => {
  const node = descriptor.nodes[index]!
  const snapshot: Record<string, unknown> = {
    path: node.path,
    value: configuration.values[index]
  }
  if (node.type === "compound") {
    const childIndex = descriptor.childIndices[index]!.find((childIndex) => configuration.active[childIndex] === 1)
    if (childIndex === undefined) {
      throw new Error(`Machine expected indexed compound state "${node.path}" to have an active child`)
    }
    snapshot.state = snapshotFromIndexedPath(descriptor, configuration, childIndex)
  } else if (node.type === "parallel") {
    const states: Record<string, unknown> = {}
    for (const childIndex of descriptor.childIndices[index]!) {
      if (configuration.active[childIndex] !== 1) {
        throw new Error(
          `Machine expected indexed parallel state "${node.path}" to have active region "${
            descriptor.nodes[childIndex]!.path
          }"`
        )
      }
      states[descriptor.nodes[childIndex]!.key] = snapshotFromIndexedPath(descriptor, configuration, childIndex)
    }
    snapshot.states = states
  }
  return snapshot as unknown as Machine.AtomicSnapshot<string, unknown>
}

const snapshotFromIndexed = (
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedConfiguration
): Machine.Snapshot<any> => {
  const rootIndex = descriptor.rootIndices.find((index) => configuration.active[index] === 1)
  if (rootIndex === undefined) throw new Error("Machine expected an active indexed root state")
  const snapshot = snapshotFromIndexedPath(descriptor, configuration, rootIndex) as Machine.Snapshot<any>
  if (configuration.completedOrder.length > 0) {
    ;(snapshot as Machine.AtomicSnapshot<string, unknown> & {
      completed: ReadonlyArray<Machine.SnapshotCompletion>
    }).completed = configuration.completedOrder.map((index) => ({
      path: descriptor.nodes[index]!.path,
      output: configuration.outputs[index]
    }))
  }
  return snapshot
}

const makeIndexedTransitionContext = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedConfiguration,
  sourceIndex: number,
  event: any
): any => {
  const source = descriptor.nodes[sourceIndex]!
  const parentIndex = descriptor.parentIndices[sourceIndex]!
  const parents: Record<string, unknown> = {}
  for (const ancestorIndex of descriptor.ancestorIndices[sourceIndex]!) {
    parents[descriptor.nodes[ancestorIndex]!.path] = configuration.values[ancestorIndex]
  }
  return {
    state: configuration.values[sourceIndex],
    parent: parentIndex < 0 ? undefined : configuration.values[parentIndex],
    parents,
    event,
    snapshot: snapshotFromIndexed(descriptor, configuration),
    target: getTargetBuilder(machine, source.path)
  }
}

type IndexedSelectedTransition = SelectedTransition<any, any, any, any> & {
  readonly sourceIndex: number
  readonly leafIndex: number
}

type IndexedEvaluatedTransition =
  & Omit<
    EvaluatedTransition<any, any, any, any, any>,
    "selection"
  >
  & {
    readonly selection: IndexedSelectedTransition
    readonly next: IndexedConfiguration
  }

const emptyCompiledValues: ReadonlyArray<never> = []

const collectIndexedTransition = (
  machine: Machine.Any,
  transition: TransitionHandler<any, any, any, any>,
  context: any
) => {
  let commands: Array<RuntimeCommand> | undefined
  let raisedEvents: Array<any> | undefined
  let emittedEvents: Array<unknown> | undefined
  const state = transition(context, {
    raise: (event: unknown) => {
      ;(raisedEvents ??= []).push(decodeEventSync(machine, event))
    },
    emit: (event: unknown) => {
      ;(emittedEvents ??= []).push(decodeEmitSync(machine, event))
    },
    sendTo: (child: unknown, event: unknown) => {
      ;(commands ??= []).push({ _tag: "SendTo", child: child as any, event })
    },
    stop: (child: unknown) => {
      ;(commands ??= []).push({ _tag: "Stop", child: child as any })
    }
  })
  return {
    state,
    commands: commands ?? emptyCompiledValues,
    raisedEvents: raisedEvents ?? emptyCompiledValues,
    emittedEvents: emittedEvents ?? emptyCompiledValues
  }
}

const selectIndexedEventTransitions = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedConfiguration,
  event: any
): ReadonlyArray<IndexedSelectedTransition> => {
  const selected: Array<IndexedSelectedTransition> = []
  for (const leafIndex of configuration.activeLeaves) {
    const dispatched = descriptor.dispatchByLeaf.get(leafIndex)!.get(event._tag)
    if (dispatched !== undefined) {
      const { sourceIndex, transition } = dispatched
      if (!selected.some((selection) => selection.sourceIndex === sourceIndex)) {
        const sourcePath = descriptor.nodes[sourceIndex]!.path
        selected.push({
          sourceIndex,
          leafIndex,
          sourcePath,
          leafPath: descriptor.nodes[leafIndex]!.path,
          trigger: { type: "event", event: event._tag },
          transition,
          context: makeIndexedTransitionContext(
            machine,
            descriptor,
            configuration,
            sourceIndex,
            event
          )
        })
      }
    }
  }
  return selected
}

const hasSameIndexedActive = (left: IndexedConfiguration, right: IndexedConfiguration): boolean => {
  if (left.active === right.active) return true
  for (let index = 0; index < left.active.length; index++) {
    if (left.active[index] !== right.active[index]) return false
  }
  return true
}

const normalizeIndexedTargetConfigurationSync = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  current: IndexedConfiguration,
  target: Machine.Target<any, any> | Machine.Snapshot<any>,
  activeLeafIndex: number
): IndexedConfiguration => {
  const targetIndex = isTarget(target) ? descriptor.indexByPath.get(String(target.path)) : undefined
  if (
    targetIndex === activeLeafIndex && current.active[activeLeafIndex] === 1 && isTarget(target) &&
    target[TargetSnapshotTypeId] === undefined && target.values === undefined && current.completedOrder.length === 0
  ) {
    const values = current.values.slice()
    values[activeLeafIndex] = decodeStateValueSync(
      machine,
      descriptor.nodes[activeLeafIndex]!,
      target.value
    )
    return { ...current, values }
  }
  return indexedConfigurationFromActive(
    descriptor,
    normalizeTargetConfigurationSync(
      machine,
      activeConfigurationFromIndexed(descriptor, current),
      target
    )
  )
}

const collectIndexedEvaluatedTransition = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  state: IndexedConfiguration,
  selection: IndexedSelectedTransition
): IndexedEvaluatedTransition => {
  const transitionResult = collectIndexedTransition(machine, selection.transition.transition, selection.context)
  const target = transitionResult.state
  validateDeclaredTransitionTarget(
    selection.sourcePath,
    selection.trigger,
    selection.transition.targets,
    target
  )
  if (target !== undefined && !isTarget(target) && !isSnapshot(target)) {
    throw new Error("Machine expected indexed transition target to be a snapshot or target builder result")
  }
  const next = target === undefined
    ? state
    : normalizeIndexedTargetConfigurationSync(machine, descriptor, state, target as any, selection.leafIndex)
  const changed = selection.transition.reenter || !hasSameIndexedActive(state, next)
  if (!changed) {
    return {
      selection,
      unresolvedTarget: target as any,
      target: target as any,
      next,
      commands: transitionResult.commands,
      raisedEvents: transitionResult.raisedEvents,
      emittedEvents: transitionResult.emittedEvents,
      changed: false,
      exitPaths: [],
      entryPaths: [],
      choiceTransitions: []
    }
  }

  const targetPath = target === undefined ? undefined : getTargetNodePath(target as any)
  const naturalBoundary = targetPath === undefined
    ? descriptor.nodes[selection.sourceIndex]!.parent
    : getLeastCommonAncestor(machine, selection.leafPath, targetPath)
  const reentryBoundary = descriptor.nodes[selection.sourceIndex]!.parent
  const boundary = selection.transition.reenter
    ? broadenTransitionBoundary(naturalBoundary, reentryBoundary)
    : naturalBoundary
  return {
    selection,
    unresolvedTarget: target as any,
    target: target as any,
    next,
    commands: transitionResult.commands,
    raisedEvents: transitionResult.raisedEvents,
    emittedEvents: transitionResult.emittedEvents,
    changed: true,
    exitPaths: getExitPaths(machine, activeConfigurationFromIndexed(descriptor, state), boundary),
    entryPaths: getEntryPaths(machine, activeConfigurationFromIndexed(descriptor, next), boundary),
    choiceTransitions: []
  }
}

const indexedMicrostep = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  state: IndexedConfiguration,
  event: any,
  selections: ReadonlyArray<IndexedSelectedTransition>
): MicrostepPlan<IndexedConfiguration, any, any, any> => {
  if (selections.length === 1) {
    const transition = collectIndexedEvaluatedTransition(machine, descriptor, state, selections[0]!)
    return {
      next: transition.next,
      event,
      transitions: [],
      commands: transition.commands,
      raisedEvents: transition.raisedEvents,
      emittedEvents: transition.emittedEvents,
      exitPaths: transition.exitPaths,
      entryPaths: transition.entryPaths,
      changed: transition.changed
    }
  }
  const activeSelections = selections.filter((selection) =>
    !selections.some((other) =>
      other.sourceIndex !== selection.sourceIndex &&
      isDescendantOf(other.sourcePath, selection.sourcePath)
    )
  )
  const evaluated = activeSelections.map((selection) =>
    collectIndexedEvaluatedTransition(machine, descriptor, state, selection)
  )
  const transitions = sortEvaluatedTransitions(
    machine,
    removeConflictingTransitions(machine, evaluated as any)
  ) as ReadonlyArray<IndexedEvaluatedTransition>

  let next = state
  if (transitions.length === 1) {
    next = transitions[0]!.next
  } else {
    const applicationOrder = [
      ...transitions.filter((transition) => !transition.changed),
      ...transitions.filter((transition) => transition.changed)
    ]
    for (const transition of applicationOrder) {
      if (transition.target !== undefined) {
        next = normalizeIndexedTargetConfigurationSync(
          machine,
          descriptor,
          next,
          transition.target,
          transition.selection.leafIndex
        )
      }
    }
  }

  const commands = transitions.flatMap((transition) => transition.commands)
  const raisedEvents = transitions.flatMap((transition) => transition.raisedEvents)
  const emittedEvents = transitions.flatMap((transition) => transition.emittedEvents)
  const changed = transitions.some((transition) => transition.changed)
  return {
    next,
    event,
    transitions: [],
    commands,
    raisedEvents,
    emittedEvents,
    exitPaths: changed ? sortExitPaths(machine, transitions.flatMap((transition) => transition.exitPaths)) : [],
    entryPaths: changed ? sortEntryPaths(machine, transitions.flatMap((transition) => transition.entryPaths)) : [],
    changed
  }
}

const planIndexedFlatConfiguration = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedConfiguration,
  decoded: { readonly _tag: PropertyKey }
): MacrostepPlan<IndexedConfiguration, any, any, any, any> => {
  let current = configuration
  let event: any = decoded
  let commands: Array<RuntimeCommand> | undefined
  let raisedEvents: Array<any> | undefined
  let emittedEvents: Array<unknown> | undefined
  let microsteps: Array<MicrostepPlan<IndexedConfiguration, any, any, any>> | undefined
  let raisedIndex = 0
  let iterations = 0

  while (true) {
    iterations += 1
    if (iterations > MaxMacrostepIterations) {
      throw new InfiniteTransitionError({
        machineId: machine.id,
        state: descriptor.nodes[current.activeLeaves[0]!]!.path,
        maxIterations: MaxMacrostepIterations
      })
    }

    const sourceIndex = current.activeLeaves[0]
    if (sourceIndex === undefined) {
      throw new Error("Machine expected an active indexed root state")
    }
    if (descriptor.nodes[sourceIndex]!.type === "final") {
      const completed = completeConfigurationSync(
        machine,
        activeConfigurationFromIndexed(descriptor, current),
        event
      ).configuration
      const root = getRootPath(machine, completed)
      if (!completed.outputs.has(root)) {
        throw new Error("Machine reached a terminal indexed configuration without a completed root output")
      }
      return {
        next: indexedConfigurationFromActive(descriptor, completed),
        commands: commands ?? emptyCompiledValues,
        emittedEvents: emittedEvents ?? emptyCompiledValues,
        microsteps: microsteps ?? emptyCompiledValues,
        done: true,
        output: completed.outputs.get(root)
      }
    }

    const sourcePath = descriptor.nodes[sourceIndex]!.path
    const transition = normalizeTransition(machine.handlers[sourcePath]?.on?.[event._tag])
    if (transition !== undefined) {
      const transitionResult = collectIndexedTransition(
        machine,
        transition.transition,
        {
          state: current.values[sourceIndex],
          parent: undefined,
          parents: {},
          event,
          snapshot: snapshotFromIndexed(descriptor, current),
          target: getTargetBuilder(machine, sourcePath)
        }
      )
      const target = transitionResult.state
      validateDeclaredTransitionTarget(
        sourcePath,
        { type: "event", event: event._tag },
        transition.targets,
        target
      )
      if (target !== undefined && !isTarget(target) && !isSnapshot(target)) {
        throw new Error("Machine expected indexed transition target to be a snapshot or target builder result")
      }

      let next = current
      if (target !== undefined) {
        const targetIndex = descriptor.indexByPath.get(String(target.path))
        const isSimpleTarget = isTarget(target)
          ? target[TargetSnapshotTypeId] === undefined && target.values === undefined
          : !("state" in target) && !("states" in target) && !("completed" in target) && !("history" in target)
        if (
          targetIndex === sourceIndex && isSimpleTarget && current.completedOrder.length === 0
        ) {
          current.values[sourceIndex] = decodeStateValueSync(
            machine,
            descriptor.nodes[sourceIndex]!,
            target.value
          )
        } else {
          next = normalizeIndexedTargetConfigurationSync(machine, descriptor, current, target as any, sourceIndex)
        }
      }
      const changed = transition.reenter || !hasSameIndexedActive(current, next)
      const nextIndex = next.activeLeaves[0]
      if (nextIndex === undefined) {
        throw new Error("Machine expected an active indexed transition target")
      }
      const step: MicrostepPlan<IndexedConfiguration, any, any, any> = {
        next,
        event,
        transitions: emptyCompiledValues,
        commands: transitionResult.commands,
        raisedEvents: transitionResult.raisedEvents,
        emittedEvents: transitionResult.emittedEvents,
        exitPaths: changed ? [sourcePath] : emptyCompiledValues,
        entryPaths: changed ? [descriptor.nodes[nextIndex]!.path] : emptyCompiledValues,
        changed
      }
      current = next
      ;(microsteps ??= []).push(step)
      if (transitionResult.commands.length > 0) {
        ;(commands ??= []).push(...transitionResult.commands)
      }
      if (transitionResult.raisedEvents.length > 0) {
        ;(raisedEvents ??= []).push(...transitionResult.raisedEvents)
      }
      if (transitionResult.emittedEvents.length > 0) {
        ;(emittedEvents ??= []).push(...transitionResult.emittedEvents)
      }
    }

    if (descriptor.nodes[current.activeLeaves[0]!]!.type === "final") {
      continue
    }
    const raised = raisedEvents?.[raisedIndex]
    if (raised === undefined) {
      return {
        next: current,
        commands: commands ?? emptyCompiledValues,
        emittedEvents: emittedEvents ?? emptyCompiledValues,
        microsteps: microsteps ?? emptyCompiledValues,
        done: false,
        output: undefined
      }
    }
    raisedIndex += 1
    event = raised
  }
}

const planIndexedConfiguration = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedConfiguration,
  input: unknown
): MacrostepPlan<IndexedConfiguration, any, any, any, any> => {
  const decoded = decodeEventSync(machine, input) as { readonly _tag: PropertyKey }
  if (descriptor.flat) {
    return planIndexedFlatConfiguration(machine, descriptor, configuration, decoded)
  }
  if (descriptor.finalIndices.some((index) => configuration.active[index] === 1)) {
    const active = activeConfigurationFromIndexed(descriptor, configuration)
    if (isActiveFinalConfiguration(machine, active)) {
      const completed = completeConfigurationSync(machine, active, decoded).configuration
      const root = getRootPath(machine, completed)
      if (!completed.outputs.has(root)) {
        throw new Error("Machine reached a terminal indexed configuration without a completed root output")
      }
      return {
        next: indexedConfigurationFromActive(descriptor, completed),
        commands: [],
        emittedEvents: [],
        microsteps: [],
        done: true,
        output: completed.outputs.get(root)
      }
    }
  }

  const selections = selectIndexedEventTransitions(machine, descriptor, configuration, decoded)
  if (selections.length === 0) {
    return {
      next: configuration,
      commands: [],
      emittedEvents: [],
      microsteps: [],
      done: false,
      output: undefined
    }
  }

  const first = indexedMicrostep(machine, descriptor, configuration, decoded, selections)
  let current = first.next
  let currentEvent: any = decoded
  const commands = [...first.commands]
  const raisedEvents = [...first.raisedEvents]
  const emittedEvents = [...first.emittedEvents]
  const microsteps = [first]
  let raisedIndex = 0
  let iterations = 0

  while (true) {
    iterations += 1
    if (iterations > MaxMacrostepIterations) {
      throw new InfiniteTransitionError({
        machineId: machine.id,
        state: descriptor.nodes[descriptor.leafIndices.find((index) => current.active[index] === 1)!]!.path,
        maxIterations: MaxMacrostepIterations
      })
    }

    if (descriptor.finalIndices.some((index) => current.active[index] === 1)) {
      const completed = completeConfigurationSync(
        machine,
        activeConfigurationFromIndexed(descriptor, current),
        currentEvent
      ).configuration
      current = indexedConfigurationFromActive(descriptor, completed)
      if (isActiveFinalConfiguration(machine, completed)) {
        const root = getRootPath(machine, completed)
        if (!completed.outputs.has(root)) {
          throw new Error("Machine reached a terminal indexed configuration without a completed root output")
        }
        return {
          next: current,
          commands,
          emittedEvents,
          microsteps,
          done: true,
          output: completed.outputs.get(root)
        }
      }
    }

    const raised = raisedEvents[raisedIndex]
    if (raised === undefined) {
      return {
        next: current,
        commands,
        emittedEvents,
        microsteps,
        done: false,
        output: undefined
      }
    }
    raisedIndex += 1
    currentEvent = raised
    const raisedSelections = selectIndexedEventTransitions(machine, descriptor, current, raised)
    if (raisedSelections.length === 0) continue
    const step = indexedMicrostep(machine, descriptor, current, raised, raisedSelections)
    current = step.next
    commands.push(...step.commands)
    raisedEvents.push(...step.raisedEvents)
    emittedEvents.push(...step.emittedEvents)
    microsteps.push(step)
  }
}

export interface CompiledExecutionPlan {
  readonly fromConfiguration: (configuration: ActiveConfiguration) => unknown
  readonly toConfiguration: (state: unknown) => ActiveConfiguration
  readonly snapshot: (state: unknown) => Machine.Snapshot<any>
  readonly plan: (
    state: unknown,
    event: unknown
  ) => MacrostepPlan<any, any, any, any, any>
  readonly initial?: (
    args: ReadonlyArray<unknown>
  ) => {
    readonly state: Machine.Snapshot<any>
    readonly configuration: unknown
    readonly activeConfiguration: ActiveConfiguration
    readonly initialEntryPaths: ReadonlyArray<string>
    readonly done: boolean
    readonly output: unknown
  }
}

const executionPlanCache = new WeakMap<Machine.Any, CompiledExecutionPlan>()

const makeActiveExecutionPlan = (machine: Machine.Any): CompiledExecutionPlan => ({
  fromConfiguration: (configuration) => configuration,
  toConfiguration: (state) => state as ActiveConfiguration,
  snapshot: (state) => snapshotFromConfiguration(machine, state as ActiveConfiguration),
  plan: (state, event) => planConfiguration(machine as any, state as ActiveConfiguration, event as any)
})

const makeIndexedExecutionPlan = (
  machine: Machine.Any,
  indexed: IndexedExecutionDescriptor
): CompiledExecutionPlan => ({
  fromConfiguration: (configuration) => indexedConfigurationFromActive(indexed, configuration),
  toConfiguration: (state) => activeConfigurationFromIndexed(indexed, state as IndexedConfiguration),
  snapshot: (state) => snapshotFromIndexed(indexed, state as IndexedConfiguration),
  plan: (state, event) => planIndexedConfiguration(machine, indexed, state as IndexedConfiguration, event),
  initial: (args) => {
    const inputArgs = machine.input === undefined
      ? args
      : args.length === 0
      ? (decodeInputSync(machine, machine.input, undefined), args)
      : [decodeInputSync(machine, machine.input, args[0])]
    const initial = machine.initial(...inputArgs as any)
    const active = normalizeConfigurationSync(machine, initial as Machine.Snapshot<any>)
    validateInitialConfiguration(machine, active)
    const completed = completeConfigurationSync(machine, active, InitialEvent).configuration
    const configuration = indexedConfigurationFromActive(indexed, completed)
    const state = snapshotFromIndexed(indexed, configuration)
    const done = isActiveFinalConfiguration(machine, completed)
    if (!done) {
      return {
        state,
        configuration,
        activeConfiguration: completed,
        initialEntryPaths: getInitialEntryPaths(machine, completed),
        done: false,
        output: undefined
      }
    }
    const root = getRootPath(machine, completed)
    if (!completed.outputs.has(root)) {
      throw new Error("Machine reached a terminal configuration without a completed root output")
    }
    return {
      state,
      configuration,
      activeConfiguration: completed,
      initialEntryPaths: getInitialEntryPaths(machine, completed),
      done: true,
      output: completed.outputs.get(root)
    }
  }
})

export type ExecutionPlanStrategy = "generic" | "indexed-flat" | "indexed-hierarchical" | "auto"

export interface SelectedExecutionPlan {
  readonly strategy: Exclude<ExecutionPlanStrategy, "auto">
  readonly plan: CompiledExecutionPlan
}

const selectExecutionPlan = (
  machine: Machine.Any,
  strategy: ExecutionPlanStrategy
): SelectedExecutionPlan => {
  if (strategy === "generic") {
    return { strategy, plan: makeActiveExecutionPlan(machine) }
  }
  const indexed = compileIndexedExecutionDescriptor(machine)
  if (indexed === undefined) {
    if (strategy === "auto") {
      return { strategy: "generic", plan: makeActiveExecutionPlan(machine) }
    }
    throw new Error(`Machine cannot compile the requested ${strategy} execution plan`)
  }
  const selected = indexed.flat ? "indexed-flat" : "indexed-hierarchical"
  if (strategy !== "auto" && strategy !== selected) {
    throw new Error(`Machine compiled ${selected}, not the requested ${strategy} execution plan`)
  }
  return { strategy: selected, plan: makeIndexedExecutionPlan(machine, indexed) }
}

/** @internal Test-only uncached strategy selection. */
export const selectExecutionPlanForTesting = (
  machine: Machine.Any,
  strategy: ExecutionPlanStrategy
): SelectedExecutionPlan => selectExecutionPlan(machine, strategy)

export const compileExecutionPlan = (machine: Machine.Any): CompiledExecutionPlan => {
  const cached = executionPlanCache.get(machine)
  if (cached !== undefined) {
    return cached
  }
  const indexed = compileIndexedExecutionDescriptor(machine)
  const compiled = indexed === undefined
    ? makeActiveExecutionPlan(machine)
    : makeIndexedExecutionPlan(machine, indexed)
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
