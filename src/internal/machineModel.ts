/**
 * Internal machine representation helpers.
 *
 * @since 4.0.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
import type { Machine } from "../Machine.js"
import { MachineSchemaDecodeError, MachineSchemaEncodeError } from "./machineErrors.js"

export const TargetTypeId = "~effect/Machine/Target"
export const TargetSnapshotTypeId: unique symbol = Symbol("effect/Machine/TargetSnapshot")
export const StateInputTypeId: unique symbol = Symbol("effect/Machine/StateInput")
export const StateConstructionTypeId: unique symbol = Symbol("effect/Machine/StateConstruction")
export const HistoryTargetTypeId: unique symbol = Symbol("effect/Machine/HistoryTarget")

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

export interface HistoryRecord {
  readonly mode: "shallow" | "deep"
  readonly parent: string
  readonly active: ReadonlySet<string>
  readonly values: ReadonlyMap<string, unknown>
}

const validateHistoryRecordControl = (machine: Machine.Any, record: HistoryRecord): void => {
  const ancestry = new Set(getPathToRoot(machine, record.parent))
  const visit = (path: string): void => {
    const node = getNode(machine, path)
    if (node.type === "compound") {
      const children = node.children.filter((child) => record.active.has(child))
      if (children.length !== 1) {
        throw new Error(`Machine history expected compound state "${path}" to retain one active child`)
      }
      if (record.mode === "deep") visit(children[0])
      return
    }
    if (node.type === "parallel") {
      for (const child of node.children) {
        if (!record.active.has(child)) {
          throw new Error(`Machine history expected parallel state "${path}" to retain region "${child}"`)
        }
        if (record.mode === "deep") visit(child)
      }
    }
  }
  visit(record.parent)
  for (const path of record.active) {
    if (!ancestry.has(path) && !isPathInSubtree(path, record.parent)) {
      throw new Error(`Machine history contains state "${path}" outside parent "${record.parent}"`)
    }
    if (
      record.mode === "shallow" && isDescendantOf(path, record.parent) &&
      getNode(machine, path).parent !== record.parent
    ) {
      throw new Error(`Machine shallow history contains deep descendant "${path}"`)
    }
  }
}

type SnapshotWithHistory = Machine.AtomicSnapshot<string, unknown> & {
  readonly history?: Readonly<Record<string, {
    readonly mode: "shallow" | "deep"
    readonly active: ReadonlyArray<string>
    readonly values: Readonly<Record<string, unknown>>
  }>>
}

const historyFromSnapshot = (
  machine: Machine.Any,
  snapshot: SnapshotWithHistory
): ReadonlyMap<string, HistoryRecord> => {
  const history = new Map<string, HistoryRecord>()
  for (const [path, entry] of Object.entries(snapshot.history ?? {})) {
    const historyNode = getNode(machine, path)
    if (historyNode.type !== "history" || historyNode.parent === undefined || historyNode.history !== entry.mode) {
      throw new Error(`Machine snapshot contains invalid history record "${path}"`)
    }
    const active = new Set<string>()
    const values = new Map<string, unknown>()
    for (const activePath of entry.active) {
      if (active.has(activePath) || !Object.prototype.hasOwnProperty.call(entry.values, activePath)) {
        throw new Error(`Machine snapshot contains invalid remembered state "${activePath}"`)
      }
      const node = getNode(machine, activePath)
      if (
        node.type === "history" ||
        !(isPathInSubtree(activePath, historyNode.parent) || getPathToRoot(machine, historyNode.parent).includes(activePath)) ||
        !Schema.is(getStateNodeSchema(node))(entry.values[activePath])
      ) {
        throw new Error(`Machine snapshot contains invalid remembered value for "${activePath}"`)
      }
      active.add(activePath)
      values.set(activePath, entry.values[activePath])
    }
    if (!active.has(historyNode.parent) || Object.keys(entry.values).length !== active.size) {
      throw new Error(`Machine snapshot contains incomplete history record "${path}"`)
    }
    history.set(path, {
      mode: entry.mode,
      parent: historyNode.parent,
      active,
      values
    })
    validateHistoryRecordControl(machine, history.get(path)!)
  }
  return history
}

const historyFromSnapshotEffect = Effect.fnUntraced(function*(
  machine: Machine.Any,
  snapshot: SnapshotWithHistory
) {
  const history = new Map<string, HistoryRecord>()
  for (const [path, entry] of Object.entries(snapshot.history ?? {})) {
    const historyNode = machine.stateNodes.byPath.get(path)
    if (
      historyNode === undefined || historyNode.type !== "history" || historyNode.parent === undefined ||
      historyNode.history !== entry.mode
    ) {
      return yield* Effect.fail(new MachineSchemaDecodeError({
        machineId: machine.id,
        boundary: "history",
        state: path,
        cause: Cause.die(new Error(`Machine snapshot contains invalid history record "${path}"`))
      }))
    }
    const active = new Set<string>()
    const values = new Map<string, unknown>()
    for (const activePath of entry.active) {
      const node = machine.stateNodes.byPath.get(activePath)
      if (
        active.has(activePath) || node === undefined || node.type === "history" ||
        !Object.prototype.hasOwnProperty.call(entry.values, activePath) ||
        !(isPathInSubtree(activePath, historyNode.parent) || getPathToRoot(machine, historyNode.parent).includes(activePath))
      ) {
        return yield* Effect.fail(new MachineSchemaDecodeError({
          machineId: machine.id,
          boundary: "history",
          state: activePath,
          cause: Cause.die(new Error(`Machine snapshot contains invalid remembered state "${activePath}"`))
        }))
      }
      active.add(activePath)
      values.set(
        activePath,
        yield* decodeBoundary(machine, getStateNodeSchema(node), entry.values[activePath], {
          boundary: "history",
          state: activePath
        })
      )
    }
    if (!active.has(historyNode.parent) || Object.keys(entry.values).length !== active.size) {
      return yield* Effect.fail(new MachineSchemaDecodeError({
        machineId: machine.id,
        boundary: "history",
        state: path,
        cause: Cause.die(new Error(`Machine snapshot contains incomplete history record "${path}"`))
      }))
    }
    history.set(path, {
      mode: entry.mode,
      parent: historyNode.parent,
      active,
      values
    })
    try {
      validateHistoryRecordControl(machine, history.get(path)!)
    } catch (cause) {
      return yield* Effect.fail(new MachineSchemaDecodeError({
        machineId: machine.id,
        boundary: "history",
        state: path,
        cause: Cause.die(cause)
      }))
    }
  }
  return history
})

const historyToSnapshot = (
  history: ReadonlyMap<string, HistoryRecord>
): Readonly<Record<string, {
  readonly mode: "shallow" | "deep"
  readonly active: ReadonlyArray<string>
  readonly values: Readonly<Record<string, unknown>>
}>> => {
  const entries: Record<string, {
    readonly mode: "shallow" | "deep"
    readonly active: ReadonlyArray<string>
    readonly values: Readonly<Record<string, unknown>>
  }> = {}
  for (const [path, record] of history) {
    entries[path] = {
      mode: record.mode,
      active: Array.from(record.active),
      values: Object.fromEntries(record.values)
    }
  }
  return entries
}

export const makeHistoryTarget = (path: string, parent: string): HistoryTarget => ({
  [HistoryTargetTypeId]: HistoryTargetTypeId,
  path,
  parent
})

export const isHistoryTarget = (u: unknown): u is HistoryTarget => hasProperty(u, HistoryTargetTypeId)

export const getStateNodeDefinition = (
  path: string,
  definition: Machine.TaggedSchema | Machine.StateNodeConfig
): {
  readonly schema: Machine.TaggedSchema | undefined
  readonly output: Schema.Top | undefined
  readonly type: "atomic" | "compound" | "parallel" | "final" | "history"
  readonly initial: string | undefined
  readonly states: Machine.StateTree | undefined
} => {
  if (!Schema.isSchema(definition) && (definition as any).type === "history") {
    return {
      schema: undefined,
      output: undefined,
      type: "history",
      initial: undefined,
      states: undefined
    }
  }
  if (Schema.isSchema(definition)) {
    return {
      schema: definition as Machine.TaggedSchema,
      output: undefined,
      type: "atomic",
      initial: undefined,
      states: undefined
    }
  }
  if (!hasProperty(definition, "schema") || !Schema.isSchema(definition.schema)) {
    throw new Error(`Machine.make expected state "${path}" to be a tagged schema or state node config`)
  }
  if ((definition as any).type === "parallel" && !hasProperty(definition, "states")) {
    throw new Error(`Machine.make expected parallel state "${path}" to declare child regions`)
  }
  if (hasProperty(definition, "states")) {
    if ((definition as any).type === "final") {
      throw new Error(`Machine.make expected compound state "${path}" to be active`)
    }
    if ((definition as any).type === "parallel") {
      return {
        schema: definition.schema as Machine.TaggedSchema,
        output: Schema.isSchema((definition as any).output) ? (definition as any).output as Schema.Top : undefined,
        type: "parallel",
        initial: undefined,
        states: (definition as any).states as Machine.StateTree
      }
    }
    if (typeof (definition as any).initial !== "string") {
      throw new Error(`Machine.make expected compound state "${path}" to declare an initial child`)
    }
    return {
      schema: definition.schema as Machine.TaggedSchema,
      output: undefined,
      type: "compound",
      initial: (definition as any).initial,
      states: (definition as any).states as Machine.StateTree
    }
  }
  return {
    schema: definition.schema as Machine.TaggedSchema,
    output: Schema.isSchema((definition as any).output) ? (definition as any).output as Schema.Top : undefined,
    type: definition.type === "final" ? "final" : "atomic",
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
      const definition = getStateNodeDefinition(path, tree[key])
      const node: Machine.StateNode = {
        path,
        key,
        schema: definition.schema,
        output: definition.output,
        type: definition.type,
        parent,
        children: [] as ReadonlyArray<string>,
        initial: definition.initial === undefined ? undefined : `${path}.${definition.initial}`,
        history: definition.type === "history"
          ? ((tree[key] as any).history === "deep" ? "deep" : "shallow")
          : undefined,
        order
      }
      byPath.set(path, node)
      order += 1
      if (definition.type === "history") {
        if (parent === undefined) {
          throw new Error(`Machine history state "${path}" must belong to a parent state`)
        }
        continue
      }
      paths.push(path)
      if (definition.states !== undefined) {
        const children = compile(definition.states, path)
        if (node.type === "compound" && (node.initial === undefined || !children.includes(node.initial))) {
          throw new Error(`Machine.make expected compound state "${path}" initial child to exist`)
        }
        ;(node as { children: ReadonlyArray<string> }).children = children
      }
    }
    return paths
  }

  return {
    byPath,
    roots: compile(states, undefined)
  } as Machine.StateNodes
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
        readonly [AncestorStateId in Machine.StateIdentifier<States>]: Machine.StateByIdentifier<
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

const isStateInput = (u: unknown): u is StateInput => hasProperty(u, StateInputTypeId)

export const markStateConstruction = <A>(value: A): A => {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.defineProperty(value, StateConstructionTypeId, {
      value: StateConstructionTypeId,
      enumerable: false
    })
  }
  return value
}

export const isStateConstruction = (u: unknown): boolean => hasProperty(u, StateConstructionTypeId)

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
    parents[snapshot.path] = snapshot.value
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

export interface ActiveConfiguration {
  readonly active: ReadonlySet<string>
  readonly values: ReadonlyMap<string, unknown>
  readonly outputs: ReadonlyMap<string, unknown>
  readonly history: ReadonlyMap<string, HistoryRecord>
}

export interface FinalCompletion {
  readonly path: string
  readonly output: unknown
}

export interface DecodeBoundaryOptions {
  readonly boundary: "input" | "event" | "emit" | "state" | "output" | "history" | "configuration"
  readonly state?: string
  readonly event?: string
}

interface CompletionResult extends FinalCompletion {
  readonly isNew: boolean
}

interface MachineProtocolSchemas {
  readonly event: Schema.Top
  readonly emit: Schema.Top
}

const MachineProtocolTypeId = Symbol.for("effect/Machine/protocol")

const getProtocolSchemas = (machine: Machine.Any): MachineProtocolSchemas => {
  const protocol = (machine as any)[MachineProtocolTypeId] as MachineProtocolSchemas | undefined
  if (protocol === undefined) {
    throw new Error("Machine protocol is unavailable")
  }
  return protocol
}

const setProtocolSchemas = (machine: Machine.Any, protocol: MachineProtocolSchemas): void => {
  Object.defineProperty(machine, MachineProtocolTypeId, {
    value: protocol,
    enumerable: false
  })
}

export const setProtocol = (machine: Machine.Any): void => {
  setProtocolSchemas(machine, {
    event: Schema.Union([...machine.events, ...machine.internalEvents]),
    emit: Schema.Union(machine.emits)
  })
}

export const copyProtocol = (source: Machine.Any, target: Machine.Any): void =>
  setProtocolSchemas(target, getProtocolSchemas(source))

export const getEventName = (event: unknown): string | undefined =>
  hasProperty(event, "_tag") ? String(event._tag) : undefined

export const decodeBoundary = <A>(
  machine: Machine.Any,
  schema: Schema.Top,
  value: unknown,
  options: DecodeBoundaryOptions
): Effect.Effect<A, MachineSchemaDecodeError> =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
    Effect.mapError((cause) =>
      new MachineSchemaDecodeError({
        machineId: machine.id,
        boundary: options.boundary,
        cause,
        ...(options.state === undefined ? {} : { state: options.state }),
        ...(options.event === undefined ? {} : { event: options.event })
      })
    )
  ) as Effect.Effect<A, MachineSchemaDecodeError>

export const decodeInput = <Input extends Schema.Top>(
  machine: Machine.Any,
  schema: Input,
  value: unknown
): Effect.Effect<Input["Type"], MachineSchemaDecodeError> =>
  decodeBoundary<Input["Type"]>(machine, schema, value, { boundary: "input" })

export const decodeEvent = <const Events extends ReadonlyArray<Machine.TaggedSchema>>(
  machine: Machine.Any,
  event: unknown
): Effect.Effect<Machine.EventOf<Events>, MachineSchemaDecodeError> => {
  const eventName = getEventName(event)
  return decodeBoundary<Machine.EventOf<Events>>(
    machine,
    getProtocolSchemas(machine).event,
    event,
    eventName === undefined ? { boundary: "event" } : { boundary: "event", event: eventName }
  )
}

export const decodeEmit = <const Emits extends ReadonlyArray<Machine.TaggedSchema>>(
  machine: Machine.Any,
  event: unknown
): Effect.Effect<Machine.EmitOf<Emits>, MachineSchemaDecodeError> => {
  const eventName = getEventName(event)
  return decodeBoundary<Machine.EmitOf<Emits>>(
    machine,
    getProtocolSchemas(machine).emit,
    event,
    eventName === undefined ? { boundary: "emit" } : { boundary: "emit", event: eventName }
  )
}

export const decodeStateValue = (
  machine: Machine.Any,
  node: Machine.StateNode,
  value: unknown
): Effect.Effect<unknown, MachineSchemaDecodeError> =>
  isStateInput(value)
    ? getStateNodeSchema(node).makeEffect(value.input).pipe(
      Effect.mapError((cause) =>
        new MachineSchemaDecodeError({
          machineId: machine.id,
          boundary: "state",
          state: node.path,
          cause
        })
      )
    )
    : decodeBoundary(machine, getStateNodeSchema(node), value, { boundary: "state", state: node.path })

export const decodeOutputValue = (
  machine: Machine.Any,
  node: Machine.StateNode,
  value: unknown
): Effect.Effect<unknown, MachineSchemaDecodeError> =>
  node.output === undefined
    ? Effect.succeed(value)
    : decodeBoundary(machine, node.output, value, { boundary: "output", state: node.path })

export const getNode = (machine: Machine.Any, path: string): Machine.StateNode => {
  const node = machine.stateNodes.byPath.get(path)
  if (node === undefined) {
    throw new Error(`Machine expected state path "${path}" to exist`)
  }
  return node
}

export const getStateNodeSchema = (node: Machine.StateNode): Machine.TaggedSchema => {
  if (node.schema === undefined || node.type === "history") {
    throw new Error(`Machine history state "${node.path}" has no active value schema`)
  }
  return node.schema
}

export const hasOwn = (u: object, key: string): boolean => Object.prototype.hasOwnProperty.call(u, key)

export const isDescendantOf = (path: string, ancestor: string): boolean => path.startsWith(`${ancestor}.`)

export const isPathInSubtree = (path: string, ancestor: string): boolean =>
  path === ancestor || isDescendantOf(path, ancestor)

export const getPathToRoot = (machine: Machine.Any, path: string): ReadonlyArray<string> => {
  const paths: Array<string> = []
  let current: string | undefined = path
  while (current !== undefined) {
    paths.unshift(current)
    current = getNode(machine, current).parent
  }
  return paths
}

export const pathDepth = (machine: Machine.Any, path: string): number => getPathToRoot(machine, path).length

export const compareDocumentOrder = (machine: Machine.Any, left: string, right: string): number =>
  getNode(machine, left).order - getNode(machine, right).order

export const hasActiveChild = (machine: Machine.Any, configuration: ActiveConfiguration, path: string): boolean =>
  getNode(machine, path).children.some((child) => configuration.active.has(child))

export const getActiveLeafPaths = (machine: Machine.Any, configuration: ActiveConfiguration): ReadonlyArray<string> => {
  const leaves = Array.from(configuration.active)
    .filter((path) => !hasActiveChild(machine, configuration, path))
    .sort((left, right) => compareDocumentOrder(machine, left, right))
  if (leaves.length === 0) {
    throw new Error("Machine expected an active leaf state")
  }
  return leaves
}

export const getLeafPath = (machine: Machine.Any, configuration: ActiveConfiguration): string =>
  getActiveLeafPaths(
    machine,
    configuration
  )[0]

export const getActiveLeafPathFrom = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string
): string => {
  const leaves = getActiveLeafPaths(machine, configuration)
    .filter((leaf) => isPathInSubtree(leaf, path))
  if (leaves.length === 0) {
    throw new Error(`Machine expected state "${path}" to have an active leaf state`)
  }
  return leaves[0]
}

export const getRootPath = (machine: Machine.Any, configuration: ActiveConfiguration): string => {
  for (const path of configuration.active) {
    if (getNode(machine, path).parent === undefined) {
      return path
    }
  }
  throw new Error("Machine expected an active root state")
}

export const getActiveValue = (configuration: ActiveConfiguration, path: string): unknown => {
  if (!configuration.values.has(path)) {
    throw new Error(
      `Machine expected active state "${path}" to have a value (available: ${Array.from(configuration.values.keys()).join(", ")})`
    )
  }
  return configuration.values.get(path)
}

export const getParentValues = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string
): Readonly<Record<string, unknown>> => {
  const parents: Record<string, unknown> = {}
  const paths = getPathToRoot(machine, path)
  for (let index = 0; index < paths.length - 1; index++) {
    const parent = paths[index]
    parents[parent] = getActiveValue(configuration, parent)
  }
  return parents
}

export const getParentValue = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string
): unknown => {
  const parent = getNode(machine, path).parent
  return parent === undefined ? undefined : getActiveValue(configuration, parent)
}

export const getInitialEntryPaths = (
  machine: Machine.Any,
  configuration: ActiveConfiguration
): ReadonlyArray<string> => {
  const visit = (path: string): ReadonlyArray<string> => {
    if (!configuration.active.has(path)) {
      return []
    }
    const node = getNode(machine, path)
    return [
      path,
      ...node.children.flatMap(visit)
    ]
  }
  return machine.stateNodes.roots.flatMap(visit)
}

export const snapshotFromPath = <const States extends Machine.StateSchemas>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string
): Machine.SnapshotByIdentifier<States, Machine.StateIdentifier<States>> => {
  const node = getNode(machine, path)
  const snapshot: Record<string, unknown> = {
    path,
    value: getActiveValue(configuration, path)
  }
  if (node.type === "compound") {
    const child = node.children.find((child) => configuration.active.has(child))
    if (child === undefined) {
      throw new Error(`Machine expected compound state "${path}" to have an active child`)
    }
    snapshot.state = snapshotFromPath(machine, configuration, child)
  }
  if (node.type === "parallel") {
    const states: Record<string, unknown> = {}
    for (const child of node.children) {
      if (!configuration.active.has(child)) {
        throw new Error(`Machine expected parallel state "${path}" to have active child region "${child}"`)
      }
      const childNode = getNode(machine, child)
      states[childNode.key] = snapshotFromPath(machine, configuration, child)
    }
    snapshot.states = states
  }
  return snapshot as unknown as Machine.SnapshotByIdentifier<States, Machine.StateIdentifier<States>>
}

export const snapshotFromConfiguration = <const States extends Machine.StateSchemas>(
  machine: Machine.Any,
  configuration: ActiveConfiguration
): Machine.Snapshot<States> => {
  const snapshot = snapshotFromPath<States>(
    machine,
    configuration,
    getRootPath(machine, configuration)
  ) as Machine.Snapshot<States>
  const completed = Array.from(configuration.outputs)
    .map(([path, output]) => ({ path, output }))
  if (completed.length > 0) {
    ;(snapshot as Machine.AtomicSnapshot<string, unknown> & {
      completed: ReadonlyArray<Machine.SnapshotCompletion>
    }).completed = completed
  }
  if (configuration.history.size > 0) {
    Object.assign(snapshot, { history: historyToSnapshot(configuration.history) })
  }
  return snapshot
}

/** Creates a targetable subtree snapshot while carrying machine-level history
 * metadata on that subtree root. This is used when a nested history target
 * must preserve active ancestors and unaffected parallel regions. */
