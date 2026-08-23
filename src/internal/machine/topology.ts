/**
 * Internal machine topology and target helpers.
 *
 * @since 0.4.0
 */

import * as Option from "effect/Option"
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
import type { Machine } from "../../Machine.js"

export const TargetTypeId = "~effect/Machine/Target"

export const TargetSnapshotTypeId: unique symbol = Symbol("effect/Machine/TargetSnapshot")

export const StateInputTypeId: unique symbol = Symbol("effect/Machine/StateInput")

export const StateConstructionTypeId: unique symbol = Symbol("effect/Machine/StateConstruction")

export const HistoryTargetTypeId: unique symbol = Symbol("effect/Machine/HistoryTarget")

export const InitialTargetTypeId: unique symbol = Symbol("effect/Machine/InitialTarget")

export const ChoiceTargetTypeId: unique symbol = Symbol("effect/Machine/ChoiceTarget")

export const NoTargetTypeId: unique symbol = Symbol("effect/Machine/NoTarget")

export const DeclinedTypeId: unique symbol = Symbol("effect/Machine/Declined")

export const TargetSelectionTypeId: unique symbol = Symbol("effect/Machine/TargetSelection")

export const StateUpdateTypeId: unique symbol = Symbol("effect/Machine/StateUpdate")

export const CombinedTargetTypeId: unique symbol = Symbol("effect/Machine/CombinedTarget")

export const SelectedBranchTypeId: unique symbol = Symbol("effect/Machine/SelectedBranch")

interface StateInput {
  readonly [StateInputTypeId]: typeof StateInputTypeId
  readonly input: unknown
}

/** Internal target produced by the history target builder. History nodes are
 * routing instructions and are never part of an active configuration. */
export interface HistoryTarget {
  readonly [HistoryTargetTypeId]: typeof HistoryTargetTypeId
  readonly path: string
  readonly parent: string
}

/** Internal instruction that enters the selected state's declared initial
 * configuration. The planner supplies implicit child values through the
 * owning states' `initialize` handlers. */
export interface InitialTarget {
  readonly [InitialTargetTypeId]: typeof InitialTargetTypeId
  readonly _tag: "InitialTarget"
  readonly path: string
  readonly value: unknown
  readonly values?: Readonly<Record<string, unknown>>
}

/** Internal target produced by a choice target builder. */
export interface ChoiceTarget {
  readonly [ChoiceTargetTypeId]: typeof ChoiceTargetTypeId
  readonly path: string
  readonly parent: string
  readonly values?: Readonly<Record<string, unknown>>
}

/** Internal marker returned by an explicitly targetless transition. */
export interface NoTarget {
  readonly [NoTargetTypeId]: typeof NoTargetTypeId
}

/** Internal marker returned when a declinable transition is not enabled. */
export interface Declined {
  readonly [DeclinedTypeId]: typeof DeclinedTypeId
}

export type TargetSelectionKind = "state" | "initial" | "history" | "choice" | "update" | "none"

export type TargetSelectionScope = "local" | "branch" | "full" | "initial"

/** Immutable destination selected while a machine definition is captured. */
export interface TargetSelection {
  readonly [TargetSelectionTypeId]: typeof TargetSelectionTypeId
  readonly kind: TargetSelectionKind
  readonly scope: TargetSelectionScope | undefined
  readonly path: string | undefined
  readonly updatePath?: string
}

/** One branch selection returned by a compiled branching transition. */
export interface SelectedBranch {
  readonly [SelectedBranchTypeId]: typeof SelectedBranchTypeId
  readonly owner: object
  readonly branchIndex: number
  readonly branchKey: string
  readonly result: unknown
}

export const makeTargetSelection = (
  kind: TargetSelectionKind,
  path?: string,
  scope?: TargetSelectionScope,
  updatePath?: string
): TargetSelection =>
  Object.freeze({
    [TargetSelectionTypeId]: TargetSelectionTypeId as typeof TargetSelectionTypeId,
    kind,
    scope,
    path,
    ...(updatePath === undefined ? {} : { updatePath })
  })

