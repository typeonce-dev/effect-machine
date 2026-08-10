/**
 * Finite hierarchical, parallel, history, choice, and automatic-transition
 * statechart models used by the public testing module.
 *
 * This module intentionally compiles through the public Machine API. It must
 * not share planner helpers with the implementation that later reference
 * models are expected to check.
 *
 * @internal
 */

import * as Schema from "effect/Schema"
import { FastCheck } from "effect/testing"
import * as Machine from "../../../Machine.js"

/**
 * An atomic state in a finite generated model.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteAtomicState {
  readonly _tag: "Atomic"
  readonly key: string
  /** Deterministic payload accepted by this state's generated schema. */
  readonly value: number
}

/**
 * A final state in a finite generated model.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteFinalState {
  readonly _tag: "Final"
  readonly key: string
  /** Deterministic payload accepted by this state's generated schema. */
  readonly value: number
  /** Deterministic value returned by this state's output handler. */
  readonly output: string
}

/**
 * A compound state in a finite generated model.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteCompoundState {
  readonly _tag: "Compound"
  readonly key: string
  /** Deterministic payload accepted by this state's generated schema. */
  readonly value: number
  /** Key of the direct child entered by default. */
  readonly initial: string
  readonly states: ReadonlyArray<FiniteState>
}

/**
 * A parallel state in a finite generated model.
 *
 * Every direct child is an orthogonal region and is active whenever the
 * parallel state is active. The output is deterministic so completion can be
 * compared without sharing executable callbacks with the reference model.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteParallelState {
  readonly _tag: "Parallel"
  readonly key: string
  /** Deterministic payload accepted by this state's generated schema. */
  readonly value: number
  /** Deterministic value returned after every region completes. */
  readonly output: string
  /** Between two and three orthogonal region nodes. */
  readonly states: ReadonlyArray<FiniteState>
}

/**
 * A shallow or deep history pseudo-state in a finite generated model.
 *
 * History states never carry values, become active, or act as transition
 * sources. `fallback` is a concrete descendant of the direct compound or
 * parallel owner and is used only before that history register is captured.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteHistoryState {
  readonly _tag: "History"
  readonly key: string
  readonly history: "shallow" | "deep"
  readonly fallback: string
}

/** A deterministic transient choice pseudo-state in a finite model. */
export interface FiniteChoiceState {
  readonly _tag: "Choice"
  readonly key: string
  readonly targets: ReadonlyArray<string>
  readonly selected: string
}

/**
 * A finite model state.
 *
 * @category models
 * @since 4.0.0
 */
export type FiniteState =
  | FiniteAtomicState
  | FiniteFinalState
  | FiniteCompoundState
  | FiniteParallelState
  | FiniteHistoryState
  | FiniteChoiceState

/**
 * The single trigger representation used by generated and hand-authored finite
 * transitions. Event, always, and completion registrations therefore share the
 * same validation, compilation, and reference interpretation path.
 *
 * @category models
 * @since 4.0.0
 */
export type FiniteTransitionTrigger =
  | { readonly type: "event"; readonly event: string }
  | { readonly type: "always" }
  | { readonly type: "done" }

/**
 * One deterministic transition in a finite generated model.
 *
 * @category models
 * @since 4.0.0
 */
interface FiniteTransitionBase {
  readonly source: string
  /** Omission represents a targetless transition. */
  readonly target?: string
  /** Optional schema-valid value supplied for the declared target state. */
  readonly targetValue?: number
}

/**
 * A public event transition may explicitly request source reentry.
 *
 * @category models
 * @since 4.0.0
 */
export type FiniteEventTransition = FiniteTransitionBase & {
  readonly trigger: Extract<FiniteTransitionTrigger, { readonly type: "event" }>
  readonly reenter: boolean
}

/**
 * An always or completion transition. Automatic transitions deliberately omit
 * the event-only reentry option.
 *
 * @category models
 * @since 4.0.0
 */
export type FiniteAutomaticTransition = FiniteTransitionBase & {
  readonly trigger: Exclude<FiniteTransitionTrigger, { readonly type: "event" }>
}

/**
 * One deterministic event or automatic transition in a finite model.
 *
 * @category models
 * @since 4.0.0
 */
export type FiniteTransition = FiniteEventTransition | FiniteAutomaticTransition

/**
 * The exact generated transition that changes a value before history capture.
 *
 * The source and target are the same active atomic state. `value` is distinct
 * from that state's generated default value.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteHistoryMutation {
  readonly source: string
  readonly event: string
  readonly target: string
  readonly value: number
}

/**
 * One exact transition in a generated history witness.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteHistoryTransfer {
  readonly source: string
  readonly event: string
  readonly target: string
}

/**
 * A replayable value-mutation, capture, and restoration witness generated for
 * one history pseudo-state.
 *
 * `events` is exactly `[mutation.event, leave.event, resume.event]`. Replaying
 * it changes a schema-valid atomic value, exits the history owner through its
 * root, and restores the remembered non-default value through `history`.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteHistoryScenario {
  readonly history: string
  readonly owner: string
  readonly historyType: "shallow" | "deep"
  readonly mutation: FiniteHistoryMutation
  readonly leave: FiniteHistoryTransfer
  readonly resume: FiniteHistoryTransfer
  readonly events: readonly [mutation: string, leave: string, resume: string]
}

/**
 * A small immutable statechart model suitable for generation and shrinking.
 *
 * State paths use dot-separated state keys. Transitions are unique by
 * source/event pair. A transition may target any state under its source root,
 * or a different root as a complete configuration.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteModel {
  readonly roots: ReadonlyArray<FiniteState>
  /** Key of the root entered during startup. */
  readonly initial: string
  readonly events: ReadonlyArray<string>
  readonly transitions: ReadonlyArray<FiniteTransition>
  /** Exact value-sensitive history witnesses attached by `finiteModels`. */
  readonly historyScenarios?: ReadonlyArray<FiniteHistoryScenario>
}

/**
 * Limits controlling finite model generation.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteModelOptions {
  /** Maximum number of root states. Always between one and three. */
  readonly maxRoots?: 1 | 2 | 3
  /** Maximum state-tree depth, counting a root as depth one. */
  readonly maxDepth?: number
  /** Maximum number of direct children in a compound state. */
  readonly maxChildren?: number
  /** Maximum number of regions in a parallel state. Always two or three. */
  readonly maxParallelRegions?: 2 | 3
  /** Maximum number of distinct public event tags. */
  readonly maxEvents?: number
  /** Maximum number of source/event transition registrations. */
  readonly maxTransitions?: number
  /** Maximum number of history pseudo-states added to one generated model. */
  readonly maxHistoryStates?: number
  /** Maximum number of deterministic choice witnesses added to a generated model. */
  readonly maxChoiceStates?: number
}