export const snapshotFromConfigurationAtPath = <const States extends Machine.StateSchemas>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string
): Machine.SnapshotByIdentifier<States, Machine.StateIdentifier<States>> => {
  const snapshot = snapshotFromPath<States>(machine, configuration, path)
  if (configuration.history.size > 0) {
    Object.assign(snapshot, { history: historyToSnapshot(configuration.history) })
  }
  return snapshot
}

export const configurationFromSnapshot = (
  machine: Machine.Any,
  snapshot: Machine.AtomicSnapshot<string, unknown>
): ActiveConfiguration => {
  const active = new Set<string>()
  const values = new Map<string, unknown>()
  const snapshotOutputs = snapshot.completed

  const visit = (current: Machine.AtomicSnapshot<string, unknown>): void => {
    const node = getNode(machine, String(current.path))
    if (!Schema.is(getStateNodeSchema(node))(current.value)) {
      throw new Error(`Machine expected snapshot for "${node.path}" to match its schema`)
    }
    active.add(node.path)
    values.set(node.path, current.value)
    if (node.type === "compound") {
      if (!hasProperty(current, "state") || !isSnapshot(current.state)) {
        throw new Error(`Machine expected compound snapshot "${node.path}" to include an active child state`)
      }
      const child = getNode(machine, String(current.state.path))
      if (child.parent !== node.path) {
        throw new Error(`Machine expected snapshot "${child.path}" to be a child of "${node.path}"`)
      }
      visit(current.state)
    }
    if (node.type === "parallel") {
      if (!hasProperty(current, "states") || typeof current.states !== "object" || current.states === null) {
        throw new Error(`Machine expected parallel snapshot "${node.path}" to include active child regions`)
      }
      const states = current.states as Readonly<Record<string, unknown>>
      for (const childPath of node.children) {
        const child = getNode(machine, childPath)
        const childSnapshot = states[child.key]
        if (!hasOwn(states, child.key) || !isSnapshot(childSnapshot)) {
          throw new Error(`Machine expected parallel snapshot "${node.path}" to include region "${child.key}"`)
        }
        const snapshotChild = getNode(machine, String(childSnapshot.path))
        if (snapshotChild.path !== child.path) {
          throw new Error(`Machine expected snapshot "${snapshotChild.path}" to be region "${child.path}"`)
        }
        visit(childSnapshot)
      }
    }
  }

  visit(snapshot)
  const outputs = new Map<string, unknown>()
  if (snapshotOutputs !== undefined) {
    for (const { output, path } of snapshotOutputs) {
      if (active.has(path)) {
        outputs.set(path, output)
      }
    }
  }
  return { active, values, outputs, history: historyFromSnapshot(machine, snapshot) }
}