/** Source-independent definition-time selection for an explicitly targetless transition. */
export const noneTargetSelection: TargetSelection = makeTargetSelection("none", undefined, "local")

export const isTargetSelection = (u: unknown): u is TargetSelection => hasProperty(u, TargetSelectionTypeId)

export interface StateUpdate {
  readonly [StateUpdateTypeId]: typeof StateUpdateTypeId
  readonly path: string
  readonly value: unknown
}

export const makeStateUpdate = (path: string, value: unknown): StateUpdate =>
  Object.freeze({
    [StateUpdateTypeId]: StateUpdateTypeId,
    path,
    value
  })

export const isStateUpdate = (u: unknown): u is StateUpdate => hasProperty(u, StateUpdateTypeId)

export interface CombinedTarget {
  readonly [CombinedTargetTypeId]: typeof CombinedTargetTypeId
  readonly target: unknown
  readonly update: StateUpdate
}

export const makeCombinedTarget = (target: unknown, update: StateUpdate): CombinedTarget =>
  Object.freeze({
    [CombinedTargetTypeId]: CombinedTargetTypeId,
    target,
    update
  })

export const isCombinedTarget = (u: unknown): u is CombinedTarget => hasProperty(u, CombinedTargetTypeId)

export const makeSelectedBranch = (
  owner: object,
  branchIndex: number,
  branchKey: string,
  result: unknown
): SelectedBranch =>
  Object.freeze({
    [SelectedBranchTypeId]: SelectedBranchTypeId,
    owner,
    branchIndex,
    branchKey,
    result
  })

export const isSelectedBranch = (u: unknown): u is SelectedBranch => hasProperty(u, SelectedBranchTypeId)

const noTarget = Object.freeze({
  [NoTargetTypeId]: NoTargetTypeId
}) as NoTarget

export const makeNoTarget = (): Machine.NoTarget => noTarget

export const isNoTarget = (u: unknown): u is Machine.NoTarget => hasProperty(u, NoTargetTypeId)

const declined = Object.freeze({
  [DeclinedTypeId]: DeclinedTypeId
}) as Declined

export const makeDeclined = (): Machine.Declined => declined

export const isDeclined = (u: unknown): u is Machine.Declined => hasProperty(u, DeclinedTypeId)

export const makeHistoryTarget = (path: string, parent: string): HistoryTarget => ({
  [HistoryTargetTypeId]: HistoryTargetTypeId,
  path,
  parent
})

export const isHistoryTarget = (u: unknown): u is HistoryTarget => hasProperty(u, HistoryTargetTypeId)

export const makeInitialTarget = (
  path: string,
  value: unknown,
  values?: Readonly<Record<string, unknown>>
): InitialTarget => ({
  [InitialTargetTypeId]: InitialTargetTypeId,
  _tag: "InitialTarget",
  path,
  value,
  ...(values === undefined ? {} : { values })
})

export const isInitialTarget = (u: unknown): u is InitialTarget => hasProperty(u, InitialTargetTypeId)

export const makeChoiceTarget = (
  path: string,
  parent: string,
  values?: Readonly<Record<string, unknown>>
): ChoiceTarget => ({
  [ChoiceTargetTypeId]: ChoiceTargetTypeId,
  path,
  parent,
  ...(values === undefined ? {} : { values })
})

export const isChoiceTarget = (u: unknown): u is ChoiceTarget => hasProperty(u, ChoiceTargetTypeId)

interface NormalizedStateNodeDefinitionBase {
  readonly annotations: Readonly<Machine.StateNodeAnnotations> | undefined
}

