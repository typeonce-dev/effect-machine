/**
 * Internal compiled machine execution plans.
 *
 * @since 0.4.0
 */

import * as Effect from "effect/Effect"
import type { Machine, MachineTarget } from "../../Machine.js"
import { type RuntimeCommand, type SendToTarget, type StopTarget } from "./command.js"
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
  type PlanningMachineReferences,
  snapshotFromConfiguration,
  withMachineReferences
} from "./configuration.js"
import { InfiniteTransitionError, StoppedError } from "./errors.js"
import { type CapturedStateConfig, toImpl } from "./implementation.js"
import { isDataInitializer } from "./initialDeclaration.js"
import * as InvocationEvent from "./invocationEvent.js"
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
  planDecodedConfiguration,
  removeConflictingTransitions,
  resolveInitialConfiguration,
  resolveInitialTarget,
  type SelectedTransition,
  sortEntryPaths,
  sortEvaluatedTransitions,
  sortExitPaths,
  type TransitionHandler,
  validateDeclaredTransitionTarget
} from "./planner.js"
import { decodeEmitSync, decodeEventSync, decodeInputSync, decodeStateValueSync } from "./protocol.js"
import {
  isCombinedTarget,
  isInitialTarget,
  isNoTarget,
  isSnapshot,
  isStateUpdate,
  isTarget,
  type TargetSnapshotSlot,
  TargetSnapshotTypeId
} from "./topology.js"

interface IndexedExecutionDescriptor {
  readonly flat: boolean
  /** Distinguishes structural nodes from valued slots, including decoded undefined. */
  readonly valued: ReadonlyArray<boolean>
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
      readonly transition: MicrostepTransition<any, any>
    }>
  >
}

const planningMachineReferences = new WeakMap<Machine.Any, PlanningMachineReferences>()

const getPlanningMachineReferences = (machine: Machine.Any): PlanningMachineReferences => {
  const cached = planningMachineReferences.get(machine)
  if (cached !== undefined) return cached
  const self: MachineTarget<unknown> = {
    id: machine.id ?? "Machine",
    sessionId: "Machine.plan",
    send: () => Effect.fail(new StoppedError())
  }
  const scope = { self, parent: undefined }
  planningMachineReferences.set(machine, scope)
  return scope
}

const resolveMachineReferences = (
  machine: Machine.Any,
  machineReferences: PlanningMachineReferences | undefined
): { readonly self: MachineTarget<any>; readonly parent?: MachineTarget<any> | undefined } => {
  const resolved = machineReferences === undefined
    ? getPlanningMachineReferences(machine)
    : machineReferences
  return machine.parent === undefined
    ? { self: resolved.self }
    : { self: resolved.self, parent: resolved.parent }
}

const indexedStateConfigKeys: ReadonlySet<PropertyKey> = new Set([
  "initialize",
  "invoke",
  "on",
  "output"
])

