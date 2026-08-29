import * as Effect from "effect/Effect"
import * as Inspectable from "effect/Inspectable"
import * as Option from "effect/Option"
import { Prototype as PipeablePrototype } from "effect/Pipeable"
import { hasProperty } from "effect/Predicate"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import type {
  ActionError,
  ChildAddress,
  ChildMachine,
  Command,
  Definition,
  ExecutionServices,
  InitialEvent as InitialEventModel,
  Logic,
  Machine,
  MachineRef,
  MachineSchemaDecodeError,
  MachineSchemaEncodeError,
  Parent,
  ParentMode,
  Runtime,
  RuntimeOutcome,
  SpawnOptions,
  StoppedError
} from "../../Machine.js"
import * as Activities from "./activities.js"
import * as Configuration from "./configuration.js"
import type { ChildAlreadyExistsError, InfiniteTransitionError, StartupError } from "./errors.js"
import * as internalPlanner from "./planner.js"
import * as internalProcess from "./process.js"
import * as Protocol from "./protocol.js"
import type { EnsureExecutable } from "./readiness.js"
import * as internalRuntime from "./runtime.js"
import * as Serialization from "./serialization.js"
import * as StateDefinition from "./stateDefinition.js"
import { ChildMachineLogicTypeId, SnapshotBuilderStateTypeId } from "./symbols.js"
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

const TypeId = "~effect/Machine"
const ParentTypeId = "~effect/Machine/Parent"
export const InvokeTypeId: unique symbol = Symbol.for("effect/Machine/Invoke")
export const TransitionTypeId: unique symbol = Symbol.for("effect/Machine/Transition")
const InvokeBuilderDescriptorTypeId: unique symbol = Symbol("effect/Machine/InvokeBuilderDescriptor")
const ChildMachineTypeId = "~effect/Machine/ChildMachine"
type IsAny<A> = 0 extends 1 & A ? true : false
type MachineRuntimeRequirement = internalRuntime.MachineRuntime
type ExcludeCompatibleRuntime<Requirements, Events, Emits> = Requirements extends Runtime.Requirement<
  infer RequiredEvents,
  infer RequiredEmits
> ? IsAny<Requirements> extends true ? Requirements
  : [RequiredEvents] extends [Events] ? [RequiredEmits] extends [Emits] ? never : Requirements
  : Requirements
  : Requirements
type SpawnRequirements<Requirements> = Exclude<Requirements, Scope.Scope>
type SpawnIdError<Options extends SpawnOptions> = "id" extends keyof Options ? Options extends {
    readonly id?: infer Id
  } ? [Id] extends [undefined] ? never : ChildAlreadyExistsError
  : ChildAlreadyExistsError
  : never
type SpawnError<Options extends SpawnOptions> = SpawnIdError<Options>
type SpawnResult<State, Event, Error, Requirements, Output, SpawnError, InitialError = never> = Effect.Effect<
  MachineRef<State, Event, Error, Output>,
  SpawnError | InitialError,
  MachineRuntimeRequirement | SpawnRequirements<Requirements>
>
type DefineStateTreeInput<States extends Machine.StateSchemas> = States
type ValidateDefinedStates<States extends Machine.StateSchemas> = [States] extends
  [Machine.ValidateStateSchemas<States>] ? []
  : [validation: Machine.ValidateStateSchemas<States>]
type InvalidDefinedStateTreeInput<States extends Machine.StateSchemas> = [States] extends
  [Machine.ValidateStateSchemas<States>] ? never
  : States & Machine.ValidateStateSchemas<States>
type ReusableStateNodeConfig =
  | Machine.AtomicStateNodeConfig
  | Machine.CompoundStateNodeConfig
  | Machine.ParallelStateNodeConfig
interface StateConstructor {
  <const Node extends ReusableStateNodeConfig>(node: Node): Node
}
interface StatesConstructor {
  <const States extends Machine.StateSchemas>(
    states: States,
    ..._validation: ValidateDefinedStates<NoInfer<States>>
  ): Machine.DefinedStates<States>
  <const States extends Machine.StateSchemas>(states: InvalidDefinedStateTreeInput<States>): never
}
type ValidateInputEventProtocol<InputEvents extends ReadonlyArray<Machine.TaggedSchema>> = InputEvents extends
  ReadonlyArray<Machine.TaggedSchema> ? unknown : never
type ValidateInternalEventProtocol<
  InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  InternalEvents extends ReadonlyArray<Machine.TaggedSchema>
> = InputEvents | InternalEvents extends ReadonlyArray<Machine.TaggedSchema> ? unknown : never

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
  self: Definition.Any,
  handlers: Machine.StateConfigs<any, any, any, any, any, any, any>
): Machine.Any => {
  const machine = Object.create(Proto)
  machine.states = self.states
  machine.events = self.events
  machine.internalEvents = self.internalEvents
  machine.emittedEvents = self.emittedEvents
  machine.parent = self.parent
  machine.input = self.input
  machine.id = self.id
  machine.initial = self.initial
  machine.initialDefinition = self.initialDefinition
  machine.stateNodes = self.stateNodes
  machine.makeTargetBuilder = self.makeTargetBuilder
  machine.handlers = handlers
  Protocol.copyProtocol(self, machine)
  return machine
}

type DefinitionBranch = {
  readonly target: (selector: unknown) => unknown
  readonly resolve?: (context: any, enqueue: unknown) => unknown
  readonly declinable?: boolean
}

type CapturedBranch = DefinitionBranch & {
  readonly selection: Topology.TargetSelection
}

type BranchDeclaration = {
  readonly title?: string
  readonly target: unknown
}

type CapturedNamedBranch = {
  readonly key: string
  readonly title: string
  readonly selection: Topology.TargetSelection
}

const TransitionBuilderDescriptorTypeId: unique symbol = Symbol("effect/Machine/TransitionBuilderDescriptor")

type DirectTransitionDescriptor = {
  readonly [TransitionBuilderDescriptorTypeId]: typeof TransitionBuilderDescriptorTypeId
  readonly type: "direct"
  readonly selection: Topology.TargetSelection
  readonly resolve?: (context: any, enqueue: unknown) => unknown
  readonly reenter: boolean
  readonly declinable: boolean
}

type BranchesTransitionDescriptor = {
  readonly [TransitionBuilderDescriptorTypeId]: typeof TransitionBuilderDescriptorTypeId
  readonly type: "branches"
  readonly declarations: unknown
  readonly resolve: (context: any, enqueue: unknown) => unknown
  readonly reenter: boolean
  readonly declinable: boolean
}

type TransitionBuilderDescriptor = DirectTransitionDescriptor | BranchesTransitionDescriptor

const InitialBuilderDescriptorTypeId: unique symbol = Symbol("effect/Machine/InitialBuilderDescriptor")

type InitialBuilderDescriptor = {
  readonly [InitialBuilderDescriptorTypeId]: typeof InitialBuilderDescriptorTypeId
  readonly selection: Topology.TargetSelection
  readonly resolve: (context: any) => unknown
}

