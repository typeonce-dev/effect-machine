import * as Effect from "effect/Effect"
import * as Inspectable from "effect/Inspectable"
import * as Option from "effect/Option"
import { Prototype as PipeablePrototype } from "effect/Pipeable"
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
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
  RuntimeOutcome,
  SpawnOptions,
  State,
  StoppedError
} from "../../Machine.js"
import * as Activities from "./activities.js"
import * as Configuration from "./configuration.js"
import * as Construction from "./construction.js"
import * as Declaration from "./declaration.js"
import type { ChildAlreadyExistsError, InfiniteTransitionError, StartupError } from "./errors.js"
import type { CapturedStateConfig } from "./implementation.js"
import * as InitialDeclaration from "./initialDeclaration.js"
import * as InvocationDefinition from "./invocationDefinition.js"
import * as Observation from "./observation.js"
import * as internalPlanner from "./planner.js"
import * as internalProcess from "./process.js"
import * as Protocol from "./protocol.js"
import type { EnsureExecutable } from "./readiness.js"
import type { ExcludeCompatibleRuntime } from "./requirements.js"
import * as internalRuntime from "./runtimeProtocol.js"
import * as Serialization from "./serialization.js"
import * as StateDefinition from "./stateDefinition.js"
import { ChildMachineLogicTypeId } from "./symbols.js"
import * as TargetReference from "./targetReference.js"
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
export const TargetReferenceTypeId: typeof TargetReference.TypeId = TargetReference.TypeId
export const targets: (root: State<Machine.StateNodeConfig>) => { readonly root: TargetReference.Reference } =
  TargetReference.make

const TypeId = "~effect/Machine"
const ParentTypeId = "~effect/Machine/Parent"
export const InvokeTypeId: unique symbol = Symbol.for("effect/Machine/Invoke")
const ChildMachineTypeId = "~effect/Machine/ChildMachine"
type MachineRuntimeRequirement = internalRuntime.MachineRuntime

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

const plainTargetSelection = (selection: Topology.TargetSelection): Topology.TargetSelection =>
  selection.kind === "none"
    ? Topology.noneTargetSelection
    : Topology.makeTargetSelection(selection.kind, selection.path, selection.scope, selection.updatePath)

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
    root: source === "" ? context.state : context.ancestors[""],
    decline: Topology.makeDeclined
  }
  delete resolverContext.target
  const resolved = branch.resolve!(resolverContext, enqueue)
  if (Topology.isDeclined(resolved)) {
    if (branch.declinable !== true) {
      throw new Error(`Machine transition for state "${source}" returned decline without declaring declinable: true`)
    }
    return resolved
  }
  validateResolvedSelection(resolved, branch.selection, stateNodes)
  return resolved
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
    if (title !== undefined && (typeof title !== "string" || title.length === 0)) {
      throw new Error(`Machine transition branch "${key}" title must be a non-empty string`)
    }
    return Object.freeze({ key, title: title ?? key, selection: plainTargetSelection(target) })
  }))
}