// Fail closed so a newly introduced semantic field must explicitly opt into
// indexed execution instead of being accepted before the kernel supports it.
const supportsIndexedStateConfig = (config: CapturedStateConfig | undefined): boolean => {
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
    ReadonlyMap<PropertyKey, MicrostepTransition<any, any>>
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

    const config = toImpl(machine).handlers[node.path]
    if (!supportsIndexedStateConfig(config)) {
      return undefined
    }
    if (config?.on === undefined) {
      continue
    }
    const byEvent = new Map<PropertyKey, MicrostepTransition<any, any>>()
    for (const tag of Reflect.ownKeys(config.on)) {
      const transition = normalizeTransition(config.on[tag] as Parameters<typeof normalizeTransition>[0])
      if (transition !== undefined) {
        if (transition.declinable) return undefined
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
      readonly transition: MicrostepTransition<any, any>
    }>
  >()
  for (const leafIndex of leafIndices) {
    const dispatch = new Map<PropertyKey, {
      readonly sourceIndex: number
      readonly transition: MicrostepTransition<any, any>
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
    valued: Object.freeze(nodes.map((node) => node.schema !== undefined)),
    // A structural root with direct leaves has the same event kernel as an
    // atomic root. Root behavior and targets that can rebuild the root retain
    // the hierarchical planner so their entry and exit boundaries stay explicit.
    flat: nodes.every((node) => node.parent === undefined && (node.type === "atomic" || node.type === "final")) || (
      nodes[0]?.path === "" && nodes[0].type === "compound" && nodes[0].schema === undefined &&
      (toImpl(machine).handlers[""] === undefined ||
        Reflect.ownKeys(toImpl(machine).handlers[""]!).every((key) => key === "initialize")) &&
      nodes.slice(1).every((node) => node.parent === "" && (node.type === "atomic" || node.type === "final")) &&
      [...transitionsByPath.values()].every((events) =>
        [...events.values()].every((transition) =>
          transition.targets !== undefined && transition.targets.every((path) => path !== "")
        )
      )
    ),
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
 * The compact execution state of the indexed kernels.
 *
 * This representation never crosses the public snapshot boundary. Only
 * `values` is ever written in place, and only by the flat kernel, after it has
 * built the handler context, whose snapshot is detached from this storage. Who
 * may let it write a state is the {@link ExecutionOwnership} of the plan. The
 * hierarchical kernel never writes a state in place: it copies the table
 * whenever it changes it, so simultaneous transitions read one stable source
 * state, and its microsteps can share states with what it returns.
 */
interface IndexedExecutionState {
  readonly active: Uint8Array
  readonly activeLeaves: ReadonlyArray<number>
  readonly values: Array<unknown>
  readonly completed: Uint8Array
  readonly outputs: ReadonlyArray<unknown>
  readonly completedOrder: ReadonlyArray<number>
}

/**
 * Who may write the execution state that a plan receives.
 *
 * - `"Persistent"`: the state is a persistent value. The caller may keep it and
 *   plan from it again, and may keep what the plan returns. The plan writes no
 *   state that it did not create in that same call, and returns no state that a
 *   later `"Persistent"` plan writes.
 * - `"Owned"`: the caller hands the state over to the plan, and reads it again
 *   only through what the plan returns. The plan may update it in place. What a
 *   plan returns, its next state and its microsteps, stays valid until that
 *   next state is planned again. A plan that throws leaves the state it received
 *   as it was.
 *
 * Every plan of one chain of states takes the same ownership, since an
 * `"Owned"` plan may write a state that a `"Persistent"` plan returned to a
 * caller that keeps it.
 *
 * @internal
 */
export type ExecutionOwnership = "Owned" | "Persistent"

const copyIndexedState = (state: IndexedExecutionState): IndexedExecutionState => ({
  active: state.active.slice(),
  activeLeaves: state.activeLeaves.slice(),
  values: state.values.slice(),
  completed: state.completed.slice(),
  outputs: state.outputs.slice(),
  completedOrder: state.completedOrder.slice()
})

/** A state equal to `state` whose values the kernel may write, as only `values` is ever written. */
const withWritableIndexedValues = (state: IndexedExecutionState): IndexedExecutionState => ({
  ...state,
  values: state.values.slice()
})

const indexedStateFromActive = (
  descriptor: IndexedExecutionDescriptor,
  configuration: ActiveConfiguration
): IndexedExecutionState => {
  const active = new Uint8Array(descriptor.nodes.length)
  const values: Array<unknown> = new Array(descriptor.nodes.length)
  const completed = new Uint8Array(descriptor.nodes.length)
  const outputs: Array<unknown> = new Array(descriptor.nodes.length)
  const completedOrder: Array<number> = []
  for (const path of configuration.active) {
    const index = descriptor.indexByPath.get(path)
    if (index === undefined) throw new Error(`Machine expected indexed active path "${path}"`)
    active[index] = 1
    if (descriptor.valued[index]) values[index] = configuration.values.get(path)
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
  configuration: IndexedExecutionState
): ActiveConfiguration => {
  const active = new Set<string>()
  const values = new Map<string, unknown>()
  const outputs = new Map<string, unknown>()
  for (let index = 0; index < descriptor.nodes.length; index++) {
    if (configuration.active[index] !== 1) continue
    const path = descriptor.nodes[index]!.path
    active.add(path)
    if (descriptor.valued[index]) values.set(path, configuration.values[index])
  }
  for (const index of configuration.completedOrder) {
    if (configuration.completed[index] === 1) {
      outputs.set(descriptor.nodes[index]!.path, configuration.outputs[index])
    }
  }
  return { active, values, outputs, history: new Map() }
}

/** A snapshot node under construction; it is detached from the indexed tables. */
interface IndexedSnapshotNode {
  readonly path: string
  readonly value: unknown
  state?: IndexedSnapshotNode
  states?: Record<string, IndexedSnapshotNode>
  completed?: ReadonlyArray<Machine.SnapshotCompletion>
}

const snapshotFromIndexedStateStatePath = (
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedExecutionState,
  index: number
): IndexedSnapshotNode => {
  const node = descriptor.nodes[index]!
  const snapshot: IndexedSnapshotNode = {
    path: node.path,
    value: descriptor.valued[index] ? configuration.values[index] : undefined
  }
  if (node.type === "compound") {
    const childIndex = descriptor.childIndices[index]!.find((childIndex) => configuration.active[childIndex] === 1)
    if (childIndex === undefined) {
      throw new Error(`Machine expected indexed compound state "${node.path}" to have an active child`)
    }
    snapshot.state = snapshotFromIndexedStateStatePath(descriptor, configuration, childIndex)
  } else if (node.type === "parallel") {
    const states: Record<string, IndexedSnapshotNode> = {}
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
  return snapshot
}

const snapshotFromIndexedState = (
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedExecutionState
): Machine.Snapshot<any> => {
  const rootIndex = descriptor.rootIndices.find((index) => configuration.active[index] === 1)
  if (rootIndex === undefined) throw new Error("Machine expected an active indexed root state")
  const snapshot = snapshotFromIndexedStateStatePath(descriptor, configuration, rootIndex)
  if (configuration.completedOrder.length > 0) {
    snapshot.completed = configuration.completedOrder.map((index) => ({
      path: descriptor.nodes[index]!.path,
      output: configuration.outputs[index]
    }))
  }
  return snapshot
}

/** A decoded machine event; indexed dispatch reads only its tag. */
interface IndexedEvent {
  readonly _tag: PropertyKey
}

/** Handler context built by indexed dispatch, matching the generic planner's transition context. */
interface IndexedTransitionContext {
  readonly self: MachineTarget<any>
  readonly parent?: MachineTarget<any> | undefined
  readonly state: unknown
  readonly containingState: unknown
  readonly ancestors: Readonly<Record<string, unknown>>
  readonly event: IndexedEvent
  readonly snapshot: Machine.Snapshot<any>
}

const makeIndexedTransitionContext = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedExecutionState,
  sourceIndex: number,
  event: IndexedEvent,
  machineReferences?: PlanningMachineReferences
): IndexedTransitionContext => {
  const parentIndex = descriptor.parentIndices[sourceIndex]!
  const ancestors: Record<string, unknown> = {}
  for (const ancestorIndex of descriptor.ancestorIndices[sourceIndex]!) {
    if (descriptor.valued[ancestorIndex]) {
      ancestors[descriptor.nodes[ancestorIndex]!.path] = configuration.values[ancestorIndex]
    }
  }
  return {
    ...resolveMachineReferences(machine, machineReferences),
    state: configuration.values[sourceIndex],
    containingState: parentIndex < 0 ? undefined : configuration.values[parentIndex],
    ancestors,
    event,
    snapshot: snapshotFromIndexedState(descriptor, configuration)
  }
}

type IndexedSelectedTransition = SelectedTransition<any, IndexedTransitionContext> & {
  readonly sourceIndex: number
  readonly leafIndex: number
}

type IndexedEvaluatedTransition =
  & Omit<
    EvaluatedTransition<any, IndexedEvent, IndexedTransitionContext>,
    "selection"
  >
  & {
    readonly selection: IndexedSelectedTransition
    readonly next: IndexedExecutionState
  }

const emptyExecutionValues: ReadonlyArray<never> = Object.freeze([])

/** Marks that a flat microstep writes no value. A decoded value may be `undefined`. */
const noIndexedValue: unique symbol = Symbol("effect/Machine/ExecutionPlan/NoValue")

export interface ExecutionMicrostep<State = unknown> {
  readonly next: State
  readonly event: unknown
  readonly transitions?: ReadonlyArray<Machine.RetainedTransition>
  readonly commands: ReadonlyArray<RuntimeCommand>
  readonly raisedEvents: ReadonlyArray<unknown>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly changed: boolean
}

export interface ExecutionMacrostep<State = unknown> {
  readonly event: unknown
  readonly next: State
  readonly commands: ReadonlyArray<RuntimeCommand>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly microsteps: ReadonlyArray<ExecutionMicrostep<State>>
  readonly done: boolean
  readonly output: unknown
}

const collectIndexedTransition = <Context>(
  machine: Machine.Any,
  transition: TransitionHandler<any, Context>,
  context: Context,
  evaluate?: NonNullable<MicrostepTransition<any, Context>["evaluate"]>
) => {
  let commands: Array<RuntimeCommand> | undefined
  let raisedEvents: Array<IndexedEvent> | undefined
  let emittedEvents: Array<unknown> | undefined
  const enqueue = {
    raise: (event: unknown) => {
      ;(raisedEvents ??= []).push(decodeEventSync(machine, event))
    },
    emit: (event: unknown) => {
      ;(emittedEvents ??= []).push(decodeEmitSync(machine, event))
    },
    sendTo: (target: SendToTarget, event: unknown) => {
      ;(commands ??= []).push({ _tag: "SendTo", target, event })
    },
    stop: (child: StopTarget) => {
      ;(commands ??= []).push({ _tag: "Stop", child })
    }
  }
  const evaluated = evaluate === undefined
    ? { result: transition(context, enqueue), branchIndex: 0, branchKey: undefined }
    : evaluate(context, enqueue)
  return {
    state: isNoTarget(evaluated.result) ? undefined : evaluated.result,
    branchIndex: evaluated.branchIndex,
    branchKey: evaluated.branchKey,
    commands: commands ?? emptyExecutionValues,
    raisedEvents: raisedEvents ?? emptyExecutionValues,
    emittedEvents: emittedEvents ?? emptyExecutionValues
  }
}

const selectIndexedEventTransitions = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedExecutionState,
  event: IndexedEvent,
  machineReferences?: PlanningMachineReferences
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
            event,
            machineReferences
          )
        })
      }
    }
  }
  return selected
}