const plainTargetSelection = (selection: Topology.TargetSelection): Topology.TargetSelection =>
  selection.kind === "none"
    ? Topology.noneTargetSelection
    : Topology.makeTargetSelection(selection.kind, selection.path, selection.scope, selection.updatePath)

const transitionOptions = (options: unknown): { readonly reenter: boolean; readonly declinable: boolean } => {
  const configuration = typeof options === "object" && options !== null
    ? options as { readonly reenter?: unknown; readonly declinable?: unknown }
    : {}
  return {
    reenter: configuration.reenter === true,
    declinable: configuration.declinable === true
  }
}

const makeDirectTransitionDescriptor = (
  selection: Topology.TargetSelection,
  resolve: ((context: any, enqueue: unknown) => unknown) | undefined,
  options: unknown
): DirectTransitionDescriptor => {
  const shared: Omit<DirectTransitionDescriptor, "resolve"> = {
    [TransitionBuilderDescriptorTypeId]: TransitionBuilderDescriptorTypeId,
    type: "direct",
    selection: plainTargetSelection(selection),
    ...transitionOptions(options)
  }
  return resolve === undefined
    ? Object.freeze(shared)
    : Object.freeze({ ...shared, resolve })
}

const decorateTransitionSelection = (selection: Topology.TargetSelection): Topology.TargetSelection =>
  Object.freeze({
    ...selection,
    resolve: (resolve: (context: any, enqueue: unknown) => unknown, options?: unknown) =>
      makeDirectTransitionDescriptor(selection, resolve, options),
    reenter: () => makeDirectTransitionDescriptor(selection, undefined, { reenter: true }),
    updating: (owner: unknown) => {
      if (typeof owner !== "function") {
        throw new Error("Machine updating owner must be a state selector")
      }
      const ownerSelection = owner()
      if (
        !Topology.isTargetSelection(ownerSelection) || ownerSelection.kind !== "state" ||
        ownerSelection.scope !== "branch"
      ) {
        throw new Error("Machine updating owner must be addressed by one branch state selector")
      }
      return decorateTransitionSelection(
        Topology.makeTargetSelection(selection.kind, selection.path, selection.scope, ownerSelection.path)
      )
    }
  })

const decorateStateUpdateSelection = (selection: Topology.TargetSelection): Topology.TargetSelection => {
  const update = (
    resolve: (context: any, enqueue: unknown) => unknown,
    options?: unknown
  ) => makeDirectTransitionDescriptor(selection, resolve, options)
  Object.assign(update, selection)
  return Object.freeze(update) as unknown as Topology.TargetSelection
}

const noneTransitionSelection = decorateTransitionSelection(Topology.noneTargetSelection)

const makeInitialBuilderDescriptor = (
  selection: Topology.TargetSelection,
  resolve: (context: any) => unknown
): InitialBuilderDescriptor =>
  Object.freeze({
    [InitialBuilderDescriptorTypeId]: InitialBuilderDescriptorTypeId,
    selection: plainTargetSelection(selection),
    resolve
  })

const decorateInitialSelection = (selection: Topology.TargetSelection): Topology.TargetSelection =>
  Object.freeze({
    ...selection,
    resolve: (resolve: (context: any) => unknown) => makeInitialBuilderDescriptor(selection, resolve)
  })

const decorateInitialSelectorNode = (node: unknown): unknown => {
  if (Topology.isTargetSelection(node)) return decorateInitialSelection(node)
  if (typeof node === "function") {
    const wrapped = ((...args: ReadonlyArray<unknown>) => decorateInitialSelection(node(...args))) as
      & ((...args: ReadonlyArray<unknown>) => unknown)
      & Record<string, unknown>
    for (const key of Object.keys(node)) {
      wrapped[key] = decorateInitialSelectorNode((node as unknown as Record<string, unknown>)[key])
    }
    return Object.freeze(wrapped)
  }
  if (typeof node === "object" && node !== null) {
    const wrapped: Record<string, unknown> = {}
    for (const key of Object.keys(node)) {
      wrapped[key] = decorateInitialSelectorNode((node as Record<string, unknown>)[key])
    }
    return Object.freeze(wrapped)
  }
  return node
}

const decorateTransitionSelectorNode = (node: unknown): unknown => {
  if (Topology.isTargetSelection(node)) {
    if (node.kind === "update") return decorateStateUpdateSelection(node)
    return node === Topology.noneTargetSelection ? noneTransitionSelection : decorateTransitionSelection(node)
  }
  if (typeof node === "function") {
    const wrapped = ((...args: ReadonlyArray<unknown>) => decorateTransitionSelection(node(...args))) as
      & ((...args: ReadonlyArray<unknown>) => unknown)
      & Record<string, unknown>
    for (const key of Object.keys(node)) {
      wrapped[key] = decorateTransitionSelectorNode((node as unknown as Record<string, unknown>)[key])
    }
    return Object.freeze(wrapped)
  }
  if (typeof node === "object" && node !== null) {
    const wrapped: Record<string, unknown> = {}
    for (const key of Object.keys(node)) {
      wrapped[key] = decorateTransitionSelectorNode((node as Record<string, unknown>)[key])
    }
    return Object.freeze(wrapped)
  }
  return node
}

const makeTransitionSelector = (
  stateNodes: Machine.StateNodes,
  source: string
): unknown => {
  const selector = {
    ...decorateTransitionSelectorNode(makeTargetSelector(stateNodes, source)) as Record<string, unknown>
  }
  selector.branches = (declarations: unknown) =>
    Object.freeze({
      resolve: (
        resolve: (context: any, enqueue: unknown) => unknown,
        options?: unknown
      ): BranchesTransitionDescriptor =>
        Object.freeze({
          [TransitionBuilderDescriptorTypeId]: TransitionBuilderDescriptorTypeId,
          type: "branches",
          declarations,
          resolve,
          ...transitionOptions(options)
        })
    })
  return Object.freeze(selector)
}

