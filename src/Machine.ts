/**
 * Schema-first machine definitions.
 *
 * @since 4.0.0
 */

import type * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Inspectable from "effect/Inspectable"
import * as Option from "effect/Option"
import { type Pipeable, Prototype as PipeablePrototype } from "effect/Pipeable"
import { hasProperty } from "effect/Predicate"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import type * as Types from "effect/Types"
import * as Activities from "./internal/machineActivities.js"
import type {
  ChildAlreadyExistsError,
  InfiniteTransitionError,
  MachineSchemaDecodeError,
  MachineSchemaEncodeError,
  ProcessLocalError,
  StartupError,
  StoppedError
} from "./internal/machineErrors.js"
import { ProcessLocalError as ProcessLocalErrorValue } from "./internal/machineErrors.js"
import * as Model from "./internal/machineModel.js"
import * as internalPlanner from "./internal/machinePlanner.js"
import * as internalProcess from "./internal/machineProcess.js"
import type { EnsureExecutable } from "./internal/machineReadiness.js"
import * as internalRuntime from "./internal/machineRuntime.js"
import * as StateDefinition from "./internal/machineStateDefinition.js"

/**
 * String literal type used as the runtime type identifier for `Machine`
 * values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~effect/Machine"

/**
 * Runtime type identifier attached to `Machine` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~effect/Machine"

declare const MachineOutputStatesTypeId: unique symbol
declare const MachineTypeId: unique symbol

/**
 * Type identifier used for the synthetic event passed to startup lifecycle
 * actions.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const InitialEventTypeId: typeof internalPlanner.InitialEventTypeId = internalPlanner.InitialEventTypeId

/**
 * Synthetic event passed to entry, exit, always, invoke, and output callbacks
 * that run while the machine is settling its initial state.
 *
 * @category models
 * @since 4.0.0
 */
export interface InitialEvent {
  readonly _tag: typeof InitialEventTypeId
}

/**
 * Synthetic event value used while the machine settles its initial state.
 *
 * @category constructors
 * @since 4.0.0
 */
export const InitialEvent: InitialEvent = internalPlanner.InitialEvent

/**
 * Returns `true` if a value is the synthetic machine initial event.
 *
 * @category guards
 * @since 4.0.0
 */
export const isInitialEvent = (u: unknown): u is InitialEvent => hasProperty(u, "_tag") && u._tag === InitialEventTypeId

type IsAny<A> = 0 extends (1 & A) ? true : false

/**
 * A schema-first machine definition.
 *
 * **Details**
 *
 * Machines support atomic, compound, parallel, and final states together with
 * completion transitions, eventless transitions, raised events, actions,
 * spawned children, and state-scoped invokes. Schemas validate machine
 * boundaries while preserving decoded state, event, output, error, and service
 * types throughout planning and execution.
 *
 * **Gotchas**
 *
 * Declarative first-class guards are not part of the current API. Conditional
 * behavior can be expressed in typed handlers with ordinary TypeScript control
 * flow. Use `after` for cancellable state-scoped delayed events.
 *
 * @category models
 * @since 4.0.0
 */
export interface Machine<
  States extends Machine.StateSchemas,
  Events extends ReadonlyArray<Machine.TaggedSchema>,
  Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events
> extends Pipeable {
  readonly [TypeId]: TypeId
  /** @internal Stable type-level carrier for machine protocol extraction. */
  readonly [MachineTypeId]: Machine.TypeCarrier<
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
  /** @internal Prevents output implementation evidence from being widened. */
  readonly [MachineOutputStatesTypeId]: Readonly<Record<OutputStates, true>>

  /**
   * State tree that defines the machine topology and state value schemas.
   *
   * @since 4.0.0
   */
  readonly states: States

  /**
   * Events accepted through public machine input boundaries.
   *
   * @since 4.0.0
   */
  readonly events: InputEvents

  /**
   * Events reserved for invokes, child emissions, and other machine-local work.
   *
   * @since 4.0.0
   */
  readonly internalEvents: ReadonlyArray<Machine.TaggedSchema>

  /**
   * Events that the machine may emit to its parent or external adapter.
   *
   * @since 4.0.0
   */
  readonly emits: Emits

  /**
   * Optional schema used to decode the machine input before initialization.
   *
   * @since 4.0.0
   */
  readonly input: Input | undefined

  /**
   * Optional stable identity used by runtime and persistence integrations.
   *
   * @since 4.0.0
   */
  readonly id: string | undefined

  /** @internal */
  readonly stateNodes: Machine.StateNodes

  /** @internal */
  readonly makeTargetBuilder: <Source extends Machine.StateNodeIdentifier<States>>(
    source: Source
  ) => Machine.TargetBuilder<States, Source>

  /** @internal */
  readonly handlers: Machine.StateConfigs<States, Events, Emits, UnhandledStates, Machine.TagOf<Events[number]>, E, R>

  /**
   * Adds typed state handlers and returns the refined machine definition.
   * Successive calls implement the remaining unhandled states while retaining
   * accumulated errors, services, final states, and output evidence.
   *
   * @since 4.0.0
   */
  readonly handle: Machine.Handler<
    States,
    Events,
    Emits,
    Input,
    UnhandledStates,
    E,
    R,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    OutputStates,
    InputEvents
  >

  /** @internal */
  readonly initial: (...args: [...Machine.InputArgs<Input>]) => Machine.InitialResult<States, InitialE, InitialR>
}

export {
  /**
   * Error returned by `spawn` when a child process with the same id already
   * exists for the current machine.
   *
   * @category errors
   * @since 4.0.0
   */
  ChildAlreadyExistsError,
  /**
   * Error returned when a machine does not stabilize within the maximum
   * number of macrostep iterations.
   *
   * @category errors
   * @since 4.0.0
   */
  InfiniteTransitionError,
  /**
   * Error returned when a machine contract value does not match the schema or
   * structural configuration declared for a machine boundary.
   *
   * @category errors
   * @since 4.0.0
   */
  MachineSchemaDecodeError,
  /**
   * Error returned when a decoded machine snapshot cannot be encoded through
   * its declared state or output schemas.
   *
   * @category errors
   * @since 4.0.0
   */
  MachineSchemaEncodeError,
  /**
   * Error returned when standalone action execution attempts an operation that
   * requires a managed machine process.
   *
   * @category errors
   * @since 4.0.0
   */
  ProcessLocalError,
  /**
   * Error returned when a machine fails while running startup lifecycle
   * logic after the initial state has been computed.
   *
   * @category errors
   * @since 4.0.0
   */
  StartupError,
  /**
   * Error returned by `join` when a running machine is stopped before
   * producing an output.
   *
   * @category errors
   * @since 4.0.0
   */
  StoppedError
} from "./internal/machineErrors.js"

const RuntimeRequirementTypeId = "~effect/Machine/RuntimeRequirement"
const ActionRequirementTypeId = "~effect/Machine/ActionRequirement"
type MachineRuntimeRequirement = internalRuntime.MachineRuntime

/**
 * Opaque marker used to keep staged action errors and services separate from
 * the Effect that plans a machine step.
 *
 * @category services
 * @since 4.0.0
 */
export interface ActionRequirement<Error, Requirements> {
  readonly [ActionRequirementTypeId]: {
    readonly error: Types.Covariant<Error>
    readonly requirements: Types.Covariant<Requirements>
  }
}

/**
 * Extracts the typed error channel of staged machine actions.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ActionError<Requirements> = Requirements extends ActionRequirement<infer Error, any> ? Error : never

/**
 * Extracts the service requirements of staged machine actions.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ActionServices<Requirements> = Requirements extends ActionRequirement<any, infer Services> ? Services
  : never

/**
 * Removes staged action requirements from machine planning services.
 *
 * @category utility types
 * @since 4.0.0
 */
export type PlanningServices<Requirements> = Exclude<Requirements, ActionRequirement<any, any>>

/**
 * Resolves all services needed to execute a machine at runtime.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ExecutionServices<Requirements> =
  | Exclude<PlanningServices<Requirements>, MachineRuntimeRequirement>
  | Exclude<ActionServices<Requirements>, MachineRuntimeRequirement>

/**
 * Managed runtime capability used to deliver raised and emitted events.
 *
 * @category models
 * @since 4.0.0
 */
export interface Runtime<in Events, in Emits> {
  /**
   * Queues an event for the current machine macrostep.
   *
   * @since 4.0.0
   */
  readonly raise: (event: Events) => Effect.Effect<void, MachineSchemaDecodeError | StoppedError>

  /**
   * Emits an event through the running machine's parent boundary.
   *
   * @since 4.0.0
   */
  readonly sendParent: (event: Emits) => Effect.Effect<void, MachineSchemaDecodeError | StoppedError>
}

/**
 * Synchronous commands available while a machine transition is being
 * selected. Enqueuing only records statechart and actor operations; it never
 * executes an Effect.
 *
 * @category models
 * @since 4.0.0
 */
export interface Enqueue<in Events, in Emits> {
  /** Raises an event inside the current macrostep. */
  readonly raise: (event: Events) => void

  /** Emits an event through the machine's parent boundary. */
  readonly emit: (event: Emits) => void

  /** Sends an event to an invoked child after the transition is selected. */
  readonly sendTo: {
    <Child extends ChildMachine.Any>(child: Child, event: ChildMachine.Event<Child>): void
    <Address extends ChildAddress<never>>(child: Address, event: ChildAddress.Event<Address>): void
  }

  /** Stops an invoked child after the transition is selected. */
  readonly stop: {
    <Child extends ChildMachine.Any>(child: Child): void
    <Event>(child: ChildAddress<Event>): void
  }
}

/** A closed actor command recorded by a synchronous machine transition. */
export type Command =
  | {
    readonly _tag: "SendTo"
    readonly child: ChildMachine.Any | ChildAddress<never>
    readonly event: unknown
  }
  | {
    readonly _tag: "Stop"
    readonly child: ChildMachine.Any | ChildAddress<never>
  }

/**
 * Namespace containing type-level members associated with `Runtime`.
 *
 * @since 4.0.0
 */
export declare namespace Runtime {
  /**
   * Protocol annotation for managed event delivery.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Protocol {
    readonly events?: unknown
    readonly emits?: unknown
  }

  /**
   * Extracts the events required by a runtime protocol annotation.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Events<Protocol> = Protocol extends { readonly events: infer Events } ? Events : never

  /**
   * Extracts the emitted events required by a runtime protocol annotation.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Emits<Protocol> = Protocol extends { readonly emits: infer Emits } ? Emits : never

  /**
   * Opaque service requirement for a machine runtime capability.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Requirement<Events, Emits> {
    readonly [RuntimeRequirementTypeId]: {
      readonly events: Events
      readonly emits: Emits
    }
  }
}

type ExcludeCompatibleRuntime<Requirements, Events, Emits> = Requirements extends Runtime.Requirement<
  infer RequiredEvents,
  infer RequiredEmits
> ? IsAny<Requirements> extends true ? Requirements
  : [RequiredEvents] extends [Events] ? [RequiredEmits] extends [Emits] ? never : Requirements
  : Requirements
  : Requirements

type IncompatibleRuntime<Requirements, Events, Emits> = Requirements extends Runtime.Requirement<
  infer RequiredEvents,
  infer RequiredEmits
> ? IsAny<Requirements> extends true ? never
  : [RequiredEvents] extends [Events] ? [RequiredEmits] extends [Emits] ? never : Requirements
  : Requirements
  : never

const RuntimeCompatibilityErrorTypeId = "~effect/Machine/RuntimeCompatibilityError"
const InvokeTypeId: unique symbol = Symbol.for("effect/Machine/Invoke")

type EnsureCompatibleRuntime<Requirements, Events, Emits> = [IncompatibleRuntime<Requirements, Events, Emits>] extends
  [never] ? unknown : {
  readonly [RuntimeCompatibilityErrorTypeId]: IncompatibleRuntime<Requirements, Events, Emits>
}

type StateDefinitionError<
  Message extends string,
  Path extends PropertyKey = never,
  Details extends PropertyKey = never
> = {
  readonly "~effect/Machine/DefinitionError": Message
  readonly path: Path
  readonly details: Details
}

type ActiveStateKey<States extends Machine.StateSchemas> = Machine.ActiveStateKey<States>

type HistoryStateKey<States extends Machine.StateSchemas> = Machine.HistoryStateKey<States>

type ChoiceStateKey<States extends Machine.StateSchemas> = Machine.ChoiceStateKey<States>

type StateDefinitionPath<Prefix extends string, Key extends PropertyKey> = Key extends string ?
  Key extends "" ? Prefix extends "" ? "<empty>" : `${Prefix}.<empty>`
  : Prefix extends "" ? Key
  : `${Prefix}.${Key}`
  : Key extends number ? Prefix extends "" ? `${Key}` : `${Prefix}.${Key}`
  : Prefix extends "" ? "<symbol>"
  : `${Prefix}.<symbol>`

type ValidateStateKey<Key extends PropertyKey, Prefix extends string> = Key extends symbol ?
  StateDefinitionError<"State keys must be strings, not symbols", StateDefinitionPath<Prefix, Key>, Key>
  : Key extends number ?
    StateDefinitionError<"State keys cannot use numeric forms", StateDefinitionPath<Prefix, Key>, Key>
  : Key extends "" ? StateDefinitionError<"State keys cannot be empty", StateDefinitionPath<Prefix, Key>, Key>
  : Key extends "__proto__" ?
    StateDefinitionError<"The state key \"__proto__\" is not allowed", StateDefinitionPath<Prefix, Key>, Key>
  : Key extends `${string}.${string}` ?
    StateDefinitionError<"State keys cannot contain \".\"", StateDefinitionPath<Prefix, Key>, Key>
  : Key extends `${number}` ?
    StateDefinitionError<"State keys cannot use numeric forms", StateDefinitionPath<Prefix, Key>, Key>
  : unknown

type ValidateStateTree<
  States extends Machine.StateSchemas,
  AllowHistory extends boolean = false,
  Prefix extends string = ""
> = {
  readonly [Key in keyof States]:
    & ValidateStateKey<Key, Prefix>
    & ValidateStateNode<States[Key], AllowHistory, StateDefinitionPath<Prefix, Key>>
}

type UnknownStateNodeProperty<Node, Kind extends StateDefinition.StateNodeKind> = Exclude<
  keyof Node,
  StateDefinition.AllowedStateNodeProperty<Kind>
>

type ValidateExactStateNodeProperties<
  Node,
  Kind extends StateDefinition.StateNodeKind,
  Path extends PropertyKey
> = [UnknownStateNodeProperty<Node, Kind>] extends [never] ? unknown
  : StateDefinitionError<
    "State nodes cannot declare properties outside their state kind",
    Path,
    Extract<UnknownStateNodeProperty<Node, Kind>, PropertyKey>
  >

type UnknownPseudoAnnotationProperty<Node> = Node extends { readonly annotations: infer Annotations } ?
  Exclude<keyof Annotations, StateDefinition.AllowedPseudoStateAnnotationProperty>
  : never

type ValidatePseudoStateAnnotations<Node, Path extends PropertyKey> = [UnknownPseudoAnnotationProperty<Node>] extends
  [never] ? unknown
  : StateDefinitionError<
    "Pseudo-state annotations contain unknown properties",
    Path,
    Extract<UnknownPseudoAnnotationProperty<Node>, PropertyKey>
  >

type ValidateStateNode<Node, AllowHistory extends boolean, Path extends PropertyKey> = Node extends
  Machine.TaggedSchema ? unknown
  : Node extends Machine.HistoryStateNodeConfig ?
      & ValidateExactStateNodeProperties<Node, "history", Path>
      & ValidatePseudoStateAnnotations<Node, Path>
      & (AllowHistory extends true ? ValidateHistoryStateNode<Node>
        : StateDefinitionError<"History states must be declared below an active parent state", Path>)
  : Node extends Machine.ChoiceStateNodeConfig ?
      & ValidateExactStateNodeProperties<Node, "choice", Path>
      & ValidatePseudoStateAnnotations<Node, Path>
      & (AllowHistory extends true ? ValidateChoiceStateNode<Node>
        : StateDefinitionError<"Choice states must be declared below an active parent state", Path>)
  : Node extends { readonly schema: Machine.TaggedSchema } ? ValidateStateNodeConfig<Node, Path>
  : StateDefinitionError<"State nodes must be tagged schemas or state node configs", Path>

type ValidateHistoryStateNode<Node extends Machine.HistoryStateNodeConfig> = [
  Extract<keyof Node, "schema" | "states" | "initial" | "output" | "choice">
] extends [never] ? unknown
  : StateDefinitionError<"History states cannot declare schemas, children, initial states, or output">

type ValidateChoiceStateNode<Node extends Machine.ChoiceStateNodeConfig> = [
  Extract<keyof Node, "schema" | "states" | "initial" | "output" | "history">
] extends [never] ? unknown
  : StateDefinitionError<"Choice states cannot declare schemas, children, initial states, output, or history">

type ValidateStateNodeConfig<
  Node extends { readonly schema: Machine.TaggedSchema },
  Path extends PropertyKey
> = Node extends { readonly type: "parallel" } ?
    & ValidateExactStateNodeProperties<Node, "parallel", Path>
    & ValidateStateNodeWithChildren<Node, Node extends { readonly states: infer Children } ? Children : never, Path>
  : Node extends { readonly type: "final" } ?
      & ValidateExactStateNodeProperties<Node, "final", Path>
      & ValidateStateNodeWithoutChildren<Node>
  : Node extends { readonly states: infer Children } ?
      & ValidateExactStateNodeProperties<Node, "compound", Path>
      & ValidateStateNodeWithChildren<Node, Children, Path>
  :
    & ValidateExactStateNodeProperties<Node, "atomic", Path>
    & ValidateStateNodeWithoutChildren<Node>

type ValidateOutputSchema<Node> = "output" extends keyof Node ? Node extends { readonly output: Schema.Top } ? unknown
  : StateDefinitionError<"State output must be a schema">
  : unknown

type ValidateStateNodeWithChildren<
  Node extends { readonly schema: Machine.TaggedSchema },
  Children,
  Path extends PropertyKey
> = Children extends Machine.StateSchemas ?
  Node extends { readonly type: "final" } ? StateDefinitionError<"Final states cannot declare child states">
  : Node extends { readonly type: "parallel" } ?
    "initial" extends keyof Node ? StateDefinitionError<"Parallel states cannot declare an initial child">
    : { readonly states: ValidateStateTree<Children, true, Extract<Path, string>> } & ValidateOutputSchema<Node>
  : "output" extends keyof Node ? StateDefinitionError<"Only final and parallel states can declare output">
  : ValidateCompoundStateNode<Node, Children, Path>
  : StateDefinitionError<"Child states must be a state tree">

type ValidateCompoundStateNode<
  Node extends { readonly schema: Machine.TaggedSchema },
  Children extends Machine.StateSchemas,
  Path extends PropertyKey
> = Node extends { readonly initial: infer Initial } ?
  Initial extends ActiveStateKey<Children> | ChoiceStateKey<Children> ? {
      readonly states: ValidateStateTree<Children, true, Extract<Path, string>>
    }
  : StateDefinitionError<"Compound initial must be one of its direct child keys">
  : StateDefinitionError<"Compound states must declare an initial child">

type ValidateStateNodeWithoutChildren<Node extends { readonly schema: Machine.TaggedSchema }> = "initial" extends
  keyof Node ? StateDefinitionError<"Atomic states cannot declare an initial child">
  : Node extends { readonly type: infer Type } ? Type extends "final" ? ValidateOutputSchema<Node>
    : Type extends "active" | undefined ?
      "output" extends keyof Node ? StateDefinitionError<"Only final and parallel states can declare output">
      : unknown
    : StateDefinitionError<"State node type must be active, final, or parallel">
  : "output" extends keyof Node ? StateDefinitionError<"Only final and parallel states can declare output">
  : unknown

type DefineStateTreeInput<States extends Machine.StateSchemas> = {
  readonly [Key in keyof States]: DefineStateNodeInput<States[Key]>
}

type DefineStateNodeInput<Node> = Node extends Machine.TaggedSchema ? Node
  : Node extends Machine.HistoryStateNodeConfig ? Machine.HistoryStateNodeConfig
  : Node extends Machine.ChoiceStateNodeConfig ? Machine.ChoiceStateNodeConfig
  : Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
    Omit<Node, "states"> & { readonly states: DefineStateTreeInput<Children> }
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? Omit<Node, "initial" | "states"> & {
      readonly initial: ActiveStateKey<Children> | ChoiceStateKey<Children>
      readonly states: DefineStateTreeInput<Children>
    }
  : Node

type ValidateDefinedStates<States extends Machine.StateSchemas> = [States] extends
  [Machine.ValidateStateSchemas<States>] ? []
  : [validation: Machine.ValidateStateSchemas<States>]

type InvalidDefinedStateTreeInput<States extends Machine.StateSchemas> = [States] extends
  [Machine.ValidateStateSchemas<States>] ? never
  : States & Machine.ValidateStateSchemas<States>

interface DefineStates {
  <const States extends Machine.StateSchemas>(
    states: States & DefineStateTreeInput<NoInfer<States>>,
    ..._validation: ValidateDefinedStates<NoInfer<States>>
  ): Machine.DefinedStates<States>
  <const States extends Machine.StateSchemas>(states: InvalidDefinedStateTreeInput<States>): never
}

type EventProtocolError<Message extends string, Tag extends PropertyKey = never> = {
  readonly "~effect/Machine/EventProtocolError": Message
  readonly tag: Tag
}

type DuplicateEventTag<
  Events extends ReadonlyArray<Machine.TaggedSchema>,
  Seen extends PropertyKey = never
> = number extends Events["length"] ? never
  : Events extends readonly [
    infer Head extends Machine.TaggedSchema,
    ...infer Tail extends ReadonlyArray<Machine.TaggedSchema>
  ] ? Machine.TagOf<Head> extends infer Tag extends PropertyKey ? Tag extends Seen ? Tag | DuplicateEventTag<Tail, Seen>
      : DuplicateEventTag<Tail, Seen | Tag>
    : never
  : never

type ValidateInputEventProtocol<
  InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  DuplicateInput extends PropertyKey = DuplicateEventTag<InputEvents>
> = [DuplicateInput] extends [never] ? unknown
  : EventProtocolError<"Public event tags must be unique", DuplicateInput>

type ValidateInternalEventProtocol<
  InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  InternalEvents extends ReadonlyArray<Machine.TaggedSchema>,
  DuplicateInternal extends PropertyKey = DuplicateEventTag<InternalEvents>,
  Overlap extends PropertyKey = Extract<
    Machine.TagOf<InputEvents[number]>,
    Machine.TagOf<InternalEvents[number]>
  >
> = [DuplicateInternal] extends [never] ? [Overlap] extends [never] ? unknown
  : EventProtocolError<"Public and internal event tags must be disjoint", Overlap>
  : EventProtocolError<"Internal event tags must be unique", DuplicateInternal>

const SnapshotBuilderStateTypeId: unique symbol = Symbol("effect/Machine/SnapshotBuilderState")
const SnapshotBuilderConstructionTypeId: unique symbol = Symbol("effect/Machine/SnapshotBuilderConstruction")

type SnapshotBuilderComplete<Regions, Constructed extends boolean = false> = {
  readonly [SnapshotBuilderStateTypeId]: Regions
  readonly [SnapshotBuilderConstructionTypeId]: Constructed
}

type FromCallable<Arguments extends ReadonlyArray<unknown>, Result> = Arguments extends
  readonly [infer Input, ...infer Rest extends ReadonlyArray<unknown>] ? {} extends Input ? {
      (...args: Rest): Result
      (...args: Arguments): Result
    }
  : (...args: Arguments) => Result
  : (...args: Arguments) => Result

type FromMethod<Arguments extends ReadonlyArray<unknown>, Result> = {
  /**
   * Constructs the selected state from its schema make input while the
   * machine plans the resulting configuration. The input may be omitted when
   * the schema accepts an empty constructor object.
   *
   * @since 4.0.0
   */
  readonly from: FromCallable<Arguments, Machine.StateConstruction<Result>>
}

