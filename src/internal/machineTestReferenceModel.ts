/**
 * Independent hierarchical, parallel, and history statechart semantics for finite test
 * models.
 *
 * This module deliberately knows nothing about `Machine`, its snapshots, the
 * finite-model compiler, target builders, or planner internals. The actual
 * planner trace is treated as opaque data and projected structurally only at
 * the comparison boundary.
 *
 * @internal
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type {
  FiniteCompoundState,
  FiniteHistoryState,
  FiniteModel,
  FiniteState,
  FiniteTransition
} from "./machineTestFiniteModel.js"

/**
 * The deterministic value assigned to one active finite-model state.
 *
 * @category models
 * @since 4.0.0
 */
export interface ReferenceStateValue {
  readonly _tag: string
  readonly value: number
}

/**
 * One output retained for an actively completed state.
 *
 * @category models
 * @since 4.0.0
 */
export interface ReferenceCompletion {
  readonly path: string
  readonly output: string
}

/**
 * One independently captured shallow or deep history register.
 *
 * @category models
 * @since 4.0.0
 */
export interface ReferenceHistoryRecord {
  readonly mode: "shallow" | "deep"
  readonly active: ReadonlyArray<string>
  readonly values: Readonly<Record<string, ReferenceStateValue>>
}

/**
 * An independently interpreted finite-model configuration.
 *
 * @category models
 * @since 4.0.0
 */
export interface ReferenceState {
  /** Active ancestors and leaf in state-definition order. */
  readonly activePaths: ReadonlyArray<string>
  /** Deterministic state values keyed by active state path. */
  readonly values: Readonly<Record<string, ReferenceStateValue>>
  /** Completed final and compound paths in completion order. */
  readonly completions: ReadonlyArray<ReferenceCompletion>
  /** Logical history registers keyed by history pseudo-state path. */
  readonly history: Readonly<Record<string, ReferenceHistoryRecord>>
  readonly status: "active" | "done"
  readonly output: string | undefined
}

/**
 * One transition retained by the independent reference step.
 *
 * @category models
 * @since 4.0.0
 */
export interface ReferenceTransition {
  readonly source: string
  readonly trigger:
    | { readonly type: "event"; readonly event: string }
    | { readonly type: "choice" }
  readonly reenter: boolean
  readonly target: string | undefined
  readonly resolvedTarget: string | undefined
}

/**
 * The independently calculated planner microstep for one selected event.
 *
 * @category models
 * @since 4.0.0
 */
export interface ReferenceMicrostep {
  readonly next: ReferenceState
  readonly event: string
  readonly transitions: ReadonlyArray<ReferenceTransition>
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly changed: boolean
}

/**
 * Startup semantics calculated without executing the real machine.
 *
 * @category models
 * @since 4.0.0
 */
export interface ReferenceInitialStep {
  readonly startingState: ReferenceState
  readonly initialEntryPaths: ReadonlyArray<string>
  readonly state: ReferenceState
  readonly microsteps: ReadonlyArray<ReferenceMicrostep>
  readonly done: boolean
  readonly output: string | undefined
}

/**
 * One public event interpreted against a reference configuration.
 *
 * @category models
 * @since 4.0.0
 */
export interface ReferenceStep {
  readonly index: number
  readonly event: string
  readonly before: ReferenceState
  readonly microsteps: ReadonlyArray<ReferenceMicrostep>
  readonly after: ReferenceState
  readonly done: boolean
  readonly output: string | undefined
}

/**
 * A complete, pure interpretation of a finite model and event sequence.
 *
 * @category models
 * @since 4.0.0
 */
export interface ReferenceTrace {
  readonly events: ReadonlyArray<string>
  readonly initial: ReferenceInitialStep
  readonly steps: ReadonlyArray<ReferenceStep>
  readonly final: ReferenceState
}

/**
 * Location of one planner/reference disagreement.
 *
 * @category models
 * @since 4.0.0
 */
export interface ModelVerificationLocation {
  readonly phase: "initial" | "event" | "final"
  readonly eventIndex?: number
  readonly microstepIndex?: number
}

type ModelStateField =
  | "initial.startingState"
  | "initial.plan.startingState"
  | "initial.plan.state"
  | "step.before"
  | "microstep.next"
  | "step.plan.next"
  | "step.after"
  | "trace.final"

/**
 * Stable semantic observation compared by the finite-model oracle.
 *
 * @category models
 * @since 4.0.0
 */
export type ModelVerificationField =
  | `${ModelStateField}.${"activePaths" | "values" | "completions" | "history"}`
  | "event.tag"
  | "initial.startingConfiguration"
  | "initial.initialEntryPaths"
  | "initial.plan.initialEntryPaths"
  | "initial.configuration"
  | "initial.plan.microsteps"
  | "initial.plan.done"
  | "initial.plan.output"
  | "trace.steps.length"
  | "step.index"
  | "step.event"
  | "step.beforeConfiguration"
  | "step.plan.microsteps.length"
  | "microstep.event"
  | "microstep.transitions"
  | "microstep.exitPaths"
  | "microstep.entryPaths"
  | "microstep.changed"
  | "step.afterConfiguration"
  | "step.plan.done"
  | "step.plan.output"
  | "trace.finalConfiguration"

/**
 * One structured semantic disagreement with the independent interpreter.
 *
 * @category models
 * @since 4.0.0
 */
export interface ModelVerificationMismatch {
  readonly location: ModelVerificationLocation
  /** Stable dotted field identifying the compared observation. */
  readonly field: ModelVerificationField
  readonly expected: unknown
  readonly actual: unknown
  readonly message: string
}

/**
 * All semantic disagreements found for one finite-model trace.
 *
 * @category errors
 * @since 4.0.0
 */
export class ModelVerificationError extends Data.TaggedError("MachineTestModelVerificationError")<{
  readonly mismatches: ReadonlyArray<ModelVerificationMismatch>
}> {}