const normalizeTransitionBuilder = (
  transition: (selector: unknown) => unknown,
  stateNodes: Machine.StateNodes,
  path: string
): unknown => {
  const result = transition(makeTransitionSelector(stateNodes, path))
  if (Topology.isTargetSelection(result)) {
    const selection = plainTargetSelection(result)
    return { target: () => selection }
  }
  if (!hasProperty(result, TransitionBuilderDescriptorTypeId)) return result
  const descriptor = result as TransitionBuilderDescriptor
  if (descriptor.type === "branches") {
    return {
      branches: () => descriptor.declarations,
      resolve: descriptor.resolve,
      reenter: descriptor.reenter,
      declinable: descriptor.declinable
    }
  }
  return {
    target: () => descriptor.selection,
    resolve: descriptor.resolve,
    reenter: descriptor.reenter,
    declinable: descriptor.declinable
  }
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

const makeSelectionMethod = (
  kind: Topology.TargetSelectionKind,
  path: string | undefined,
  scope: Topology.TargetSelectionScope
): () => Topology.TargetSelection =>
() => Topology.makeTargetSelection(kind, path, scope)

const makeSelectionValue = (
  kind: Topology.TargetSelectionKind,
  path: string | undefined,
  scope: Topology.TargetSelectionScope
): Topology.TargetSelection => Topology.makeTargetSelection(kind, path, scope)

const makeStateUpdateSelection = (
  path: string,
  scope: "local" | "branch"
): Topology.TargetSelection => Topology.makeTargetSelection("update", path, scope)

const addSelectionChildren = (
  builder: Record<string, unknown>,
  stateNodes: Machine.StateNodes,
  parent: string,
  scope: "local" | "branch",
  source?: string
): void => {
  for (const node of stateNodes.byPath.values()) {
    if (node.parent !== parent || node.type === "history") continue
    builder[node.key] = makeSelectionNode(stateNodes, node.path, scope, source)
  }
}

const makeSelectionNode = (
  stateNodes: Machine.StateNodes,
  path: string,
  scope: Topology.TargetSelectionScope,
  source?: string
): unknown => {
  const node = getTargetBuilderNode(stateNodes, path)
  const kind: Topology.TargetSelectionKind = node.type === "choice" ? "choice" : "state"
  const method = makeSelectionMethod(kind, path, scope) as unknown as Record<string, unknown>
  if (node.type !== "atomic" && node.type !== "final" && node.type !== "choice" && node.type !== "history") {
    Object.defineProperty(method, "initial", {
      value: makeSelectionValue("initial", path, scope),
      enumerable: true
    })
    if (scope === "local" || scope === "branch") {
      addSelectionChildren(method, stateNodes, path, scope, source)
    }
    if (
      scope === "branch" && source !== undefined && node.schema !== undefined &&
      (source === path || source.startsWith(`${path}.`)) &&
      getTargetBuilderNode(stateNodes, source).type !== "choice"
    ) {
      Object.defineProperty(method, "update", {
        value: makeStateUpdateSelection(path, "branch"),
        enumerable: true
      })
    }
  }
  return method
}

const makeHistorySelectionTree = (
  stateNodes: Machine.StateNodes,
  parent: string | undefined
): Record<string, unknown> => {
  const builder: Record<string, unknown> = {}
  for (const node of stateNodes.byPath.values()) {
    if (node.parent !== parent) continue
    if (node.type === "history") {
      builder[node.key] = makeSelectionValue("history", node.path, "full")
    } else if (node.type !== "choice") {
      const children = makeHistorySelectionTree(stateNodes, node.path)
      if (Object.keys(children).length > 0) builder[node.key] = children
    }
  }
  return builder
}

const makeTargetSelector = (
  stateNodes: Machine.StateNodes,
  source: string
): unknown => {
  const full: Record<string, unknown> = {}
  for (const node of stateNodes.byPath.values()) {
    if (node.parent === undefined && node.type !== "history" && node.type !== "choice") {
      full[node.key] = makeSelectionNode(stateNodes, node.path, "full")
    }
  }
  const branch: Record<string, unknown> = {}
  const root = getTargetBuilderNode(stateNodes, source.split(".")[0]!)
  branch[root.key] = makeSelectionNode(stateNodes, root.path, "branch", source)
  const local: Record<string, unknown> = {}
  const localScope = getLocalTargetScope(stateNodes, source)
  if (localScope !== undefined) {
    const localScopeNode = getTargetBuilderNode(stateNodes, localScope)
    if (localScopeNode.schema !== undefined) {
      local.with = makeSelectionValue("state", localScope, "local")
      if (getTargetBuilderNode(stateNodes, source).type !== "choice") {
        local.update = makeStateUpdateSelection(localScope, "local")
      }
    }
    addSelectionChildren(local, stateNodes, localScope, "local")
  }
  return {
    none: Topology.noneTargetSelection,
    local,
    branch,
    full,
    history: makeHistorySelectionTree(stateNodes, undefined)
  }
}

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
      selection.kind !== "state" || (selection.scope !== "local" && selection.scope !== "branch") ||
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

const makeUpdatingConstruction = (
  target: unknown,
  ownerPath: string
): { readonly update: (update: unknown) => Topology.CombinedTarget } =>
  Object.freeze({
    update: (update: unknown) => {
      if (!Topology.isStateUpdate(update) || update.path !== ownerPath) {
        throw new Error(`Machine combined target must update its declared owner "${ownerPath}"`)
      }
      return Topology.makeCombinedTarget(target, update)
    }
  })

const makeUpdatingTargetBuilder = (
  builder: unknown,
  ownerPath: string
): unknown => {
  if (typeof builder !== "object" || builder === null) {
    throw new Error("Machine combined target requires a state construction builder")
  }
  const updating: Record<PropertyKey, unknown> = {}
  for (const property of Reflect.ownKeys(builder)) {
    const descriptor = Object.getOwnPropertyDescriptor(builder, property)
    if (descriptor === undefined) continue
    if (
      (property === "from" || property === "decoded") && "value" in descriptor && typeof descriptor.value === "function"
    ) {
      const construct = descriptor.value
      descriptor.value = (...args: ReadonlyArray<unknown>) => makeUpdatingConstruction(construct(...args), ownerPath)
    }
    Object.defineProperty(updating, property, descriptor)
  }
  return Object.freeze(updating)
}

const getSelectionBuilder = (
  target: Record<string, any>,
  selection: Topology.TargetSelection,
  stateNodes: Machine.StateNodes,
  source: string
): unknown => {
  if (selection.kind === "none") return target.none
  if (selection.kind === "update") {
    return withFrom(
      (value: unknown) => Topology.makeStateUpdate(selection.path!, value),
      "leaf",
      true
    )
  }
  let builder: any
  let parts = selection.path!.split(".")
  if (selection.kind === "history") {
    builder = target.history
  } else if (selection.scope === "local") {
    builder = target.local
    const scope = getLocalTargetScope(stateNodes, source)
    if (scope !== undefined) {
      if (selection.path === scope) {
        builder = builder.with
        parts = []
      } else {
        parts = selection.path!.slice(scope.length + 1).split(".")
      }
    }
  } else if (selection.scope === "branch") {
    builder = target.branch
  } else {
    builder = target.full
  }
  for (const part of parts) builder = builder[part]
  if (selection.kind === "initial") builder = builder.initial
  if (
    typeof builder !== "function" &&
    (typeof builder !== "object" || builder === null || typeof builder.from !== "function")
  ) {
    throw new Error(`Machine could not construct selected transition target "${selection.path}"`)
  }
  return selection.updatePath === undefined ? builder : makeUpdatingTargetBuilder(builder, selection.updatePath)
}

const constructSelectedTarget = (builder: any): unknown =>
  typeof builder?.from === "function" ? builder.from() : builder()

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
    (resultPath !== selection.path && !(acceptsDescendant && resultPath.startsWith(`${selection.path}.`)))
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
  const selectedTarget = getSelectionBuilder(context.target, branch.selection, stateNodes, source)
  if (branch.resolve === undefined) return constructSelectedTarget(selectedTarget)
  const resolverContext = { ...context }
  if (branch.selection.kind === "none") delete resolverContext.target
  else resolverContext.target = selectedTarget
  if (branch.selection.kind === "update") {
    const ownerPath = branch.selection.path!
    delete resolverContext.target
    resolverContext.current = context.ancestors[ownerPath] ?? context.state
    resolverContext.owner = getSelectionBuilder(
      context.target,
      makeStateUpdateSelection(ownerPath, branch.selection.scope === "local" ? "local" : "branch"),
      stateNodes,
      source
    )
  } else if (branch.selection.updatePath !== undefined) {
    const ownerPath = branch.selection.updatePath
    resolverContext.current = context.ancestors[ownerPath]
    resolverContext.owner = getSelectionBuilder(
      context.target,
      makeStateUpdateSelection(ownerPath, "branch"),
      stateNodes,
      source
    )
  }
  if (branch.declinable === true) resolverContext.decline = Topology.makeDeclined
  const resolved = branch.resolve(resolverContext, enqueue)
  if (Topology.isDeclined(resolved)) {
    if (branch.declinable !== true) {
      throw new Error(`Machine transition for state "${source}" returned decline without declaring declinable: true`)
    }
    return resolved
  }
  validateResolvedSelection(resolved, branch.selection, stateNodes)
  return resolved === undefined ? constructSelectedTarget(selectedTarget) : resolved
}