/**
 * Resolved limits and structural guarantees for a finite model arbitrary.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteModelDiagnostics {
  readonly limits: {
    readonly maxRoots: 1 | 2 | 3
    readonly maxDepth: number
    readonly maxChildren: number
    readonly maxParallelRegions: 2 | 3
    readonly maxEvents: number
    readonly maxTransitions: number
    readonly maxHistoryStates: number
    readonly maxChoiceStates: number
  }
  readonly guarantees: {
    readonly compoundOnly: false
    readonly parallelStates: true
    readonly historyStates: true
    readonly historyLeaveResumeSequences: true
    readonly historyValueScenarios: true
    readonly choiceStates: true
    readonly choiceInitialWitnesses: true
    readonly structurallyValid: true
    readonly shrinkPreservesValidity: true
    readonly eventlessTransitions: true
    readonly acyclicAutomaticTransitions: true
  }
}

/**
 * A finite model arbitrary and the exact limits used to construct it.
 *
 * @category models
 * @since 4.0.0
 */
export interface FiniteModels {
  readonly arbitrary: FastCheck.Arbitrary<FiniteModel>
  readonly diagnostics: FiniteModelDiagnostics
}

interface RawAtomicState {
  readonly _tag: "Atomic"
}

interface RawFinalState {
  readonly _tag: "Final"
}

interface RawCompoundState {
  readonly _tag: "Compound"
  readonly initialIndex: number
  readonly states: ReadonlyArray<RawState>
}

interface RawParallelState {
  readonly _tag: "Parallel"
  readonly states: ReadonlyArray<RawState>
}

type RawState = RawAtomicState | RawFinalState | RawCompoundState | RawParallelState

interface FlatFiniteState {
  readonly node: FiniteState
  readonly path: string
  readonly parent: string | undefined
  readonly root: string
}

interface TransitionCandidate {
  readonly source: string
  readonly trigger: FiniteTransitionTrigger
  readonly targets: ReadonlyArray<string>
}

const triggerKey = (trigger: FiniteTransitionTrigger): string =>
  trigger.type === "event" ? `event:${trigger.event}` : trigger.type

const defaults = {
  maxRoots: 3 as const,
  maxDepth: 3,
  maxChildren: 3,
  maxParallelRegions: 3 as const,
  maxEvents: 3,
  maxTransitions: 12,
  maxHistoryStates: 2,
  maxChoiceStates: 1
}

const validateLimit = (name: string, value: number, maximum: number): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`MachineTest.finiteModels expected ${name} to be an integer between 1 and ${maximum}`)
  }
}

const resolveOptions = (options: FiniteModelOptions): FiniteModelDiagnostics["limits"] => {
  const limits = {
    maxRoots: options.maxRoots ?? defaults.maxRoots,
    maxDepth: options.maxDepth ?? defaults.maxDepth,
    maxChildren: options.maxChildren ?? defaults.maxChildren,
    maxParallelRegions: options.maxParallelRegions ?? defaults.maxParallelRegions,
    maxEvents: options.maxEvents ?? defaults.maxEvents,
    maxTransitions: options.maxTransitions ?? defaults.maxTransitions,
    maxHistoryStates: options.maxHistoryStates ?? defaults.maxHistoryStates,
    maxChoiceStates: options.maxChoiceStates ?? defaults.maxChoiceStates
  }
  validateLimit("maxRoots", limits.maxRoots, 3)
  validateLimit("maxDepth", limits.maxDepth, 6)
  validateLimit("maxChildren", limits.maxChildren, 4)
  validateLimit("maxParallelRegions", limits.maxParallelRegions, 3)
  if (limits.maxParallelRegions < 2) {
    throw new Error("MachineTest.finiteModels expected maxParallelRegions to be two or three")
  }
  validateLimit("maxEvents", limits.maxEvents, 8)
  validateLimit("maxTransitions", limits.maxTransitions, 256)
  if (!Number.isSafeInteger(limits.maxHistoryStates) || limits.maxHistoryStates < 0 || limits.maxHistoryStates > 8) {
    throw new Error("MachineTest.finiteModels expected maxHistoryStates to be an integer between 0 and 8")
  }
  if (!Number.isSafeInteger(limits.maxChoiceStates) || limits.maxChoiceStates < 0 || limits.maxChoiceStates > 8) {
    throw new Error("MachineTest.finiteModels expected maxChoiceStates to be an integer between 0 and 8")
  }
  return limits
}

const rawStateArbitrary = (
  depth: number,
  limits: FiniteModelDiagnostics["limits"]
): FastCheck.Arbitrary<RawState> => {
  const leaf = FastCheck.boolean().map((final): RawState => final ? { _tag: "Final" } : { _tag: "Atomic" })
  if (depth >= limits.maxDepth) return leaf

  const nested = rawStateArbitrary(depth + 1, limits)
  const compound = FastCheck.array(nested, {
    minLength: 1,
    maxLength: limits.maxChildren
  }).chain((states) =>
    FastCheck.integer({ min: 0, max: states.length - 1 }).map((initialIndex): RawCompoundState => ({
      _tag: "Compound",
      initialIndex,
      states
    }))
  )
  const parallel = FastCheck.array(nested, {
    minLength: 2,
    maxLength: limits.maxParallelRegions
  }).map((states): RawParallelState => ({ _tag: "Parallel", states }))
  return FastCheck.oneof(leaf, compound, parallel)
}

const normalizeStates = (raw: ReadonlyArray<RawState>): ReadonlyArray<FiniteState> => {
  let value = 0
  const visit = (states: ReadonlyArray<RawState>, parentPath: string): ReadonlyArray<FiniteState> =>
    states.map((state, index) => {
      const key = `state${index}`
      const path = parentPath === "" ? key : `${parentPath}.${key}`
      const currentValue = value++
      if (state._tag === "Atomic") {
        return Object.freeze({ _tag: "Atomic", key, value: currentValue })
      }
      if (state._tag === "Final") {
        return Object.freeze({
          _tag: "Final",
          key,
          value: currentValue,
          output: `output:${path}`
        })
      }
      const children = visit(state.states, path)
      if (state._tag === "Parallel") {
        return Object.freeze({
          _tag: "Parallel",
          key,
          value: currentValue,
          output: `output:${path}`,
          states: Object.freeze(children.slice())
        })
      }
      return Object.freeze({
        _tag: "Compound",
        key,
        value: currentValue,
        initial: children[state.initialIndex]!.key,
        states: Object.freeze(children.slice())
      })
    })
  return Object.freeze(visit(raw, "").slice())
}

const flattenStates = (roots: ReadonlyArray<FiniteState>): ReadonlyArray<FlatFiniteState> => {
  const flattened: Array<FlatFiniteState> = []
  const visit = (states: ReadonlyArray<FiniteState>, parent: string | undefined, root: string | undefined): void => {
    for (const node of states) {
      const path = parent === undefined ? node.key : `${parent}.${node.key}`
      const nodeRoot = root ?? path
      flattened.push({ node, path, parent, root: nodeRoot })
      if (node._tag === "Compound" || node._tag === "Parallel") visit(node.states, path, nodeRoot)
    }
  }
  visit(roots, undefined, undefined)
  return flattened
}