type ConstructionResult<Result> = Result | Machine.StateConstruction<Result>

type UnwrapConstruction<Result> = Result extends Machine.StateConstruction<infer Value> ? Value : Result

type ConstructionSelectorFromCallable<Input, Builder, Result> = {} extends Input ? {
    <Selected extends ConstructionResult<Result>>(
      state: (builder: Builder) => Selected
    ): Machine.StateConstruction<UnwrapConstruction<Selected>>
    <Selected extends ConstructionResult<Result>>(
      input: Input,
      state: (builder: Builder) => Selected
    ): Machine.StateConstruction<UnwrapConstruction<Selected>>
  }
  : <Selected extends ConstructionResult<Result>>(
    input: Input,
    state: (builder: Builder) => Selected
  ) => Machine.StateConstruction<UnwrapConstruction<Selected>>

type InitialSnapshotBuilderWithPrefix<
  States extends Machine.StateSchemas,
  Prefix extends string = ""
> =
  & {
    readonly [Key in ActiveStateKey<States>]: InitialSnapshotMethod<States, Key, Prefix>
  }
  & {
    readonly [Key in ChoiceStateKey<States>]: () => Machine.ChoiceTargetInstruction<Machine.JoinPath<Prefix, Key>>
  }

type InitialSnapshotMethod<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string
> =
  & ((
    ...args: InitialSnapshotArguments<States, StateId, Prefix>
  ) => InitialSnapshotResult<States, StateId, Prefix>)
  & FromMethod<
    InitialSnapshotFromArguments<States, StateId, Prefix>,
    InitialSnapshotResult<States, StateId, Prefix>
  >

type InitialSnapshotArguments<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = States[StateId] extends infer Node ?
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ? [
      value: Machine.NodeSchema<Node>["Type"],
      states: (
        builder: InitialParallelBuilder<Children, Path>
      ) => SnapshotBuilderComplete<InitialSnapshotRegionsWithPrefix<Children, Path>>
    ]
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ?
    Node extends { readonly initial: infer Initial extends ActiveStateKey<Children> | ChoiceStateKey<Children> } ? [
        value: Machine.NodeSchema<Node>["Type"],
        state: (
          builder: Pick<InitialSnapshotBuilderWithPrefix<Children, Path>, Initial>
        ) => InitialSelectableResult<Children, Initial, Path>
      ]
    : never
  : [value: Machine.NodeSchema<Node>["Type"]]
  : never

type InitialSnapshotFromArguments<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = States[StateId] extends infer Node ?
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ? [
      input: Machine.NodeSchema<Node>["~type.make.in"],
      states: (
        builder: InitialParallelBuilder<Children, Path>
      ) => SnapshotBuilderComplete<InitialSnapshotRegionsWithPrefix<Children, Path>, boolean>
    ]
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ?
    Node extends { readonly initial: infer Initial extends ActiveStateKey<Children> | ChoiceStateKey<Children> } ? [
        input: Machine.NodeSchema<Node>["~type.make.in"],
        state: (
          builder: Pick<InitialSnapshotBuilderWithPrefix<Children, Path>, Initial>
        ) => ConstructionResult<InitialSelectableResult<Children, Initial, Path>>
      ]
    : never
  : [input: Machine.NodeSchema<Node>["~type.make.in"]]
  : never

type InitialSnapshotResult<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = States[StateId] extends infer Node ?
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
    Machine.ParallelSnapshot<
      Path,
      Machine.NodeSchema<Node>["Type"],
      InitialSnapshotRegionsWithPrefix<Children, Path>
    >
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ?
    Node extends { readonly initial: infer Initial extends ActiveStateKey<Children> | ChoiceStateKey<Children> } ?
      Machine.CompoundSnapshot<
        Path,
        Machine.NodeSchema<Node>["Type"],
        InitialSelectableResult<Children, Initial, Path>
      >
    : never
  : Machine.AtomicSnapshot<Path, Machine.NodeSchema<Node>["Type"]>
  : never

type InitialSelectableResult<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States> | ChoiceStateKey<States>,
  Prefix extends string
> = StateId extends ChoiceStateKey<States> ? Machine.ChoiceTargetInstruction<Machine.JoinPath<Prefix, StateId>>
  : StateId extends ActiveStateKey<States> ? InitialSnapshotResult<States, StateId, Prefix>
  : never

type InitialSnapshotRegionsWithPrefix<
  States extends Machine.StateSchemas,
  Prefix extends string
> = {
  readonly [Key in ActiveStateKey<States>]: InitialSnapshotResult<States, Key, Prefix>
}

type InitialParallelBuilder<
  States extends Machine.StateSchemas,
  Prefix extends string,
  Remaining extends ActiveStateKey<States> = ActiveStateKey<States>,
  Regions = {},
  Constructed extends boolean = false
> =
  & SnapshotBuilderComplete<Regions, Constructed>
  & {
    readonly [Key in Remaining]:
      & ((
        ...args: InitialSnapshotArguments<States, Key, Prefix>
      ) => InitialParallelBuilder<
        States,
        Prefix,
        Exclude<Remaining, Key>,
        Regions & { readonly [Region in Key]: InitialSnapshotResult<States, Key, Prefix> },
        Constructed
      >)
      & {
        readonly from: FromCallable<
          InitialSnapshotFromArguments<States, Key, Prefix>,
          InitialParallelBuilder<
            States,
            Prefix,
            Exclude<Remaining, Key>,
            Regions & { readonly [Region in Key]: InitialSnapshotResult<States, Key, Prefix> },
            true
          >
        >
      }
  }

type FullSnapshotBuilderWithPrefix<
  States extends Machine.StateSchemas,
  Prefix extends string = ""
> =
  & {
    readonly [Key in ActiveStateKey<States>]: FullSnapshotMethod<States, Key, Prefix>
  }
  & {
    readonly [Key in ChoiceStateKey<States>]: () => Machine.ChoiceTargetInstruction<Machine.JoinPath<Prefix, Key>>
  }

type FullSnapshotMethod<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string
> =
  & ((
    ...args: FullSnapshotArguments<States, StateId, Prefix>
  ) => FullSnapshotResult<States, StateId, Prefix>)
  & FromMethod<
    FullSnapshotFromArguments<States, StateId, Prefix>,
    FullSnapshotResult<States, StateId, Prefix>
  >

