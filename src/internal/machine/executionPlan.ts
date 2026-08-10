/**
 * Internal compiled machine execution plans.
 *
 * @since 4.0.0
 */

import type { Machine } from "../../Machine.js"
import { getTargetBuilder, type RuntimeCommand } from "./command.js"
import {
  type ActiveConfiguration,
  compareDocumentOrder,
  completeConfigurationSync,
  getInitialEntryPaths,
  getPathToRoot,
  getRootPath,
  isActiveFinalConfiguration,
  isDescendantOf,
  normalizeConfigurationSync,
  normalizeTargetConfigurationSync,
  snapshotFromConfiguration,
  validateInitialConfiguration
} from "./configuration.js"
import { InfiniteTransitionError } from "./errors.js"
import {
  broadenTransitionBoundary,
  type EvaluatedTransition,
  getEntryPaths,
  getExitPaths,
  getLeastCommonAncestor,
  getTargetNodePath,
  InitialEvent,
  MaxMacrostepIterations,
  type MicrostepTransition,
  normalizeTransition,
  planConfiguration,
  removeConflictingTransitions,
  type SelectedTransition,
  sortEntryPaths,
  sortEvaluatedTransitions,
  sortExitPaths,
  type TransitionHandler,
  validateDeclaredTransitionTarget
} from "./planner.js"
import { decodeEmitSync, decodeEventSync, decodeInputSync, decodeStateValueSync } from "./protocol.js"
import { isSnapshot, isTarget, TargetSnapshotTypeId } from "./topology.js"

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

const indexedStateConfigKeys: ReadonlySet<PropertyKey> = new Set([
  "initial",
  "invoke",
  "on",
  "output"
])

// Fail closed so a newly introduced semantic field must explicitly opt into
// indexed execution instead of being accepted before the kernel supports it.
const supportsIndexedStateConfig = (config: Machine.AnyStateConfig | undefined): boolean => {
  if (config === undefined) {
    return true
  }
  for (const key of Reflect.ownKeys(config)) {
    if (!indexedStateConfigKeys.has(key)) {
      return false
    }
  }
  return true
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
    if (!supportsIndexedStateConfig(config)) {
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

/**
 * The compact execution state owned by a single compiled process drain.
 *
 * This representation never crosses the public snapshot boundary. The flat
 * kernel may update `values` in place only after constructing the handler
 * context, whose snapshot is detached from this storage. Hierarchical plans
 * copy the table whenever simultaneous transitions need their common source
 * state to remain stable.
 */
interface OwnedIndexedState {
  readonly active: Uint8Array
  readonly activeLeaves: ReadonlyArray<number>
  readonly values: Array<unknown>
  readonly completed: Uint8Array
  readonly outputs: ReadonlyArray<unknown>
  readonly completedOrder: ReadonlyArray<number>
}

const updateOwnedIndexedValue = (
  state: OwnedIndexedState,
  index: number,
  value: unknown
): void => {
  state.values[index] = value
}

const ownedIndexedStateFromActive = (
  descriptor: IndexedExecutionDescriptor,
  configuration: ActiveConfiguration
): OwnedIndexedState => {
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

const activeConfigurationFromIndexedState = (
  descriptor: IndexedExecutionDescriptor,
  configuration: OwnedIndexedState
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

const snapshotFromIndexedStateStatePath = (
  descriptor: IndexedExecutionDescriptor,
  configuration: OwnedIndexedState,
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
    snapshot.state = snapshotFromIndexedStateStatePath(descriptor, configuration, childIndex)
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
      states[descriptor.nodes[childIndex]!.key] = snapshotFromIndexedStateStatePath(
        descriptor,
        configuration,
        childIndex
      )
    }
    snapshot.states = states
  }
  return snapshot as unknown as Machine.AtomicSnapshot<string, unknown>
}

const snapshotFromIndexedState = (
  descriptor: IndexedExecutionDescriptor,
  configuration: OwnedIndexedState
): Machine.Snapshot<any> => {
  const rootIndex = descriptor.rootIndices.find((index) => configuration.active[index] === 1)
  if (rootIndex === undefined) throw new Error("Machine expected an active indexed root state")
  const snapshot = snapshotFromIndexedStateStatePath(descriptor, configuration, rootIndex) as Machine.Snapshot<any>
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
  configuration: OwnedIndexedState,
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
    snapshot: snapshotFromIndexedState(descriptor, configuration),
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
    readonly next: OwnedIndexedState
  }

const emptyExecutionValues: ReadonlyArray<never> = Object.freeze([])

export interface ExecutionMicrostep<State = unknown> {
  readonly next: State
  readonly event: unknown
  readonly commands: ReadonlyArray<RuntimeCommand>
  readonly raisedEvents: ReadonlyArray<unknown>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly changed: boolean
}

export interface ExecutionMacrostep<State = unknown> {
  readonly next: State
  readonly commands: ReadonlyArray<RuntimeCommand>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly microsteps: ReadonlyArray<ExecutionMicrostep<State>>
  readonly done: boolean
  readonly output: unknown
}

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
    commands: commands ?? emptyExecutionValues,
    raisedEvents: raisedEvents ?? emptyExecutionValues,
    emittedEvents: emittedEvents ?? emptyExecutionValues
  }
}

const selectIndexedEventTransitions = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  configuration: OwnedIndexedState,
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

const hasSameIndexedActive = (left: OwnedIndexedState, right: OwnedIndexedState): boolean => {
  if (left.active === right.active) return true
  for (let index = 0; index < left.active.length; index++) {
    if (left.active[index] !== right.active[index]) return false
  }
  return true
}