export const normalizeConfiguration = <const States extends Machine.StateSchemas>(
  machine: Machine.Any,
  state: Machine.Snapshot<States>
): ActiveConfiguration => configurationFromSnapshot(machine, state)

export const configurationFromSnapshotEffect = Effect.fnUntraced(function*(
  machine: Machine.Any,
  snapshot: Machine.AtomicSnapshot<string, unknown>
) {
  const active = new Set<string>()
  const values = new Map<string, unknown>()
  const snapshotOutputs = snapshot.completed

  const visit: (
    current: Machine.AtomicSnapshot<string, unknown>
  ) => Effect.Effect<void, MachineSchemaDecodeError> = Effect.fnUntraced(function*(
    current: Machine.AtomicSnapshot<string, unknown>
  ) {
    const node = getNode(machine, String(current.path))
    const value = yield* decodeStateValue(machine, node, current.value)
    active.add(node.path)
    values.set(node.path, value)
    if (node.type === "compound") {
      if (!hasProperty(current, "state") || !isSnapshot(current.state)) {
        throw new Error(`Machine expected compound snapshot "${node.path}" to include an active child state`)
      }
      const child = getNode(machine, String(current.state.path))
      if (child.parent !== node.path) {
        throw new Error(`Machine expected snapshot "${child.path}" to be a child of "${node.path}"`)
      }
      yield* visit(current.state)
    }
    if (node.type === "parallel") {
      if (!hasProperty(current, "states") || typeof current.states !== "object" || current.states === null) {
        throw new Error(`Machine expected parallel snapshot "${node.path}" to include active child regions`)
      }
      const states = current.states as Readonly<Record<string, unknown>>
      for (const childPath of node.children) {
        const child = getNode(machine, childPath)
        const childSnapshot = states[child.key]
        if (!hasOwn(states, child.key) || !isSnapshot(childSnapshot)) {
          throw new Error(`Machine expected parallel snapshot "${node.path}" to include region "${child.key}"`)
        }
        const snapshotChild = getNode(machine, String(childSnapshot.path))
        if (snapshotChild.path !== child.path) {
          throw new Error(`Machine expected snapshot "${snapshotChild.path}" to be region "${child.path}"`)
        }
        yield* visit(childSnapshot)
      }
    }
  })

  yield* visit(snapshot)
  const outputs = new Map<string, unknown>()
  if (snapshotOutputs !== undefined) {
    for (const { output, path } of snapshotOutputs) {
      if (active.has(path)) {
        outputs.set(path, output)
      }
    }
  }
  return {
    active,
    values,
    outputs,
    history: yield* historyFromSnapshotEffect(machine, snapshot)
  } as ActiveConfiguration
})