const isPathInSubtree = (path: string, root: string): boolean => path === root || path.startsWith(`${root}.`)

const initialLeaves = (
  states: ReadonlyMap<string, FlatFiniteState>,
  path: string
): ReadonlyArray<string> => {
  const state = states.get(path)!
  if (state.node._tag === "Choice") return initialLeaves(states, state.node.selected)
  if (state.node._tag === "Compound") {
    return initialLeaves(states, `${path}.${state.node.initial}`)
  }
  if (state.node._tag === "Parallel") {
    return state.node.states
      .filter((child) => child._tag !== "History" && child._tag !== "Choice")
      .flatMap((child) => initialLeaves(states, `${path}.${child.key}`))
  }
  return state.node._tag === "Atomic" ? [path] : []
}

const addGeneratedHistory = (
  roots: ReadonlyArray<FiniteState>,
  initial: string,
  maxHistoryStates: number,
  maxTransitions: number,
  events: ReadonlyArray<string>,
  decisions: ReadonlyArray<"shallow" | "deep">
): {
  readonly roots: ReadonlyArray<FiniteState>
  readonly scenarios: ReadonlyArray<FiniteHistoryScenario>
} => {
  if (maxHistoryStates === 0 || maxTransitions < 2 || decisions.length === 0) {
    return { roots, scenarios: [] }
  }
  const flattened = flattenStates(roots)
  const byPath = new Map(flattened.map((state) => [state.path, state]))
  const initialActiveLeaves = initialLeaves(byPath, initial)
  const initialActive = new Set(initialActiveLeaves.flatMap((leaf) => {
    const parts = leaf.split(".")
    return parts.map((_, index) => parts.slice(0, index + 1).join("."))
  }))
  const outside = roots
    .filter((root) => root.key !== initial)
    .map((root) => ({ root, leaves: initialLeaves(byPath, root.key) }))
    .find(({ leaves }) => leaves.length > 0)
  if (outside === undefined) return { roots, scenarios: [] }

  const eligible = flattened.filter((state) =>
    initialActive.has(state.path) &&
    (state.node._tag === "Compound" || state.node._tag === "Parallel") &&
    initialLeaves(byPath, state.path).length > 0
  )
  const count = Math.min(
    maxHistoryStates,
    decisions.length,
    Math.floor(events.length / 2),
    Math.floor(maxTransitions / 3),
    eligible.length
  )
  const selected = eligible.slice(0, count).map((owner, index) => {
    const composite = owner.node as FiniteCompoundState | FiniteParallelState
    const directAtomic = composite._tag === "Compound"
      ? composite.states.find((child) => child.key === composite.initial && child._tag === "Atomic")
      : composite.states.find((child) => child._tag === "Atomic")
    const historyType = decisions[index] === "shallow" && directAtomic !== undefined ? "shallow" : "deep"
    const mutationSource = historyType === "shallow"
      ? `${owner.path}.${directAtomic!.key}`
      : initialLeaves(byPath, owner.path)[0]!
    const fallbackChild = composite._tag === "Compound"
      ? composite.states.find((child) => child.key === composite.initial)!
      : composite.states.find((child) => child._tag !== "History")!
    const history: FiniteHistoryState = Object.freeze({
      _tag: "History",
      key: `history${index}`,
      history: historyType,
      fallback: `${owner.path}.${fallbackChild.key}`
    })
    return { owner, history, mutationSource }
  })
  const byOwner = new Map(selected.map(({ history, owner }) => [owner.path, history]))
  const decorate = (states: ReadonlyArray<FiniteState>, parent: string | undefined): ReadonlyArray<FiniteState> =>
    Object.freeze(states.map((state): FiniteState => {
      const path = parent === undefined ? state.key : `${parent}.${state.key}`
      if (state._tag !== "Compound" && state._tag !== "Parallel") return state
      const children = decorate(state.states, path)
      const history = byOwner.get(path)
      return Object.freeze({
        ...state,
        states: Object.freeze(history === undefined ? children.slice() : [...children, history])
      })
    }))
  const decorated = decorate(roots, undefined)
  return {
    roots: decorated,
    scenarios: selected.map(({ history, mutationSource, owner }, index): FiniteHistoryScenario => {
      const historyPath = `${owner.path}.${history.key}`
      const leaveEvent = events[index]!
      const mutationEvent = events[count + index]!
      const mutationValue = (byPath.get(mutationSource)!.node as FiniteAtomicState).value + 10_000 + index
      return Object.freeze({
        history: historyPath,
        owner: owner.path,
        historyType: history.history,
        mutation: Object.freeze({
          source: mutationSource,
          event: mutationEvent,
          target: mutationSource,
          value: mutationValue
        }),
        leave: Object.freeze({
          source: initialLeaves(byPath, owner.path)[0]!,
          event: leaveEvent,
          target: outside.root.key
        }),
        resume: Object.freeze({
          source: outside.leaves[0]!,
          event: leaveEvent,
          target: historyPath
        }),
        events: Object.freeze([mutationEvent, leaveEvent, leaveEvent]) as readonly [string, string, string]
      })
    })
  }
}

const addGeneratedChoices = (
  roots: ReadonlyArray<FiniteState>,
  maxChoiceStates: number
): ReadonlyArray<FiniteState> => {
  if (maxChoiceStates === 0) return roots
  let remaining = maxChoiceStates
  const visit = (
    states: ReadonlyArray<FiniteState>,
    parent: string | undefined,
    insideParallel: boolean
  ): ReadonlyArray<FiniteState> =>
    Object.freeze(states.map((state): FiniteState => {
      const path = parent === undefined ? state.key : `${parent}.${state.key}`
      if (state._tag === "Compound") {
        const children = visit(state.states, path, insideParallel)
        if (remaining > 0 && !insideParallel) {
          const concrete = children.filter((child) =>
            child._tag !== "History" && child._tag !== "Choice" && child._tag !== "Parallel"
          )
          if (concrete.some((child) => child.key === state.initial)) {
            remaining -= 1
            const choice: FiniteChoiceState = Object.freeze({
              _tag: "Choice",
              key: `choice${remaining}`,
              targets: Object.freeze(concrete.map((child) => `${path}.${child.key}`)),
              selected: `${path}.${state.initial}`
            })
            return Object.freeze({
              ...state,
              initial: choice.key,
              states: Object.freeze([...children, choice])
            })
          }
        }
        return Object.freeze({ ...state, states: children })
      }
      if (state._tag === "Parallel") return Object.freeze({ ...state, states: visit(state.states, path, true) })
      return state
    }))
  return visit(roots, undefined, false)
}