interface IndexedState {
  readonly node: FiniteState
  readonly path: string
  readonly parent: string | undefined
  readonly root: string
  readonly depth: number
  readonly order: number
  readonly children: ReadonlyArray<string>
}

interface ModelIndex {
  readonly ordered: ReadonlyArray<IndexedState>
  readonly byPath: ReadonlyMap<string, IndexedState>
  readonly transitions: ReadonlyMap<string, FiniteTransition>
  readonly histories: ReadonlyArray<IndexedState & { readonly node: FiniteHistoryState }>
}

const ControlOrder: unique symbol = Symbol("MachineTestReferenceControlOrder")

type InternalReferenceState = ReferenceState & {
  readonly [ControlOrder]: ReadonlyArray<string>
}

const withControlOrder = (
  state: ReferenceState,
  order: ReadonlyArray<string>
): InternalReferenceState => {
  Object.defineProperty(state, ControlOrder, { value: order.slice(), enumerable: false })
  return state as InternalReferenceState
}

const controlOrder = (state: ReferenceState): ReadonlyArray<string> =>
  ControlOrder in state ? (state as InternalReferenceState)[ControlOrder] : state.activePaths

const stateTag = (path: string): string => `State_${path.replaceAll(".", "_")}`

/**
 * Builds the oracle's own state index. This traversal intentionally duplicates
 * the structural work performed by the compiler instead of importing it.
 */
const indexModel = (model: FiniteModel): ModelIndex => {
  const ordered: Array<IndexedState> = []
  const visit = (
    states: ReadonlyArray<FiniteState>,
    parent: string | undefined,
    root: string | undefined,
    depth: number
  ): void => {
    for (const node of states) {
      const path = parent === undefined ? node.key : `${parent}.${node.key}`
      const nodeRoot = root ?? path
      ordered.push({
        node,
        path,
        parent,
        root: nodeRoot,
        depth,
        order: ordered.length,
        children: node._tag === "Compound" || node._tag === "Parallel"
          ? node.states.filter((child) => child._tag !== "History" && child._tag !== "Choice").map((child) =>
            `${path}.${child.key}`
          )
          : []
      })
      if (node._tag === "Compound" || node._tag === "Parallel") {
        visit(node.states, path, nodeRoot, depth + 1)
      }
    }
  }
  visit(model.roots, undefined, undefined, 1)
  const byPath = new Map(ordered.map((state) => [state.path, state]))
  const transitions = new Map(
    model.transitions.map((transition) => [`${transition.source}\u0000${transition.event}`, transition])
  )
  const histories = ordered.filter(
    (state): state is IndexedState & { readonly node: FiniteHistoryState } => state.node._tag === "History"
  )
  return { ordered, byPath, transitions, histories }
}

const getState = (index: ModelIndex, path: string): IndexedState => {
  const state = index.byPath.get(path)
  if (state === undefined) {
    throw new Error(`MachineTest.interpretModel received unknown state path "${path}"`)
  }
  return state
}

const activeValue = (state: IndexedState, value?: number): ReferenceStateValue => {
  if (state.node._tag === "History" || state.node._tag === "Choice") {
    throw new Error(`MachineTest.interpretModel cannot activate pseudo-state "${state.path}"`)
  }
  return { _tag: stateTag(state.path), value: value ?? state.node.value }
}

const applyTargetValue = (
  index: ModelIndex,
  state: ReferenceState,
  transition: FiniteTransition
): ReferenceState => {
  if (transition.targetValue === undefined || transition.target === undefined) return state
  const target = getState(index, transition.target)
  if (target.node._tag === "History" || !state.activePaths.includes(target.path)) return state
  return withControlOrder({
    ...state,
    values: { ...state.values, [target.path]: activeValue(target, transition.targetValue) }
  }, controlOrder(state))
}

const pathsToRoot = (index: ModelIndex, path: string): ReadonlyArray<string> => {
  const paths: Array<string> = []
  let current: IndexedState | undefined = getState(index, path)
  while (current !== undefined) {
    paths.unshift(current.path)
    current = current.parent === undefined ? undefined : getState(index, current.parent)
  }
  return paths
}

const initialChildPath = (state: IndexedState): string => {
  const node = state.node as FiniteCompoundState
  const child = node.states.find((candidate) => candidate.key === node.initial)
  if (child === undefined) {
    throw new Error(`MachineTest.interpretModel received unknown initial child "${node.initial}" for "${state.path}"`)
  }
  return `${state.path}.${child.key}`
}

const resolveChoicePath = (index: ModelIndex, path: string): string => {
  let current = getState(index, path)
  const seen = new Set<string>()
  while (current.node._tag === "Choice") {
    if (seen.has(current.path)) {
      throw new Error(`MachineTest.interpretModel received infinite choice loop at "${current.path}"`)
    }
    seen.add(current.path)
    current = getState(index, current.node.selected)
  }
  return current.path
}

const expandInitial = (index: ModelIndex, path: string): ReadonlyArray<string> => {
  const current = getState(index, path)
  if (current.node._tag === "Choice") return expandInitial(index, resolveChoicePath(index, current.path))
  if (current.node._tag === "Compound") {
    return [current.path, ...expandInitial(index, initialChildPath(current))]
  }
  if (current.node._tag === "Parallel") {
    return [
      current.path,
      ...current.children.flatMap((child) => expandInitial(index, child))
    ]
  }
  return [current.path]
}

const makeUnsettledState = (index: ModelIndex, target: string): ReferenceState => {
  const activePaths = [...pathsToRoot(index, target).slice(0, -1), ...expandInitial(index, target)]
  const values: Record<string, ReferenceStateValue> = {}
  for (const path of activePaths) {
    values[path] = activeValue(getState(index, path))
  }
  return withControlOrder({
    activePaths,
    values,
    completions: [],
    history: {},
    status: "active",
    output: undefined
  }, activePaths)
}

