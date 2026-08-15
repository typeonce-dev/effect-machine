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
export { ChildMachineLogicTypeId, InitialEventTypeId } from "./symbols.js"

const TypeId = "~effect/Machine"
export const SnapshotBuilderStateTypeId: unique symbol = Symbol("effect/Machine/SnapshotBuilderState")
export const InvokeTypeId: unique symbol = Symbol.for("effect/Machine/Invoke")
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
interface DefineStates {
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

const cloneWithHandlers = (
  self: Machine.Any,
  handlers: Machine.StateConfigs<any, any, any, any, any, any, any>
): Machine.Any => {
  const machine = Object.create(Proto)
  machine.states = self.states
  machine.events = self.events
  machine.internalEvents = self.internalEvents
  machine.emits = self.emits
  machine.input = self.input
  machine.id = self.id
  machine.initial = self.initial
  machine.stateNodes = self.stateNodes
  machine.makeTargetBuilder = self.makeTargetBuilder
  machine.handlers = handlers
  machine.handle = makeHandle(machine)
  Protocol.copyProtocol(self, machine)
  return machine
}

const validateTransitionTargets = (
  stateNodes: Machine.StateNodes,
  path: string,
  trigger: PropertyKey,
  transition: unknown
): void => {
  if (typeof transition !== "object" || transition === null || !hasProperty(transition, "targets")) {
    return
  }
  if (!Array.isArray(transition.targets)) {
    throw new Error(
      `Machine expected transition targets for state "${path}" on "${String(trigger)}" to be an array`
    )
  }
  for (const target of transition.targets) {
    if (typeof target !== "string" || !stateNodes.byPath.has(target)) {
      throw new Error(
        `Machine transition for state "${path}" on "${String(trigger)}" declares unknown target "${String(target)}"`
      )
    }
  }
}

const captureTransition = (transition: unknown): unknown => {
  if (typeof transition !== "object" || transition === null) {
    return transition
  }
  const captured = { ...(transition as Record<PropertyKey, unknown>) }
  if (Array.isArray(captured.targets)) {
    captured.targets = captured.targets.slice()
  }
  return captured
}

const captureEventHandlers = (on: object): Record<PropertyKey, unknown> => {
  // The machine owns its dispatch table. Compiled plans may snapshot these
  // definitions, so retaining caller-owned containers would let strategies
  // observe different handlers after an unsafe external mutation.
  const captured: Record<PropertyKey, unknown> = Object.create(null)
  for (const event of Reflect.ownKeys(on)) {
    captured[event] = captureTransition((on as Record<PropertyKey, unknown>)[event])
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
      const capturedOn = captureEventHandlers(on)
      stateConfig.on = capturedOn
      for (const event of Reflect.ownKeys(capturedOn)) {
        validateTransitionTargets(stateNodes, path, event, capturedOn[event])
      }
    }
    validateTransitionTargets(stateNodes, path, "always", stateConfig.always)
    validateTransitionTargets(stateNodes, path, "done", stateConfig.onDone)
    validateTransitionTargets(stateNodes, path, "choice", stateConfig.choice)
    const node = stateNodes.byPath.get(path)
    if (node?.type === "choice") {
      if (
        typeof stateConfig.choice !== "object" || stateConfig.choice === null ||
        !hasProperty(stateConfig.choice, "transition") || typeof stateConfig.choice.transition !== "function" ||
        !hasProperty(stateConfig.choice, "targets") || !Array.isArray(stateConfig.choice.targets) ||
        stateConfig.choice.targets.length === 0
      ) {
        throw new Error(`Machine choice state "${path}" requires a transition and at least one declared target`)
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
    builder[key] = withFrom(
      (value: unknown, selector?: (builder: unknown) => unknown) =>
        makeSnapshotForNode(definition, key, value, selector, options),
      node.states === undefined ? "leaf" : "nested",
      node.schema !== undefined
    )
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
    builder[key] = withFrom(
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
    builder[child.key] = withFrom(
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
      local: makeLocalTargetBuilder(states, stateNodes, source),
      branch: makeBranchTargetBuilder(states, stateNodes, source),
      full,
      history
    }) as Machine.TargetBuilder<States, Source>
}

export const defineStates: DefineStates = (<const States extends Machine.StateSchemas>(
  states: States
): Machine.DefinedStates<States> => {
  StateDefinition.validateStateDefinitions(states, "Machine.defineStates")
  return {
    states,
    initial: makeSnapshotBuilder(states, { mode: "initial", prefix: "" }) as Machine.InitialBuilder<States>,
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
}) as DefineStates

type MakeConfig<
  States extends Machine.StateSchemas,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  Emits extends ReadonlyArray<Machine.TaggedSchema>,
  Input extends Schema.Top,
  InitialE,
  InitialR,
  InternalEvents extends ReadonlyArray<Machine.TaggedSchema>
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
  readonly emits?: Emits
  readonly input?: Input
  readonly initial: (...args: [...Machine.InputArgs<Input>]) => Machine.InitialResult<States, InitialE, InitialR>
}

type MakeResult<
  States extends Machine.StateSchemas,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  Emits extends ReadonlyArray<Machine.TaggedSchema>,
  Input extends Schema.Top,
  InitialE,
  InitialR,
  InternalEvents extends ReadonlyArray<Machine.TaggedSchema>
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
  InputEvents
>

interface Make {
  <
    const States extends Machine.StateSchemas,
    const InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
    const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
    const Input extends Schema.Top = typeof Schema.Void,
    InitialE = never,
    InitialR = never,
    const InternalEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
  >(
    config: MakeConfig<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents>,
    ..._validation: ValidateDefinedStates<NoInfer<States>>
  ): MakeResult<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents>
  <
    const States extends Machine.StateSchemas,
    const InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
    const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
    const Input extends Schema.Top = typeof Schema.Void,
    InitialE = never,
    InitialR = never,
    const InternalEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
  >(
    config:
      & Omit<MakeConfig<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents>, "states">
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
  const InternalEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
>(
  config: {
    readonly id?: string
    readonly states: States
    readonly events: Machine.EventProtocol<"public", InputEvents>
    readonly internalEvents?: Machine.EventProtocol<"internal", InternalEvents>
    readonly emits?: Emits
    readonly input?: Input
    readonly initial: (...args: [...Machine.InputArgs<Input>]) => Machine.InitialResult<States, InitialE, InitialR>
  }
): MakeResult<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents> => {
  StateDefinition.validateStateDefinitions(config.states, "Machine.make")
  const self = Object.create(Proto)
  self.states = config.states
  self.events = config.events
  self.internalEvents = config.internalEvents ?? Protocol.makeEventProtocol("internal", [] as const)
  self.emits = config.emits ?? []
  self.input = config.input
  self.id = config.id
  self.initial = config.initial
  self.stateNodes = Topology.compileStateNodes(config.states)
  self.makeTargetBuilder = makeTargetBuilder(config.states, self.stateNodes)
  self.handlers = Object.create(null)
  self.handle = makeHandle(self)
  Protocol.setProtocol(self)
  return self
}) as Make

export const events = <const Schemas extends ReadonlyArray<Machine.TaggedSchema>>(
  ...schemas: Schemas
): Machine.EventProtocol<"public", readonly [...Schemas]> =>
  Protocol.makeEventProtocol<"public", readonly [...Schemas]>("public", schemas)

export const internalEvents = <const Schemas extends ReadonlyArray<Machine.TaggedSchema>>(
  ...schemas: Schemas
): Machine.EventProtocol<"internal", readonly [...Schemas]> =>
  Protocol.makeEventProtocol<"internal", readonly [...Schemas]>("internal", schemas)

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

export const retag = (
  target: Machine.TaggedSchema,
  source: { readonly _tag: PropertyKey },
  patch?: unknown
): any => {
  const { _tag: _, ...fields } = source
  return target.make({ ...fields, ...((patch ?? {}) as object) } as never)
}
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
    Output
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
    Output
  >,
  MachineSchemaDecodeError,
  ExcludeCompatibleRuntime<
    ExecutionServices<R>,
    Machine.EventOf<Events>,
    Machine.EmitOf<Emits>
  >
> = internalProcess.resume as any