const freezeModel = (
  roots: ReadonlyArray<FiniteState>,
  initial: string,
  events: ReadonlyArray<string>,
  transitions: ReadonlyArray<FiniteTransition>,
  historyScenarios: ReadonlyArray<FiniteHistoryScenario> = []
): FiniteModel =>
  Object.freeze({
    roots,
    initial,
    events: Object.freeze(events.slice()),
    transitions: Object.freeze(transitions.map((transition) => Object.freeze(transition))),
    historyScenarios: Object.freeze(historyScenarios.slice())
  })

const makeTransitionArbitrary = (
  roots: ReadonlyArray<FiniteState>,
  initial: string,
  events: ReadonlyArray<string>,
  maxTransitions: number,
  historyScenarios: ReadonlyArray<FiniteHistoryScenario> = []
): FastCheck.Arbitrary<ReadonlyArray<FiniteTransition>> => {
  const states = flattenStates(roots)
  const sourceOrder = new Map(states.map((state, index) => [state.path, index]))
  const stateByPath = new Map(states.map((state) => [state.path, state]))
  const initiallyActive = new Set(
    initialLeaves(stateByPath, initial).flatMap((leaf) => {
      const parts = leaf.split(".")
      return parts.map((_, index) => parts.slice(0, index + 1).join("."))
    })
  )
  const triggerOrder = (trigger: FiniteTransitionTrigger): number =>
    trigger.type === "event"
      ? events.indexOf(trigger.event)
      : events.length + (trigger.type === "always" ? 0 : 1)
  const orderTransitions = (transitions: ReadonlyArray<FiniteTransition>): ReadonlyArray<FiniteTransition> =>
    transitions.slice().sort((left, right) =>
      sourceOrder.get(left.source)! - sourceOrder.get(right.source)! ||
      triggerOrder(left.trigger) - triggerOrder(right.trigger)
    )
  const active = states.filter(({ node }) => node._tag !== "Final" && node._tag !== "History" && node._tag !== "Choice")
  const mandatory = historyScenarios.flatMap((scenario): ReadonlyArray<FiniteTransition> => [
    {
      source: scenario.mutation.source,
      trigger: { type: "event", event: scenario.mutation.event },
      target: scenario.mutation.target,
      targetValue: scenario.mutation.value,
      reenter: false
    },
    {
      source: scenario.leave.source,
      trigger: { type: "event", event: scenario.leave.event },
      target: scenario.leave.target,
      reenter: false
    },
    {
      source: scenario.resume.source,
      trigger: { type: "event", event: scenario.resume.event },
      target: scenario.resume.target,
      reenter: false
    }
  ])
  const mandatoryRegistrations = new Set(
    mandatory.map(({ source, trigger }) => `${source}\u0000${triggerKey(trigger)}`)
  )
  const reservedEvents = new Set(
    historyScenarios.flatMap(({ leave, mutation }) => [leave.event, mutation.event])
  )
  const eventCandidates = active.flatMap(({ path: source, root }) =>
    events.map((event): TransitionCandidate => ({
      source,
      trigger: { type: "event", event },
      // `branch` addresses the source root while `full` replaces another root.
      // Same-root targets may select any state, including a parallel state or
      // a compound state whose initial descent enters a parallel state. The
      // compiler expands those targets into every required orthogonal region.
      targets: states.filter((target) =>
        target.node._tag !== "History" && (target.root === root || target.parent === undefined)
      )
        .map(({ path }) => path)
    }))
  ).filter(({ source, trigger }) =>
    !mandatoryRegistrations.has(`${source}\u0000${triggerKey(trigger)}`) &&
    (trigger.type !== "event" || !reservedEvents.has(trigger.event))
  )
  const exitsSourceTargets = (source: FlatFiniteState): ReadonlyArray<string> =>
    states.filter((target, targetIndex) => {
      if (
        targetIndex <= sourceOrder.get(source.path)! || target.node._tag === "History" ||
        target.node._tag === "Choice"
      ) return false
      // A generated automatic transition must make its source inactive. This
      // gives the independent oracle a structurally acyclic witness instead of
      // relying on runtime iteration bounds. A later sibling under a compound
      // parent exits the source branch; a later root replaces the whole root.
      if (source.parent === undefined) {
        return target.parent === undefined && target.root !== source.root
      }
      return stateByPath.get(source.parent)?.node._tag === "Compound" && target.parent === source.parent
    }).map(({ path }) => path)
  const automaticCandidates: ReadonlyArray<TransitionCandidate> = historyScenarios.length === 0
    ? [
      ...active.flatMap((source): ReadonlyArray<TransitionCandidate> =>
        source.node._tag !== "Atomic" ? [] : [{
          source: source.path,
          trigger: { type: "always" },
          targets: exitsSourceTargets(source)
        }]
      ),
      ...states.flatMap((source): ReadonlyArray<TransitionCandidate> =>
        source.node._tag !== "Compound" && source.node._tag !== "Parallel" ? [] : [{
          source: source.path,
          trigger: { type: "done" },
          targets: exitsSourceTargets(source)
        }]
      )
    ].filter(({ targets }) => targets.length > 0)
    : []
  const completesOnEntry = (path: string): boolean => {
    const state = stateByPath.get(path)!
    if (state.node._tag === "Final") return true
    if (state.node._tag === "Compound") {
      const node = state.node
      return node.states.some(({ key, _tag }) => key === node.initial && _tag === "Final")
    }
    if (state.node._tag === "Parallel") {
      return state.node.states
        .filter(({ _tag }) => _tag !== "History" && _tag !== "Choice")
        .every((child) => completesOnEntry(`${path}.${child.key}`))
    }
    return false
  }
  const materialize = (
    selected: ReadonlyArray<TransitionCandidate>,
    allowTargetlessEvents = true
  ): FastCheck.Arbitrary<ReadonlyArray<FiniteTransition>> => {
    if (selected.length === 0) return FastCheck.constant([])
    const decisions = selected.map((candidate) =>
      FastCheck.record({
        // Targetless event transitions remain useful witnesses. Generated
        // automatic transitions always exit their source so stabilization is
        // acyclic by construction; targetless automatic semantics are covered
        // by focused examples rather than mixed into the finite-model oracle.
        targetIndex: FastCheck.integer({
          min: candidate.trigger.type === "event" && allowTargetlessEvents ? 0 : 1,
          max: candidate.targets.length
        }),
        targetValueOffset: FastCheck.integer({ min: 0, max: 2 }),
        reenter: FastCheck.boolean()
      })
    )
    return FastCheck.tuple(...decisions).map((values) =>
      selected.map((candidate, index): FiniteTransition => {
        const decision = values[index]!
        const target = decision.targetIndex === 0 ? undefined : candidate.targets[decision.targetIndex - 1]
        const targetState = target === undefined ? undefined : states.find(({ path }) => path === target)
        const targetValue = targetState?.node._tag === "Atomic" &&
            decision.targetValueOffset !== 0
          ? targetState.node.value + decision.targetValueOffset
          : undefined
        const targetFields = target === undefined
          ? {}
          : { target, ...(targetValue === undefined ? {} : { targetValue }) }
        const trigger = candidate.trigger
        return trigger.type === "event"
          ? { source: candidate.source, trigger, reenter: decision.reenter, ...targetFields }
          : { source: candidate.source, trigger, ...targetFields }
      })
    )
  }
  const optionalBudget = maxTransitions - mandatory.length
  const general = FastCheck.subarray([...eventCandidates, ...automaticCandidates], {
    minLength: 0,
    maxLength: Math.min(optionalBudget, eventCandidates.length + automaticCandidates.length)
  }).chain((selected) => materialize(selected).map((transitions) => orderTransitions([...mandatory, ...transitions])))

  if (mandatory.length > 0 || optionalBudget < 2 || automaticCandidates.length === 0) return general

  // Bias one branch toward a reachable public-event -> automatic-transition
  // chain. The automatic edge itself still moves forward in document order,
  // so combining the two trigger kinds cannot introduce an automatic cycle.
  const chainCandidates = eventCandidates.flatMap((eventCandidate) => {
    const source = stateByPath.get(eventCandidate.source)!
    if (source.node._tag !== "Atomic" || !initiallyActive.has(source.path)) return []
    return automaticCandidates.flatMap((automaticCandidate) => {
      if (
        automaticCandidate.source === eventCandidate.source ||
        !eventCandidate.targets.includes(automaticCandidate.source) ||
        (automaticCandidate.trigger.type === "done" && !completesOnEntry(automaticCandidate.source))
      ) return []
      return [{
        event: { ...eventCandidate, targets: [automaticCandidate.source] },
        automatic: automaticCandidate
      }]
    })
  })
  if (chainCandidates.length === 0) return general

  const chain = FastCheck.constantFrom(...chainCandidates).chain(({ automatic, event }) =>
    materialize([event, automatic], false).map((transitions) => orderTransitions(transitions))
  )
  return FastCheck.oneof(general, chain)
}

