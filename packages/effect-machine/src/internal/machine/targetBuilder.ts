/** Constructs decoded snapshots and transition targets from a captured state tree. */
import { hasProperty } from "effect/Predicate"
import type { Machine } from "../../Machine.js"
import { SnapshotBuilderStateTypeId } from "./symbols.js"
import * as Topology from "./topology.js"

type SnapshotBuilderOptions = {
  readonly mode: "initial" | "full"
  readonly prefix: string
}

type FromMethodKind = "leaf" | "nested"

export const withFrom = <Method extends (value: unknown, ...args: ReadonlyArray<any>) => unknown>(
  method: Method,
  kind: FromMethodKind,
  valued: boolean
): {
  readonly decoded?: Method
  readonly from: (...args: ReadonlyArray<any>) => unknown
} => {
  const builder: Record<string, unknown> = {}
  if (valued) {
    Object.defineProperty(builder, "decoded", {
      value: method,
      enumerable: false
    })
  }
  Object.defineProperty(builder, "from", {
    value: (...args: ReadonlyArray<any>) => {
      if (!valued) {
        return method(undefined, ...args)
      }
      const omitted = args.length === 0 || (kind === "nested" && args.length === 1 && typeof args[0] === "function")
      const input = omitted ? {} : args[0]
      const rest = omitted ? args : args.slice(1)
      return method(Topology.makeStateInput(input), ...rest)
    },
    enumerable: false
  })
  return builder as {
    readonly decoded?: Method
    readonly from: (...args: ReadonlyArray<any>) => unknown
  }
}

const withInitial = <Builder extends object>(
  builder: Builder,
  path: string,
  valued: boolean,
  values?: Readonly<Record<string, unknown>>
): Builder => {
  const initial = withFrom(
    (value: unknown) => Topology.makeInitialTarget(path, value, values),
    "leaf",
    valued
  )
  Object.defineProperty(builder, "initial", {
    value: initial,
    enumerable: false
  })
  return builder
}

export const makeSnapshotBuilder = (
  states: Machine.StateTree,
  options: SnapshotBuilderOptions
): unknown => {
  const builder: Record<string, unknown> = {}
  for (const key of Object.keys(states)) {
    const definition = states[key]!
    const pseudoType = (definition as { readonly type?: unknown }).type
    if (pseudoType === "history") {
      continue
    }
    const path = options.prefix === "" ? key : `${options.prefix}.${key}`
    if (pseudoType === "choice") {
      builder[key] = () => Topology.makeChoiceTarget(path, getParentPathRuntime(path))
      continue
    }
    const node = Topology.getStateNodeDefinition(path, definition)
    const method = withFrom(
      (value: unknown, selector?: (builder: unknown) => unknown) =>
        makeSnapshotForNode(definition, key, value, selector, options),
      node.states === undefined ? "leaf" : "nested",
      node.schema !== undefined
    )
    builder[key] = node.states === undefined || options.mode !== "full" || options.prefix !== ""
      ? method
      : withInitial(method, path, node.schema !== undefined)
  }
  return builder
}

const makeParallelSnapshotBuilder = (
  states: Machine.StateTree,
  options: SnapshotBuilderOptions,
  regions: Readonly<Record<string, unknown>>
): unknown => {
  const builder: Record<string, unknown> = {}
  Object.defineProperty(builder, SnapshotBuilderStateTypeId, {
    value: regions,
    enumerable: false
  })
  for (const key of Object.keys(states)) {
    const definition = states[key]!
    const pseudoType = (definition as { readonly type?: unknown }).type
    if (pseudoType === "history" || pseudoType === "choice") {
      continue
    }
    if (hasProperty(regions, key)) {
      continue
    }
    const path = options.prefix === "" ? key : `${options.prefix}.${key}`
    const node = Topology.getStateNodeDefinition(path, definition)
    const method = withFrom(
      (value: unknown, selector?: (builder: unknown) => unknown) => {
        const nextRegions: Record<string, unknown> = {}
        for (const regionKey of Object.keys(regions)) {
          nextRegions[regionKey] = regions[regionKey]
        }
        nextRegions[key] = makeSnapshotForNode(definition, key, value, selector, options)
        return makeParallelSnapshotBuilder(states, options, nextRegions)
      },
      node.states === undefined ? "leaf" : "nested",
      node.schema !== undefined
    )
    builder[key] = method
  }
  return builder
}