export const normalizeConfigurationEffect = <const States extends Machine.StateSchemas>(
  machine: Machine.Any,
  state: Machine.Snapshot<States>
): Effect.Effect<ActiveConfiguration, MachineSchemaDecodeError> =>
  configurationFromSnapshotEffect(machine, state).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.findErrorOption(cause)
      return Option.isSome(error) && error.value instanceof MachineSchemaDecodeError
        ? Effect.fail(error.value)
        : Effect.fail(
          new MachineSchemaDecodeError({
            machineId: machine.id,
            boundary: "configuration",
            cause
          })
        )
    })
  )

export const validateInitialConfiguration = (machine: Machine.Any, configuration: ActiveConfiguration): void => {
  for (const path of configuration.active) {
    const node = getNode(machine, path)
    if (node.type === "compound") {
      const child = node.children.find((child) => configuration.active.has(child))
      if (child !== node.initial) {
        throw new Error(`Machine initial state "${node.path}" must enter initial child "${node.initial}"`)
      }
    }
    if (node.type === "parallel") {
      for (const child of node.children) {
        if (!configuration.active.has(child)) {
          throw new Error(`Machine initial state "${node.path}" must enter child region "${child}"`)
        }
      }
    }
  }
}

/** Capture every history register whose owning parent exits in this microstep.
 * The control record is deliberately independent from effects/actions: it is
 * part of the logical snapshot and is therefore preserved by pure planning. */