type NormalizedStateNodeDefinition =
  | (NormalizedStateNodeDefinitionBase & {
    readonly type: "atomic"
    readonly schema: Machine.TaggedSchema | undefined
    readonly output: undefined
    readonly history: undefined
    readonly initial: undefined
    readonly states: undefined
  })
  | (NormalizedStateNodeDefinitionBase & {
    readonly type: "compound"
    readonly schema: Machine.TaggedSchema | undefined
    readonly output: undefined
    readonly history: undefined
    readonly initial: string
    readonly states: Machine.StateTree
  })
  | (NormalizedStateNodeDefinitionBase & {
    readonly type: "parallel"
    readonly schema: Machine.TaggedSchema | undefined
    readonly output: Schema.Top | undefined
    readonly history: undefined
    readonly initial: undefined
    readonly states: Machine.StateTree
  })
  | (NormalizedStateNodeDefinitionBase & {
    readonly type: "final"
    readonly schema: Machine.TaggedSchema | undefined
    readonly output: Schema.Top | undefined
    readonly history: undefined
    readonly initial: undefined
    readonly states: undefined
  })
  | (NormalizedStateNodeDefinitionBase & {
    readonly type: "history"
    readonly schema: undefined
    readonly output: undefined
    readonly history: "shallow" | "deep"
    readonly initial: undefined
    readonly states: undefined
  })
  | (NormalizedStateNodeDefinitionBase & {
    readonly type: "choice"
    readonly schema: undefined
    readonly output: undefined
    readonly history: undefined
    readonly initial: undefined
    readonly states: undefined
  })

export const getStateNodeDefinition = (
  path: string,
  definition: Machine.TaggedSchema | Machine.StateNodeConfig
): NormalizedStateNodeDefinition => {
  if (!Schema.isSchema(definition) && definition.type === "history") {
    return {
      schema: undefined,
      output: undefined,
      annotations: definition.annotations,
      type: "history",
      history: definition.history === "deep" ? "deep" : "shallow",
      initial: undefined,
      states: undefined
    }
  }
  if (!Schema.isSchema(definition) && definition.type === "choice") {
    return {
      schema: undefined,
      output: undefined,
      annotations: definition.annotations,
      type: "choice",
      history: undefined,
      initial: undefined,
      states: undefined
    }
  }
  if (Schema.isSchema(definition)) {
    return {
      schema: definition,
      output: undefined,
      annotations: Schema.resolveAnnotations(definition),
      type: "atomic",
      history: undefined,
      initial: undefined,
      states: undefined
    }
  }
  const schema = hasProperty(definition, "schema") && Schema.isSchema(definition.schema)
    ? definition.schema as Machine.TaggedSchema
    : undefined
  const annotations = schema === undefined ? definition.annotations : Schema.resolveAnnotations(schema)
  if (definition.type === "parallel" && !hasProperty(definition, "states")) {
    throw new Error(`Machine.make expected parallel state "${path}" to declare child regions`)
  }
  if (hasProperty(definition, "states")) {
    const type: unknown = definition.type
    if (type === "final") {
      throw new Error(`Machine.make expected compound state "${path}" to be active`)
    }
    if (definition.type === "parallel") {
      return {
        schema,
        output: Schema.isSchema(definition.output) ? definition.output : undefined,
        annotations,
        type: "parallel",
        history: undefined,
        initial: undefined,
        states: definition.states
      }
    }
    if (typeof definition.initial !== "string") {
      throw new Error(`Machine.make expected compound state "${path}" to declare an initial child`)
    }
    return {
      schema,
      output: undefined,
      annotations,
      type: "compound",
      history: undefined,
      initial: definition.initial,
      states: definition.states
    }
  }
  const output = Schema.isSchema(definition.output) ? definition.output : undefined
  return definition.type === "final"
    ? {
      schema,
      output,
      annotations,
      type: "final",
      history: undefined,
      initial: undefined,
      states: undefined
    }
    : {
      schema,
      output: undefined,
      annotations,
      type: "atomic",
      history: undefined,
      initial: undefined,
      states: undefined
    }
}