const getParallelSnapshotBuilderRegions = (
  path: string,
  states: Machine.StateTree,
  builder: unknown
): Readonly<Record<string, unknown>> => {
  if (typeof builder !== "object" || builder === null || !hasProperty(builder, SnapshotBuilderStateTypeId)) {
    throw new Error(`Machine expected parallel state "${path}" builder callback to return a builder`)
  }
  const regions = (builder as { readonly [SnapshotBuilderStateTypeId]: Readonly<Record<string, unknown>> })[
    SnapshotBuilderStateTypeId
  ]
  for (const key of Object.keys(states)) {
    const pseudoType = (states[key] as { readonly type?: unknown }).type
    if (pseudoType === "history" || pseudoType === "choice") {
      continue
    }
    if (!hasProperty(regions, key)) {
      throw new Error(`Machine expected parallel state "${path}" builder callback to provide region "${key}"`)
    }
  }
  return regions
}

const makeSnapshotForNode = (
  definition: Machine.TaggedSchema | Machine.StateNodeConfig,
  key: string,
  value: unknown,
  selector: ((builder: unknown) => unknown) | undefined,
  options: SnapshotBuilderOptions
): Record<string, unknown> => {
  const path = options.prefix === "" ? key : `${options.prefix}.${key}`
  const node = Topology.getStateNodeDefinition(path, definition)
  const snapshot: Record<string, unknown> = {
    path,
    value
  }
  if (node.states === undefined) {
    return snapshot
  }
  if (selector === undefined) {
    throw new Error(`Machine expected state "${path}" builder to provide active child states`)
  }
  if (node.type === "parallel") {
    const builder = makeParallelSnapshotBuilder(node.states, { ...options, prefix: path }, {})
    const selected = selector(builder)
    snapshot.states = getParallelSnapshotBuilderRegions(path, node.states, selected)
    return snapshot
  }
  const childStates = options.mode === "initial" && node.initial !== undefined
    ? { [node.initial]: node.states[node.initial]! }
    : node.states
  const selected = selector(makeSnapshotBuilder(childStates, { ...options, prefix: path }))
  snapshot.state = selected
  return snapshot
}

export const getTargetBuilderNode = (
  stateNodes: Machine.StateNodes,
  path: string
): Machine.StateNode => {
  const node = stateNodes.byPath.get(path)
  if (node === undefined) {
    throw new Error(`Machine expected state path "${path}" to exist`)
  }
  return node
}

export const getLocalTargetScope = (
  stateNodes: Machine.StateNodes,
  source: string
): string | undefined => {
  let current: string | undefined = source
  while (current !== undefined) {
    const node = stateNodes.byPath.get(current)
    if (node === undefined) {
      return undefined
    }
    if (node.type === "compound") {
      return node.path
    }
    current = node.parent
  }
  return undefined
}

const hasTargetValues = (
  values: Readonly<Record<string, unknown>> | undefined
): values is Readonly<Record<string, unknown>> => values !== undefined && Object.keys(values).length > 0

const makeTargetWithValues = (
  path: string,
  value: unknown,
  values: Readonly<Record<string, unknown>> | undefined
): Machine.Target<any, any> =>
  hasTargetValues(values)
    ? Topology.makeTarget(path as any, value as any, { values: values as any })
    : Topology.makeTarget(path as any, value as any)

const getTargetBuilderDefinition = (
  states: Machine.StateTree,
  targetPath: string
): Machine.TaggedSchema | Machine.StateNodeConfig => {
  let children = states
  let path = ""
  let definition: Machine.TaggedSchema | Machine.StateNodeConfig | undefined
  for (const key of targetPath.split(".")) {
    if (!hasProperty(children, key)) {
      throw new Error(`Machine expected state path "${targetPath}" to exist`)
    }
    definition = children[key]!
    path = path === "" ? key : `${path}.${key}`
    const node = Topology.getStateNodeDefinition(path, definition)
    children = node.states ?? {}
  }
  return definition!
}