const topologyTargetPath = (selection: Topology.TargetSelection): string | undefined =>
  selection.kind === "update" ? undefined : selection.path

const isArrayIndexKey = (key: string): boolean => {
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && index < 0xffff_ffff && String(index) === key
}

const captureNamedBranches = (
  declarations: unknown,
  path: string,
  trigger: PropertyKey
): ReadonlyArray<CapturedNamedBranch> => {
  if (typeof declarations !== "object" || declarations === null || Array.isArray(declarations)) {
    throw new Error(`Machine branching transition for state "${path}" on "${String(trigger)}" requires a branch record`)
  }
  if (Object.getOwnPropertySymbols(declarations).length > 0) {
    throw new Error(`Machine branching transition for state "${path}" on "${String(trigger)}" cannot use symbol keys`)
  }
  const keys = Object.keys(declarations)
  if (keys.length === 0) {
    throw new Error(`Machine branching transition for state "${path}" on "${String(trigger)}" requires a branch`)
  }
  return Object.freeze(keys.map((key) => {
    if (key.length === 0 || isArrayIndexKey(key)) {
      throw new Error(
        `Machine branching transition for state "${path}" on "${String(trigger)}" requires non-index string branch keys`
      )
    }
    const declaration = (declarations as Record<string, unknown>)[key]
    if (typeof declaration !== "object" || declaration === null || !hasProperty(declaration, "target")) {
      throw new Error(`Machine transition branch "${key}" requires a target selection`)
    }
    const { target, title } = declaration as BranchDeclaration
    if (!Topology.isTargetSelection(target)) {
      throw new Error(`Machine transition branch "${key}" must select exactly one target`)
    }
    if (target.updatePath !== undefined) {
      throw new Error(`Machine transition branch "${key}" cannot declare an updating target`)
    }
    if (title !== undefined && (typeof title !== "string" || title.length === 0)) {
      throw new Error(`Machine transition branch "${key}" title must be a non-empty string`)
    }
    return Object.freeze({ key, title: title ?? key, selection: plainTargetSelection(target) })
  }))
}

const wrapSelectedBranchBuilder = (
  builder: unknown,
  owner: object,
  branchIndex: number,
  branchKey: string
): unknown => {
  if (typeof builder === "function") {
    const wrapped = (...args: ReadonlyArray<unknown>) =>
      Topology.makeSelectedBranch(owner, branchIndex, branchKey, builder(...args))
    for (const property of Reflect.ownKeys(builder)) {
      if (
        property === "length" || property === "name" || property === "prototype" || property === "caller" ||
        property === "arguments"
      ) continue
      const descriptor = Object.getOwnPropertyDescriptor(builder, property)
      if (descriptor === undefined) continue
      if ("value" in descriptor && typeof descriptor.value === "function") {
        descriptor.value = wrapSelectedBranchBuilder(descriptor.value, owner, branchIndex, branchKey)
      }
      Object.defineProperty(wrapped, property, descriptor)
    }
    return wrapped
  }
  if (typeof builder === "object" && builder !== null) {
    const wrapped: Record<PropertyKey, unknown> = {}
    for (const property of Reflect.ownKeys(builder)) {
      const descriptor = Object.getOwnPropertyDescriptor(builder, property)
      if (descriptor === undefined) continue
      if ("value" in descriptor && typeof descriptor.value === "function") {
        descriptor.value = wrapSelectedBranchBuilder(descriptor.value, owner, branchIndex, branchKey)
      }
      Object.defineProperty(wrapped, property, descriptor)
    }
    return wrapped
  }
  throw new Error(`Machine could not construct transition branch "${branchKey}"`)
}

const makeBranchSelectors = (
  context: Record<string, any>,
  branches: ReadonlyArray<CapturedNamedBranch>,
  owner: object,
  stateNodes: Machine.StateNodes,
  source: string
): Readonly<Record<string, unknown>> => {
  const select: Record<string, unknown> = Object.create(null)
  for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
    const branch = branches[branchIndex]!
    select[branch.key] = wrapSelectedBranchBuilder(
      getSelectionBuilder(context.target, branch.selection, stateNodes, source),
      owner,
      branchIndex,
      branch.key
    )
  }
  return Object.freeze(select)
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