const directActiveChild = (
  index: ModelIndex,
  state: ReferenceState,
  parent: string
): IndexedState | undefined => {
  const parentState = getState(index, parent)
  return parentState.children
    .map((path) => getState(index, path))
    .find((child) => state.activePaths.includes(child.path))
}

const settleCompletions = (index: ModelIndex, state: ReferenceState): ReferenceState => {
  const completions = [...state.completions]
  const outputs = new Map(completions.map((completion) => [completion.path, completion.output]))
  const complete = (path: string): string | undefined => {
    if (outputs.has(path)) return outputs.get(path)
    const current = getState(index, path)
    let output: string | undefined
    if (current.node._tag === "Final") {
      output = current.node.output
    } else if (current.node._tag === "Compound") {
      const child = directActiveChild(index, state, current.path)
      if (child?.node._tag !== "Final") return undefined
      output = complete(child.path)
    } else if (current.node._tag === "Parallel") {
      for (const childPath of current.children) {
        if (!state.activePaths.includes(childPath) || complete(childPath) === undefined) {
          return undefined
        }
      }
      output = current.node.output
    }
    if (output !== undefined) {
      outputs.set(path, output)
      completions.push({ path, output })
    }
    return output
  }
  const deepestFirst = state.activePaths.slice().sort((left, right) => {
    const leftState = getState(index, left)
    const rightState = getState(index, right)
    return rightState.depth - leftState.depth || leftState.order - rightState.order
  })

  for (const path of deepestFirst) {
    complete(path)
  }

  const root = state.activePaths.find((path) => getState(index, path).parent === undefined)
  const output = root === undefined ? undefined : outputs.get(root)
  return withControlOrder({
    ...state,
    completions,
    status: output === undefined ? "active" : "done",
    output
  }, controlOrder(state))
}

const samePaths = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((path, index) => path === right[index])

const leastCommonAncestor = (index: ModelIndex, left: string, right: string): string | undefined => {
  const leftPaths = pathsToRoot(index, left)
  const rightPaths = pathsToRoot(index, right)
  let result: string | undefined
  for (let position = 0; position < Math.min(leftPaths.length, rightPaths.length); position++) {
    if (leftPaths[position] !== rightPaths[position]) break
    result = leftPaths[position]
  }
  return result
}

const isDescendant = (index: ModelIndex, path: string, ancestor: string): boolean => {
  let parent = getState(index, path).parent
  while (parent !== undefined) {
    if (parent === ancestor) return true
    parent = getState(index, parent).parent
  }
  return false
}

const broadenBoundary = (
  index: ModelIndex,
  natural: string | undefined,
  reentry: string | undefined
): string | undefined => {
  if (natural === undefined || reentry === undefined) return undefined
  return natural === reentry || isDescendant(index, natural, reentry) ? reentry : natural
}

const lifecyclePaths = (
  index: ModelIndex,
  activePaths: ReadonlyArray<string>,
  boundary: string | undefined,
  direction: "entry" | "exit"
): ReadonlyArray<string> =>
  activePaths
    .filter((path) => boundary === undefined || isDescendant(index, path, boundary))
    .sort((left, right) => {
      const leftState = getState(index, left)
      const rightState = getState(index, right)
      const depth = direction === "entry"
        ? leftState.depth - rightState.depth
        : rightState.depth - leftState.depth
      if (depth !== 0) return depth
      return direction === "entry"
        ? leftState.order - rightState.order
        : rightState.order - leftState.order
    })

interface SelectedTransition {
  readonly transition: FiniteTransition
  readonly leaf: string
}

interface EvaluatedTransition extends SelectedTransition {
  readonly next: ReferenceState
  readonly targetPath: string | undefined
  readonly changed: boolean
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
}

const activeLeaves = (index: ModelIndex, state: ReferenceState): ReadonlyArray<string> =>
  state.activePaths.filter((path) => {
    const current = getState(index, path)
    return current.children.every((child) => !state.activePaths.includes(child))
  })

const selectTransitions = (
  index: ModelIndex,
  state: ReferenceState,
  event: string
): ReadonlyArray<SelectedTransition> => {
  const selections: Array<SelectedTransition> = []
  const selectedSources = new Set<string>()
  for (const leaf of activeLeaves(index, state)) {
    const candidates = pathsToRoot(index, leaf).slice().reverse()
    for (const source of candidates) {
      const transition = index.transitions.get(`${source}\u0000${event}`)
      if (transition === undefined) continue
      if (!selectedSources.has(source)) {
        selectedSources.add(source)
        selections.push({ transition, leaf })
      }
      break
    }
  }
  return selections.filter(({ transition }) =>
    !selections.some(({ transition: other }) =>
      other.source !== transition.source && isDescendant(index, other.source, transition.source)
    )
  )
}

const runtimeTargetPath = (index: ModelIndex, transition: FiniteTransition): string | undefined => {
  if (transition.target === undefined) return undefined
  const source = getState(index, transition.source)
  const target = getState(index, transition.target)
  if (target.node._tag === "History") return target.parent
  if (target.node._tag === "Choice") {
    return runtimeTargetPath(index, { ...transition, target: resolveChoicePath(index, target.path) })
  }
  // A same-root branch builder identifies the concrete initialized leaf. A
  // full builder replaces the root with a complete snapshot and identifies
  // that snapshot's root even when it contains initialized descendants.
  if (source.root !== target.root) return target.path

  const initial = (path: string): string => {
    const current = getState(index, path)
    if (current.node._tag === "Parallel") {
      if (transition.source !== current.path && !transition.source.startsWith(`${current.path}.`)) {
        return current.path
      }
      const child = transition.source === current.path
        ? current.children[0]!
        : current.children.find((candidate) => isPathInSubtree(transition.source, candidate))!
      return initial(child)
    }
    return current.node._tag === "Compound" ? initial(initialChildPath(current)) : current.path
  }
  const inspect = (path: string): string => {
    const current = getState(index, path)
    if (
      current.node._tag === "Parallel" && transition.source !== current.path &&
      !transition.source.startsWith(`${current.path}.`)
    ) {
      return current.path
    }
    if (current.path === target.path) return initial(current.path)
    const next = target.path.slice(current.path.length + 1).split(".")[0]!
    return inspect(`${current.path}.${next}`)
  }
  return inspect(source.root)
}

