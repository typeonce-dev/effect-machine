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
  ExecutionServices,
  InitialEvent as InitialEventModel,
  Logic,
  Machine,
  MachineRef,
  MachineSchemaDecodeError,
  MachineSchemaEncodeError,
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
export const InvokeTypeId: unique symbol = Symbol.for("effect/Machine/Invoke")
export const TransitionTypeId: unique symbol = Symbol.for("effect/Machine/Transition")
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

const makeBoundInvoke = (config: unknown): unknown => config

const cloneWithHandlers = (
  self: Machine.Any,
  handlers: Machine.StateConfigs<any, any, any, any, any, any, any>
): Machine.Any => {
  const machine = Object.create(Proto)
  machine.states = self.states
  machine.events = self.events
  machine.internalEvents = self.internalEvents
  machine.emittedEvents = self.emittedEvents
  machine.parentEvents = self.parentEvents
  machine.input = self.input
  machine.id = self.id
  machine.initial = self.initial
  machine.initialDefinition = self.initialDefinition
  machine.stateNodes = self.stateNodes
  machine.makeTargetBuilder = self.makeTargetBuilder
  machine.handlers = handlers
  machine.handle = makeHandle(machine)
  machine.invoke = makeBoundInvoke
  Protocol.copyProtocol(self, machine)
  return machine
}

type DefinitionBranch = {
  readonly title?: string
  readonly when?: (context: any) => Option.Option<unknown>
  readonly target: (selector: unknown) => unknown
  readonly resolve?: (context: any, enqueue: unknown) => unknown
}