const captureTransition = (
  rawTransition: unknown,
  stateNodes: Machine.StateNodes,
  path: string,
  trigger: PropertyKey
): unknown => {
  if (typeof rawTransition !== "function") {
    throw new Error(
      `Machine transition for state "${path}" on "${String(trigger)}" must be a target-first callback`
    )
  }
  const transition = normalizeTransitionBuilder(rawTransition as (selector: unknown) => unknown, stateNodes, path)
  if (typeof transition !== "object" || transition === null) {
    throw new Error(`Machine transition for state "${path}" on "${String(trigger)}" must be an object`)
  }
  const definition = transition as Record<PropertyKey, unknown>
  const selector = makeTargetSelector(stateNodes, path)
  const reenter = definition.reenter === true
  const declinable = definition.declinable === true
  if (hasProperty(definition, "branches")) {
    const branching = definition as { readonly branches: unknown; readonly resolve?: unknown }
    if (typeof branching.branches !== "function" || typeof branching.resolve !== "function") {
      throw new Error(
        `Machine branching transition for state "${path}" on "${String(trigger)}" requires branches and resolve`
      )
    }
    const resolve = branching.resolve
    const branches = captureNamedBranches(branching.branches(selector), path, trigger)
    const owner = Object.freeze({})
    const evaluate = (context: Record<string, any>, enqueue: unknown) => {
      const resolverContext = { ...context }
      delete resolverContext.target
      resolverContext.select = makeBranchSelectors(context, branches, owner, stateNodes, path)
      if (declinable) resolverContext.decline = Topology.makeDeclined
      const selected = resolve(resolverContext, enqueue)
      if (Topology.isDeclined(selected)) {
        if (!declinable) {
          throw new Error(
            `Machine branching transition for state "${path}" on "${
              String(trigger)
            }" returned decline without declaring declinable: true`
          )
        }
        return { result: selected, branchIndex: -1, branchKey: undefined }
      }
      if (!Topology.isSelectedBranch(selected) || selected.owner !== owner) {
        throw new Error(
          `Machine branching transition for state "${path}" on "${String(trigger)}" must select one declared branch`
        )
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
      declinable,
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
          title: branch.title,
          target: topologyTargetPath(branch.selection),
          selection: transitionTargetSelection(branch.selection),
          updates: selectionUpdates(branch.selection)
        })
      ),
      evaluate,
      transition: (context: Record<string, any>, enqueue: unknown) => evaluate(context, enqueue).result
    }
  }
  const branch = captureDefinitionBranch(transition, selector, stateNodes, path, trigger)
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
  path: string
): Record<PropertyKey, unknown> => {
  // The machine owns its dispatch table. Compiled plans may snapshot these
  // definitions, so retaining caller-owned containers would let strategies
  // observe different handlers after an unsafe external mutation.
  const captured: Record<PropertyKey, unknown> = Object.create(null)
  for (const event of Reflect.ownKeys(on)) {
    captured[event] = captureTransition((on as Record<PropertyKey, unknown>)[event], stateNodes, path, event)
  }
  return captured
}

interface InvokeBuilderDescriptor {
  readonly [InvokeBuilderDescriptorTypeId]: typeof InvokeBuilderDescriptorTypeId
  readonly config: Readonly<Record<PropertyKey, unknown>>
}

type InvokeBuilderChannel = "onDone" | "onFailure" | "onElement" | "onSnapshot"

const makeInvokeBuilder = (
  config: Readonly<Record<PropertyKey, unknown>>,
  channels: ReadonlyArray<InvokeBuilderChannel>
): InvokeBuilderDescriptor => {
  const builder: Record<PropertyKey, unknown> = {
    [InvokeBuilderDescriptorTypeId]: InvokeBuilderDescriptorTypeId as typeof InvokeBuilderDescriptorTypeId,
    config
  }
  for (const channel of channels) {
    if (!hasProperty(config, channel)) {
      builder[channel] = (handler: unknown) => makeInvokeBuilder({ ...config, [channel]: handler }, channels)
    }
  }
  return Object.freeze(builder) as unknown as InvokeBuilderDescriptor
}

const invokeSelector = Object.freeze({
  effect: (id: string, effect: unknown) => makeInvokeBuilder({ id, effect }, ["onDone", "onFailure"]),
  stream: (id: string, stream: unknown) => makeInvokeBuilder({ id, stream }, ["onElement", "onDone", "onFailure"]),
  timer: (id: string, after: unknown) => makeInvokeBuilder({ id, after }, ["onDone"]),
  logic: (id: string, options: Readonly<Record<PropertyKey, unknown>>) =>
    makeInvokeBuilder({ id, ...options }, ["onSnapshot", "onDone", "onFailure"]),
  child: (child: unknown, options?: Readonly<Record<PropertyKey, unknown>>) =>
    makeInvokeBuilder(options === undefined ? { child } : { child, ...options }, [
      "onSnapshot",
      "onDone",
      "onFailure"
    ])
})

const invokeBuilderConfig = (value: unknown, path: string): Readonly<Record<PropertyKey, unknown>> => {
  if (
    typeof value !== "object" || value === null ||
    !hasProperty(value, InvokeBuilderDescriptorTypeId) ||
    value[InvokeBuilderDescriptorTypeId] !== InvokeBuilderDescriptorTypeId
  ) {
    throw new Error(`Machine invocation for state "${path}" must be constructed from its source selector`)
  }
  return (value as unknown as InvokeBuilderDescriptor).config
}

const captureInvokeDefinition = (
  invoke: unknown,
  stateNodes: Machine.StateNodes,
  path: string
): unknown => {
  if (typeof invoke !== "function") {
    throw new Error(`Machine invocation for state "${path}" must be a source-first callback`)
  }
  const authored = invoke(invokeSelector)
  const definitions = Array.isArray(authored) ? authored : [authored]
  const capturedDefinitions = definitions.map((definition) => {
    const captured = { ...invokeBuilderConfig(definition, path) }
    for (const key of ["onElement", "onDone", "onFailure", "onSnapshot"] as const) {
      if (captured[key] !== undefined) {
        captured[key] = captureTransition(captured[key], stateNodes, path, key)
      }
    }
    return captured
  })
  if (Array.isArray(authored)) return capturedDefinitions
  return capturedDefinitions[0]
}

const flattenHandlers = (
  handlers: Record<PropertyKey, Machine.AnyStateConfig>,
  stateNodes: Machine.StateNodes,
  states: Machine.StateTree,
  prefix: string,
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
    const on = stateConfig.on
    if (typeof on === "object" && on !== null) {
      const capturedOn = captureEventHandlers(on, stateNodes, path)
      stateConfig.on = capturedOn
    }
    if (stateConfig.always !== undefined) {
      stateConfig.always = captureTransition(stateConfig.always, stateNodes, path, "always")
    }
    if (stateConfig.onDone !== undefined) {
      stateConfig.onDone = captureTransition(stateConfig.onDone, stateNodes, path, "done")
    }
    if (stateConfig.choice !== undefined) {
      stateConfig.choice = captureTransition(stateConfig.choice, stateNodes, path, "choice")
    }
    if (stateConfig.invoke !== undefined) {
      stateConfig.invoke = captureInvokeDefinition(stateConfig.invoke, stateNodes, path)
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
    handlers[path] = stateConfig as Machine.AnyStateConfig
    if (childConfig !== undefined) {
      const node = Topology.getStateNodeDefinition(path, states[key]!)
      if (node.states === undefined) {
        throw new Error(`Machine expected state "${path}" to declare child states`)
      }
      if (typeof childConfig !== "object" || childConfig === null) {
        throw new Error(`Machine expected state "${path}" child handlers to be an object`)
      }
      flattenHandlers(handlers, stateNodes, node.states, path, childConfig as Record<string, unknown>)
    }
  }
}

const makeHandle = (self: Definition.Any): Definition.Any["handle"] =>
  ((config: Record<string, unknown>) => {
    const handlers: Record<PropertyKey, Machine.AnyStateConfig> = Object.create(null)
    flattenHandlers(handlers, self.stateNodes, self.states, "", config)
    return makeWithHandlers(self, handlers)
  }) as Definition.Any["handle"]

export const isMachine = (
  u: unknown
): u is Machine.Any => hasProperty(u, TypeId) && u[TypeId] === TypeId