const entryChoicePath = (index: ModelIndex, path: string): string | undefined => {
  const state = getState(index, path)
  if (state.node._tag === "Choice") return state.path
  if (state.node._tag === "Compound") {
    return entryChoicePath(index, `${state.path}.${state.node.initial}`)
  }
  if (state.node._tag === "Parallel") {
    for (const child of state.children) {
      const choice = entryChoicePath(index, child)
      if (choice !== undefined) return choice
    }
  }
  return undefined
}

const choiceResolvedTargetPath = (index: ModelIndex, path: string): string => {
  const choice = getState(index, path)
  if (choice.node._tag !== "Choice") return choice.path
  const selected = getState(index, choice.node.selected)
  if (selected.node._tag === "Choice") return choiceResolvedTargetPath(index, selected.path)
  return runtimeTargetPath(index, {
    source: choice.path,
    event: "__choice__",
    target: selected.path,
    reenter: false
  })!
}

const isPathInSubtree = (path: string, root: string): boolean => path === root || path.startsWith(`${root}.`)

const expandSelection = (
  index: ModelIndex,
  path: string,
  requested: string
): ReadonlyArray<string> => {
  const current = getState(index, path)
  if (current.node._tag === "History") return []
  if (current.node._tag === "Compound") {
    const selected = current.children.find((child) => isPathInSubtree(requested, child)) ?? initialChildPath(current)
    return [current.path, ...expandSelection(index, selected, requested)]
  }
  if (current.node._tag === "Parallel") {
    return [
      current.path,
      ...current.children.flatMap((child) =>
        expandSelection(index, child, isPathInSubtree(requested, child) ? requested : child)
      )
    ]
  }
  return [current.path]
}

const makeHistoryConfiguration = (
  index: ModelIndex,
  current: ReferenceState,
  owner: string,
  activePaths: ReadonlyArray<string>,
  rememberedValues: Readonly<Record<string, ReferenceStateValue>>,
  history: Readonly<Record<string, ReferenceHistoryRecord>>
): ReferenceState => {
  const active = new Set(activePaths)
  const ownerAncestors = pathsToRoot(index, owner)
  const ownerAncestry = new Set(ownerAncestors)

  // Parallel ancestors outside the owner retain active sibling regions. When
  // the owner belongs to an inactive root, those regions follow initial entry.
  for (const ancestorPath of ownerAncestors) {
    const ancestor = getState(index, ancestorPath)
    if (ancestor.node._tag !== "Parallel") continue
    const selectedRegion = ancestor.children.find((child) => ownerAncestry.has(child))
    for (const region of ancestor.children) {
      if (region === selectedRegion || active.has(region)) continue
      const retained = current.activePaths.filter((path) => isPathInSubtree(path, region))
      for (const path of retained.length === 0 ? expandInitial(index, region) : retained) active.add(path)
    }
  }

  const ordered = index.ordered
    .filter(({ node, path }) => node._tag !== "History" && node._tag !== "Choice" && active.has(path))
    .map(({ path }) => path)
  const values: Record<string, ReferenceStateValue> = {}
  for (const path of ordered) {
    values[path] = rememberedValues[path] ?? current.values[path] ?? activeValue(getState(index, path))
  }
  const completions = current.completions.filter(({ path }) => active.has(path) && !isPathInSubtree(path, owner))
  return withControlOrder({
    activePaths: ordered,
    values,
    completions,
    history,
    status: "active",
    output: undefined
  }, ordered)
}

const captureHistory = (
  index: ModelIndex,
  current: ReferenceState,
  next: ReferenceState,
  exitPaths: ReadonlyArray<string>
): ReferenceState => {
  if (exitPaths.length === 0) return next
  const exited = new Set(exitPaths)
  const history: Record<string, ReferenceHistoryRecord> = { ...next.history }
  for (const state of index.histories) {
    const owner = state.parent!
    if (!exited.has(owner)) continue
    const active = current.activePaths.filter((path) =>
      pathsToRoot(index, owner).includes(path) || path === owner ||
      (state.node.history === "deep"
        ? isPathInSubtree(path, owner)
        : getState(index, path).parent === owner)
    )
    const values: Record<string, ReferenceStateValue> = {}
    for (const path of active) values[path] = current.values[path]!
    history[state.path] = {
      mode: state.node.history,
      active,
      values
    }
  }
  return withControlOrder({ ...next, history }, controlOrder(next))
}

const restoreHistory = (
  index: ModelIndex,
  current: ReferenceState,
  historyState: IndexedState & { readonly node: FiniteHistoryState }
): ReferenceState => {
  const owner = historyState.parent!
  const record = current.history[historyState.path]
  if (record === undefined) {
    const active = [
      ...pathsToRoot(index, owner).slice(0, -1),
      ...expandSelection(index, owner, historyState.node.fallback)
    ]
    const values: Record<string, ReferenceStateValue> = {}
    for (const path of active) values[path] = activeValue(getState(index, path))
    return makeHistoryConfiguration(index, current, owner, active, values, current.history)
  }

  const active = new Set(record.active)
  if (record.mode === "shallow") {
    for (const child of getState(index, owner).children) {
      if (!active.has(child)) continue
      for (const path of expandInitial(index, child).slice(1)) active.add(path)
    }
  }
  return makeHistoryConfiguration(index, current, owner, Array.from(active), record.values, current.history)
}