type FullSnapshotArguments<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = States[StateId] extends infer Node ?
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ? [
      value: Machine.NodeSchema<Node>["Type"],
      states: (
        builder: FullParallelBuilder<Children, Path>
      ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>>
    ]
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? [
      value: Machine.NodeSchema<Node>["Type"],
      state: (
        builder: FullSnapshotBuilderWithPrefix<Children, Path>
      ) =>
        | Machine.SnapshotWithPrefix<Children, Path>
        | Machine.ChoiceTargetInstruction<Machine.ChoiceIdentifierWithPrefix<Children, Path>>
    ]
  : [value: Machine.NodeSchema<Node>["Type"]]
  : never

type FullSnapshotFromArguments<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = States[StateId] extends infer Node ?
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ? [
      input: Machine.NodeSchema<Node>["~type.make.in"],
      states: (
        builder: FullParallelBuilder<Children, Path>
      ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>, boolean>
    ]
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? [
      input: Machine.NodeSchema<Node>["~type.make.in"],
      state: (
        builder: FullSnapshotBuilderWithPrefix<Children, Path>
      ) => ConstructionResult<
        | Machine.SnapshotWithPrefix<Children, Path>
        | Machine.ChoiceTargetInstruction<Machine.ChoiceIdentifierWithPrefix<Children, Path>>
      >
    ]
  : [input: Machine.NodeSchema<Node>["~type.make.in"]]
  : never

type FullSnapshotResult<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = Machine.SnapshotByIdentifierWithPath<States, StateId, Path>

type FullParallelBuilder<
  States extends Machine.StateSchemas,
  Prefix extends string,
  Remaining extends ActiveStateKey<States> = ActiveStateKey<States>,
  Regions = {},
  Constructed extends boolean = false
> =
  & SnapshotBuilderComplete<Regions, Constructed>
  & {
    readonly [Key in Remaining]:
      & ((
        ...args: FullSnapshotArguments<States, Key, Prefix>
      ) => FullParallelBuilder<
        States,
        Prefix,
        Exclude<Remaining, Key>,
        Regions & { readonly [Region in Key]: FullSnapshotResult<States, Key, Prefix> },
        Constructed
      >)
      & {
        readonly from: FromCallable<
          FullSnapshotFromArguments<States, Key, Prefix>,
          FullParallelBuilder<
            States,
            Prefix,
            Exclude<Remaining, Key>,
            Regions & { readonly [Region in Key]: FullSnapshotResult<States, Key, Prefix> },
            true
          >
        >
      }
  }

type HistorySnapshotArguments<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Owner extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = Path extends Owner ? FullSnapshotArguments<States, StateId, Prefix>
  : States[StateId] extends infer Node ?
    Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ? [
        value: Machine.NodeSchema<Node>["Type"],
        states: (
          builder: HistoryParallelBuilder<Children, Path, Owner>
        ) => SnapshotBuilderComplete<HistorySnapshotRegions<Children, Path, Owner>>
      ]
    : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? [
        value: Machine.NodeSchema<Node>["Type"],
        state: (
          builder: HistorySnapshotBuilderWithPrefix<Children, Owner, Path>
        ) => ConstructionResult<HistorySnapshotWithPrefix<Children, Owner, Path>>
      ]
    : never
  : never

type HistorySnapshotFromArguments<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Owner extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = Path extends Owner ? FullSnapshotFromArguments<States, StateId, Prefix>
  : States[StateId] extends infer Node ?
    Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ? [
        input: Machine.NodeSchema<Node>["~type.make.in"],
        states: (
          builder: HistoryParallelBuilder<Children, Path, Owner>
        ) => SnapshotBuilderComplete<HistorySnapshotRegions<Children, Path, Owner>, boolean>
      ]
    : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? [
        input: Machine.NodeSchema<Node>["~type.make.in"],
        state: (
          builder: HistorySnapshotBuilderWithPrefix<Children, Owner, Path>
        ) => ConstructionResult<HistorySnapshotWithPrefix<Children, Owner, Path>>
      ]
    : never
  : never

type HistorySnapshotResult<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Owner extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = Path extends Owner ? FullSnapshotResult<States, StateId, Prefix>
  : States[StateId] extends infer Node ?
    Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
      Machine.ParallelSnapshot<
        Path,
        Machine.NodeSchema<Node>["Type"],
        HistorySnapshotRegions<Children, Path, Owner>
      >
    : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? Machine.CompoundSnapshot<
        Path,
        Machine.NodeSchema<Node>["Type"],
        HistorySnapshotWithPrefix<Children, Owner, Path>
      >
    : never
  : never

type HistorySnapshotMethod<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Owner extends string
> =
  & ((
    ...args: HistorySnapshotArguments<States, StateId, Prefix, Owner>
  ) => HistorySnapshotResult<States, StateId, Prefix, Owner>)
  & FromMethod<
    HistorySnapshotFromArguments<States, StateId, Prefix, Owner>,
    HistorySnapshotResult<States, StateId, Prefix, Owner>
  >

type HistorySnapshotWithPrefix<
  States extends Machine.StateSchemas,
  Owner extends string,
  Prefix extends string
> = {
  readonly [Key in ActiveStateKey<States>]: Owner extends
    | Machine.JoinPath<Prefix, Key>
    | `${Machine.JoinPath<Prefix, Key>}.${string}` ? HistorySnapshotResult<States, Key, Prefix, Owner>
    : never
}[ActiveStateKey<States>]

type HistorySnapshotBuilderWithPrefix<
  States extends Machine.StateSchemas,
  Owner extends string,
  Prefix extends string = ""
> = {
  readonly [
    Key in ActiveStateKey<States> as Owner extends
      | Machine.JoinPath<Prefix, Key>
      | `${Machine.JoinPath<Prefix, Key>}.${string}` ? Key
      : never
  ]: HistorySnapshotMethod<States, Key, Prefix, Owner>
}

type HistorySnapshotRegions<
  States extends Machine.StateSchemas,
  Prefix extends string,
  Owner extends string
> = {
  readonly [Key in ActiveStateKey<States>]: Owner extends
    | Machine.JoinPath<Prefix, Key>
    | `${Machine.JoinPath<Prefix, Key>}.${string}` ? HistorySnapshotResult<States, Key, Prefix, Owner>
    : FullSnapshotResult<States, Key, Prefix>
}

type HistoryParallelBuilder<
  States extends Machine.StateSchemas,
  Prefix extends string,
  Owner extends string,
  Remaining extends ActiveStateKey<States> = ActiveStateKey<States>,
  Regions = {},
  Constructed extends boolean = false
> =
  & SnapshotBuilderComplete<Regions, Constructed>
  & {
    readonly [Key in Remaining]: Owner extends
      | Machine.JoinPath<Prefix, Key>
      | `${Machine.JoinPath<Prefix, Key>}.${string}` ?
        & ((...args: HistorySnapshotArguments<States, Key, Prefix, Owner>) => HistoryParallelBuilder<
          States,
          Prefix,
          Owner,
          Exclude<Remaining, Key>,
          Regions & { readonly [Region in Key]: HistorySnapshotResult<States, Key, Prefix, Owner> },
          Constructed
        >)
        & {
          readonly from: FromCallable<
            HistorySnapshotFromArguments<States, Key, Prefix, Owner>,
            HistoryParallelBuilder<
              States,
              Prefix,
              Owner,
              Exclude<Remaining, Key>,
              Regions & { readonly [Region in Key]: HistorySnapshotResult<States, Key, Prefix, Owner> },
              true
            >
          >
        }
      :
        & ((...args: FullSnapshotArguments<States, Key, Prefix>) => HistoryParallelBuilder<
          States,
          Prefix,
          Owner,
          Exclude<Remaining, Key>,
          Regions & { readonly [Region in Key]: FullSnapshotResult<States, Key, Prefix> },
          Constructed
        >)
        & {
          readonly from: FromCallable<
            FullSnapshotFromArguments<States, Key, Prefix>,
            HistoryParallelBuilder<
              States,
              Prefix,
              Owner,
              Exclude<Remaining, Key>,
              Regions & { readonly [Region in Key]: FullSnapshotResult<States, Key, Prefix> },
              true
            >
          >
        }
  }

type ParentPath<Path extends string> = Path extends `${infer Parent}.${infer Child}`
  ? Child extends `${string}.${string}` ? `${Parent}.${ParentPath<Child>}` : Parent
  : never

type IsCompoundNode<Node> = Node extends { readonly type: "parallel" } ? false
  : Node extends { readonly states: Machine.StateSchemas } ? true
  : false

type NearestCompoundScope<
  States extends Machine.StateSchemas,
  Source extends Machine.StateNodeIdentifier<States>
> = Source extends Machine.StateIdentifier<States> ?
  IsCompoundNode<Machine.NodeByIdentifier<States, Source>> extends true ? Source
  : ParentPath<Source> extends infer Parent extends Machine.StateIdentifier<States> ?
    NearestCompoundScope<States, Parent>
  : never
  : ParentPath<Source> extends infer Parent extends Machine.StateIdentifier<States> ?
    NearestCompoundScope<States, Parent>
  : never

type ChildrenOf<
  States extends Machine.StateSchemas,
  Path extends Machine.StateIdentifier<States>
> = Machine.NodeByIdentifier<States, Path> extends { readonly states: infer Children extends Machine.StateSchemas } ?
  Children
  : never

type StateIdentifierFromPath<
  States extends Machine.StateSchemas,
  Path extends string
> = Extract<Path, Machine.StateIdentifier<States>>

type LocalTargetResult<
  AllStates extends Machine.StateSchemas,
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = States[StateId] extends { readonly states: infer Children extends Machine.StateSchemas } ?
  States[StateId] extends { readonly type: "parallel" } ?
    Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>
  : LocalTargetResultWithPrefix<AllStates, Children, Path>
  : Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>

type LocalTargetResultWithPrefix<
  AllStates extends Machine.StateSchemas,
  States extends Machine.StateSchemas,
  Prefix extends string
> =
  | {
    readonly [Key in ActiveStateKey<States>]: LocalTargetResult<AllStates, States, Key, Prefix>
  }[ActiveStateKey<States>]
  | Machine.ChoiceTarget<
    AllStates,
    Extract<Machine.JoinPath<Prefix, ChoiceStateKey<States>>, Machine.ChoiceIdentifier<AllStates>>
  >

type LocalTargetBuilderWithPrefix<
  AllStates extends Machine.StateSchemas,
  States extends Machine.StateSchemas,
  Prefix extends string,
  Source extends Machine.StateNodeIdentifier<AllStates>
> =
  & {
    readonly [Key in ActiveStateKey<States>]: LocalTargetMethod<AllStates, States, Key, Prefix, Source>
  }
  & {
    readonly [Key in ChoiceStateKey<States>]: () => Machine.ChoiceTarget<
      AllStates,
      Extract<Machine.JoinPath<Prefix, Key>, Machine.ChoiceIdentifier<AllStates>>
    >
  }

type LocalTargetMethod<
  AllStates extends Machine.StateSchemas,
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Source extends Machine.StateNodeIdentifier<AllStates>,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = States[StateId] extends infer Node ?
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
    Source extends Path | `${Path}.${string}` ?
        & (<Result extends ConstructionResult<LocalTargetResultWithPrefix<AllStates, Children, Path>>>(
          value: Machine.NodeSchema<Node>["Type"],
          state: (
            builder: LocalTargetBuilderWithPrefix<AllStates, Children, Path, Source>
          ) => Result
        ) => Result)
        & {
          readonly from: ConstructionSelectorFromCallable<
            Machine.NodeSchema<Node>["~type.make.in"],
            LocalTargetBuilderWithPrefix<AllStates, Children, Path, Source>,
            LocalTargetResultWithPrefix<AllStates, Children, Path>
          >
        }
    :
      & ((
        value: Machine.NodeSchema<Node>["Type"],
        states: (
          builder: FullParallelBuilder<Children, Path>
        ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>>
      ) => Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>)
      & FromMethod<
        [
          input: Machine.NodeSchema<Node>["~type.make.in"],
          states: (
            builder: FullParallelBuilder<Children, Path>
          ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>, boolean>
        ],
        Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>
      >
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ?
      & (<Result extends ConstructionResult<LocalTargetResultWithPrefix<AllStates, Children, Path>>>(
        value: Machine.NodeSchema<Node>["Type"],
        state: (
          builder: LocalTargetBuilderWithPrefix<AllStates, Children, Path, Source>
        ) => Result
      ) => Result)
      & {
        readonly from: ConstructionSelectorFromCallable<
          Machine.NodeSchema<Node>["~type.make.in"],
          LocalTargetBuilderWithPrefix<AllStates, Children, Path, Source>,
          LocalTargetResultWithPrefix<AllStates, Children, Path>
        >
      }
  :
    & ((value: Machine.NodeSchema<Node>["Type"]) => Machine.Target<
      AllStates,
      StateIdentifierFromPath<AllStates, Path>
    >)
    & FromMethod<
      [input: Machine.NodeSchema<Node>["~type.make.in"]],
      Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>
    >
  : never

type LocalTargetBuilderForScope<
  States extends Machine.StateSchemas,
  Scope extends Machine.StateIdentifier<States>,
  Source extends Machine.StateNodeIdentifier<States>
> = ChildrenOf<States, Scope> extends infer Children extends Machine.StateSchemas ?
    & LocalTargetBuilderWithPrefix<States, Children, Scope, Source>
    & {
      /**
       * Updates the value of the state containing the local group and moves to
       * one of the states inside it. Values in other active branches are kept.
       *
       * @since 4.0.0
       */
      readonly with:
        & (<Result extends ConstructionResult<LocalTargetResultWithPrefix<States, Children, Scope>>>(
          value: Machine.StateByIdentifier<States, Scope>,
          state: (
            builder: LocalTargetBuilderWithPrefix<States, Children, Scope, Source>
          ) => Result
        ) => Result)
        & {
          readonly from: ConstructionSelectorFromCallable<
            Machine.SchemaByIdentifier<States, Scope>["~type.make.in"],
            LocalTargetBuilderWithPrefix<States, Children, Scope, Source>,
            LocalTargetResultWithPrefix<States, Children, Scope>
          >
        }
    }
  : {}

type BranchTargetResult<
  AllStates extends Machine.StateSchemas,
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = States[StateId] extends { readonly states: infer Children extends Machine.StateSchemas } ?
  States[StateId] extends { readonly type: "parallel" } ?
    Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>
  : BranchTargetResultWithPrefix<AllStates, Children, Path>
  : Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>

type BranchTargetResultWithPrefix<
  AllStates extends Machine.StateSchemas,
  States extends Machine.StateSchemas,
  Prefix extends string
> =
  | {
    readonly [Key in ActiveStateKey<States>]: BranchTargetResult<AllStates, States, Key, Prefix>
  }[ActiveStateKey<States>]
  | Machine.ChoiceTarget<
    AllStates,
    Extract<Machine.JoinPath<Prefix, ChoiceStateKey<States>>, Machine.ChoiceIdentifier<AllStates>>
  >

type BranchTargetBuilderWithPrefix<
  AllStates extends Machine.StateSchemas,
  States extends Machine.StateSchemas,
  Prefix extends string,
  Source extends Machine.StateNodeIdentifier<AllStates>
> =
  & {
    readonly [Key in ActiveStateKey<States>]: BranchTargetMethod<AllStates, States, Key, Prefix, Source>
  }
  & {
    readonly [Key in ChoiceStateKey<States>]: () => Machine.ChoiceTarget<
      AllStates,
      Extract<Machine.JoinPath<Prefix, Key>, Machine.ChoiceIdentifier<AllStates>>
    >
  }

type BranchTargetMethod<
  AllStates extends Machine.StateSchemas,
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Source extends Machine.StateNodeIdentifier<AllStates>,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = States[StateId] extends infer Node ?
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
    Source extends Path | `${Path}.${string}` ?
        & (<Result extends ConstructionResult<BranchTargetResultWithPrefix<AllStates, Children, Path>>>(
          value: Machine.NodeSchema<Node>["Type"],
          state: (
            builder: BranchTargetBuilderWithPrefix<AllStates, Children, Path, Source>
          ) => Result
        ) => Result)
        & {
          readonly from: ConstructionSelectorFromCallable<
            Machine.NodeSchema<Node>["~type.make.in"],
            BranchTargetBuilderWithPrefix<AllStates, Children, Path, Source>,
            BranchTargetResultWithPrefix<AllStates, Children, Path>
          >
        }
        & BranchTargetBuilderWithPrefix<AllStates, Children, Path, Source>
    :
      & ((
        value: Machine.NodeSchema<Node>["Type"],
        states: (
          builder: FullParallelBuilder<Children, Path>
        ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>>
      ) => Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>)
      & FromMethod<
        [
          input: Machine.NodeSchema<Node>["~type.make.in"],
          states: (
            builder: FullParallelBuilder<Children, Path>
          ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>, boolean>
        ],
        Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>
      >
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ?
      & (<Result extends ConstructionResult<BranchTargetResultWithPrefix<AllStates, Children, Path>>>(
        value: Machine.NodeSchema<Node>["Type"],
        state: (
          builder: BranchTargetBuilderWithPrefix<AllStates, Children, Path, Source>
        ) => Result
      ) => Result)
      & {
        readonly from: ConstructionSelectorFromCallable<
          Machine.NodeSchema<Node>["~type.make.in"],
          BranchTargetBuilderWithPrefix<AllStates, Children, Path, Source>,
          BranchTargetResultWithPrefix<AllStates, Children, Path>
        >
      }
      & BranchTargetBuilderWithPrefix<AllStates, Children, Path, Source>
  :
    & ((value: Machine.NodeSchema<Node>["Type"]) => Machine.Target<
      AllStates,
      StateIdentifierFromPath<AllStates, Path>
    >)
    & FromMethod<
      [input: Machine.NodeSchema<Node>["~type.make.in"]],
      Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>
    >
  : never

type BranchTargetBuilderForRoot<
  States extends Machine.StateSchemas,
  Root extends ActiveStateKey<States>,
  Source extends Machine.StateNodeIdentifier<States>
> = {
  readonly [Key in Root]: BranchTargetMethod<States, States, Key, "", Source>
}

type HistoryContainingKey<States extends Machine.StateSchemas> = {
  readonly [Key in Extract<keyof States, string>]: States[Key] extends Machine.HistoryStateNodeConfig ? Key
    : States[Key] extends { readonly states: infer Children extends Machine.StateSchemas } ?
      [Machine.HistoryIdentifier<Children>] extends [never] ? never : Key
    : never
}[Extract<keyof States, string>]

type HistoryTargetBuilderWithPrefix<
  AllStates extends Machine.StateSchemas,
  States extends Machine.StateSchemas,
  Prefix extends string
> = {
  readonly [Key in HistoryContainingKey<States>]: States[Key] extends Machine.HistoryStateNodeConfig ?
    () => Machine.HistoryTarget<
      AllStates,
      Extract<Machine.JoinPath<Prefix, Key>, Machine.HistoryIdentifier<AllStates>>
    >
    : States[Key] extends { readonly states: infer Children extends Machine.StateSchemas } ?
      HistoryTargetBuilderWithPrefix<AllStates, Children, Machine.JoinPath<Prefix, Key>>
    : never
}

type HasDirectShallowHistory<States extends Machine.StateSchemas> = {
  readonly [Key in HistoryStateKey<States>]: States[Key] extends { readonly history: "deep" } ? never : Key
}[HistoryStateKey<States>] extends never ? false : true

type InitializerClosureForNode<
  AllStates extends Machine.StateSchemas,
  Node,
  Path extends string
> = Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
    | Extract<Path, Machine.StateIdentifier<AllStates>>
    | InitializerClosuresForChildren<AllStates, Children, Path>
  : Node extends { readonly states: infer Children extends Machine.StateSchemas; readonly initial: infer Initial } ?
      | Extract<Path, Machine.StateIdentifier<AllStates>>
      | (Initial extends ActiveStateKey<Children> ? InitializerClosureForNode<
          AllStates,
          Children[Initial],
          Machine.JoinPath<Path, Initial>
        >
        : never)
  : never

type InitializerClosuresForChildren<
  AllStates extends Machine.StateSchemas,
  States extends Machine.StateSchemas,
  Prefix extends string
> = {
  readonly [Key in ActiveStateKey<States>]: InitializerClosureForNode<
    AllStates,
    States[Key],
    Machine.JoinPath<Prefix, Key>
  >
}[ActiveStateKey<States>]

type RequiredHistoryInitializersWithPrefix<
  AllStates extends Machine.StateSchemas,
  States extends Machine.StateSchemas,
  Prefix extends string
> = {
  readonly [Key in ActiveStateKey<States>]: States[Key] extends {
    readonly states: infer Children extends Machine.StateSchemas
  } ?
      | (HasDirectShallowHistory<Children> extends true ?
        InitializerClosuresForChildren<AllStates, Children, Machine.JoinPath<Prefix, Key>>
        : never)
      | RequiredHistoryInitializersWithPrefix<AllStates, Children, Machine.JoinPath<Prefix, Key>>
    : never
}[ActiveStateKey<States>]

type SpawnRequirements<Requirements> = Exclude<
  Requirements,
  Scope.Scope
>

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

/**
 * Represents the active or terminal lifecycle state of a running machine.
 *
 * **Details**
 *
 * Failures retain the last successfully published machine state and expose the
 * complete `Cause`. Stopped machines are distinct from machines that complete
 * with output or fail while processing an event.
 *
 * @category models
 * @since 4.0.0
 */
export type RuntimeSnapshot<State, Error = never, Output = never> =
  | {
    readonly status: "active"
    readonly state: State
  }
  | {
    readonly status: "done"
    readonly state: State
    readonly output: Output
  }
  | {
    readonly status: "error"
    readonly state: State
    readonly cause: Cause.Cause<Error>
  }
  | {
    readonly status: "stopped"
    readonly state: State
  }

/**
 * Represents a classified terminal outcome derived from a runtime snapshot.
 *
 * @category models
 * @since 4.0.0
 */
export type RuntimeOutcome<State, Error = never, Output = never> =
  | {
    readonly _tag: "Done"
    readonly output: Output
    readonly snapshot: Extract<RuntimeSnapshot<State, Error, Output>, { readonly status: "done" }>
  }
  | {
    readonly _tag: "Failure"
    readonly error: Error
    readonly cause: Cause.Cause<Error>
    readonly snapshot: Extract<RuntimeSnapshot<State, Error, Output>, { readonly status: "error" }>
  }
  | {
    readonly _tag: "Defect"
    readonly defect: unknown
    readonly cause: Cause.Cause<Error>
    readonly snapshot: Extract<RuntimeSnapshot<State, Error, Output>, { readonly status: "error" }>
  }
  | {
    readonly _tag: "Interrupted"
    readonly cause: Cause.Cause<Error>
    readonly snapshot: Extract<RuntimeSnapshot<State, Error, Output>, { readonly status: "error" }>
  }
  | {
    readonly _tag: "Cause"
    readonly cause: Cause.Cause<Error>
    readonly snapshot: Extract<RuntimeSnapshot<State, Error, Output>, { readonly status: "error" }>
  }
  | {
    readonly _tag: "Stopped"
    readonly snapshot: Extract<RuntimeSnapshot<State, Error, Output>, { readonly status: "stopped" }>
  }

/**
 * Provides access to a running machine's state, lifecycle, event input, and
 * termination operations.
 *
 * **Gotchas**
 *
 * `send` reports whether an event was accepted for delivery. Errors that occur
 * while asynchronously processing an accepted event are observed through
 * `snapshot`, `changes`, or `join`. Sending after termination fails with
 * `StoppedError`.
 *
 * @category models
 * @since 4.0.0
 */
export interface MachineRef<out State, in Event, out Error = never, out Output = never> {
  /** Stable machine definition id, or a generated fallback when none was declared. */
  readonly id: string

  /** Unique identity for this running machine instance. */
  readonly sessionId: string

  /** Reads the latest logical state. */
  readonly state: Effect.Effect<State>

  /** Reads the latest lifecycle snapshot. */
  readonly snapshot: Effect.Effect<RuntimeSnapshot<State, Error, Output>>

  /** Streams lifecycle snapshots published after subscription. */
  readonly changes: Stream.Stream<RuntimeSnapshot<State, Error, Output>>

  /** Waits for machine output or fails when execution fails or is stopped. */
  readonly join: Effect.Effect<Output, Error | StoppedError>

  /** Stops this machine instance and its owned child processes. */
  readonly stop: Effect.Effect<void>

  /** Accepts an event for asynchronous processing by the running machine. */
  readonly send: (event: Event) => Effect.Effect<void, StoppedError>

  /**
   * Returns the current directly owned child for a typed descriptor.
   *
   * @since 4.0.0
   */
  readonly child: <Child extends ChildMachine.Any>(
    child: Child
  ) => Effect.Effect<Option.Option<ChildMachine.Ref<Child>>>

  /**
   * Streams activation, replacement, and removal of a directly owned child.
   *
   * @since 4.0.0
   */
  readonly childChanges: <Child extends ChildMachine.Any>(
    child: Child
  ) => Stream.Stream<Option.Option<ChildMachine.Ref<Child>>>
}

/**
 * Machine-specific process logic used by `spawn` and `invoke`.
 *
 * @category models
 * @since 4.0.0
 */
export interface Logic<
  State,
  Event,
  out Error = never,
  out Requirements = never,
  out Output = never,
  out InitialError = never
> {
  /** Creates the initial process state and may spawn scoped child processes. */
  initial(scope: Logic.Scope<Event>): Effect.Effect<State, InitialError, Requirements>

  /** Runs the stateful process loop until it produces output or fails. */
  run(context: Logic.Context<State, Event>): Effect.Effect<Output, Error, Requirements>
}

/**
 * Public types used by advanced machine process logic.
 *
 * @since 4.0.0
 */
export declare namespace Logic {
  /**
   * Machine-local endpoint that can receive events and be stopped.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Address<in Event> {
    /** Parent-local address id. */
    readonly id: string

    /** Unique identity for this running child instance. */
    readonly sessionId: string

    /** Stops the addressed child process. */
    readonly stop: Effect.Effect<void>

    /** Sends an event to the addressed child process. */
    readonly send: (event: Event) => Effect.Effect<void, StoppedError>
  }

  /**
   * Starts child process logic owned by the current machine process.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Spawn {
    <ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError = never>(
      logic: Logic<ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError>
    ): Effect.Effect<
      MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
      ChildInitialError,
      Exclude<ChildRequirements, Scope.Scope>
    >
    <
      ChildState,
      ChildEvent,
      ChildError,
      ChildRequirements,
      ChildOutput,
      Options extends SpawnOptions,
      ChildInitialError = never
    >(
      logic: Logic<ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError>,
      options: Options & ChildAddress.OptionsCompatibility<Options, ChildEvent>
    ): Effect.Effect<
      MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
      SpawnIdError<Options> | ChildInitialError,
      Exclude<ChildRequirements, Scope.Scope>
    >
  }

  /**
   * Machine-local capabilities available while process logic initializes.
   *
   * **Gotchas**
   *
   * `sendParent` accepts `unknown` because process logic is independent from
   * the parent that eventually owns it. Prefer typed process output or an
   * invoke snapshot mapper when either can represent the communication.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Scope<Event> {
    /** Address of the process being initialized. */
    readonly self: Address<Event>

    /** Address of the owning process, when one exists. */
    readonly parent: Address<unknown> | undefined

    /** Starts a child process owned by this scope. */
    readonly spawn: Spawn

    /** Sends an untyped event to the owning process. */
    readonly sendParent: (event: unknown) => Effect.Effect<void, StoppedError>

    /** Sends an event through a typed parent-local child address. */
    readonly sendTo: <Address extends ChildAddress<never>>(
      id: Address,
      event: ChildAddress.Event<Address>
    ) => Effect.Effect<void, StoppedError>

    /** Stops a child process selected by its parent-local address. */
    readonly stopChild: <Event>(id: ChildAddress<Event>) => Effect.Effect<void>
  }

  /**
   * Machine-local capabilities available while stateful process logic runs.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Context<State, Event> extends Scope<Event> {
    /** Waits for the next event delivered to this process. */
    readonly receive: Effect.Effect<Event>

    /** Reads the current process state. */
    readonly state: Effect.Effect<State>

    /** Replaces the current process state. */
    readonly setState: (state: State) => Effect.Effect<void>

    /** Updates the current process state effectfully and atomically. */
    readonly updateState: <E, R>(
      update: (state: State) => Effect.Effect<State, E, R>
    ) => Effect.Effect<void, E, R>
  }
}

const ChildAddressTypeId = "~effect/Machine/ChildAddress"
const ChildAddressCompatibilityErrorTypeId = "~effect/Machine/ChildAddressCompatibilityError"
const ChildMachineTypeId = "~effect/Machine/ChildMachine"
type InvokeLifecycleId = string & { readonly [ChildAddressTypeId]?: never }

/**
 * Typed descriptor for a complete machine invoked as a child.
 *
 * **Details**
 *
 * The descriptor carries the child's address and complete machine type. Pass
 * the same value to `invokeMachine`, `sendTo`, and child lookup APIs so state,
 * event, error, and output types are inferred without separate annotations.
 *
 * @category models
 * @since 4.0.0
 */
export interface ChildMachine<Id extends string, M extends Machine.Any> {
  readonly [ChildMachineTypeId]: typeof ChildMachineTypeId

  /** Parent-local id used to address the invoked child. */
  readonly id: Id

  /** Complete machine definition carried by this descriptor. */
  readonly machine: M
}

/**
 * Namespace containing type-level members associated with `ChildMachine`.
 *
 * @since 4.0.0
 */
export declare namespace ChildMachine {
  /**
   * Any typed child machine descriptor.
   *
   * @category models
   * @since 4.0.0
   */
  export type Any = ChildMachine<string, Machine.Any>

  /**
   * Running machine reference selected by a child descriptor.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Ref<Child> = Child extends ChildMachine<string, infer M> ? MachineRef<
      Machine.Snapshot<Machine.States<M>>,
      Machine.InputEvent<M>,
      | Machine.Error<M>
      | ActionError<Machine.Services<M>>
      | InfiniteTransitionError
      | MachineSchemaDecodeError
      | StoppedError,
      Machine.Output<M>
    >
    : never

  /**
   * Event accepted by the child selected by a descriptor.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Event<Child> = Ref<Child> extends MachineRef<any, infer Event, any, any> ? Event : never
}

/**
 * Parent-local address for a child process that can receive events.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildAddress<Event> = string & ChildAddress.Variance<Event>

/**
 * Namespace containing type-level members associated with `ChildAddress`.
 *
 * @since 4.0.0
 */
export declare namespace ChildAddress {
  /**
   * Variance marker carried by a typed child process address.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Variance<in Event> {
    readonly [ChildAddressTypeId]: {
      readonly _Event: Types.Contravariant<Event>
    }
  }

  /**
   * Extracts the event protocol accepted by a child address.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Event<Address> = Address extends ChildAddress<infer Event> ? Event : unknown

  /**
   * Ensures a child address protocol is compatible with a child process event
   * protocol.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Compatibility<Address, Event> = [Address] extends [ChildAddress<infer AddressEvent>] ?
    [AddressEvent] extends [Event] ? unknown : {
      readonly [ChildAddressCompatibilityErrorTypeId]: {
        readonly address: AddressEvent
        readonly child: Event
      }
    }
    : unknown

  /**
   * Ensures spawn options with a typed child address are compatible with a
   * child process event protocol.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type OptionsCompatibility<Options, Event> = "id" extends keyof Options ? Options extends {
      readonly id?: infer Address
    } ? Compatibility<Exclude<Address, undefined>, Event>
    : unknown
    : unknown
}

/**
 * Options for spawning child processes.
 *
 * @category models
 * @since 4.0.0
 */
export interface SpawnOptions {
  readonly id?: string
}

/**
 * Options for spawning child processes with a parent-local id.
 *
 * @category models
 * @since 4.0.0
 */
export interface SpawnIdOptions extends SpawnOptions {
  readonly id: string
}

/**
 * Namespace containing type-level members associated with `Machine`.
 *
 * @since 4.0.0
 */
export declare namespace Machine {
  /**
   * Stable type-level representation carried by every machine definition.
   *
   * @internal
   */
  export interface TypeCarrier<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Input extends Schema.Top,
    UnhandledStates extends StateIdentifier<States>,
    E,
    R,
    InitialE,
    InitialR,
    FinalStates extends StateIdentifier<States>,
    Output,
    Emits extends ReadonlyArray<TaggedSchema>,
    OutputStates extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema>
  > {
    readonly states: States
    readonly events: Events
    readonly input: Input
    readonly unhandledStates: UnhandledStates
    readonly error: E
    readonly services: R
    readonly initialError: InitialE
    readonly initialServices: InitialR
    readonly finalStates: FinalStates
    readonly output: Output
    readonly emits: Emits
    readonly outputStates: OutputStates
    readonly inputEvents: InputEvents
  }

  /**
   * Any schema-first machine.
   *
   * This is an erased structural view for APIs that store machines without
   * knowing their protocols. Generic APIs should capture `M extends Any` to
   * preserve the concrete machine type. The private output-implementation
   * proof is intentionally omitted so erasing a machine cannot manufacture
   * that proof on another concrete `Machine` type.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Any extends Pipeable {
    readonly [TypeId]: TypeId
    /** @internal */
    readonly [MachineTypeId]: TypeCarrier<any, any, any, any, any, any, any, any, any, any, any, any, any>
    readonly states: StateSchemas
    readonly events: ReadonlyArray<TaggedSchema>
    readonly internalEvents: ReadonlyArray<TaggedSchema>
    readonly emits: ReadonlyArray<TaggedSchema>
    readonly input: Schema.Top | undefined
    readonly id: string | undefined
    /** @internal */
    readonly stateNodes: StateNodes
    /** @internal */
    readonly makeTargetBuilder: any
    /** @internal */
    readonly handlers: any
    /** @internal */
    readonly handle: any
    /** @internal */
    readonly initial: any
  }

  /**
   * Extracts the state schema tree carried by a machine definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type States<M extends Any> = M[typeof MachineTypeId]["states"]

  /**
   * Extracts the complete event schema tuple carried by a machine definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Events<M extends Any> = M[typeof MachineTypeId]["events"]

  /**
   * Extracts the input schema carried by a machine definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Input<M extends Any> = M[typeof MachineTypeId]["input"]

  /**
   * Extracts state paths that do not yet have handlers.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type UnhandledStates<M extends Any> = M[typeof MachineTypeId]["unhandledStates"]

  /**
   * Extracts the runtime error channel carried by a machine definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Error<M extends Any> = M[typeof MachineTypeId]["error"]

  /**
   * Extracts runtime service requirements carried by a machine definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Services<M extends Any> = M[typeof MachineTypeId]["services"]

  /**
   * Extracts the startup error channel carried by a machine definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InitialError<M extends Any> = M[typeof MachineTypeId]["initialError"]

  /**
   * Extracts startup service requirements carried by a machine definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InitialServices<M extends Any> = M[typeof MachineTypeId]["initialServices"]

  /**
   * Extracts final state paths carried by a machine definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type FinalStates<M extends Any> = M[typeof MachineTypeId]["finalStates"]

  /**
   * Extracts the terminal output channel carried by a machine definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Output<M extends Any> = M[typeof MachineTypeId]["output"]

  /**
   * Extracts the emitted event schema tuple carried by a machine definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Emits<M extends Any> = M[typeof MachineTypeId]["emits"]

  /**
   * Extracts state paths with implemented output handlers.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type OutputStates<M extends Any> = M[typeof MachineTypeId]["outputStates"]

  /**
   * Extracts the public input event schema tuple carried by a machine definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InputEvents<M extends Any> = M[typeof MachineTypeId]["inputEvents"]

  /**
   * Extracts the complete event protocol handled inside a machine.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Event<M extends Any> = EventOf<Events<M>>

  /**
   * Extracts the event protocol accepted by public machine input boundaries.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InputEvent<M extends Any> = EventOf<InputEvents<M>>

  /**
   * Extracts the event protocol emitted by a machine.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Emit<M extends Any> = EmitOf<Emits<M>>

  /**
   * A schema whose decoded value contains a `_tag` discriminator.
   *
   * **Details**
   *
   * This mirrors the tagged-schema constraint used by `Schema.toTaggedUnion`.
   *
   * @category models
   * @since 4.0.0
   */
  export type TaggedSchema = Schema.Top & { readonly Type: { readonly _tag: PropertyKey } }

  /**
   * Descriptive annotations exposed for compiled state nodes.
   *
   * Schema-backed states resolve their complete Effect Schema annotation map.
   * Pseudo-states accept only the descriptive fields below. Annotations never
   * affect state identity, targeting, or runtime behavior.
   *
   * @category models
   * @since 4.0.0
   */
  export interface StateNodeAnnotations extends Schema.Annotations.Annotations {
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly documentation?: string | undefined
  }

  /** Descriptive annotations accepted by schema-less pseudo-states. */
  export type PseudoStateAnnotations = Pick<
    StateNodeAnnotations,
    "title" | "description" | "documentation"
  >

  /**
   * Configuration accepted for an atomic object state node.
   *
   * @category models
   * @since 4.0.0
   */
  export type AtomicStateNodeConfig =
    | {
      readonly schema: TaggedSchema
      readonly type?: "active"
      readonly output?: never
    }
    | {
      readonly schema: TaggedSchema
      readonly type: "final"
      readonly output?: Schema.Top
    }

  /**
   * Configuration accepted for a compound object state node.
   *
   * @category models
   * @since 4.0.0
   */
  export interface CompoundStateNodeConfig {
    readonly schema: TaggedSchema
    readonly type?: "active"
    readonly initial: string
    readonly states: StateTree
  }

  /**
   * Configuration accepted for a parallel object state node.
   *
   * @category models
   * @since 4.0.0
   */
  export interface ParallelStateNodeConfig {
    readonly schema: TaggedSchema
    readonly type: "parallel"
    readonly output?: Schema.Top
    readonly states: StateTree
  }

  /**
   * Pseudo-state that restores the last active configuration of its parent.
   *
   * History nodes are transition targets only. They never become active and
   * therefore do not declare a state value schema or lifecycle handlers.
   * Both recorded history and a first-use default can rebuild inactive
   * ancestors. A default is a complete root configuration containing the
   * history owner, so its validity is independent of the transition source.
   *
   * @category models
   * @since 4.0.0
   */
  export interface HistoryStateNodeConfig {
    readonly type: "history"
    /** Defaults to shallow history. */
    readonly history?: "shallow" | "deep"
    readonly annotations?: PseudoStateAnnotations
  }

  /**
   * Transient decision pseudo-state resolved immediately when targeted.
   *
   * Choice nodes have no value and never belong to an active configuration.
   * Their required `choice` implementation uses ordinary TypeScript or an
   * Effect to select a typed target.
   *
   * @category models
   * @since 4.0.0
   */
  export interface ChoiceStateNodeConfig {
    readonly type: "choice"
    readonly annotations?: PseudoStateAnnotations
  }

  /**
   * Configuration accepted for an object state node.
   *
   * @category models
   * @since 4.0.0
   */
  export type StateNodeConfig =
    | AtomicStateNodeConfig
    | CompoundStateNodeConfig
    | ParallelStateNodeConfig
    | HistoryStateNodeConfig
    | ChoiceStateNodeConfig

  /**
   * Object state tree keyed by state path.
   *
   * Keys must be non-empty, non-numeric strings without `.`. The
   * prototype-mutating key `__proto__` and symbol keys are not accepted.
   *
   * @category models
   * @since 4.0.0
   */
  export type StateTree = Readonly<Record<string, TaggedSchema | StateNodeConfig>>

  /**
   * State schema definitions accepted by `make`.
   *
   * @category models
   * @since 4.0.0
   */
  export type StateSchemas = StateTree

  /**
   * Builder for initial state snapshots generated by `defineStates`.
   *
   * **When to use**
   *
   * Use when you need the type of the `initial` property returned by
   * `defineStates` or want to expose an initial snapshot builder from a helper.
   *
   * **Details**
   *
   * Initial builders enforce the declared initial child for compound states and
   * require every direct region for parallel states.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InitialBuilder<States extends StateSchemas> = InitialSnapshotBuilderWithPrefix<States>

  /**
   * State definitions and snapshot builders returned by `defineStates`.
   *
   * **Details**
   *
   * The `states` property is the original state tree and can be passed directly
   * to `make`. The `initial` property builds path-safe snapshots for the same
   * state tree.
   *
   * @category models
   * @since 4.0.0
   */
  export interface DefinedStates<States extends StateSchemas> {
    /** Original state tree supplied to {@link defineStates}. */
    readonly states: States

    /** Type-safe builders for constructing valid initial snapshots. */
    readonly initial: InitialBuilder<States>

    /**
     * Returns the decoded value for an active state path.
     *
     * @since 4.0.0
     */
    readonly get: <Path extends StateIdentifier<States>>(
      snapshot: Snapshot<States>,
      path: Path
    ) => Option.Option<StateByIdentifier<States, Path>>

    /**
     * Returns the decoded value for an active state path together with all of
     * its active parent values.
     *
     * **Details**
     *
     * Parent values are keyed by their full state paths.
     *
     * @since 4.0.0
     */
    readonly getWithParents: <Path extends StateIdentifier<States>>(
      snapshot: Snapshot<States>,
      path: Path
    ) => Option.Option<StateWithParents<States, Path>>

    /**
     * Returns the snapshot for an active state path.
     *
     * @since 4.0.0
     */
    readonly getSnapshot: <Path extends StateIdentifier<States>>(
      snapshot: Snapshot<States>,
      path: Path
    ) => Option.Option<SnapshotByIdentifier<States, Path>>

    /**
     * Returns whether a state path is active in the snapshot.
     *
     * @since 4.0.0
     */
    readonly matches: <Path extends StateIdentifier<States>>(
      snapshot: Snapshot<States>,
      path: Path
    ) => boolean
  }

  /**
   * Validates the nested shape of state schema definitions.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type ValidateStateSchemas<States extends StateSchemas> = ValidateStateTree<States>

  /** Properties shared by every compiled state-node variant. */
  export interface StateNodeBase<Path extends string = string> {
    readonly path: Path
    readonly key: string
    /** Resolved Effect Schema annotations, or descriptive pseudo-state annotations. */
    readonly annotations: Readonly<StateNodeAnnotations> | undefined
    readonly order: number
  }

  /** Runtime metadata for a compiled atomic state. */
  export interface AtomicStateNode<OwnPath extends string = string, ActivePath extends string = OwnPath>
    extends StateNodeBase<OwnPath>
  {
    readonly type: "atomic"
    readonly schema: TaggedSchema
    readonly output: undefined
    readonly history: undefined
    readonly parent: ActivePath | undefined
    readonly children: readonly []
    readonly initial: undefined
  }

  /** Runtime metadata for a compiled compound state. */
  export interface CompoundStateNode<
    OwnPath extends string = string,
    ActivePath extends string = OwnPath,
    ChoicePath extends string = ActivePath
  > extends StateNodeBase<OwnPath> {
    readonly type: "compound"
    readonly schema: TaggedSchema
    readonly output: undefined
    readonly history: undefined
    readonly parent: ActivePath | undefined
    /** Active child paths. Pseudo-states are available through their `parent` relationship. */
    readonly children: ReadonlyArray<ActivePath>
    readonly initial: ActivePath | ChoicePath
  }

  /** Runtime metadata for a compiled parallel state. */
  export interface ParallelStateNode<OwnPath extends string = string, ActivePath extends string = OwnPath>
    extends StateNodeBase<OwnPath>
  {
    readonly type: "parallel"
    readonly schema: TaggedSchema
    readonly output: Schema.Top | undefined
    readonly history: undefined
    readonly parent: ActivePath | undefined
    /** Active child paths. Pseudo-states are available through their `parent` relationship. */
    readonly children: ReadonlyArray<ActivePath>
    readonly initial: undefined
  }

  /** Runtime metadata for a compiled final state. */
  export interface FinalStateNode<OwnPath extends string = string, ActivePath extends string = OwnPath>
    extends StateNodeBase<OwnPath>
  {
    readonly type: "final"
    readonly schema: TaggedSchema
    readonly output: Schema.Top | undefined
    readonly history: undefined
    readonly parent: ActivePath | undefined
    readonly children: readonly []
    readonly initial: undefined
  }

  /** Runtime metadata for a compiled history pseudo-state. */
  export interface HistoryStateNode<OwnPath extends string = string, ActivePath extends string = string>
    extends StateNodeBase<OwnPath>
  {
    readonly type: "history"
    readonly schema: undefined
    readonly output: undefined
    readonly history: "shallow" | "deep"
    readonly parent: ActivePath
    readonly children: readonly []
    readonly initial: undefined
  }

  /** Runtime metadata for a compiled choice pseudo-state. */
  export interface ChoiceStateNode<OwnPath extends string = string, ActivePath extends string = string>
    extends StateNodeBase<OwnPath>
  {
    readonly type: "choice"
    readonly schema: undefined
    readonly output: undefined
    readonly history: undefined
    readonly parent: ActivePath
    readonly children: readonly []
    readonly initial: undefined
  }

  /**
   * Runtime metadata for a compiled state node.
   *
   * The `type` discriminator narrows every kind-specific topology and schema
   * property while preserving a uniform inspection shape.
   *
   * @category models
   * @since 4.0.0
   */
  export type ActiveStateNode<ActivePath extends string = string, ChoicePath extends string = ActivePath> =
    | AtomicStateNode<ActivePath, ActivePath>
    | CompoundStateNode<ActivePath, ActivePath, ChoicePath>
    | ParallelStateNode<ActivePath, ActivePath>
    | FinalStateNode<ActivePath, ActivePath>

  export type StateNode<
    ActivePath extends string = string,
    HistoryPath extends string = ActivePath,
    ChoicePath extends string = ActivePath
  > =
    | ActiveStateNode<ActivePath, ChoicePath>
    | HistoryStateNode<HistoryPath, ActivePath>
    | ChoiceStateNode<ChoicePath, ActivePath>

  /**
   * Runtime lookup table for state nodes.
   *
   * @category models
   * @since 4.0.0
   */
  export interface StateNodes<
    ActivePath extends string = string,
    HistoryPath extends string = ActivePath,
    ChoicePath extends string = ActivePath
  > {
    readonly byPath: ReadonlyMap<ActivePath | HistoryPath | ChoicePath, StateNode<ActivePath, HistoryPath, ChoicePath>>
    readonly roots: ReadonlyArray<ActivePath>
  }

  /**
   * Trigger that selects a registered transition handler.
   *
   * @category models
   * @since 4.0.0
   */
  export type TransitionTrigger<EventTag extends PropertyKey = PropertyKey> =
    | {
      readonly type: "event"
      readonly event: EventTag
    }
    | {
      readonly type: "always"
    }
    | {
      readonly type: "done"
    }
    | {
      readonly type: "choice"
    }

  /**
   * Statically inspectable destination paths for a transition handler.
   * A declared parent path covers every descendant below that state.
   *
   * @category models
   * @since 4.0.0
   */
  export type TransitionTargets<Path extends string = string> =
    | {
      readonly type: "dynamic"
    }
    | {
      readonly type: "declared"
      readonly paths: ReadonlyArray<Path>
    }

  /**
   * Inspectable registration for a transition handler.
   *
   * **Details**
   *
   * Event, eventless, and completion handlers may declare an upper bound of
   * possible target paths. A handler without that declaration is explicitly
   * reported as dynamic. The source, trigger, and reentry behavior are
   * available without executing the handler.
   *
   * @category models
   * @since 4.0.0
   */
  export interface TransitionDefinition<
    SourcePath extends string = string,
    EventTag extends PropertyKey = PropertyKey,
    TargetPath extends string = SourcePath
  > {
    readonly source: SourcePath
    readonly trigger: TransitionTrigger<EventTag>
    readonly reenter: boolean
    readonly targets: TransitionTargets<TargetPath>
  }

  /**
   * Serializable description of state-owned work.
   *
   * Static invoke descriptors expose their lifecycle id and kind without
   * retaining Effects, closures, services, or child runtimes. A function-valued
   * invoke factory is reported as dynamic and is never evaluated by inspection.
   *
   * @category models
   * @since 4.0.0
   */
  export type ActivityDefinition<SourcePath extends string = string> = Activities.ActivityDefinition<SourcePath>

  /**
   * Transition retained after hierarchy precedence and conflict resolution for
   * one planned microstep.
   *
   * @category models
   * @since 4.0.0
   */
  export interface RetainedTransition<
    SourcePath extends string = string,
    EventTag extends PropertyKey = PropertyKey,
    TargetPath extends string = SourcePath
  > {
    readonly source: SourcePath
    readonly trigger: TransitionTrigger<EventTag>
    readonly reenter: boolean
    /** Path returned by the handler, including a history pseudo-state. */
    readonly target: TargetPath | undefined
    /** Concrete path used after resolving history, otherwise equal to `target`. */
    readonly resolvedTarget: TargetPath | undefined
  }

  /**
   * Constructor arguments for a machine initial state function.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InputArgs<Input extends Schema.Top> = Input extends typeof Schema.Void ? []
    : [input: Input["Type"]]

  /**
   * Extracts the discriminator value represented by a tagged schema.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type TagOf<S extends TaggedSchema> = S["Type"]["_tag"]

  /**
   * Extracts the schema from a state tree node definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type NodeSchema<Node> = Node extends TaggedSchema ? Node
    : Node extends { readonly schema: infer Schema extends TaggedSchema } ? Schema
    : never

  /**
   * Prefixes a state path with its parent path.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type JoinPath<Parent extends string, Child extends string> = Parent extends "" ? Child : `${Parent}.${Child}`

  /**
   * Extracts the state path values represented by a state definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type StateIdentifier<States extends StateSchemas> = StateIdentifierWithPrefix<States>

  /**
   * Extracts the state path values represented by a state definition under a
   * parent path prefix.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type StateIdentifierWithPrefix<
    States extends StateSchemas,
    Prefix extends string = ""
  > = {
    readonly [Key in Extract<keyof States, string>]: States[Key] extends
      HistoryStateNodeConfig | ChoiceStateNodeConfig ? never
      : States[Key] extends { readonly states: infer Children }
        ? Children extends StateSchemas ?
          JoinPath<Prefix, Key> | StateIdentifierWithPrefix<Children, JoinPath<Prefix, Key>>
        : JoinPath<Prefix, Key>
      : JoinPath<Prefix, Key>
  }[Extract<keyof States, string>]

  /**
   * Extracts the transition-only history pseudo-state paths in a definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type HistoryIdentifier<States extends StateSchemas> = HistoryIdentifierWithPrefix<States>

  /** Extracts the transition-only choice pseudo-state paths. */
  export type ChoiceIdentifier<States extends StateSchemas> = ChoiceIdentifierWithPrefix<States>

  /**
   * Extracts every compiled state-node path, including history pseudo-states.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type StateNodeIdentifier<States extends StateSchemas> =
    | StateIdentifier<States>
    | HistoryIdentifier<States>
    | ChoiceIdentifier<States>

  /** @internal */
  export type HistoryIdentifierWithPrefix<
    States extends StateSchemas,
    Prefix extends string = ""
  > = {
    readonly [Key in Extract<keyof States, string>]: States[Key] extends HistoryStateNodeConfig ? JoinPath<Prefix, Key>
      : States[Key] extends { readonly states: infer Children extends StateSchemas } ?
        HistoryIdentifierWithPrefix<Children, JoinPath<Prefix, Key>>
      : never
  }[Extract<keyof States, string>]

  /** @internal */
  export type ChoiceIdentifierWithPrefix<
    States extends StateSchemas,
    Prefix extends string = ""
  > = {
    readonly [Key in Extract<keyof States, string>]: States[Key] extends ChoiceStateNodeConfig ? JoinPath<Prefix, Key>
      : States[Key] extends { readonly states: infer Children extends StateSchemas } ?
        ChoiceIdentifierWithPrefix<Children, JoinPath<Prefix, Key>>
      : never
  }[Extract<keyof States, string>]

  /** Active keys directly declared in a state tree. */
  export type ActiveStateKey<States extends StateSchemas> = {
    readonly [Key in Extract<keyof States, string>]: States[Key] extends HistoryStateNodeConfig | ChoiceStateNodeConfig
      ? never
      : Key
  }[Extract<keyof States, string>]

  /** History pseudo-state keys directly declared in a state tree. */
  export type HistoryStateKey<States extends StateSchemas> = {
    readonly [Key in Extract<keyof States, string>]: States[Key] extends HistoryStateNodeConfig ? Key : never
  }[Extract<keyof States, string>]

  /** Choice pseudo-state keys directly declared in a state tree. */
  export type ChoiceStateKey<States extends StateSchemas> = {
    readonly [Key in Extract<keyof States, string>]: States[Key] extends ChoiceStateNodeConfig ? Key : never
  }[Extract<keyof States, string>]

  /**
   * Active states that must implement implicit initial-value construction for
   * shallow history restoration.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type RequiredHistoryInitializers<States extends StateSchemas> = [HistoryIdentifier<States>] extends [never]
    ? never
    : Extract<RequiredHistoryInitializersWithPrefix<States, States, "">, StateIdentifier<States>>

  /** Active parent states that own one or more history pseudo-states. */
  export type HistoryParentIdentifier<States extends StateSchemas> = HistoryIdentifier<States> extends infer HistoryId
    ? HistoryId extends string ? Extract<ImmediateParentStateIdentifier<HistoryId>, StateIdentifier<States>> : never
    : never

  /** Active parent states that own one or more choice pseudo-states. */
  export type ChoiceParentIdentifier<States extends StateSchemas> = ChoiceIdentifier<States> extends infer ChoiceId
    ? ChoiceId extends string ? Extract<ImmediateParentStateIdentifier<ChoiceId>, StateIdentifier<States>> : never
    : never

  /** History defaults and implicit initializers that remain unimplemented. */
  export type MissingHistoryImplementations<
    States extends StateSchemas,
    UnhandledStates extends StateIdentifier<States>
  > = Extract<UnhandledStates, HistoryParentIdentifier<States> | RequiredHistoryInitializers<States>>

  /** Choice-owning active parents that remain unimplemented. */
  export type MissingChoiceImplementations<
    States extends StateSchemas,
    UnhandledStates extends StateIdentifier<States>
  > = Extract<UnhandledStates, ChoiceParentIdentifier<States>>

  /** @internal Readiness proof for required choice resolvers. */
  export type EnsureChoiceImplementations<
    States extends StateSchemas,
    UnhandledStates extends StateIdentifier<States>
  > = [ChoiceIdentifier<States>] extends [never] ? unknown
    : [MissingChoiceImplementations<States, UnhandledStates>] extends [never] ? unknown
    : {
      readonly "~effect/Machine/MissingChoiceImplementation": MissingChoiceImplementations<States, UnhandledStates>
    }

  /** @internal Readiness proof required by planning and managed execution. */
  export type EnsureHistoryImplementations<
    States extends StateSchemas,
    UnhandledStates extends StateIdentifier<States>
  > =
    & ([HistoryIdentifier<States>] extends [never] ? unknown
      : [MissingHistoryImplementations<States, UnhandledStates>] extends [never] ? unknown :
      {
        readonly "~effect/Machine/MissingHistoryImplementation": MissingHistoryImplementations<States, UnhandledStates>
      })
    & EnsureChoiceImplementations<States, UnhandledStates>

  /**
   * Extracts a state-tree node by state path.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type NodeByIdentifier<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = StateId extends `${infer Head}.${infer Rest}`
    ? Head extends keyof States
      ? States[Head] extends { readonly states: infer Children extends StateSchemas }
        ? Rest extends StateIdentifier<Children> ? NodeByIdentifier<Children, Rest> : never
      : never
    : never
    : StateId extends keyof States ? States[StateId]
    : never

  /**
   * Extracts a schema from a state definition by state identifier.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type SchemaByIdentifier<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeSchema<NodeByIdentifier<States, StateId>>

  /**
   * Extracts the union of state values represented by a state definition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type StateOf<States extends StateSchemas> = StateIdentifier<States> extends infer StateId
    ? StateId extends StateIdentifier<States> ? SchemaByIdentifier<States, StateId>["Type"]
    : never
    : never

  /**
   * Extracts the union of event values represented by an event schema list.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type EventOf<Events extends ReadonlyArray<TaggedSchema>> = Events[number]["Type"]

  /**
   * Extracts the union of emitted event values represented by an emitted event
   * schema list.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type EmitOf<Emits extends ReadonlyArray<TaggedSchema>> = Emits[number]["Type"]

  /**
   * Event values received by lifecycle callbacks.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type LifecycleEvent<Events extends ReadonlyArray<TaggedSchema>> = EventOf<Events> | InitialEvent

  /**
   * Extracts a state value from a state definition by identifier.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type StateByIdentifier<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = Extract<StateOf<States>, SchemaByIdentifier<States, StateId>["Type"]>

  /**
   * Extracts every parent state path from a state identifier.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type ParentStateIdentifier<StateId extends string> = StateId extends `${infer Parent}.${infer Child}`
    ? Parent | (Child extends `${string}.${string}` ? `${Parent}.${ParentStateIdentifier<Child>}` : never)
    : never

  /**
   * Extracts the nearest parent state path from a state identifier.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type ImmediateParentStateIdentifier<StateId extends string> = StateId extends `${infer Head}.${infer Tail}` ?
    Tail extends `${string}.${string}` ? `${Head}.${ImmediateParentStateIdentifier<Tail>}`
    : Head
    : never

  /**
   * Maps every parent state path of a state identifier to its decoded value.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type ParentStateValues<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = StateId extends StateIdentifier<States> ? {
      readonly [Parent in Extract<ParentStateIdentifier<StateId>, StateIdentifier<States>>]: StateByIdentifier<
        States,
        Parent
      >
    }
    : never

  /**
   * Extracts the nearest parent value, or `undefined` for a root state.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type ParentStateValue<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = StateId extends StateIdentifier<States> ?
    Extract<ImmediateParentStateIdentifier<StateId>, StateIdentifier<States>> extends infer Parent
      ? [Parent] extends [never] ? undefined
      : Parent extends StateIdentifier<States> ? StateByIdentifier<States, Parent>
      : undefined
    : undefined
    : never

  /**
   * Represents a decoded state value together with all of its parent values.
   *
   * @category models
   * @since 4.0.0
   */
  export type StateWithParents<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = StateId extends StateIdentifier<States> ? {
      readonly value: StateByIdentifier<States, StateId>
      readonly parents: ParentStateValues<States, StateId>
    }
    : never

  type UndefinedIfNever<A> = [A] extends [never] ? undefined : A

  type NodeOutput<Node> = Node extends { readonly output: infer Output extends Schema.Top } ? Schema.Schema.Type<Output>
    : undefined

  /**
   * Extracts the declared output type for a state node.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type OutputByIdentifier<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeOutput<NodeByIdentifier<States, StateId>>

  type DirectFinalCompletionOutput<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeByIdentifier<States, StateId> extends { readonly type: "final" } ? OutputByIdentifier<States, StateId>
    : never

  type CompoundCompletionOutput<
    States extends StateSchemas,
    Children extends StateSchemas,
    Prefix extends StateIdentifier<States>
  > = UndefinedIfNever<CompoundCompletionOutputRaw<States, Children, Prefix>>

  type CompoundCompletionOutputRaw<
    States extends StateSchemas,
    Children extends StateSchemas,
    Prefix extends StateIdentifier<States>
  > = {
    readonly [Key in ActiveStateKey<Children>]: DirectFinalCompletionOutput<
      States,
      Extract<JoinPath<Prefix, Key>, StateIdentifier<States>>
    >
  }[ActiveStateKey<Children>]

  /**
   * Extracts the output passed when a state node completes.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type CompletionOutputByIdentifier<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeByIdentifier<States, StateId> extends infer Node
    ? Node extends { readonly type: "parallel" } ? OutputByIdentifier<States, StateId>
    : Node extends { readonly states: infer Children extends StateSchemas } ? CompoundCompletionOutput<
        States,
        Children,
        StateId
      >
    : Node extends { readonly type: "final" } ? OutputByIdentifier<States, StateId>
    : undefined
    : undefined

  /**
   * Extracts the schema-derived union produced by structurally terminal root
   * states.
   *
   * **Details**
   *
   * Unlike a planned step's optional `output`, active atomic roots do not add
   * `undefined` to the union. Output-less final and parallel roots
   * intentionally contribute `undefined`, because that is their completed
   * value. Handler-driven reachability can make this structural union
   * conservative; for example, a root `onDone` handler can transition away
   * before that root becomes the machine's terminal result.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type TerminalOutput<States extends StateSchemas> = {
    readonly [Key in Extract<keyof States, string>]: Extract<Key, StateIdentifier<States>> extends
      infer StateId extends StateIdentifier<States> ?
      NodeByIdentifier<States, StateId> extends infer Node
        ? Node extends { readonly type: "parallel" | "final" } ? OutputByIdentifier<States, StateId>
        : Node extends { readonly states: infer Children extends StateSchemas } ? CompoundCompletionOutputRaw<
            States,
            Children,
            StateId
          >
        : never
      : never
      : never
  }[Extract<keyof States, string>]

  /**
   * Extracts every state path whose definition declares an output schema.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type DeclaredOutputState<States extends StateSchemas> =
    & {
      readonly [StateId in StateIdentifier<States>]: NodeByIdentifier<States, StateId> extends
        { readonly output: Schema.Top } ? StateId
        : never
    }[StateIdentifier<States>]
    & StateIdentifier<States>

  /**
   * Validates that every declared output schema has a matching handler
   * implementation before a machine is planned or started.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type EnsureOutputImplementations<
    States extends StateSchemas,
    OutputStates extends StateIdentifier<States>
  > = [
    Exclude<DeclaredOutputState<States>, OutputStates>
  ] extends [never] ? unknown : {
    readonly "~effect/Machine/MissingOutputImplementation": Exclude<
      DeclaredOutputState<States>,
      OutputStates
    >
  }

  type OutputSchema<Node> = Node extends { readonly output: infer Output extends Schema.Top } ? Output : never

  type DecodingServices<Current> = Current extends Schema.Top ? Current["DecodingServices"] : never

  type EncodingServices<Current> = Current extends Schema.Top ? Current["EncodingServices"] : never

  /**
   * Services required to decode every state value and completion output in a
   * machine snapshot.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type SnapshotDecodingServices<States extends StateSchemas> = StateIdentifier<States> extends infer StateId
    ? StateId extends StateIdentifier<States> ?
        | DecodingServices<SchemaByIdentifier<States, StateId>>
        | DecodingServices<OutputSchema<NodeByIdentifier<States, StateId>>>
    : never
    : never

  /**
   * Services required to encode every state value and completion output in a
   * machine snapshot.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type SnapshotEncodingServices<States extends StateSchemas> = StateIdentifier<States> extends infer StateId
    ? StateId extends StateIdentifier<States> ?
        | EncodingServices<SchemaByIdentifier<States, StateId>>
        | EncodingServices<OutputSchema<NodeByIdentifier<States, StateId>>>
    : never
    : never

  /**
   * Encoded value for one active state path in a normalized machine snapshot.
   *
   * @category models
   * @since 4.0.0
   */
  export interface EncodedSnapshotState {
    readonly path: string
    readonly value: unknown
  }

  /**
   * Encoded output for one completed state path in a normalized machine
   * snapshot. An omitted output represents `undefined`.
   *
   * @category models
   * @since 4.0.0
   */
  export interface EncodedSnapshotCompletion {
    readonly path: string
    readonly output?: unknown
  }

  /** Encoded values and paths retained by one history pseudo-state. */
  export interface EncodedSnapshotHistoryEntry {
    readonly mode: "shallow" | "deep"
    readonly active: ReadonlyArray<string>
    readonly values: Readonly<Record<string, unknown>>
  }

  /**
   * Normalized data representation of a machine snapshot.
   *
   * **Details**
   *
   * Active state and completion values use the encoded representations of
   * their declared schemas. Runtime process state such as children, fibers,
   * scopes, queues, and subscriptions is not included.
   *
   * @category models
   * @since 4.0.0
   */
  export interface EncodedSnapshot {
    readonly _tag: "MachineSnapshot"
    readonly active: ReadonlyArray<EncodedSnapshotState>
    readonly completed?: ReadonlyArray<EncodedSnapshotCompletion>
    readonly history?: Readonly<Record<string, EncodedSnapshotHistoryEntry>>
  }

  /**
   * Completed state path and its resolved output value.
   *
   * @category models
   * @since 4.0.0
   */
  export interface SnapshotCompletion {
    readonly path: string
    readonly output: unknown
  }

  /** Decoded values and paths retained by one history pseudo-state. */
  export interface SnapshotHistoryEntry {
    readonly mode: "shallow" | "deep"
    readonly active: ReadonlyArray<string>
    readonly values: Readonly<Record<string, unknown>>
  }

  /**
   * Carries lifecycle metadata required to resume planning from a cloned
   * snapshot.
   *
   * **Gotchas**
   *
   * Snapshots contain decoded in-memory values. Their current object shape is
   * experimental and is not a stable JSON persistence or wire format. Copies
   * must preserve decoded values such as `Schema.Class` instances; JSON and
   * `structuredClone` may not preserve those runtime contracts.
   * Use {@link encodeSnapshot} and {@link decodeSnapshot} to cross a persistence
   * or transport boundary.
   *
   * @category models
   * @since 4.0.0
   */
  export interface SnapshotMetadata {
    readonly completed?: ReadonlyArray<SnapshotCompletion>
    readonly history?: Readonly<Record<string, SnapshotHistoryEntry>>
  }

  /**
   * Atomic statechart snapshot carrying path identity separately from the
   * decoded state value.
   *
   * @category models
   * @since 4.0.0
   */
  export interface AtomicSnapshot<Path extends string, Value> extends SnapshotMetadata {
    readonly path: Path
    readonly value: Value
  }

  /**
   * Compound statechart snapshot carrying parent value plus the active child
   * snapshot.
   *
   * @category models
   * @since 4.0.0
   */
  export interface CompoundSnapshot<Path extends string, Value, Child> extends SnapshotMetadata {
    readonly path: Path
    readonly value: Value
    readonly state: Child
  }

  /**
   * Parallel statechart snapshot carrying parent value plus one active snapshot
   * per child region.
   *
   * @category models
   * @since 4.0.0
   */
  export interface ParallelSnapshot<Path extends string, Value, Regions> extends SnapshotMetadata {
    readonly path: Path
    readonly value: Value
    readonly states: Regions
  }

  /**
   * Extracts the snapshot value represented by a state definition by
   * identifier.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type SnapshotByIdentifier<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeByIdentifier<States, StateId> extends infer Node
    ? Node extends { readonly type: "parallel"; readonly states: infer Children }
      ? Children extends StateSchemas ? ParallelSnapshot<
          StateId,
          StateByIdentifier<States, StateId>,
          SnapshotRegionsWithPrefix<Children, StateId>
        >
      : AtomicSnapshot<StateId, StateByIdentifier<States, StateId>>
    : Node extends { readonly states: infer Children } ? Children extends StateSchemas ? CompoundSnapshot<
          StateId,
          StateByIdentifier<States, StateId>,
          SnapshotWithPrefix<Children, StateId>
        >
      : AtomicSnapshot<StateId, StateByIdentifier<States, StateId>>
    : AtomicSnapshot<StateId, StateByIdentifier<States, StateId>>
    : AtomicSnapshot<StateId, StateByIdentifier<States, StateId>>

  /**
   * Extracts child snapshots under a parent path prefix.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type SnapshotWithPrefix<
    States extends StateSchemas,
    Prefix extends string
  > = {
    readonly [Key in ActiveStateKey<States>]: SnapshotByIdentifierWithPath<States, Key, JoinPath<Prefix, Key>>
  }[ActiveStateKey<States>]

  /**
   * Extracts child snapshots under a parallel parent path prefix, keyed by
   * child region.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type SnapshotRegionsWithPrefix<
    States extends StateSchemas,
    Prefix extends string
  > = {
    readonly [Key in ActiveStateKey<States>]: SnapshotByIdentifierWithPath<States, Key, JoinPath<Prefix, Key>>
  }

  /**
   * Extracts a snapshot for a state node while preserving its full path.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type SnapshotByIdentifierWithPath<
    States extends StateSchemas,
    StateId extends ActiveStateKey<States>,
    Path extends string
  > = States[StateId] extends { readonly type: "parallel"; readonly states: infer Children }
    ? Children extends StateSchemas ? ParallelSnapshot<
        Path,
        NodeSchema<States[StateId]>["Type"],
        SnapshotRegionsWithPrefix<Children, Path>
      >
    : AtomicSnapshot<Path, NodeSchema<States[StateId]>["Type"]>
    : States[StateId] extends { readonly states: infer Children } ? Children extends StateSchemas ? CompoundSnapshot<
          Path,
          NodeSchema<States[StateId]>["Type"],
          SnapshotWithPrefix<Children, Path>
        >
      : AtomicSnapshot<Path, NodeSchema<States[StateId]>["Type"]>
    : AtomicSnapshot<Path, NodeSchema<States[StateId]>["Type"]>

  /**
   * Extracts a complete root snapshot whose selected configuration contains a
   * particular active state.
   *
   * Parallel ancestors still require every region, while compound ancestors
   * are narrowed to the branch leading to `Owner`.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type CompleteSnapshotContaining<
    States extends StateSchemas,
    Owner extends StateIdentifier<States>
  > = HistorySnapshotWithPrefix<States, Owner, "">

  /**
   * Extracts the union of statechart snapshots represented by a state
   * definition.
   *
   * @category models
   * @since 4.0.0
   */
  export type Snapshot<States extends StateSchemas> = {
    readonly [StateId in ActiveStateKey<States>]: SnapshotByIdentifier<States, StateId & StateIdentifier<States>>
  }[ActiveStateKey<States>]

  /**
   * Extracts the root state identifier from a state path.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type RootStateIdentifier<StateId extends string> = StateId extends `${infer Root}.${string}` ? Root : StateId

  /**
   * Extracts the public snapshot shape that contains a final state path.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type SnapshotContainingFinal<
    States extends StateSchemas,
    FinalStates extends StateIdentifier<States>
  > = FinalStates extends StateIdentifier<States>
    ? RootStateIdentifier<FinalStates> extends infer Root extends StateIdentifier<States> ? SnapshotByIdentifier<
        States,
        Root
      >
    : never
    : never

  /**
   * Extracts state identifiers whose state-tree definition marks them final.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type FinalStateFromDefinition<States extends StateSchemas> =
    & {
      readonly [StateId in StateIdentifier<States>]: NodeByIdentifier<States, StateId> extends
        { readonly type: "final" } ? StateId
        : never
    }[StateIdentifier<States>]
    & StateIdentifier<States>

  /**
   * Extracts an event value from an event schema list by tag.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type EventByTag<
    Events extends ReadonlyArray<TaggedSchema>,
    Tag extends TagOf<Events[number]>
  > =
    | Extract<EventOf<Events>, { readonly _tag: Tag }>
    | (EventOf<Events> extends infer Event ? Event extends {
        readonly _tag: infer EventTag extends PropertyKey
      } ? [EventTag] extends [Tag] ? never
        : [Tag] extends [EventTag] ? Omit<Event, "_tag"> & { readonly _tag: Tag }
        : never
      : never
      : never)

  /**
   * Opaque state construction returned by a builder's `.from` method.
   *
   * The machine resolves the instruction through the selected state schema
   * while planning. Its decoded value is intentionally unavailable until
   * planning succeeds.
   *
   * @category models
   * @since 4.0.0
   */
  export interface StateConstruction<Result> {
    readonly [Model.StateConstructionTypeId]: Result
  }

  /**
   * Machine-bound target instruction accepted from transition handlers.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Target<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > {
    readonly [Model.TargetTypeId]: typeof Model.TargetTypeId
    readonly [Model.TargetSnapshotTypeId]?: SnapshotByIdentifier<States, StateId>
    readonly path: StateId
    readonly value: StateByIdentifier<States, StateId>
    readonly values?: Partial<
      {
        readonly [AncestorStateId in StateIdentifier<States>]: StateByIdentifier<States, AncestorStateId>
      }
    >
  }

  /**
   * Transition instruction that restores a history pseudo-state's parent.
   *
   * Unlike ordinary targets, history targets carry no state value. The
   * planner resolves the remembered concrete configuration, or evaluates the
   * history node's typed default when no record exists.
   *
   * @category models
   * @since 4.0.0
   */
  export interface HistoryTarget<
    States extends StateSchemas,
    HistoryId extends HistoryIdentifier<States>
  > {
    readonly [Model.HistoryTargetTypeId]: typeof Model.HistoryTargetTypeId
    readonly path: HistoryId
    readonly parent: Extract<ParentPath<HistoryId>, StateIdentifier<States>>
  }

  /** Branded transient target instruction used while constructing initial states. */
  export interface ChoiceTargetInstruction<ChoiceId extends string = string> {
    readonly [Model.ChoiceTargetTypeId]: typeof Model.ChoiceTargetTypeId
    readonly path: ChoiceId
    readonly parent: ParentPath<ChoiceId>
    readonly values?: Readonly<Record<string, unknown>>
  }

  /** Transition instruction that enters a transient choice pseudo-state. */
  export interface ChoiceTarget<
    States extends StateSchemas,
    ChoiceId extends ChoiceIdentifier<States>
  > extends ChoiceTargetInstruction<ChoiceId> {
    readonly parent: Extract<ParentPath<ChoiceId>, StateIdentifier<States>>
  }

  /** Builder containing only history pseudo-state paths. */
  export type HistoryTargetBuilder<States extends StateSchemas> = HistoryTargetBuilderWithPrefix<States, States, "">

  /**
   * Builder for complete transition snapshots.
   *
   * **When to use**
   *
   * Use when a transition enters an inactive root or otherwise needs to provide
   * every active child below the selected root.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type FullTargetBuilder<States extends StateSchemas> = FullSnapshotBuilderWithPrefix<States>

  /**
   * Builder for a complete fallback configuration containing a history owner.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type HistoryDefaultTargetBuilder<
    States extends StateSchemas,
    Owner extends StateIdentifier<States>
  > = HistorySnapshotBuilderWithPrefix<States, Owner>

  /**
   * Builder for source-local transition targets.
   *
   * **When to use**
   *
   * Use when a transition stays inside the nearest active compound ancestor of
   * the source state and should preserve active ancestor and sibling values.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type LocalTargetBuilder<
    States extends StateSchemas,
    Source extends StateNodeIdentifier<States>
  > = NearestCompoundScope<States, Source> extends infer Scope ? [Scope] extends [never] ? {}
    : Scope extends StateIdentifier<States> ? LocalTargetBuilderForScope<States, Scope, Source>
    : {}
    : {}

  /**
   * Builder for partial transition targets within the active source root.
   *
   * **When to use**
   *
   * Use when a transition should replace one descendant of the active source
   * root while preserving unmentioned active ancestors or parallel regions.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type BranchTargetBuilder<
    States extends StateSchemas,
    Source extends StateNodeIdentifier<States>
  > = BranchTargetBuilderForRoot<
    States,
    Extract<RootStateIdentifier<Source>, ActiveStateKey<States>>,
    Source
  >

  /**
   * Machine-bound target builders available in transition contexts.
   *
   * **Details**
   *
   * `local` targets the nearest compound scope for the source state, `branch`
   * targets descendants of the source root, and `full` builds complete
   * snapshots for any root.
   *
   * These builders control how the next active configuration is assembled; they
   * do not directly control state re-entry. Exit and entry paths are derived
   * from the previous and next active paths. Shared active ancestors remain
   * entered even when a `full` target supplies their values again. Use an event
   * transition with `reenter: true` when the source should explicitly exit and
   * enter again.
   *
   * @category models
   * @since 4.0.0
   */
  export interface TargetBuilder<
    States extends StateSchemas,
    Source extends StateNodeIdentifier<States>
  > {
    /**
     * Moves to another state in the same local group. The value of the state
     * containing that group, and values in other active branches, are kept.
     *
     * @since 4.0.0
     */
    readonly local: LocalTargetBuilder<States, Source>

    /**
     * Moves to a state elsewhere under the current top-level state. Parent
     * values change only when their builder methods are explicitly called;
     * other active branches are kept.
     *
     * @since 4.0.0
     */
    readonly branch: BranchTargetBuilder<States, Source>

    /**
     * Moves to any top-level state by building its complete active state
     * configuration.
     *
     * **Details**
     *
     * When the target contains nested states, an active child must be selected.
     * When it contains parallel states, an active state must be provided for
     * every region.
     *
     * @since 4.0.0
     */
    readonly full: FullTargetBuilder<States>

    /** Restores a declared shallow or deep history pseudo-state. */
    readonly history: HistoryTargetBuilder<States>
  }

  /**
   * Context passed to a state/event handler.
   *
   * @category models
   * @since 4.0.0
   */
  export interface HandlerContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    EventTag extends TagOf<Events[number]>,
    E,
    R
  > {
    readonly state: StateByIdentifier<States, StateId>
    readonly parent: ParentStateValue<States, StateId>
    readonly parents: ParentStateValues<States, StateId>
    /** Complete logical configuration captured at the start of this microstep. */
    readonly snapshot: Snapshot<States>
    readonly event: EventByTag<Events, EventTag>

    /**
     * Provides typed builders for choosing the next active state from this
     * handler. Each builder documents which existing state values it keeps.
     *
     * @since 4.0.0
     */
    readonly target: TargetBuilder<States, StateId>
  }

  /**
   * Context passed to an entry or exit state handler.
   *
   * @category models
   * @since 4.0.0
   */
  export interface StateActionContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > {
    readonly state: StateByIdentifier<States, StateId>
    readonly parent: ParentStateValue<States, StateId>
    readonly parents: ParentStateValues<States, StateId>
    readonly event: LifecycleEvent<Events>
  }

  /**
   * Context passed to an invoked child process source.
   *
   * @category models
   * @since 4.0.0
   */
  export interface InvokeContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > {
    readonly state: StateByIdentifier<States, StateId>
    readonly parent: ParentStateValue<States, StateId>
    readonly parents: ParentStateValues<States, StateId>
    readonly event: LifecycleEvent<Events>
  }

  /**
   * Context passed to an invoked child process active snapshot mapper.
   *
   * @category models
   * @since 4.0.0
   */
  export interface InvokeSnapshotContext<State, Error, Output> {
    readonly id: string
    readonly snapshot: Extract<RuntimeSnapshot<State, Error, Output>, { readonly status: "active" }>
  }

  /**
   * Context passed to an invoked machine terminal output mapper.
   *
   * @category models
   * @since 4.0.0
   */
  export interface InvokeDoneContext<Output> {
    readonly id: string
    readonly output: Output
  }

  /**
   * Context passed to an eventless transition handler.
   *
   * @category models
   * @since 4.0.0
   */
  export interface AlwaysContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > {
    readonly state: StateByIdentifier<States, StateId>
    readonly parent: ParentStateValue<States, StateId>
    readonly parents: ParentStateValues<States, StateId>
    /** Complete logical configuration captured at the start of this microstep. */
    readonly snapshot: Snapshot<States>
    readonly event: LifecycleEvent<Events>

    /**
     * Provides typed builders for choosing the next active state from this
     * eventless handler. Each builder documents which existing state values it
     * keeps.
     *
     * @since 4.0.0
     */
    readonly target: TargetBuilder<States, StateId>
  }

  /**
   * Context passed to a state completion transition handler.
   *
   * @category models
   * @since 4.0.0
   */
  export interface DoneContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > {
    readonly state: StateByIdentifier<States, StateId>
    readonly parent: ParentStateValue<States, StateId>
    readonly parents: ParentStateValues<States, StateId>
    /** Complete logical configuration captured at the start of this microstep. */
    readonly snapshot: Snapshot<States>
    readonly event: LifecycleEvent<Events>
    readonly output: CompletionOutputByIdentifier<States, StateId>

    /**
     * Provides typed builders for choosing the next active state after this
     * state completes. Each builder documents which existing state values it
     * keeps.
     *
     * @since 4.0.0
     */
    readonly target: TargetBuilder<States, StateId>
  }

  /** Context passed to a transient choice resolver. There is no `state` value. */
  export interface ChoiceContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    ChoiceId extends ChoiceIdentifier<States>
  > {
    readonly parent: StateByIdentifier<
      States,
      Extract<ImmediateParentStateIdentifier<ChoiceId>, StateIdentifier<States>>
    >
    readonly parents: {
      readonly [Parent in Extract<ParentStateIdentifier<ChoiceId>, StateIdentifier<States>>]: StateByIdentifier<
        States,
        Parent
      >
    }
    readonly event: LifecycleEvent<Events>
    readonly target: TargetBuilder<States, ChoiceId>
  }

  /**
   * Context passed to a final state output function.
   *
   * @category models
   * @since 4.0.0
   */
  export interface FinalOutputContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > {
    readonly state: StateByIdentifier<States, StateId>
    readonly parent: ParentStateValue<States, StateId>
    readonly parents: ParentStateValues<States, StateId>
    readonly event: LifecycleEvent<Events>
  }

  /**
   * Extracts region outputs for a completed parallel state.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type ParallelOutputRegions<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeByIdentifier<States, StateId> extends
    { readonly type: "parallel"; readonly states: infer Children extends StateSchemas } ? {
      readonly [Key in ActiveStateKey<Children>]: CompletionOutputByIdentifier<
        States,
        Extract<JoinPath<StateId, Key>, StateIdentifier<States>>
      >
    }
    : never

  /**
   * Context passed to a parallel state output function.
   *
   * @category models
   * @since 4.0.0
   */
  export interface ParallelOutputContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > {
    readonly state: StateByIdentifier<States, StateId>
    readonly parent: ParentStateValue<States, StateId>
    readonly parents: ParentStateValues<States, StateId>
    readonly event: LifecycleEvent<Events>
    readonly outputs: ParallelOutputRegions<States, StateId>
  }

  /**
   * Return value accepted from entry and exit state actions.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type StateActionResult<E, R> = undefined

  /**
   * Return value accepted from a machine initial state function.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InitialResult<States extends StateSchemas, E, R> =
    | Snapshot<States>
    | InitialSnapshot<States>
    | StateConstruction<Snapshot<States> | InitialSnapshot<States>>

  /** Initial snapshots may transiently terminate in a declared choice node. */
  export type InitialSnapshot<States extends StateSchemas> = {
    readonly [StateId in ActiveStateKey<States>]: InitialSnapshotResult<States, StateId, "">
  }[ActiveStateKey<States>]

  /**
   * Return value accepted from transition handlers.
   *
   * **Details**
   *
   * Handlers return snapshots for complete state replacement or target builder
   * results for path-safe partial transitions. Raw decoded state values are not
   * accepted at transition boundaries.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type HandlerResult<States extends StateSchemas, E, R> =
    | Snapshot<States>
    | Target<States, StateIdentifier<States>>
    | HistoryTarget<States, HistoryIdentifier<States>>
    | ChoiceTarget<States, ChoiceIdentifier<States>>
    | StateConstruction<
      | Snapshot<States>
      | Target<States, StateIdentifier<States>>
      | HistoryTarget<States, HistoryIdentifier<States>>
      | ChoiceTarget<States, ChoiceIdentifier<States>>
    >
    | void

  /** A choice resolver must always select a typed target synchronously. */
  export type ChoiceResult<States extends StateSchemas, E, R> =
    | Snapshot<States>
    | Target<States, StateIdentifier<States>>
    | HistoryTarget<States, HistoryIdentifier<States>>
    | ChoiceTarget<States, ChoiceIdentifier<States>>
    | StateConstruction<
      | Snapshot<States>
      | Target<States, StateIdentifier<States>>
      | HistoryTarget<States, HistoryIdentifier<States>>
      | ChoiceTarget<States, ChoiceIdentifier<States>>
    >

  /**
   * Extracts the union of handler return values from a handler map.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type HandlerEffect<Handlers> = Handlers[keyof Handlers]
  /**
   * Extracts the error type from a handler return value.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type HandlerError<Handlers> = Effect.Error<HandlerEffect<Handlers>>
  /**
   * Extracts the service requirements from a handler return value.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type HandlerServices<Handlers> = Effect.Services<HandlerEffect<Handlers>>
  /**
   * Extracts the return value from an initial state function.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InitialReturn<Initial> = Initial extends (...args: any) => infer Ret ? Ret : never
  /**
   * Extracts the return value from an entry or exit action.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type StateActionReturn<Config, Key extends "entry" | "exit"> = Key extends keyof Config
    ? NonNullable<Config[Key]> extends (...args: any) => infer Ret ? Ret : never
    : never
  /** Extracts the return value from an implicit initial child implementation. */
  export type StateInitialReturn<Config> = Config extends { readonly initial?: infer Initial }
    ? NonNullable<Initial> extends (...args: any) => infer Ret ? Ret : never
    : never
  /** Extracts the return values from a state's history defaults. */
  export type HistoryDefaultReturn<Config> = Config extends { readonly history?: infer History } ? {
      readonly [Key in keyof NonNullable<History>]: NonNullable<History>[Key] extends {
        readonly default: (...args: any) => infer Ret
      } ? Ret :
        never
    }[keyof NonNullable<History>]
    : never
  /** Extracts the return value from a choice resolver. */
  export type ChoiceReturn<Config> = Config extends {
    readonly choice: { readonly transition: (...args: any) => infer Ret }
  } ? Ret :
    never
  /**
   * Extracts the return value from an event transition config.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type EventTransitionReturn<Transition> = Transition extends (...args: any) => infer Ret ? Ret
    : Transition extends { readonly transition: (...args: any) => infer Ret } ? Ret
    : never
  /**
   * Extracts the return value from a state's event handlers.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type EventHandlerReturn<Config> = Config extends { readonly on?: infer On }
    ? { readonly [EventTag in keyof On]: EventTransitionReturn<NonNullable<On[EventTag]>> }[
      keyof On
    ]
    : never
  /**
   * Extracts the invoke config or configs from a state config.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InvokeReturn<Config> = "invoke" extends keyof Config
    ? Config extends { readonly invoke?: infer Invoke }
      ? NonNullable<Invoke> extends (...args: any) => infer Resolved
        ? NonNullable<Resolved> extends ReadonlyArray<infer One> ? One : NonNullable<Resolved>
      : NonNullable<Invoke> extends ReadonlyArray<infer One> ? One
      : NonNullable<Invoke>
    : never
    : never
  /**
   * Extracts the child process logic returned by an invoke source.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InvokeLogic<Invoke> = Invoke extends { readonly src: (...args: any) => infer Logic } ? Logic : never
  /**
   * Extracts the startup error from an invoke source child process logic.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InvokeInitialError<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly initialError: Types.Covariant<infer InitialError> }
  } ? InitialError
    : InvokeLogic<Invoke> extends Logic<any, any, any, any, any, infer InitialError> ? InitialError
    : never
  /**
   * Extracts the runtime error from an invoked child process.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InvokeRuntimeError<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly error: Types.Covariant<infer Error> }
  } ? Error
    : InvokeLogic<Invoke> extends Logic<any, any, infer Error, any, any, any> ? Error
    : never
  /**
   * Extracts the output from an invoked child process.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InvokeOutput<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly output: Types.Covariant<infer Output> }
  } ? Output
    : InvokeLogic<Invoke> extends Logic<any, any, any, any, infer Output, any> ? Output
    : never
  /**
   * Extracts the service requirements from an invoke source child process logic.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InvokeServices<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly requirements: Types.Covariant<infer Requirements> }
  } ? Requirements
    : InvokeLogic<Invoke> extends Logic<any, any, any, infer Requirements, any, any> ? Requirements
    : never
  /**
   * Extracts events emitted directly by an invoked child.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InvokeEmits<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly emits: Types.Covariant<infer Emits> }
  } ? Emits :
    never
  /**
   * Extracts events returned by an invoked child snapshot mapper.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InvokeSnapshotEvent<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly snapshotEvent: Types.Covariant<infer Event> }
  } ? Event :
    never
  /**
   * Extracts the parent transition error contribution from invoked children.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InvokeError<Config> = [InvokeReturn<Config>] extends [never] ? never
    : ChildAlreadyExistsError | InvokeInitialError<InvokeReturn<Config>> | InvokeRuntimeError<InvokeReturn<Config>>
  /**
   * Extracts the parent service requirement contribution from invoked children.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type InvokeRequirements<Config> = [InvokeReturn<Config>] extends [never] ? never
    : MachineRuntimeRequirement | InvokeServices<InvokeReturn<Config>>
  /**
   * Extracts the return value from an eventless transition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type AlwaysReturn<Config> = Config extends { readonly always?: infer Always }
    ? EventTransitionReturn<NonNullable<Always>>
    : never
  /**
   * Extracts the return value from a state completion transition.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type DoneReturn<Config> = Config extends { readonly onDone?: infer OnDone }
    ? EventTransitionReturn<NonNullable<OnDone>>
    : never
  /**
   * Extracts the return value from a final state output function.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type FinalOutputReturn<Config> = Config extends { readonly output?: infer Output }
    ? NonNullable<Output> extends (...args: any) => infer Ret ? Ret : never
    : never

  /**
   * Extracts all service requirements contributed by a state handler config.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type ConfigServices<Config> =
    | Effect.Services<EventHandlerReturn<Config>>
    | Effect.Services<AlwaysReturn<Config>>
    | Effect.Services<DoneReturn<Config>>
    | Effect.Services<StateActionReturn<Config, "entry">>
    | Effect.Services<StateActionReturn<Config, "exit">>
    | Effect.Services<StateInitialReturn<Config>>
    | Effect.Services<HistoryDefaultReturn<Config>>
    | Effect.Services<ChoiceReturn<Config>>
    | InvokeRequirements<Config>

  /**
   * Configuration for invoking a child process while a state is active.
   *
   * @category models
   * @since 4.0.0
   */
  export interface InvokeConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    Event,
    ChildState,
    ChildEvent,
    ChildError,
    ChildRequirements,
    ChildOutput,
    ChildInitialError,
    ChildEmits = never,
    DeliveredOutput = ChildOutput
  > {
    readonly [InvokeTypeId]: {
      readonly output: Types.Covariant<DeliveredOutput>
      readonly emits: Types.Covariant<ChildEmits>
      readonly snapshotEvent: Types.Covariant<Event>
      readonly error: Types.Covariant<ChildError>
      readonly requirements: Types.Covariant<ChildRequirements>
      readonly initialError: Types.Covariant<ChildInitialError>
    }
    /** @internal Serializable descriptor metadata used by inspection. */
    readonly [Activities.ActivityMetadataTypeId]?: Activities.StaticActivityMetadata
    readonly id: string
    /**
     * Optional parent-local address for sending events to this invocation.
     *
     * The invocation `id` is only its state-local lifecycle key. Use an
     * explicit typed address when the parent must communicate with it.
     */
    readonly address?: string
    /** @internal */
    readonly descriptor?: ChildMachine.Any
    src(): Logic<
      ChildState,
      ChildEvent,
      ChildError,
      ChildRequirements,
      ChildOutput,
      ChildInitialError
    >
    snapshot?(
      context: InvokeSnapshotContext<ChildState, ChildError, ChildOutput>
    ): Event | undefined
    onDone?(context: InvokeDoneContext<ChildOutput>): DeliveredOutput | undefined
  }

  /** @internal */
  export interface AnyInvokeConfig<
    Output = unknown,
    Error = unknown,
    Requirements = unknown,
    InitialError = unknown,
    Emits = never,
    SnapshotEvent = never
  > {
    readonly [InvokeTypeId]: {
      readonly output: Types.Covariant<Output>
      readonly emits: Types.Covariant<Emits>
      readonly snapshotEvent: Types.Covariant<SnapshotEvent>
      readonly error: Types.Covariant<Error>
      readonly requirements: Types.Covariant<Requirements>
      readonly initialError: Types.Covariant<InitialError>
    }
  }

  interface InvokeDefinitionValue {
    readonly [InvokeTypeId]: unknown
  }

  /**
   * State-bound configuration for invoked child processes.
   *
   * **Details**
   *
   * A function form receives the owning state's typed value and lifecycle
   * event before constructing one or more invoke configurations.
   *
   * @category models
   * @since 4.0.0
   */
  export type InvokeDefinition<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > =
    | InvokeDefinitionValue
    | ReadonlyArray<InvokeDefinitionValue>
    | ((context: InvokeContext<States, Events, Emits, StateId>) =>
      | InvokeDefinitionValue
      | ReadonlyArray<InvokeDefinitionValue>)

  type OutputHandlerConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    Context
  > = NodeByIdentifier<States, StateId> extends { readonly output: Schema.Top } ? {
      readonly output: (context: Context) => OutputByIdentifier<States, StateId>
    }
    : {
      readonly output?: never
    }

  type ActiveOutputHandlerConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > = NodeByIdentifier<States, StateId> extends { readonly type: "parallel" } ? OutputHandlerConfig<
      States,
      Events,
      StateId,
      ParallelOutputContext<States, Events, StateId>
    >
    : {
      readonly output?: never
    }

  /**
   * Configuration accepted for a non-final state.
   *
   * @category models
   * @since 4.0.0
   */
  export type ActiveStateConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    E,
    R
  > = {
    readonly entry?: (
      context: StateActionContext<States, Events, Emits, StateId>,
      enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
    ) => StateActionResult<any, any>
    readonly exit?: (
      context: StateActionContext<States, Events, Emits, StateId>,
      enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
    ) => StateActionResult<any, any>
    readonly invoke?: InvokeDefinition<States, Events, Emits, StateId>
    readonly always?:
      | ((
        context: AlwaysContext<States, Events, Emits, StateId>,
        enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
      ) => HandlerResult<States, any, any>)
      | {
        /** Statically declared upper bound of possible target paths. */
        readonly targets?: ReadonlyArray<StateNodeIdentifier<States>>
        readonly transition: (
          context: AlwaysContext<States, Events, Emits, StateId>,
          enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
        ) => HandlerResult<States, any, any>
      }
    readonly onDone?:
      | ((
        context: DoneContext<States, Events, Emits, StateId>,
        enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
      ) => HandlerResult<States, any, any>)
      | {
        /** Statically declared upper bound of possible target paths. */
        readonly targets?: ReadonlyArray<StateNodeIdentifier<States>>
        readonly transition: (
          context: DoneContext<States, Events, Emits, StateId>,
          enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
        ) => HandlerResult<States, any, any>
      }
    readonly on?: {
      readonly [EventTag in TagOf<Events[number]>]?:
        | ((
          context: HandlerContext<States, Events, Emits, StateId, EventTag, E, R>,
          enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
        ) => HandlerResult<States, any, any>)
        | {
          readonly reenter?: boolean
          /**
           * Upper bound of state or history paths this handler may target.
           * Returning `void` is always permitted. Declaring a parent state also
           * permits concrete descendant targets below it.
           */
          readonly targets?: ReadonlyArray<StateNodeIdentifier<States>>
          readonly transition: (
            context: HandlerContext<States, Events, Emits, StateId, EventTag, E, R>,
            enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
          ) => HandlerResult<States, any, any>
        }
    }
    readonly initial?: StateInitialHandler<States, Events, Emits, StateId>
  } & ActiveOutputHandlerConfig<States, Events, StateId>

  /** Values supplied when a statechart implicitly enters a state's initial children. */
  export type StateInitialValue<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeByIdentifier<States, StateId> extends infer Node ?
    Node extends { readonly type: "parallel"; readonly states: infer Children extends StateSchemas } ? {
        readonly [Key in ActiveStateKey<Children>]: NodeSchema<Children[Key]>["Type"]
      }
    : Node extends { readonly states: infer Children extends StateSchemas; readonly initial: infer Initial } ?
      Initial extends ActiveStateKey<Children> ? NodeSchema<Children[Initial]>["Type"] : never
    : never
    : never

  /** Context passed to an implicit child-state initializer. */
  export type StateInitialContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > = StateActionContext<States, Events, Emits, StateId>

  /** Initial child value implementation for a compound or parallel state. */
  export type StateInitialHandler<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > = (
    context: StateInitialContext<States, Events, Emits, StateId>,
    enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
  ) => StateInitialValue<States, StateId>

  /** Context used only when a history node has no previously captured record. */
  export interface HistoryDefaultContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    ParentId extends StateIdentifier<States>
  > {
    readonly event: LifecycleEvent<Events>
    readonly target: HistoryDefaultTargetBuilder<States, ParentId>
    readonly parent: ParentId
  }

  /**
   * Typed fallback evaluated when a history node has no record yet.
   *
   * The fallback constructs a complete root configuration containing the
   * history owner. This makes the default independent of the transition source
   * and provides every inactive ancestor and required parallel region.
   */
  export type HistoryDefaultHandler<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    ParentId extends StateIdentifier<States>
  > = (
    context: HistoryDefaultContext<States, Events, Emits, ParentId>,
    enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
  ) =>
    | CompleteSnapshotContaining<States, ParentId>
    | StateConstruction<CompleteSnapshotContaining<States, ParentId>>

  /** Default implementations keyed by direct history child. */
  export type HistoryDefaultConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    ParentId extends StateIdentifier<States>,
    Children extends StateSchemas
  > = {
    readonly [Key in HistoryStateKey<Children>]?: {
      readonly default: HistoryDefaultHandler<States, Events, Emits, ParentId>
    }
  }

  /** Required implementation for a choice pseudo-state. */
  export interface ChoiceStateConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    ChoiceId extends ChoiceIdentifier<States>
  > {
    readonly choice: {
      /** Statically inspectable upper bound of every possible target. */
      readonly targets: readonly [StateNodeIdentifier<States>, ...ReadonlyArray<StateNodeIdentifier<States>>]
      readonly transition: (
        context: ChoiceContext<States, Events, Emits, ChoiceId>,
        enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
      ) => ChoiceResult<States, any, any>
    }
    readonly entry?: never
    readonly exit?: never
    readonly invoke?: never
    readonly always?: never
    readonly on?: never
    readonly onDone?: never
    readonly output?: never
    readonly initial?: never
  }

  /**
   * Configuration accepted for a final state.
   *
   * @category models
   * @since 4.0.0
   */
  export type FinalStateConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > = {
    readonly entry?: (
      context: StateActionContext<States, Events, Emits, StateId>,
      enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
    ) => StateActionResult<any, any>
    readonly exit?: never
    readonly always?: never
    readonly onDone?: never
    readonly on?: never
  } & OutputHandlerConfig<States, Events, StateId, FinalOutputContext<States, Events, StateId>>

  /**
   * Configuration accepted by `handle` for a state tag.
   *
   * @category models
   * @since 4.0.0
   */
  export type HandlerConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    E,
    R
  > = NodeByIdentifier<States, StateId> extends { readonly type: "final" } ?
    FinalStateConfig<States, Events, Emits, StateId>
    : ActiveStateConfig<States, Events, Emits, StateId, E, R>

  type HandlerNodeConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Path extends StateNodeIdentifier<States>,
    E,
    R
  > = Path extends ChoiceIdentifier<States> ? ChoiceStateConfig<States, Events, Emits, Path>
    : Path extends StateIdentifier<States> ? HandlerConfig<States, Events, Emits, Path, E, R>
    : never

  type HandlerChildren<Node> = Node extends { readonly states: infer Children extends StateSchemas } ? Children : never

  type HandlerNodeId<States extends StateSchemas, Path extends string> = Extract<Path, StateNodeIdentifier<States>>

  type HandlerConfigPart<Config> = {
    readonly [Key in keyof Config as Key extends "states" ? never : Key]: Config[Key]
  }

  type HandlerNodeChildrenConfig<Config> = "states" extends keyof Config ?
    Config extends { readonly states?: infer Children } ? NonNullable<Children>
    : never
    : never

  type HandlerNodeByPath<States extends StateSchemas, Path extends string> = Path extends
    `${infer Head}.${infer Rest}` ? Head extends keyof States ? States[Head] extends {
        readonly states: infer Children extends StateSchemas
      } ? HandlerNodeByPath<Children, Rest>
      : never
    : never
    : Path extends keyof States ? States[Path]
    : never

  // Resolve only the supplied branch for a flattened state-node path. Keeping
  // this recursion on the finite path avoids recursively expanding an open
  // generic handler config.
  type HandlerConfigAtPath<Config, Path extends string> = Path extends `${infer Head}.${infer Rest}` ?
    Head extends keyof Config ? HandlerConfigAtPath<HandlerNodeChildrenConfig<Config[Head]>, Rest>
    : never
    : Path extends keyof Config ? Config[Path]
    : never

  // Rebuild the public nested handler shape so branded validation errors stay
  // attached to the exact property that introduced them.
  type HandlerValidationAtPath<Path extends string, Validation> = Path extends `${infer Head}.${infer Rest}` ? {
      readonly [Key in Head]?: {
        readonly states: HandlerValidationAtPath<Rest, Validation>
      }
    }
    : { readonly [Key in Path]?: Validation }

  type HandlerNode<
    AllStates extends StateSchemas,
    Node,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    E,
    R,
    StateId extends StateNodeIdentifier<AllStates>
  > =
    & HandlerNodeConfig<AllStates, Events, Emits, StateId, E, R>
    & (StateId extends ChoiceIdentifier<AllStates> ? {
        readonly states?: never
        readonly history?: never
      }
      : HandlerChildren<Node> extends infer Children extends StateSchemas ? [Children] extends [never] ? {
            readonly states?: never
            readonly history?: never
          }
        : {
          readonly states?: HandlerTree<
            AllStates,
            Children,
            Events,
            Emits,
            E,
            R,
            Extract<StateId, StateIdentifier<AllStates>>
          >
          readonly history?: HistoryDefaultConfig<
            AllStates,
            Events,
            Emits,
            Extract<StateId, StateIdentifier<AllStates>>,
            Children
          >
        }
      : {
        readonly states?: never
        readonly history?: never
      })

  type HandlerTree<
    AllStates extends StateSchemas,
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    E,
    R,
    Prefix extends string
  > = {
    readonly [Key in ActiveStateKey<States> | ChoiceStateKey<States>]?: HandlerNode<
      AllStates,
      States[Key],
      Events,
      Emits,
      E,
      R,
      HandlerNodeId<AllStates, JoinPath<Prefix, Key>>
    >
  }

  type HandlerNodeConfigKey =
    | "always"
    | "choice"
    | "entry"
    | "exit"
    | "history"
    | "initial"
    | "invoke"
    | "on"
    | "onDone"
    | "output"
    | "states"

  type HandlerValidationError<Message extends string, Path extends string, Detail = unknown> = {
    readonly "~effect/Machine/HandlerError": readonly [message: Message, path: Path, detail: Detail]
  }

  type NodeHasDeclaredOutput<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeByIdentifier<States, StateId> extends { readonly output: Schema.Top } ? StateId : never

  type DirectFinalOutputState<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeByIdentifier<States, StateId> extends { readonly type: "final" } ? NodeHasDeclaredOutput<States, StateId>
    : never

  type CompoundCompletionOutputStates<
    States extends StateSchemas,
    Children extends StateSchemas,
    Prefix extends StateIdentifier<States>
  > = {
    readonly [Key in Extract<keyof Children, string>]: DirectFinalOutputState<
      States,
      Extract<JoinPath<Prefix, Key>, StateIdentifier<States>>
    >
  }[Extract<keyof Children, string>]

  type RequiredCompletionOutputStates<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeByIdentifier<States, StateId> extends infer Node
    ? Node extends { readonly type: "parallel" } ? NodeHasDeclaredOutput<States, StateId>
    : Node extends { readonly states: infer Children extends StateSchemas } ? CompoundCompletionOutputStates<
        States,
        Children,
        StateId
      >
    : never
    : never

  type RequiredParallelOutputStates<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeByIdentifier<States, StateId> extends
    { readonly type: "parallel"; readonly states: infer Children extends StateSchemas } ? {
      readonly [Key in Extract<keyof Children, string>]: RequiredCompletionOutputStates<
        States,
        Extract<JoinPath<StateId, Key>, StateIdentifier<States>>
      >
    }[Extract<keyof Children, string>]
    : never

  type HandlerOutputStates<
    AllStates extends StateSchemas,
    StateId extends StateIdentifier<AllStates>,
    Config
  > = "output" extends keyof Config ? StateId : never

  type HandlerUnknownStateKeyValidation<
    States extends StateSchemas,
    Prefix extends string,
    Config,
    UnknownKeys extends string = Exclude<Extract<keyof Config, string>, Extract<keyof States, string>>
  > = [UnknownKeys] extends [never] ? unknown : {
    readonly [Key in UnknownKeys]: HandlerValidationError<
      "Handler tree contains a state key that does not exist",
      JoinPath<Prefix, Key>,
      Key
    >
  }

  type HandlerUnknownConfigKeyValidation<
    StateId extends string,
    Config,
    UnknownKeys extends string = Exclude<Extract<keyof Config, string>, HandlerNodeConfigKey>
  > = [UnknownKeys] extends [never] ? unknown : {
    readonly [Key in UnknownKeys]: HandlerValidationError<
      "Handler config contains an unknown key",
      StateId,
      Key
    >
  }

  type HandlerOnKeyValidation<
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends string,
    Config,
    On = Config extends { readonly on?: infer Current } ? NonNullable<Current> : never,
    UnknownKeys extends string = Exclude<Extract<keyof On, string>, TagOf<Events[number]>>
  > = "on" extends keyof Config ? [UnknownKeys] extends [never] ? unknown
    : {
      readonly on: {
        readonly [Key in UnknownKeys]: HandlerValidationError<
          "Handler config contains an event key that does not exist",
          StateId,
          Key
        >
      }
    }
    : unknown

  type TransitionResultTargetPath<Result> = IsAny<Result> extends true ? never
    : Result extends Effect.Effect<infer Success, any, any> ? TransitionResultTargetPath<Success>
    : Result extends StateConstruction<infer Constructed> ? TransitionResultTargetPath<Constructed>
    : Result extends { readonly path: infer Path extends string } ? Path
    : never

  type DeclaredTransitionTarget<Transition> = Transition extends {
    readonly targets: infer Targets extends ReadonlyArray<string>
  } ? Targets[number]
    : never

  type ExcludeDeclaredTransitionTarget<Returned, Declared extends string> = Returned extends string ?
    Returned extends Declared | `${Declared}.${string}` ? never : Returned
    : never

  type UndeclaredTransitionTarget<Transition> = "targets" extends keyof Transition ? ExcludeDeclaredTransitionTarget<
      TransitionResultTargetPath<EventTransitionReturn<Transition>>,
      DeclaredTransitionTarget<Transition>
    >
    : never

  type HandlerOnTargetValidationErrors<StateId extends string, On> = {
    readonly [
      EventTag in keyof On as [UndeclaredTransitionTarget<On[EventTag]>] extends [never] ? never
        : EventTag
    ]: HandlerValidationError<
      "Transition returns a target not listed in targets",
      StateId,
      readonly [event: EventTag, target: UndeclaredTransitionTarget<On[EventTag]>]
    >
  }

  type HandlerOnTargetValidation<StateId extends string, Config> = "on" extends keyof Config ?
    Config extends { readonly on?: infer On } ? HandlerOnTargetValidationErrors<
        StateId,
        NonNullable<On>
      > extends infer Errors ? keyof Errors extends never ? unknown
        : { readonly on: Errors }
      : never
    : unknown
    : unknown

  type HandlerDirectTargetValidation<
    StateId extends string,
    Config,
    Trigger extends "always" | "onDone",
    Transition = Config extends { readonly [Key in Trigger]?: infer Value } ? NonNullable<Value> : never,
    Undeclared extends string = UndeclaredTransitionTarget<Transition>
  > = Trigger extends keyof Config ? [Undeclared] extends [never] ? unknown
    : {
      readonly [Key in Trigger]: HandlerValidationError<
        "Transition returns a target not listed in targets",
        StateId,
        readonly [trigger: Trigger, target: Undeclared]
      >
    }
    : unknown

  type HandlerChildrenValidation<
    Node,
    Prefix extends string,
    Config
  > = "states" extends keyof Config ?
    Config extends { readonly states?: infer ChildrenConfig } ?
      HandlerChildren<Node> extends infer Children extends StateSchemas ? [Children] extends [never] ? {
            readonly states: HandlerValidationError<
              "Handler config contains child states for a state that has no children",
              Prefix
            >
          }
        : HandlerUnknownStateKeyValidation<Children, Prefix, NonNullable<ChildrenConfig>> extends infer Validation ?
          unknown extends Validation ? unknown
          : { readonly states: Validation }
        : never
      : never
    : {
      readonly states: HandlerValidationError<
        "Handler config contains child states for a state that has no children",
        Prefix
      >
    }
    : unknown

  type HandlerOutputRequirementValidation<
    AllStates extends StateSchemas,
    StateId extends StateIdentifier<AllStates>,
    AvailableOutputStates extends StateIdentifier<AllStates>,
    Config
  > =
    & ("onDone" extends keyof Config ? [
        Exclude<RequiredCompletionOutputStates<AllStates, StateId>, AvailableOutputStates>
      ] extends [never] ? unknown
      : {
        readonly onDone: HandlerValidationError<
          "Handler config is missing an output implementation required by onDone",
          StateId,
          Exclude<RequiredCompletionOutputStates<AllStates, StateId>, AvailableOutputStates>
        >
      }
      : unknown)
    & ("output" extends keyof Config ? NodeByIdentifier<AllStates, StateId> extends { readonly type: "parallel" } ? [
          Exclude<RequiredParallelOutputStates<AllStates, StateId>, AvailableOutputStates>
        ] extends [never] ? unknown
        : {
          readonly output: HandlerValidationError<
            "Handler config is missing a region output implementation required by parallel output",
            StateId,
            Exclude<RequiredParallelOutputStates<AllStates, StateId>, AvailableOutputStates>
          >
        }
      : unknown
      : unknown)

  type HandlerNodeValidation<
    AllStates extends StateSchemas,
    Node,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<AllStates>,
    Config,
    AvailableOutputStates extends StateIdentifier<AllStates>
  > = StateId extends ChoiceIdentifier<AllStates> ?
      & HandlerChoiceUnknownConfigKeyValidation<StateId, Config>
      & HandlerChoiceTargetValidation<StateId, Config>
      & HandlerRuntimeValidation<Events, Emits, StateId, Config>
    : StateId extends StateIdentifier<AllStates> ?
        & HandlerUnknownConfigKeyValidation<StateId, Config>
        & HandlerOnKeyValidation<Events, StateId, Config>
        & HandlerOnTargetValidation<StateId, Config>
        & HandlerDirectTargetValidation<StateId, Config, "always">
        & HandlerDirectTargetValidation<StateId, Config, "onDone">
        & HandlerInvokeOutputValidation<Events, StateId, Config>
        & HandlerInvokeEmitsValidation<Events, StateId, Config>
        & HandlerInvokeSnapshotValidation<Events, StateId, Config>
        & HandlerChildrenValidation<Node, StateId, Config>
        & HandlerOutputRequirementValidation<AllStates, StateId, AvailableOutputStates, Config>
        & HandlerRuntimeValidation<Events, Emits, StateId, Config>
    : unknown

  type HandlerChoiceUnknownConfigKeyValidation<
    StateId extends string,
    Config,
    UnknownKeys extends string = Exclude<Extract<keyof Config, string>, "choice">
  > = [UnknownKeys] extends [never] ? unknown : {
    readonly [Key in UnknownKeys]: HandlerValidationError<
      "Choice handler config contains an invalid key",
      StateId,
      Key
    >
  }

  type HandlerChoiceTargetValidation<StateId extends string, Config> = Config extends {
    readonly choice: infer Choice
  } ? [UndeclaredTransitionTarget<Choice>] extends [never] ? unknown : {
      readonly choice: HandlerValidationError<
        "Choice resolver returns a target not listed in targets",
        StateId,
        UndeclaredTransitionTarget<Choice>
      >
    }
    : unknown

  type HandlerInvokeOutputValidation<
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends string,
    Config
  > = [InvokeReturn<Config>] extends [never] ? unknown
    : [Exclude<InvokeOutput<InvokeReturn<Config>>, EventOf<Events> | void>] extends [never] ? unknown
    : {
      readonly invoke: HandlerValidationError<
        "Invoked child output must be a machine event or void",
        StateId,
        Exclude<InvokeOutput<InvokeReturn<Config>>, EventOf<Events> | void>
      >
    }

  type HandlerInvokeEmitsValidation<
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends string,
    Config
  > = [InvokeReturn<Config>] extends [never] ? unknown
    : [Exclude<InvokeEmits<InvokeReturn<Config>>, EventOf<Events>>] extends [never] ? unknown
    : {
      readonly invoke: HandlerValidationError<
        "Invoked child emits events not accepted by the parent machine",
        StateId,
        Exclude<InvokeEmits<InvokeReturn<Config>>, EventOf<Events>>
      >
    }

  type HandlerInvokeSnapshotValidation<
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends string,
    Config
  > = [InvokeReturn<Config>] extends [never] ? unknown
    : IsAny<InvokeSnapshotEvent<InvokeReturn<Config>>> extends true ? unknown
    : [Exclude<InvokeSnapshotEvent<InvokeReturn<Config>>, EventOf<Events> | undefined>] extends [never] ? unknown
    : {
      readonly invoke: HandlerValidationError<
        "Invoked child snapshot mapper must return a machine event or undefined",
        StateId,
        Exclude<InvokeSnapshotEvent<InvokeReturn<Config>>, EventOf<Events> | undefined>
      >
    }

  type HandlerRuntimeValidation<
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends string,
    Config,
    Incompatible = IncompatibleRuntime<
      ConfigServices<HandlerConfigPart<Config>>,
      EventOf<Events>,
      EmitOf<Emits>
    >
  > = [Incompatible] extends [never] ? unknown
    : HandlerValidationError<"Handler config requires an incompatible machine runtime", StateId, Incompatible>

  type HandlerNodeValidationAtPath<
    AllStates extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Config,
    AvailableOutputStates extends StateIdentifier<AllStates>,
    StateId extends StateNodeIdentifier<AllStates>,
    NodeConfig = HandlerConfigAtPath<Config, StateId>
  > = [NodeConfig] extends [never] ? never
    : HandlerNodeValidation<
      AllStates,
      HandlerNodeByPath<AllStates, StateId>,
      Events,
      Emits,
      StateId,
      NodeConfig,
      AvailableOutputStates
    > extends infer Validation ? unknown extends Validation ? never
      : HandlerValidationAtPath<StateId, Validation>
    : never

  type HandlerTreeNodeValidations<
    AllStates extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Config,
    AvailableOutputStates extends StateIdentifier<AllStates>
  > = Types.UnionToIntersection<
    StateNodeIdentifier<AllStates> extends infer StateId extends StateNodeIdentifier<AllStates> ?
      StateId extends StateNodeIdentifier<AllStates> ? HandlerNodeValidationAtPath<
          AllStates,
          Events,
          Emits,
          Config,
          AvailableOutputStates,
          StateId
        >
      : never
      : never
  >

  type HandlerTreeValidation<
    AllStates extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Config,
    AvailableOutputStates extends StateIdentifier<AllStates>
  > =
    & HandlerUnknownStateKeyValidation<AllStates, "", Config>
    & HandlerTreeNodeValidations<AllStates, Events, Emits, Config, AvailableOutputStates>

  type HandlerHasRequiredInitial<
    AllStates extends StateSchemas,
    StateId extends StateIdentifier<AllStates>,
    Config
  > = StateId extends RequiredHistoryInitializers<AllStates> ? "initial" extends keyof Config ? true : false : true

  type HandlerHasRequiredHistoryDefaults<Node, Config> = Node extends {
    readonly states: infer Children extends StateSchemas
  } ? [HistoryStateKey<Children>] extends [never] ? true
    : Config extends { readonly history?: infer HistoryConfig } ? [
        Exclude<HistoryStateKey<Children>, Extract<keyof NonNullable<HistoryConfig>, string>>
      ] extends [never] ? true
      : false
    : false
    : true

  type HandlerHasRequiredChoices<Node, Config> = Node extends {
    readonly states: infer Children extends StateSchemas
  } ? [ChoiceStateKey<Children>] extends [never] ? true
    : Config extends { readonly states?: infer ChildrenConfig } ? [
        Exclude<ChoiceStateKey<Children>, Extract<keyof NonNullable<ChildrenConfig>, string>>
      ] extends [never] ? true
      : false
    : false
    : true

  type HandlerImplementedStateId<
    AllStates extends StateSchemas,
    Node,
    StateId extends StateIdentifier<AllStates>,
    Config
  > = [HistoryIdentifier<AllStates> | ChoiceIdentifier<AllStates>] extends [never] ? StateId
    : HandlerHasRequiredInitial<AllStates, StateId, Config> extends true ?
      HandlerHasRequiredHistoryDefaults<Node, Config> extends true ?
        HandlerHasRequiredChoices<Node, Config> extends true ? StateId : never
      : never
    : never

  type HandlerConfigError<Config> =
    | Effect.Error<EventHandlerReturn<Config>>
    | Effect.Error<AlwaysReturn<Config>>
    | Effect.Error<DoneReturn<Config>>
    | Effect.Error<StateActionReturn<Config, "entry">>
    | Effect.Error<StateActionReturn<Config, "exit">>
    | Effect.Error<StateInitialReturn<Config>>
    | Effect.Error<HistoryDefaultReturn<Config>>
    | Effect.Error<ChoiceReturn<Config>>
    | InvokeError<Config>

  type HandlerNodeEvidence<
    AllStates extends StateSchemas,
    Config,
    StateId extends StateNodeIdentifier<AllStates>,
    NodeConfig = HandlerConfigAtPath<Config, StateId>
  > = [NodeConfig] extends [never] ? never : {
    readonly stateId: StateId extends StateIdentifier<AllStates> ? HandlerImplementedStateId<
        AllStates,
        HandlerNodeByPath<AllStates, StateId>,
        StateId,
        NodeConfig
      >
      : never
    readonly error: HandlerConfigError<HandlerConfigPart<NodeConfig>>
    readonly services: ConfigServices<HandlerConfigPart<NodeConfig>>
    readonly outputState: StateId extends StateIdentifier<AllStates> ? HandlerOutputStates<
        AllStates,
        StateId,
        HandlerConfigPart<NodeConfig>
      >
      : never
  }

  // Compute every accumulated channel from one normalized node union instead
  // of repeating recursive walks for states, errors, services, and outputs.
  type HandlerTreeEvidence<AllStates extends StateSchemas, Config> = StateNodeIdentifier<AllStates> extends
    infer StateId extends StateNodeIdentifier<AllStates> ?
    StateId extends StateNodeIdentifier<AllStates> ? HandlerNodeEvidence<AllStates, Config, StateId>
    : never
    : never

  type HandleTreeResult<
    AllStates extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Input extends Schema.Top,
    UnhandledStates extends StateIdentifier<AllStates>,
    E,
    R,
    InitialE,
    InitialR,
    FinalStates extends StateIdentifier<AllStates>,
    Output,
    OutputStates extends StateIdentifier<AllStates>,
    InputEvents extends ReadonlyArray<TaggedSchema>,
    Config
  > = Machine<
    AllStates,
    Events,
    Input,
    Exclude<UnhandledStates, HandlerTreeEvidence<AllStates, Config>["stateId"]>,
    E | HandlerTreeEvidence<AllStates, Config>["error"],
    ExcludeCompatibleRuntime<
      R | HandlerTreeEvidence<AllStates, Config>["services"],
      EventOf<Events>,
      EmitOf<Emits>
    >,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    Emits,
    OutputStates | Extract<HandlerTreeEvidence<AllStates, Config>["outputState"], StateIdentifier<AllStates>>,
    InputEvents
  >

  /**
   * Adds state handlers from a root state object.
   *
   * @category combinators
   * @since 4.0.0
   */
  export interface Handler<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Input extends Schema.Top,
    UnhandledStates extends StateIdentifier<States>,
    E,
    R,
    InitialE,
    InitialR,
    FinalStates extends StateIdentifier<States>,
    Output,
    OutputStates extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema>
  > {
    <const Config extends HandlerTree<States, States, Events, Emits, E, R, "">>(
      config:
        & Config
        & HandlerTreeValidation<
          States,
          Events,
          Emits,
          NoInfer<Config>,
          | OutputStates
          | Extract<
            HandlerTreeEvidence<States, NoInfer<Config>>["outputState"],
            StateIdentifier<States>
          >
        >
    ): HandleTreeResult<
      States,
      Events,
      Emits,
      Input,
      UnhandledStates,
      E,
      R,
      InitialE,
      InitialR,
      FinalStates,
      Output,
      OutputStates,
      InputEvents,
      Config
    >
  }

  /**
   * Any state config.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type AnyStateConfig =
    | StateConfig<any, any, any, any, any, any, any>
    | ChoiceStateConfig<any, any, any, any>

  /**
   * Runtime event-handler map stored for a single state tag.
   *
   * @category models
   * @since 4.0.0
   */
  export type EventHandlerMap<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    EventTag extends TagOf<Events[number]>,
    E,
    R
  > = Readonly<
    Record<
      PropertyKey,
      | ((
        context: HandlerContext<States, Events, Emits, StateId, EventTag, E, R>,
        enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
      ) => HandlerResult<States, E, R>)
      | {
        readonly reenter?: boolean
        /** Statically declared upper bound of possible target paths. */
        readonly targets?: ReadonlyArray<StateNodeIdentifier<States>>
        readonly transition: (
          context: HandlerContext<States, Events, Emits, StateId, EventTag, E, R>,
          enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
        ) => HandlerResult<States, E, R>
      }
    >
  >

  /**
   * Runtime state config stored for a single state tag.
   *
   * @category models
   * @since 4.0.0
   */
  export interface StateConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    EventTag extends TagOf<Events[number]>,
    E,
    R
  > {
    readonly entry?: (
      context: StateActionContext<States, Events, Emits, StateId>,
      enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
    ) => StateActionResult<E, R>
    readonly exit?: (
      context: StateActionContext<States, Events, Emits, StateId>,
      enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
    ) => StateActionResult<E, R>
    readonly invoke?: InvokeDefinition<States, Events, Emits, StateId>
    readonly always?:
      | ((
        context: AlwaysContext<States, Events, Emits, StateId>,
        enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
      ) => HandlerResult<States, E, R>)
      | {
        readonly targets?: ReadonlyArray<StateNodeIdentifier<States>>
        readonly transition: (
          context: AlwaysContext<States, Events, Emits, StateId>,
          enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
        ) => HandlerResult<States, E, R>
      }
    readonly onDone?:
      | ((
        context: DoneContext<States, Events, Emits, StateId>,
        enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
      ) => HandlerResult<States, E, R>)
      | {
        readonly targets?: ReadonlyArray<StateNodeIdentifier<States>>
        readonly transition: (
          context: DoneContext<States, Events, Emits, StateId>,
          enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
        ) => HandlerResult<States, E, R>
      }
    readonly output?:
      | ((context: FinalOutputContext<States, Events, StateId>) => unknown)
      | ((context: ParallelOutputContext<States, Events, StateId>) => unknown)
    readonly on?: EventHandlerMap<States, Events, Emits, StateId, EventTag, E, R>
  }

  /**
   * Runtime handler table stored on a machine.
   *
   * @category models
   * @since 4.0.0
   */
  export type StateConfigs<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    EventTag extends TagOf<Events[number]>,
    E,
    R
  > = Readonly<
    Record<
      PropertyKey,
      | StateConfig<States, Events, Emits, StateId, EventTag, E, R>
      | ChoiceStateConfig<States, Events, Emits, ChoiceIdentifier<States>>
    >
  >
}

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
  Model.copyProtocol(self, machine)
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
      for (const event of Reflect.ownKeys(on)) {
        validateTransitionTargets(stateNodes, path, event, (on as Record<PropertyKey, unknown>)[event])
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
      const node = Model.getStateNodeDefinition(path, states[key])
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

/**
 * Returns `true` if a value is a `Machine`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isMachine = (
  u: unknown
): u is Machine.Any => hasProperty(u, TypeId) && u[TypeId] === TypeId

/**
 * Returns `true` if a state snapshot is final for a machine.
 *
 * @category guards
 * @since 4.0.0
 */
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
  kind: FromMethodKind
): Method & { readonly from: (...args: ReadonlyArray<any>) => unknown } => {
  Object.defineProperty(method, "from", {
    value: (...args: ReadonlyArray<any>) => {
      const omitted = args.length === 0 || (kind === "nested" && args.length === 1 && typeof args[0] === "function")
      const input = omitted ? {} : args[0]
      const rest = omitted ? args : args.slice(1)
      return method(Model.makeStateInput(input), ...rest)
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
    const pseudoType = (states[key] as { readonly type?: unknown }).type
    if (pseudoType === "history") {
      continue
    }
    const path = options.prefix === "" ? key : `${options.prefix}.${key}`
    if (pseudoType === "choice") {
      builder[key] = () => Model.makeChoiceTarget(path, getParentPathRuntime(path))
      continue
    }
    const node = Model.getStateNodeDefinition(path, states[key])
    builder[key] = withFrom(
      (value: unknown, selector?: (builder: unknown) => unknown) =>
        makeSnapshotForNode(states[key], key, value, selector, options),
      node.states === undefined ? "leaf" : "nested"
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
    const pseudoType = (states[key] as { readonly type?: unknown }).type
    if (pseudoType === "history" || pseudoType === "choice") {
      continue
    }
    if (hasProperty(regions, key)) {
      continue
    }
    const path = options.prefix === "" ? key : `${options.prefix}.${key}`
    const node = Model.getStateNodeDefinition(path, states[key])
    builder[key] = withFrom((value: unknown, selector?: (builder: unknown) => unknown) => {
      const nextRegions: Record<string, unknown> = {}
      for (const regionKey of Object.keys(regions)) {
        nextRegions[regionKey] = regions[regionKey]
      }
      nextRegions[key] = makeSnapshotForNode(states[key], key, value, selector, options)
      return makeParallelSnapshotBuilder(states, options, nextRegions)
    }, node.states === undefined ? "leaf" : "nested")
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
  const node = Model.getStateNodeDefinition(path, definition)
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
    ? { [node.initial]: node.states[node.initial] }
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
    ? Model.makeTarget(path as any, value as any, { values: values as any })
    : Model.makeTarget(path as any, value as any)

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
    definition = children[key]
    path = path === "" ? key : `${path}.${key}`
    const node = Model.getStateNodeDefinition(path, definition)
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
  return Model.makeTarget(node.path as any, value as any, {
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
      builder[child.key] = () => Model.makeChoiceTarget(child.path, parent.path, values)
      continue
    }
    builder[child.key] = withFrom((value: unknown, selector?: (builder: unknown) => unknown) => {
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
          extendTargetValues(values, child.path, value),
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
        extendTargetValues(values, child.path, value),
        source
      ))
    }, child.type === "atomic" || child.type === "final" ? "leaf" : "nested")
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
  builder.with = withFrom((value: unknown, selector?: (builder: unknown) => unknown) => {
    if (selector === undefined) {
      throw new Error(`Machine expected target "${scope}" builder to provide an active child state`)
    }
    return selector(makeLocalTargetChildBuilder(states, stateNodes, scope, { [scope]: value }, source))
  }, "nested")
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
      builder[child.key] = () => Model.makeChoiceTarget(child.path, parent.path, values)
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
    return withFrom((value: unknown) => makeTargetWithValues(node.path, value, values), "leaf")
  }
  const builder = withFrom((value: unknown, selector?: (builder: unknown) => unknown) => {
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
        extendTargetValues(values, node.path, value),
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
      extendTargetValues(values, node.path, value),
      source
    )
    return selector(nextBuilder)
  }, "nested") as unknown as Record<string, unknown>
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
    const definition = states[key]
    if ((definition as { readonly type?: unknown }).type === "history") {
      const parent = getParentPathRuntime(path)
      builder[key] = () => Model.makeHistoryTarget(path, parent)
      continue
    }
    if (typeof definition === "object" && definition !== null && hasProperty(definition, "states")) {
      builder[key] = makeHistoryTargetBuilder(definition.states as Machine.StateTree, path)
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

/**
 * Defines a state tree while preserving literal state paths.
 *
 * **When to use**
 *
 * Use when you want to pass a state tree to `make` and also get typed
 * snapshot builders for initial states and tests.
 *
 * **Details**
 *
 * The returned `states` property is the same object passed to `defineStates`.
 * The returned `initial` builder creates snapshots without user-authored path
 * strings and enforces compound and parallel initial-state rules.
 *
 * **Example** (Atomic initial snapshot)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
 *
 * const States = Machine.defineStates({ idle: Idle })
 *
 * Machine.make({
 *   states: States.states,
 *   events: [],
 *   initial: () => States.initial.idle.from()
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const defineStates: DefineStates = (<const States extends Machine.StateSchemas>(
  states: States
): Machine.DefinedStates<States> => {
  StateDefinition.validateStateDefinitions(states, "Machine.defineStates")
  return {
    states: states as States,
    initial: makeSnapshotBuilder(states as States, { mode: "initial", prefix: "" }) as Machine.InitialBuilder<States>,
    get: ((snapshot, path) =>
      Model.getSnapshotByPath(snapshot, path).pipe(
        Option.map((snapshot) => snapshot.value)
      )) as Machine.DefinedStates<States>["get"],
    getWithParents: ((snapshot, path) => {
      const parents: Record<string, unknown> = {}
      return Model.getSnapshotByPath(snapshot, path, parents).pipe(
        Option.map((snapshot) => ({ value: snapshot.value, parents }))
      )
    }) as Machine.DefinedStates<States>["getWithParents"],
    getSnapshot: Model.getSnapshotByPath as unknown as Machine.DefinedStates<States>["getSnapshot"],
    matches: (snapshot, path) => Option.isSome(Model.getSnapshotByPath(snapshot, path))
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
  readonly events: InputEvents & ValidateInputEventProtocol<NoInfer<InputEvents>>
  readonly internalEvents?:
    & InternalEvents
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

/**
 * Creates a schema-first machine definition.
 *
 * **Details**
 *
 * State and event schemas provide runtime boundary validation while their
 * decoded types drive handler, state, event, target, error, and service
 * inference. State-tree validation is applied whether `states` comes from
 * `defineStates` or is passed inline. Call `handle` on the returned definition
 * to implement state behavior with ordinary TypeScript control flow.
 *
 * Schemas in `events` define the public input protocol. Schemas in
 * `internalEvents` are added to the complete handler protocol for invoke
 * results, child emissions, and other machine-local deliveries. Their tags
 * must be disjoint.
 *
 * **Example** (Typed counter machine)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * class Count extends Schema.TaggedClass<Count>("Count")("Count", {
 *   value: Schema.Number
 * }) {}
 *
 * class Increment extends Schema.TaggedClass<Increment>("Increment")("Increment", {
 *   by: Schema.Number
 * }) {}
 *
 * const States = Machine.defineStates({ Count })
 *
 * const counter = Machine.make({
 *   states: States.states,
 *   events: [Increment],
 *   initial: () => States.initial.Count(new Count({ value: 0 }))
 * }).handle({
 *   Count: {
 *     on: {
 *       Increment: ({ event, state }) =>
 *         States.initial.Count(new Count({ value: state.value + event.by }))
 *     }
 *   }
 * })
 * ```
 *
 * @see {@link defineStates} for typed initial snapshot builders.
 * @category constructors
 * @since 4.0.0
 */
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
    readonly events: InputEvents
    readonly internalEvents?: InternalEvents
    readonly emits?: Emits
    readonly input?: Input
    readonly initial: (...args: [...Machine.InputArgs<Input>]) => Machine.InitialResult<States, InitialE, InitialR>
  }
): MakeResult<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents> => {
  StateDefinition.validateStateDefinitions(config.states, "Machine.make")
  const self = Object.create(Proto)
  self.states = config.states
  self.events = config.events
  self.internalEvents = config.internalEvents ?? []
  self.emits = config.emits ?? []
  self.input = config.input
  self.id = config.id
  self.initial = config.initial
  self.stateNodes = Model.compileStateNodes(config.states)
  self.makeTargetBuilder = makeTargetBuilder(config.states, self.stateNodes)
  self.handlers = Object.create(null)
  self.handle = makeHandle(self)
  Model.setProtocol(self)
  return self
}) as Make

type EventConstructorArgs<EventSchema extends Machine.TaggedSchema> = {} extends EventSchema["~type.make.in"] ?
  [input?: EventSchema["~type.make.in"]]
  : [input: EventSchema["~type.make.in"]]

/**
 * Constructs an event from a schema owned by a machine's protocol.
 *
 * **Details**
 *
 * The schema constructor runs exactly once. The resulting decoded event is
 * trusted by this machine and definitions derived from it with `handle`, so
 * repeated delivery does not decode the same already-constructed value again.
 * Events supplied through ordinary `send` and `plan` calls remain untrusted
 * and continue through full runtime schema validation.
 * Treat the returned event as immutable after construction.
 *
 * The schema must be one of the machine's configured public or internal event
 * schemas, or a case schema belonging to a configured `Schema.TaggedUnion`.
 *
 * **Example**
 *
 * ```ts
 * const increment = Machine.event(counter, Increment, { by: 1 })
 * yield* ref.send(increment)
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const event = <
  const M extends Machine.Any,
  const EventSchema extends Machine.TaggedSchema
>(
  machine: M,
  schema: EventSchema & ([EventSchema["Type"]] extends [Machine.Event<M>] ? unknown : never),
  ...args: EventConstructorArgs<EventSchema>
): EventSchema["Type"] => Model.makeEvent(machine, schema, args.length === 0 ? {} : args[0])

/**
 * Encodes a decoded machine snapshot into a normalized data representation.
 *
 * **When to use**
 *
 * Use when you need to store or transport a statechart snapshot independently
 * of its local machine runtime.
 *
 * **Details**
 *
 * Each active state value and completed output is encoded with the schema
 * declared for its state path. The result contains no process-local runtime
 * state.
 *
 * **Gotchas**
 *
 * The encoded snapshot does not contain the machine definition, machine
 * version, running children, invoked process state, services, or subscriptions.
 * Store machine identity and migration metadata alongside the result when the
 * snapshot crosses deployment versions. Schema encoding does not by itself
 * guarantee JSON-compatible values; schemas used with JSON-backed storage must
 * have JSON-compatible encoded representations.
 *
 * @see {@link decodeSnapshot} for restoring an encoded snapshot.
 * @category encoding
 * @since 4.0.0
 */
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
> = Model.encodeSnapshot as any

/**
 * Decodes a normalized data representation into a validated machine snapshot.
 *
 * **When to use**
 *
 * Use when you need to resume planning from a snapshot loaded from storage or
 * received over a transport boundary.
 *
 * **Details**
 *
 * Decoding resolves every path against the supplied machine, decodes values
 * with their state and output schemas, validates compound and parallel state
 * relationships, and rebuilds the recursive in-memory snapshot.
 *
 * **Gotchas**
 *
 * Decoding restores logical statechart data only. It does not restart invoked
 * processes, recreate spawned children, or restore a previous `MachineRef`.
 *
 * @see {@link encodeSnapshot} for creating the normalized representation.
 * @category decoding
 * @since 4.0.0
 */
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
> = Model.decodeSnapshot as any

/**
 * Creates an invoked child process configuration for an active state.
 *
 * **When to use**
 *
 * Use to run a child process while a machine remains in a state. Successful
 * outputs are sent directly to the parent machine as events; `void` sends
 * nothing. Unrecovered child failures fail the owning machine. Active
 * snapshots can optionally be mapped to progress events.
 *
 * **Gotchas**
 *
 * Invoked child processes run while their owning state is active and are
 * stopped before the state exits. An unrecovered child failure fails the owning
 * machine; recover inside the child Effect when failure should become an event.
 * The `id` is a state-local lifecycle key, not a communication address. To
 * send events to the invocation, pass a typed `childAddress` as `address`.
 * The `src` callback is intentionally independent from its parent state. When
 * construction depends on the typed state, lifecycle event, or runtime, use
 * the state config factory form `invoke: (context) => Machine.invoke(...)` and
 * close over that context from `src`.
 *
 * **Example** (Effect output as a parent event)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * class Loaded extends Schema.TaggedClass<Loaded>("Loaded")("Loaded", {
 *   value: Schema.String
 * }) {}
 *
 * const load = Machine.invoke({
 *   id: "load",
 *   src: () => Machine.effect(Effect.succeed(new Loaded({ value: "ready" })))
 * })
 * ```
 *
 * @see {@link effect} for one-shot child effects.
 * @see {@link spawn} for children whose lifetime is controlled by actions.
 * @category constructors
 * @since 4.0.0
 */
export const invoke = <
  ChildState,
  ChildEvent,
  ChildError = never,
  ChildRequirements = never,
  ChildOutput = never,
  ChildInitialError = never,
  Event = never,
  Address extends ChildAddress<never> | undefined = undefined
>(
  config:
    & {
      readonly id: InvokeLifecycleId
      readonly src: () => Logic<
        ChildState,
        ChildEvent,
        ChildError,
        ChildRequirements,
        ChildOutput,
        ChildInitialError
      >
      readonly snapshot?: (
        context: Machine.InvokeSnapshotContext<ChildState, ChildError, ChildOutput>
      ) => Event | undefined
    }
    & ([Address] extends [undefined] ? {
        readonly address?: never
      }
      : {
        readonly address: Exclude<Address, undefined>
      } & ChildAddress.Compatibility<Exclude<Address, undefined>, NoInfer<ChildEvent>>)
): Machine.InvokeConfig<
  any,
  any,
  any,
  any,
  Event,
  ChildState,
  ChildEvent,
  ChildError,
  ChildRequirements,
  ChildOutput,
  ChildInitialError
> => ({
  ...config,
  [InvokeTypeId]: undefined as any,
  [Activities.ActivityMetadataTypeId]: { type: "process" }
})

type InvokeEffectResult<Requirements, Event> = Machine.InvokeConfig<
  any,
  any,
  any,
  any,
  never,
  void,
  never,
  never,
  Requirements,
  Event | void,
  never
>

type InvokeEffectIsInfallible<Fx extends Effect.Effect<any, any, any>> = IsAny<Effect.Error<Fx>> extends true ? false
  : [Effect.Error<Fx>] extends [never] ? true
  : false

type InvokeEffectConfig<
  Fx extends Effect.Effect<any, any, any>,
  SuccessEvent,
  FailureEvent
> =
  & {
    readonly id: InvokeLifecycleId
    readonly effect: Fx
    readonly onSuccess: (value: NoInfer<Effect.Success<Fx>>) => SuccessEvent | void
  }
  & (
    InvokeEffectIsInfallible<Fx> extends true ? {
        readonly onFailure?: never
      }
      : {
        readonly onFailure: (error: NoInfer<Effect.Error<Fx>>) => FailureEvent | void
      }
  )

/**
 * Invokes one Effect and maps its typed outcome into machine-local events.
 *
 * **Details**
 *
 * This is the high-level one-shot counterpart to `invoke`. Success and typed
 * failure values are mapped independently, so callers do not need to recover
 * an Effect into a common event union by hand. Defects and interruption remain
 * failures of the owning machine.
 *
 * Declare mapped outcomes in `internalEvents` unless they are also legitimate
 * public commands.
 *
 * @see {@link invoke} for arbitrary child process logic.
 * @see {@link after} for a state-scoped delayed event.
 * @category constructors
 * @since 4.0.0
 */
export const invokeEffect = <
  const Fx extends Effect.Effect<any, any, any>,
  SuccessEvent,
  FailureEvent = never
>(
  config: InvokeEffectConfig<Fx, SuccessEvent, FailureEvent>
): InvokeEffectResult<
  Effect.Services<Fx>,
  SuccessEvent | (InvokeEffectIsInfallible<Fx> extends true ? never : FailureEvent)
> =>
  ((config: {
    readonly id: string
    readonly effect: Effect.Effect<unknown, unknown, unknown>
    readonly onSuccess: (value: unknown) => unknown
    readonly onFailure?: (error: unknown) => unknown
  }) => ({
    ...invoke({
      id: config.id,
      src: () =>
        effect(
          config.onFailure === undefined
            ? Effect.map(config.effect, config.onSuccess)
            : Effect.matchEffect(config.effect, {
              onFailure: (error) => Effect.succeed(config.onFailure!(error)),
              onSuccess: (value) => Effect.succeed(config.onSuccess(value))
            })
        )
    }),
    [Activities.ActivityMetadataTypeId]: {
      type: "effect",
      outcomes: {
        success: "dynamic",
        failure: config.onFailure === undefined ? "none" : "dynamic"
      }
    }
  }))(config as any) as any

/**
 * Creates a cancellable state-scoped delayed event.
 *
 * The timer starts when its owning state is entered and is interrupted when
 * that state exits. The delayed value should normally be declared in
 * `internalEvents`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const after = <Event extends { readonly _tag: PropertyKey }>(
  duration: Duration.Input,
  event: Event,
  options?: { readonly id?: InvokeLifecycleId }
): InvokeEffectResult<never, Event> => ({
  ...invoke({
    id: options?.id ?? `Machine.after:${String(event._tag)}`,
    src: () => effect(Effect.as(Effect.sleep(duration), event))
  }),
  [Activities.ActivityMetadataTypeId]: {
    type: "timer",
    duration: Duration.format(Duration.fromInputUnsafe(duration)),
    event: String(event._tag)
  }
})

type RetagFields<Target extends Machine.TaggedSchema> = Omit<Target["~type.make.in"], "_tag">

type RetagTargetCompatibility<Target extends Machine.TaggedSchema> = Target extends {
  readonly fields: Schema.Struct.Fields
} ? "_tag" extends keyof Target["~type.make.in"] ? {} extends Pick<Target["~type.make.in"], "_tag"> ? unknown : {
      readonly "~effect/Machine/RetagTargetError": "Target schema must supply its discriminator when make is called"
    }
  : unknown
  : {
    readonly "~effect/Machine/RetagTargetError": "Target schema must be one tagged struct or tagged class"
  }

type RequiredKeys<A> = {
  readonly [Key in keyof A]-?: {} extends Pick<A, Key> ? never : Key
}[keyof A]

type CompatibleSourceKeys<Fields, Source> = {
  readonly [Key in Extract<keyof Fields, keyof Source>]: Source[Key] extends Fields[Key] ? Key : never
}[Extract<keyof Fields, keyof Source>]

type RetagPatch<Target extends Machine.TaggedSchema, Source> =
  & Partial<RetagFields<Target>>
  & Pick<
    RetagFields<Target>,
    Exclude<RequiredKeys<RetagFields<Target>>, CompatibleSourceKeys<RetagFields<Target>, Source>>
  >

type RetagArgs<Target extends Machine.TaggedSchema, Source> = [
  Exclude<RequiredKeys<RetagFields<Target>>, CompatibleSourceKeys<RetagFields<Target>, Source>>
] extends [never] ? [patch?: RetagPatch<Target, Source>]
  : [patch: RetagPatch<Target, Source>]

/**
 * Constructs another tagged case from compatible source fields.
 *
 * The target must be one tagged struct or tagged class whose discriminator is
 * supplied by its constructor. Union wrappers are rejected because their
 * `make` operation cannot select a member after the source discriminator has
 * been discarded. Missing or incompatible required target fields must be
 * supplied by the patch, and the target schema's normal `make` validation
 * remains authoritative at runtime.
 *
 * @category constructors
 * @since 4.0.0
 */
export const retag = <
  const Target extends Machine.TaggedSchema,
  const Source extends { readonly _tag: PropertyKey }
>(
  target: Target & RetagTargetCompatibility<Target>,
  source: Source,
  ...args: RetagArgs<Target, Source>
): Target["Type"] => {
  const { _tag: _, ...fields } = source
  return target.make({ ...fields, ...(args[0] ?? {}) } as Target["~type.make.in"])
}

type InvokeMachineInput<Input extends Schema.Top> = Input extends typeof Schema.Void ? {
    readonly input?: never
  }
  : {
    readonly input: Input["Type"]
  }

/**
 * Creates an invoked child process from a complete statechart machine.
 *
 * **When to use**
 *
 * Use when a state should own another statechart machine and communicate with
 * it through typed child events, emissions, snapshots, or terminal output.
 *
 * **Details**
 *
 * Child emissions are delivered directly to the parent as events. Active
 * snapshots and terminal output can be mapped to parent events. The owning
 * state controls the child lifetime.
 *
 * **Gotchas**
 *
 * Active invoked machines must have unique child addresses. A machine starts
 * after its owning state's entry actions, so those actions cannot send events
 * to a newly entered child. Unrecovered child failures fail the parent.
 *
 * @see {@link invoke} for invoking lower-level process logic.
 * @see {@link sendTo} for sending events to the invoked machine.
 * @category constructors
 * @since 4.0.0
 */
export const invokeMachine: {
  <
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
    SnapshotEvent = never,
    DoneEvent = never,
    Id extends string = string,
    OutputStates extends Machine.StateIdentifier<States> = never,
    InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events
  >(
    config:
      & {
        readonly child: ChildMachine<
          Id,
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
          & EnsureExecutable<States, UnhandledStates, OutputStates>
        >
        readonly snapshot?: (
          context: Machine.InvokeSnapshotContext<
            Machine.Snapshot<States>,
            | E
            | ActionError<R>
            | InfiniteTransitionError
            | MachineSchemaDecodeError
            | StoppedError,
            Output
          >
        ) => SnapshotEvent | undefined
        readonly onDone: (context: Machine.InvokeDoneContext<Output>) => DoneEvent | undefined
      }
      & InvokeMachineInput<Input>
  ): Machine.InvokeConfig<
    any,
    any,
    any,
    any,
    SnapshotEvent,
    Machine.Snapshot<States>,
    Machine.EventOf<InputEvents>,
    E | ActionError<R> | InfiniteTransitionError | MachineSchemaDecodeError | StoppedError,
    ExcludeCompatibleRuntime<
      Exclude<ExecutionServices<InitialR | R>, internalRuntime.MachineRuntime>,
      Machine.EventOf<Events>,
      Machine.EmitOf<Emits>
    >,
    Output,
    | InitialE
    | E
    | ActionError<InitialR | R>
    | InfiniteTransitionError
    | MachineSchemaDecodeError
    | StartupError
    | StoppedError,
    Machine.EmitOf<Emits>,
    DoneEvent
  >
  <
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
    SnapshotEvent = never,
    Id extends string = string,
    OutputStates extends Machine.StateIdentifier<States> = never,
    InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events
  >(
    config:
      & {
        readonly child: ChildMachine<
          Id,
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
          & EnsureExecutable<States, UnhandledStates, OutputStates>
        >
        readonly snapshot?: (
          context: Machine.InvokeSnapshotContext<
            Machine.Snapshot<States>,
            | E
            | ActionError<R>
            | InfiniteTransitionError
            | MachineSchemaDecodeError
            | StoppedError,
            Output
          >
        ) => SnapshotEvent | undefined
        readonly onDone?: never
      }
      & InvokeMachineInput<Input>
  ): Machine.InvokeConfig<
    any,
    any,
    any,
    any,
    SnapshotEvent,
    Machine.Snapshot<States>,
    Machine.EventOf<InputEvents>,
    E | ActionError<R> | InfiniteTransitionError | MachineSchemaDecodeError | StoppedError,
    ExcludeCompatibleRuntime<
      Exclude<ExecutionServices<InitialR | R>, internalRuntime.MachineRuntime>,
      Machine.EventOf<Events>,
      Machine.EmitOf<Emits>
    >,
    Output,
    | InitialE
    | E
    | ActionError<InitialR | R>
    | InfiniteTransitionError
    | MachineSchemaDecodeError
    | StartupError
    | StoppedError,
    Machine.EmitOf<Emits>
  >
} = ((config: {
  readonly child: ChildMachine.Any
  readonly input?: unknown
  readonly snapshot?: (context: Machine.InvokeSnapshotContext<any, any, any>) => unknown
  readonly onDone?: (context: Machine.InvokeDoneContext<any>) => unknown
}) => {
  const machine = config.child.machine
  return {
    id: config.child.id,
    address: config.child.id,
    descriptor: config.child,
    src: () =>
      machine.input === undefined
        ? (internalProcess.toProcessLogic as any)(machine)
        : (internalProcess.toProcessLogic as any)(machine, config.input),
    snapshot: config.snapshot,
    onDone: config.onDone,
    [Activities.ActivityMetadataTypeId]: {
      type: "machine",
      child: {
        id: config.child.id,
        machineId: machine.id ?? null
      }
    },
    [InvokeTypeId]: undefined as any
  }
}) as any

/**
 * Plans the initial state for a machine without executing actor commands.
 *
 * **Details**
 *
 * The returned plan contains the settled initial snapshot, actor commands,
 * emitted events, optional final output, and every startup microstep. Planning
 * may evaluate transition logic and follow completion, eventless, and
 * raised-event steps. Transition callbacks are evaluated synchronously.
 * `startingState` and `initialEntryPaths` describe the normalized
 * configuration before entry callbacks and settlement begin.
 *
 * **Gotchas**
 *
 * `start` executes the closed command list as part of the managed actor commit
 * protocol. Manual planners may inspect commands but need a running actor scope
 * to execute child-addressed operations.
 *
 * @see {@link plan} for planning a received event.
 * @see {@link start} for the managed runtime protocol.
 * @category constructors
 * @since 4.0.0
 */
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
      readonly event: Machine.EventOf<Events> | InitialEvent
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

/**
 * Returns every compiled state node in definition order.
 *
 * **Details**
 *
 * The result includes atomic, compound, parallel, final, history, and choice
 * nodes together with their resolved descriptive annotations. Use each node's
 * `parent` property to reconstruct the complete hierarchy. Pseudo-states are
 * intentionally omitted from `children` because they can never appear in an
 * active configuration.
 *
 * @category getters
 * @since 4.0.0
 */
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

/**
 * Returns every registered transition handler in state definition order.
 *
 * **Details**
 *
 * Event handlers retain their handler-key order within each source state and
 * are followed by eventless and completion handlers. This function does not
 * execute handlers. Object-form event, eventless, and completion handlers with
 * a `targets` declaration expose those possible paths; handlers without one
 * remain dynamic.
 *
 * @category getters
 * @since 4.0.0
 */
export const transitionDefinitions = <M extends Machine.Any>(
  machine: M
): ReadonlyArray<
  Machine.TransitionDefinition<
    Machine.StateNodeIdentifier<Machine.States<M>>,
    Machine.TagOf<Machine.Events<M>[number]>,
    Machine.StateNodeIdentifier<Machine.States<M>>
  >
> =>
  Model.transitionDefinitions(machine) as ReadonlyArray<
    Machine.TransitionDefinition<
      Machine.StateNodeIdentifier<Machine.States<M>>,
      Machine.TagOf<Machine.Events<M>[number]>,
      Machine.StateNodeIdentifier<Machine.States<M>>
    >
  >

/**
 * Returns serializable descriptions of every state-owned activity.
 *
 * **Details**
 *
 * Static `invoke`, `invokeEffect`, `after`, and `invokeMachine` descriptors
 * expose stable ownership and lifecycle metadata without serializing runtime
 * values. Function-valued invoke factories are represented as dynamic and are
 * never evaluated during inspection.
 *
 * @category getters
 * @since 4.0.0
 */
export const activityDefinitions = <M extends Machine.Any>(
  machine: M
): ReadonlyArray<Machine.ActivityDefinition<Machine.StateIdentifier<Machine.States<M>>>> =>
  Activities.activityDefinitions(machine) as ReadonlyArray<
    Machine.ActivityDefinition<Machine.StateIdentifier<Machine.States<M>>>
  >

/**
 * Returns every state node active in a decoded snapshot, in definition order.
 *
 * **Details**
 *
 * Active compound ancestors and parallel regions are included together with
 * their active descendants. History and choice pseudo-states are never active
 * and are not returned.
 *
 * @category getters
 * @since 4.0.0
 */
export const configuration = <M extends Machine.Any>(
  machine: M,
  state: Machine.Snapshot<Machine.States<M>>
): ReadonlyArray<
  Machine.ActiveStateNode<
    Machine.StateIdentifier<Machine.States<M>>,
    Machine.ChoiceIdentifier<Machine.States<M>>
  >
> => {
  const active = Model.normalizeConfiguration(machine, state).active
  return stateNodes(machine).filter(
    (node): node is Machine.ActiveStateNode<
      Machine.StateIdentifier<Machine.States<M>>,
      Machine.ChoiceIdentifier<Machine.States<M>>
    > => node.type !== "history" && node.type !== "choice" && active.has(node.path)
  )
}

/**
 * Returns the event tags handled by the current state snapshot.
 *
 * @category getters
 * @since 4.0.0
 */
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

/**
 * Plans the next state snapshot synchronously.
 *
 * **Details**
 *
 * Planning selects child transitions before conflicting ancestors, permits
 * non-conflicting transitions in parallel regions, processes completion and
 * eventless transitions, and drains raised events in FIFO order. Exit paths
 * are deepest-first and entry paths are parent-first.
 *
 * **Gotchas**
 *
 * `plan` returns data; it does not implement the actor commit protocol.
 * `start` executes child commands, publishes `next`, and then delivers
 * `emittedEvents`. Events with no enabled transition are ignored and produce
 * an unchanged plan.
 *
 * @see {@link planInitial} for planning machine startup.
 * @see {@link start} for managed execution and lifecycle observation.
 * @category combinators
 * @since 4.0.0
 */
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
  event: Machine.EventOf<InputEvents>
) => Effect.Effect<
  & {
    readonly next: Machine.Snapshot<States>
    readonly commands: ReadonlyArray<Command>
    readonly emittedEvents: ReadonlyArray<Machine.EmitOf<Emits>>
    readonly microsteps: ReadonlyArray<{
      readonly next: Machine.Snapshot<States>
      readonly event: Machine.EventOf<Events> | InitialEvent
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

/**
 * Creates a one-shot child process from an Effect.
 *
 * **When to use**
 *
 * Use when you need side effects that produce one typed output or error.
 *
 * **Details**
 *
 * The Effect may run arbitrary side effects. Its success value is the process
 * output, its typed error is preserved, and its services are inferred. When
 * invoked, the output is sent to the owning machine as an event unless it is
 * `void`.
 *
 * **Gotchas**
 *
 * This process has no incoming event protocol. Its Effect runs once. Use
 * `transition` for a process that receives events over time and `logic` for
 * direct machine-local communication or intermediate snapshots.
 *
 * **Example** (Recover a child failure as output)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * class LoadFailed extends Schema.TaggedClass<LoadFailed>("LoadFailed")("LoadFailed", {
 *   reason: Schema.String
 * }) {}
 *
 * const load = Machine.effect(
 *   Effect.fail("unavailable").pipe(
 *     Effect.catch((reason) => Effect.succeed(new LoadFailed({ reason })))
 *   )
 * )
 * ```
 *
 * @see {@link transition} for event-driven state.
 * @see {@link logic} for direct control over intermediate snapshots.
 * @category constructors
 * @since 4.0.0
 */
export const effect = <Output, Error = never, Requirements = never>(
  effect: Effect.Effect<Output, Error, Requirements>
): Logic<void, never, Error, Requirements, Output> => ({
  initial: () => Effect.void,
  run: () => effect
})

/**
 * Creates advanced stateful process logic from explicit initialization and
 * execution methods.
 *
 * **When to use**
 *
 * Use when you need a machine-scoped process to publish intermediate snapshots
 * directly.
 *
 * **Details**
 *
 * Initialization produces the first state before `run` starts. The running
 * context receives events, reads or updates state, manages child processes,
 * and can communicate with its owning machine. Errors and service requirements
 * from both phases remain in the returned `Logic` type.
 *
 * **Gotchas**
 *
 * This is the low-level process constructor. Parent messages sent directly
 * through its scope are intentionally `unknown` because the logic does not know
 * which machine will eventually own it. Prefer typed output, typed child
 * addresses, or invoke snapshot mapping when possible.
 *
 * @see {@link effect} for one-shot work.
 * @see {@link transition} for event-driven state.
 * @category constructors
 * @since 4.0.0
 */
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

/**
 * Creates child process logic from an initial state and a transition function.
 *
 * **When to use**
 *
 * Use when a child process only needs sequential event-driven state updates and
 * does not need direct control over intermediate snapshots or child ownership.
 *
 * **Details**
 *
 * Each received event runs the transition Effect against the latest state. The
 * resulting state is published before the next queued event is processed.
 *
 * @see {@link effect} for one-shot work.
 * @see {@link logic} for direct process lifecycle control.
 * @category constructors
 * @since 4.0.0
 */
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

/**
 * Creates a typed descriptor for a complete child machine.
 *
 * Descriptors identify a child by id and machine identity, so independently
 * constructed descriptors for the same pair address the same invoked child.
 *
 * @category constructors
 * @since 4.0.0
 */
export const child = <const Id extends string, M extends Machine.Any>(
  id: Id,
  machine: M
): ChildMachine<Id, M> => ({
  [ChildMachineTypeId]: ChildMachineTypeId,
  id,
  machine
})

/**
 * Creates a typed parent-local address for lower-level child process logic.
 *
 * The default event protocol is `never`; provide an event type before using
 * the address with `spawn`, `invoke`, or `sendTo`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childAddress = <Event = never>(id: string): ChildAddress<Event> => id as ChildAddress<Event>

/**
 * Spawns a child process owned by the currently running machine.
 *
 * **When to use**
 *
 * Use from lower-level process logic to create children that should be
 * addressed or stopped by the owning process instead of tied to a single
 * state's `invoke` lifecycle.
 *
 * **Gotchas**
 *
 * This Effect requires a managed process runtime. A named child id must be
 * unique for the current parent until that child stops.
 *
 * @see {@link invoke} for children that start and stop with a state.
 * @see {@link sendTo} for sending events to named children.
 * @category runtime
 * @since 4.0.0
 */
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

/**
 * Sends an event to a named child process of the running machine.
 *
 * @category runtime
 * @since 4.0.0
 */
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

/**
 * Stops a named child process of the running machine.
 *
 * @category runtime
 * @since 4.0.0
 */
export const stopChild: {
  <Event>(child: ChildAddress<Event>): Effect.Effect<void, never, MachineRuntimeRequirement>
  <Child extends ChildMachine.Any>(child: Child): Effect.Effect<void, never, MachineRuntimeRequirement>
} = ((child: string | ChildMachine.Any) =>
  Effect.flatMap(
    internalRuntime.MachineRuntime,
    (runtime) => runtime.stopChild(child)
  )) as any

/**
 * Returns a stream of terminal lifecycle outcomes for a running machine.
 *
 * @category combinators
 * @since 4.0.0
 */
export const watch = <State, Event, Error = never, Output = never>(
  ref: MachineRef<State, Event, Error, Output>
): Stream.Stream<RuntimeOutcome<State, Error, Output>> => internalRuntime.watch(ref)

/**
 * Starts a machine.
 *
 * **When to use**
 *
 * Use when you want asynchronous event delivery, lifecycle snapshots, `join`,
 * and machine-owned spawned or invoked children.
 *
 * **Details**
 *
 * For each accepted event the runtime plans the complete synchronous
 * macrostep, executes closed actor commands, stops invokes for exited states,
 * publishes the new state, delivers emitted events, and then starts invokes
 * for entered states.
 *
 * **Gotchas**
 *
 * The returned handle's `send` operation only enqueues events. Transition
 * failures are reported through the runtime snapshot, `changes`, and `join`
 * rather than being returned by `send`. Sending after the machine reaches any
 * terminal state fails immediately with `StoppedError`.
 *
 * @see {@link plan} for inspecting the same transition plan without executing it.
 * @see {@link watch} for classified terminal outcomes.
 * @category constructors
 * @since 4.0.0
 */
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
    Machine.EventOf<InputEvents>,
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

/**
 * Starts a fresh managed runtime from a decoded logical snapshot.
 *
 * **Details**
 *
 * `resume` validates and normalizes the supplied snapshot before publishing it
 * as the first state. It does not call the machine's initial function, replay
 * entry or transition actions, re-deliver raised or emitted events, or
 * re-evaluate historical completion and eventless transitions. Active-state
 * invokes start once in ancestor and document order with {@link InitialEvent};
 * delayed invokes restart their complete duration and invoked machines start
 * from their own initial state.
 *
 * Only logical state, completion, and history metadata are resumed. Queues,
 * scopes, subscriptions, fibers, spawned children, invoke progress, and prior
 * runtime status are process-local and are not restored. A final snapshot
 * immediately produces a completed ref with its current-machine output.
 *
 * Decode encoded data explicitly with {@link decodeSnapshot} before calling
 * this function. Stable snapshots are hosted as supplied; newly enabled
 * eventless or completion transitions in a changed machine definition are not
 * evaluated merely because the runtime was resumed; only ordinary subsequent
 * transition planning can enter and stabilize states.
 *
 * @see {@link decodeSnapshot} for the schema and transport boundary.
 * @see {@link start} for ordinary initial startup.
 * @category constructors
 * @since 4.0.0
 */
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
    Machine.EventOf<InputEvents>,
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
