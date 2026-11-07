import * as Effect from "effect/Effect"
import * as Inspectable from "effect/Inspectable"
import * as Option from "effect/Option"
import { Prototype as PipeablePrototype } from "effect/Pipeable"
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import type {
  ChildAddress,
  ChildMachine,
  Definition,
  Logic,
  Machine,
  MachineRef,
  MachineSchemaDecodeError,
  MachineSchemaEncodeError,
  Parent,
  ParentMode,
  RuntimeOutcome,
  SpawnOptions,
  State,
  StoppedError
} from "../../Machine.js"
import * as Activities from "./activities.js"
import * as Configuration from "./configuration.js"
import * as Construction from "./construction.js"
import * as Declaration from "./declaration.js"
import type { PlanningError, StartupError } from "./errors.js"
import type { CapturedStateConfig } from "./implementation.js"
import * as InitialDeclaration from "./initialDeclaration.js"
import * as InvocationDefinition from "./invocationDefinition.js"
import * as Observation from "./observation.js"
import * as internalPlanner from "./planner.js"
import * as internalProcess from "./process.js"
import * as Protocol from "./protocol.js"
import * as internalRuntime from "./runtimeProtocol.js"
import * as Serialization from "./serialization.js"
import * as StateDefinition from "./stateDefinition.js"
import { ChildMachineLogicTypeId } from "./symbols.js"
import * as Topology from "./topology.js"

export {
  ChildAlreadyExistsError,
  InfiniteTransitionError,
  MachineSchemaDecodeError,
  MachineSchemaEncodeError,
  ProcessLocalError,
  StartupError,
  StoppedError
} from "./errors.js"
export { ChildMachineLogicTypeId, InitialEventTypeId, SnapshotBuilderStateTypeId } from "./symbols.js"

/** Internal seam for the public target-reference factory and its opaque brand. */

const TypeId = "~effect/Machine"
const ParentTypeId = "~effect/Machine/Parent"
export const InvokeTypeId: unique symbol = Symbol.for("effect/Machine/Invoke")
const ChildMachineTypeId = "~effect/Machine/ChildMachine"
type MachineRuntimeRequirement = internalRuntime.MachineRuntime

const Proto = {
  ...Inspectable.BaseProto,
  ...PipeablePrototype,
  [TypeId]: TypeId,
  toJSON() {
    return {
      _id: "Machine"
    }
  }
}

const makeWithHandlers = (
  self: Machine.Any,
  handlers: Readonly<Record<string, CapturedStateConfig>>
): Machine.Any => {
  const machine = Object.create(Proto)
  machine.states = self.states
  machine.root = self.root
  machine.events = self.events
  machine.internalEvents = self.internalEvents
  machine.emittedEvents = self.emittedEvents
  machine.parent = self.parent
  machine.input = self.input
  machine.id = self.id
  machine.initial = self.initial
  machine.initialDefinition = self.initialDefinition
  machine.stateNodes = self.stateNodes
  machine.handlers = handlers
  Protocol.copyProtocol(self, machine)
  return machine
}

type DefinitionBranch = {
  readonly target: (selector: unknown) => unknown
  readonly resolve?: (context: any, enqueue: unknown) => unknown
}

type CapturedBranch = DefinitionBranch & {
  readonly selection: Topology.TargetSelection
}

type CapturedNamedBranch = {
  readonly key: string
  readonly selection: Topology.TargetSelection
}

const transitionTargetSelection = (
  selection: Topology.TargetSelection
): Machine.TransitionTargetSelection =>
  Object.freeze({
    path: selection.path,
    kind: selection.kind,
    scope: selection.scope
  })

const selectionUpdates = (selection: Topology.TargetSelection): ReadonlyArray<string> =>
  selection.updatePath === undefined ?
    selection.kind === "update" && selection.path !== undefined ? [selection.path] : []
    : [selection.updatePath]

const captureDefinitionBranch = (
  branch: unknown,
  selector: unknown,
  stateNodes: Machine.StateNodes,
  path: string,
  trigger: PropertyKey
): CapturedBranch => {
  if (
    typeof branch !== "object" || branch === null || !hasProperty(branch, "target") ||
    typeof branch.target !== "function"
  ) {
    throw new Error(`Machine transition for state "${path}" on "${String(trigger)}" requires a target selector`)
  }
  const selection = branch.target(selector)
  if (!Topology.isTargetSelection(selection)) {
    throw new Error(`Machine transition for state "${path}" on "${String(trigger)}" must select exactly one target`)
  }
  if (selection.updatePath !== undefined) {
    const owner = stateNodes.byPath.get(selection.updatePath)
    if (
      (selection.kind !== "state" && selection.kind !== "choice") ||
      (selection.scope !== "local" && selection.scope !== "branch") ||
      selection.path === undefined || owner === undefined || owner.schema === undefined ||
      (owner.type !== "compound" && owner.type !== "parallel") ||
      !Configuration.isDescendantOf(path, owner.path) ||
      !Configuration.isDescendantOf(selection.path, owner.path)
    ) {
      throw new Error(
        `Machine updating owner "${selection.updatePath}" must be a valued ancestor retained by source "${path}" and target "${selection.path}"`
      )
    }
  }
  return { ...(branch as DefinitionBranch), selection }
}

