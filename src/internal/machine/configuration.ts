/**
 * Internal active-configuration, history, and completion helpers.
 *
 * @since 0.4.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { hasProperty } from "effect/Predicate"
import type { Machine } from "../../Machine.js"
import { MachineSchemaDecodeError } from "./errors.js"
import {
  decodeBoundary,
  decodeOutputValue,
  decodeOutputValueSync,
  decodeStateValue,
  decodeStateValueSync
} from "./protocol.js"
import { getNode, getStateNodeSchema, isSnapshot, isTarget, TargetSnapshotTypeId } from "./topology.js"

export interface HistoryRecord {
  readonly mode: "shallow" | "deep"
  readonly parent: string
  readonly active: ReadonlySet<string>
  readonly values: ReadonlyMap<string, unknown>
}

export const validateHistoryRecordControl = (machine: Machine.Any, record: HistoryRecord): void => {
  const ancestry = new Set(getPathToRoot(machine, record.parent))
  const visit = (path: string): void => {
    const node = getNode(machine, path)
    if (node.type === "compound") {
      const children = node.children.filter((child) => record.active.has(child))
      if (children.length !== 1) {
        throw new Error(`Machine history expected compound state "${path}" to retain one active child`)
      }
      if (record.mode === "deep") visit(children[0]!)
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
  readonly history?: Readonly<
    Record<string, {
      readonly mode: "shallow" | "deep"
      readonly active: ReadonlyArray<string>
      readonly values: Readonly<Record<string, unknown>>
    }>
  >
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
      if (active.has(activePath)) {
        throw new Error(`Machine snapshot contains invalid remembered state "${activePath}"`)
      }
      const node = getNode(machine, activePath)
      if (
        node.type === "history" || node.type === "choice" ||
        !(isPathInSubtree(activePath, historyNode.parent) ||
          getPathToRoot(machine, historyNode.parent).includes(activePath))
      ) {
        throw new Error(`Machine snapshot contains invalid remembered value for "${activePath}"`)
      }
      active.add(activePath)
      const hasValue = Object.prototype.hasOwnProperty.call(entry.values, activePath)
      if (node.schema === undefined) {
        if (hasValue) throw new Error(`Machine snapshot contains a value for structural state "${activePath}"`)
      } else {
        if (!hasValue) throw new Error(`Machine snapshot omits remembered value for "${activePath}"`)
        values.set(activePath, decodeStateValueSync(machine, node, entry.values[activePath]))
      }
    }
    if (!active.has(historyNode.parent) || Object.keys(entry.values).length !== values.size) {
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
      return yield* Effect.fail(
        new MachineSchemaDecodeError({
          machineId: machine.id,
          boundary: "history",
          state: path,
          cause: Cause.die(new Error(`Machine snapshot contains invalid history record "${path}"`))
        })
      )
    }
    const active = new Set<string>()
    const values = new Map<string, unknown>()
    for (const activePath of entry.active) {
      const node = machine.stateNodes.byPath.get(activePath)
      if (
        active.has(activePath) || node === undefined || node.type === "history" || node.type === "choice" ||
        !(isPathInSubtree(activePath, historyNode.parent) ||
          getPathToRoot(machine, historyNode.parent).includes(activePath))
      ) {
        return yield* Effect.fail(
          new MachineSchemaDecodeError({
            machineId: machine.id,
            boundary: "history",
            state: activePath,
            cause: Cause.die(new Error(`Machine snapshot contains invalid remembered state "${activePath}"`))
          })
        )
      }
      active.add(activePath)
      const hasValue = Object.prototype.hasOwnProperty.call(entry.values, activePath)
      if (node.schema === undefined) {
        if (hasValue) {
          return yield* Effect.fail(
            new MachineSchemaDecodeError({
              machineId: machine.id,
              boundary: "history",
              state: activePath,
              cause: Cause.die(new Error(`Machine snapshot contains a value for structural state "${activePath}"`))
            })
          )
        }
      } else {
        if (!hasValue) {
          return yield* Effect.fail(
            new MachineSchemaDecodeError({
              machineId: machine.id,
              boundary: "history",
              state: activePath,
              cause: Cause.die(new Error(`Machine snapshot omits remembered value for "${activePath}"`))
            })
          )
        }
        values.set(
          activePath,
          yield* decodeBoundary(machine, getStateNodeSchema(node), entry.values[activePath], {
            boundary: "history",
            state: activePath
          })
        )
      }
    }
    if (!active.has(historyNode.parent) || Object.keys(entry.values).length !== values.size) {
      return yield* Effect.fail(
        new MachineSchemaDecodeError({
          machineId: machine.id,
          boundary: "history",
          state: path,
          cause: Cause.die(new Error(`Machine snapshot contains incomplete history record "${path}"`))
        })
      )
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
      return yield* Effect.fail(
        new MachineSchemaDecodeError({
          machineId: machine.id,
          boundary: "history",
          state: path,
          cause: Cause.die(cause)
        })
      )
    }
  }
  return history
})

const historyToSnapshot = (
  machine: Machine.Any,
  history: ReadonlyMap<string, HistoryRecord>
): Readonly<
  Record<string, {
    readonly mode: "shallow" | "deep"
    readonly active: ReadonlyArray<string>
    readonly values: Readonly<Record<string, unknown>>
  }>
> => {
  const entries: Record<string, {
    readonly mode: "shallow" | "deep"
    readonly active: ReadonlyArray<string>
    readonly values: Readonly<Record<string, unknown>>
  }> = {}
  for (const [path, record] of history) {
    const active = Array.from(record.active).sort((left, right) => compareDocumentOrder(machine, left, right))
    entries[path] = {
      mode: record.mode,
      active,
      values: Object.fromEntries(record.values)
    }
  }
  return entries
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

interface CompletionResult extends FinalCompletion {
  readonly isNew: boolean
}

const pathToRootCache = new WeakMap<Machine.StateNodes, Map<string, ReadonlyArray<string>>>()

export const hasOwn = (u: object, key: string): boolean => Object.prototype.hasOwnProperty.call(u, key)

export const isDescendantOf = (path: string, ancestor: string): boolean => path.startsWith(`${ancestor}.`)

export const isPathInSubtree = (path: string, ancestor: string): boolean =>
  path === ancestor || isDescendantOf(path, ancestor)

export const getPathToRoot = (machine: Machine.Any, path: string): ReadonlyArray<string> => {
  let pathsByLeaf = pathToRootCache.get(machine.stateNodes)
  if (pathsByLeaf === undefined) {
    pathsByLeaf = new Map()
    pathToRootCache.set(machine.stateNodes, pathsByLeaf)
  }
  const cached = pathsByLeaf.get(path)
  if (cached !== undefined) {
    return cached
  }
  const paths: Array<string> = []
  let current: string | undefined = path
  while (current !== undefined) {
    paths.unshift(current)
    current = getNode(machine, current).parent
  }
  pathsByLeaf.set(path, paths)
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
  )[0]!

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
  return leaves[0]!
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
      `Machine expected active state "${path}" to have a value (available: ${
        Array.from(configuration.values.keys()).join(", ")
      })`
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
    const parent = paths[index]!
    if (configuration.values.has(parent)) {
      parents[parent] = configuration.values.get(parent)
    }
  }
  return parents
}

export const getParentValue = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string
): unknown => {
  const parent = getNode(machine, path).parent
  return parent === undefined ? undefined : configuration.values.get(parent)
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
    value: configuration.values.get(path)
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
    Object.assign(snapshot, { history: historyToSnapshot(machine, configuration.history) })
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
    Object.assign(snapshot, { history: historyToSnapshot(machine, configuration.history) })
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
    active.add(node.path)
    if (node.schema === undefined) {
      if (current.value !== undefined) {
        throw new Error(`Machine structural snapshot "${node.path}" cannot contain a value`)
      }
    } else {
      values.set(node.path, decodeStateValueSync(machine, node, current.value))
    }
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

export const normalizeConfigurationSync = <const States extends Machine.StateSchemas>(
  machine: Machine.Any,
  state: Machine.Snapshot<States>
): ActiveConfiguration => {
  try {
    return configurationFromSnapshot(machine, state)
  } catch (cause) {
    if (cause instanceof MachineSchemaDecodeError) {
      throw cause
    }
    throw new MachineSchemaDecodeError({
      machineId: machine.id,
      boundary: "configuration",
      cause: Cause.die(cause)
    })
  }
}

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
    active.add(node.path)
    if (node.schema === undefined) {
      if (current.value !== undefined) {
        throw new Error(`Machine structural snapshot "${node.path}" cannot contain a value`)
      }
    } else {
      values.set(node.path, yield* decodeStateValue(machine, node, current.value))
    }
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
      const initialNode = node.initial === undefined ? undefined : getNode(machine, node.initial)
      if (initialNode?.type === "choice" ? child === undefined : child !== node.initial) {
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
      if (current.values.has(path)) {
        values.set(path, current.values.get(path))
      }
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
    if (currentNode.schema === undefined) {
      const supplied = currentPath === node.path ?
        value
        : providedValues !== undefined && hasOwn(providedValues, currentPath) ?
        providedValues[currentPath]
        : undefined
      if (supplied !== undefined) throw new Error(`Machine structural target "${currentPath}" cannot contain a value`)
      continue
    }
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
    if (node.schema === undefined) {
      if (providedValues !== undefined && hasOwn(providedValues, ancestor)) {
        throw new Error(`Machine structural target "${ancestor}" cannot contain a value`)
      }
      continue
    }
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
        if (pathSet.has(child)) continue
        if (current.active.has(child)) {
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
          continue
        }
        if (providedValues !== undefined && hasOwn(providedValues, child)) {
          for (const [providedPath, providedValue] of Object.entries(providedValues)) {
            if (!isPathInSubtree(providedPath, child)) continue
            const providedNode = getNode(machine, providedPath)
            active.add(providedPath)
            if (providedNode.schema === undefined) {
              throw new Error(`Machine structural target "${providedPath}" cannot contain a value`)
            }
            values.set(providedPath, yield* decodeStateValue(machine, providedNode, providedValue))
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

const configurationFromTargetPathSync = (
  machine: Machine.Any,
  current: ActiveConfiguration,
  path: string,
  value: unknown,
  providedValues: Readonly<Record<string, unknown>> | undefined
): ActiveConfiguration => {
  const node = getNode(machine, path)
  const active = new Set<string>()
  const values = new Map<string, unknown>()
  const outputs = new Map<string, unknown>()
  const paths = getPathToRoot(machine, node.path)
  const pathSet = new Set(paths)

  for (const currentPath of paths) {
    const currentNode = getNode(machine, currentPath)
    active.add(currentPath)
    if (currentNode.schema === undefined) {
      const supplied = currentPath === node.path ?
        value
        : providedValues !== undefined && hasOwn(providedValues, currentPath) ?
        providedValues[currentPath]
        : undefined
      if (supplied !== undefined) throw new Error(`Machine structural target "${currentPath}" cannot contain a value`)
      continue
    }
    if (currentPath === node.path) {
      values.set(currentPath, decodeStateValueSync(machine, currentNode, value))
    } else if (providedValues !== undefined && hasOwn(providedValues, currentPath)) {
      values.set(currentPath, decodeStateValueSync(machine, currentNode, providedValues[currentPath]))
    } else if (current.values.has(currentPath)) {
      values.set(currentPath, current.values.get(currentPath))
    } else {
      throw new Error(`Machine target "${node.path}" requires a value for ancestor state "${currentPath}"`)
    }
  }

  for (const ancestor of paths) {
    const ancestorNode = getNode(machine, ancestor)
    if (ancestorNode.type !== "parallel") continue
    for (const child of ancestorNode.children) {
      if (pathSet.has(child) || !current.active.has(child)) continue
      for (const activePath of current.active) {
        if (!isPathInSubtree(activePath, child)) continue
        active.add(activePath)
        if (current.values.has(activePath)) values.set(activePath, current.values.get(activePath))
        if (current.outputs.has(activePath)) outputs.set(activePath, current.outputs.get(activePath))
      }
    }
  }

  if (node.type === "compound" || node.type === "parallel") {
    throw new Error(`Machine target "${node.path}" must include an active child state`)
  }
  return { active, values, outputs, history: current.history }
}

const configurationFromTargetSnapshotSync = (
  machine: Machine.Any,
  current: ActiveConfiguration,
  snapshot: Machine.AtomicSnapshot<string, unknown>,
  providedValues: Readonly<Record<string, unknown>> | undefined
): ActiveConfiguration => {
  const subtree = configurationFromSnapshot(machine, snapshot)
  const active = new Set(subtree.active)
  const values = new Map(subtree.values)
  const outputs = new Map(subtree.outputs)
  const paths = getPathToRoot(machine, String(snapshot.path))
  const pathSet = new Set(paths)

  for (const ancestor of paths.slice(0, -1)) {
    const node = getNode(machine, ancestor)
    active.add(ancestor)
    if (node.schema === undefined) {
      if (providedValues !== undefined && hasOwn(providedValues, ancestor)) {
        throw new Error(`Machine structural target "${ancestor}" cannot contain a value`)
      }
      continue
    }
    if (providedValues !== undefined && hasOwn(providedValues, ancestor)) {
      values.set(ancestor, decodeStateValueSync(machine, node, providedValues[ancestor]))
    } else if (current.values.has(ancestor)) {
      values.set(ancestor, current.values.get(ancestor))
    } else {
      throw new Error(`Machine target "${snapshot.path}" requires a value for ancestor state "${ancestor}"`)
    }
  }

  for (const ancestor of paths.slice(0, -1)) {
    const ancestorNode = getNode(machine, ancestor)
    if (ancestorNode.type !== "parallel") continue
    for (const child of ancestorNode.children) {
      if (pathSet.has(child)) continue
      if (current.active.has(child)) {
        for (const activePath of current.active) {
          if (!isPathInSubtree(activePath, child)) continue
          active.add(activePath)
          if (current.values.has(activePath)) values.set(activePath, current.values.get(activePath))
          if (current.outputs.has(activePath)) outputs.set(activePath, current.outputs.get(activePath))
        }
        continue
      }
      if (providedValues !== undefined && hasOwn(providedValues, child)) {
        for (const [providedPath, providedValue] of Object.entries(providedValues)) {
          if (!isPathInSubtree(providedPath, child)) continue
          const providedNode = getNode(machine, providedPath)
          active.add(providedPath)
          if (providedNode.schema === undefined) {
            throw new Error(`Machine structural target "${providedPath}" cannot contain a value`)
          }
          values.set(providedPath, decodeStateValueSync(machine, providedNode, providedValue))
        }
      }
    }
  }
  return {
    active,
    values,
    outputs,
    history: new Map([...current.history, ...subtree.history])
  }
}

export const normalizeTargetConfigurationSync = <const States extends Machine.StateSchemas>(
  machine: Machine.Any,
  current: ActiveConfiguration,
  target: Machine.Snapshot<States> | Machine.Target<States, Machine.StateIdentifier<States>>
): ActiveConfiguration => {
  if (isTarget(target)) {
    const snapshot = target[TargetSnapshotTypeId]
    if (snapshot !== undefined) {
      if (String(snapshot.path) !== String(target.path)) {
        throw new Error(`Machine expected target snapshot path to be "${target.path}"`)
      }
      return configurationFromTargetSnapshotSync(
        machine,
        current,
        snapshot,
        target.values as Readonly<Record<string, unknown>> | undefined
      )
    }
    return configurationFromTargetPathSync(
      machine,
      current,
      target.path,
      target.value,
      target.values as Readonly<Record<string, unknown>> | undefined
    )
  }
  if (isSnapshot(target)) {
    const configuration = normalizeConfigurationSync(machine, target)
    return { ...configuration, history: new Map([...current.history, ...configuration.history]) }
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
    state: configuration.values.get(path),
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

const resolveFinalOutputSync = <const Events extends ReadonlyArray<Machine.TaggedSchema>>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string,
  event: Machine.LifecycleEvent<Events>,
  outputs?: Readonly<Record<string, unknown>>
): unknown => {
  const node = getNode(machine, path)
  const output = getStateConfigByPath(machine, path)?.output?.({
    state: configuration.values.get(path),
    parent: getParentValue(machine, configuration, path),
    parents: getParentValues(machine, configuration, path),
    event,
    outputs
  } as any)
  return decodeOutputValueSync(machine, node, output)
}

const completeActiveFinalNodeSync = <const Events extends ReadonlyArray<Machine.TaggedSchema>>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string,
  event: Machine.LifecycleEvent<Events>,
  outputs: Map<string, unknown>,
  completions: Array<FinalCompletion>
): CompletionResult | undefined => {
  if (!configuration.active.has(path)) return undefined
  if (outputs.has(path)) return { path, output: outputs.get(path), isNew: false }
  const node = getNode(machine, path)
  if (node.type === "compound") {
    const child = getActiveChildPath(machine, configuration, path)
    if (child === undefined || !isDirectFinalPath(machine, child)) return undefined
    const childCompletion = completeActiveFinalNodeSync(machine, configuration, child, event, outputs, completions)
    if (childCompletion === undefined) return undefined
    const completion = setCompletedOutput(outputs, path, childCompletion.output)
    if (completion.isNew) completions.push(completion)
    return completion
  }
  if (node.type === "parallel") {
    const regionOutputs: Record<string, unknown> = {}
    let completed = true
    for (const child of node.children) {
      const childCompletion = completeActiveFinalNodeSync(machine, configuration, child, event, outputs, completions)
      if (childCompletion === undefined) completed = false
      else regionOutputs[getNode(machine, child).key] = childCompletion.output
    }
    if (!completed) return undefined
    const completion = setCompletedOutput(
      outputs,
      path,
      resolveFinalOutputSync(machine, configuration, path, event, regionOutputs)
    )
    if (completion.isNew) completions.push(completion)
    return completion
  }
  if (!isDirectFinalPath(machine, path)) return undefined
  const completion = setCompletedOutput(outputs, path, resolveFinalOutputSync(machine, configuration, path, event))
  if (completion.isNew) completions.push(completion)
  return completion
}

export const completeConfigurationSync = <const Events extends ReadonlyArray<Machine.TaggedSchema>>(
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  event: Machine.LifecycleEvent<Events>
): {
  readonly configuration: ActiveConfiguration
  readonly completions: ReadonlyArray<FinalCompletion>
} => {
  const outputs = new Map(configuration.outputs)
  const completions: Array<FinalCompletion> = []
  const completed: ActiveConfiguration = {
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
    completeActiveFinalNodeSync(machine, completed, path, event, outputs, completions)
  }
  return { configuration: completed, completions }
}