export const captureHistory = (
  machine: Machine.Any,
  current: ActiveConfiguration,
  next: ActiveConfiguration,
  exitPaths: ReadonlyArray<string>
): ActiveConfiguration => {
  if (exitPaths.length === 0) {
    return next
  }
  const exited = new Set(exitPaths)
  const history = new Map(next.history)
  for (const node of machine.stateNodes.byPath.values() as Iterable<Machine.StateNode>) {
    if (node.type !== "history" || node.parent === undefined || !exited.has(node.parent)) {
      continue
    }
    const mode = node.history === "deep" ? "deep" : "shallow"
    const active = new Set<string>()
    for (const ancestor of getPathToRoot(machine, node.parent)) {
      if (current.active.has(ancestor)) {
        active.add(ancestor)
      }
    }
    for (const path of current.active) {
      if (
        path === node.parent ||
        (mode === "deep" && isDescendantOf(path, node.parent)) ||
        (mode === "shallow" && getNode(machine, path).parent === node.parent)
      ) {
        active.add(path)
      }
    }
    const values = new Map<string, unknown>()
    for (const path of active) {
      values.set(path, getActiveValue(current, path))
    }
    history.set(node.path, {
      mode,
      parent: node.parent,
      active,
      values
    })
  }
  return {
    active: next.active,
    values: next.values,
    outputs: next.outputs,
    history
  }
}

export const getHistoryRecord = (
  configuration: ActiveConfiguration,
  path: string
): HistoryRecord | undefined => configuration.history.get(path)

/** Builds the remembered portion of a configuration. Shallow records are
 * intentionally incomplete below their direct child; the planner completes
 * them by invoking only the required typed initializers. */
export const configurationFromHistoryRecord = (
  machine: Machine.Any,
  current: ActiveConfiguration,
  record: HistoryRecord
): ActiveConfiguration => {
  const active = new Set(record.active)
  const values = new Map(record.values)
  const outputs = new Map<string, unknown>()
  const ancestors = getPathToRoot(machine, record.parent)
  const ancestorSet = new Set(ancestors)

  // A history transition can occur while an ancestor parallel state remains
  // active. Its unaffected regions retain their current configuration.
  for (const ancestor of ancestors) {
    const node = getNode(machine, ancestor)
    if (node.type !== "parallel") {
      continue
    }
    for (const child of node.children) {
      if (ancestorSet.has(child) || record.active.has(child) || !current.active.has(child)) {
        continue
      }
      for (const path of current.active) {
        if (isPathInSubtree(path, child)) {
          active.add(path)
          if (current.values.has(path)) values.set(path, current.values.get(path))
          if (current.outputs.has(path)) outputs.set(path, current.outputs.get(path))
        }
      }
    }
  }

  return { active, values, outputs, history: current.history }
}

export const configurationFromTargetPathEffect = Effect.fnUntraced(function*(
  machine: Machine.Any,
  current: ActiveConfiguration,
  path: string,
  value: unknown,
  providedValues: Readonly<Record<string, unknown>> | undefined
) {
  const node = getNode(machine, path)
  const active = new Set<string>()
  const values = new Map<string, unknown>()
  const outputs = new Map<string, unknown>()
  const paths = getPathToRoot(machine, node.path)
  const pathSet = new Set(paths)

  for (const currentPath of paths) {
    const currentNode = getNode(machine, currentPath)
    active.add(currentPath)
    if (currentPath === node.path) {
      values.set(currentPath, yield* decodeStateValue(machine, currentNode, value))
    } else if (providedValues !== undefined && hasOwn(providedValues, currentPath)) {
      values.set(currentPath, yield* decodeStateValue(machine, currentNode, providedValues[currentPath]))
    } else if (current.values.has(currentPath)) {
      values.set(currentPath, current.values.get(currentPath))
    } else {
      throw new Error(`Machine target "${node.path}" requires a value for ancestor state "${currentPath}"`)
    }
  }

  for (const ancestor of paths) {
    const ancestorNode = getNode(machine, ancestor)
    if (ancestorNode.type === "parallel") {
      for (const child of ancestorNode.children) {
        if (pathSet.has(child) || !current.active.has(child)) {
          continue
        }
        for (const activePath of current.active) {
          if (isPathInSubtree(activePath, child)) {
            active.add(activePath)
            if (current.values.has(activePath)) {
              values.set(activePath, current.values.get(activePath))
            }
            if (current.outputs.has(activePath)) {
              outputs.set(activePath, current.outputs.get(activePath))
            }
          }
        }
      }
    }
  }

  if (node.type === "compound" || node.type === "parallel") {
    throw new Error(`Machine target "${node.path}" must include an active child state`)
  }

  return {
    active,
    values,
    outputs,
    history: current.history
  } as ActiveConfiguration
})

export const configurationFromTargetSnapshotEffect = Effect.fnUntraced(function*(
  machine: Machine.Any,
  current: ActiveConfiguration,
  snapshot: Machine.AtomicSnapshot<string, unknown>,
  providedValues: Readonly<Record<string, unknown>> | undefined
) {
  const subtree = yield* configurationFromSnapshotEffect(machine, snapshot)
  const active = new Set(subtree.active)
  const values = new Map(subtree.values)
  const outputs = new Map(subtree.outputs)
  const paths = getPathToRoot(machine, String(snapshot.path))
  const pathSet = new Set(paths)

  for (const ancestor of paths.slice(0, -1)) {
    const node = getNode(machine, ancestor)
    active.add(ancestor)
    if (providedValues !== undefined && hasOwn(providedValues, ancestor)) {
      values.set(ancestor, yield* decodeStateValue(machine, node, providedValues[ancestor]))
    } else if (current.values.has(ancestor)) {
      values.set(ancestor, current.values.get(ancestor))
    } else {
      throw new Error(`Machine target "${snapshot.path}" requires a value for ancestor state "${ancestor}"`)
    }
  }

  for (const ancestor of paths.slice(0, -1)) {
    const ancestorNode = getNode(machine, ancestor)
    if (ancestorNode.type === "parallel") {
      for (const child of ancestorNode.children) {
        if (pathSet.has(child) || !current.active.has(child)) {
          continue
        }
        for (const activePath of current.active) {
          if (isPathInSubtree(activePath, child)) {
            active.add(activePath)
            if (current.values.has(activePath)) {
              values.set(activePath, current.values.get(activePath))
            }
            if (current.outputs.has(activePath)) {
              outputs.set(activePath, current.outputs.get(activePath))
            }
          }
        }
      }
    }
  }

  return {
    active,
    values,
    outputs,
    history: new Map([...current.history, ...subtree.history])
  } as ActiveConfiguration
})