const constructBranch = (
  selection: Topology.TargetSelection,
  stateNodes: Machine.StateNodes,
  declaration: Declaration.Declaration,
  raw: unknown = {},
  source?: string
): unknown => {
  const config = Construction.record(raw)
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
      throw new Error("Machine root targets accept input only")
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

const makeBranchSelectors = (
  branches: ReadonlyArray<CapturedNamedBranch>,
  owner: object,
  stateNodes: Machine.StateNodes,
  declaration: Declaration.Declaration,
  source: string
): Readonly<Record<string, unknown>> =>
  Object.freeze(Object.fromEntries(
    branches.map((branch, index) => [branch.key, (config?: unknown) =>
      Topology.makeSelectedBranch(
        owner,
        index,
        branch.key,
        branch.selection.kind === "none"
          ? Topology.makeNoTarget()
          : constructBranch(branch.selection, stateNodes, declaration, config, source)
      )]
    )
  ))

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
  stateNodes: Machine.StateNodes
): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null) throw new Error(`Machine transition for "${path}" must be an object`)
  const config = { ...raw } as Record<string, unknown>
  const allowed = [
    "target",
    "update",
    "input",
    "history",
    "none",
    "branches",
    "data",
    "decoded",
    "resolve",
    "guard",
    "reenter",
    "declinable"
  ]
  for (const key of Reflect.ownKeys(config)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new Error("Machine transition contains an unknown field")
    }
  }
  for (const key of ["resolve", "guard"]) {
    if (config[key] !== undefined && typeof config[key] !== "function") {
      throw new Error(`Machine transition ${key} must be a function`)
    }
  }
  const guard = typeof config.guard === "function" ? config.guard : undefined
  const resolve = typeof config.resolve === "function" ? config.resolve : undefined
  if (config.decoded !== undefined && typeof config.decoded !== "boolean") {
    throw new Error("Machine decoded must be a boolean construction flag")
  }
  const hasData = Object.prototype.hasOwnProperty.call(config, "data")
  if (config.decoded === true && !hasData) throw new Error("Machine decoded construction requires data")
  if (hasData && resolve !== undefined) throw new Error("Machine data and resolve are mutually exclusive")
  const data = config.data
  const construct = typeof data === "function" ? data : () => data
  const guarded = guard !== undefined
  const declinable = guarded || config.declinable === true
  if (typeof config.branches === "string") {
    const group = declaration.branches.get(config.branches)
    if (group === undefined || resolve === undefined) {
      throw new Error("Machine branching transition requires a registered group and resolver")
    }
    if (
      ["target", "update", "input", "history", "none", "data", "decoded"].some((key) => config[key] !== undefined)
    ) throw new Error("Machine branching transition cannot redeclare its destination")
    const entries = Object.fromEntries(
      Object.entries(group).map(([key, spec]) => [key, {
        title: spec.title,
        target: captureDefinitionBranch(
          { target: () => Declaration.selection(declaration, spec) },
          undefined,
          stateNodes,
          path,
          key
        ).selection
      }])
    )
    return {
      branches: () => entries,
      reenter: config.reenter,
      declinable,
      resolve: (context: Record<string, any>, enqueue: unknown) => {
        return guarded && !guard(context) ? Topology.makeDeclined() : resolve(context, enqueue)
      }
    }
  }
  const selection = Declaration.selection(declaration, config)
  if (resolve !== undefined && selection.kind !== "none") {
    throw new Error("Machine advanced construction requires a declared branch group")
  }
  const input = config.input
  const constructInput = typeof input === "function" ? input : () => input
  if (selection.path !== "" && Object.hasOwn(config, "input")) {
    throw new Error("Machine input belongs only to root targets")
  }
  if (selection.path === "" && selection.kind !== "update" && (hasData || config.decoded !== undefined)) {
    throw new Error("Machine root targets accept input instead of data")
  }
  return {
    target: () => selection,
    reenter: config.reenter,
    declinable,
    resolve: (context: Record<string, any>, enqueue: unknown) => {
      if (guarded && !guard(context)) return Topology.makeDeclined()
      if (resolve !== undefined) return resolve(context, enqueue)
      if (selection.path === "" && selection.kind !== "update") {
        return constructBranch(selection, stateNodes, declaration, { input: constructInput(context) })
      }
      const value = construct(context)
      return constructBranch(
        selection,
        stateNodes,
        declaration,
        selection.updatePath === undefined
          ? {
            ...(hasData ? { data: value } : {}),
            ...(config.decoded === undefined ? {} : { decoded: config.decoded })
          }
          : {
            ...(value.target === undefined ? {} : { data: value.target, decoded: config.decoded }),
            update: { data: value.update, decoded: config.decoded }
          },
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
  trigger: PropertyKey
): unknown => {
  const transition = normalizeObjectTransition(rawTransition, declaration, path, stateNodes)
  if (typeof transition !== "object" || transition === null) {
    throw new Error(`Machine transition for state "${path}" on "${String(trigger)}" must be an object`)
  }
  const definition = transition as Record<PropertyKey, unknown>
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
    const branches = captureNamedBranches(branching.branches(), path, trigger)
    const owner = Object.freeze({})
    const evaluate = (context: Record<string, any>, enqueue: unknown) => {
      const resolverContext: Record<string, any> = {
        ...context,
        root: path === "" ? context.state : context.ancestors[""],
        decline: Topology.makeDeclined
      }
      delete resolverContext.target
      resolverContext.select = makeBranchSelectors(branches, owner, stateNodes, declaration, path)
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
      event
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
        captured[key] = captureTransition(captured[key], stateNodes, path, declaration, key)
      }
    }
    return InvocationDefinition.capture(captured, path)
  })
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
      stateConfig.always = captureTransition(stateConfig.always, stateNodes, path, declaration, "always")
    }
    if (stateConfig.onDone !== undefined) {
      stateConfig.onDone = captureTransition(stateConfig.onDone, stateNodes, path, declaration, "done")
    }
    if (stateConfig.choice !== undefined) {
      stateConfig.choice = captureTransition(stateConfig.choice, stateNodes, path, declaration, "choice")
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
    handlers[path] = stateConfig as CapturedStateConfig
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
      initialize: (input) => compiled.initial(Protocol.decodeInputSync(compiled, compiled.input, input))
    }, { "": captured.handlers })
    return makeWithHandlers(compiled, handlers)
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
    getSnapshot: Topology.getSnapshotByPath as unknown as Machine.StateAccessors<
      { readonly "": Machine.StateNodeConfig }
    >["getSnapshot"],
    matches:
      ((snapshot: Machine.AtomicSnapshot<string, unknown>, path: string) =>
        Option.isSome(Topology.getSnapshotByPath(snapshot, path))) as Machine.StateAccessors<
          { readonly "": Machine.StateNodeConfig }
        >["matches"]
  }
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