const makeParallelTarget = (
  states: Machine.StateTree,
  node: Machine.StateNode,
  value: unknown,
  selector: ((builder: unknown) => unknown) | undefined,
  values: Readonly<Record<string, unknown>> | undefined
): Machine.Target<any, any> => {
  if (selector === undefined) {
    throw new Error(`Machine expected parallel target "${node.path}" builder to provide every active region`)
  }
  const snapshot = makeSnapshotForNode(
    getTargetBuilderDefinition(states, node.path),
    node.key,
    value,
    selector,
    { mode: "full", prefix: node.parent ?? "" }
  )
  return Topology.makeTarget(node.path as any, value as any, {
    snapshot: snapshot as any,
    values: values as any
  })
}

const extendTargetValues = (
  values: Readonly<Record<string, unknown>> | undefined,
  path: string,
  value: unknown
): Readonly<Record<string, unknown>> => {
  const next: Record<string, unknown> = {}
  if (values !== undefined) {
    for (const key of Object.keys(values)) {
      next[key] = values[key]
    }
  }
  next[path] = value
  return next
}

const makeLocalTargetChildBuilder = (
  states: Machine.StateTree,
  stateNodes: Machine.StateNodes,
  parentPath: string,
  values: Readonly<Record<string, unknown>> | undefined,
  source: string
): unknown => {
  const parent = getTargetBuilderNode(stateNodes, parentPath)
  const builder: Record<string, unknown> = {}
  for (
    const childPath of Array.from(stateNodes.byPath.values())
      .filter((node) => node.parent === parent.path && node.type !== "history")
      .map((node) => node.path)
  ) {
    const child = getTargetBuilderNode(stateNodes, childPath)
    if (child.type === "choice") {
      builder[child.key] = () => Topology.makeChoiceTarget(child.path, parent.path, values)
      continue
    }
    const method = withFrom(
      (value: unknown, selector?: (builder: unknown) => unknown) => {
        if (child.type === "atomic" || child.type === "final") {
          return makeTargetWithValues(child.path, value, values)
        }
        if (child.type === "parallel") {
          if (source !== child.path && !source.startsWith(`${child.path}.`)) {
            return makeParallelTarget(states, child, value, selector, values)
          }
          if (selector === undefined) {
            throw new Error(`Machine expected target "${child.path}" builder to provide an active child state`)
          }
          return selector(makeLocalTargetChildBuilder(
            states,
            stateNodes,
            child.path,
            child.schema === undefined ? values : extendTargetValues(values, child.path, value),
            source
          ))
        }
        if (selector === undefined) {
          throw new Error(`Machine expected target "${child.path}" builder to provide an active child state`)
        }
        return selector(makeLocalTargetChildBuilder(
          states,
          stateNodes,
          child.path,
          child.schema === undefined ? values : extendTargetValues(values, child.path, value),
          source
        ))
      },
      child.type === "atomic" || child.type === "final" ? "leaf" : "nested",
      child.schema !== undefined
    )
    builder[child.key] = child.type === "atomic" || child.type === "final"
      ? method
      : withInitial(method, child.path, child.schema !== undefined, values)
  }
  return builder
}

const makeLocalTargetBuilder = (
  states: Machine.StateTree,
  stateNodes: Machine.StateNodes,
  source: string
): unknown => {
  const scope = getLocalTargetScope(stateNodes, source)
  if (scope === undefined) {
    return {}
  }
  const builder = makeLocalTargetChildBuilder(states, stateNodes, scope, undefined, source) as Record<string, unknown>
  const scopeNode = getTargetBuilderNode(stateNodes, scope)
  if (scopeNode.schema !== undefined) {
    builder.with = withFrom(
      (value: unknown, selector?: (builder: unknown) => unknown) => {
        if (selector === undefined) {
          throw new Error(`Machine expected target "${scope}" builder to provide an active child state`)
        }
        return selector(makeLocalTargetChildBuilder(states, stateNodes, scope, { [scope]: value }, source))
      },
      "nested",
      true
    )
  }
  return builder
}

const addBranchTargetChildren = (
  builder: Record<string, unknown>,
  states: Machine.StateTree,
  stateNodes: Machine.StateNodes,
  parentPath: string,
  values: Readonly<Record<string, unknown>> | undefined,
  source: string
): void => {
  const parent = getTargetBuilderNode(stateNodes, parentPath)
  for (
    const childPath of Array.from(stateNodes.byPath.values())
      .filter((node) => node.parent === parent.path && node.type !== "history")
      .map((node) => node.path)
  ) {
    const child = getTargetBuilderNode(stateNodes, childPath)
    if (child.type === "choice") {
      builder[child.key] = () => Topology.makeChoiceTarget(child.path, parent.path, values)
      continue
    }
    builder[child.key] = makeBranchTargetNodeBuilder(states, stateNodes, child.path, values, source)
  }
}