/**
 * Generates bounded, structurally valid hierarchical statechart
 * models.
 *
 * Generation is composed from shrinkable topology, initial-state, event, and
 * transition decisions. Paths and transition candidates are rebuilt after a
 * topology shrink, so a shrink can never retain a dangling source or target.
 * Generated automatic transitions are acyclic by construction: `always`
 * transitions leave atomic sources and completion transitions leave compound
 * or parallel sources. Separate focused witnesses cover cyclic stabilization.
 *
 * @category constructors
 * @since 4.0.0
 */
export const finiteModels = (options: FiniteModelOptions = {}): FiniteModels => {
  const limits = resolveOptions(options)
  const rawRoots = FastCheck.array(rawStateArbitrary(1, limits), {
    minLength: 1,
    maxLength: limits.maxRoots
  })
  const arbitrary = rawRoots.chain((raw) => {
    const activeRoots = normalizeStates(raw)
    return FastCheck.tuple(
      FastCheck.integer({ min: 0, max: activeRoots.length - 1 }),
      FastCheck.integer({ min: 1, max: limits.maxEvents }),
      FastCheck.array(FastCheck.constantFrom("shallow" as const, "deep" as const), {
        minLength: 0,
        maxLength: limits.maxHistoryStates
      })
    ).chain(([initialIndex, eventCount, historyDecisions]) => {
      const events = Array.from({ length: eventCount }, (_, index) => `Event${index}`)
      const initial = activeRoots[initialIndex]!.key
      const generated = addGeneratedHistory(
        activeRoots,
        initial,
        limits.maxHistoryStates,
        limits.maxTransitions,
        events,
        historyDecisions
      )
      const roots = generated.scenarios.length === 0
        ? addGeneratedChoices(generated.roots, limits.maxChoiceStates)
        : generated.roots
      return makeTransitionArbitrary(roots, initial, events, limits.maxTransitions, generated.scenarios).map(
        (transitions) => freezeModel(roots, initial, events, transitions, generated.scenarios)
      )
    })
  })

  return {
    arbitrary,
    diagnostics: {
      limits,
      guarantees: {
        compoundOnly: false,
        parallelStates: true,
        historyStates: true,
        historyLeaveResumeSequences: true,
        historyValueScenarios: true,
        choiceStates: true,
        choiceInitialWitnesses: true,
        structurallyValid: true,
        shrinkPreservesValidity: true,
        eventlessTransitions: true,
        acyclicAutomaticTransitions: true
      }
    }
  }
}

const isValidKey = (key: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)