type CapturedBranch = DefinitionBranch & {
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

const makeSelectionMethod = (
  kind: Topology.TargetSelectionKind,
  path: string | undefined,
  scope: Topology.TargetSelectionScope
): () => Topology.TargetSelection =>
() => Topology.makeTargetSelection(kind, path, scope)

const addSelectionChildren = (
  builder: Record<string, unknown>,
  stateNodes: Machine.StateNodes,
  parent: string,
  scope: "local" | "branch"
): void => {
  for (const node of stateNodes.byPath.values()) {
    if (node.parent !== parent || node.type === "history") continue
    builder[node.key] = makeSelectionNode(stateNodes, node.path, scope)
  }
}

const makeSelectionNode = (
  stateNodes: Machine.StateNodes,
  path: string,
  scope: Topology.TargetSelectionScope
): unknown => {
  const node = getTargetBuilderNode(stateNodes, path)
  const kind: Topology.TargetSelectionKind = node.type === "choice" ? "choice" : "state"
  const method = makeSelectionMethod(kind, path, scope) as unknown as Record<string, unknown>
  if (node.type !== "atomic" && node.type !== "final" && node.type !== "choice" && node.type !== "history") {
    Object.defineProperty(method, "initial", {
      value: makeSelectionMethod("initial", path, scope),
      enumerable: true
    })
    if (scope === "local" || scope === "branch") {
      addSelectionChildren(method, stateNodes, path, scope)
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
      builder[node.key] = makeSelectionMethod("history", node.path, "full")
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
  branch[root.key] = makeSelectionNode(stateNodes, root.path, "branch")
  const local: Record<string, unknown> = {}
  const localScope = getLocalTargetScope(stateNodes, source)
  if (localScope !== undefined) {
    const localScopeNode = getTargetBuilderNode(stateNodes, localScope)
    if (localScopeNode.schema !== undefined) {
      local.with = makeSelectionMethod("state", localScope, "local")
    }
    addSelectionChildren(local, stateNodes, localScope, "local")
  }
  return {
    none: makeSelectionMethod("none", undefined, "local"),
    local,
    branch,
    full,
    history: makeHistorySelectionTree(stateNodes, undefined)
  }
}

const captureDefinitionBranch = (
  branch: unknown,
  selector: unknown,
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
  return { ...(branch as DefinitionBranch), selection }
}

const getSelectionBuilder = (
  target: Record<string, any>,
  selection: Topology.TargetSelection,
  stateNodes: Machine.StateNodes,
  source: string
): unknown => {
  if (selection.kind === "none") return target.none
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
  return builder
}

const constructSelectedTarget = (builder: any): unknown => typeof builder === "function" ? builder() : builder.from()

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
  if (result === undefined) return
  const resultPath = typeof result === "object" && result !== null && hasProperty(result, "path") &&
      typeof result.path === "string"
    ? result.path
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
  source: string,
  match?: { readonly value: unknown }
): unknown => {
  const selectedTarget = getSelectionBuilder(context.target, branch.selection, stateNodes, source)
  if (branch.resolve === undefined) return constructSelectedTarget(selectedTarget)
  const resolverContext = { ...context }
  if (branch.selection.kind === "none") delete resolverContext.target
  else resolverContext.target = selectedTarget
  if (match !== undefined) resolverContext.match = match.value
  const resolved = branch.resolve(resolverContext, enqueue)
  validateResolvedSelection(resolved, branch.selection, stateNodes)
  return resolved === undefined ? constructSelectedTarget(selectedTarget) : resolved
}

const captureTransition = (
  transition: unknown,
  stateNodes: Machine.StateNodes,
  path: string,
  trigger: PropertyKey
): unknown => {
  if (typeof transition !== "object" || transition === null) {
    throw new Error(`Machine transition for state "${path}" on "${String(trigger)}" must be an object`)
  }
  const definition = transition as Record<PropertyKey, unknown>
  const selector = makeTargetSelector(stateNodes, path)
  const reenter = definition.reenter === true
  if (Array.isArray(definition.cases)) {
    const rawCases = definition.cases as ReadonlyArray<unknown>
    if (definition.cases.length === 0 || !hasProperty(definition, "otherwise")) {
      throw new Error(
        `Machine conditional transition for state "${path}" on "${String(trigger)}" requires cases and otherwise`
      )
    }
    const cases = rawCases.map((branch) => {
      const captured = captureDefinitionBranch(branch, selector, path, trigger)
      if (typeof captured.title !== "string" || captured.title.length === 0 || typeof captured.when !== "function") {
        throw new Error(
          `Machine conditional transition case for state "${path}" on "${String(trigger)}" requires title and when`
        )
      }
      return captured
    })
    const otherwise = captureDefinitionBranch(definition.otherwise, selector, path, trigger)
    const evaluate = (context: Record<string, any>, enqueue: unknown) => {
      const predicateContext = { ...context }
      delete predicateContext.target
      for (let branchIndex = 0; branchIndex < cases.length; branchIndex++) {
        const branch = cases[branchIndex]!
        const result = branch.when!(predicateContext)
        if (!Option.isOption(result)) {
          throw new Error(`Machine conditional transition case "${branch.title}" must return Option`)
        }
        if (Option.isSome(result)) {
          return {
            result: runCapturedBranch(branch, context, enqueue, stateNodes, path, { value: result.value }),
            branchIndex
          }
        }
      }
      return {
        result: runCapturedBranch(otherwise, context, enqueue, stateNodes, path),
        branchIndex: cases.length
      }
    }
    return {
      reenter,
      targets: [
        ...new Set(
          [...cases, otherwise].flatMap((branch) => branch.selection.path === undefined ? [] : [branch.selection.path])
        )
      ],
      branches: [
        ...cases.map((branch) => ({
          type: "case" as const,
          title: branch.title!,
          target: branch.selection.path,
          selection: transitionTargetSelection(branch.selection)
        })),
        {
          type: "otherwise" as const,
          target: otherwise.selection.path,
          selection: transitionTargetSelection(otherwise.selection)
        }
      ],
      evaluate,
      transition: (context: Record<string, any>, enqueue: unknown) => evaluate(context, enqueue).result
    }
  }
  const branch = captureDefinitionBranch(transition, selector, path, trigger)
  const evaluate = (context: Record<string, any>, enqueue: unknown) => ({
    result: runCapturedBranch(branch, context, enqueue, stateNodes, path),
    branchIndex: 0
  })
  return {
    reenter,
    targets: branch.selection.path === undefined ? [] : [branch.selection.path],
    branches: [{
      type: "direct" as const,
      target: branch.selection.path,
      selection: transitionTargetSelection(branch.selection)
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

const captureInvokeDefinition = (
  invoke: unknown,
  stateNodes: Machine.StateNodes,
  path: string
): unknown => {
  if (Array.isArray(invoke)) return invoke.map((item) => captureInvokeDefinition(item, stateNodes, path))
  if (typeof invoke !== "object" || invoke === null) return invoke
  const captured = { ...(invoke as Record<PropertyKey, unknown>) }
  for (const key of ["onDone", "onFailure", "onSnapshot"] as const) {
    if (captured[key] !== undefined) {
      captured[key] = captureTransition(captured[key], stateNodes, path, key)
    }
  }
  return captured
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

const makeHandle = (self: Machine.Any): Machine.Any["handle"] =>
  ((config: Record<string, unknown>) => {
    const handlers: Record<PropertyKey, Machine.AnyStateConfig> = Object.assign(
      Object.create(null),
      self.handlers
    )
    flattenHandlers(handlers, self.stateNodes, self.states, "", config)
    return cloneWithHandlers(self, handlers)
  }) as Machine.Any["handle"]

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
): Method & { readonly from: (...args: ReadonlyArray<any>) => unknown } => {
  Object.defineProperty(method, "from", {
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
  return method as Method & { readonly from: (...args: ReadonlyArray<any>) => unknown }
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
      selector[node.key] = makeSelectionNode(stateNodes, node.path, "initial")
    }
  }
  return selector
}

const getInitialSelectionBuilder = (
  initialBuilder: Record<string, any>,
  selection: Topology.TargetSelection
): (...args: ReadonlyArray<any>) => unknown => {
  const path = selection.path
  if (path === undefined || path.includes(".")) {
    throw new Error("Machine initial target must select one top-level state")
  }
  const builder = initialBuilder[path]
  if (typeof builder !== "function") {
    throw new Error(`Machine could not construct selected initial state "${path}"`)
  }
  return builder
}

const captureInitialBranch = (
  branch: unknown,
  selector: unknown,
  initialBuilder: Record<string, any>
): CapturedBranch & { readonly builder: (...args: ReadonlyArray<any>) => unknown } => {
  const captured = captureDefinitionBranch(branch, selector, "<machine>", "initial")
  if (captured.selection.kind !== "state" && captured.selection.kind !== "initial") {
    throw new Error("Machine initial target must select a top-level state or its declared initial entry")
  }
  return { ...captured, builder: getInitialSelectionBuilder(initialBuilder, captured.selection) }
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
  if (typeof definition !== "object" || definition === null) {
    throw new Error("Machine initial definition must be an object")
  }
  const selector = makeInitialSelector(stateNodes)
  const initialBuilder = makeSnapshotBuilder(states, { mode: "initial", prefix: "" }) as Record<string, any>
  const branch = captureInitialBranch(definition, selector, initialBuilder)
  return {
    initial: (input?: unknown) => {
      const result = branch.resolve === undefined
        ? branch.builder()
        : branch.resolve({ input, target: branch.builder }, undefined)
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
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema>
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
  readonly parentEvents?: Machine.EventProtocol<"public", ParentEvents>
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
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema>
> = Machine<
  States,
  readonly [...InputEvents, ...InternalEvents],
  Input,
  Machine.StateIdentifier<States>,
  never,
  never,
  InitialE,
  InitialR,
  Machine.FinalStateFromDefinition<States>,
  Machine.TerminalOutput<States>,
  Emits,
  never,
  InputEvents,
  ParentEvents
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
    const ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
  >(
    config: MakeConfig<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents, ParentEvents>,
    ..._validation: ValidateDefinedStates<NoInfer<States>>
  ): MakeResult<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents, ParentEvents>
  <
    const States extends Machine.StateSchemas,
    const InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
    const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
    const Input extends Schema.Top = typeof Schema.Void,
    InitialE = never,
    InitialR = never,
    const InternalEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
    const ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
  >(
    config:
      & Omit<MakeConfig<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents, ParentEvents>, "states">
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
  const ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
>(
  config: {
    readonly id?: string
    readonly states: States
    readonly events: Machine.EventProtocol<"public", InputEvents>
    readonly internalEvents?: Machine.EventProtocol<"internal", InternalEvents>
    readonly emittedEvents?: Machine.EventProtocol<"emitted", Emits>
    readonly parentEvents?: Machine.EventProtocol<"public", ParentEvents>
    readonly input?: Input
    readonly initial: unknown
  }
): MakeResult<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents, ParentEvents> => {
  StateDefinition.validateStateDefinitions(config.states, "Machine.make")
  const self = Object.create(Proto)
  self.states = config.states
  self.events = config.events
  self.internalEvents = config.internalEvents ?? Protocol.makeEventProtocol("internal", [] as const)
  self.emittedEvents = config.emittedEvents ?? Protocol.makeEventProtocol("emitted", [] as const)
  self.parentEvents = config.parentEvents ?? Protocol.makeEventProtocol("public", [] as const)
  self.input = config.input
  self.id = config.id
  self.stateNodes = Topology.compileStateNodes(config.states)
  const compiledInitial = compileInitial(config.initial, config.states, self.stateNodes)
  self.initial = compiledInitial.initial
  self.initialDefinition = compiledInitial.definition
  self.makeTargetBuilder = makeTargetBuilder(config.states, self.stateNodes)
  self.handlers = Object.create(null)
  self.handle = makeHandle(self)
  self.invoke = makeBoundInvoke
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
): ChildMachine<Id, M> => ({
  [ChildMachineTypeId]: ChildMachineTypeId,
  id,
  machine,
  [ChildMachineLogicTypeId]: (input) =>
    machine.input === undefined
      ? (internalProcess.toProcessLogic as any)(machine)
      : (internalProcess.toProcessLogic as any)(machine, input)
})

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
} = ((
  logic: Logic<any, any, any, any, any, any>,
  options?: SpawnOptions
) =>
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