const resolveHistoryState = (
  index: ModelIndex,
  before: ReferenceState,
  transition: FiniteTransition,
  leaf: string
): ReferenceState => {
  const historyState = getState(index, transition.target!) as IndexedState & { readonly node: FiniteHistoryState }
  const owner = historyState.parent!
  const reenteredOwner = transition.reenter && before.activePaths.includes(owner)
  const provisionalBoundary = transition.reenter
    ? getState(index, transition.source).parent
    : leastCommonAncestor(index, leaf, owner)
  const provisionalExitPaths = reenteredOwner
    ? lifecyclePaths(
      index,
      before.activePaths.filter((path) => isPathInSubtree(path, owner)),
      undefined,
      "exit"
    )
    : lifecyclePaths(index, before.activePaths, provisionalBoundary, "exit")
  const stateAtResolution = provisionalExitPaths.includes(owner)
    ? captureHistory(index, before, before, provisionalExitPaths)
    : before
  return restoreHistory(index, stateAtResolution, historyState)
}

const targetState = (
  index: ModelIndex,
  before: ReferenceState,
  transition: FiniteTransition,
  leaf: string = transition.source
): ReferenceState => {
  if (transition.target === undefined) return before
  const source = getState(index, transition.source)
  const target = getState(index, transition.target)
  if (target.node._tag === "Choice") {
    return targetState(index, before, { ...transition, target: resolveChoicePath(index, target.path) }, leaf)
  }
  if (target.node._tag === "History") return resolveHistoryState(index, before, transition, leaf)
  if (source.root !== target.root) {
    const unsettled = makeUnsettledState(index, target.path)
    return applyTargetValue(
      index,
      withControlOrder({ ...unsettled, history: before.history }, controlOrder(unsettled)),
      transition
    )
  }

  const actualTarget = runtimeTargetPath(index, transition)!
  const actualNode = getState(index, actualTarget)
  // A returned parallel target is an upper bound carrying a complete nested
  // snapshot: retain the more specific declared descendant for that snapshot.
  // Conversely, a branch target may resolve a declared compound/parallel
  // ancestor to the concrete initialized leaf selected inside the source
  // region. In both cases the deeper path describes the control change.
  const configurationTarget = actualNode.depth >= target.depth ? actualTarget : target.path
  const active = new Set<string>([
    ...pathsToRoot(index, configurationTarget).slice(0, -1),
    ...expandInitial(index, configurationTarget)
  ])
  const retainedValuePaths = new Set(
    pathsToRoot(index, configurationTarget)
      .slice(0, -1)
      .filter((path) => before.activePaths.includes(path))
  )
  const retainedCompletionPaths: Array<string> = []
  const order: Array<string> = actualNode.node._tag === "Parallel"
    ? [
      ...index.ordered
        .filter(({ path }) => active.has(path) && isPathInSubtree(path, actualTarget))
        .map(({ path }) => path),
      ...pathsToRoot(index, actualTarget).slice(0, -1)
    ]
    : pathsToRoot(index, actualTarget).slice()
  const targetAncestors = pathsToRoot(index, configurationTarget)
  for (const ancestorPath of targetAncestors) {
    const ancestor = getState(index, ancestorPath)
    if (ancestor.node._tag !== "Parallel") continue
    const selectedRegion = ancestor.children.find((child) => isPathInSubtree(configurationTarget, child))
    const sourceInside = transition.source === ancestor.path || transition.source.startsWith(`${ancestor.path}.`)
    for (const region of ancestor.children) {
      if (region === selectedRegion) continue
      if (sourceInside && before.activePaths.includes(region)) {
        for (const path of controlOrder(before)) {
          if (isPathInSubtree(path, region)) {
            active.add(path)
            retainedValuePaths.add(path)
            if (!order.includes(path)) order.push(path)
            if (
              before.completions.some((completion) => completion.path === path) &&
              !retainedCompletionPaths.includes(path)
            ) {
              retainedCompletionPaths.push(path)
            }
          }
        }
      } else {
        for (const path of expandInitial(index, region)) {
          active.add(path)
          if (!order.includes(path)) order.push(path)
        }
      }
    }
  }
  if (actualNode.node._tag === "Parallel") {
    const subtreeOrder = index.ordered
      .filter(({ path }) => active.has(path) && isPathInSubtree(path, actualTarget))
      .map(({ path }) => path)
    const outsideOrder = order.filter((path) => !isPathInSubtree(path, actualTarget))
    order.splice(0, order.length, ...subtreeOrder, ...outsideOrder)
  }

  const activePaths = index.ordered.filter(({ path }) => active.has(path)).map(({ path }) => path)
  const values: Record<string, ReferenceStateValue> = {}
  for (const path of activePaths) {
    values[path] = retainedValuePaths.has(path) && before.values[path] !== undefined
      ? before.values[path]
      : activeValue(getState(index, path))
  }
  return applyTargetValue(
    index,
    withControlOrder({
      activePaths,
      values,
      completions: retainedCompletionPaths.flatMap((path) => {
        const completion = before.completions.find((candidate) => candidate.path === path)
        return completion === undefined ? [] : [completion]
      }),
      history: before.history,
      status: "active",
      output: undefined
    }, order),
    transition
  )
}

const transitionRecord = (index: ModelIndex, transition: FiniteTransition): ReferenceTransition => ({
  source: transition.source,
  trigger: { type: "event", event: transition.event },
  reenter: transition.reenter,
  // Retain the target identity returned by the compiler's selected builder;
  // the finite AST keeps the broader declared bound separately.
  target: transition.target !== undefined && getState(index, transition.target).node._tag === "History"
    ? transition.target
    : transition.target === undefined
    ? runtimeTargetPath(index, transition)
    : getState(index, transition.source).root !== getState(index, transition.target).root
    ? transition.target
    : entryChoicePath(index, transition.target) ?? runtimeTargetPath(index, transition),
  resolvedTarget: transition.target === undefined
    ? runtimeTargetPath(index, transition)
    : entryChoicePath(index, transition.target) === undefined
    ? runtimeTargetPath(index, transition)
    : choiceResolvedTargetPath(index, entryChoicePath(index, transition.target)!)
})