export const normalizeTargetConfigurationEffect = <const States extends Machine.StateSchemas>(
  machine: Machine.Any,
  current: ActiveConfiguration,
  target: Machine.Snapshot<States> | Machine.Target<States, Machine.StateIdentifier<States>>
): Effect.Effect<ActiveConfiguration, MachineSchemaDecodeError> => {
  if (isTarget(target)) {
    const snapshot = target[TargetSnapshotTypeId]
    if (snapshot !== undefined) {
      if (String(snapshot.path) !== String(target.path)) {
        throw new Error(`Machine expected target snapshot path to be "${target.path}"`)
      }
      return configurationFromTargetSnapshotEffect(
        machine,
        current,
        snapshot,
        target.values as Readonly<Record<string, unknown>> | undefined
      )
    }
    return configurationFromTargetPathEffect(
      machine,
      current,
      target.path,
      target.value,
      target.values as Readonly<Record<string, unknown>> | undefined
    )
  }
  if (isSnapshot(target)) {
    return normalizeConfigurationEffect(machine, target).pipe(
      Effect.map((configuration) => ({
        ...configuration,
        history: new Map([...current.history, ...configuration.history])
      }))
    )
  }
  throw new Error("Machine expected transition target to be a snapshot or target builder result")
}

export const getStateConfigByPath = (
  machine: Machine.Any,
  path: string
): Machine.AnyStateConfig | undefined => machine.handlers[path]

export const getActiveChildPath = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string
): string | undefined => getNode(machine, path).children.find((child) => configuration.active.has(child))

export const isDirectFinalPath = (
  machine: Machine.Any,
  path: string
): boolean => getNode(machine, path).type === "final"

export const hasCompletionHandler = (
  machine: Machine.Any,
  path: string
): boolean => getStateConfigByPath(machine, path)?.onDone !== undefined

export const isActiveFinalNode = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string
): boolean => {
  if (!configuration.active.has(path)) {
    return false
  }
  const node = getNode(machine, path)
  if (node.type === "compound") {
    const child = getActiveChildPath(machine, configuration, path)
    return child !== undefined && isDirectFinalPath(machine, child)
  }
  if (node.type === "parallel") {
    for (const child of node.children) {
      if (!isActiveFinalNode(machine, configuration, child)) {
        return false
      }
    }
    return true
  }
  return isDirectFinalPath(machine, path)
}

export const isActiveFinalConfiguration = (
  machine: Machine.Any,
  configuration: ActiveConfiguration
): boolean => {
  const root = getRootPath(machine, configuration)
  return isActiveFinalNode(machine, configuration, root) && !hasCompletionHandler(machine, root)
}

export const setCompletedOutput = (
  outputs: Map<string, unknown>,
  path: string,
  output: unknown
): CompletionResult => {
  if (outputs.has(path)) {
    return {
      path,
      output: outputs.get(path),
      isNew: false
    }
  }
  outputs.set(path, output)
  return {
    path,
    output,
    isNew: true
  }
}

export const resolveFinalOutputEffect: <
  const Events extends ReadonlyArray<Machine.TaggedSchema>
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string,
  event: Machine.LifecycleEvent<Events>,
  outputs?: Readonly<Record<string, unknown>>
) => Effect.Effect<unknown, MachineSchemaDecodeError> = Effect.fnUntraced(function*<
  const Events extends ReadonlyArray<Machine.TaggedSchema>
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string,
  event: Machine.LifecycleEvent<Events>,
  outputs?: Readonly<Record<string, unknown>>
) {
  const node = getNode(machine, path)
  const output = getStateConfigByPath(machine, path)?.output?.({
    state: getActiveValue(configuration, path),
    parent: getParentValue(machine, configuration, path),
    parents: getParentValues(machine, configuration, path),
    event,
    outputs
  } as any)
  return yield* decodeOutputValue(machine, node, output)
})

export const completeActiveFinalNodeEffect: <
  const Events extends ReadonlyArray<Machine.TaggedSchema>
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string,
  event: Machine.LifecycleEvent<Events>,
  outputs: Map<string, unknown>,
  completions: Array<FinalCompletion>
) => Effect.Effect<CompletionResult | undefined, MachineSchemaDecodeError> = Effect.fnUntraced(function*<
  const Events extends ReadonlyArray<Machine.TaggedSchema>
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string,
  event: Machine.LifecycleEvent<Events>,
  outputs: Map<string, unknown>,
  completions: Array<FinalCompletion>
) {
  if (!configuration.active.has(path)) {
    return undefined
  }
  if (outputs.has(path)) {
    return {
      path,
      output: outputs.get(path),
      isNew: false
    }
  }
  const node = getNode(machine, path)
  if (node.type === "compound") {
    const child = getActiveChildPath(machine, configuration, path)
    if (child === undefined || !isDirectFinalPath(machine, child)) {
      return undefined
    }
    const childCompletion = yield* completeActiveFinalNodeEffect(
      machine,
      configuration,
      child,
      event,
      outputs,
      completions
    )
    if (childCompletion === undefined) {
      return undefined
    }
    const completion = setCompletedOutput(outputs, path, childCompletion.output)
    if (completion.isNew) {
      completions.push(completion)
    }
    return completion
  }
  if (node.type === "parallel") {
    const regionOutputs: Record<string, unknown> = {}
    let completed = true
    for (const child of node.children) {
      const childCompletion = yield* completeActiveFinalNodeEffect(
        machine,
        configuration,
        child,
        event,
        outputs,
        completions
      )
      if (childCompletion === undefined) {
        completed = false
      } else {
        regionOutputs[getNode(machine, child).key] = childCompletion.output
      }
    }
    if (!completed) {
      return undefined
    }
    const completion = setCompletedOutput(
      outputs,
      path,
      yield* resolveFinalOutputEffect(machine, configuration, path, event, regionOutputs)
    )
    if (completion.isNew) {
      completions.push(completion)
    }
    return completion
  }
  if (!isDirectFinalPath(machine, path)) {
    return undefined
  }
  const completion = setCompletedOutput(
    outputs,
    path,
    yield* resolveFinalOutputEffect(machine, configuration, path, event)
  )
  if (completion.isNew) {
    completions.push(completion)
  }
  return completion
})