const hasSameIndexedActive = (left: IndexedExecutionState, right: IndexedExecutionState): boolean => {
  if (left.active === right.active) return true
  for (let index = 0; index < left.active.length; index++) {
    if (left.active[index] !== right.active[index]) return false
  }
  return true
}

const normalizeIndexedTargetStateSync = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  current: IndexedExecutionState,
  target: Machine.Target<any, any> | Machine.Snapshot<any>,
  activeLeafIndex: number
): IndexedExecutionState => {
  const targetIndex = isTarget(target) ? descriptor.indexByPath.get(String(target.path)) : undefined
  if (
    targetIndex === activeLeafIndex && current.active[activeLeafIndex] === 1 && isTarget(target) &&
    (target as TargetSnapshotSlot)[TargetSnapshotTypeId] === undefined && target.values === undefined &&
    current.completedOrder.length === 0 &&
    descriptor.valued[activeLeafIndex]
  ) {
    const values = current.values.slice()
    values[activeLeafIndex] = decodeStateValueSync(
      machine,
      descriptor.nodes[activeLeafIndex]!,
      target.value
    )
    return { ...current, values }
  }
  return indexedStateFromActive(
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
  state: IndexedExecutionState,
  selection: IndexedSelectedTransition
): IndexedEvaluatedTransition => {
  const transitionResult = collectIndexedTransition(
    machine,
    selection.transition.transition,
    selection.context,
    selection.transition.evaluate
  )
  const combined = isCombinedTarget(transitionResult.state) ? transitionResult.state : undefined
  const transitionState = combined?.target ?? transitionResult.state
  const stateUpdate = combined?.update ?? (isStateUpdate(transitionState) ? transitionState : undefined)
  const update = stateUpdate !== undefined
    ? (() => {
      const index = descriptor.indexByPath.get(stateUpdate.path)
      const node = index === undefined ? undefined : descriptor.nodes[index]
      if (
        index === undefined || node === undefined || state.active[index] !== 1 || node.schema === undefined
      ) {
        throw new Error(
          `Machine state update owner "${stateUpdate.path}" must be an active valued state`
        )
      }
      return {
        path: node.path,
        value: decodeStateValueSync(machine, node, stateUpdate.value)
      }
    })()
    : undefined
  const unresolvedTarget = transitionState === undefined || isStateUpdate(transitionState) ? undefined : transitionState
  validateDeclaredTransitionTarget(
    selection.sourcePath,
    selection.trigger,
    selection.transition.targets,
    unresolvedTarget
  )
  const initialTarget = unresolvedTarget !== undefined && isInitialTarget(unresolvedTarget)
    ? unresolvedTarget
    : undefined
  const initialResolution = initialTarget === undefined
    ? undefined
    : resolveInitialTarget(
      machine,
      (() => {
        const current = activeConfigurationFromIndexedState(descriptor, state)
        return update === undefined
          ? current
          : { ...current, values: new Map(current.values).set(update.path, update.value) }
      })(),
      initialTarget,
      selection.context.event
    )
  const target = initialResolution?.target ?? unresolvedTarget
  if (target !== undefined && !isTarget(target) && !isSnapshot(target)) {
    throw new Error("Machine expected indexed transition target to be a snapshot or target builder result")
  }
  // Without an initial target, the validated target is the returned target.
  const retainedTarget = initialTarget ?? target
  // The shared initial-target resolver decodes raised events but erases their type.
  const initialRaisedEvents = (initialResolution?.raisedEvents ?? emptyExecutionValues) as ReadonlyArray<IndexedEvent>
  let next = target === undefined
    ? update === undefined ? state : (() => {
      const next = copyIndexedState(state)
      next.values[descriptor.indexByPath.get(update.path)!] = update.value
      return next
    })()
    : normalizeIndexedTargetStateSync(machine, descriptor, state, target, selection.leafIndex)
  if (combined !== undefined && update !== undefined) {
    const ownerIndex = descriptor.indexByPath.get(update.path)!
    if (next.active[ownerIndex] !== 1) {
      throw new Error(`Machine combined target exited its updating owner "${update.path}"`)
    }
    const values = next.values.slice()
    values[ownerIndex] = update.value
    next = { ...next, values }
  }
  const changed = selection.transition.reenter || !hasSameIndexedActive(state, next)
  const stabilize = changed || update !== undefined
  if (!changed) {
    return {
      selection,
      branchIndex: transitionResult.branchIndex,
      branchKey: transitionResult.branchKey,
      unresolvedTarget: retainedTarget,
      target,
      update,
      next,
      commands: [...transitionResult.commands, ...(initialResolution?.commands ?? [])],
      raisedEvents: [...transitionResult.raisedEvents, ...initialRaisedEvents],
      emittedEvents: [...transitionResult.emittedEvents, ...(initialResolution?.emittedEvents ?? [])],
      changed: false,
      stabilize,
      exitPaths: [],
      entryPaths: [],
      choiceTransitions: initialResolution?.transitions ?? []
    }
  }

  const targetPath = target === undefined ? undefined : getTargetNodePath(target)
  const naturalBoundary = targetPath === undefined
    ? descriptor.nodes[selection.sourceIndex]!.parent
    : getLeastCommonAncestor(machine, selection.leafPath, targetPath)
  const reentryBoundary = descriptor.nodes[selection.sourceIndex]!.parent
  const boundary = selection.transition.reenter
    ? broadenTransitionBoundary(naturalBoundary, reentryBoundary)
    : naturalBoundary
  return {
    selection,
    branchIndex: transitionResult.branchIndex,
    branchKey: transitionResult.branchKey,
    unresolvedTarget: retainedTarget,
    target,
    update,
    next,
    commands: [...transitionResult.commands, ...(initialResolution?.commands ?? [])],
    raisedEvents: [...transitionResult.raisedEvents, ...initialRaisedEvents],
    emittedEvents: [...transitionResult.emittedEvents, ...(initialResolution?.emittedEvents ?? [])],
    changed: true,
    stabilize,
    exitPaths: getExitPaths(machine, activeConfigurationFromIndexedState(descriptor, state), boundary),
    entryPaths: getEntryPaths(machine, activeConfigurationFromIndexedState(descriptor, next), boundary),
    choiceTransitions: initialResolution?.transitions ?? []
  }
}

/** Indexed microsteps keep decoded raised events typed for the next dispatch. */
type IndexedMicrostep = ExecutionMicrostep<IndexedExecutionState> & {
  readonly raisedEvents: ReadonlyArray<IndexedEvent>
}

const retainIndexedTransition = (transition: IndexedEvaluatedTransition): Machine.RetainedTransition => ({
  source: transition.selection.sourcePath,
  trigger: transition.selection.trigger,
  reenter: transition.selection.transition.reenter,
  branchIndex: transition.branchIndex,
  branchKey: transition.branchKey,
  target: transition.unresolvedTarget === undefined ? undefined : getTargetNodePath(transition.unresolvedTarget),
  resolvedTarget: transition.target === undefined ? undefined : getTargetNodePath(transition.target),
  updates: transition.update === undefined ? [] : [transition.update.path]
})

/**
 * A retained microstep of the hierarchical kernel. It builds its retained
 * transitions on first read, from evaluated transitions that hold only values
 * no later plan writes.
 */
class RetainedHierarchicalMicrostep implements IndexedMicrostep {
  #evaluated: ReadonlyArray<IndexedEvaluatedTransition> | undefined
  #transitions: ReadonlyArray<Machine.RetainedTransition> | undefined

  constructor(
    readonly next: IndexedExecutionState,
    readonly event: IndexedEvent,
    evaluated: ReadonlyArray<IndexedEvaluatedTransition>,
    readonly commands: ReadonlyArray<RuntimeCommand>,
    readonly raisedEvents: ReadonlyArray<IndexedEvent>,
    readonly emittedEvents: ReadonlyArray<unknown>,
    readonly exitPaths: ReadonlyArray<string>,
    readonly entryPaths: ReadonlyArray<string>,
    readonly changed: boolean
  ) {
    this.#evaluated = evaluated
  }

  get transitions(): ReadonlyArray<Machine.RetainedTransition> {
    if (this.#transitions === undefined) {
      this.#transitions = this.#evaluated!.map(retainIndexedTransition)
      this.#evaluated = undefined
    }
    return this.#transitions
  }
}

/**
 * A retained microstep of the flat kernel, which builds its one retained
 * transition on first read.
 */
class RetainedFlatMicrostep implements IndexedMicrostep {
  readonly #source: string
  readonly #reenter: boolean
  readonly #branchIndex: number
  readonly #branchKey: string | undefined
  readonly #target: Machine.Target<any, any> | Machine.Snapshot<any> | undefined
  readonly #update: { readonly path: string } | undefined
  #transitions: ReadonlyArray<Machine.RetainedTransition> | undefined

  constructor(
    readonly next: IndexedExecutionState,
    readonly event: IndexedEvent,
    readonly commands: ReadonlyArray<RuntimeCommand>,
    readonly raisedEvents: ReadonlyArray<IndexedEvent>,
    readonly emittedEvents: ReadonlyArray<unknown>,
    readonly exitPaths: ReadonlyArray<string>,
    readonly entryPaths: ReadonlyArray<string>,
    readonly changed: boolean,
    source: string,
    reenter: boolean,
    branchIndex: number,
    branchKey: string | undefined,
    target: Machine.Target<any, any> | Machine.Snapshot<any> | undefined,
    update: { readonly path: string } | undefined
  ) {
    this.#source = source
    this.#reenter = reenter
    this.#branchIndex = branchIndex
    this.#branchKey = branchKey
    this.#target = target
    this.#update = update
  }

  get transitions(): ReadonlyArray<Machine.RetainedTransition> {
    if (this.#transitions === undefined) {
      const target = this.#target === undefined ? undefined : getTargetNodePath(this.#target)
      this.#transitions = [{
        source: this.#source,
        trigger: { type: "event", event: this.event._tag },
        reenter: this.#reenter,
        branchIndex: this.#branchIndex,
        branchKey: this.#branchKey,
        target,
        resolvedTarget: target,
        updates: this.#update === undefined ? [] : [this.#update.path]
      }]
    }
    return this.#transitions
  }
}