export const make = <
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
    readonly root: State<Machine.StateNodeConfig>
    readonly effects?: unknown
    readonly streams?: unknown
    readonly timers?: unknown
    readonly logic?: unknown
    readonly children?: unknown
    readonly branches?: unknown
    readonly events: Machine.EventProtocol<"public", InputEvents>
    readonly internalEvents?: Machine.EventProtocol<"internal", InternalEvents>
    readonly emittedEvents?: Machine.EventProtocol<"emitted", Emits>
    readonly parent?: ParentDeclaration
    readonly input?: Input
  }
): MakeResult<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents, ParentDeclaration> => {
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
      : [input as Machine.TaggedSchema]
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

export const eventsFromFields = (cases: Readonly<Record<string, Schema.Struct.Fields>>) =>
  Protocol.makeEventProtocol("public", eventFieldSchemas(cases))
export const internalEventsFromFields = (cases: Readonly<Record<string, Schema.Struct.Fields>>) =>
  Protocol.makeEventProtocol("internal", eventFieldSchemas(cases))
export const emittedEventsFromFields = (cases: Readonly<Record<string, Schema.Struct.Fields>>) =>
  Protocol.makeEventProtocol("emitted", eventFieldSchemas(cases))

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
    readonly emittedEvents: ReadonlyArray<Machine.EmittedEventOf<Emits>>
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
      readonly emittedEvents: ReadonlyArray<Machine.EmittedEventOf<Emits>>
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
    readonly emittedEvents: ReadonlyArray<Machine.EmittedEventOf<Emits>>
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
      readonly emittedEvents: ReadonlyArray<Machine.EmittedEventOf<Emits>>
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

export const waitFor = Observation.waitFor

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
    Machine.EmittedEventOf<Emits>
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
    Machine.EmittedEventOf<Emits>
  >
> = internalProcess.resume as any