export const completeConfigurationEffect: <
  const Events extends ReadonlyArray<Machine.TaggedSchema>
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  event: Machine.LifecycleEvent<Events>
) => Effect.Effect<{
  readonly configuration: ActiveConfiguration
  readonly completions: ReadonlyArray<FinalCompletion>
}, MachineSchemaDecodeError> = Effect.fnUntraced(function*<
  const Events extends ReadonlyArray<Machine.TaggedSchema>
>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  event: Machine.LifecycleEvent<Events>
) {
  const outputs = new Map(configuration.outputs)
  const completions: Array<FinalCompletion> = []
  const completed = {
    active: configuration.active,
    values: configuration.values,
    outputs,
    history: configuration.history
  }
  for (
    const path of Array.from(completed.active).sort((left, right) => {
      const depth = pathDepth(machine, right) - pathDepth(machine, left)
      return depth === 0 ? compareDocumentOrder(machine, left, right) : depth
    })
  ) {
    yield* completeActiveFinalNodeEffect(machine, completed, path, event, outputs, completions)
  }
  return { configuration: completed, completions } as {
    readonly configuration: ActiveConfiguration
    readonly completions: ReadonlyArray<FinalCompletion>
  }
})

const EncodedSnapshotSchema = Schema.Struct({
  _tag: Schema.Literal("MachineSnapshot"),
  active: Schema.Array(Schema.Struct({
    path: Schema.String,
    value: Schema.Unknown
  })),
  completed: Schema.optional(Schema.Array(Schema.Struct({
    path: Schema.String,
    output: Schema.optional(Schema.Unknown)
  }))),
  history: Schema.optional(Schema.Record(Schema.String, Schema.Struct({
    mode: Schema.Literals(["shallow", "deep"]),
    active: Schema.Array(Schema.String),
    values: Schema.Record(Schema.String, Schema.Unknown)
  })))
})

const encodeBoundary = (
  machine: Machine.Any,
  schema: Schema.Top,
  value: unknown,
  options: {
    readonly boundary: "state" | "output" | "history"
    readonly state: string
  }
): Effect.Effect<unknown, MachineSchemaEncodeError, unknown> =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      new MachineSchemaEncodeError({
        machineId: machine.id,
        boundary: options.boundary,
        state: options.state,
        cause
      })
    )
  )

const decodeEncodedBoundary = (
  machine: Machine.Any,
  schema: Schema.Top,
  value: unknown,
  options: {
    readonly boundary: "state" | "output" | "history"
    readonly state: string
  }
): Effect.Effect<unknown, MachineSchemaDecodeError, unknown> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      new MachineSchemaDecodeError({
        machineId: machine.id,
        boundary: options.boundary,
        state: options.state,
        cause
      })
    )
  )

const getCompletionSchema = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string
): Schema.Top => {
  const node = getNode(machine, path)
  if (node.type === "compound") {
    const child = getActiveChildPath(machine, configuration, path)
    if (child === undefined) {
      throw new Error(`Machine expected completed state "${path}" to have an active child`)
    }
    return getCompletionSchema(machine, configuration, child)
  }
  return node.output ?? Schema.Void
}

const validateEncodedConfiguration = (
  machine: Machine.Any,
  configuration: ActiveConfiguration
): Machine.Snapshot<any> => {
  const snapshot = snapshotFromConfiguration(machine, configuration)
  const normalized = configurationFromSnapshot(machine, snapshot)
  if (
    normalized.active.size !== configuration.active.size ||
    Array.from(configuration.active).some((path) => !normalized.active.has(path))
  ) {
    throw new Error("Machine encoded snapshot contains states outside its active configuration")
  }
  return snapshot
}

const failEncodeCause = (
  machine: Machine.Any,
  cause: Cause.Cause<unknown>
): Effect.Effect<never, MachineSchemaEncodeError> => {
  const error = Cause.findErrorOption(cause)
  return Option.isSome(error) && error.value instanceof MachineSchemaEncodeError
    ? Effect.fail(error.value)
    : Effect.fail(
      new MachineSchemaEncodeError({
        machineId: machine.id,
        boundary: "configuration",
        cause
      })
    )
}

const failDecodeCause = (
  machine: Machine.Any,
  cause: Cause.Cause<unknown>
): Effect.Effect<never, MachineSchemaDecodeError> => {
  const error = Cause.findErrorOption(cause)
  return Option.isSome(error) && error.value instanceof MachineSchemaDecodeError
    ? Effect.fail(error.value)
    : Effect.fail(
      new MachineSchemaDecodeError({
        machineId: machine.id,
        boundary: "configuration",
        cause
      })
    )
}

export const encodeSnapshot = (
  machine: Machine.Any,
  snapshot: Machine.Snapshot<any>
): Effect.Effect<Machine.EncodedSnapshot, MachineSchemaEncodeError, unknown> =>
  Effect.gen(function*() {
    const configuration = yield* normalizeConfigurationEffect(machine, snapshot).pipe(
      Effect.mapError((error) =>
        new MachineSchemaEncodeError({
          machineId: machine.id,
          boundary: error.boundary === "state" || error.boundary === "history" ? error.boundary : "configuration",
          ...(error.state === undefined ? {} : { state: error.state }),
          cause: error.cause
        })
      )
    )
    const completionPaths = new Set<string>()
    for (const completion of snapshot.completed ?? []) {
      if (completionPaths.has(completion.path)) {
        throw new Error(`Machine snapshot contains duplicate completion "${completion.path}"`)
      }
      if (!configuration.active.has(completion.path) || !isActiveFinalNode(machine, configuration, completion.path)) {
        throw new Error(`Machine snapshot contains invalid completion "${completion.path}"`)
      }
      completionPaths.add(completion.path)
    }
    const active: Array<Machine.EncodedSnapshotState> = []
    for (
      const path of Array.from(configuration.active).sort((left, right) => compareDocumentOrder(machine, left, right))
    ) {
      const node = getNode(machine, path)
      active.push({
        path,
        value: yield* encodeBoundary(machine, getStateNodeSchema(node), getActiveValue(configuration, path), {
          boundary: "state",
          state: path
        })
      })
    }

    const completed: Array<Machine.EncodedSnapshotCompletion> = []
    for (
      const [path, output] of Array.from(configuration.outputs).sort(([left], [right]) =>
        compareDocumentOrder(machine, left, right)
      )
    ) {
      if (!configuration.active.has(path) || !isActiveFinalNode(machine, configuration, path)) {
        throw new Error(`Machine encoded snapshot contains invalid completion "${path}"`)
      }
      const encodedOutput = yield* encodeBoundary(
        machine,
        getCompletionSchema(machine, configuration, path),
        output,
        {
          boundary: "output",
          state: path
        }
      )
      completed.push({
        path,
        ...(encodedOutput === undefined ? {} : { output: encodedOutput })
      })
    }

    const history: Record<string, Machine.EncodedSnapshotHistoryEntry> = {}
    for (const [historyPath, record] of Array.from(configuration.history).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      const historyNode = machine.stateNodes.byPath.get(historyPath)
      if (
        historyNode === undefined || historyNode.type !== "history" || historyNode.parent !== record.parent ||
        historyNode.history !== record.mode
      ) {
        return yield* Effect.fail(
          new MachineSchemaEncodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(new Error(`Machine snapshot contains invalid history record "${historyPath}"`))
          })
        )
      }
      try {
        validateHistoryRecordControl(machine, record)
      } catch (cause) {
        return yield* Effect.fail(
          new MachineSchemaEncodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(cause)
          })
        )
      }
      const encodedValues: Record<string, unknown> = {}
      for (const path of record.active) {
        const stateNode = machine.stateNodes.byPath.get(path)
        if (
          stateNode === undefined || stateNode.type === "history" || !record.values.has(path) ||
          !(isPathInSubtree(path, record.parent) || getPathToRoot(machine, record.parent).includes(path))
        ) {
          return yield* Effect.fail(
            new MachineSchemaEncodeError({
              machineId: machine.id,
              boundary: "history",
              state: path,
              cause: Cause.die(new Error(`Machine snapshot contains invalid remembered state "${path}"`))
            })
          )
        }
        encodedValues[path] = yield* encodeBoundary(
          machine,
          getStateNodeSchema(stateNode),
          record.values.get(path),
          { boundary: "history", state: path }
        )
      }
      if (record.values.size !== record.active.size) {
        return yield* Effect.fail(
          new MachineSchemaEncodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(new Error(`Machine history record "${historyPath}" contains values outside its paths`))
          })
        )
      }
      history[historyPath] = {
        mode: record.mode,
        active: Array.from(record.active).sort((left, right) => compareDocumentOrder(machine, left, right)),
        values: encodedValues
      }
    }

    return {
      _tag: "MachineSnapshot" as const,
      active,
      ...(completed.length === 0 ? {} : { completed }),
      ...(Object.keys(history).length === 0 ? {} : { history })
    }
  }).pipe(Effect.catchCause((cause) => failEncodeCause(machine, cause)))