const choiceTransitionRecords = (index: ModelIndex, path: string): ReadonlyArray<ReferenceTransition> => {
  const records: Array<ReferenceTransition> = []
  let current = getState(index, path)
  const seen = new Set<string>()
  while (current.node._tag === "Choice") {
    if (seen.has(current.path)) break
    seen.add(current.path)
    const selected = getState(index, current.node.selected)
    const selectedTarget = selected.node._tag === "Choice"
      ? selected.path
      : choiceResolvedTargetPath(index, current.path)
    records.push({
      source: current.path,
      trigger: { type: "choice" },
      reenter: false,
      target: selectedTarget,
      resolvedTarget: choiceResolvedTargetPath(index, current.path)
    })
    current = getState(index, resolveChoicePath(index, selected.path))
  }
  return records
}

const initialChoiceTransitionRecords = (index: ModelIndex, path: string): ReadonlyArray<ReferenceTransition> => {
  const current = getState(index, path)
  if (current.node._tag === "Choice") {
    const records = choiceTransitionRecords(index, current.path)
    return [...records, ...initialChoiceTransitionRecords(index, resolveChoicePath(index, current.path))]
  }
  if (current.node._tag === "Compound") {
    return initialChoiceTransitionRecords(index, initialChildPath(current))
  }
  if (current.node._tag === "Parallel") {
    return current.children.flatMap((child) => initialChoiceTransitionRecords(index, child))
  }
  return []
}

const evaluateTransition = (
  index: ModelIndex,
  before: ReferenceState,
  selection: SelectedTransition
): EvaluatedTransition => {
  const { transition } = selection
  const targetPath = runtimeTargetPath(index, transition)
  const next = targetState(index, before, transition, selection.leaf)
  const changed = transition.reenter || !samePaths(before.activePaths, next.activePaths)
  if (!changed) {
    return { ...selection, next, targetPath, changed, exitPaths: [], entryPaths: [] }
  }
  const naturalBoundary = targetPath === undefined
    ? getState(index, transition.source).parent
    : leastCommonAncestor(index, selection.leaf, targetPath)
  const choiceEntry = transition.target === undefined ? undefined : entryChoicePath(index, transition.target)
  const choiceResolvesToActiveAncestor = choiceEntry !== undefined &&
    isPathInSubtree(transition.source, resolveChoicePath(index, choiceEntry))
  const boundary = transition.reenter
    ? !choiceResolvesToActiveAncestor
      ? broadenBoundary(index, naturalBoundary, getState(index, transition.source).parent)
      : getState(index, transition.source).parent
    : naturalBoundary
  const historyTarget = transition.target === undefined ? undefined : getState(index, transition.target)
  const reenteredHistoryOwner = historyTarget?.node._tag === "History" && transition.reenter &&
    historyTarget.parent !== undefined && before.activePaths.includes(historyTarget.parent)
  return {
    ...selection,
    next,
    targetPath,
    changed,
    exitPaths: reenteredHistoryOwner
      ? lifecyclePaths(
        index,
        before.activePaths.filter((path) => isPathInSubtree(path, historyTarget.parent!)),
        undefined,
        "exit"
      )
      : lifecyclePaths(index, before.activePaths, boundary, "exit"),
    entryPaths: reenteredHistoryOwner
      ? lifecyclePaths(
        index,
        next.activePaths.filter((path) => isPathInSubtree(path, historyTarget.parent!)),
        undefined,
        "entry"
      )
      : lifecyclePaths(index, next.activePaths, boundary, "entry")
  }
}

const hasPathIntersection = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.some((path) => right.includes(path))

const sortByDocumentOrder = <A extends { readonly transition: FiniteTransition }>(
  index: ModelIndex,
  transitions: Iterable<A>
): ReadonlyArray<A> =>
  Array.from(transitions).sort((left, right) =>
    getState(index, left.transition.source).order - getState(index, right.transition.source).order
  )

const removeConflicts = (
  index: ModelIndex,
  transitions: ReadonlyArray<EvaluatedTransition>
): ReadonlyArray<EvaluatedTransition> => {
  const retained: Array<EvaluatedTransition> = []
  for (const transition of sortByDocumentOrder(index, transitions)) {
    let preempted = false
    const remove = new Set<EvaluatedTransition>()
    for (const other of retained) {
      if (!hasPathIntersection(transition.exitPaths, other.exitPaths)) continue
      if (isDescendant(index, transition.transition.source, other.transition.source)) {
        remove.add(other)
      } else {
        preempted = true
        break
      }
    }
    if (preempted) continue
    for (const other of remove) retained.splice(retained.indexOf(other), 1)
    retained.push(transition)
  }
  return retained
}