const validateModel = (model: FiniteModel): ReadonlyArray<FlatFiniteState> => {
  if (!Array.isArray(model.roots) || model.roots.length < 1 || model.roots.length > 3) {
    throw new Error("MachineTest.compileModel expected between one and three root states")
  }
  const visit = (states: ReadonlyArray<FiniteState>, parent: string | undefined): void => {
    if (states.length === 0) {
      throw new Error(`MachineTest.compileModel expected ${parent ?? "the model"} to contain a state`)
    }
    const siblingKeys = new Set<string>()
    for (const node of states) {
      if (!isValidKey(node.key)) {
        throw new Error(`MachineTest.compileModel received invalid state key "${node.key}"`)
      }
      if (siblingKeys.has(node.key)) {
        throw new Error(`MachineTest.compileModel received duplicate state key "${node.key}"`)
      }
      siblingKeys.add(node.key)
      const path = parent === undefined ? node.key : `${parent}.${node.key}`
      if (node._tag !== "History" && node._tag !== "Choice" && !Number.isSafeInteger(node.value)) {
        throw new Error(`MachineTest.compileModel expected state "${path}" value to be a safe integer`)
      }
      if (node._tag === "History") {
        if (parent === undefined) {
          throw new Error(`MachineTest.compileModel received root history state "${path}"`)
        }
        if (node.history !== "shallow" && node.history !== "deep") {
          throw new Error(`MachineTest.compileModel received invalid history mode at "${path}"`)
        }
        continue
      }
      if (node._tag === "Choice") {
        if (parent === undefined || node.targets.length === 0 || !node.targets.includes(node.selected)) {
          throw new Error(`MachineTest.compileModel received invalid choice state "${path}"`)
        }
        continue
      }
      if (node._tag === "Compound") {
        if (!node.states.some((child) => child.key === node.initial && child._tag !== "History")) {
          throw new Error(`MachineTest.compileModel received unknown initial child "${node.initial}" for "${path}"`)
        }
        visit(node.states, path)
      } else if (node._tag === "Parallel") {
        const regions = node.states.filter((child) => child._tag !== "History" && child._tag !== "Choice")
        if (regions.length < 2 || regions.length > 3) {
          throw new Error(`MachineTest.compileModel expected parallel state "${path}" to contain two or three regions`)
        }
        if (typeof node.output !== "string") {
          throw new Error(`MachineTest.compileModel expected parallel state "${path}" output to be a string`)
        }
        visit(node.states, path)
      } else if (node._tag === "Final" && typeof node.output !== "string") {
        throw new Error(`MachineTest.compileModel expected final state "${path}" output to be a string`)
      } else if (node._tag !== "Atomic" && node._tag !== "Final") {
        throw new Error(`MachineTest.compileModel received unsupported state type at "${path}"`)
      }
    }
  }
  visit(model.roots, undefined)

  if (!model.roots.some((root) => root.key === model.initial)) {
    throw new Error(`MachineTest.compileModel received unknown initial root "${model.initial}"`)
  }
  const events = new Set<string>()
  for (const event of model.events) {
    if (typeof event !== "string" || event.length === 0 || events.has(event)) {
      throw new Error(`MachineTest.compileModel received invalid or duplicate event tag "${String(event)}"`)
    }
    events.add(event)
  }
  if (events.size === 0) {
    throw new Error("MachineTest.compileModel expected at least one event tag")
  }

  const flattened = flattenStates(model.roots)
  const byPath = new Map(flattened.map((state) => [state.path, state]))
  for (const state of flattened) {
    if (state.node._tag !== "Choice") continue
    const owner = state.parent === undefined ? undefined : byPath.get(state.parent)
    if (owner?.node._tag !== "Compound") {
      throw new Error(`MachineTest.compileModel expected choice state "${state.path}" to belong to a compound state`)
    }
    for (const targetPath of state.node.targets) {
      const target = byPath.get(targetPath)
      if (
        target === undefined || target.node._tag === "History" || target.node._tag === "Choice" ||
        target.parent !== owner.path
      ) {
        throw new Error(`MachineTest.compileModel received invalid choice target "${targetPath}"`)
      }
    }
  }
  for (const state of flattened) {
    if (state.node._tag !== "History") continue
    const owner = state.parent === undefined ? undefined : byPath.get(state.parent)
    const fallback = byPath.get(state.node.fallback)
    if (
      owner === undefined ||
      (owner.node._tag !== "Compound" && owner.node._tag !== "Parallel") ||
      fallback === undefined ||
      fallback.node._tag === "History" ||
      fallback.path === owner.path ||
      !isPathInSubtree(fallback.path, owner.path)
    ) {
      throw new Error(
        `MachineTest.compileModel expected history state "${state.path}" fallback to be a concrete descendant of "${state.parent}"`
      )
    }
  }
  const registrations = new Set<string>()
  const transitionsByRegistration = new Map<string, FiniteTransition>()
  for (const transition of model.transitions) {
    const source = byPath.get(transition.source)
    if (
      source === undefined || source.node._tag === "Final" || source.node._tag === "History" ||
      source.node._tag === "Choice"
    ) {
      throw new Error(`MachineTest.compileModel received invalid transition source "${transition.source}"`)
    }
    if (transition.trigger.type === "event" && !events.has(transition.trigger.event)) {
      throw new Error(`MachineTest.compileModel received unknown transition event "${transition.trigger.event}"`)
    }
    if (
      transition.trigger.type === "done" && source.node._tag !== "Compound" && source.node._tag !== "Parallel"
    ) {
      throw new Error(
        `MachineTest.compileModel received completion transition for non-composite "${transition.source}"`
      )
    }
    if (transition.trigger.type !== "event" && "reenter" in transition) {
      throw new Error(`MachineTest.compileModel received event-only reenter option from "${transition.source}"`)
    }
    const registration = `${transition.source}\u0000${triggerKey(transition.trigger)}`
    if (registrations.has(registration)) {
      throw new Error(
        `MachineTest.compileModel received duplicate transition for "${transition.source}" on ` +
          `"${triggerKey(transition.trigger)}"`
      )
    }
    registrations.add(registration)
    transitionsByRegistration.set(registration, transition)
    if (transition.target !== undefined) {
      const target = byPath.get(transition.target)
      if (target === undefined) {
        throw new Error(`MachineTest.compileModel received unknown transition target "${transition.target}"`)
      }
      if (target.node._tag !== "History" && target.root !== source.root && target.parent !== undefined) {
        throw new Error(
          `MachineTest.compileModel expected cross-root target "${transition.target}" to select its root "${target.root}"`
        )
      }
    }
    if (
      transition.targetValue !== undefined &&
      (!Number.isSafeInteger(transition.targetValue) || transition.target === undefined ||
        byPath.get(transition.target)?.node._tag === "History" ||
        byPath.get(transition.target)?.node._tag === "Choice")
    ) {
      throw new Error(
        `MachineTest.compileModel received invalid target value for transition from "${transition.source}"`
      )
    }
  }
  const initiallyActiveLeaves = initialLeaves(byPath, model.initial)
  const initiallyActive = new Set(initiallyActiveLeaves.flatMap((leaf) => {
    const parts = leaf.split(".")
    return parts.map((_, index) => parts.slice(0, index + 1).join("."))
  }))
  const scenarioHistories = new Set<string>()
  const scenarioEvents = new Set<string>()
  const scenarioRegistrations = new Set<string>()
  for (const scenario of model.historyScenarios ?? []) {
    const history = byPath.get(scenario.history)
    const mutationState = byPath.get(scenario.mutation.source)
    if (
      history?.node._tag !== "History" || history.parent !== scenario.owner ||
      history.node.history !== scenario.historyType
    ) {
      throw new Error(`MachineTest.compileModel received invalid history scenario for "${scenario.history}"`)
    }
    if (scenarioHistories.has(scenario.history)) {
      throw new Error(`MachineTest.compileModel received duplicate history scenario for "${scenario.history}"`)
    }
    scenarioHistories.add(scenario.history)
    const owner = byPath.get(scenario.owner)!
    const ownerNode = owner.node
    let expectedMutationSource: string | undefined
    if (scenario.historyType === "deep") {
      expectedMutationSource = initialLeaves(byPath, owner.path)[0]
    } else if (ownerNode._tag === "Compound") {
      if (ownerNode.states.some((child) => child.key === ownerNode.initial && child._tag === "Atomic")) {
        expectedMutationSource = `${owner.path}.${ownerNode.initial}`
      }
    } else if (ownerNode._tag === "Parallel") {
      const directAtomic = ownerNode.states.find((child) => child._tag === "Atomic")
      if (directAtomic !== undefined) expectedMutationSource = `${owner.path}.${directAtomic.key}`
    }
    if (
      mutationState?.node._tag !== "Atomic" || scenario.mutation.target !== scenario.mutation.source ||
      scenario.mutation.value === mutationState.node.value || !initiallyActive.has(mutationState.path) ||
      scenario.mutation.source !== expectedMutationSource
    ) {
      throw new Error(`MachineTest.compileModel received invalid history mutation for "${scenario.history}"`)
    }
    if (
      !Array.isArray(scenario.events) || scenario.events.length !== 3 ||
      scenario.resume.target !== scenario.history || scenario.leave.event !== scenario.resume.event ||
      scenario.events[0] !== scenario.mutation.event || scenario.events[1] !== scenario.leave.event ||
      scenario.events[2] !== scenario.resume.event
    ) {
      throw new Error(`MachineTest.compileModel received inconsistent history events for "${scenario.history}"`)
    }
    const expectedOutside = model.roots
      .filter((root) => root.key !== model.initial)
      .find((root) => initialLeaves(byPath, root.key).length > 0)
    if (
      scenario.leave.source !== initialLeaves(byPath, owner.path)[0] ||
      scenario.leave.target !== expectedOutside?.key ||
      scenario.resume.source !==
        (expectedOutside === undefined ? undefined : initialLeaves(byPath, expectedOutside.key)[0])
    ) {
      throw new Error(`MachineTest.compileModel received invalid history transfer for "${scenario.history}"`)
    }
    const expectedTransitions: ReadonlyArray<readonly [FiniteHistoryTransfer | FiniteHistoryMutation, number?]> = [
      [scenario.mutation, scenario.mutation.value],
      [scenario.leave],
      [scenario.resume]
    ]
    if (scenarioEvents.has(scenario.mutation.event) || scenarioEvents.has(scenario.leave.event)) {
      throw new Error(`MachineTest.compileModel received duplicate history scenario event for "${scenario.history}"`)
    }
    scenarioEvents.add(scenario.mutation.event)
    scenarioEvents.add(scenario.leave.event)
    for (const [expected, targetValue] of expectedTransitions) {
      const registration = `${expected.source}\u0000${triggerKey({ type: "event", event: expected.event })}`
      if (scenarioRegistrations.has(registration)) {
        throw new Error(`MachineTest.compileModel received duplicate history witness for "${scenario.history}"`)
      }
      scenarioRegistrations.add(registration)
      const transition = transitionsByRegistration.get(registration)
      if (
        transition?.trigger.type !== "event" || transition.trigger.event !== expected.event ||
        transition.target !== expected.target || !("reenter" in transition) || transition.reenter ||
        transition.targetValue !== targetValue
      ) {
        throw new Error(`MachineTest.compileModel could not replay history scenario for "${scenario.history}"`)
      }
    }
  }
  return flattened
}