const indexedMicrostep = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  state: IndexedExecutionState,
  event: IndexedEvent,
  selections: ReadonlyArray<IndexedSelectedTransition>,
  retainTransitions: boolean
): IndexedMicrostep => {
  if (selections.length === 1) {
    const transition = collectIndexedEvaluatedTransition(machine, descriptor, state, selections[0]!)
    return retainTransitions
      ? new RetainedHierarchicalMicrostep(
        transition.next,
        event,
        [transition],
        transition.commands,
        transition.raisedEvents,
        transition.emittedEvents,
        transition.exitPaths,
        transition.entryPaths,
        transition.changed
      )
      : {
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
  const transitions = sortEvaluatedTransitions(machine, removeConflictingTransitions(machine, evaluated))

  let next = state
  if (transitions.length === 1) {
    next = transitions[0]!.next
  } else {
    for (const transition of transitions) {
      if (transition.update !== undefined) {
        const values = next.values.slice()
        values[descriptor.indexByPath.get(transition.update.path)!] = transition.update.value
        next = { ...next, values }
      }
    }
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
  const exitPaths = changed ? sortExitPaths(machine, transitions.flatMap((transition) => transition.exitPaths)) : []
  const entryPaths = changed ? sortEntryPaths(machine, transitions.flatMap((transition) => transition.entryPaths)) : []
  return retainTransitions
    ? new RetainedHierarchicalMicrostep(
      next,
      event,
      transitions,
      commands,
      raisedEvents,
      emittedEvents,
      exitPaths,
      entryPaths,
      changed
    )
    : { next, event, commands, raisedEvents, emittedEvents, exitPaths, entryPaths, changed }
}

const planIndexedFlatState = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedExecutionState,
  decoded: IndexedEvent,
  retainMicrosteps: boolean,
  ownership: ExecutionOwnership,
  machineReferences?: PlanningMachineReferences
): ExecutionMacrostep<IndexedExecutionState> => {
  let current = configuration
  let event: IndexedEvent = decoded
  let commands: Array<RuntimeCommand> | undefined
  let raisedEvents: Array<IndexedEvent> | undefined
  let emittedEvents: Array<unknown> | undefined
  let microsteps: Array<ExecutionMicrostep<IndexedExecutionState>> | undefined
  let raisedIndex = 0
  let iterations = 0
  // Whether `current` may be written in place, because nothing but this plan
  // references it. A persistent caller's state, and the state of a retained
  // microstep, are copied before they would be written.
  let writable = ownership === "Owned"
  // The value that this plan overwrote in an owned caller's state, so that a
  // plan that throws leaves that state as it was. Only the active leaf is
  // written, and the leaf of the caller's state stays active while `current`
  // is that state, so one value is all a plan overwrites in it.
  let restoreIndex = -1
  let restoreValue: unknown

  try {
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
          event: decoded,
          next: indexedStateFromActive(descriptor, completed),
          commands: commands ?? emptyExecutionValues,
          emittedEvents: emittedEvents ?? emptyExecutionValues,
          microsteps: microsteps ?? emptyExecutionValues,
          done: true,
          output: completed.outputs.get(root)
        }
      }

      const sourcePath = descriptor.nodes[sourceIndex]!.path
      const transition = normalizeTransition(toImpl(machine).handlers[sourcePath]?.on?.[event._tag])
      if (transition !== undefined) {
        const transitionResult = collectIndexedTransition(
          machine,
          transition.transition,
          {
            ...resolveMachineReferences(machine, machineReferences),
            state: current.values[sourceIndex],
            containingState: undefined,
            ancestors: {},
            event,
            snapshot: snapshotFromIndexedState(descriptor, current)
          },
          transition.evaluate
        )
        const update = isStateUpdate(transitionResult.state) ? transitionResult.state : undefined
        const target = update === undefined ? transitionResult.state : undefined
        // The new value of the source state, when this microstep keeps it active.
        let value: unknown = noIndexedValue
        if (update !== undefined) {
          const node = descriptor.nodes[sourceIndex]!
          if (update.path !== sourcePath || node.schema === undefined) {
            throw new Error(`Machine state update owner "${update.path}" must be the active valued state`)
          }
          value = decodeStateValueSync(machine, node, update.value)
        }
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
            ? (target as TargetSnapshotSlot)[TargetSnapshotTypeId] === undefined && target.values === undefined
            : !("state" in target) && !("states" in target) && !("completed" in target) && !("history" in target)
          if (
            targetIndex === sourceIndex && isSimpleTarget && current.completedOrder.length === 0 &&
            descriptor.valued[sourceIndex]
          ) {
            value = decodeStateValueSync(machine, descriptor.nodes[sourceIndex]!, target.value)
          } else {
            next = normalizeIndexedTargetStateSync(machine, descriptor, current, target, sourceIndex)
          }
        }
        if (value !== noIndexedValue) {
          if (!writable) {
            current = withWritableIndexedValues(current)
            writable = true
          } else if (current === configuration && restoreIndex === -1) {
            restoreIndex = sourceIndex
            restoreValue = configuration.values[sourceIndex]
          }
          current.values[sourceIndex] = value
          next = current
        }
        const changed = transition.reenter || !hasSameIndexedActive(current, next)
        const nextIndex = next.activeLeaves[0]
        if (nextIndex === undefined) {
          throw new Error("Machine expected an active indexed transition target")
        }
        const exitPaths = changed ? [sourcePath] : emptyExecutionValues
        const entryPaths = changed ? [descriptor.nodes[nextIndex]!.path] : emptyExecutionValues
        const step: ExecutionMicrostep<IndexedExecutionState> = retainMicrosteps
          ? new RetainedFlatMicrostep(
            next,
            event,
            transitionResult.commands,
            transitionResult.raisedEvents,
            transitionResult.emittedEvents,
            exitPaths,
            entryPaths,
            changed,
            sourcePath,
            transition.reenter,
            transitionResult.branchIndex,
            transitionResult.branchKey,
            target,
            update
          )
          : {
            next,
            event,
            commands: transitionResult.commands,
            raisedEvents: transitionResult.raisedEvents,
            emittedEvents: transitionResult.emittedEvents,
            exitPaths,
            entryPaths,
            changed
          }
        // A state that this microstep created is referenced by nothing else,
        // unless the microstep is retained.
        if (next !== current) writable = true
        current = next
        if (retainMicrosteps) writable = false
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
          event: decoded,
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
  } catch (error) {
    if (restoreIndex !== -1) configuration.values[restoreIndex] = restoreValue
    throw error
  }
}