const makeBranchTargetNodeBuilder = (
  states: Machine.StateTree,
  stateNodes: Machine.StateNodes,
  path: string,
  values: Readonly<Record<string, unknown>> | undefined,
  source: string
): unknown => {
  const node = getTargetBuilderNode(stateNodes, path)
  if (node.type === "atomic" || node.type === "final") {
    return withFrom(
      (value: unknown) => makeTargetWithValues(node.path, value, values),
      "leaf",
      node.schema !== undefined
    )
  }
  const builder = withFrom(
    (value: unknown, selector?: (builder: unknown) => unknown) => {
      if (node.type === "parallel") {
        if (source !== node.path && !source.startsWith(`${node.path}.`)) {
          return makeParallelTarget(states, node, value, selector, values)
        }
        if (selector === undefined) {
          throw new Error(`Machine expected target "${node.path}" builder to provide an active child state`)
        }
        const nextBuilder: Record<string, unknown> = {}
        addBranchTargetChildren(
          nextBuilder,
          states,
          stateNodes,
          node.path,
          node.schema === undefined ? values : extendTargetValues(values, node.path, value),
          source
        )
        return selector(nextBuilder)
      }
      if (selector === undefined) {
        throw new Error(`Machine expected target "${node.path}" builder to provide an active child state`)
      }
      const nextBuilder: Record<string, unknown> = {}
      addBranchTargetChildren(
        nextBuilder,
        states,
        stateNodes,
        node.path,
        node.schema === undefined ? values : extendTargetValues(values, node.path, value),
        source
      )
      return selector(nextBuilder)
    },
    "nested",
    node.schema !== undefined
  ) as unknown as Record<string, unknown>
  withInitial(builder, node.path, node.schema !== undefined, values)
  if (node.type !== "parallel" || source === node.path || source.startsWith(`${node.path}.`)) {
    addBranchTargetChildren(builder, states, stateNodes, node.path, values, source)
  }
  return builder
}

const makeBranchTargetBuilder = (
  states: Machine.StateTree,
  stateNodes: Machine.StateNodes,
  source: string
): unknown => {
  const rootPath = source.split(".")[0]!
  const root = getTargetBuilderNode(stateNodes, rootPath)
  return {
    [root.key]: makeBranchTargetNodeBuilder(states, stateNodes, root.path, undefined, source)
  }
}

const makeHistoryTargetBuilder = (
  states: Machine.StateTree,
  prefix: string
): unknown => {
  const builder: Record<string, unknown> = {}
  for (const key of Object.keys(states)) {
    const path = prefix === "" ? key : `${prefix}.${key}`
    const definition = Topology.getStateNodeDefinition(path, states[key]!)
    if (definition.type === "history") {
      const parent = getParentPathRuntime(path)
      builder[key] = () => Topology.makeHistoryTarget(path, parent)
      continue
    }
    if (definition.states !== undefined) {
      builder[key] = makeHistoryTargetBuilder(definition.states, path)
    }
  }
  return builder
}

const getParentPathRuntime = (path: string): string => {
  const separator = path.lastIndexOf(".")
  if (separator < 0) {
    throw new Error(`Machine expected history state "${path}" to have an active parent`)
  }
  return path.slice(0, separator)
}

export const makeTargetBuilder = <const States extends Machine.StateSchemas>(
  states: States,
  stateNodes: Machine.StateNodes
) => {
  const full = makeSnapshotBuilder(states, { mode: "full", prefix: "" }) as Machine.FullTargetBuilder<States>
  const history = makeHistoryTargetBuilder(states, "") as Machine.HistoryTargetBuilder<States>
  return <Source extends Machine.StateNodeIdentifier<States>>(source: Source): Machine.TargetBuilder<States, Source> =>
    ({
      none: Topology.makeNoTarget,
      local: makeLocalTargetBuilder(states, stateNodes, source),
      branch: makeBranchTargetBuilder(states, stateNodes, source),
      full,
      history
    }) as Machine.TargetBuilder<States, Source>
}