export const isFinal = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema>,
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events
>(
  machine: Machine<
    States,
    Events,
    Input,
    UnhandledStates,
    E,
    R,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    Emits,
    OutputStates,
    InputEvents
  >,
  state: Machine.Snapshot<States>
): state is Machine.SnapshotContainingFinal<States, FinalStates> => internalPlanner.isFinal(machine as any, state)

type SnapshotBuilderOptions = {
  readonly mode: "initial" | "full"
  readonly prefix: string
}

type FromMethodKind = "leaf" | "nested"

const withFrom = <Method extends (value: unknown, ...args: ReadonlyArray<any>) => unknown>(
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

const makeSnapshotBuilder = (
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

const getTargetBuilderNode = (
  stateNodes: Machine.StateNodes,
  path: string
): Machine.StateNode => {
  const node = stateNodes.byPath.get(path)
  if (node === undefined) {
    throw new Error(`Machine expected state path "${path}" to exist`)
  }
  return node
}

const getLocalTargetScope = (
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

const makeTargetBuilder = <const States extends Machine.StateSchemas>(
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

const makeInitialSelector = (stateNodes: Machine.StateNodes): unknown => {
  const selector: Record<string, unknown> = {}
  for (const node of stateNodes.byPath.values()) {
    if (node.parent === undefined && node.type !== "history" && node.type !== "choice") {
      selector[node.key] = node.type === "atomic" || node.type === "final"
        ? makeSelectionMethod("state", node.path, "initial")
        : Object.freeze({ initial: makeSelectionValue("initial", node.path, "initial") })
    }
  }
  return Object.freeze(selector)
}

const getInitialSelectionBuilder = (
  initialBuilder: Record<string, any>,
  selection: Topology.TargetSelection
): Record<string, any> => {
  const path = selection.path
  if (path === undefined || path.includes(".")) {
    throw new Error("Machine initial target must select one top-level state")
  }
  const builder = initialBuilder[path]
  if (typeof builder !== "object" || builder === null || typeof builder.from !== "function") {
    throw new Error(`Machine could not construct selected initial state "${path}"`)
  }
  return builder
}

const captureInitialBranch = (
  definition: unknown,
  stateNodes: Machine.StateNodes,
  initialBuilder: Record<string, any>
): {
  readonly selection: Topology.TargetSelection
  readonly resolve?: (context: any) => unknown
  readonly builder: Record<string, any>
} => {
  if (typeof definition !== "function") {
    throw new Error("Machine initial definition must be a target-first callback")
  }
  const result = definition(decorateInitialSelectorNode(makeInitialSelector(stateNodes)))
  let selection: Topology.TargetSelection
  let resolve: ((context: any) => unknown) | undefined
  if (Topology.isTargetSelection(result)) {
    selection = plainTargetSelection(result)
  } else if (hasProperty(result, InitialBuilderDescriptorTypeId)) {
    const descriptor = result as InitialBuilderDescriptor
    selection = descriptor.selection
    resolve = descriptor.resolve
  } else {
    throw new Error("Machine initial definition must select exactly one target")
  }
  if (selection.kind !== "state" && selection.kind !== "initial") {
    throw new Error("Machine initial target must select a top-level state or its declared initial entry")
  }
  const captured = {
    selection,
    builder: getInitialSelectionBuilder(initialBuilder, selection)
  }
  return resolve === undefined ? Object.freeze(captured) : Object.freeze({ ...captured, resolve })
}

const validateInitialSelection = (result: unknown, selection: Topology.TargetSelection): void => {
  if (
    typeof result !== "object" || result === null || !hasProperty(result, "path") || result.path !== selection.path
  ) {
    const resultPath = typeof result === "object" && result !== null && hasProperty(result, "path")
      ? String(result.path)
      : "<invalid>"
    throw new Error(`Machine initial resolver selected "${selection.path}" but constructed "${resultPath}"`)
  }
}

const compileInitial = (
  definition: unknown,
  states: Machine.StateTree,
  stateNodes: Machine.StateNodes
): {
  readonly initial: (input?: unknown) => unknown
  readonly definition: Machine.InitialDefinition
} => {
  const initialBuilder = makeSnapshotBuilder(states, { mode: "initial", prefix: "" }) as Record<string, any>
  const branch = captureInitialBranch(definition, stateNodes, initialBuilder)
  return {
    initial: (input?: unknown) => {
      const result = branch.resolve === undefined
        ? constructSelectedTarget(branch.builder)
        : branch.resolve({ input, target: branch.builder })
      validateInitialSelection(result, branch.selection)
      return result
    },
    definition: Object.freeze({
      target: branch.selection.path!,
      selection: transitionTargetSelection(branch.selection) as Machine.InitialDefinition["selection"]
    })
  }
}

export const state: StateConstructor = (<const Node extends ReusableStateNodeConfig>(node: Node): Node => {
  StateDefinition.validateStateDefinitions({ state: node }, "Machine.state")
  return StateDefinition.captureStateDefinitions({ state: node }).state
}) as StateConstructor

export const states: StatesConstructor = (<const States extends Machine.StateSchemas>(
  states: States
): Machine.DefinedStates<States> => {
  StateDefinition.validateStateDefinitions(states, "Machine.states")
  const captured = StateDefinition.captureStateDefinitions(states)
  return {
    states: captured,
    path: ((path: string) => path) as Machine.DefinedStates<States>["path"],
    get:
      ((snapshot: Machine.AtomicSnapshot<string, unknown>, path: string) =>
        Topology.getSnapshotByPath(snapshot, path).pipe(
          Option.map((snapshot) => snapshot.value)
        )) as Machine.DefinedStates<States>["get"],
    getWithParents: ((snapshot, path) => {
      const parents: Record<string, unknown> = {}
      return Topology.getSnapshotByPath(snapshot, path, parents).pipe(
        Option.map((snapshot) => ({ value: snapshot.value, parents }))
      )
    }) as Machine.DefinedStates<States>["getWithParents"],
    getSnapshot: Topology.getSnapshotByPath as unknown as Machine.DefinedStates<States>["getSnapshot"],
    matches:
      ((snapshot: Machine.AtomicSnapshot<string, unknown>, path: string) =>
        Option.isSome(Topology.getSnapshotByPath(snapshot, path))) as Machine.DefinedStates<States>["matches"]
  }
}) as StatesConstructor

type MakeConfig<
  States extends Machine.StateSchemas,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  Emits extends ReadonlyArray<Machine.TaggedSchema>,
  Input extends Schema.Top,
  InitialE,
  InitialR,
  InternalEvents extends ReadonlyArray<Machine.TaggedSchema>,
  ParentDeclaration extends Parent.Any | undefined
> = {
  readonly id?: string
  readonly states: States & DefineStateTreeInput<NoInfer<States>>
  readonly events:
    & Machine.EventProtocol<"public", InputEvents>
    & ValidateInputEventProtocol<NoInfer<InputEvents>>
  readonly internalEvents?:
    & Machine.EventProtocol<"internal", InternalEvents>
    & ValidateInternalEventProtocol<
      NoInfer<InputEvents>,
      NoInfer<InternalEvents>
    >
  readonly emittedEvents?: Machine.EventProtocol<"emitted", Emits>
  readonly parent?: ParentDeclaration
  readonly input?: Input
  readonly initial: unknown
}

type MakeResult<
  States extends Machine.StateSchemas,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  Emits extends ReadonlyArray<Machine.TaggedSchema>,
  Input extends Schema.Top,
  InitialE,
  InitialR,
  InternalEvents extends ReadonlyArray<Machine.TaggedSchema>,
  ParentDeclaration extends Parent.Any | undefined
> = Definition<
  States,
  readonly [...InputEvents, ...InternalEvents],
  Input,
  InitialE,
  InitialR,
  Machine.FinalStateFromDefinition<States>,
  Machine.TerminalOutput<States>,
  Emits,
  InputEvents,
  Machine.ParentEventsOf<ParentDeclaration>
>

interface Make {
  <
    const States extends Machine.StateSchemas,
    const InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
    const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
    const Input extends Schema.Top = typeof Schema.Void,
    InitialE = never,
    InitialR = never,
    const InternalEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
    const ParentDeclaration extends Parent.Any | undefined = undefined
  >(
    config: MakeConfig<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents, ParentDeclaration>,
    ..._validation: ValidateDefinedStates<NoInfer<States>>
  ): MakeResult<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents, ParentDeclaration>
  <
    const States extends Machine.StateSchemas,
    const InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
    const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
    const Input extends Schema.Top = typeof Schema.Void,
    InitialE = never,
    InitialR = never,
    const InternalEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
    const ParentDeclaration extends Parent.Any | undefined = undefined
  >(
    config:
      & Omit<
        MakeConfig<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents, ParentDeclaration>,
        "states"
      >
      & { readonly states: InvalidDefinedStateTreeInput<States> }
  ): never
}

export const make: Make = (<
  const States extends Machine.StateSchemas,
  const InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  InitialE = never,
  InitialR = never,
  const InternalEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const ParentDeclaration extends Parent.Any | undefined = undefined
>(
  config: {
    readonly id?: string
    readonly states: States
    readonly events: Machine.EventProtocol<"public", InputEvents>
    readonly internalEvents?: Machine.EventProtocol<"internal", InternalEvents>
    readonly emittedEvents?: Machine.EventProtocol<"emitted", Emits>
    readonly parent?: ParentDeclaration
    readonly input?: Input
    readonly initial: unknown
  }
): MakeResult<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents, ParentDeclaration> => {
  StateDefinition.validateStateDefinitions(config.states, "Machine.make")
  const self = Object.create(Proto)
  self.states = config.states
  self.events = config.events
  self.internalEvents = config.internalEvents ?? Protocol.makeEventProtocol("internal", [] as const)
  self.emittedEvents = config.emittedEvents ?? Protocol.makeEventProtocol("emitted", [] as const)
  self.parent = config.parent
  self.input = config.input
  self.id = config.id
  self.stateNodes = Topology.compileStateNodes(config.states)
  const compiledInitial = compileInitial(config.initial, config.states, self.stateNodes)
  self.initial = compiledInitial.initial
  self.initialDefinition = compiledInitial.definition
  self.makeTargetBuilder = makeTargetBuilder(config.states, self.stateNodes)
  self.handlers = Object.create(null)
  self.handle = makeHandle(self)
  Protocol.setProtocol(self)
  return self
}) as Make

const flattenEventProtocolInputs = <Kind extends Machine.EventProtocolKind>(
  kind: Kind,
  inputs: ReadonlyArray<Machine.EventProtocolInput<Kind>>
): ReadonlyArray<Machine.TaggedSchema> =>
  inputs.flatMap((input) =>
    Protocol.isEventProtocol(input, kind)
      ? Protocol.eventProtocolSchemas(input)
      : [input as Machine.TaggedSchema]
  )

export const events = <const Inputs extends ReadonlyArray<Machine.EventProtocolInput<"public">>>(
  ...inputs: Inputs
): Machine.EventProtocol<"public", Machine.EventProtocolInputSchemasOf<"public", Inputs>> =>
  Protocol.makeEventProtocol(
    "public",
    flattenEventProtocolInputs("public", inputs)
  ) as Machine.EventProtocol<"public", Machine.EventProtocolInputSchemasOf<"public", Inputs>>

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

export const encodeSnapshot: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events
>(
  machine: Machine<
    States,
    Events,
    Input,
    UnhandledStates,
    E,
    R,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    Emits,
    OutputStates,
    InputEvents
  >,
  snapshot: Machine.Snapshot<States>
) => Effect.Effect<
  Machine.EncodedSnapshot,
  MachineSchemaEncodeError,
  Machine.SnapshotEncodingServices<States>
> = Serialization.encodeSnapshot as any

export const decodeSnapshot: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events
>(
  machine: Machine<
    States,
    Events,
    Input,
    UnhandledStates,
    E,
    R,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    Emits,
    OutputStates,
    InputEvents
  >,
  encoded: unknown
) => Effect.Effect<
  Machine.Snapshot<States>,
  MachineSchemaDecodeError,
  Machine.SnapshotDecodingServices<States>
> = Serialization.decodeSnapshot as any

export const planInitial: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events
>(
  machine:
    & Machine<
      States,
      Events,
      Input,
      UnhandledStates,
      E,
      R,
      InitialE,
      InitialR,
      FinalStates,
      Output,
      Emits,
      OutputStates,
      InputEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>,
  ...args: [...Machine.InputArgs<Input>]
) => Effect.Effect<
  & {
    readonly startingState: Machine.Snapshot<States>
    readonly initialEntryPaths: ReadonlyArray<Machine.StateIdentifier<States>>
    readonly state: Machine.Snapshot<States>
    readonly commands: ReadonlyArray<Command>
    readonly emittedEvents: ReadonlyArray<Machine.EmitOf<Emits>>
    readonly microsteps: ReadonlyArray<{
      readonly next: Machine.Snapshot<States>
      readonly event: Machine.EventOf<Events> | InitialEventModel
      readonly transitions: ReadonlyArray<
        Machine.RetainedTransition<
          Machine.StateNodeIdentifier<States>,
          Machine.TagOf<Events[number]>,
          Machine.StateNodeIdentifier<States>
        >
      >
      readonly commands: ReadonlyArray<Command>
      readonly raisedEvents: ReadonlyArray<Machine.EventOf<Events>>
      readonly emittedEvents: ReadonlyArray<Machine.EmitOf<Emits>>
      readonly exitPaths: ReadonlyArray<string>
      readonly entryPaths: ReadonlyArray<string>
      readonly changed: boolean
    }>
  }
  & (
    | {
      readonly done: true
      readonly output: Output
    }
    | {
      readonly done: false
      readonly output: undefined
    }
  ),
  InitialE | E | InfiniteTransitionError | MachineSchemaDecodeError | StartupError,
  never
> = internalPlanner.planInitial as any

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
): Machine.InputEvents<M> => Protocol.inputEventSchemas(machine) as Machine.InputEvents<M>

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

export const enabled = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema>,
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events
>(
  machine: Machine<
    States,
    Events,
    Input,
    UnhandledStates,
    E,
    R,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    Emits,
    OutputStates,
    InputEvents
  >,
  state: Machine.Snapshot<States>
): ReadonlyArray<Machine.TagOf<Events[number]>> => internalPlanner.enabled(machine as any, state)

export const can = internalPlanner.can

export const plan: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events
>(
  machine:
    & Machine<
      States,
      Events,
      Input,
      UnhandledStates,
      E,
      R,
      InitialE,
      InitialR,
      FinalStates,
      Output,
      Emits,
      OutputStates,
      InputEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>,
  state: Machine.Snapshot<States>,
  event: Machine.EventInputOf<InputEvents>
) => Effect.Effect<
  & {
    readonly next: Machine.Snapshot<States>
    readonly commands: ReadonlyArray<Command>
    readonly emittedEvents: ReadonlyArray<Machine.EmitOf<Emits>>
    readonly microsteps: ReadonlyArray<{
      readonly next: Machine.Snapshot<States>
      readonly event: Machine.EventOf<Events> | InitialEventModel
      readonly transitions: ReadonlyArray<
        Machine.RetainedTransition<
          Machine.StateNodeIdentifier<States>,
          Machine.TagOf<Events[number]>,
          Machine.StateNodeIdentifier<States>
        >
      >
      readonly commands: ReadonlyArray<Command>
      readonly raisedEvents: ReadonlyArray<Machine.EventOf<Events>>
      readonly emittedEvents: ReadonlyArray<Machine.EmitOf<Emits>>
      readonly exitPaths: ReadonlyArray<string>
      readonly entryPaths: ReadonlyArray<string>
      readonly changed: boolean
    }>
  }
  & (
    | {
      readonly done: true
      readonly output: Output
    }
    | {
      readonly done: false
      readonly output: undefined
    }
  ),
  E | InfiniteTransitionError | MachineSchemaDecodeError,
  never
> = internalPlanner.plan as any

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
      ? (internalProcess.toProcessLogic as any)(machine)
      : (internalProcess.toProcessLogic as any)(machine, input))

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
      ? (internalProcess.toProcessLogic as any)(machine)
      : (internalProcess.toProcessLogic as any)(machine, input)
  return (id) => makeChild(id, machine, makeLogic)
}

export const childAddress = <Event = never>(id: string): ChildAddress<Event> => id as ChildAddress<Event>

export const spawn: {
  <ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError = never>(
    logic: Logic<
      ChildState,
      ChildEvent,
      ChildError,
      ChildRequirements,
      ChildOutput,
      ChildInitialError
    >
  ): SpawnResult<ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, never, ChildInitialError>
  <
    ChildState,
    ChildEvent,
    ChildError,
    ChildRequirements,
    ChildOutput,
    Options extends SpawnOptions,
    ChildInitialError = never
  >(
    logic: Logic<
      ChildState,
      ChildEvent,
      ChildError,
      ChildRequirements,
      ChildOutput,
      ChildInitialError
    >,
    options: Options & ChildAddress.OptionsCompatibility<Options, ChildEvent>
  ): SpawnResult<
    ChildState,
    ChildEvent,
    ChildError,
    ChildRequirements,
    ChildOutput,
    SpawnError<Options>,
    ChildInitialError
  >
} = ((logic: Logic<any, any, any, any, any, any>, options?: SpawnOptions) =>
  Effect.flatMap(
    internalRuntime.MachineRuntime,
    (runtime) => options === undefined ? runtime.spawn(logic) : (runtime.spawn as any)(logic, options)
  )) as any

export const sendTo: {
  <Child extends ChildMachine.Any>(
    child: Child,
    event: ChildMachine.Event<Child>
  ): Effect.Effect<void, StoppedError, MachineRuntimeRequirement>
  <Address extends ChildAddress<never>>(
    id: Address,
    event: ChildAddress.Event<Address>
  ): Effect.Effect<void, StoppedError, MachineRuntimeRequirement>
} = ((child: string | ChildMachine.Any, event: unknown) =>
  Effect.flatMap(
    internalRuntime.MachineRuntime,
    (runtime) => runtime.sendTo(child, event)
  )) as any

export const stopChild: {
  <Event>(child: ChildAddress<Event>): Effect.Effect<void, never, MachineRuntimeRequirement>
  <Child extends ChildMachine.Any>(child: Child): Effect.Effect<void, never, MachineRuntimeRequirement>
} = ((child: string | ChildMachine.Any) =>
  Effect.flatMap(
    internalRuntime.MachineRuntime,
    (runtime) => runtime.stopChild(child)
  )) as any

export const watch = <State, Event, Error = never, Output = never>(
  ref: MachineRef<State, Event, Error, Output>
): Stream.Stream<RuntimeOutcome<State, Error, Output>> => internalRuntime.watch(ref)

export const prepare = internalProcess.prepare

export const start: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events
>(
  machine:
    & Machine<
      States,
      Events,
      Input,
      UnhandledStates,
      E,
      R,
      InitialE,
      InitialR,
      FinalStates,
      Output,
      Emits,
      OutputStates,
      InputEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>,
  ...args: [...Machine.InputArgs<Input>]
) => Effect.Effect<
  MachineRef<
    Machine.Snapshot<States>,
    Machine.EventInputOf<InputEvents>,
    | E
    | ActionError<R>
    | InfiniteTransitionError
    | MachineSchemaDecodeError
    | StoppedError,
    Output,
    Machine.EmittedEventOf<Emits>
  >,
  | InitialE
  | E
  | ActionError<InitialR | R>
  | InfiniteTransitionError
  | MachineSchemaDecodeError
  | StartupError
  | StoppedError,
  ExcludeCompatibleRuntime<
    ExecutionServices<InitialR | R>,
    Machine.EventOf<Events>,
    Machine.EmitOf<Emits>
  >
> = internalProcess.start as any

export const resume: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events
>(
  machine:
    & Machine<
      States,
      Events,
      Input,
      UnhandledStates,
      E,
      R,
      InitialE,
      InitialR,
      FinalStates,
      Output,
      Emits,
      OutputStates,
      InputEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>,
  snapshot: Machine.Snapshot<States>
) => Effect.Effect<
  MachineRef<
    Machine.Snapshot<States>,
    Machine.EventInputOf<InputEvents>,
    | E
    | ActionError<R>
    | InfiniteTransitionError
    | MachineSchemaDecodeError
    | StoppedError,
    Output,
    Machine.EmittedEventOf<Emits>
  >,
  MachineSchemaDecodeError,
  ExcludeCompatibleRuntime<
    ExecutionServices<R>,
    Machine.EventOf<Events>,
    Machine.EmitOf<Emits>
  >
> = internalProcess.resume as any