const validateResolvedSelection = (
  result: unknown,
  selection: Topology.TargetSelection,
  stateNodes: Machine.StateNodes
): void => {
  if (selection.kind === "none") {
    if (result !== undefined) {
      throw new Error("Machine targetless transition resolver must return undefined")
    }
    return
  }
  if (selection.kind === "update") {
    if (!Topology.isStateUpdate(result) || result.path !== selection.path) {
      throw new Error(`Machine state update for "${selection.path}" must return its selected update builder`)
    }
    return
  }
  if (selection.updatePath !== undefined) {
    if (!Topology.isCombinedTarget(result) || result.update.path !== selection.updatePath) {
      throw new Error(`Machine target updating "${selection.updatePath}" must return target construction .update(...)`)
    }
  } else if (Topology.isCombinedTarget(result)) {
    throw new Error("Machine combined target requires an updating owner declaration")
  }
  if (result === undefined) return
  const target = Topology.isCombinedTarget(result) ? result.target : result
  const resultPath = typeof target === "object" && target !== null && hasProperty(target, "path") &&
      typeof target.path === "string"
    ? target.path
    : undefined
  const selectedNode = selection.path === undefined ? undefined : stateNodes.byPath.get(selection.path)
  const acceptsDescendant = (selection.scope === "local" || selection.scope === "branch") &&
    (selectedNode?.type === "compound" || selectedNode?.type === "parallel")
  if (
    resultPath === undefined ||
    (resultPath !== selection.path && !(acceptsDescendant && Configuration.isDescendantOf(resultPath, selection.path!)))
  ) {
    throw new Error(
      `Machine transition resolver selected "${selection.path}" but constructed "${resultPath ?? "<invalid>"}"`
    )
  }
}

const runCapturedBranch = (
  branch: CapturedBranch,
  context: Record<string, any>,
  enqueue: unknown,
  stateNodes: Machine.StateNodes,
  source: string
): unknown => {
  const resolverContext: Record<string, any> = {
    ...context,
    root: source === "" ? context.state : context.ancestors[""]
  }
  delete resolverContext.target
  const resolved = branch.resolve!(resolverContext, enqueue)
  if (Topology.isDeclined(resolved)) return resolved
  validateResolvedSelection(resolved, branch.selection, stateNodes)
  return resolved
}

const topologyTargetPath = (selection: Topology.TargetSelection): string | undefined =>
  selection.kind === "update" ? undefined : selection.path

const constructBranch = (
  selection: Topology.TargetSelection,
  stateNodes: Machine.StateNodes,
  declaration: Declaration.Declaration,
  raw: unknown = {},
  source?: string
): unknown => {
  const config = Construction.record(raw)
  if (selection.kind === "choice" && selection.updatePath !== undefined) {
    const { update, ...state } = config
    if (Reflect.ownKeys(state).length > 0) throw new Error("Machine pseudo-state construction accepts no data")
    const node = stateNodes.byPath.get(selection.path!)!
    return Topology.makeCombinedTarget(
      Topology.makeChoiceTarget(node.path, node.parent!),
      Construction.update(stateNodes, selection.updatePath, update)
    )
  }
  if (selection.kind === "none" || selection.kind === "history" || selection.kind === "choice") {
    if (Reflect.ownKeys(config).length > 0) throw new Error("Machine pseudo-state construction accepts no data")
    if (selection.kind === "none") return undefined
    const node = stateNodes.byPath.get(selection.path!)!
    return selection.kind === "history" ?
      Topology.makeHistoryTarget(node.path, node.parent!)
      : Topology.makeChoiceTarget(node.path, node.parent!)
  }
  if (selection.kind === "update") return Construction.update(stateNodes, selection.path!, config)
  if (selection.path === "") {
    if (Reflect.ownKeys(config).some((key) => key !== "input")) {
      throw new Error("Machine initialize branches accept input only")
    }
    if (declaration.initialize === undefined) throw new Error("Machine root initialization is unavailable")
    return declaration.initialize(config.input)
  }
  if (selection.updatePath !== undefined) {
    const { update, ...state } = config
    return Topology.makeCombinedTarget(
      Construction.target(stateNodes, selection.path!, state, source),
      Construction.update(stateNodes, selection.updatePath, update)
    )
  }
  return Construction.target(stateNodes, selection.path!, config, source)
}

// The key is the entry as written. It identifies the branch in `select` calls, retained transitions, and coverage.
const branchEntryKey = (entry: Readonly<Record<string, unknown>>, source: string, trigger: PropertyKey): string => {
  const fields = Reflect.ownKeys(entry)
  const invalid = () =>
    new Error(`Machine branch entry for state "${source}" on "${String(trigger)}" must be one destination`)
  if (typeof entry.target === "string") {
    if (fields.some((field) => field !== "target" && field !== "update")) throw invalid()
    if (entry.update === undefined) return `target:${entry.target}`
    if (typeof entry.update !== "string") throw invalid()
    return `target:${entry.target}+update:${entry.update}`
  }
  if (fields.length !== 1) throw invalid()
  if (typeof entry.update === "string") return `update:${entry.update}`
  if (typeof entry.history === "string") return `history:${entry.history}`
  for (const field of ["initialize", "stay", "decline"]) {
    if (entry[field] === true) return field
  }
  throw invalid()
}