const stateTag = (path: string): string => `State_${path.replaceAll(".", "_")}`

const stateValue = (
  state: FlatFiniteState,
  value?: number
): { readonly _tag: string; readonly value: number } => {
  if (state.node._tag === "History" || state.node._tag === "Choice") {
    throw new Error(`MachineTest.compileModel cannot construct a value for pseudo-state "${state.path}"`)
  }
  return { _tag: stateTag(state.path), value: value ?? state.node.value }
}

const runtimeTargetPath = (
  byPath: ReadonlyMap<string, FlatFiniteState>,
  sourcePath: string,
  requestedPath: string
): string => {
  const source = byPath.get(sourcePath)!
  const requested = byPath.get(requestedPath)!
  if (requested.node._tag === "History") return requested.parent!
  if (requested.node._tag === "Choice") return runtimeTargetPath(byPath, sourcePath, requested.node.selected)
  if (source.root !== requested.root) return requested.path

  const initial = (path: string): string => {
    const current = byPath.get(path)!
    if (current.node._tag === "Parallel") {
      if (sourcePath !== current.path && !sourcePath.startsWith(`${current.path}.`)) {
        return current.path
      }
      const child = sourcePath === current.path
        ? current.node.states[0]!.key
        : sourcePath.slice(current.path.length + 1).split(".")[0]!
      return initial(`${current.path}.${child}`)
    }
    return current.node._tag === "Compound" ? initial(`${current.path}.${current.node.initial}`) : current.path
  }
  const inspect = (path: string): string => {
    const current = byPath.get(path)!
    if (
      current.node._tag === "Parallel" && sourcePath !== current.path && !sourcePath.startsWith(`${current.path}.`)
    ) {
      return current.path
    }
    if (current.path === requestedPath) return initial(current.path)
    const next = requestedPath.slice(current.path.length + 1).split(".")[0]!
    return inspect(`${current.path}.${next}`)
  }
  return inspect(source.root)
}

const makeStateTree = (
  states: ReadonlyArray<FiniteState>,
  parent: string | undefined
): Record<string, Machine.Machine.TaggedSchema | Machine.Machine.StateNodeConfig> => {
  const tree: Record<string, Machine.Machine.TaggedSchema | Machine.Machine.StateNodeConfig> = Object.create(null)
  for (const node of states) {
    const path = parent === undefined ? node.key : `${parent}.${node.key}`
    if (node._tag === "History") {
      tree[node.key] = {
        type: "history",
        ...(node.history === "deep" ? { history: "deep" } : {})
      }
      continue
    }
    if (node._tag === "Choice") {
      tree[node.key] = { type: "choice" }
      continue
    }
    const schema = Schema.TaggedStruct(stateTag(path), { value: Schema.Number })
    if (node._tag === "Atomic") {
      tree[node.key] = schema
    } else if (node._tag === "Final") {
      tree[node.key] = { schema, type: "final", output: Schema.Literal(node.output) }
    } else if (node._tag === "Compound") {
      tree[node.key] = {
        schema,
        initial: node.initial,
        states: makeStateTree(node.states, path)
      }
    } else {
      tree[node.key] = {
        schema,
        type: "parallel",
        output: Schema.Literal(node.output),
        states: makeStateTree(node.states, path)
      }
    }
  }
  return tree
}

const selectSnapshot = (
  builder: Record<string, any>,
  path: string,
  byPath: ReadonlyMap<string, FlatFiniteState>,
  requestedParts: ReadonlyArray<string> | undefined,
  index: number,
  sourcePath?: string,
  requestedValue?: number
): unknown => {
  const state = byPath.get(path)!
  if (state.node._tag === "History") {
    throw new Error(`MachineTest.compileModel cannot construct active history state "${path}"`)
  }
  if (state.node._tag === "Choice") {
    return (builder[state.node.key] as () => unknown)()
  }
  const method = builder[state.node.key] as (value: unknown, selector?: (builder: any) => unknown) => unknown
  const value = stateValue(state, path === requestedParts?.join(".") ? requestedValue : undefined)
  if (state.node._tag === "Atomic" || state.node._tag === "Final") return method(value)

  const requestedChild = requestedParts?.[index + 1]
  if (state.node._tag === "Parallel") {
    const parallel = state.node
    const sourceInside = sourcePath === path || sourcePath?.startsWith(`${path}.`) === true
    if (sourceInside) {
      const childKey = requestedChild ?? (sourcePath === path
        ? parallel.states.find((child) => child._tag !== "History" && child._tag !== "Choice")!.key
        : sourcePath!.slice(path.length + 1).split(".")[0]!)
      return method(
        value,
        (children: Record<string, any>) =>
          selectSnapshot(
            children,
            `${path}.${childKey}`,
            byPath,
            requestedChild === undefined ? undefined : requestedParts,
            index + 1,
            sourcePath,
            requestedValue
          )
      )
    }
    return method(value, (children: Record<string, any>) => {
      let selected: unknown = children
      for (const child of parallel.states.filter((child) => child._tag !== "History" && child._tag !== "Choice")) {
        const isRequestedRegion = requestedChild === child.key
        selected = selectSnapshot(
          selected as Record<string, any>,
          `${path}.${child.key}`,
          byPath,
          isRequestedRegion ? requestedParts : undefined,
          index + 1,
          sourcePath,
          requestedValue
        )
      }
      return selected
    })
  }

  const childKey = requestedChild ?? state.node.initial
  const childPath = `${path}.${childKey}`
  return method(
    value,
    (children: Record<string, any>) =>
      selectSnapshot(
        children,
        childPath,
        byPath,
        requestedChild === undefined ? undefined : requestedParts,
        index + 1,
        sourcePath,
        requestedValue
      )
  )
}