const planIndexedState = (
  machine: Machine.Any,
  descriptor: IndexedExecutionDescriptor,
  configuration: IndexedExecutionState,
  input: unknown,
  decode: boolean,
  retainMicrosteps: boolean,
  ownership: ExecutionOwnership,
  machineReferences?: PlanningMachineReferences
): ExecutionMacrostep<IndexedExecutionState> => {
  if (InvocationEvent.isInvocationEvent(input)) {
    // Invocation lifecycle transitions retain the generic planner as their
    // semantic reference. Ordinary machine events and initialization stay on
    // the indexed representation; only the private lifecycle macrostep crosses
    // the representation boundary.
    const planned = planConfiguration(
      machine,
      machineReferences === undefined
        ? activeConfigurationFromIndexedState(descriptor, configuration)
        : withMachineReferences(activeConfigurationFromIndexedState(descriptor, configuration), machineReferences),
      input
    )
    return {
      event: planned.event,
      next: indexedStateFromActive(descriptor, planned.next),
      commands: planned.commands,
      emittedEvents: planned.emittedEvents,
      microsteps: planned.microsteps.map((step) => ({
        next: indexedStateFromActive(descriptor, step.next),
        event: step.event,
        transitions: step.transitions,
        commands: step.commands,
        raisedEvents: step.raisedEvents,
        emittedEvents: step.emittedEvents,
        exitPaths: step.exitPaths,
        entryPaths: step.entryPaths,
        changed: step.changed
      })),
      done: planned.done,
      output: planned.output
    }
  }
  const decoded: IndexedEvent = decode ? decodeEventSync(machine, input) : input as IndexedEvent
  if (descriptor.flat) {
    return planIndexedFlatState(
      machine,
      descriptor,
      configuration,
      decoded,
      retainMicrosteps,
      ownership,
      machineReferences
    )
  }
  // The hierarchical kernel never writes a state in place, so it plans every
  // ownership alike.
  if (descriptor.finalIndices.some((index) => configuration.active[index] === 1)) {
    const active = activeConfigurationFromIndexedState(descriptor, configuration)
    if (isActiveFinalConfiguration(machine, active)) {
      const completed = completeConfigurationSync(machine, active, decoded).configuration
      const root = getRootPath(machine, completed)
      if (!completed.outputs.has(root)) {
        throw new Error("Machine reached a terminal indexed configuration without a completed root output")
      }
      return {
        event: decoded,
        next: indexedStateFromActive(descriptor, completed),
        commands: [],
        emittedEvents: [],
        microsteps: [],
        done: true,
        output: completed.outputs.get(root)
      }
    }
  }

  const selections = selectIndexedEventTransitions(machine, descriptor, configuration, decoded, machineReferences)
  if (selections.length === 0) {
    return {
      event: decoded,
      next: configuration,
      commands: [],
      emittedEvents: [],
      microsteps: [],
      done: false,
      output: undefined
    }
  }

  const first = indexedMicrostep(machine, descriptor, configuration, decoded, selections, retainMicrosteps)
  let current = first.next
  let currentEvent: IndexedEvent = decoded
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
      current = indexedStateFromActive(descriptor, completed)
      if (isActiveFinalConfiguration(machine, completed)) {
        const root = getRootPath(machine, completed)
        if (!completed.outputs.has(root)) {
          throw new Error("Machine reached a terminal indexed configuration without a completed root output")
        }
        return {
          event: decoded,
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
        event: decoded,
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
    const raisedSelections = selectIndexedEventTransitions(machine, descriptor, current, raised, machineReferences)
    if (raisedSelections.length === 0) continue
    const step = indexedMicrostep(machine, descriptor, current, raised, raisedSelections, retainMicrosteps)
    current = step.next
    commands.push(...step.commands)
    raisedEvents.push(...step.raisedEvents)
    emittedEvents.push(...step.emittedEvents)
    microsteps.push(step)
  }
}

/**
 * A machine compiled for planning, with an execution state of its own.
 *
 * `plan` takes the {@link ExecutionOwnership} of the state it receives. With
 * `retainMicrosteps`, each microstep keeps its retained transitions, and its
 * `next` stays readable for as long as that ownership keeps what a plan returns
 * valid. Without it, a microstep's `next` may have been written by a later
 * microstep of the same plan, and only its paths and `changed` are meaningful.
 */
export interface CompiledExecutionPlan {
  readonly fromConfiguration: (configuration: ActiveConfiguration) => unknown
  readonly toConfiguration: (state: unknown) => ActiveConfiguration
  readonly snapshot: (state: unknown) => Machine.Snapshot<any>
  readonly plan: (
    state: unknown,
    event: unknown,
    ownership: ExecutionOwnership,
    retainMicrosteps: boolean,
    machineReferences?: PlanningMachineReferences
  ) => ExecutionMacrostep
  /**
   * Plans an event that needs no decoding: a public event that
   * `decodeEventSync` returned, or an invocation event. Otherwise as `plan`.
   */
  readonly planDecoded: (
    state: unknown,
    event: Machine.EventOf<any> | InvocationEvent.InvocationEvent,
    ownership: ExecutionOwnership,
    retainMicrosteps: boolean,
    machineReferences?: PlanningMachineReferences
  ) => ExecutionMacrostep
  readonly initial?: (
    args: ReadonlyArray<unknown>,
    machineReferences?: PlanningMachineReferences
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
  // The reference planner never writes a configuration in place.
  plan: (state, event, _ownership, _retainMicrosteps, machineReferences) =>
    planConfiguration(
      machine,
      machineReferences === undefined
        ? state as ActiveConfiguration
        : withMachineReferences(state as ActiveConfiguration, machineReferences),
      event as Machine.EventOf<any>
    ),
  planDecoded: (state, event, _ownership, _retainMicrosteps, machineReferences) =>
    planDecodedConfiguration(
      machine,
      machineReferences === undefined
        ? state as ActiveConfiguration
        : withMachineReferences(state as ActiveConfiguration, machineReferences),
      event
    )
})

const makeIndexedExecutionPlan = (
  machine: Machine.Any,
  indexed: IndexedExecutionDescriptor
): CompiledExecutionPlan => ({
  fromConfiguration: (configuration) => indexedStateFromActive(indexed, configuration),
  toConfiguration: (state) => activeConfigurationFromIndexedState(indexed, state as IndexedExecutionState),
  snapshot: (state) => snapshotFromIndexedState(indexed, state as IndexedExecutionState),
  plan: (state, event, ownership, retainMicrosteps, machineReferences) =>
    planIndexedState(
      machine,
      indexed,
      state as IndexedExecutionState,
      event,
      true,
      retainMicrosteps,
      ownership,
      machineReferences
    ),
  planDecoded: (state, event, ownership, retainMicrosteps, machineReferences) =>
    planIndexedState(
      machine,
      indexed,
      state as IndexedExecutionState,
      event,
      false,
      retainMicrosteps,
      ownership,
      machineReferences
    ),
  // Only captured data constructors can use indexed startup. Unknown initializer
  // protocols retain generic startup so commands and emissions cannot be dropped.
  ...(Object.values(toImpl(machine).handlers as Record<string, CapturedStateConfig>).some((config) =>
      config.initialize !== undefined && !isDataInitializer(config.initialize)
    ) ?
    {} :
    {
      initial: (args: ReadonlyArray<unknown>, machineReferences?: PlanningMachineReferences) => {
        const inputArgs = machine.input === undefined
          ? args
          : args.length === 0
          ? (decodeInputSync(machine, machine.input, undefined), args)
          : [decodeInputSync(machine, machine.input, args[0])]
        const initial = toImpl(machine).initial(...inputArgs)
        const normalized = isInitialTarget(initial)
          ? resolveInitialConfiguration(
            machine,
            {
              active: new Set(),
              values: new Map(),
              outputs: new Map(),
              history: new Map(),
              ...(machineReferences === undefined ? {} : { machineReferences })
            },
            initial,
            InitialEvent
          ).configuration
          : normalizeConfigurationSync(machine, initial as Machine.Snapshot<any>)
        const active = machineReferences === undefined
          ? normalized
          : withMachineReferences(normalized, machineReferences)
        const completed = completeConfigurationSync(machine, active, InitialEvent).configuration
        const configuration = indexedStateFromActive(indexed, completed)
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
