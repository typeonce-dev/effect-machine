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

export const ChoiceTargetTypeId: unique symbol = Symbol("effect/Machine/ChoiceTarget")

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

/** Internal target produced by a choice target builder. */
export interface ChoiceTarget {
  readonly [ChoiceTargetTypeId]: typeof ChoiceTargetTypeId
  readonly path: string
  readonly parent: string
  readonly values?: Readonly<Record<string, unknown>>
}

export const makeHistoryTarget = (path: string, parent: string): HistoryTarget => ({
  [HistoryTargetTypeId]: HistoryTargetTypeId,
  path,
  parent
})

export const isHistoryTarget = (u: unknown): u is HistoryTarget => hasProperty(u, HistoryTargetTypeId)

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

const dynamicTransitionTargets = { type: "dynamic" } as const

const transitionTargets = (handler: unknown): Machine.TransitionTargets =>
  typeof handler === "object" && handler !== null && "targets" in handler && handler.targets !== undefined
    ? { type: "declared", paths: Array.from(handler.targets as ReadonlyArray<string>) }
    : dynamicTransitionTargets

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
          targets: transitionTargets(choice)
        })
      }
      continue
    }
    for (const event of Reflect.ownKeys(config.on ?? {})) {
      const handler = config.on?.[event]
      definitions.push({
        source: node.path,
        trigger: { type: "event", event },
        reenter: typeof handler === "object" && handler !== null && handler.reenter === true,
        targets: transitionTargets(handler)
      })
    }
    if (config.always !== undefined) {
      definitions.push({
        source: node.path,
        trigger: { type: "always" },
        reenter: false,
        targets: transitionTargets(config.always)
      })
    }
    if (config.onDone !== undefined) {
      definitions.push({
        source: node.path,
        trigger: { type: "done" },
        reenter: false,
        targets: transitionTargets(config.onDone)
      })
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