const captureNamedBranches = (
  entries: unknown,
  declaration: Declaration.Declaration,
  source: string,
  trigger: PropertyKey,
  stateNodes: Machine.StateNodes
): { readonly branches: ReadonlyArray<CapturedNamedBranch>; readonly declines: boolean } => {
  const label = `Machine branches for state "${source}" on "${String(trigger)}"`
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${label} require at least one entry`)
  const keys = new Set<string>()
  const branches: Array<CapturedNamedBranch> = []
  let declines = false
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) throw new Error(`${label} must list objects`)
    const key = branchEntryKey(entry, source, trigger)
    if (keys.has(key)) throw new Error(`${label} declare "${key}" more than once`)
    keys.add(key)
    if (key === "decline") {
      declines = true
      continue
    }
    branches.push(Object.freeze({
      key,
      selection: captureDefinitionBranch(
        { target: () => Declaration.selection(declaration, entry) },
        undefined,
        stateNodes,
        source,
        trigger
      ).selection
    }))
  }
  if (branches.length === 0) throw new Error(`${label} need a destination besides decline`)
  return { branches: Object.freeze(branches), declines }
}

const updateValue = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && hasProperty(value, "decoded") && value.decoded === true &&
    hasProperty(value, "data")
    ? { decoded: true, data: value.data }
    : { data: value }

const makeBranchSelect = (
  branches: ReadonlyArray<CapturedNamedBranch>,
  declines: boolean,
  owner: object,
  stateNodes: Machine.StateNodes,
  declaration: Declaration.Declaration,
  source: string
): Readonly<Record<string, unknown>> => {
  const selected = (key: string, construct: (selection: Topology.TargetSelection) => unknown) => {
    const index = branches.findIndex((branch) => branch.key === key)
    if (index === -1) {
      throw new Error(`Machine resolve for state "${source}" selected "${key}", which branches does not declare`)
    }
    return Topology.makeSelectedBranch(owner, index, key, construct(branches[index]!.selection))
  }
  return Object.freeze({
    target: (path: string, raw?: unknown) => {
      const { update, ...construction } = raw === undefined ? {} as Record<string, unknown> : Construction.record(raw)
      if (update === undefined) {
        return selected(
          `target:${path}`,
          (selection) => constructBranch(selection, stateNodes, declaration, construction, source)
        )
      }
      const name = Declaration.updateOwner(update)
      return selected(`target:${path}+update:${name}`, (selection) =>
        constructBranch(
          selection,
          stateNodes,
          declaration,
          { ...construction, update: updateValue((update as Record<string, unknown>)[name]) },
          source
        ))
    },
    update: (updates: unknown) => {
      const name = Declaration.updateOwner(updates)
      return selected(`update:${name}`, (selection) =>
        constructBranch(
          selection,
          stateNodes,
          declaration,
          updateValue((updates as Record<string, unknown>)[name]),
          source
        ))
    },
    history: (path: string) =>
      selected(`history:${path}`, (selection) => constructBranch(selection, stateNodes, declaration, {}, source)),
    initialize: (raw?: unknown) =>
      selected("initialize", (selection) => constructBranch(selection, stateNodes, declaration, raw, source)),
    stay: () => selected("stay", () => Topology.makeNoTarget()),
    decline: () => {
      if (!declines) {
        throw new Error(`Machine resolve for state "${source}" selected "decline", which branches does not declare`)
      }
      return Topology.makeSelectedBranch(owner, -1, "decline", Topology.makeDeclined())
    }
  })
}

const validateSelectedBranchResult = (
  result: unknown,
  selection: Topology.TargetSelection,
  stateNodes: Machine.StateNodes
): void => {
  if (selection.kind === "none") {
    if (!Topology.isNoTarget(result)) {
      throw new Error("Machine targetless branch must return its selected targetless builder")
    }
    return
  }
  if (result === undefined) {
    throw new Error(`Machine transition branch selected "${selection.path}" without constructing its target`)
  }
  validateResolvedSelection(result, selection, stateNodes)
}

// Invocation input contexts do not pass through captured transition evaluation.
const objectContext = (context: Record<string, any>, path: string): Record<string, any> => ({
  ...context,
  root: path === "" ? context.state : context.ancestors[""]
})

const normalizeObjectTransition = (
  raw: unknown,
  declaration: Declaration.Declaration,
  path: string,
  stateNodes: Machine.StateNodes,
  acceptance: Machine.TransitionAcceptance
): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null) throw new Error(`Machine transition for "${path}" must be an object`)
  const config = { ...raw } as Record<string, unknown>
  const allowed = [
    "target",
    "update",
    "initialize",
    "history",
    "stay",
    "branches",
    "data",
    "decoded",
    "resolve",
    "guard",
    "reenter",
    "commands"
  ]
  for (const key of Reflect.ownKeys(config)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new Error("Machine transition contains an unknown field")
    }
  }
  for (const key of ["resolve", "guard", "commands"]) {
    if (config[key] !== undefined && typeof config[key] !== "function") {
      throw new Error(`Machine transition ${key} must be a function`)
    }
  }
  const guard = typeof config.guard === "function" ? config.guard : undefined
  const resolve = typeof config.resolve === "function" ? config.resolve : undefined
  const commands = typeof config.commands === "function" ? config.commands : undefined
  if (config.decoded !== undefined && typeof config.decoded !== "boolean") {
    throw new Error("Machine decoded must be a boolean construction flag")
  }
  const hasData = Object.prototype.hasOwnProperty.call(config, "data")
  if (config.decoded === true && !hasData) throw new Error("Machine decoded construction requires data")
  const guarded = guard !== undefined
  if (
    acceptance === "required" &&
    (guarded || (Array.isArray(config.branches) && config.branches.some((entry) => entry?.decline === true)))
  ) {
    throw new Error(`Machine guard and decline apply only to on and always, on state "${path}"`)
  }
  if ((config.branches === undefined) !== (resolve === undefined)) {
    throw new Error("Machine branches and resolve must be declared together")
  }
  if (config.branches !== undefined) {
    if (
      ["target", "update", "initialize", "history", "stay", "data", "decoded", "guard", "commands"].some((key) =>
        config[key] !== undefined
      )
    ) throw new Error("Machine branching transition cannot redeclare its destination, guard, or commands")
    return {
      branches: config.branches,
      reenter: config.reenter,
      resolve
    }
  }
  if (typeof config.update === "string") throw new Error("Machine transition update must be a record with one owner")
  const selection = Declaration.selection(declaration, config)
  const initialize = config.initialize
  const initializes = initialize !== undefined
  if (initializes && (hasData || config.decoded !== undefined)) {
    throw new Error("Machine initialize accepts machine input instead of data")
  }
  if (initializes && !declaration.input && initialize !== true) {
    throw new Error("Machine initialize requires true when the machine declares no input")
  }
  if (selection.kind === "none" && (hasData || config.decoded !== undefined)) {
    throw new Error("Machine targetless transition accepts no data")
  }
  const constructInput = !declaration.input
    ? () => undefined
    : typeof initialize === "function"
    ? initialize
    : () => initialize
  const owner = selection.updatePath ?? (selection.kind === "update" ? selection.path : undefined)
  const updates = config.update as Record<string, unknown> | undefined
  const rawUpdate = owner === undefined || updates === undefined ? undefined : updates[Declaration.updateOwner(updates)]
  const constructUpdate = rawUpdate === undefined ? undefined : InitialDeclaration.ownerUpdate(rawUpdate)
  const construct = typeof config.data === "function" ? config.data : () => config.data
  return {
    target: () => selection,
    reenter: config.reenter,
    declinable: guarded,
    resolve: (context: Record<string, any>, enqueue: unknown) => {
      if (guarded && !guard(context)) return Topology.makeDeclined()
      commands?.(context, enqueue)
      if (selection.kind === "none") return undefined
      if (initializes) {
        return constructBranch(selection, stateNodes, declaration, { input: constructInput(context) })
      }
      const state = {
        ...(hasData ? { data: construct(context) } : {}),
        ...(config.decoded === undefined ? {} : { decoded: config.decoded })
      }
      return constructBranch(
        selection,
        stateNodes,
        declaration,
        selection.kind === "update" ?
          constructUpdate!(context) :
          selection.updatePath === undefined
          ? state
          : { ...state, update: constructUpdate!(context) },
        path
      )
    }
  }
}

const captureTransition = (
  rawTransition: unknown,
  stateNodes: Machine.StateNodes,
  path: string,
  declaration: Declaration.Declaration,
  trigger: PropertyKey,
  acceptance: Machine.TransitionAcceptance
): unknown => {
  const transition = normalizeObjectTransition(rawTransition, declaration, path, stateNodes, acceptance)
  if (typeof transition !== "object" || transition === null) {
    throw new Error(`Machine transition for state "${path}" on "${String(trigger)}" must be an object`)
  }
  const definition = transition as Record<PropertyKey, unknown>
  const reenter = definition.reenter === true
  if (hasProperty(definition, "branches")) {
    const resolve = (definition as Record<PropertyKey, unknown>).resolve as (
      context: Record<string, any>,
      enqueue: unknown
    ) => unknown
    const { branches, declines } = captureNamedBranches(definition.branches, declaration, path, trigger, stateNodes)
    const owner = Object.freeze({})
    const select = makeBranchSelect(branches, declines, owner, stateNodes, declaration, path)
    const evaluate = (context: Record<string, any>, enqueue: unknown) => {
      const resolverContext: Record<string, any> = {
        ...context,
        root: path === "" ? context.state : context.ancestors[""],
        select
      }
      delete resolverContext.target
      const selected = resolve(resolverContext, enqueue)
      if (!Topology.isSelectedBranch(selected) || selected.owner !== owner) {
        throw new Error(
          `Machine branching transition for state "${path}" on "${String(trigger)}" must return a select call`
        )
      }
      if (selected.branchIndex === -1) {
        return { result: selected.result, branchIndex: -1, branchKey: undefined }
      }
      const branch = branches[selected.branchIndex]
      if (branch === undefined || selected.branchKey !== branch.key) {
        throw new Error(`Machine branching transition returned invalid branch evidence`)
      }
      validateSelectedBranchResult(selected.result, branch.selection, stateNodes)
      return {
        result: selected.result,
        branchIndex: selected.branchIndex,
        branchKey: selected.branchKey
      }
    }
    return {
      reenter,
      declinable: declines,
      targets: [
        ...new Set(
          branches.flatMap((branch) =>
            topologyTargetPath(branch.selection) === undefined ? [] : [branch.selection.path!]
          )
        )
      ],
      branches: branches.map((branch) =>
        Object.freeze({
          type: "branch" as const,
          key: branch.key,
          target: topologyTargetPath(branch.selection),
          selection: transitionTargetSelection(branch.selection),
          updates: selectionUpdates(branch.selection)
        })
      ),
      evaluate,
      transition: (context: Record<string, any>, enqueue: unknown) => evaluate(context, enqueue).result
    }
  }
  const declinable = definition.declinable === true
  const branch = captureDefinitionBranch(transition, undefined, stateNodes, path, trigger)
  const evaluate = (context: Record<string, any>, enqueue: unknown) => ({
    result: runCapturedBranch(branch, context, enqueue, stateNodes, path),
    branchIndex: 0,
    branchKey: undefined
  })
  return {
    reenter,
    declinable,
    targets: topologyTargetPath(branch.selection) === undefined ? [] : [branch.selection.path!],
    branches: [{
      type: "direct" as const,
      target: topologyTargetPath(branch.selection),
      selection: transitionTargetSelection(branch.selection),
      updates: selectionUpdates(branch.selection)
    }],
    evaluate,
    transition: (context: Record<string, any>, enqueue: unknown) => evaluate(context, enqueue).result
  }
}

const captureEventHandlers = (
  on: object,
  stateNodes: Machine.StateNodes,
  path: string,
  declaration: Declaration.Declaration
): Record<PropertyKey, unknown> => {
  // The machine owns its dispatch table. Compiled plans may snapshot these
  // definitions, so retaining caller-owned containers would let strategies
  // observe different handlers after an unsafe external mutation.
  const captured: Record<PropertyKey, unknown> = Object.create(null)
  for (const event of Reflect.ownKeys(on)) {
    captured[event] = captureTransition(
      (on as Record<PropertyKey, unknown>)[event],
      stateNodes,
      path,
      declaration,
      event,
      "declinable"
    )
  }
  return captured
}

const captureInvokeDefinition = (
  invoke: unknown,
  stateNodes: Machine.StateNodes,
  path: string,
  declaration: Declaration.Declaration
): unknown => {
  const definitions = Array.isArray(invoke) ? invoke : [invoke]
  const capturedDefinitions = definitions.map((definition) => {
    const captured = Declaration.invocation(
      declaration,
      definition,
      path,
      (context) => objectContext(context as Record<string, any>, path)
    )
    for (const key of ["onElement", "onDone", "onFailure", "onSnapshot"] as const) {
      if (captured[key] !== undefined) {
        captured[key] = captureTransition(captured[key], stateNodes, path, declaration, key, "required")
      }
    }
    return InvocationDefinition.capture(captured, path)
  })
  InvocationDefinition.assertDistinctIds(capturedDefinitions, path)
  if (Array.isArray(invoke)) return Object.freeze(capturedDefinitions)
  return capturedDefinitions[0]
}

const flattenHandlers = (
  handlers: Record<PropertyKey, CapturedStateConfig>,
  stateNodes: Machine.StateNodes,
  states: Machine.StateTree,
  prefix: string,
  declaration: Declaration.Declaration,
  config: Record<string, unknown>
): void => {
  for (const key of Object.keys(config)) {
    const path = prefix === "" ? key : `${prefix}.${key}`
    if (!hasProperty(states, key)) {
      throw new Error(`Machine received handler for unknown state "${path}"`)
    }
    const nodeConfig = config[key]
    if (typeof nodeConfig !== "object" || nodeConfig === null) {
      throw new Error(`Machine expected state "${path}" handler to be an object`)
    }
    const { states: childConfig, ...stateConfig } = nodeConfig as Record<string, unknown>
    if (typeof stateConfig.history === "object" && stateConfig.history !== null) {
      stateConfig.history = Object.freeze(Object.fromEntries(
        Object.entries(stateConfig.history).map(([key, entry]) => [
          key,
          typeof entry === "object" && entry !== null ? Object.freeze({ ...entry }) : entry
        ])
      ))
    }
    const on = stateConfig.on
    if (typeof on === "object" && on !== null) {
      const capturedOn = captureEventHandlers(on, stateNodes, path, declaration)
      stateConfig.on = capturedOn
    }
    if (stateConfig.always !== undefined) {
      stateConfig.always = captureTransition(stateConfig.always, stateNodes, path, declaration, "always", "declinable")
    }
    if (stateConfig.onDone !== undefined) {
      stateConfig.onDone = captureTransition(stateConfig.onDone, stateNodes, path, declaration, "done", "required")
    }
    if (stateConfig.choice !== undefined) {
      stateConfig.choice = captureTransition(stateConfig.choice, stateNodes, path, declaration, "choice", "required")
    }
    if (stateConfig.invoke !== undefined) {
      stateConfig.invoke = captureInvokeDefinition(stateConfig.invoke, stateNodes, path, declaration)
    }
    const node = stateNodes.byPath.get(path)
    if (node?.type === "choice") {
      if (
        typeof stateConfig.choice !== "object" || stateConfig.choice === null ||
        !hasProperty(stateConfig.choice, "transition") || typeof stateConfig.choice.transition !== "function" ||
        !hasProperty(stateConfig.choice, "targets") || !Array.isArray(stateConfig.choice.targets) ||
        stateConfig.choice.targets.length === 0
      ) {
        throw new Error(`Machine choice state "${path}" requires a transition`)
      }
    }
    handlers[path] = stateConfig
    if (childConfig !== undefined) {
      const node = Topology.getStateNodeDefinition(path, states[key]!)
      if (node.states === undefined) {
        throw new Error(`Machine expected state "${path}" to declare child states`)
      }
      if (typeof childConfig !== "object" || childConfig === null) {
        throw new Error(`Machine expected state "${path}" child handlers to be an object`)
      }
      flattenHandlers(handlers, stateNodes, node.states, path, declaration, childConfig as Record<string, unknown>)
    }
  }
}

const publicPath = (path: string): string => path === "" ? Declaration.rootPathName : path

// A choice entered with an owner update resolves after that update, so every
// branch it can reach, through nested choices, must keep the owner active.
const assertChoiceUpdatesRetainOwners = (machine: Machine.Any): void => {
  let hasChoice = false
  for (const node of machine.stateNodes.byPath.values()) {
    if (node.type === "choice") {
      hasChoice = true
      break
    }
  }
  if (!hasChoice) return
  const definitions = Topology.transitionDefinitions(machine)
  const choices = new Map<string, Machine.TransitionDefinition>()
  for (const definition of definitions) {
    if (definition.trigger.type === "choice") choices.set(definition.source, definition)
  }
  for (const definition of definitions) {
    for (const branch of definition.branches) {
      const owner = branch.updates[0]
      const entered = branch.selection.path
      if (branch.selection.kind !== "choice" || owner === undefined || entered === undefined) continue
      const pending = [entered]
      const visited = new Set<string>()
      while (pending.length > 0) {
        const choice = pending.shift()!
        if (visited.has(choice)) continue
        visited.add(choice)
        for (const choiceBranch of choices.get(choice)?.branches ?? []) {
          const { kind, path: target } = choiceBranch.selection
          // Targetless and update-only choice branches are rejected by choice validation itself.
          if (target === undefined || kind === "none" || kind === "update") continue
          if (kind === "choice") {
            pending.push(target)
          } else if (!Configuration.isDescendantOf(target, owner)) {
            const label = choiceBranch.type === "branch" ? `branch "${choiceBranch.key}"` : "transition"
            throw new Error(
              `Machine transition from "${publicPath(definition.source)}" updates "${publicPath(owner)}" before ` +
                `choice "${choice}", whose ${label} targets "${publicPath(target)}" outside that owner`
            )
          }
        }
      }
    }
  }
}

const makeHandle = (self: Definition.Any, declaration: Declaration.Declaration): Definition.Any["handle"] =>
  ((config: Record<string, unknown>) => {
    const captured = InitialDeclaration.capture(declaration.root, config)
    const compiled = Object.assign(Object.create(Proto), self)
    Protocol.copyProtocol(self, compiled)
    compiled.states = Object.freeze({ "": captured.node })
    compiled.stateNodes = Topology.compileStateNodes(compiled.states)
    if (compiled.stateNodes.byPath.get("").schema === undefined && config.root !== undefined) {
      throw new Error("Machine schema-less root cannot construct data")
    }
    const constructRoot = compiled.stateNodes.byPath.get("").schema === undefined
      ? () => undefined
      : InitialDeclaration.construction(config.root)
    compiled.initial = (input: unknown) => ({
      ...Topology.makeInitialTarget("", constructRoot({ input })),
      input: { value: input }
    })
    compiled.initialDefinition = Object.freeze({
      target: "",
      selection: Object.freeze({ path: "", kind: "initial", scope: "initial" })
    })
    const handlers: Record<PropertyKey, CapturedStateConfig> = Object.create(null)
    flattenHandlers(handlers, compiled.stateNodes, compiled.states, "", {
      ...declaration,
      initialize: (input) =>
        compiled.initial(
          compiled.input === undefined ? undefined : Protocol.decodeInputSync(compiled, compiled.input, input)
        )
    }, { "": captured.handlers })
    const machine = makeWithHandlers(compiled, handlers)
    assertChoiceUpdatesRetainOwners(machine)
    return machine
  }) as Definition.Any["handle"]

export const isMachine = (
  u: unknown
): u is Machine.Any => hasProperty(u, TypeId) && u[TypeId] === TypeId

// Erased machine operations. `any` marks the positions whose types the public
// `Machine` module computes from the machine's generic parameters; the public
// module specializes each operation without a cast.

export const isFinal: (machine: Machine.Any, state: any) => state is any = internalPlanner.isFinal

export const state = (node: unknown): State<Machine.StateNodeConfig> => {
  const captured = StateDefinition.captureRoot(node) as Machine.StateNodeConfig
  const access = makeStateHelpers()
  return Object.freeze({ ...access, "~effect/Machine/State": "~effect/Machine/State", node: captured })
}

const makeStateHelpers = (): Machine.StateAccessors<{ readonly "": Machine.StateNodeConfig }> => {
  return {
    path: ((path: string) => path) as Machine.StateAccessors<{ readonly "": Machine.StateNodeConfig }>["path"],
    get:
      ((snapshot: Machine.AtomicSnapshot<string, unknown>, path: string) =>
        Topology.getSnapshotByPath(snapshot, path).pipe(
          Option.map((snapshot) => snapshot.value)
        )) as Machine.StateAccessors<{ readonly "": Machine.StateNodeConfig }>["get"],
    getWithParents: ((snapshot, path) => {
      const parents: Record<string, unknown> = {}
      return Topology.getSnapshotByPath(snapshot, path, parents).pipe(
        Option.map((snapshot) => ({ value: snapshot.value, parents }))
      )
    }) as Machine.StateAccessors<{ readonly "": Machine.StateNodeConfig }>["getWithParents"],
    getSnapshot: Topology.getSnapshotByPath as Machine.StateAccessors<
      { readonly "": Machine.StateNodeConfig }
    >["getSnapshot"],
    matches:
      ((snapshot: Machine.AtomicSnapshot<string, unknown>, path: string) =>
        Option.isSome(Topology.getSnapshotByPath(snapshot, path)))
  }
}

export const make = (
  config: {
    readonly id?: string
    readonly root: Machine.Any["root"]
    readonly effects?: unknown
    readonly streams?: unknown
    readonly timers?: unknown
    readonly logic?: unknown
    readonly children?: unknown
    readonly branches?: unknown
    readonly events: Machine.EventProtocol<"public", any>
    readonly internalEvents?: Machine.EventProtocol<"internal", any>
    readonly emittedEvents?: Machine.EventProtocol<"emitted", any>
    readonly parent?: Parent.Any | undefined
    readonly input?: Schema.Top
  }
): any => {
  if (Object.hasOwn(config, "initial") || Object.hasOwn(config, "initialConfiguration")) {
    throw new Error("Machine initial edges and root data belong in handle")
  }
  const states = Object.freeze({ "": config.root.node })
  const self = Object.create(PipeablePrototype)
  self.states = states
  self.root = config.root
  self.events = config.events
  self.internalEvents = config.internalEvents ?? Protocol.makeEventProtocol("internal", [] as const)
  self.emittedEvents = config.emittedEvents ?? Protocol.makeEventProtocol("emitted", [] as const)
  self.parent = config.parent
  self.input = config.input
  self.id = config.id
  self.handlers = Object.create(null)
  self.handle = makeHandle(self, Declaration.capture(config.root, config))
  Protocol.setProtocol(self)
  return self
}

const flattenEventProtocolInputs = <Kind extends Machine.EventProtocolKind>(
  kind: Kind,
  inputs: ReadonlyArray<Machine.EventProtocolInput<Kind>>
): ReadonlyArray<Machine.TaggedSchema> =>
  inputs.flatMap((input) =>
    Protocol.isEventProtocol(input, kind)
      ? Protocol.eventProtocolSchemas(input)
      : [input]
  )

export const events = <const Inputs extends ReadonlyArray<Machine.EventProtocolInput<"public">>>(
  ...inputs: Inputs
): Machine.EventProtocol<"public", Machine.EventProtocolInputSchemasOf<"public", Inputs>> =>
  Protocol.makeEventProtocol(
    "public",
    flattenEventProtocolInputs("public", inputs)
  ) as Machine.EventProtocol<"public", Machine.EventProtocolInputSchemasOf<"public", Inputs>>

const eventFieldSchemas = (
  cases: Readonly<Record<string, Schema.Struct.Fields>>
): ReadonlyArray<Machine.TaggedSchema> => {
  for (const [tag, fields] of Object.entries(cases)) {
    if (Object.hasOwn(fields, "_tag")) throw new Error(`Machine event "${tag}" fields cannot declare _tag`)
  }
  return Object.keys(cases).length === 0 ? [] : [Schema.TaggedUnion(cases)]
}

export const eventsFromFields = (
  cases: Readonly<Record<string, Schema.Struct.Fields>>
): Machine.EventProtocol<"public", any> => Protocol.makeEventProtocol("public", eventFieldSchemas(cases))
export const internalEventsFromFields = (
  cases: Readonly<Record<string, Schema.Struct.Fields>>
): Machine.EventProtocol<"internal", any> => Protocol.makeEventProtocol("internal", eventFieldSchemas(cases))
export const emittedEventsFromFields = (
  cases: Readonly<Record<string, Schema.Struct.Fields>>
): Machine.EventProtocol<"emitted", any> => Protocol.makeEventProtocol("emitted", eventFieldSchemas(cases))

const makeParent = <
  const Mode extends ParentMode,
  const Events extends ReadonlyArray<Machine.TaggedSchema>
>(
  mode: Mode,
  events: Machine.EventProtocol<"public", Events>
): Parent<Mode, Events> => {
  if (!Protocol.isEventProtocol(events, "public")) {
    throw new Error("Machine parent declarations require a protocol created with Machine.events")
  }
  return Object.freeze({ [ParentTypeId]: ParentTypeId, mode, events })
}

export const parent = <const Events extends ReadonlyArray<Machine.TaggedSchema>>(
  events: Machine.EventProtocol<"public", Events>
): Parent<"required", Events> => makeParent("required", events)

export const optionalParent = <const Events extends ReadonlyArray<Machine.TaggedSchema>>(
  events: Machine.EventProtocol<"public", Events>
): Parent<"optional", Events> => makeParent("optional", events)

export const internalEvents = <const Inputs extends ReadonlyArray<Machine.EventProtocolInput<"internal">>>(
  ...inputs: Inputs
): Machine.EventProtocol<"internal", Machine.EventProtocolInputSchemasOf<"internal", Inputs>> =>
  Protocol.makeEventProtocol(
    "internal",
    flattenEventProtocolInputs("internal", inputs)
  ) as Machine.EventProtocol<"internal", Machine.EventProtocolInputSchemasOf<"internal", Inputs>>

export const emittedEvents = <const Inputs extends ReadonlyArray<Machine.EventProtocolInput<"emitted">>>(
  ...inputs: Inputs
): Machine.EventProtocol<"emitted", Machine.EventProtocolInputSchemasOf<"emitted", Inputs>> =>
  Protocol.makeEventProtocol(
    "emitted",
    flattenEventProtocolInputs("emitted", inputs)
  ) as Machine.EventProtocol<"emitted", Machine.EventProtocolInputSchemasOf<"emitted", Inputs>>

export const encodeSnapshot: (
  machine: Machine.Any,
  snapshot: any
) => Effect.Effect<Machine.EncodedSnapshot, MachineSchemaEncodeError, any> = Serialization.encodeSnapshot

export const decodeSnapshot: (
  machine: Machine.Any,
  encoded: unknown
) => Effect.Effect<any, MachineSchemaDecodeError, any> = Serialization.decodeSnapshot

export const planInitial: (
  machine: Machine.Any,
  ...args: ReadonlyArray<any>
) => Effect.Effect<any, PlanningError | StartupError> = internalPlanner.planInitial

// Erased boundary: compiled nodes are stored with string paths; the generic
// machine type is the only source of their literal identifiers.
export const stateNodes = <M extends Machine.Any>(
  machine: M
): ReadonlyArray<
  Machine.StateNode<
    Machine.StateIdentifier<Machine.States<M>>,
    Machine.HistoryIdentifier<Machine.States<M>>,
    Machine.ChoiceIdentifier<Machine.States<M>>
  >
> =>
  Array.from(machine.stateNodes.byPath.values()) as unknown as ReadonlyArray<
    Machine.StateNode<
      Machine.StateIdentifier<Machine.States<M>>,
      Machine.HistoryIdentifier<Machine.States<M>>,
      Machine.ChoiceIdentifier<Machine.States<M>>
    >
  >

export const initialDefinition = <M extends Machine.Any>(
  machine: M
): Machine.InitialDefinition<
  Machine.RootStateIdentifier<Machine.StateIdentifier<Machine.States<M>>>
> =>
  machine.initialDefinition as Machine.InitialDefinition<
    Machine.RootStateIdentifier<Machine.StateIdentifier<Machine.States<M>>>
  >

export const inputEventSchemas = <M extends Machine.Any>(
  machine: M
): Machine.InputEvents<M> => Protocol.inputEventSchemas(machine)

export const transitionDefinitions = <M extends Machine.Any>(
  machine: M
): ReadonlyArray<
  Machine.TransitionDefinition<
    Machine.StateNodeIdentifier<Machine.States<M>>,
    Machine.TagOf<Machine.Events<M>[number]>,
    Machine.StateNodeIdentifier<Machine.States<M>>
  >
> =>
  Topology.transitionDefinitions(machine) as ReadonlyArray<
    Machine.TransitionDefinition<
      Machine.StateNodeIdentifier<Machine.States<M>>,
      Machine.TagOf<Machine.Events<M>[number]>,
      Machine.StateNodeIdentifier<Machine.States<M>>
    >
  >

export const activityDefinitions = <M extends Machine.Any>(
  machine: M
): ReadonlyArray<Machine.ActivityDefinition<Machine.StateIdentifier<Machine.States<M>>>> =>
  Activities.activityDefinitions(machine) as ReadonlyArray<
    Machine.ActivityDefinition<Machine.StateIdentifier<Machine.States<M>>>
  >

export const configuration = <M extends Machine.Any>(
  machine: M,
  state: Machine.Snapshot<Machine.States<M>>
): ReadonlyArray<
  Machine.ActiveStateNode<
    Machine.StateIdentifier<Machine.States<M>>,
    Machine.ChoiceIdentifier<Machine.States<M>>
  >
> => {
  const active = Configuration.normalizeConfiguration(machine, state).active
  return stateNodes(machine).filter(
    (node): node is Machine.ActiveStateNode<
      Machine.StateIdentifier<Machine.States<M>>,
      Machine.ChoiceIdentifier<Machine.States<M>>
    > => node.type !== "history" && node.type !== "choice" && active.has(node.path)
  )
}

export const enabled: (machine: Machine.Any, state: any) => ReadonlyArray<any> = internalPlanner.enabled

export const can: {
  (machine: Machine.Any): (state: any, event: any) => Effect.Effect<boolean, MachineSchemaDecodeError>
  (machine: Machine.Any, state: any, event: any): Effect.Effect<boolean, MachineSchemaDecodeError>
} = internalPlanner.can

export const plan: (
  machine: Machine.Any,
  state: any,
  event: any
) => Effect.Effect<any, PlanningError> = internalPlanner.plan

export const logic = <
  State,
  Event = never,
  Output = void,
  Error = never,
  Requirements = never,
  InitialError = never,
  InitialRequirements = never
>(
  options: {
    readonly initial:
      | State
      | ((
        scope: Logic.Scope<Event>
      ) => Effect.Effect<State, InitialError, InitialRequirements>)
    readonly run: (
      context: Logic.Context<State, Event>
    ) => Effect.Effect<Output, Error, Requirements>
  }
): Logic<State, Event, Error, Requirements | InitialRequirements, Output, InitialError> => ({
  initial: (scope) =>
    typeof options.initial === "function"
      ? (options.initial as (
        scope: Logic.Scope<Event>
      ) => Effect.Effect<State, InitialError, InitialRequirements>)(scope)
      : Effect.succeed(options.initial),
  run: options.run
})

export const transition = <State, Event, Error = never, Requirements = never>(
  initial: State,
  transition: (state: State, event: Event) => Effect.Effect<State, Error, Requirements>
): Logic<State, Event, Error, Requirements, never> =>
  logic<State, Event, never, Error, Requirements>({
    initial,
    run: ({ receive, updateState }) =>
      receive.pipe(
        Effect.flatMap((event) => updateState((state) => transition(state, event))),
        Effect.forever
      )
  })

export const child = <const Id extends string, M extends Machine.Any>(
  id: Id,
  machine: M
): ChildMachine<Id, M> =>
  makeChild(id, machine, (input) =>
    machine.input === undefined
      ? internalProcess.toProcessLogic(machine)
      : internalProcess.toProcessLogic(machine, input))

const makeChild = <const Id extends string, M extends Machine.Any>(
  id: Id,
  machine: M,
  makeLogic: (input?: unknown) => Logic<any, any, any, any, any, any>
): ChildMachine<Id, M> => ({
  [ChildMachineTypeId]: ChildMachineTypeId,
  id,
  machine,
  [ChildMachineLogicTypeId]: makeLogic
})

export const childFamily = <M extends Machine.Any>(machine: M): ChildMachine.Family<M> => {
  const makeLogic = (input?: unknown): Logic<any, any, any, any, any, any> =>
    machine.input === undefined
      ? internalProcess.toProcessLogic(machine)
      : internalProcess.toProcessLogic(machine, input)
  return (id) => makeChild(id, machine, makeLogic)
}

export const childAddress = <Event = never>(id: string): ChildAddress<Event> => id as ChildAddress<Event>

// The public `Machine` module declares the typed overloads and checks these
// erased implementations against them structurally.
export const spawn = (logic: Logic<any, any, any, any, any, any>, options?: SpawnOptions) =>
  Effect.flatMap(
    internalRuntime.MachineRuntime,
    // `SpawnOptions` declares only `id`; an absent id spawns an anonymous child.
    (runtime) => options?.id === undefined ? runtime.spawn(logic) : runtime.spawn(logic, { id: options.id })
  )

export const sendTo = (
  child: string | ChildMachine.Any,
  event: unknown
): Effect.Effect<void, StoppedError, MachineRuntimeRequirement> =>
  Effect.flatMap(
    internalRuntime.MachineRuntime,
    (runtime) => runtime.sendTo(child, event)
  )

export const stopChild = (
  child: string | ChildMachine.Any
): Effect.Effect<void, never, MachineRuntimeRequirement> =>
  Effect.flatMap(
    internalRuntime.MachineRuntime,
    (runtime) => runtime.stopChild(child)
  )

export const watch = <State, Event, Error = never, Output = never>(
  ref: MachineRef<State, Event, Error, Output>
): Stream.Stream<RuntimeOutcome<State, Error, Output>> => internalRuntime.watch(ref)

export const waitFor = Observation.waitFor

export const prepare: (
  machine: Machine.Any,
  ...args: ReadonlyArray<any>
) => Effect.Effect<internalRuntime.PreparedProcess<any, any, any, any, any, any, any>> = internalProcess.prepare

export const start: (
  machine: Machine.Any,
  ...args: ReadonlyArray<any>
) => Effect.Effect<MachineRef<any, any, any, any, any>, any, any> = internalProcess.start

export const resume: (
  machine: Machine.Any,
  snapshot: any
) => Effect.Effect<MachineRef<any, any, any, any, any>, MachineSchemaDecodeError, any> = internalProcess.resume