export const compileStateNodes = (states: Machine.StateSchemas): Machine.StateNodes => {
  const byPath = new Map<string, Machine.StateNode>()
  let order = 0

  const compile = (tree: Machine.StateTree, parent: string | undefined): ReadonlyArray<string> => {
    const paths: Array<string> = []
    for (const key of Object.keys(tree)) {
      if (key.includes(".")) {
        throw new Error(`Machine state keys cannot contain ".": "${key}"`)
      }
      const path = parent === undefined ? key : `${parent}.${key}`
      const definition = getStateNodeDefinition(path, tree[key]!)
      let node: Machine.StateNode
      let childStates: Machine.StateTree | undefined
      const base = { path, key, annotations: definition.annotations, order }
      switch (definition.type) {
        case "atomic":
          node = {
            ...base,
            type: "atomic",
            schema: definition.schema,
            output: undefined,
            history: undefined,
            parent,
            children: [],
            initial: undefined
          }
          break
        case "compound":
          node = {
            ...base,
            type: "compound",
            schema: definition.schema,
            output: undefined,
            history: undefined,
            parent,
            children: [],
            initial: `${path}.${definition.initial}`
          }
          childStates = definition.states
          break
        case "parallel":
          node = {
            ...base,
            type: "parallel",
            schema: definition.schema,
            output: definition.output,
            history: undefined,
            parent,
            children: [],
            initial: undefined
          }
          childStates = definition.states
          break
        case "final":
          node = {
            ...base,
            type: "final",
            schema: definition.schema,
            output: definition.output,
            history: undefined,
            parent,
            children: [],
            initial: undefined
          }
          break
        case "history":
          if (parent === undefined) {
            throw new Error(`Machine history state "${path}" must belong to a parent state`)
          }
          node = {
            ...base,
            type: "history",
            schema: undefined,
            output: undefined,
            history: definition.history,
            parent,
            children: [],
            initial: undefined
          }
          break
        case "choice":
          if (parent === undefined) {
            throw new Error(`Machine choice state "${path}" must belong to a parent state`)
          }
          node = {
            ...base,
            type: "choice",
            schema: undefined,
            output: undefined,
            history: undefined,
            parent,
            children: [],
            initial: undefined
          }
          break
      }
      byPath.set(path, node)
      order += 1
      if (definition.type === "history" || definition.type === "choice") {
        continue
      }
      paths.push(path)
      if (childStates !== undefined) {
        const children = compile(childStates, path)
        if (node.type === "compound") {
          if (!children.includes(node.initial) && byPath.get(node.initial)?.type !== "choice") {
            throw new Error(`Machine.make expected compound state "${path}" initial child to exist`)
          }
          node = { ...node, children }
        } else if (node.type === "parallel") {
          node = { ...node, children }
        } else {
          throw new Error(`Machine state "${path}" cannot declare child states`)
        }
        byPath.set(path, node)
      }
    }
    return paths
  }

  return {
    byPath,
    roots: compile(states, undefined)
  } as Machine.StateNodes
}

const transitionBranches = (handler: unknown): ReadonlyArray<Machine.TransitionBranch> =>
  typeof handler === "object" && handler !== null && "branches" in handler && Array.isArray(handler.branches)
    ? Array.from(handler.branches as ReadonlyArray<Machine.TransitionBranch>)
    : []

const transitionAcceptance = (handler: unknown): Machine.TransitionAcceptance =>
  typeof handler === "object" && handler !== null && "declinable" in handler && handler.declinable === true
    ? "declinable"
    : "required"