const stepModel = (
  index: ModelIndex,
  before: ReferenceState,
  event: string,
  stepIndex: number
): ReferenceStep => {
  // Public events delivered after terminal completion are observed but cannot
  // select another transition.
  if (before.status === "done") {
    return {
      index: stepIndex,
      event,
      before,
      microsteps: [],
      after: before,
      done: true,
      output: before.output
    }
  }

  const selected = selectTransitions(index, before, event)
  if (selected.length === 0) {
    return {
      index: stepIndex,
      event,
      before,
      microsteps: [],
      after: before,
      done: false,
      output: undefined
    }
  }

  const retained = removeConflicts(index, selected.map((selection) => evaluateTransition(index, before, selection)))
  const sorted = sortByDocumentOrder(index, retained)
  let next = before
  const applicationOrder = [
    ...sorted.filter((transition) => !transition.changed),
    ...sorted.filter((transition) => transition.changed)
  ]
  for (const evaluated of applicationOrder) {
    next = targetState(index, next, evaluated.transition, evaluated.leaf)
  }
  const changed = sorted.some((transition) => transition.changed)
  const exitPaths = lifecyclePaths(index, sorted.flatMap((transition) => transition.exitPaths), undefined, "exit")
  const entryPaths = lifecyclePaths(index, sorted.flatMap((transition) => transition.entryPaths), undefined, "entry")
  next = captureHistory(index, before, next, exitPaths)
  const enteredChoice = sorted.some(({ transition }) =>
    transition.target !== undefined && entryChoicePath(index, transition.target) !== undefined
  )
  if (enteredChoice) next = withControlOrder({ ...next, completions: [] }, controlOrder(next))

  const microstep: ReferenceMicrostep = {
    next,
    event,
    transitions: sorted.flatMap(({ transition }) => {
      const choice = transition.target === undefined ? undefined : entryChoicePath(index, transition.target)
      return [
        transitionRecord(index, transition),
        ...(choice === undefined ? [] : choiceTransitionRecords(index, choice))
      ]
    }),
    exitPaths,
    entryPaths,
    changed
  }
  const after = settleCompletions(index, next)
  return {
    index: stepIndex,
    event,
    before,
    microsteps: [microstep],
    after,
    done: after.status === "done",
    output: after.output
  }
}

/**
 * Purely interprets a hierarchical finite model without compiling or
 * executing a `Machine`.
 *
 * @category verification
 * @since 4.0.0
 */
export const interpretModel = (
  model: FiniteModel,
  events: ReadonlyArray<string>
): ReferenceTrace => {
  const index = indexModel(model)
  const initialRoot = getState(index, model.initial)
  if (initialRoot.parent !== undefined) {
    throw new Error(`MachineTest.interpretModel expected initial state "${model.initial}" to be a root`)
  }
  const startingState = makeUnsettledState(index, model.initial)
  const initialState = settleCompletions(index, startingState)
  const initialChoiceTransitions = initialChoiceTransitionRecords(index, model.initial)
  const initial: ReferenceInitialStep = {
    startingState,
    initialEntryPaths: startingState.activePaths,
    state: initialState,
    microsteps: initialChoiceTransitions.length === 0 ? [] : [{
      next: startingState,
      event: "InitialEvent",
      transitions: initialChoiceTransitions,
      exitPaths: [],
      entryPaths: [],
      changed: false
    }],
    done: initialState.status === "done",
    output: initialState.output
  }
  const steps: Array<ReferenceStep> = []
  let current = initialState
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const step = stepModel(index, current, events[eventIndex]!, eventIndex)
    steps.push(step)
    current = step.after
  }
  return {
    events: events.slice(),
    initial,
    steps,
    final: current
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface ActualStateProjection {
  readonly activePaths: ReadonlyArray<string>
  readonly values: Readonly<Record<string, unknown>>
  readonly completions: ReadonlyArray<unknown>
  readonly history: unknown
}

const projectState = (snapshot: unknown): ActualStateProjection => {
  const activePaths: Array<string> = []
  const values: Record<string, unknown> = {}
  const visit = (current: unknown): void => {
    if (!isRecord(current)) return
    if (typeof current.path === "string") {
      activePaths.push(current.path)
      values[current.path] = current.value
    }
    if (current.state !== undefined) visit(current.state)
    if (isRecord(current.states)) {
      for (const child of Object.values(current.states)) visit(child)
    }
  }
  visit(snapshot)
  return {
    activePaths,
    values,
    completions: isRecord(snapshot) && Array.isArray(snapshot.completed) ? snapshot.completed : [],
    history: isRecord(snapshot) && isRecord(snapshot.history) ? snapshot.history : {}
  }
}

const canonicalize = (value: unknown): unknown => {
  if (value === undefined) return { $undefined: true }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))

const get = (value: unknown, key: string): unknown => isRecord(value) ? value[key] : undefined

const array = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []

const eventTag = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  const tag = get(value, "_tag")
  return typeof tag === "string" ? tag : undefined
}

const completionOrderIndependent = (values: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
  values.slice().sort((left, right) => {
    const leftPath = get(left, "path")
    const rightPath = get(right, "path")
    return String(leftPath).localeCompare(String(rightPath))
  })

const historyOrderIndependent = (value: unknown): unknown => {
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map((path) => {
      const record = value[path]
      if (!isRecord(record)) return [path, record]
      const active = array(record.active).slice().sort((left, right) => String(left).localeCompare(String(right)))
      return [path, { mode: record.mode, active, values: record.values }]
    })
  )
}

const projectTransition = (value: unknown): unknown => {
  if (!isRecord(value)) return value
  const trigger = get(value, "trigger")
  return {
    source: value.source,
    trigger: isRecord(trigger)
      ? { type: trigger.type, ...(trigger.type === "event" ? { event: trigger.event } : {}) }
      : trigger,
    reenter: value.reenter,
    target: value.target,
    resolvedTarget: value.resolvedTarget
  }
}

/**
 * Compares an opaque executable planner trace with the independent finite
 * reference interpreter. The function accumulates every mismatch so shrunk
 * counterexamples preserve the full semantic difference.
 *
 * @internal The public wrapper narrows `actualTrace` to `MachineTest.Trace`.
 */