const findSnapshot = (snapshot: unknown, path: string): unknown => {
  if (typeof snapshot !== "object" || snapshot === null) return undefined
  const current = snapshot as Record<string, unknown>
  if (current.path === path) return snapshot
  if (current.state !== undefined) {
    const found = findSnapshot(current.state, path)
    if (found !== undefined) return found
  }
  if (typeof current.states === "object" && current.states !== null) {
    for (const child of Object.values(current.states)) {
      const found = findSnapshot(child, path)
      if (found !== undefined) return found
    }
  }
  return undefined
}

const selectHistoryTarget = (builder: Record<string, any>, path: string): unknown => {
  const parts = path.split(".")
  let current: any = builder
  for (let index = 0; index < parts.length - 1; index++) current = current[parts[index]!]
  return current[parts[parts.length - 1]!]()
}

type TargetBuilder = {
  readonly branch: Record<string, any>
  readonly full: Record<string, any>
  readonly history: Record<string, any>
}

const makeHandlers = (
  states: ReadonlyArray<FiniteState>,
  parent: string | undefined,
  byPath: ReadonlyMap<string, FlatFiniteState>,
  transitions: ReadonlyMap<string, FiniteTransition>
): Record<string, unknown> => {
  const handlers: Record<string, unknown> = Object.create(null)
  for (const node of states) {
    const path = parent === undefined ? node.key : `${parent}.${node.key}`
    if (node._tag === "History") continue
    if (node._tag === "Choice") {
      handlers[node.key] = {
        choice: {
          targets: node.targets,
          transition: ({ target }: { readonly target: TargetBuilder }) => {
            const selected = byPath.get(node.selected)!
            const parts = selected.path.split(".")
            const builder = selected.root === byPath.get(path)!.root ? target.branch : target.full
            return selectSnapshot(builder, parts[0]!, byPath, parts, 0, path)
          }
        }
      }
      continue
    }
    if (node._tag === "Final") {
      handlers[node.key] = { output: () => node.output }
      continue
    }
    const on: Record<string, unknown> = Object.create(null)
    let always: unknown
    let onDone: unknown
    for (const transition of transitions.values()) {
      if (transition.source !== path) continue
      const config = {
        ...("reenter" in transition ? { reenter: transition.reenter } : {}),
        ...(transition.target === undefined
          ? {}
          : {
            targets: [
              byPath.get(transition.target)!.node._tag === "History" ||
                byPath.get(transition.target)!.node._tag === "Choice"
                ? transition.target
                : runtimeTargetPath(byPath, path, transition.target)
            ]
          }),
        transition: ({ target }: { readonly target: TargetBuilder }) => {
          if (transition.target === undefined) return undefined
          const targetState = byPath.get(transition.target)!
          if (targetState.node._tag === "History") return selectHistoryTarget(target.history, targetState.path)
          const parts = transition.target.split(".")
          const builder = targetState.root === byPath.get(path)!.root ? target.branch : target.full
          return selectSnapshot(builder, parts[0]!, byPath, parts, 0, path, transition.targetValue)
        }
      }
      if (transition.trigger.type === "event") on[transition.trigger.event] = config
      else if (transition.trigger.type === "always") always = config
      else onDone = config
    }
    const history = node._tag === "Compound" || node._tag === "Parallel"
      ? Object.fromEntries(node.states.flatMap((child) => {
        if (child._tag !== "History") return []
        return [[child.key, {
          default: ({ target }: { readonly target: Record<string, any> }) => {
            const fallback = byPath.get(child.fallback)!
            const parts = child.fallback.split(".")
            const completeRoot = selectSnapshot(target, fallback.root, byPath, parts, 0)
            if (findSnapshot(completeRoot, path) === undefined) {
              throw new Error(
                `MachineTest.compileModel could not construct history fallback for "${path}.${child.key}"`
              )
            }
            return completeRoot
          }
        }]]
      }))
      : {}
    handlers[node.key] = {
      ...(Object.keys(on).length === 0 ? {} : { on }),
      ...(always === undefined ? {} : { always }),
      ...(onDone === undefined ? {} : { onDone }),
      ...(node._tag === "Compound" || node._tag === "Parallel"
        ? {
          ...(node._tag === "Parallel" ? { output: () => node.output } : {}),
          ...(Object.keys(history).length === 0 ? {} : { history }),
          ...(node._tag === "Compound"
            ? {
              initial: () => stateValue(byPath.get(`${path}.${node.initial}`)!)
            }
            : {
              initial: () =>
                Object.fromEntries(
                  node.states
                    .filter((child) => child._tag !== "History" && child._tag !== "Choice")
                    .map((child) => [child.key, stateValue(byPath.get(`${path}.${child.key}`)!)])
                )
            }),
          states: makeHandlers(node.states, path, byPath, transitions)
        }
        : {})
    }
  }
  return handlers
}

/**
 * Compiles a finite model into a real machine using only public definition,
 * construction, and handler APIs.
 *
 * Hand-authored models are validated before compilation. This compiler is a
 * testing adapter, not the independent reference interpreter used by later
 * conformance stages.
 *
 * @category constructors
 * @since 4.0.0
 */
export const compileModel = (model: FiniteModel): Machine.Machine.Any => {
  const flattened = validateModel(model)
  const byPath = new Map(flattened.map((state) => [state.path, state]))
  const stateTree = makeStateTree(model.roots, undefined)
  const defined = Machine.defineStates(stateTree as any)
  const eventSchemas = model.events.map((event) => Schema.TaggedStruct(event, {}))
  const initial = byPath.get(model.initial)!
  const machine = Machine.make({
    states: defined.states as any,
    events: eventSchemas as any,
    initial: () => selectSnapshot(defined.initial as any, initial.path, byPath, [initial.path], 0) as any
  })
  const transitions = new Map(model.transitions.map((transition) => [
    `${transition.source}\u0000${triggerKey(transition.trigger)}`,
    transition
  ]))
  return machine.handle(makeHandlers(model.roots, undefined, byPath, transitions) as any) as Machine.Machine.Any
}