export const transitionDefinitions = (
  machine: Machine.Any
): ReadonlyArray<Machine.TransitionDefinition> => {
  const definitions: Array<Machine.TransitionDefinition> = []
  for (const node of machine.stateNodes.byPath.values()) {
    const config = machine.handlers[node.path] as Machine.AnyStateConfig | undefined
    if (config === undefined) {
      continue
    }
    if (node.type === "choice") {
      const choice = (config as any).choice
      if (choice !== undefined) {
        definitions.push({
          source: node.path,
          trigger: { type: "choice" },
          reenter: false,
          acceptance: "required",
          branches: transitionBranches(choice)
        })
      }
      continue
    }
    for (const event of Reflect.ownKeys(config.on ?? {})) {
      const handler = config.on?.[event]
      definitions.push({
        source: node.path,
        trigger: { type: "event", event },
        reenter: hasProperty(handler, "reenter") && handler.reenter === true,
        acceptance: transitionAcceptance(handler),
        branches: transitionBranches(handler)
      })
    }
    if (config.always !== undefined) {
      definitions.push({
        source: node.path,
        trigger: { type: "always" },
        reenter: false,
        acceptance: transitionAcceptance(config.always),
        branches: transitionBranches(config.always)
      })
    }
    if (config.onDone !== undefined) {
      definitions.push({
        source: node.path,
        trigger: { type: "done" },
        reenter: false,
        acceptance: transitionAcceptance(config.onDone),
        branches: transitionBranches(config.onDone)
      })
    }
    const invokes = config.invoke === undefined
      ? []
      : Array.isArray(config.invoke)
      ? config.invoke
      : [config.invoke]
    for (const invoke of invokes) {
      const id = "child" in invoke ? String(invoke.child.id) : String(invoke.id)
      for (const outcome of ["element", "done", "failure", "snapshot"] as const) {
        const handler = outcome === "element"
          ? invoke.onElement
          : outcome === "done"
          ? invoke.onDone
          : outcome === "failure"
          ? invoke.onFailure
          : invoke.onSnapshot
        if (handler !== undefined) {
          definitions.push({
            source: node.path,
            trigger: { type: "invoke", id, outcome },
            reenter: typeof handler === "object" && handler !== null && handler.reenter === true,
            acceptance: transitionAcceptance(handler),
            branches: transitionBranches(handler)
          })
        }
      }
    }
  }
  return definitions
}

export const makeTarget = <
  const States extends Machine.StateSchemas,
  const StateId extends Machine.StateIdentifier<States>
>(
  path: StateId,
  value: Machine.StateByIdentifier<States, StateId>,
  options?: {
    readonly snapshot?: Machine.SnapshotByIdentifier<States, StateId>
    readonly values?: Partial<
      {
        readonly [AncestorStateId in Machine.ValuedStateIdentifier<States>]: Machine.StateByIdentifier<
          States,
          AncestorStateId
        >
      }
    >
  }
): Machine.Target<States, StateId> =>
  ({
    [TargetTypeId]: TargetTypeId,
    [TargetSnapshotTypeId]: options?.snapshot,
    path,
    value,
    values: options?.values
  }) as Machine.Target<States, StateId>

export const isTarget = (u: unknown): u is Machine.Target<any, any> => hasProperty(u, TargetTypeId)

export const makeStateInput = (input: unknown): StateInput => ({
  [StateInputTypeId]: StateInputTypeId,
  input
})

export const isStateInput = (u: unknown): u is StateInput => hasProperty(u, StateInputTypeId)

export const isSnapshot = (u: unknown): u is Machine.AtomicSnapshot<string, unknown> =>
  hasProperty(u, "path") && hasProperty(u, "value")

export const getSnapshotByPath = (
  snapshot: Machine.AtomicSnapshot<string, unknown>,
  path: string,
  parents?: Record<string, unknown>
): Option.Option<Machine.AtomicSnapshot<string, unknown>> => {
  if (snapshot.path === path) {
    return Option.some(snapshot)
  }
  if (!path.startsWith(`${snapshot.path}.`)) {
    return Option.none()
  }
  if (parents !== undefined) {
    if (snapshot.value !== undefined) {
      parents[snapshot.path] = snapshot.value
    }
  }
  if (hasProperty(snapshot, "state") && isSnapshot(snapshot.state)) {
    return getSnapshotByPath(snapshot.state, path, parents)
  }
  if (hasProperty(snapshot, "states") && typeof snapshot.states === "object" && snapshot.states !== null) {
    for (const child of Object.values(snapshot.states)) {
      if (isSnapshot(child)) {
        const result = getSnapshotByPath(child, path, parents)
        if (Option.isSome(result)) {
          return result
        }
      }
    }
  }
  return Option.none()
}

export const getNode = (machine: Machine.Any, path: string): Machine.StateNode => {
  const node = machine.stateNodes.byPath.get(path)
  if (node === undefined) {
    throw new Error(`Machine expected state path "${path}" to exist`)
  }
  return node
}

export const getStateNodeSchema = (node: Machine.StateNode): Machine.TaggedSchema => {
  if (node.schema === undefined) {
    throw new Error(`Machine state "${node.path}" has no value schema`)
  }
  return node.schema
}