export const verifyModelTrace = (
  model: FiniteModel,
  actualTrace: unknown
): Effect.Effect<void, ModelVerificationError> => {
  const mismatches: Array<ModelVerificationMismatch> = []
  const add = (
    location: ModelVerificationLocation,
    field: ModelVerificationField,
    expected: unknown,
    actual: unknown
  ): void => {
    if (equal(expected, actual)) return
    mismatches.push({
      location,
      field,
      expected,
      actual,
      message: `${field} differs from the independent finite-model interpretation`
    })
  }

  const scenario = get(actualTrace, "scenario")
  const actualEvents = array(get(scenario, "events"))
  const tags = actualEvents.map(eventTag)
  for (let index = 0; index < tags.length; index++) {
    if (tags[index] === undefined) {
      add({ phase: "event", eventIndex: index }, "event.tag", "a string _tag", tags[index])
    }
  }
  const reference = interpretModel(model, tags.map((tag) => tag ?? "<invalid-event>"))
  const actualInitial = get(actualTrace, "initial")
  const actualInitialPlan = get(actualInitial, "plan")
  const initialLocation: ModelVerificationLocation = { phase: "initial" }

  const compareState = (
    location: ModelVerificationLocation,
    field: ModelStateField,
    expected: ReferenceState,
    actual: unknown
  ): void => {
    const projected = projectState(actual)
    add(location, `${field}.activePaths`, expected.activePaths, projected.activePaths)
    add(location, `${field}.values`, expected.values, projected.values)
    // Completion records are a logical cache. Their array insertion order can
    // change when an unaffected parallel region is copied through a target,
    // but path/output membership is the observable semantic contract.
    add(
      location,
      `${field}.completions`,
      completionOrderIndependent(expected.completions),
      completionOrderIndependent(projected.completions)
    )
    add(
      location,
      `${field}.history`,
      historyOrderIndependent(expected.history),
      historyOrderIndependent(projected.history)
    )
  }

  compareState(
    initialLocation,
    "initial.startingState",
    reference.initial.startingState,
    get(actualInitial, "startingState")
  )
  compareState(
    initialLocation,
    "initial.plan.startingState",
    reference.initial.startingState,
    get(actualInitialPlan, "startingState")
  )
  add(
    initialLocation,
    "initial.startingConfiguration",
    reference.initial.startingState.activePaths,
    get(actualInitial, "startingConfiguration")
  )
  add(
    initialLocation,
    "initial.initialEntryPaths",
    reference.initial.initialEntryPaths,
    get(actualInitial, "initialEntryPaths")
  )
  add(
    initialLocation,
    "initial.plan.initialEntryPaths",
    reference.initial.initialEntryPaths,
    get(actualInitialPlan, "initialEntryPaths")
  )
  compareState(initialLocation, "initial.plan.state", reference.initial.state, get(actualInitialPlan, "state"))
  add(
    initialLocation,
    "initial.configuration",
    reference.initial.state.activePaths,
    get(actualInitial, "configuration")
  )
  add(
    initialLocation,
    "initial.plan.microsteps",
    reference.initial.microsteps.length,
    array(get(actualInitialPlan, "microsteps")).length
  )
  add(initialLocation, "initial.plan.done", reference.initial.done, get(actualInitialPlan, "done"))
  add(initialLocation, "initial.plan.output", reference.initial.output, get(actualInitialPlan, "output"))

  const actualSteps = array(get(actualTrace, "steps"))
  add({ phase: "final" }, "trace.steps.length", reference.steps.length, actualSteps.length)
  for (let stepIndex = 0; stepIndex < reference.steps.length; stepIndex++) {
    const expected = reference.steps[stepIndex]!
    const actual = actualSteps[stepIndex]
    const location: ModelVerificationLocation = { phase: "event", eventIndex: stepIndex }
    const actualPlan = get(actual, "plan")
    add(location, "step.index", expected.index, get(actual, "index"))
    add(location, "step.event", expected.event, eventTag(get(actual, "event")))
    compareState(location, "step.before", expected.before, get(actual, "before"))
    add(location, "step.beforeConfiguration", expected.before.activePaths, get(actual, "beforeConfiguration"))

    const actualMicrosteps = array(get(actualPlan, "microsteps"))
    add(location, "step.plan.microsteps.length", expected.microsteps.length, actualMicrosteps.length)
    for (let microstepIndex = 0; microstepIndex < expected.microsteps.length; microstepIndex++) {
      const expectedMicrostep = expected.microsteps[microstepIndex]!
      const actualMicrostep = actualMicrosteps[microstepIndex]
      const microstepLocation: ModelVerificationLocation = {
        phase: "event",
        eventIndex: stepIndex,
        microstepIndex
      }
      compareState(microstepLocation, "microstep.next", expectedMicrostep.next, get(actualMicrostep, "next"))
      add(microstepLocation, "microstep.event", expectedMicrostep.event, eventTag(get(actualMicrostep, "event")))
      add(
        microstepLocation,
        "microstep.transitions",
        expectedMicrostep.transitions,
        array(get(actualMicrostep, "transitions")).map(projectTransition)
      )
      add(microstepLocation, "microstep.exitPaths", expectedMicrostep.exitPaths, get(actualMicrostep, "exitPaths"))
      add(microstepLocation, "microstep.entryPaths", expectedMicrostep.entryPaths, get(actualMicrostep, "entryPaths"))
      add(microstepLocation, "microstep.changed", expectedMicrostep.changed, get(actualMicrostep, "changed"))
    }

    compareState(location, "step.plan.next", expected.after, get(actualPlan, "next"))
    compareState(location, "step.after", expected.after, get(actual, "after"))
    add(location, "step.afterConfiguration", expected.after.activePaths, get(actual, "afterConfiguration"))
    add(location, "step.plan.done", expected.done, get(actualPlan, "done"))
    add(location, "step.plan.output", expected.output, get(actualPlan, "output"))
  }

  const finalLocation: ModelVerificationLocation = { phase: "final" }
  compareState(finalLocation, "trace.final", reference.final, get(actualTrace, "final"))
  add(finalLocation, "trace.finalConfiguration", reference.final.activePaths, get(actualTrace, "finalConfiguration"))

  return mismatches.length === 0
    ? Effect.void
    : Effect.fail(new ModelVerificationError({ mismatches }))
}