export const decodeSnapshot = (
  machine: Machine.Any,
  encoded: unknown
): Effect.Effect<Machine.Snapshot<any>, MachineSchemaDecodeError, unknown> =>
  Effect.gen(function*() {
    const decoded = yield* Schema.decodeUnknownEffect(EncodedSnapshotSchema)(encoded).pipe(
      Effect.mapError((cause) =>
        new MachineSchemaDecodeError({
          machineId: machine.id,
          boundary: "configuration",
          cause
        })
      )
    )
    const active = new Set<string>()
    const values = new Map<string, unknown>()
    for (const entry of decoded.active) {
      if (active.has(entry.path)) {
        throw new Error(`Machine encoded snapshot contains duplicate state "${entry.path}"`)
      }
      const node = getNode(machine, entry.path)
      active.add(entry.path)
      values.set(
        entry.path,
        yield* decodeEncodedBoundary(machine, getStateNodeSchema(node), entry.value, {
          boundary: "state",
          state: entry.path
        })
      )
    }

    const history = new Map<string, HistoryRecord>()
    for (const [historyPath, encodedRecord] of Object.entries(decoded.history ?? {})) {
      const historyNode = machine.stateNodes.byPath.get(historyPath)
      if (
        historyNode === undefined || historyNode.type !== "history" || historyNode.parent === undefined ||
        historyNode.history !== encodedRecord.mode
      ) {
        return yield* Effect.fail(
          new MachineSchemaDecodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(new Error(`Machine encoded snapshot contains invalid history record "${historyPath}"`))
          })
        )
      }
      const rememberedActive = new Set<string>()
      const rememberedValues = new Map<string, unknown>()
      for (const path of encodedRecord.active) {
        if (rememberedActive.has(path)) {
          return yield* Effect.fail(
            new MachineSchemaDecodeError({
              machineId: machine.id,
              boundary: "history",
              state: path,
              cause: Cause.die(new Error(`Machine encoded history contains duplicate state "${path}"`))
            })
          )
        }
        const stateNode = machine.stateNodes.byPath.get(path)
        if (
          stateNode === undefined || stateNode.type === "history" ||
          !Object.prototype.hasOwnProperty.call(encodedRecord.values, path) ||
          !(isPathInSubtree(path, historyNode.parent) || getPathToRoot(machine, historyNode.parent).includes(path))
        ) {
          return yield* Effect.fail(
            new MachineSchemaDecodeError({
              machineId: machine.id,
              boundary: "history",
              state: path,
              cause: Cause.die(new Error(`Machine encoded snapshot contains invalid remembered state "${path}"`))
            })
          )
        }
        rememberedActive.add(path)
        rememberedValues.set(
          path,
          yield* decodeEncodedBoundary(machine, getStateNodeSchema(stateNode), encodedRecord.values[path], {
            boundary: "history",
            state: path
          })
        )
      }
      if (Object.keys(encodedRecord.values).length !== rememberedActive.size) {
        return yield* Effect.fail(
          new MachineSchemaDecodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(new Error(`Machine encoded history "${historyPath}" contains values outside its paths`))
          })
        )
      }
      if (!rememberedActive.has(historyNode.parent)) {
        return yield* Effect.fail(
          new MachineSchemaDecodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(new Error(`Machine encoded history "${historyPath}" does not contain its parent state`))
          })
        )
      }
      const record: HistoryRecord = {
        mode: encodedRecord.mode,
        parent: historyNode.parent,
        active: rememberedActive,
        values: rememberedValues
      }
      try {
        validateHistoryRecordControl(machine, record)
      } catch (cause) {
        return yield* Effect.fail(
          new MachineSchemaDecodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(cause)
          })
        )
      }
      history.set(historyPath, record)
    }

    const configuration: ActiveConfiguration = {
      active,
      values,
      outputs: new Map(),
      history
    }
    const snapshot = validateEncodedConfiguration(machine, configuration)
    const completions: Array<Machine.SnapshotCompletion> = []
    const completionPaths = new Set<string>()
    for (const completion of decoded.completed ?? []) {
      if (completionPaths.has(completion.path)) {
        throw new Error(`Machine encoded snapshot contains duplicate completion "${completion.path}"`)
      }
      if (!active.has(completion.path) || !isActiveFinalNode(machine, configuration, completion.path)) {
        throw new Error(`Machine encoded snapshot contains invalid completion "${completion.path}"`)
      }
      completionPaths.add(completion.path)
      completions.push({
        path: completion.path,
        output: yield* decodeEncodedBoundary(
          machine,
          getCompletionSchema(machine, configuration, completion.path),
          completion.output,
          {
            boundary: "output",
            state: completion.path
          }
        )
      })
    }
    if (completions.length > 0) {
      ;(snapshot as Machine.AtomicSnapshot<string, unknown> & {
        completed: ReadonlyArray<Machine.SnapshotCompletion>
      }).completed = completions
    }
    return snapshot
  }).pipe(Effect.catchCause((cause) => failDecodeCause(machine, cause)))