const normalizeIndexedTargetStateSync = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  current: OwnedIndexedState,
  target: Machine.Target<any, any> | Machine.Snapshot<any>,
  activeLeafIndex: number
): OwnedIndexedState => {
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
  return ownedIndexedStateFromActive(
    descriptor,
    normalizeTargetConfigurationSync(
      machine,
      activeConfigurationFromIndexedState(descriptor, current),
      target
    )
  )
}

const collectIndexedEvaluatedTransition = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  state: OwnedIndexedState,
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
    : normalizeIndexedTargetStateSync(machine, descriptor, state, target as any, selection.leafIndex)
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
    exitPaths: getExitPaths(machine, activeConfigurationFromIndexedState(descriptor, state), boundary),
    entryPaths: getEntryPaths(machine, activeConfigurationFromIndexedState(descriptor, next), boundary),
    choiceTransitions: []
  }
}

const indexedMicrostep = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  state: OwnedIndexedState,
  event: any,
  selections: ReadonlyArray<IndexedSelectedTransition>
): ExecutionMicrostep<OwnedIndexedState> => {
  if (selections.length === 1) {
    const transition = collectIndexedEvaluatedTransition(machine, descriptor, state, selections[0]!)
    return {
      next: transition.next,
      event,
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
        next = normalizeIndexedTargetStateSync(
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
    commands,
    raisedEvents,
    emittedEvents,
    exitPaths: changed ? sortExitPaths(machine, transitions.flatMap((transition) => transition.exitPaths)) : [],
    entryPaths: changed ? sortEntryPaths(machine, transitions.flatMap((transition) => transition.entryPaths)) : [],
    changed
  }
}

const planIndexedFlatState = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  configuration: OwnedIndexedState,
  decoded: { readonly _tag: PropertyKey }
): ExecutionMacrostep<OwnedIndexedState> => {
  let current = configuration
  let event: any = decoded
  let commands: Array<RuntimeCommand> | undefined
  let raisedEvents: Array<any> | undefined
  let emittedEvents: Array<unknown> | undefined
  let microsteps: Array<ExecutionMicrostep<OwnedIndexedState>> | undefined
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
        activeConfigurationFromIndexedState(descriptor, current),
        event
      ).configuration
      const root = getRootPath(machine, completed)
      if (!completed.outputs.has(root)) {
        throw new Error("Machine reached a terminal indexed configuration without a completed root output")
      }
      return {
        next: ownedIndexedStateFromActive(descriptor, completed),
        commands: commands ?? emptyExecutionValues,
        emittedEvents: emittedEvents ?? emptyExecutionValues,
        microsteps: microsteps ?? emptyExecutionValues,
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
          snapshot: snapshotFromIndexedState(descriptor, current),
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
          updateOwnedIndexedValue(
            current,
            sourceIndex,
            decodeStateValueSync(
              machine,
              descriptor.nodes[sourceIndex]!,
              target.value
            )
          )
        } else {
          next = normalizeIndexedTargetStateSync(machine, descriptor, current, target as any, sourceIndex)
        }
      }
      const changed = transition.reenter || !hasSameIndexedActive(current, next)
      const nextIndex = next.activeLeaves[0]
      if (nextIndex === undefined) {
        throw new Error("Machine expected an active indexed transition target")
      }
      const step: ExecutionMicrostep<OwnedIndexedState> = {
        next,
        event,
        commands: transitionResult.commands,
        raisedEvents: transitionResult.raisedEvents,
        emittedEvents: transitionResult.emittedEvents,
        exitPaths: changed ? [sourcePath] : emptyExecutionValues,
        entryPaths: changed ? [descriptor.nodes[nextIndex]!.path] : emptyExecutionValues,
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
        commands: commands ?? emptyExecutionValues,
        emittedEvents: emittedEvents ?? emptyExecutionValues,
        microsteps: microsteps ?? emptyExecutionValues,
        done: false,
        output: undefined
      }
    }
    raisedIndex += 1
    event = raised
  }
}

const planIndexedState = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  configuration: OwnedIndexedState,
  input: unknown
): ExecutionMacrostep<OwnedIndexedState> => {
  const decoded = decodeEventSync(machine, input)
  if (descriptor.flat) {
    return planIndexedFlatState(machine, descriptor, configuration, decoded)
  }
  if (descriptor.finalIndices.some((index) => configuration.active[index] === 1)) {
    const active = activeConfigurationFromIndexedState(descriptor, configuration)
    if (isActiveFinalConfiguration(machine, active)) {
      const completed = completeConfigurationSync(machine, active, decoded).configuration
      const root = getRootPath(machine, completed)
      if (!completed.outputs.has(root)) {
        throw new Error("Machine reached a terminal indexed configuration without a completed root output")
      }
      return {
        next: ownedIndexedStateFromActive(descriptor, completed),
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
        activeConfigurationFromIndexedState(descriptor, current),
        currentEvent
      ).configuration
      current = ownedIndexedStateFromActive(descriptor, completed)
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
  ) => ExecutionMacrostep
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
  fromConfiguration: (configuration) => ownedIndexedStateFromActive(indexed, configuration),
  toConfiguration: (state) => activeConfigurationFromIndexedState(indexed, state as OwnedIndexedState),
  snapshot: (state) => snapshotFromIndexedState(indexed, state as OwnedIndexedState),
  plan: (state, event) => planIndexedState(machine, indexed, state as OwnedIndexedState, event),
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
    const configuration = ownedIndexedStateFromActive(indexed, completed)
    const state = snapshotFromIndexedState(indexed, configuration)
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
