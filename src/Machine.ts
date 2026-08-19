/**
 * Schema-first machine definitions.
 *
 * @since 0.4.0
 */

import type * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import type * as Option from "effect/Option"
import type { Pipeable } from "effect/Pipeable"
import { hasProperty } from "effect/Predicate"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import type * as Types from "effect/Types"
import type * as Activities from "./internal/machine/activities.js"
import type {
  ChildAlreadyExistsError,
  InfiniteTransitionError,
  MachineSchemaDecodeError,
  MachineSchemaEncodeError,
  StartupError,
  StoppedError
} from "./internal/machine/machine.js"
import * as internal from "./internal/machine/machine.js"
import { InitialEventTypeId } from "./internal/machine/machine.js"
import type { EnsureExecutable } from "./internal/machine/readiness.js"
import type * as internalRuntime from "./internal/machine/runtime.js"
import type * as StateDefinition from "./internal/machine/stateDefinition.js"
import type * as Topology from "./internal/machine/topology.js"

/**
 * String literal type used as the runtime type identifier for `Machine`
 * values.
 *
 * @category type IDs
 * @since 0.4.0
 */
export type TypeId = "~effect/Machine"

/**
 * Runtime type identifier attached to `Machine` values.
 *
 * @category type IDs
 * @since 0.4.0
 */
export const TypeId: TypeId = "~effect/Machine"

declare const MachineOutputStatesTypeId: unique symbol
declare const MachineTypeId: unique symbol
declare const EventConstructionTypeId: unique symbol
declare const EmittedEventConstructionTypeId: unique symbol
declare const EventProtocolTypeId: unique symbol
declare const ParentModeTypeId: unique symbol

const ParentTypeId = "~effect/Machine/Parent"

const ChildMachineLogicTypeId: typeof internal.ChildMachineLogicTypeId = internal.ChildMachineLogicTypeId

/**
 * Type identifier used for the synthetic event passed to startup lifecycle
 * actions.
 *
 * @category type IDs
 * @since 0.4.0
 */
export { InitialEventTypeId }

/**
 * Synthetic event passed to entry, exit, always, invoke, and output callbacks
 * that run while the machine is settling its initial state.
 *
 * @category models
 * @since 0.4.0
 */
export interface InitialEvent {
  readonly _tag: typeof InitialEventTypeId
}

/**
 * Synthetic event value used while the machine settles its initial state.
 *
 * @category constructors
 * @since 0.4.0
 */
export const InitialEvent: InitialEvent = { _tag: InitialEventTypeId }

/**
 * Returns `true` if a value is the synthetic machine initial event.
 *
 * @category guards
 * @since 0.4.0
 */
export const isInitialEvent = (u: unknown): u is InitialEvent => hasProperty(u, "_tag") && u._tag === InitialEventTypeId

type IsAny<A> = 0 extends (1 & A) ? true : false

/**
 * A schema-first machine implementation.
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
 * @since 0.4.0
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
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
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
    InputEvents,
    ParentEvents
  >
  /** @internal Prevents output implementation evidence from being widened. */
  readonly [MachineOutputStatesTypeId]: Readonly<Record<OutputStates, true>>

  /**
   * State tree that defines the machine topology and state value schemas.
   *
   * @since 0.4.0
   */
  readonly states: States

  /**
   * Events accepted through public machine input boundaries.
   *
   * @since 0.4.0
   */
  readonly events: Machine.EventProtocol<"public", InputEvents>

  /**
   * Events reserved for raised events and other machine-local work.
   *
   * @since 0.4.0
   */
  readonly internalEvents: Machine.EventProtocol<
    "internal",
    Machine.InternalEventSchemas<Events, InputEvents>
  >

  /**
   * Ephemeral outward notifications published to this machine's observers.
   * Emissions are never delivered implicitly to an owning machine.
   *
   * @since 0.4.0
   */
  readonly emittedEvents: Machine.EventProtocol<"emitted", Emits>

  /**
   * Declared owning-machine protocol, or `undefined` when this machine does
   * not communicate with its owner.
   *
   * Required parents make the machine child-only and expose a non-optional
   * `parent` target to handlers. Optional parents keep root execution valid
   * and expose `parent` as possibly absent.
   *
   * @since 0.17.0
   */
  readonly parent: Machine.ParentDeclarationOf<ParentEvents>

  /**
   * Optional schema used to decode the machine input before initialization.
   *
   * @since 0.4.0
   */
  readonly input: Input | undefined

  /**
   * Optional stable identity used by runtime and persistence integrations.
   *
   * @since 0.4.0
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

  /** @internal */
  readonly initial: (...args: [...Machine.InputArgs<Input>]) => Machine.InitialResult<States, InitialE, InitialR>
  /** @internal */
  readonly initialDefinition: Machine.InitialDefinition
}

/**
 * A schema-first machine definition that can produce independent
 * implementations.
 *
 * **Details**
 *
 * Call `handle` once for each implementation. The returned {@link Machine}
 * does not expose `handle`, so handler configuration cannot be accumulated or
 * replaced through chained calls. Calling `handle` multiple times on the same
 * definition remains supported and creates independent machines.
 *
 * @category models
 * @since 0.15.0
 */
export interface Definition<
  States extends Machine.StateSchemas,
  Events extends ReadonlyArray<Machine.TaggedSchema>,
  Input extends Schema.Top = typeof Schema.Void,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
> extends
  Machine<
    States,
    Events,
    Input,
    Machine.StateIdentifier<States>,
    never,
    never,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    Emits,
    never,
    InputEvents,
    ParentEvents
  >
{
  /**
   * Adds typed state handlers and returns an independent machine
   * implementation. Event dispatch maps and transition descriptors are
   * captured by value, so later mutation of the supplied objects cannot alter
   * the resulting machine.
   *
   * @since 0.4.0
   */
  readonly handle: Machine.Handler<
    States,
    Events,
    Emits,
    Input,
    Machine.StateIdentifier<States>,
    never,
    never,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    never,
    InputEvents,
    ParentEvents
  >
}

/**
 * Namespace containing type-level members associated with {@link Definition}.
 *
 * @category models
 * @since 0.15.0
 */
export declare namespace Definition {
  /**
   * Any schema-first machine definition.
   *
   * @category models
   * @since 0.15.0
   */
  export interface Any extends Machine.Any {
    readonly handle: any
  }
}

export {
  /**
   * Error returned by `spawn` when a child process with the same id already
   * exists for the current machine.
   *
   * @category errors
   * @since 0.4.0
   */
  ChildAlreadyExistsError,
  /**
   * Error returned when a machine does not stabilize within the maximum
   * number of macrostep iterations.
   *
   * @category errors
   * @since 0.4.0
   */
  InfiniteTransitionError,
  /**
   * Error returned when a machine contract value does not match the schema or
   * structural configuration declared for a machine boundary.
   *
   * @category errors
   * @since 0.4.0
   */
  MachineSchemaDecodeError,
  /**
   * Error returned when a decoded machine snapshot cannot be encoded through
   * its declared state or output schemas.
   *
   * @category errors
   * @since 0.4.0
   */
  MachineSchemaEncodeError,
  /**
   * Error returned when standalone action execution attempts an operation that
   * requires a managed machine process.
   *
   * @category errors
   * @since 0.4.0
   */
  ProcessLocalError,
  /**
   * Error returned when a machine fails while running startup lifecycle
   * logic after the initial state has been computed.
   *
   * @category errors
   * @since 0.4.0
   */
  StartupError,
  /**
   * Error returned by `join` when a running machine is stopped before
   * producing an output.
   *
   * @category errors
   * @since 0.4.0
   */
  StoppedError
} from "./internal/machine/machine.js"

const RuntimeRequirementTypeId = "~effect/Machine/RuntimeRequirement"
const ActionRequirementTypeId = "~effect/Machine/ActionRequirement"
type MachineRuntimeRequirement = internalRuntime.MachineRuntime

/**
 * Opaque marker used to keep staged action errors and services separate from
 * the Effect that plans a machine step.
 *
 * @category services
 * @since 0.4.0
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
 * @since 0.4.0
 */
export type ActionError<Requirements> = Requirements extends ActionRequirement<infer Error, any> ? Error : never

/**
 * Extracts the service requirements of staged machine actions.
 *
 * @category utility types
 * @since 0.4.0
 */
export type ActionServices<Requirements> = Requirements extends ActionRequirement<any, infer Services> ? Services
  : never

/**
 * Removes staged action requirements from machine planning services.
 *
 * @category utility types
 * @since 0.4.0
 */
export type PlanningServices<Requirements> = Exclude<Requirements, ActionRequirement<any, any>>

/**
 * Resolves all services needed to execute a machine at runtime.
 *
 * @category utility types
 * @since 0.4.0
 */
export type ExecutionServices<Requirements> =
  | Exclude<PlanningServices<Requirements>, MachineRuntimeRequirement>
  | Exclude<ActionServices<Requirements>, MachineRuntimeRequirement>

/**
 * Managed runtime capability used to deliver raised events and publish
 * emitted notifications.
 *
 * @category models
 * @since 0.4.0
 */
export interface Runtime<in Events, in Emits> {
  /**
   * Queues an event for the current machine macrostep.
   *
   * @since 0.4.0
   */
  readonly raise: (event: Machine.EventInput<Events>) => Effect.Effect<void, MachineSchemaDecodeError | StoppedError>

  /**
   * Publishes an ephemeral notification to the running machine's observers.
   *
   * @since 0.4.0
   */
  readonly emit: (
    event: Machine.EmittedEventInput<Emits>
  ) => Effect.Effect<void, MachineSchemaDecodeError | StoppedError>
}

/**
 * Minimal typed target accepted by inter-machine send commands.
 *
 * @category models
 * @since 0.12.0
 */
export interface MachineTarget<in Event> {
  readonly id: string
  readonly sessionId: string
  readonly send: (event: Event) => Effect.Effect<void, StoppedError>
}

/**
 * Availability declared for an owning-machine target.
 *
 * @category models
 * @since 0.17.0
 */
export type ParentMode = "required" | "optional"

/**
 * Owning-machine protocol declared by {@link parent} or
 * {@link optionalParent}.
 *
 * @category models
 * @since 0.17.0
 */
export interface Parent<Mode extends ParentMode, Events extends ReadonlyArray<Machine.TaggedSchema>> {
  readonly [ParentTypeId]: typeof ParentTypeId
  readonly mode: Mode
  readonly events: Machine.EventProtocol<"public", Events>
}

/**
 * Namespace containing type-level members associated with {@link Parent}.
 *
 * @category models
 * @since 0.17.0
 */
export declare namespace Parent {
  /** Any owning-machine protocol declaration. */
  export type Any = Parent<ParentMode, ReadonlyArray<Machine.TaggedSchema>>
}

/**
 * Machine targets available while evaluating machine behavior.
 *
 * @category models
 * @since 0.12.0
 */
export type MachineReferences<
  InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema>
> =
  & {
    /** Target for the current machine. Sending queues a later mailbox event. */
    readonly self: MachineTarget<Machine.EventInputOf<InputEvents>>
  }
  & (Machine.ParentModeOf<ParentEvents> extends "required" ? {
      /** Required target for the machine that owns this child. */
      readonly parent: MachineTarget<Machine.EventInputOf<ParentEvents>>
    } :
    Machine.ParentModeOf<ParentEvents> extends "optional" ? {
        /** Target for the owning machine, or `undefined` when running as a root. */
        readonly parent: MachineTarget<Machine.EventInputOf<ParentEvents>> | undefined
      } :
    {})

/**
 * Synchronous commands available while a machine transition is being
 * selected. Enqueuing only records statechart and machine operations; it never
 * executes an Effect.
 *
 * @category models
 * @since 0.4.0
 */
export interface Enqueue<in Events, in Emits> {
  /** Raises an event inside the current macrostep. */
  readonly raise: (event: Machine.EventInput<Events>) => void

  /** Publishes an ephemeral notification to this machine's observers. */
  readonly emit: (event: Machine.EmittedEventInput<Emits>) => void

  /** Sends an event to an invoked child after the transition is selected. */
  readonly sendTo: {
    <Event>(target: MachineTarget<Event>, event: Event): void
    <Child extends ChildMachine.Any>(child: Child, event: ChildMachine.Event<Child>): void
    <Address extends ChildAddress<never>>(child: Address, event: ChildAddress.Event<Address>): void
  }

  /** Stops an invoked child after the transition is selected. */
  readonly stop: {
    <Child extends ChildMachine.Any>(child: Child): void
    <Event>(child: ChildAddress<Event>): void
  }
}

/**
 * A closed machine command recorded by a synchronous transition.
 *
 * @category models
 * @since 0.4.0
 */
export type Command =
  | {
    readonly _tag: "SendTo"
    readonly target: MachineTarget<unknown> | ChildMachine.Any | ChildAddress<never>
    readonly event: unknown
  }
  | {
    readonly _tag: "Stop"
    readonly child: ChildMachine.Any | ChildAddress<never>
  }

/**
 * Namespace containing type-level members associated with `Runtime`.
 *
 * @category models
 * @since 0.4.0
 */
export declare namespace Runtime {
  /**
   * Protocol annotation for managed event delivery.
   *
   * @category models
   * @since 0.4.0
   */
  export interface Protocol {
    readonly events?: unknown
    readonly emits?: unknown
  }

  /**
   * Extracts the events required by a runtime protocol annotation.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type Events<Protocol> = Protocol extends { readonly events: infer Events } ? Events : never

  /**
   * Extracts the emitted events required by a runtime protocol annotation.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type Emits<Protocol> = Protocol extends { readonly emits: infer Emits } ? Emits : never

  /**
   * Opaque service requirement for a machine runtime capability.
   *
   * @category services
   * @since 0.4.0
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

const InvokeTypeId: typeof internal.InvokeTypeId = internal.InvokeTypeId
const TransitionTypeId: typeof internal.TransitionTypeId = internal.TransitionTypeId
declare const TransitionBuilderTypeId: unique symbol
declare const InvokeBuilderTypeId: unique symbol
declare const InitialBuilderTypeId: unique symbol

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
  : Node extends Machine.StateNodeConfig ? ValidateStateNodeConfig<Node, Path>
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
  Node extends Machine.StateNodeConfig,
  Path extends PropertyKey
> = Node extends { readonly type: "parallel" } ?
    & ValidateExactStateNodeProperties<Node, "parallel", Path>
    & ValidateStateNodeWithChildren<Node, Node extends { readonly states: infer Children } ? Children : never, Path>
    & ValidatePseudoStateAnnotations<Node, Path>
  : Node extends { readonly type: "final" } ?
      & ValidateExactStateNodeProperties<Node, "final", Path>
      & ValidateStateNodeWithoutChildren<Node>
      & ValidatePseudoStateAnnotations<Node, Path>
  : Node extends { readonly states: infer Children } ?
      & ValidateExactStateNodeProperties<Node, "compound", Path>
      & ValidateStateNodeWithChildren<Node, Children, Path>
      & ValidatePseudoStateAnnotations<Node, Path>
  :
    & ValidateExactStateNodeProperties<Node, "atomic", Path>
    & ValidateStateNodeWithoutChildren<Node>
    & ValidatePseudoStateAnnotations<Node, Path>

type ValidateOutputSchema<Node> = "output" extends keyof Node ? Node extends { readonly output: Schema.Top } ? unknown
  : StateDefinitionError<"State output must be a schema">
  : unknown

type SelectorChildKey<Children extends Machine.StateSchemas> = ActiveStateKey<Children> | ChoiceStateKey<Children>

type ValidateInitialSelectorChild<Children extends Machine.StateSchemas, Path extends PropertyKey> = "initial" extends
  SelectorChildKey<Children> ? StateDefinitionError<
    "Active and choice child states cannot use the reserved target selector key \"initial\"",
    StateDefinitionPath<Extract<Path, string>, "initial">,
    "initial"
  >
  : unknown

type ValidateWithSelectorChild<
  Node extends Machine.StateNodeConfig,
  Children extends Machine.StateSchemas,
  Path extends PropertyKey
> = Node extends { readonly schema: Machine.TaggedSchema } ?
  "with" extends SelectorChildKey<Children> ? StateDefinitionError<
      "Schema-backed compound child states cannot use the reserved local target selector key \"with\"",
      StateDefinitionPath<Extract<Path, string>, "with">,
      "with"
    >
  : unknown
  : unknown

type ValidateStateNodeWithChildren<
  Node extends Machine.StateNodeConfig,
  Children,
  Path extends PropertyKey
> = Children extends Machine.StateSchemas ?
  Node extends { readonly type: "final" } ? StateDefinitionError<"Final states cannot declare child states">
  : Node extends { readonly type: "parallel" } ?
      & ValidateInitialSelectorChild<Children, Path>
      & ("initial" extends keyof Node ? StateDefinitionError<"Parallel states cannot declare an initial child">
        : { readonly states: ValidateStateTree<Children, true, Extract<Path, string>> } & ValidateOutputSchema<Node>)
  : "output" extends keyof Node ? StateDefinitionError<"Only final and parallel states can declare output">
  : ValidateCompoundStateNode<Node, Children, Path>
  : StateDefinitionError<"Child states must be a state tree">

type ValidateCompoundStateNode<
  Node extends Machine.StateNodeConfig,
  Children extends Machine.StateSchemas,
  Path extends PropertyKey
> = Node extends { readonly initial: infer Initial } ?
  Initial extends ActiveStateKey<Children> | ChoiceStateKey<Children> ?
      & ValidateInitialSelectorChild<Children, Path>
      & ValidateWithSelectorChild<Node, Children, Path>
      & {
        readonly states: ValidateStateTree<Children, true, Extract<Path, string>>
      }
  : StateDefinitionError<
    "Compound initial must be one of its direct child keys",
    Path,
    Extract<Initial, PropertyKey>
  >
  : StateDefinitionError<"Compound states must declare an initial child", Path>

type ValidateStateNodeWithoutChildren<Node extends Machine.StateNodeConfig> = "initial" extends keyof Node ?
  StateDefinitionError<"Atomic states cannot declare an initial child">
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

type ReusableStateNodeConfig =
  | Machine.AtomicStateNodeConfig
  | Machine.CompoundStateNodeConfig
  | Machine.ParallelStateNodeConfig

type ReusableStateValidation<Node> = Node extends ReusableStateNodeConfig ? ValidateStateNode<Node, false, "state">
  : StateDefinitionError<"Reusable states must be active state nodes", "state">

type ValidateDefinedState<Node> = [Node] extends [ReusableStateValidation<Node>] ? []
  : [validation: ReusableStateValidation<Node>]

type InvalidDefinedStateInput<Node> = [Node] extends [ReusableStateValidation<Node>] ? never
  : Node & ReusableStateValidation<Node>

interface StateConstructor {
  <const Node>(
    node: Node & DefineStateNodeInput<NoInfer<Node>>,
    ..._validation: ValidateDefinedState<NoInfer<Node>>
  ): Node
  <const Node>(node: InvalidDefinedStateInput<Node>): never
}

interface StatesConstructor {
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
  ] ? Machine.TagOf<Head> extends infer Tag extends PropertyKey ?
        | Extract<Tag, Seen>
        | DuplicateEventTag<Tail, Seen | Tag>
    : never
  : never

type ValidateInputEventProtocol<
  InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  DuplicateInput extends PropertyKey = DuplicateEventTag<InputEvents>
> = [DuplicateInput] extends [never] ? unknown
  : EventProtocolError<"Public event tags must be unique", DuplicateInput>

type ValidateEmittedEventProtocol<
  EmittedEvents extends ReadonlyArray<Machine.TaggedSchema>,
  DuplicateEmitted extends PropertyKey = DuplicateEventTag<EmittedEvents>
> = [DuplicateEmitted] extends [never] ? unknown
  : EventProtocolError<"Emitted event tags must be unique", DuplicateEmitted>

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

type ValidateEventProtocolBuilder<
  Kind extends Machine.EventProtocolKind,
  Inputs extends ReadonlyArray<Machine.EventProtocolInput<Kind>>,
  Schemas extends ReadonlyArray<Machine.TaggedSchema> = Machine.EventProtocolInputSchemasOf<Kind, Inputs>,
  Duplicate extends PropertyKey = DuplicateEventTag<Schemas>
> = [Duplicate] extends [never] ? unknown
  : EventProtocolError<"Event protocol tags must be unique", Duplicate>

const SnapshotBuilderStateTypeId: typeof internal.SnapshotBuilderStateTypeId = internal.SnapshotBuilderStateTypeId
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
   * @since 0.4.0
   */
  readonly from: FromCallable<Arguments, Machine.StateConstruction<Result>>
}

type ConstructionResult<Result> = Result | Machine.StateConstruction<Result>

type UnwrapConstruction<Result> = Result extends Machine.StateConstruction<infer Value> ? Value : Result

type NodeValue<Node> = [Machine.NodeSchema<Node>] extends [never] ? undefined
  : Machine.NodeSchema<Node>["Type"]

type NodeMakeInput<Node> = [Machine.NodeSchema<Node>] extends [never] ? never
  : Machine.NodeSchema<Node>["~type.make.in"]

type WithNodeValue<Node, Rest extends ReadonlyArray<unknown>> = Machine.NodeSchema<Node> extends never ? Rest
  : readonly [value: NodeValue<Node>, ...Rest]

type WithNodeInput<Node, Rest extends ReadonlyArray<unknown>> = Machine.NodeSchema<Node> extends never ? Rest
  : readonly [input: NodeMakeInput<Node>, ...Rest]

type NodeBuilderMethod<
  Node,
  Arguments extends ReadonlyArray<unknown>,
  Result,
  FromArguments extends ReadonlyArray<unknown>,
  FromResult
> = Machine.NodeSchema<Node> extends never ? {
    readonly from: FromCallable<FromArguments, FromResult>
  }
  :
    & ((...args: Arguments) => Result)
    & { readonly from: FromCallable<FromArguments, FromResult> }

type NodeMethod<
  Node,
  Arguments extends ReadonlyArray<unknown>,
  Result,
  FromArguments extends ReadonlyArray<unknown>
> = Machine.NodeSchema<Node> extends never ? FromMethod<FromArguments, Result>
  : ((...args: Arguments) => Result) & FromMethod<FromArguments, Result>

type NodeMethodWithInitial<
  Node,
  Arguments extends ReadonlyArray<unknown>,
  Result,
  FromArguments extends ReadonlyArray<unknown>,
  Path extends string
> = Machine.NodeSchema<Node> extends never ? {
    readonly from: FromCallable<FromArguments, Machine.StateConstruction<Result>>
    readonly initial: InitialTargetFactory<Node, Path>
  }
  :
    & ((...args: Arguments) => Result)
    & {
      readonly from: FromCallable<FromArguments, Machine.StateConstruction<Result>>
      readonly initial: InitialTargetFactory<Node, Path>
    }

interface InitialTargetMethod<
  Node,
  Path extends string
> {
  /** Enters this state through its declared initial configuration. */
  readonly initial: InitialTargetFactory<Node, Path>
}

interface InitialTargetFactory<
  Node,
  Path extends string
> {
  (...args: WithNodeValue<Node, readonly []>): Machine.InitialTarget<Path>
  readonly from: FromCallable<
    WithNodeInput<Node, readonly []>,
    Machine.StateConstruction<Machine.InitialTarget<Path>>
  >
}

type NodeConstructionSelectorFromCallable<Node, Builder, Result> = Machine.NodeSchema<Node> extends never ? {
    <Selected extends ConstructionResult<Result>>(
      state: (builder: Builder) => Selected
    ): Machine.StateConstruction<UnwrapConstruction<Selected>>
  }
  : ConstructionSelectorFromCallable<NodeMakeInput<Node>, Builder, Result>

type NestedTargetMethod<Node, Builder, Result, Path extends string> = Machine.NodeSchema<Node> extends never ? {
    readonly from: NodeConstructionSelectorFromCallable<Node, Builder, Result>
    readonly initial: InitialTargetFactory<Node, Path>
  }
  :
    & (<Selected extends ConstructionResult<Result>>(
      value: NodeValue<Node>,
      state: (builder: Builder) => Selected
    ) => Selected)
    & {
      readonly from: NodeConstructionSelectorFromCallable<Node, Builder, Result>
      readonly initial: InitialTargetFactory<Node, Path>
    }

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
> = Machine.NodeSchema<States[StateId]> extends never ? FromMethod<
    InitialSnapshotFromArguments<States, StateId, Prefix>,
    InitialSnapshotResult<States, StateId, Prefix>
  >
  :
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
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
    WithNodeValue<Node, [
      states: (
        builder: InitialParallelBuilder<Children, Path>
      ) => SnapshotBuilderComplete<InitialSnapshotRegionsWithPrefix<Children, Path>>
    ]>
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ?
    Node extends { readonly initial: infer Initial extends ActiveStateKey<Children> | ChoiceStateKey<Children> } ?
      WithNodeValue<Node, [
        state: (
          builder: Pick<InitialSnapshotBuilderWithPrefix<Children, Path>, Initial>
        ) => InitialSelectableResult<Children, Initial, Path>
      ]>
    : never
  : WithNodeValue<Node, []>
  : never

type InitialSnapshotFromArguments<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = States[StateId] extends infer Node ?
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
    WithNodeInput<Node, [
      states: (
        builder: InitialParallelBuilder<Children, Path>
      ) => SnapshotBuilderComplete<InitialSnapshotRegionsWithPrefix<Children, Path>, boolean>
    ]>
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ?
    Node extends { readonly initial: infer Initial extends ActiveStateKey<Children> | ChoiceStateKey<Children> } ?
      WithNodeInput<Node, [
        state: (
          builder: Pick<InitialSnapshotBuilderWithPrefix<Children, Path>, Initial>
        ) => ConstructionResult<InitialSelectableResult<Children, Initial, Path>>
      ]>
    : never
  : WithNodeInput<Node, []>
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
      NodeValue<Node>,
      InitialSnapshotRegionsWithPrefix<Children, Path>
    >
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ?
    Node extends { readonly initial: infer Initial extends ActiveStateKey<Children> | ChoiceStateKey<Children> } ?
      Machine.CompoundSnapshot<
        Path,
        NodeValue<Node>,
        InitialSelectableResult<Children, Initial, Path>
      >
    : never
  : Machine.AtomicSnapshot<Path, NodeValue<Node>>
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
    readonly [Key in Remaining]: NodeBuilderMethod<
      States[Key],
      InitialSnapshotArguments<States, Key, Prefix>,
      InitialParallelBuilder<
        States,
        Prefix,
        Exclude<Remaining, Key>,
        Regions & { readonly [Region in Key]: InitialSnapshotResult<States, Key, Prefix> },
        Constructed
      >,
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
> = Machine.NodeSchema<States[StateId]> extends never ? FromMethod<
    FullSnapshotFromArguments<States, StateId, Prefix>,
    FullSnapshotResult<States, StateId, Prefix>
  >
  :
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
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
    WithNodeValue<Node, [
      states: (
        builder: FullParallelBuilder<Children, Path>
      ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>>
    ]>
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? WithNodeValue<Node, [
      state: (
        builder: FullSnapshotBuilderWithPrefix<Children, Path>
      ) =>
        | Machine.SnapshotWithPrefix<Children, Path>
        | Machine.ChoiceTargetInstruction<Machine.ChoiceIdentifierWithPrefix<Children, Path>>
    ]>
  : WithNodeValue<Node, []>
  : never

type FullSnapshotFromArguments<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = States[StateId] extends infer Node ?
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
    WithNodeInput<Node, [
      states: (
        builder: FullParallelBuilder<Children, Path>
      ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>, boolean>
    ]>
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? WithNodeInput<Node, [
      state: (
        builder: FullSnapshotBuilderWithPrefix<Children, Path>
      ) => ConstructionResult<
        | Machine.SnapshotWithPrefix<Children, Path>
        | Machine.ChoiceTargetInstruction<Machine.ChoiceIdentifierWithPrefix<Children, Path>>
      >
    ]>
  : WithNodeInput<Node, []>
  : never

type FullSnapshotResult<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = Machine.SnapshotByIdentifierWithPath<States, StateId, Path>

type InitialEntryStateKey<States extends Machine.StateSchemas> = {
  readonly [Key in ActiveStateKey<States>]: States[Key] extends { readonly states: Machine.StateSchemas } ? Key : never
}[ActiveStateKey<States>]

type FullInitialTargetBuilder<States extends Machine.StateSchemas> = {
  readonly [Key in InitialEntryStateKey<States>]: InitialTargetMethod<States[Key], Key>
}

type FullParallelBuilder<
  States extends Machine.StateSchemas,
  Prefix extends string,
  Remaining extends ActiveStateKey<States> = ActiveStateKey<States>,
  Regions = {},
  Constructed extends boolean = false
> =
  & SnapshotBuilderComplete<Regions, Constructed>
  & {
    readonly [Key in Remaining]: NodeBuilderMethod<
      States[Key],
      FullSnapshotArguments<States, Key, Prefix>,
      FullParallelBuilder<
        States,
        Prefix,
        Exclude<Remaining, Key>,
        Regions & { readonly [Region in Key]: FullSnapshotResult<States, Key, Prefix> },
        Constructed
      >,
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

type HistorySnapshotArguments<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Owner extends string,
  Path extends string = Machine.JoinPath<Prefix, StateId>
> = Path extends Owner ? FullSnapshotArguments<States, StateId, Prefix>
  : States[StateId] extends infer Node ?
    Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
      WithNodeValue<Node, [
        states: (
          builder: HistoryParallelBuilder<Children, Path, Owner>
        ) => SnapshotBuilderComplete<HistorySnapshotRegions<Children, Path, Owner>>
      ]>
    : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? WithNodeValue<Node, [
        state: (
          builder: HistorySnapshotBuilderWithPrefix<Children, Owner, Path>
        ) => ConstructionResult<HistorySnapshotWithPrefix<Children, Owner, Path>>
      ]>
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
    Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
      WithNodeInput<Node, [
        states: (
          builder: HistoryParallelBuilder<Children, Path, Owner>
        ) => SnapshotBuilderComplete<HistorySnapshotRegions<Children, Path, Owner>, boolean>
      ]>
    : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? WithNodeInput<Node, [
        state: (
          builder: HistorySnapshotBuilderWithPrefix<Children, Owner, Path>
        ) => ConstructionResult<HistorySnapshotWithPrefix<Children, Owner, Path>>
      ]>
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
        NodeValue<Node>,
        HistorySnapshotRegions<Children, Path, Owner>
      >
    : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? Machine.CompoundSnapshot<
        Path,
        NodeValue<Node>,
        HistorySnapshotWithPrefix<Children, Owner, Path>
      >
    : never
  : never

type HistorySnapshotMethod<
  States extends Machine.StateSchemas,
  StateId extends ActiveStateKey<States>,
  Prefix extends string,
  Owner extends string
> = Machine.NodeSchema<States[StateId]> extends never ? FromMethod<
    HistorySnapshotFromArguments<States, StateId, Prefix, Owner>,
    HistorySnapshotResult<States, StateId, Prefix, Owner>
  >
  :
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
      | `${Machine.JoinPath<Prefix, Key>}.${string}` ? NodeBuilderMethod<
        States[Key],
        HistorySnapshotArguments<States, Key, Prefix, Owner>,
        HistoryParallelBuilder<
          States,
          Prefix,
          Owner,
          Exclude<Remaining, Key>,
          Regions & { readonly [Region in Key]: HistorySnapshotResult<States, Key, Prefix, Owner> },
          Constructed
        >,
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
      : NodeBuilderMethod<
        States[Key],
        FullSnapshotArguments<States, Key, Prefix>,
        HistoryParallelBuilder<
          States,
          Prefix,
          Owner,
          Exclude<Remaining, Key>,
          Regions & { readonly [Region in Key]: FullSnapshotResult<States, Key, Prefix> },
          Constructed
        >,
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
    Source extends Path | `${Path}.${string}` ? NestedTargetMethod<
        Node,
        LocalTargetBuilderWithPrefix<AllStates, Children, Path, Source>,
        LocalTargetResultWithPrefix<AllStates, Children, Path>,
        Path
      >
    : NodeMethodWithInitial<
      Node,
      WithNodeValue<Node, [
        states: (
          builder: FullParallelBuilder<Children, Path>
        ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>>
      ]>,
      Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>,
      WithNodeInput<Node, [
        states: (
          builder: FullParallelBuilder<Children, Path>
        ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>, boolean>
      ]>,
      Path
    >
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ? NestedTargetMethod<
      Node,
      LocalTargetBuilderWithPrefix<AllStates, Children, Path, Source>,
      LocalTargetResultWithPrefix<AllStates, Children, Path>,
      Path
    >
  : NodeMethod<
    Node,
    WithNodeValue<Node, []>,
    Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>,
    WithNodeInput<Node, []>
  >
  : never

type LocalTargetBuilderForScope<
  States extends Machine.StateSchemas,
  Scope extends Machine.StateIdentifier<States>,
  Source extends Machine.StateNodeIdentifier<States>
> = ChildrenOf<States, Scope> extends infer Children extends Machine.StateSchemas ?
    & LocalTargetBuilderWithPrefix<States, Children, Scope, Source>
    & (Scope extends Machine.ValuedStateIdentifier<States> ? {
        /**
         * Updates the value of the state containing the local group and moves to
         * one of the states inside it. Values in other active branches are kept.
         *
         * @since 0.4.0
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
      } :
      {})
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
        & NestedTargetMethod<
          Node,
          BranchTargetBuilderWithPrefix<AllStates, Children, Path, Source>,
          BranchTargetResultWithPrefix<AllStates, Children, Path>,
          Path
        >
        & BranchTargetBuilderWithPrefix<AllStates, Children, Path, Source>
    : NodeMethodWithInitial<
      Node,
      WithNodeValue<Node, [
        states: (
          builder: FullParallelBuilder<Children, Path>
        ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>>
      ]>,
      Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>,
      WithNodeInput<Node, [
        states: (
          builder: FullParallelBuilder<Children, Path>
        ) => SnapshotBuilderComplete<Machine.SnapshotRegionsWithPrefix<Children, Path>, boolean>
      ]>,
      Path
    >
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ?
      & NestedTargetMethod<
        Node,
        BranchTargetBuilderWithPrefix<AllStates, Children, Path, Source>,
        BranchTargetResultWithPrefix<AllStates, Children, Path>,
        Path
      >
      & BranchTargetBuilderWithPrefix<AllStates, Children, Path, Source>
  : NodeMethod<
    Node,
    WithNodeValue<Node, []>,
    Machine.Target<AllStates, StateIdentifierFromPath<AllStates, Path>>,
    WithNodeInput<Node, []>
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

type HasValuedActiveChild<States extends Machine.StateSchemas> = {
  readonly [Key in ActiveStateKey<States>]: Machine.NodeSchema<States[Key]> extends never ? never : Key
}[ActiveStateKey<States>] extends never ? false : true

type InitializerClosureForNode<
  AllStates extends Machine.StateSchemas,
  Node,
  Path extends string
> = Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
    | (HasValuedActiveChild<Children> extends true ? Extract<Path, Machine.StateIdentifier<AllStates>> : never)
    | InitializerClosuresForChildren<AllStates, Children, Path>
  : Node extends { readonly states: infer Children extends Machine.StateSchemas; readonly initial: infer Initial } ?
      | (Initial extends ActiveStateKey<Children> ? Machine.NodeSchema<Children[Initial]> extends never ? never
        : Extract<Path, Machine.StateIdentifier<AllStates>>
        : never)
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
 * @since 0.4.0
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
 * Live, root-scoped records describing one prepared machine tree.
 *
 * Inspection records deliberately erase machine-specific values to `unknown`:
 * one stream may contain unrelated root, child-machine, and `Logic` protocols.
 * The record structure remains a closed discriminated union, while typed
 * application observation continues through `changes` and `emissions`.
 *
 * @category models
 * @since 0.13.0
 */
export declare namespace Inspection {
  /** Read-only identity of a local machine endpoint. */
  export interface Endpoint {
    readonly id: string
    readonly sessionId: string
  }

  /** Read-only identity of a runtime represented in the inspection tree. */
  export interface Subject extends Endpoint {
    readonly kind: "Machine" | "Logic"
  }

  /** Causal origin of an inspected runtime. */
  export type Origin =
    | { readonly _tag: "Root" }
    | {
      readonly _tag: "Invoke"
      readonly ownerPath: string
      readonly invokeId: string
    }
    | {
      readonly _tag: "Spawn"
      readonly address: string | undefined
    }

  /** Causal owner of a send or emission. */
  export type Causation =
    | { readonly _tag: "Initialization" }
    | { readonly _tag: "Macrostep"; readonly macrostepId: number }
    | { readonly _tag: "Activity"; readonly activitySessionId: string }

  /** Closed command projection safe for observation. */
  export type Command =
    | {
      readonly _tag: "SendTo"
      readonly target: Endpoint | { readonly id: string }
      readonly event: unknown
    }
    | {
      readonly _tag: "Stop"
      readonly target: Endpoint | { readonly id: string }
    }

  /** One statechart microstep in a committed macrostep. */
  export interface Microstep {
    readonly event: unknown
    readonly transitions: ReadonlyArray<Machine.RetainedTransition>
    readonly raisedEvents: ReadonlyArray<unknown>
    readonly emittedEvents: ReadonlyArray<unknown>
    readonly commands: ReadonlyArray<Command>
    readonly exitPaths: ReadonlyArray<string>
    readonly entryPaths: ReadonlyArray<string>
    readonly changed: boolean
  }

  /** Common ordering and identity fields for every record. */
  export interface Base {
    /** Total publication order within this prepared root. */
    readonly sequence: number
    /** Session id of the prepared root that owns this inspection stream. */
    readonly rootSessionId: string
    /** Runtime instance described by this record. */
    readonly subject: Subject
  }

  /** Announces allocation of a root or owned process identity. */
  export interface Created extends Base {
    readonly _tag: "Created"
    readonly parent: Subject | undefined
    readonly origin: Origin
    /** Compiled statechart definition; absent for generic `Logic`. */
    readonly definition: Machine.Any | undefined
  }

  /** Announces successful initialization. */
  export interface Initialized extends Base {
    readonly _tag: "Initialized"
    readonly snapshot: RuntimeSnapshot<unknown, unknown, unknown>
    readonly initialEntryPaths: ReadonlyArray<string>
    readonly microsteps: ReadonlyArray<Microstep>
  }

  /** Announces failure before an initial runtime snapshot exists. */
  export interface StartFailed extends Base {
    readonly _tag: "StartFailed"
    readonly cause: Cause.Cause<unknown>
  }

  /** Announces acceptance of an event by a local mailbox. */
  export interface EventSent extends Base {
    readonly _tag: "EventSent"
    readonly deliveryId: number
    readonly source: Subject | undefined
    readonly target: Endpoint
    readonly event: unknown
    readonly causedBy: Causation | undefined
  }

  /** Announces complete processing of one statechart mailbox event. */
  export interface EventProcessed extends Base {
    readonly _tag: "EventProcessed"
    readonly macrostepId: number
    readonly deliveryId: number
    readonly source: Subject | undefined
    readonly event: unknown
    readonly before: RuntimeSnapshot<unknown, unknown, unknown>
    readonly after: RuntimeSnapshot<unknown, unknown, unknown>
    readonly handled: boolean
    readonly configurationChanged: boolean
    readonly microsteps: ReadonlyArray<Microstep>
  }

  /** Announces a direct state update made by generic `Logic`. */
  export interface StateChanged extends Base {
    readonly _tag: "StateChanged"
    readonly before: unknown
    readonly after: unknown
    readonly causedByDeliveryId: number | undefined
  }

  /** Announces actual publication on a machine's domain emission stream. */
  export interface Emitted extends Base {
    readonly _tag: "Emitted"
    readonly emission: unknown
    readonly causedBy: Causation | undefined
  }

  /** Identity of one Effect or timer invocation run. */
  export interface Activity {
    readonly id: string
    readonly sessionId: string
    readonly owner: Subject
    readonly ownerPath: string
    readonly kind: "Effect" | "Stream" | "Timer"
  }

  /** Announces an Effect, Stream, or timer invocation starting. */
  export interface ActivityStarted extends Base {
    readonly _tag: "ActivityStarted"
    readonly activity: Activity
  }

  /** Announces an Effect or timer invocation outcome. */
  export interface ActivityStopped extends Base {
    readonly _tag: "ActivityStopped"
    readonly activity: Activity
    /** Success or failure from the invoke; interruption means its owner stopped it. */
    readonly exit: Exit.Exit<unknown, unknown>
  }

  /** Announces a terminal local runtime snapshot. */
  export interface Terminated extends Base {
    readonly _tag: "Terminated"
    readonly snapshot: RuntimeSnapshot<unknown, unknown, unknown>
  }

  /** Complete live inspection protocol. */
  export type Event =
    | Created
    | Initialized
    | StartFailed
    | EventSent
    | EventProcessed
    | StateChanged
    | Emitted
    | ActivityStarted
    | ActivityStopped
    | Terminated
}

/**
 * Represents a classified terminal outcome derived from a runtime snapshot.
 *
 * @category models
 * @since 0.4.0
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
 * A fresh machine whose observable streams exist before initialization.
 *
 * Subscribe to `emissions` before evaluating `start` when initial-entry
 * emissions must be observed. `start` is one-shot: concurrent and repeated
 * evaluations share the same initialization and running reference.
 *
 * @category models
 * @since 0.11.0
 */
export interface Prepared<out State, in Event, out Error, out Output, out Emitted, out StartError, StartRequirements> {
  /** Stable machine definition id, or a generated fallback when none was declared. */
  readonly id: string

  /** Unique identity reserved for this prepared machine instance. */
  readonly sessionId: string

  /** Waits for startup, then streams the initial lifecycle snapshot and later changes. */
  readonly changes: Stream.Stream<RuntimeSnapshot<State, Error, Output>, StartError>

  /** Streams ephemeral notifications published after subscription. */
  readonly emissions: Stream.Stream<Emitted>

  /**
   * Streams ordered operational records for this root and every locally owned
   * descendant. The stream is hot, non-replayed, never fails, and completes
   * after the prepared root terminates. Subscribe before evaluating `start` to
   * observe initialization.
   */
  readonly inspection: Stream.Stream<Inspection.Event>

  /** Initializes this machine once and returns its running reference. */
  readonly start: Effect.Effect<MachineRef<State, Event, Error, Output, Emitted>, StartError, StartRequirements>
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
 * @since 0.4.0
 */
export interface MachineRef<out State, in Event, out Error = never, out Output = never, out Emitted = never>
  extends MachineTarget<Event>
{
  /** Stable machine definition id, or a generated fallback when none was declared. */
  readonly id: string

  /** Unique identity for this running machine instance. */
  readonly sessionId: string

  /** Reads the latest logical state. */
  readonly state: Effect.Effect<State>

  /** Reads the latest lifecycle snapshot. */
  readonly snapshot: Effect.Effect<RuntimeSnapshot<State, Error, Output>>

  /** Streams the current lifecycle snapshot followed by later changes. */
  readonly changes: Stream.Stream<RuntimeSnapshot<State, Error, Output>>

  /**
   * Streams ephemeral notifications published after subscription. Emissions
   * are not retained or replayed; the stream completes when the machine stops.
   */
  readonly emissions: Stream.Stream<Emitted>

  /** Waits for machine output or fails when execution fails or is stopped. */
  readonly join: Effect.Effect<Output, Error | StoppedError>

  /** Stops this machine instance and its owned child processes. */
  readonly stop: Effect.Effect<void>

  /** Accepts an event for asynchronous processing by the running machine. */
  readonly send: (event: Event) => Effect.Effect<void, StoppedError>

  /**
   * Returns the current directly owned child for a typed descriptor.
   *
   * @since 0.4.0
   */
  readonly child: <Child extends ChildMachine.Any>(
    child: Child
  ) => Effect.Effect<Option.Option<ChildMachine.Ref<Child>>>

  /**
   * Streams activation, replacement, and removal of a directly owned child.
   *
   * @since 0.4.0
   */
  readonly childChanges: <Child extends ChildMachine.Any>(
    child: Child
  ) => Stream.Stream<Option.Option<ChildMachine.Ref<Child>>>
}

/**
 * Machine-specific process logic used by `spawn` and state-owned invocations.
 *
 * @category models
 * @since 0.4.0
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
 * @category models
 * @since 0.4.0
 */
export declare namespace Logic {
  /**
   * Machine-local endpoint that can receive events and be stopped.
   *
   * @category models
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @category models
   * @since 0.4.0
   */
  export interface Scope<Event> {
    /** Address of the process being initialized. */
    readonly self: Address<Event>

    /** Address of the owning process, when one exists. */
    readonly parent: Address<unknown> | undefined

    /** Starts a child process owned by this scope. */
    readonly spawn: Spawn

    /** Sends an event to a machine target or typed parent-local child address. */
    readonly sendTo: {
      <TargetEvent>(target: MachineTarget<TargetEvent>, event: TargetEvent): Effect.Effect<void, StoppedError>
      <Address extends ChildAddress<never>>(
        id: Address,
        event: ChildAddress.Event<Address>
      ): Effect.Effect<void, StoppedError>
    }

    /** Stops a child process selected by its parent-local address. */
    readonly stopChild: <Event>(id: ChildAddress<Event>) => Effect.Effect<void>
  }

  /**
   * Machine-local capabilities available while stateful process logic runs.
   *
   * @category models
   * @since 0.4.0
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
 * a descriptor for the same id and machine to inline `invoke`, `sendTo`, and
 * child lookup APIs so state, event, error, and output types are inferred
 * without separate annotations.
 *
 * @category models
 * @since 0.4.0
 */
export interface ChildMachine<Id extends string, M extends Machine.Any> {
  readonly [ChildMachineTypeId]: typeof ChildMachineTypeId

  /** Parent-local id used to address the invoked child. */
  readonly id: Id

  /** Complete machine definition carried by this descriptor. */
  readonly machine: M

  /** @internal */
  readonly [ChildMachineLogicTypeId]: (input?: unknown) => Logic<any, any, any, any, any, any>
}

/**
 * Namespace containing type-level members associated with `ChildMachine`.
 *
 * @category models
 * @since 0.4.0
 */
export declare namespace ChildMachine {
  /**
   * Any typed child machine descriptor.
   *
   * @category models
   * @since 0.4.0
   */
  export type Any = ChildMachine<string, Machine.Any>

  /**
   * Running machine reference selected by a child descriptor.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type Ref<Child> = Child extends ChildMachine<string, infer M> ? MachineRef<
      Machine.Snapshot<Machine.States<M>>,
      Machine.EventInput<Machine.InputEvent<M>>,
      | Machine.Error<M>
      | ActionError<Machine.Services<M>>
      | InfiniteTransitionError
      | MachineSchemaDecodeError
      | StoppedError,
      Machine.Output<M>,
      Machine.EmittedEvent<M>
    >
    : never

  /**
   * Event accepted by the child selected by a descriptor.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type Event<Child> = Child extends ChildMachine<string, infer M> ? Machine.EventInput<Machine.InputEvent<M>>
    : never
}

/**
 * Parent-local address for a child process that can receive events.
 *
 * @category models
 * @since 0.4.0
 */
export type ChildAddress<Event> = string & ChildAddress.Variance<Event>

/**
 * Namespace containing type-level members associated with `ChildAddress`.
 *
 * @category models
 * @since 0.4.0
 */
export declare namespace ChildAddress {
  /**
   * Variance marker carried by a typed child process address.
   *
   * @category models
   * @since 0.4.0
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
   * @since 0.4.0
   */
  export type Event<Address> = Address extends ChildAddress<infer Event> ? Event : unknown

  /**
   * Ensures a child address protocol is compatible with a child process event
   * protocol.
   *
   * @category utility types
   * @since 0.4.0
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
   * @since 0.4.0
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
 * @since 0.4.0
 */
export interface SpawnOptions {
  readonly id?: string
}

/**
 * Options for spawning child processes with a parent-local id.
 *
 * @category models
 * @since 0.4.0
 */
export interface SpawnIdOptions extends SpawnOptions {
  readonly id: string
}

/**
 * Namespace containing type-level members associated with `Machine`.
 *
 * @category models
 * @since 0.4.0
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
    InputEvents extends ReadonlyArray<TaggedSchema>,
    ParentEvents extends ReadonlyArray<TaggedSchema>
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
    readonly emittedEvents: Emits
    readonly outputStates: OutputStates
    readonly inputEvents: InputEvents
    readonly parentEvents: ParentEvents
  }

  /** @internal Carries parent availability without widening the event tuple. */
  export type ParentEventSchemas<
    Mode extends ParentMode,
    Events extends ReadonlyArray<TaggedSchema>
  > = Events & { readonly [ParentModeTypeId]: Mode }

  /** Extracts the parent availability encoded in a machine event tuple. */
  export type ParentModeOf<Events extends ReadonlyArray<TaggedSchema>> = Events extends
    { readonly [ParentModeTypeId]: infer Mode extends ParentMode } ? Mode
    : Events extends readonly [] ? "none"
    : "optional"

  /** Extracts the event schemas declared by an owning-machine protocol. */
  export type ParentEventsOf<Declaration extends Parent.Any | undefined> = Declaration extends Parent<
    infer Mode,
    infer Events
  > ? ParentEventSchemas<Mode, Events>
    : readonly []

  /** Extracts the owning-machine declaration carried by a machine. */
  export type ParentDeclarationOf<Events extends ReadonlyArray<TaggedSchema>> = ParentModeOf<Events> extends
    infer Mode ? Mode extends ParentMode ? Parent<Mode, Events> : undefined
    : never

  /** Constraint applied to APIs that create an independent root runtime. */
  export type RootCompatible<Events extends ReadonlyArray<TaggedSchema>> = ParentModeOf<Events> extends "required"
    ? never
    : unknown

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
   * @since 0.4.0
   */
  export interface Any extends Pipeable {
    readonly [TypeId]: TypeId
    /** @internal */
    readonly [MachineTypeId]: TypeCarrier<any, any, any, any, any, any, any, any, any, any, any, any, any, any>
    readonly states: StateSchemas
    readonly events: EventProtocol.Any<"public">
    readonly internalEvents: EventProtocol.Any<"internal">
    readonly emittedEvents: EventProtocol.Any<"emitted">
    readonly parent: Parent.Any | undefined
    readonly input: Schema.Top | undefined
    readonly id: string | undefined
    /** @internal */
    readonly stateNodes: StateNodes
    /** @internal */
    readonly makeTargetBuilder: any
    /** @internal */
    readonly handlers: any
    /** @internal */
    readonly initial: any
    /** @internal */
    readonly initialDefinition: InitialDefinition
  }

  /**
   * Extracts the state schema tree carried by a machine definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type States<M extends Any> = M[typeof MachineTypeId]["states"]

  /**
   * Extracts the complete event schema tuple carried by a machine definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type Events<M extends Any> = M[typeof MachineTypeId]["events"]

  /**
   * Extracts the startup input schema carried by a machine definition.
   *
   * @category utility types
   * @since 0.18.0
   */
  export type InputSchema<M extends Any> = M[typeof MachineTypeId]["input"]

  /**
   * Extracts the decoded startup input accepted by a machine definition.
   *
   * Machines declared with `Schema.Void` do not accept a startup input, so
   * their extracted input type is `never`.
   *
   * @category utility types
   * @since 0.18.0
   */
  export type Input<M extends Any> = InputSchema<M> extends infer Input extends Schema.Top
    ? Input extends typeof Schema.Void ? never
    : Input["Type"]
    : never

  /**
   * Extracts state paths that do not yet have handlers.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type UnhandledStates<M extends Any> = M[typeof MachineTypeId]["unhandledStates"]

  /**
   * Extracts the runtime error channel carried by a machine definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type Error<M extends Any> = M[typeof MachineTypeId]["error"]

  /**
   * Extracts runtime service requirements carried by a machine definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type Services<M extends Any> = M[typeof MachineTypeId]["services"]

  /**
   * Extracts the startup error channel carried by a machine definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InitialError<M extends Any> = M[typeof MachineTypeId]["initialError"]

  /**
   * Extracts startup service requirements carried by a machine definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InitialServices<M extends Any> = M[typeof MachineTypeId]["initialServices"]

  /**
   * Extracts final state paths carried by a machine definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type FinalStates<M extends Any> = M[typeof MachineTypeId]["finalStates"]

  /**
   * Extracts the terminal output channel carried by a machine definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type Output<M extends Any> = M[typeof MachineTypeId]["output"]

  /**
   * Extracts the emitted event schema tuple carried by a machine definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type EmittedEvents<M extends Any> = M[typeof MachineTypeId]["emittedEvents"]

  /** @deprecated Use {@link EmittedEvents}. */
  export type Emits<M extends Any> = EmittedEvents<M>

  /**
   * Extracts state paths with implemented output handlers.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type OutputStates<M extends Any> = M[typeof MachineTypeId]["outputStates"]

  /**
   * Extracts the public input event schema tuple carried by a machine definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InputEvents<M extends Any> = M[typeof MachineTypeId]["inputEvents"]

  /** Extracts the public input protocol required from an owning machine. */
  export type ParentEvents<M extends Any> = M[typeof MachineTypeId]["parentEvents"]

  /** Extracts whether a machine requires or optionally accepts an owner. */
  export type ParentAvailability<M extends Any> = ParentModeOf<M[typeof MachineTypeId]["parentEvents"]>

  /** Extracts an internal event schema tuple from the complete and public protocols. */
  export type InternalEventSchemas<
    Events extends ReadonlyArray<TaggedSchema>,
    InputEvents extends ReadonlyArray<TaggedSchema>
  > = Events extends readonly [
    ...InputEvents,
    ...infer Internal extends ReadonlyArray<TaggedSchema>
  ] ? readonly [...Internal]
    : readonly []

  /** Extracts the internal event schema tuple carried by a machine definition. */
  export type InternalEvents<M extends Any> = InternalEventSchemas<Events<M>, InputEvents<M>>

  /**
   * Extracts the complete event protocol handled inside a machine.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type Event<M extends Any> = EventOf<Events<M>>

  /**
   * Extracts the event protocol accepted by public machine input boundaries.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InputEvent<M extends Any> = EventOf<InputEvents<M>>

  /**
   * Opaque event construction returned by {@link events} and
   * {@link internalEvents}.
   *
   * The machine resolves the instruction through its event schema when it is
   * delivered. Only the discriminator is available before decoding succeeds.
   */
  export interface EventConstruction<out Event extends { readonly _tag: PropertyKey }> {
    readonly [EventConstructionTypeId]: Event
    readonly _tag: Event["_tag"]
  }

  /** Opaque construction returned by {@link emittedEvents}. */
  export interface EmittedEventConstruction<out Event extends { readonly _tag: PropertyKey }> {
    readonly [EmittedEventConstructionTypeId]: Event
    readonly _tag: Event["_tag"]
  }

  /** A decoded event or a deferred machine-bound construction of that event. */
  export type EventInput<Event> =
    | Event
    | (Event extends { readonly _tag: PropertyKey } ? EventConstruction<Event> : never)

  /** A decoded emitted event or a deferred emitted-event construction. */
  export type EmittedEventInput<Event> =
    | Event
    | (Event extends { readonly _tag: PropertyKey } ? EmittedEventConstruction<Event> : never)

  /** Event inputs accepted for a schema tuple at machine delivery boundaries. */
  export type EventInputOf<Events extends ReadonlyArray<TaggedSchema>> = EventInput<EventOf<Events>>

  /** Identifies whether an event protocol is accepted publicly or only inside a machine. */
  export type EventProtocolKind = "public" | "internal" | "emitted"

  type EventConstructorInput<EventSchema extends TaggedSchema> = Omit<EventSchema["~type.make.in"], "_tag">

  type EventConstructor<
    EventSchema extends TaggedSchema,
    Tag extends EventSchema["Type"]["_tag"],
    Kind extends EventProtocolKind
  > = {} extends EventConstructorInput<EventSchema> ? (
      input?: EventConstructorInput<EventSchema>
    ) => Kind extends "emitted" ? EmittedEventConstruction<EventByTag<readonly [EventSchema], Tag>>
      : EventConstruction<EventByTag<readonly [EventSchema], Tag>>
    : (
      input: EventConstructorInput<EventSchema>
    ) => Kind extends "emitted" ? EmittedEventConstruction<EventByTag<readonly [EventSchema], Tag>>
      : EventConstruction<EventByTag<readonly [EventSchema], Tag>>

  type FiniteEventTag<Tag extends PropertyKey> = string extends Tag ? never
    : number extends Tag ? never
    : symbol extends Tag ? never
    : Tag

  type EventConstructorsForSchema<
    EventSchema extends TaggedSchema,
    Kind extends EventProtocolKind
  > = EventSchema extends {
    readonly cases: infer Cases extends Readonly<Record<PropertyKey, TaggedSchema>>
  } ? {
      readonly [Tag in keyof Cases]: Tag extends Cases[Tag]["Type"]["_tag"] ? EventConstructor<Cases[Tag], Tag, Kind>
        : never
    }
    : EventSchema extends { readonly members: infer Members extends ReadonlyArray<TaggedSchema> } ?
      Types.UnionToIntersection<EventConstructorsForSchema<Members[number], Kind>>
    : {
      readonly [Tag in FiniteEventTag<EventSchema["Type"]["_tag"]>]: EventConstructor<EventSchema, Tag, Kind>
    }

  /** Protocol-bound constructors keyed by each configured event tag. */
  export type EventConstructors<
    Events extends ReadonlyArray<TaggedSchema>,
    Kind extends EventProtocolKind = "public"
  > = {
    readonly [Tag in keyof Types.UnionToIntersection<EventConstructorsForSchema<Events[number], Kind>>]:
      Types.UnionToIntersection<EventConstructorsForSchema<Events[number], Kind>>[Tag]
  }

  /**
   * A schema-backed event protocol exposing only deferred event constructors.
   *
   * The schema tuple is retained opaquely for machine runtime validation and
   * type inference. It is not exposed as a runtime property.
   *
   * @since 0.10.0
   */
  export type EventProtocol<
    Kind extends EventProtocolKind,
    Schemas extends ReadonlyArray<TaggedSchema>
  > = EventConstructors<Schemas, Kind> & {
    readonly [EventProtocolTypeId]: {
      readonly kind: Kind
      readonly schemas: Schemas
    }
  }

  export namespace EventProtocol {
    /** An erased event protocol descriptor retaining its kind and schema carrier. */
    export interface Any<Kind extends EventProtocolKind = EventProtocolKind> {
      readonly [EventProtocolTypeId]: {
        readonly kind: Kind
        readonly schemas: ReadonlyArray<TaggedSchema>
      }
    }
  }

  /** A schema or an existing protocol accepted by an event builder. */
  export type EventProtocolInput<Kind extends EventProtocolKind> = TaggedSchema | EventProtocol.Any<Kind>

  type EventProtocolInputSchemas<
    Kind extends EventProtocolKind,
    Input extends EventProtocolInput<Kind>
  > = Input extends EventProtocol<Kind, infer Schemas> ? Schemas
    : Input extends TaggedSchema ? readonly [Input]
    : readonly []

  /** Flattens schema and protocol inputs into one owned schema tuple. */
  export type EventProtocolInputSchemasOf<
    Kind extends EventProtocolKind,
    Inputs extends ReadonlyArray<EventProtocolInput<Kind>>
  > = Inputs extends readonly [
    infer Head extends EventProtocolInput<Kind>,
    ...infer Tail extends ReadonlyArray<EventProtocolInput<Kind>>
  ] ? readonly [...EventProtocolInputSchemas<Kind, Head>, ...EventProtocolInputSchemasOf<Kind, Tail>]
    : readonly []

  /** @internal Extracts the schema tuple carried opaquely by an event protocol. */
  export type EventProtocolSchemas<Protocol extends EventProtocol.Any> = Protocol[typeof EventProtocolTypeId]["schemas"]

  /**
   * Extracts the event protocol emitted by a machine.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type EmittedEvent<M extends Any> = EmittedEventOf<Emits<M>>

  /** @deprecated Use {@link EmittedEvent}. */
  export type Emit<M extends Any> = EmittedEvent<M>

  /**
   * A schema whose decoded value contains a `_tag` discriminator.
   *
   * **Details**
   *
   * This mirrors the tagged-schema constraint used by `Schema.toTaggedUnion`.
   *
   * @category models
   * @since 0.4.0
   */
  export type TaggedSchema = Schema.Top & { readonly Type: { readonly _tag: PropertyKey } }

  /**
   * Descriptive annotations exposed for compiled state nodes.
   *
   * Schema-backed states resolve their complete Effect Schema annotation map.
   * Schema-less active states and pseudo-states accept only the descriptive
   * fields below. Annotations never affect state identity, targeting, or
   * runtime behavior.
   *
   * @category models
   * @since 0.4.0
   */
  export interface StateNodeAnnotations extends Schema.Annotations.Annotations {
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly documentation?: string | undefined
  }

  /** Descriptive annotations accepted by schema-less active and pseudo-states. */
  export type SchemaLessStateAnnotations = Pick<
    StateNodeAnnotations,
    "title" | "description" | "documentation"
  >

  /** @deprecated Use {@link SchemaLessStateAnnotations}. */
  export type PseudoStateAnnotations = SchemaLessStateAnnotations

  /**
   * Configuration accepted for an atomic object state node. Omit `schema` when
   * the state owns no value; a schema-less final may still declare `output`.
   *
   * @category models
   * @since 0.4.0
   */
  export type AtomicStateNodeConfig =
    | {
      readonly schema: TaggedSchema
      readonly type?: "active"
      readonly output?: never
      readonly annotations?: never
    }
    | {
      readonly schema: TaggedSchema
      readonly type: "final"
      readonly output?: Schema.Top
      readonly annotations?: never
    }
    | {
      readonly schema?: never
      readonly type?: "active"
      readonly output?: never
      readonly annotations?: SchemaLessStateAnnotations
    }
    | {
      readonly schema?: never
      readonly type: "final"
      readonly output?: Schema.Top
      readonly annotations?: SchemaLessStateAnnotations
    }

  /**
   * Configuration accepted for a compound object state node. Omit `schema`
   * when the compound state exists only to own control topology.
   *
   * @category models
   * @since 0.4.0
   */
  export type CompoundStateNodeConfig =
    | {
      readonly schema: TaggedSchema
      readonly type?: "active"
      readonly initial: string
      readonly states: StateTree
      readonly annotations?: never
    }
    | {
      readonly schema?: never
      readonly type?: "active"
      readonly initial: string
      readonly states: StateTree
      readonly annotations?: SchemaLessStateAnnotations
    }

  /**
   * Configuration accepted for a parallel object state node. Omit `schema`
   * when the parallel state exists only to own its regions.
   *
   * @category models
   * @since 0.4.0
   */
  export type ParallelStateNodeConfig =
    | {
      readonly schema: TaggedSchema
      readonly type: "parallel"
      readonly output?: Schema.Top
      readonly states: StateTree
      readonly annotations?: never
    }
    | {
      readonly schema?: never
      readonly type: "parallel"
      readonly output?: Schema.Top
      readonly states: StateTree
      readonly annotations?: SchemaLessStateAnnotations
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
   * @since 0.4.0
   */
  export interface HistoryStateNodeConfig {
    readonly type: "history"
    /** Defaults to shallow history. */
    readonly history?: "shallow" | "deep"
    readonly annotations?: SchemaLessStateAnnotations
  }

  /**
   * Transient decision pseudo-state resolved immediately when targeted.
   *
   * Choice nodes have no value and never belong to an active configuration.
   * Their required `choice` implementation uses ordinary TypeScript or an
   * Effect to select a typed target.
   *
   * @category models
   * @since 0.4.0
   */
  export interface ChoiceStateNodeConfig {
    readonly type: "choice"
    readonly annotations?: SchemaLessStateAnnotations
  }

  /**
   * Configuration accepted for an object state node.
   *
   * @category models
   * @since 0.4.0
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
   * @since 0.4.0
   */
  export type StateTree = Readonly<Record<string, TaggedSchema | StateNodeConfig>>

  /**
   * State schema definitions accepted by `make`.
   *
   * @category models
   * @since 0.4.0
   */
  export type StateSchemas = StateTree

  /**
   * Builder for initial state snapshots generated by `states`.
   *
   * **When to use**
   *
   * Use when you need the type of the `initial` property returned by
   * `states` or want to expose an initial snapshot builder from a helper.
   *
   * **Details**
   *
   * Initial builders enforce the declared initial child for compound states and
   * require every direct region for parallel states.
   *
   * @category utility types
   * @since 0.4.0
   */
  type InitialBuilder<States extends StateSchemas> = InitialSnapshotBuilderWithPrefix<States>

  /**
   * State definitions and snapshot access helpers returned by `states`.
   *
   * **Details**
   *
   * The `states` property is the original state tree and can be passed directly
   * to `make`. The remaining helpers match and read snapshots for the same
   * state tree.
   *
   * @category models
   * @since 0.4.0
   */
  export interface DefinedStates<States extends StateSchemas> {
    /** Captured state tree supplied to {@link states}. */
    readonly states: States

    /**
     * Checks and preserves one active state path from this definition.
     *
     * This is useful for named path helpers, including finite template-literal
     * families. Every member of a path union must exist in the state tree.
     *
     * @since 0.15.0
     */
    readonly path: <const Path extends StateIdentifier<States>>(path: Path) => Path

    /**
     * Returns the decoded value for an active state path. The supplied
     * snapshot may be a complete root snapshot or a snapshot previously
     * extracted from this definition. Extracted snapshots accept only their
     * own absolute path and descendant paths.
     *
     * @since 0.4.0
     */
    readonly get: {
      <Path extends ValuedStateIdentifier<States>>(
        snapshot: Snapshot<States>,
        path: Path
      ): Option.Option<StateByIdentifier<States, Path>>
      <
        const From extends StateIdentifier<States>,
        const Path extends ValuedStateIdentifier<States>
      >(
        snapshot: SnapshotByIdentifier<States, From>,
        path: Path & (Path extends NoInfer<From> | `${NoInfer<From>}.${string}` ? unknown : never)
      ): Option.Option<StateByIdentifier<States, Path>>
    }

    /**
     * Returns the decoded value for an active state path together with all of
     * its active parent values.
     *
     * **Details**
     *
     * Parent values are keyed by their full state paths.
     *
     * @since 0.4.0
     */
    readonly getWithParents: <Path extends ValuedStateIdentifier<States>>(
      snapshot: Snapshot<States>,
      path: Path
    ) => Option.Option<StateWithParents<States, Path>>

    /**
     * Returns the snapshot for an active state path. The supplied snapshot may
     * be a complete root snapshot or a snapshot previously extracted from this
     * definition. Extracted snapshots accept only their own absolute path and
     * descendant paths.
     *
     * @since 0.4.0
     */
    readonly getSnapshot: {
      <Path extends StateIdentifier<States>>(
        snapshot: Snapshot<States>,
        path: Path
      ): Option.Option<SnapshotByIdentifier<States, Path>>
      <
        const From extends StateIdentifier<States>,
        const Path extends StateIdentifier<States>
      >(
        snapshot: SnapshotByIdentifier<States, From>,
        path: Path & (Path extends NoInfer<From> | `${NoInfer<From>}.${string}` ? unknown : never)
      ): Option.Option<SnapshotByIdentifier<States, Path>>
    }

    /**
     * Returns whether a state path is active in the snapshot. The supplied
     * snapshot may be a complete root snapshot or a snapshot previously
     * extracted from this definition. Extracted snapshots accept only their
     * own absolute path and descendant paths.
     *
     * @since 0.4.0
     */
    readonly matches: {
      <Path extends StateIdentifier<States>>(
        snapshot: Snapshot<States>,
        path: Path
      ): boolean
      <
        const From extends StateIdentifier<States>,
        const Path extends StateIdentifier<States>
      >(
        snapshot: SnapshotByIdentifier<States, From>,
        path: Path & (Path extends NoInfer<From> | `${NoInfer<From>}.${string}` ? unknown : never)
      ): boolean
    }
  }

  /**
   * Validates the nested shape of state schema definitions.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type ValidateStateSchemas<States extends StateSchemas> = ValidateStateTree<States>

  /** Properties shared by every compiled state-node variant. */
  export interface StateNodeBase<Path extends string = string> {
    readonly path: Path
    readonly key: string
    /** Resolved schema annotations, or descriptive schema-less-state annotations. */
    readonly annotations: Readonly<StateNodeAnnotations> | undefined
    readonly order: number
  }

  /** Runtime metadata for a compiled atomic state. */
  export interface AtomicStateNode<OwnPath extends string = string, ActivePath extends string = OwnPath>
    extends StateNodeBase<OwnPath>
  {
    readonly type: "atomic"
    readonly schema: TaggedSchema | undefined
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
    readonly schema: TaggedSchema | undefined
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
    readonly schema: TaggedSchema | undefined
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
    readonly schema: TaggedSchema | undefined
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
    | {
      readonly type: "invoke"
      readonly id: string
      readonly outcome: "element" | "done" | "failure" | "snapshot"
    }

  /** Static topology selected by a transition branch. */
  export interface TransitionTargetSelection<
    Path extends string | undefined = string | undefined,
    Kind extends Topology.TargetSelectionKind = Topology.TargetSelectionKind,
    Scope extends Topology.TargetSelectionScope | undefined = Topology.TargetSelectionScope | undefined
  > {
    readonly path: Path
    readonly kind: Kind
    readonly scope: Scope
  }

  /** One statically captured branch of a transition definition. */
  export type TransitionBranch<Path extends string = string> =
    | {
      readonly type: "direct"
      readonly target: Path | undefined
      readonly selection: TransitionTargetSelection<Path | undefined>
    }
    | {
      readonly type: "branch"
      readonly key: string
      readonly title: string
      readonly target: Path | undefined
      readonly selection: TransitionTargetSelection<Path | undefined>
    }

  /** The statically selected root entry for machine startup. */
  export interface InitialDefinition<Path extends string = string> {
    readonly target: Path
    readonly selection: TransitionTargetSelection<Path, "state" | "initial", "initial">
  }

  /**
   * Inspectable registration for a transition handler.
   *
   * **Details**
   *
   * Every branch exposes its selected target without executing its resolver.
   * A compound local or branch target covers its descendants;
   * `undefined` identifies an explicitly targetless branch.
   *
   * @category models
   * @since 0.4.0
   */
  export interface TransitionDefinition<
    SourcePath extends string = string,
    EventTag extends PropertyKey = PropertyKey,
    TargetPath extends string = SourcePath
  > {
    readonly source: SourcePath
    readonly trigger: TransitionTrigger<EventTag>
    readonly reenter: boolean
    readonly acceptance: TransitionAcceptance
    readonly branches: ReadonlyArray<TransitionBranch<TargetPath>>
  }

  /**
   * Serializable description of state-owned work.
   *
   * Static invoke definitions expose their lifecycle id and kind without
   * retaining Effects, closures, services, or child runtimes. Function-valued
   * sources are reported as dynamic and are never evaluated by inspection.
   *
   * @category models
   * @since 0.4.0
   */
  export type ActivityDefinition<SourcePath extends string = string> = Activities.ActivityDefinition<SourcePath>

  /**
   * Transition retained after hierarchy precedence and conflict resolution for
   * one planned microstep.
   *
   * @category models
   * @since 0.4.0
   */
  export interface RetainedTransition<
    SourcePath extends string = string,
    EventTag extends PropertyKey = PropertyKey,
    TargetPath extends string = SourcePath
  > {
    readonly source: SourcePath
    readonly trigger: TransitionTrigger<EventTag>
    readonly reenter: boolean
    /** Zero-based index of the selected static branch. */
    readonly branchIndex: number
    /** Stable key of a named branch, or `undefined` for a direct transition. */
    readonly branchKey: string | undefined
    /** Path returned by the handler, including a choice or history pseudo-state. */
    readonly target: TargetPath | undefined
    /**
     * Concrete path used after resolving choice, initial, or history routing.
     * Choice microsteps retain each intermediate pseudo-state edge separately.
     */
    readonly resolvedTarget: TargetPath | undefined
  }

  /**
   * Constructor arguments for a machine initial state function.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InputArgs<Input extends Schema.Top> = Input extends typeof Schema.Void ? []
    : [input: Input["Type"]]

  /**
   * Extracts the discriminator value represented by a tagged schema.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type TagOf<S extends TaggedSchema> = S["Type"]["_tag"]

  /**
   * Extracts the schema from a state tree node definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type NodeSchema<Node> = Node extends TaggedSchema ? Node
    : Node extends { readonly schema: infer Schema extends TaggedSchema } ? Schema
    : never

  /**
   * Prefixes a state path with its parent path.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type JoinPath<Parent extends string, Child extends string> = Parent extends "" ? Child : `${Parent}.${Child}`

  /**
   * Extracts the state path values represented by a state definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type StateIdentifier<States extends StateSchemas> = StateIdentifierWithPrefix<States>

  /** Extracts active state paths whose definitions declare a state value schema. */
  export type ValuedStateIdentifier<States extends StateSchemas> = StateIdentifier<States> extends infer StateId
    ? StateId extends StateIdentifier<States> ? NodeSchema<NodeByIdentifier<States, StateId>> extends never ? never
      : StateId
    : never
    : never

  /** Extracts active state paths whose definitions intentionally omit a state value schema. */
  export type StructuralStateIdentifier<States extends StateSchemas> = Exclude<
    StateIdentifier<States>,
    ValuedStateIdentifier<States>
  >

  /**
   * Extracts the state path values represented by a state definition under a
   * parent path prefix.
   *
   * @category utility types
   * @since 0.4.0
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
   * @since 0.4.0
   */
  export type HistoryIdentifier<States extends StateSchemas> = HistoryIdentifierWithPrefix<States>

  /** Extracts the transition-only choice pseudo-state paths. */
  export type ChoiceIdentifier<States extends StateSchemas> = ChoiceIdentifierWithPrefix<States>

  /**
   * Extracts every compiled state-node path, including history pseudo-states.
   *
   * @category utility types
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
   */
  export type SchemaByIdentifier<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeSchema<NodeByIdentifier<States, StateId>>

  /**
   * Extracts the union of state values represented by a state definition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type StateOf<States extends StateSchemas> = StateIdentifier<States> extends infer StateId
    ? StateId extends StateIdentifier<States> ? SchemaByIdentifier<States, StateId>["Type"]
    : never
    : never

  /**
   * Extracts the union of event values represented by an event schema list.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type EventOf<Events extends ReadonlyArray<TaggedSchema>> = Events[number]["Type"]

  /**
   * Extracts the union of emitted event values represented by an emitted event
   * schema list.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type EmittedEventOf<Emits extends ReadonlyArray<TaggedSchema>> = Emits[number]["Type"]

  /** @deprecated Use {@link EmittedEventOf}. */
  export type EmitOf<Emits extends ReadonlyArray<TaggedSchema>> = EmittedEventOf<Emits>

  /**
   * Event values received by lifecycle callbacks.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type LifecycleEvent<Events extends ReadonlyArray<TaggedSchema>> = EventOf<Events> | InitialEvent

  /**
   * Extracts a state value from a state definition by identifier.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type StateByIdentifier<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = StateId extends ValuedStateIdentifier<States> ? SchemaByIdentifier<States, StateId>["Type"] : undefined

  /**
   * Extracts every parent state path from a state identifier.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type ParentStateIdentifier<StateId extends string> = StateId extends `${infer Parent}.${infer Child}`
    ? Parent | (Child extends `${string}.${string}` ? `${Parent}.${ParentStateIdentifier<Child>}` : never)
    : never

  /**
   * Extracts the nearest parent state path from a state identifier.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type ImmediateParentStateIdentifier<StateId extends string> = StateId extends `${infer Head}.${infer Tail}` ?
    Tail extends `${string}.${string}` ? `${Head}.${ImmediateParentStateIdentifier<Tail>}`
    : Head
    : never

  /**
   * Maps every parent state path of a state identifier to its decoded value.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type ParentStateValues<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = StateId extends StateIdentifier<States> ? {
      readonly [Parent in Extract<ParentStateIdentifier<StateId>, ValuedStateIdentifier<States>>]: StateByIdentifier<
        States,
        Parent
      >
    }
    : never

  /**
   * Extracts the nearest parent value, or `undefined` for a root state.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type ParentStateValue<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = StateId extends StateIdentifier<States> ?
    Extract<ImmediateParentStateIdentifier<StateId>, StateIdentifier<States>> extends infer Parent
      ? [Parent] extends [never] ? undefined
      : Parent extends ValuedStateIdentifier<States> ? StateByIdentifier<States, Parent>
      : undefined
    : undefined
    : never

  /**
   * Represents a decoded state value together with all of its parent values.
   *
   * @category models
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
   */
  export interface EncodedSnapshotState {
    readonly path: string
    readonly value?: unknown
  }

  /**
   * Encoded output for one completed state path in a normalized machine
   * snapshot. An omitted output represents `undefined`.
   *
   * @category models
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
   */
  export type SnapshotByIdentifierWithPath<
    States extends StateSchemas,
    StateId extends ActiveStateKey<States>,
    Path extends string
  > = States[StateId] extends { readonly type: "parallel"; readonly states: infer Children }
    ? Children extends StateSchemas ? ParallelSnapshot<
        Path,
        NodeValue<States[StateId]>,
        SnapshotRegionsWithPrefix<Children, Path>
      >
    : AtomicSnapshot<Path, NodeValue<States[StateId]>>
    : States[StateId] extends { readonly states: infer Children } ? Children extends StateSchemas ? CompoundSnapshot<
          Path,
          NodeValue<States[StateId]>,
          SnapshotWithPrefix<Children, Path>
        >
      : AtomicSnapshot<Path, NodeValue<States[StateId]>>
    : AtomicSnapshot<Path, NodeValue<States[StateId]>>

  /**
   * Extracts a complete root snapshot whose selected configuration contains a
   * particular active state.
   *
   * Parallel ancestors still require every region, while compound ancestors
   * are narrowed to the branch leading to `Owner`.
   *
   * @category utility types
   * @since 0.4.0
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
   * @since 0.4.0
   */
  export type Snapshot<States extends StateSchemas> = {
    readonly [StateId in ActiveStateKey<States>]: SnapshotByIdentifier<States, StateId & StateIdentifier<States>>
  }[ActiveStateKey<States>]

  /**
   * Extracts the root state identifier from a state path.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type RootStateIdentifier<StateId extends string> = StateId extends `${infer Root}.${string}` ? Root : StateId

  /**
   * Extracts the public snapshot shape that contains a final state path.
   *
   * @category utility types
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
   */
  export interface StateConstruction<Result> {
    readonly [Topology.StateConstructionTypeId]: Result
  }

  /**
   * Machine-bound target instruction accepted from transition handlers.
   *
   * @category models
   * @since 0.4.0
   */
  export interface Target<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > {
    readonly [Topology.TargetTypeId]: typeof Topology.TargetTypeId
    readonly [Topology.TargetSnapshotTypeId]?: SnapshotByIdentifier<States, StateId>
    readonly path: StateId
    readonly value: StateByIdentifier<States, StateId>
    readonly values?: Partial<
      {
        readonly [AncestorStateId in ValuedStateIdentifier<States>]: StateByIdentifier<States, AncestorStateId>
      }
    >
  }

  /**
   * Opaque result returned by an explicitly targetless transition.
   *
   * The transition remains handled and retains its queued commands, raised
   * events, and emitted events, but selects no concrete destination.
   *
   * @category models
   * @since 0.10.0
   */
  export interface NoTarget {
    readonly [Topology.NoTargetTypeId]: typeof Topology.NoTargetTypeId
  }

  /**
   * Opaque result returned when a declinable transition does not accept the
   * current event or lifecycle outcome.
   *
   * Declining selects no transition and discards operations enqueued by that
   * resolver. Hierarchical event and eventless dispatch continues with the
   * next eligible ancestor candidate.
   *
   * @category models
   * @since 0.17.0
   */
  export interface Declined {
    readonly [Topology.DeclinedTypeId]: typeof Topology.DeclinedTypeId
  }

  /** Static acceptance contract of one transition definition. */
  export type TransitionAcceptance = "required" | "declinable"

  /**
   * Transition instruction that restores a history pseudo-state's parent.
   *
   * Unlike ordinary targets, history targets carry no state value. The
   * planner resolves the remembered concrete configuration, or evaluates the
   * history node's typed default when no record exists.
   *
   * @category models
   * @since 0.4.0
   */
  export interface HistoryTarget<
    States extends StateSchemas,
    HistoryId extends HistoryIdentifier<States>
  > {
    readonly [Topology.HistoryTargetTypeId]: typeof Topology.HistoryTargetTypeId
    readonly path: HistoryId
    readonly parent: Extract<ParentPath<HistoryId>, StateIdentifier<States>>
  }

  /**
   * Transition instruction that enters a compound or parallel state through
   * its declared initial configuration.
   *
   * @category models
   * @since 0.13.0
   */
  export interface InitialTarget<StateId extends string> {
    readonly [Topology.TargetTypeId]: typeof Topology.TargetTypeId
    readonly [Topology.TargetSnapshotTypeId]?: never
    readonly [Topology.InitialTargetTypeId]: typeof Topology.InitialTargetTypeId
    readonly _tag: "InitialTarget"
    readonly path: StateId
    readonly value: never
    readonly values?: never
  }

  /** Branded transient target instruction used while constructing initial states. */
  export interface ChoiceTargetInstruction<ChoiceId extends string = string> {
    readonly [Topology.ChoiceTargetTypeId]: typeof Topology.ChoiceTargetTypeId
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
   * @since 0.4.0
   */
  export type FullTargetBuilder<States extends StateSchemas> = [InitialEntryStateKey<States>] extends [never] ?
    FullSnapshotBuilderWithPrefix<States>
    : FullSnapshotBuilderWithPrefix<States> & FullInitialTargetBuilder<States>

  /**
   * Builder for a complete fallback configuration containing a history owner.
   *
   * @category utility types
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * `none()` handles without selecting a destination, `local` targets the
   * nearest compound scope for the source state, `branch` targets descendants
   * of the source root, and `full` builds complete snapshots for any root.
   *
   * These builders control how the next active configuration is assembled; they
   * do not directly control state re-entry. Exit and entry paths are derived
   * from the previous and next active paths. Shared active ancestors remain
   * entered even when a `full` target supplies their values again. Use an event
   * transition with `reenter: true` when the source should explicitly exit and
   * enter again.
   *
   * @category models
   * @since 0.4.0
   */
  export interface TargetBuilder<
    States extends StateSchemas,
    Source extends StateNodeIdentifier<States>
  > {
    /**
     * Selects an explicitly targetless transition.
     *
     * The event or lifecycle outcome is handled and queued operations are
     * retained, while the current state configuration remains the transition
     * result.
     *
     * @since 0.10.0
     */
    readonly none: () => NoTarget

    /**
     * Moves to another state in the same local group. The value of the state
     * containing that group, and values in other active branches, are kept.
     *
     * @since 0.4.0
     */
    readonly local: LocalTargetBuilder<States, Source>

    /**
     * Moves to a state elsewhere under the current top-level state. Parent
     * values change only when their builder methods are explicitly called;
     * other active branches are kept.
     *
     * @since 0.4.0
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
     * @since 0.4.0
     */
    readonly full: FullTargetBuilder<States>

    /** Restores a declared shallow or deep history pseudo-state. */
    readonly history: HistoryTargetBuilder<States>
  }

  /**
   * Opaque exact destination selected while a machine definition is captured.
   * The selection contains topology only; state values are constructed later
   * by the selected branch's resolver.
   *
   * @category models
   * @since 0.14.0
   */
  export interface TargetSelection<
    out Result,
    out Path extends string | undefined = string | undefined,
    out Kind extends Topology.TargetSelectionKind = Topology.TargetSelectionKind
  > {
    readonly [Topology.TargetSelectionTypeId]: typeof Topology.TargetSelectionTypeId
    readonly kind: Kind
    readonly scope: Topology.TargetSelectionScope | undefined
    readonly path: Path
    readonly "~effect/Machine/TargetSelectionResult"?: Types.Covariant<Result>
  }

  type SelectionValue<Builder, Path extends string, Kind extends Topology.TargetSelectionKind = "state"> =
    TargetSelection<Builder, Path, Kind>

  type SelectionMethod<Builder, Path extends string, Kind extends Topology.TargetSelectionKind = "state"> = () =>
    SelectionValue<Builder, Path, Kind>

  type InitialSelectionMethod<Builder, Path extends string> = Builder extends { readonly initial: infer Initial } ? {
      readonly initial: SelectionValue<Initial, Path, "initial">
    }
    : {}

  type SelectionTreeWithPrefix<
    AllStates extends StateSchemas,
    States extends StateSchemas,
    Prefix extends string,
    Scope extends "local" | "branch",
    Builder
  > = {
    readonly [Key in Extract<ActiveStateKey<States> | ChoiceStateKey<States>, keyof Builder>]: SelectionNode<
      AllStates,
      States[Key],
      JoinPath<Prefix, Key>,
      Scope,
      Builder[Key]
    >
  }

  type SelectionNode<
    AllStates extends StateSchemas,
    Node,
    Path extends string,
    Scope extends "local" | "branch",
    Builder
  > = Node extends ChoiceStateNodeConfig ? SelectionMethod<
      Builder,
      Path,
      "choice"
    >
    : Node extends { readonly states: infer Children extends StateSchemas } ?
        & SelectionMethod<Builder, Path>
        & InitialSelectionMethod<Builder, Path>
        & SelectionTreeWithPrefix<AllStates, Children, Path, Scope, Builder>
    : SelectionMethod<Builder, Path>

  type FullSelectionNode<
    AllStates extends StateSchemas,
    Node,
    Path extends StateIdentifier<AllStates>,
    Builder
  > = Node extends { readonly states: StateSchemas } ?
      & SelectionMethod<Builder, Path>
      & InitialSelectionMethod<Builder, Path>
    : SelectionMethod<Builder, Path>

  type FullTargetSelector<States extends StateSchemas> = {
    readonly [Key in Extract<ActiveStateKey<States>, keyof FullTargetBuilder<States>>]: FullSelectionNode<
      States,
      States[Key],
      Extract<Key, StateIdentifier<States>>,
      FullTargetBuilder<States>[Key]
    >
  }

  type BranchTargetSelector<
    States extends StateSchemas,
    Source extends StateNodeIdentifier<States>,
    Root extends string = Source extends `${infer Head}.${string}` ? Head : Source
  > = Root extends ActiveStateKey<States> ? Root extends keyof BranchTargetBuilder<States, Source> ? {
        readonly [Key in Root]: SelectionNode<
          States,
          States[Key],
          Key,
          "branch",
          BranchTargetBuilder<States, Source>[Key]
        >
      }
    : {}
    : {}

  type LocalTargetSelector<
    States extends StateSchemas,
    Source extends StateNodeIdentifier<States>
  > = NearestCompoundScope<States, Source> extends infer Scope extends StateIdentifier<States> ?
    ChildrenOf<States, Scope> extends infer Children extends StateSchemas ?
      LocalTargetBuilder<States, Source> extends infer Builder ?
          & SelectionTreeWithPrefix<States, Children, Scope, "local", Builder>
          & ("with" extends keyof Builder ? {
              readonly with: SelectionValue<Builder["with"], Scope>
            }
            : {})
      : {}
    : {}
    : {}

  type HistorySelectionTree<
    AllStates extends StateSchemas,
    States extends StateSchemas,
    Prefix extends string,
    Builder
  > = {
    readonly [Key in Extract<HistoryContainingKey<States>, keyof Builder>]: States[Key] extends HistoryStateNodeConfig ?
      SelectionValue<
        Builder[Key],
        JoinPath<Prefix, Key>,
        "history"
      >
      : States[Key] extends { readonly states: infer Children extends StateSchemas } ? HistorySelectionTree<
          AllStates,
          Children,
          JoinPath<Prefix, Key>,
          Builder[Key]
        >
      : never
  }

  /**
   * Definition-time topology selector available to an ordinary transition.
   * Topology-only instructions (`none`, declared `initial` and history
   * selections, and `local.with`) are values. State and choice destinations
   * remain callable selection methods.
   */
  export interface TargetSelector<
    States extends StateSchemas,
    Source extends StateNodeIdentifier<States>
  > {
    readonly none: SelectionValue<TargetBuilder<States, Source>["none"], never, "none">
    readonly local: LocalTargetSelector<States, Source>
    readonly branch: BranchTargetSelector<States, Source>
    readonly full: FullTargetSelector<States>
    readonly history: HistorySelectionTree<States, States, "", HistoryTargetBuilder<States>>
  }

  /** Definition-time selector that can choose only a valid top-level initial entry. */
  type InitialTargetSelector<States extends StateSchemas> = {
    readonly [Key in Extract<ActiveStateKey<States>, keyof InitialBuilder<States>>]: States[Key] extends
      { readonly states: StateSchemas } ? {
        readonly initial: SelectionValue<InitialBuilder<States>[Key], Key, "initial">
      }
      : SelectionMethod<InitialBuilder<States>[Key], Key>
  }

  /**
   * Context passed to a state/event handler.
   *
   * @category models
   * @since 0.4.0
   */
  export type HandlerContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    EventTag extends TagOf<Events[number]>,
    E,
    R,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = MachineReferences<InputEvents, ParentEvents> & {
    readonly state: StateByIdentifier<States, StateId>
    readonly containingState: ParentStateValue<States, StateId>
    readonly ancestors: ParentStateValues<States, StateId>
    /** Complete logical configuration captured at the start of this microstep. */
    readonly snapshot: Snapshot<States>
    readonly event: EventByTag<Events, EventTag>

    /**
     * Provides typed builders for choosing the next active state from this
     * handler. Each builder documents which existing state values it keeps.
     *
     * @since 0.4.0
     */
    readonly target: TargetBuilder<States, StateId>
  }

  /**
   * Context passed to an entry or exit state handler.
   *
   * @category models
   * @since 0.4.0
   */
  export type StateActionContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = MachineReferences<InputEvents, ParentEvents> & {
    readonly state: StateByIdentifier<States, StateId>
    readonly containingState: ParentStateValue<States, StateId>
    readonly ancestors: ParentStateValues<States, StateId>
    readonly event: LifecycleEvent<Events>
  }

  /**
   * Context passed to a function-valued invocation source.
   *
   * @category models
   * @since 0.4.0
   */
  export type InvokeContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = MachineReferences<InputEvents, ParentEvents> & {
    readonly state: StateByIdentifier<States, StateId>
    readonly containingState: ParentStateValue<States, StateId>
    readonly ancestors: ParentStateValues<States, StateId>
    readonly event: LifecycleEvent<Events>
  }

  /**
   * Context passed to an invocation's active-snapshot transition.
   *
   * @category models
   * @since 0.4.0
   */
  export type InvokeSnapshotContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    State,
    Error,
    Output,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = MachineReferences<InputEvents, ParentEvents> & {
    readonly id: string
    readonly state: StateByIdentifier<States, StateId>
    readonly containingState: ParentStateValue<States, StateId>
    readonly ancestors: ParentStateValues<States, StateId>
    readonly target: TargetBuilder<States, StateId>
    readonly snapshot: Extract<RuntimeSnapshot<State, Error, Output>, { readonly status: "active" }>
  }

  /**
   * Context passed to an invocation's successful completion transition.
   *
   * @category models
   * @since 0.4.0
   */
  export type InvokeDoneContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    Output,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = MachineReferences<InputEvents, ParentEvents> & {
    readonly id: string
    readonly state: StateByIdentifier<States, StateId>
    readonly containingState: ParentStateValue<States, StateId>
    readonly ancestors: ParentStateValues<States, StateId>
    readonly snapshot: Snapshot<States>
    readonly target: TargetBuilder<States, StateId>
    readonly output: Output
  }

  /** Context passed to a Stream invocation's element transition. */
  export type InvokeElementContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    Element,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = MachineReferences<InputEvents, ParentEvents> & {
    readonly id: string
    readonly state: StateByIdentifier<States, StateId>
    readonly containingState: ParentStateValue<States, StateId>
    readonly ancestors: ParentStateValues<States, StateId>
    readonly snapshot: Snapshot<States>
    readonly target: TargetBuilder<States, StateId>
    readonly element: Element
  }

  /** Context passed to an invocation typed-failure transition. */
  export type InvokeFailureContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    Error,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = MachineReferences<InputEvents, ParentEvents> & {
    readonly id: string
    readonly state: StateByIdentifier<States, StateId>
    readonly containingState: ParentStateValue<States, StateId>
    readonly ancestors: ParentStateValues<States, StateId>
    readonly snapshot: Snapshot<States>
    readonly target: TargetBuilder<States, StateId>
    readonly error: Error
  }

  /**
   * Context passed to an eventless transition handler.
   *
   * @category models
   * @since 0.4.0
   */
  export type AlwaysContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = MachineReferences<InputEvents, ParentEvents> & {
    readonly state: StateByIdentifier<States, StateId>
    readonly containingState: ParentStateValue<States, StateId>
    readonly ancestors: ParentStateValues<States, StateId>
    /** Complete logical configuration captured at the start of this microstep. */
    readonly snapshot: Snapshot<States>
    readonly event: LifecycleEvent<Events>

    /**
     * Provides typed builders for choosing the next active state from this
     * eventless handler. Each builder documents which existing state values it
     * keeps.
     *
     * @since 0.4.0
     */
    readonly target: TargetBuilder<States, StateId>
  }

  /**
   * Context passed to a state completion transition handler.
   *
   * @category models
   * @since 0.4.0
   */
  export type DoneContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = MachineReferences<InputEvents, ParentEvents> & {
    readonly state: StateByIdentifier<States, StateId>
    readonly containingState: ParentStateValue<States, StateId>
    readonly ancestors: ParentStateValues<States, StateId>
    /** Complete logical configuration captured at the start of this microstep. */
    readonly snapshot: Snapshot<States>
    readonly event: LifecycleEvent<Events>
    readonly output: CompletionOutputByIdentifier<States, StateId>

    /**
     * Provides typed builders for choosing the next active state after this
     * state completes. Each builder documents which existing state values it
     * keeps.
     *
     * @since 0.4.0
     */
    readonly target: TargetBuilder<States, StateId>
  }

  /** Context passed to a transient choice resolver. There is no `state` value. */
  export type ChoiceContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    ChoiceId extends ChoiceIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = MachineReferences<InputEvents, ParentEvents> & {
    readonly containingState: StateByIdentifier<
      States,
      Extract<ImmediateParentStateIdentifier<ChoiceId>, StateIdentifier<States>>
    >
    readonly ancestors: {
      readonly [Parent in Extract<ParentStateIdentifier<ChoiceId>, ValuedStateIdentifier<States>>]: StateByIdentifier<
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
   * @since 0.4.0
   */
  export interface FinalOutputContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > {
    readonly state: StateByIdentifier<States, StateId>
    readonly containingState: ParentStateValue<States, StateId>
    readonly ancestors: ParentStateValues<States, StateId>
    readonly event: LifecycleEvent<Events>
  }

  /**
   * Extracts region outputs for a completed parallel state.
   *
   * @category utility types
   * @since 0.4.0
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
   * @since 0.4.0
   */
  export interface ParallelOutputContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>
  > {
    readonly state: StateByIdentifier<States, StateId>
    readonly containingState: ParentStateValue<States, StateId>
    readonly ancestors: ParentStateValues<States, StateId>
    readonly event: LifecycleEvent<Events>
    readonly outputs: ParallelOutputRegions<States, StateId>
  }

  /**
   * Return value accepted from entry and exit state actions.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type StateActionResult<E, R> = undefined

  /**
   * Return value accepted from a machine initial state function.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InitialResult<States extends StateSchemas, E, R> =
    | Snapshot<States>
    | InitialSnapshot<States>
    | InitialTarget<StateIdentifier<States>>
    | StateConstruction<Snapshot<States> | InitialSnapshot<States> | InitialTarget<StateIdentifier<States>>>

  /** Initial snapshots may transiently terminate in a declared choice node. */
  export type InitialSnapshot<States extends StateSchemas> = {
    readonly [StateId in ActiveStateKey<States>]: InitialSnapshotResult<States, StateId, "">
  }[ActiveStateKey<States>]

  /**
   * Return value accepted from transition handlers.
   *
   * **Details**
   *
   * Handlers return snapshots for complete state replacement, target builder
   * results for path-safe partial transitions, or `target.none()` for an
   * explicitly targetless transition. Raw decoded state values and `void` are
   * not accepted at transition boundaries.
   *
   * @category utility types
   * @since 0.4.0
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
    | NoTarget

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
   * @since 0.4.0
   */
  export type HandlerEffect<Handlers> = Handlers[keyof Handlers]
  /**
   * Extracts the error type from a handler return value.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type HandlerError<Handlers> = Effect.Error<HandlerEffect<Handlers>>
  /**
   * Extracts the service requirements from a handler return value.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type HandlerServices<Handlers> = Effect.Services<HandlerEffect<Handlers>>
  /**
   * Extracts the return value from an initial state function.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InitialReturn<Initial> = Initial extends (...args: any) => infer Ret ? Ret : never
  /**
   * Extracts the return value from an entry or exit action.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type StateActionReturn<Config, Key extends "entry" | "exit"> = Key extends keyof Config
    ? NonNullable<Config[Key]> extends (...args: any) => infer Ret ? Ret : never
    : never
  /** Extracts the return value from an implicit initial child implementation. */
  export type StateInitializeReturn<Config> = Config extends { readonly initialize?: infer Initialize }
    ? NonNullable<Initialize> extends (...args: any) => infer Ret ? Ret : never
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
  export type ChoiceReturn<Config> = Config extends { readonly choice: infer Choice } ? EventTransitionReturn<Choice>
    : never
  /**
   * Extracts the return value from an event transition config.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type EventTransitionReturn<Transition> = Transition extends (...args: any) => infer Authored ?
    Authored extends TransitionBuilderEvidence<infer Result, any> ? Result : never
    : Transition extends { readonly resolve?: infer Resolve } ?
      NonNullable<Resolve> extends (...args: any) => infer Ret ? Ret : never
    : never
  /**
   * Extracts the return value from a state's event handlers.
   *
   * @category utility types
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
   */
  export type InvokeResolvedSource<Source> = Source extends (...args: any) => infer Resolved ? Resolved : Source

  type InvokeFactoryResult<Source> = Source extends (...args: any) => infer Resolved ? Resolved : never

  type ChildMachineLogic<Child> = Child extends ChildMachine<string, infer M> ? Logic<
      Snapshot<States<M>>,
      EventInput<InputEvent<M>>,
      Error<M> | ActionError<Services<M>> | InfiniteTransitionError | MachineSchemaDecodeError | StoppedError,
      ExcludeCompatibleRuntime<
        Exclude<ExecutionServices<InitialServices<M> | Services<M>>, internalRuntime.MachineRuntime>,
        Event<M>,
        Emit<M>
      >,
      Output<M>,
      | InitialError<M>
      | Error<M>
      | ActionError<InitialServices<M> | Services<M>>
      | InfiniteTransitionError
      | MachineSchemaDecodeError
      | StartupError
      | StoppedError
    >
    : never

  export type InvokeLogic<Invoke> = Invoke extends { readonly effect: infer Source } ?
    InvokeFactoryResult<Source> extends infer Fx extends Effect.Effect<any, any, any> ? Logic<
        void,
        never,
        Effect.Error<Fx>,
        Effect.Services<Fx>,
        Effect.Success<Fx>
      >
    : never
    : Invoke extends { readonly stream: infer Source } ?
      InvokeFactoryResult<Source> extends infer SourceStream extends Stream.Stream<any, any, any> ? Logic<
          void,
          never,
          Stream.Error<SourceStream>,
          Stream.Services<SourceStream>,
          void
        >
      : never
    : Invoke extends { readonly after: unknown } ? Logic<void, never, never, never, void>
    : Invoke extends { readonly logic: infer Source } ? InvokeResolvedSource<Source>
    : Invoke extends { readonly child: infer Child } ? ChildMachineLogic<Child>
    : never
  /**
   * Extracts the startup error from an invoke source child process logic.
   *
   * @category utility types
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
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
   * @since 0.4.0
   */
  export type InvokeEmits<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly emits: Types.Covariant<infer Emitted> }
  } ? Emitted
    : Invoke extends { readonly child: ChildMachine<string, infer M> } ? Emit<M>
    : never

  /** Public parent inputs required by an invoked child machine. */
  export type InvokeParentEvents<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly parentEvents: Types.Covariant<infer ParentEvent> }
  } ? ParentEvent
    : IsAny<Invoke> extends true ? never
    : Invoke extends { readonly child: ChildMachine<string, infer M> } ? EventOf<ParentEvents<M>>
    : never
  /** Extracts transition results returned by invocation lifecycle handlers. */
  export type InvokeOutcomeReturn<Invoke> = Invoke extends unknown ?
      | (Invoke extends {
        readonly [InvokeTypeId]: { readonly outcomes: Types.Covariant<infer Outcomes> }
      } ? EventTransitionReturn<Outcomes> :
        never)
      | (Invoke extends { readonly onDone?: infer Handler } ? EventTransitionReturn<NonNullable<Handler>> : never)
      | (Invoke extends { readonly onFailure?: infer Handler } ? EventTransitionReturn<NonNullable<Handler>> : never)
      | (Invoke extends { readonly onElement?: infer Handler } ? EventTransitionReturn<NonNullable<Handler>> : never)
      | (Invoke extends { readonly onSnapshot?: infer Handler } ? EventTransitionReturn<NonNullable<Handler>> : never)
    : never
  type InvokeOutcomeError<Invoke> = IsAny<InvokeOutcomeReturn<Invoke>> extends true ? never
    : Effect.Error<InvokeOutcomeReturn<Invoke>>
  type InvokeOutcomeServices<Invoke> = IsAny<InvokeOutcomeReturn<Invoke>> extends true ? never
    : Effect.Services<InvokeOutcomeReturn<Invoke>>
  /**
   * Extracts the parent transition error contribution from invoked children.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InvokeError<Config> = [InvokeReturn<Config>] extends [never] ? never
    :
      | ChildAlreadyExistsError
      | InvokeInitialError<InvokeReturn<Config>>
      | InvokeOutcomeError<InvokeReturn<Config>>
  /**
   * Extracts the parent service requirement contribution from invoked children.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InvokeRequirements<Config> = [InvokeReturn<Config>] extends [never] ? never
    :
      | MachineRuntimeRequirement
      | InvokeServices<InvokeReturn<Config>>
      | InvokeOutcomeServices<InvokeReturn<Config>>
  /**
   * Extracts the return value from an eventless transition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type AlwaysReturn<Config> = Config extends { readonly always?: infer Always }
    ? EventTransitionReturn<NonNullable<Always>>
    : never
  /**
   * Extracts the return value from a state completion transition.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type DoneReturn<Config> = Config extends { readonly onDone?: infer OnDone }
    ? EventTransitionReturn<NonNullable<OnDone>>
    : never
  /**
   * Extracts the return value from a final state output function.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type FinalOutputReturn<Config> = Config extends { readonly output?: infer Output }
    ? NonNullable<Output> extends (...args: any) => infer Ret ? Ret : never
    : never

  /**
   * Extracts all service requirements contributed by a state handler config.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type ConfigServices<Config> =
    | Effect.Services<EventHandlerReturn<Config>>
    | Effect.Services<AlwaysReturn<Config>>
    | Effect.Services<DoneReturn<Config>>
    | Effect.Services<StateActionReturn<Config, "entry">>
    | Effect.Services<StateActionReturn<Config, "exit">>
    | Effect.Services<HistoryDefaultReturn<Config>>
    | Effect.Services<ChoiceReturn<Config>>
    | InvokeRequirements<Config>

  /** Type evidence retained by an authored transition without affecting runtime data. */
  export interface TransitionTyped<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean,
    Acceptance extends TransitionAcceptance = "required"
  > {
    readonly [TransitionTypeId]: {
      readonly owner: Types.Covariant<readonly [States, Events, Emits, StateId, Context]>
      readonly acceptance: Types.Covariant<Acceptance>
    }
  }

  /** The only transition value accepted by machine handler APIs. */
  export type TransitionConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean = false,
    Acceptance extends TransitionAcceptance = "required"
  > = TransitionBuilderInput<States, Events, Emits, StateId, Context, Reenter, Acceptance>

  export type SelectionBuilder<Selection> = Selection extends TargetSelection<infer Builder, any, any> ? Builder : never
  export type SelectionKind<Selection> = Selection extends TargetSelection<any, any, infer Kind> ? Kind : never
  export type SelectionPath<Selection> = Selection extends TargetSelection<any, infer Path, any> ? Path : never
  export type TargetBuilderResult<Builder> =
    | (Builder extends (...args: any) => infer Result ? Result : never)
    | (Builder extends { readonly from: (...args: any) => infer Result } ? Result : never)
  export type SelectedTargetResult<Selection> = SelectionBuilder<Selection> extends infer Builder ?
    TargetBuilderResult<Builder>
    : never

  type SelectionSupportsDefaultConstruction<Selection> = SelectionKind<Selection> extends "none" ? true
    : SelectionBuilder<Selection> extends { readonly from: (...args: infer Args) => any } ? [] extends Args ? true
      : false
    : SelectionBuilder<Selection> extends (...args: infer Args) => any ? [] extends Args ? true
      : false
    : false

  export type TransitionResolveContext<
    Context,
    Selection
  > =
    & Omit<Context, "target">
    & (SelectionKind<Selection> extends "none" ? {} : { readonly target: SelectionBuilder<Selection> })

  /** Context capability available only to explicitly declinable resolvers. */
  export interface DeclineCapability {
    readonly decline: () => Declined
  }

  export type TransitionResolver<
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Context,
    Selection
  > = (
    context: TransitionResolveContext<Context, Selection>,
    enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
  ) => SelectionKind<Selection> extends "none" ? undefined : SelectedTargetResult<Selection> | undefined

  export type DeclinableTransitionResolver<
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Context,
    Selection
  > = (
    context: TransitionResolveContext<Context, Selection> & DeclineCapability,
    enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
  ) =>
    | (SelectionKind<Selection> extends "none" ? undefined : SelectedTargetResult<Selection> | undefined)
    | Declined

  /** One named destination declared by a branching transition. */
  export interface TransitionBranchInput<
    Selection extends TargetSelection<any, any, any> = TargetSelection<any, any, any>
  > {
    readonly target: Selection
    readonly title?: string
  }

  /** Opaque evidence that a branching resolver selected one declared branch. */
  export interface SelectedBranch<out Key extends string, out Result> {
    readonly [Topology.SelectedBranchTypeId]: {
      readonly key: Types.Covariant<Key>
      readonly result: Types.Covariant<Result>
    }
  }

  type SelectedBranchCallable<Callable, Key extends string> = Callable extends {
    (...args: infer Arguments1): infer Result1
    (...args: infer Arguments2): infer Result2
  } ? {
      (...args: Arguments1): SelectedBranch<Key, Result1>
      (...args: Arguments2): SelectedBranch<Key, Result2>
    }
    : Callable extends (...args: infer Arguments) => infer Result ? (...args: Arguments) => SelectedBranch<Key, Result>
    : {}

  type SelectedBranchBuilderProperties<Builder, Key extends string> = {
    readonly [Property in keyof Builder]: Builder[Property] extends (...args: any) => any ?
      SelectedBranchCallable<Builder[Property], Key>
      : Builder[Property]
  }

  /** Target-specific builder that brands every construction with its branch key. */
  export type SelectedBranchBuilder<Builder, Key extends string> =
    & SelectedBranchCallable<Builder, Key>
    & SelectedBranchBuilderProperties<Builder, Key>

  export type BranchSelectors<Branches extends Readonly<Record<string, TransitionBranchInput>>> = {
    readonly [Key in Extract<keyof Branches, string>]: SelectedBranchBuilder<
      SelectionBuilder<Branches[Key]["target"]>,
      Key
    >
  }

  export type BranchSelectionResult<Branches extends Readonly<Record<string, TransitionBranchInput>>> = {
    readonly [Key in Extract<keyof Branches, string>]: SelectedBranch<
      Key,
      SelectedTargetResult<Branches[Key]["target"]>
    >
  }[Extract<keyof Branches, string>]

  export type TransitionBranchesResolveContext<
    Context,
    Branches extends Readonly<Record<string, TransitionBranchInput>>
  > = Omit<Context, "target"> & { readonly select: BranchSelectors<Branches> }

  export type TransitionBranchesResolver<
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Context,
    Branches extends Readonly<Record<string, TransitionBranchInput>>
  > = (
    context: TransitionBranchesResolveContext<Context, Branches>,
    enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
  ) => BranchSelectionResult<Branches>

  export type DeclinableTransitionBranchesResolver<
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Context,
    Branches extends Readonly<Record<string, TransitionBranchInput>>
  > = (
    context: TransitionBranchesResolveContext<Context, Branches> & DeclineCapability,
    enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
  ) => BranchSelectionResult<Branches> | Declined

  /** @internal Type evidence retained by a transition authored through its bound selector. */
  export interface TransitionBuilderEvidence<out Result, out Acceptance extends TransitionAcceptance> {
    readonly [TransitionBuilderTypeId]: {
      readonly result: Types.Covariant<Result>
      readonly acceptance: Types.Covariant<Acceptance>
    }
  }

  type TransitionReenterOption<Reenter extends boolean> = [Reenter] extends [true] ? { readonly reenter?: boolean }
    : { readonly reenter?: never }

  type TransitionRequiredOptions<Reenter extends boolean> =
    & TransitionReenterOption<Reenter>
    & { readonly declinable?: false }

  type TransitionDeclinableOptions<Reenter extends boolean> =
    & TransitionReenterOption<Reenter>
    & { readonly declinable: true }

  type BuiltTransition<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean,
    Result,
    Acceptance extends TransitionAcceptance
  > =
    & TransitionTyped<States, Events, Emits, StateId, Context, Reenter, Acceptance>
    & TransitionBuilderEvidence<Result, Acceptance>

  interface TransitionResolveRequired<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean,
    Selection extends TargetSelection<any, any, any>
  > {
    (
      resolve: TransitionResolver<Events, Emits, Context, Selection>,
      options?: TransitionRequiredOptions<Reenter>
    ): BuiltTransition<
      States,
      Events,
      Emits,
      StateId,
      Context,
      Reenter,
      SelectionKind<Selection> extends "none" ? undefined : SelectedTargetResult<Selection> | undefined,
      "required"
    >
  }

  interface TransitionResolveDeclinable<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean,
    Selection extends TargetSelection<any, any, any>
  > {
    (
      resolve: DeclinableTransitionResolver<Events, Emits, Context, Selection>,
      options: TransitionDeclinableOptions<Reenter>
    ): BuiltTransition<
      States,
      Events,
      Emits,
      StateId,
      Context,
      Reenter,
      | (SelectionKind<Selection> extends "none" ? undefined : SelectedTargetResult<Selection> | undefined)
      | Declined,
      "declinable"
    >
  }

  /** A selected transition target with target-specific resolver operations. */
  export type TransitionTarget<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean,
    Acceptance extends TransitionAcceptance,
    Selection extends TargetSelection<any, any, any>
  > =
    & Selection
    & (SelectionSupportsDefaultConstruction<Selection> extends true ? BuiltTransition<
        States,
        Events,
        Emits,
        StateId,
        Context,
        Reenter,
        SelectionKind<Selection> extends "none" ? undefined : SelectedTargetResult<Selection> | undefined,
        "required"
      >
      : {})
    & {
      readonly resolve:
        & TransitionResolveRequired<States, Events, Emits, StateId, Context, Reenter, Selection>
        & ("declinable" extends Acceptance ? TransitionResolveDeclinable<
            States,
            Events,
            Emits,
            StateId,
            Context,
            Reenter,
            Selection
          >
          : {})
    }
    & ([Reenter] extends [true] ? SelectionSupportsDefaultConstruction<Selection> extends true ? {
          readonly reenter: () => BuiltTransition<
            States,
            Events,
            Emits,
            StateId,
            Context,
            Reenter,
            SelectionKind<Selection> extends "none" ? undefined : SelectedTargetResult<Selection> | undefined,
            "required"
          >
        }
      : {}
      : {})

  /** @internal Type evidence retained by a machine initial-entry declaration. */
  export interface InitialBuilderEvidence<out Selection> {
    readonly [InitialBuilderTypeId]: Types.Covariant<Selection>
  }

  /** A selected machine initial entry with its exact resolver target. */
  export type InitialTransitionTarget<Input, Selection extends TargetSelection<any, any, any>> =
    & Selection
    & (SelectionSupportsDefaultConstruction<Selection> extends true ? InitialBuilderEvidence<Selection> : {})
    & {
      readonly resolve: (
        resolve: (context: {
          readonly input: Input
          readonly target: SelectionBuilder<Selection>
        }) => SelectedTargetResult<Selection>
      ) => InitialBuilderEvidence<Selection>
    }

  type InitialSelectorNode<Input, Node> = Node extends (...args: infer Args) => infer Selection ?
    Selection extends TargetSelection<any, any, any> ?
        & ((...args: Args) => InitialTransitionTarget<Input, Selection>)
        & {
          readonly [Key in keyof Node]: InitialSelectorNode<Input, Node[Key]>
        }
    : never
    : Node extends TargetSelection<any, any, any> ? InitialTransitionTarget<Input, Node>
    : {
      readonly [Key in keyof Node]: InitialSelectorNode<Input, Node[Key]>
    }

  /** Definition-time selector for a machine's top-level initial entry. */
  export type InitialSelector<States extends StateSchemas, Input = void> = InitialSelectorNode<
    Input,
    InitialTargetSelector<States>
  >

  /** Target-first initial-entry declaration accepted by {@link make}. */
  export type InitialBuilderInput<States extends StateSchemas, Input> = (
    to: InitialSelector<States, Input>
  ) => InitialBuilderEvidence<TargetSelection<any, any, any>>

  type TransitionSelectorNode<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean,
    Acceptance extends TransitionAcceptance,
    Node
  > = Node extends (...args: infer Args) => infer Selection ? Selection extends TargetSelection<any, any, any> ?
        & ((...args: Args) => TransitionTarget<
          States,
          Events,
          Emits,
          StateId,
          Context,
          Reenter,
          Acceptance,
          Selection
        >)
        & {
          readonly [Key in keyof Node]: TransitionSelectorNode<
            States,
            Events,
            Emits,
            StateId,
            Context,
            Reenter,
            Acceptance,
            Node[Key]
          >
        }
    : never
    : Node extends TargetSelection<any, any, any> ? TransitionTarget<
        States,
        Events,
        Emits,
        StateId,
        Context,
        Reenter,
        Acceptance,
        Node
      >
    : {
      readonly [Key in keyof Node]: TransitionSelectorNode<
        States,
        Events,
        Emits,
        StateId,
        Context,
        Reenter,
        Acceptance,
        Node[Key]
      >
    }

  interface TransitionBranchesResolveRequired<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean,
    Branches extends Readonly<Record<string, TransitionBranchInput>>
  > {
    (
      resolve: TransitionBranchesResolver<Events, Emits, Context, Branches>,
      options?: TransitionRequiredOptions<Reenter>
    ): BuiltTransition<
      States,
      Events,
      Emits,
      StateId,
      Context,
      Reenter,
      BranchSelectionResult<Branches>,
      "required"
    >
  }

  interface TransitionBranchesResolveDeclinable<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean,
    Branches extends Readonly<Record<string, TransitionBranchInput>>
  > {
    (
      resolve: DeclinableTransitionBranchesResolver<Events, Emits, Context, Branches>,
      options: TransitionDeclinableOptions<Reenter>
    ): BuiltTransition<
      States,
      Events,
      Emits,
      StateId,
      Context,
      Reenter,
      BranchSelectionResult<Branches> | Declined,
      "declinable"
    >
  }

  /** Selector supplied to inline transition declarations. */
  export type TransitionSelector<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean,
    Acceptance extends TransitionAcceptance
  > =
    & TransitionSelectorNode<
      States,
      Events,
      Emits,
      StateId,
      Context,
      Reenter,
      Acceptance,
      TargetSelector<States, StateId>
    >
    & {
      readonly branches: <const Branches extends Readonly<Record<string, TransitionBranchInput>>>(
        branches: Branches & ValidateTransitionBranchRecord<NoInfer<Branches>>
      ) => {
        readonly resolve:
          & TransitionBranchesResolveRequired<States, Events, Emits, StateId, Context, Reenter, Branches>
          & ("declinable" extends Acceptance ? TransitionBranchesResolveDeclinable<
              States,
              Events,
              Emits,
              StateId,
              Context,
              Reenter,
              Branches
            >
            : {})
      }
    }

  /** Inline transition declaration accepted by state and invocation handlers. */
  export type TransitionBuilderInput<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean,
    Acceptance extends TransitionAcceptance
  > = (
    to: TransitionSelector<States, Events, Emits, StateId, Context, Reenter, Acceptance>
  ) =>
    & TransitionTyped<States, Events, Emits, StateId, Context, Reenter, Acceptance>
    & TransitionBuilderEvidence<any, Acceptance>

  export type InvokeTransition<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context
  > = TransitionConfig<States, Events, Emits, StateId, Context, true, TransitionAcceptance>

  export type InvokeSource<Value, Context> = Value | ((context: Context) => Value)

  /** Inline state-owned work that runs for the lifetime of its active state. */
  export interface InvokeOwned<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > {
    readonly "~effect/Machine/InvokeOwner"?: Types.Covariant<
      readonly [States, Events, Emits, StateId, InputEvents, ParentEvents]
    >
  }

  /** Type evidence retained by a completed state-owned invocation. */
  export interface InvokeTyped<
    Output,
    Error,
    Requirements,
    InitialError,
    Emits = never,
    ParentEvent = never,
    Outcomes = never
  > {
    readonly [InvokeTypeId]: {
      readonly output: Types.Covariant<Output>
      readonly error: Types.Covariant<Error>
      readonly requirements: Types.Covariant<Requirements>
      readonly initialError: Types.Covariant<InitialError>
      readonly emits: Types.Covariant<Emits>
      readonly parentEvents: Types.Covariant<ParentEvent>
      readonly outcomes: Types.Covariant<Outcomes>
    }
  }

  type StoredInvokeConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > =
    & InvokeOwned<States, Events, Emits, StateId, InputEvents, ParentEvents>
    & (
      | {
        readonly id: string
        readonly effect: (
          context: InvokeContext<States, Events, Emits, StateId, InputEvents, ParentEvents>
        ) => Effect.Effect<any, any, any>
        readonly stream?: never
        readonly after?: never
        readonly logic?: never
        readonly child?: never
        readonly address?: never
        readonly onDone?: unknown
        readonly onFailure?: unknown
        readonly onElement?: never
        readonly onSnapshot?: never
      }
      | {
        readonly id: string
        readonly stream: (
          context: InvokeContext<States, Events, Emits, StateId, InputEvents, ParentEvents>
        ) => Stream.Stream<any, any, any>
        readonly effect?: never
        readonly after?: never
        readonly logic?: never
        readonly child?: never
        readonly address?: never
        readonly onElement?: unknown
        readonly onDone: unknown
        readonly onFailure?: unknown
        readonly onSnapshot?: never
      }
      | {
        readonly id: string
        readonly after: InvokeSource<
          Duration.Input,
          InvokeContext<States, Events, Emits, StateId, InputEvents, ParentEvents>
        >
        readonly effect?: never
        readonly stream?: never
        readonly logic?: never
        readonly child?: never
        readonly address?: never
        readonly onDone: unknown
        readonly onFailure?: never
        readonly onElement?: never
        readonly onSnapshot?: never
      }
      | {
        readonly id: string
        readonly address: string
        readonly logic: InvokeSource<
          Logic<any, any, any, any, any, any>,
          InvokeContext<States, Events, Emits, StateId, InputEvents, ParentEvents>
        >
        readonly effect?: never
        readonly stream?: never
        readonly after?: never
        readonly child?: never
        readonly onDone?: unknown
        readonly onFailure?: unknown
        readonly onElement?: never
        readonly onSnapshot?: unknown
      }
      | {
        readonly child: ChildMachine.Any
        readonly input?:
          | {}
          | null
          | ((context: InvokeContext<States, Events, Emits, StateId, InputEvents, ParentEvents>) => unknown)
        readonly id?: never
        readonly address?: never
        readonly effect?: never
        readonly stream?: never
        readonly after?: never
        readonly logic?: never
        readonly onDone?: unknown
        readonly onFailure?: unknown
        readonly onElement?: never
        readonly onSnapshot?: unknown
      }
    )

  type StoredInvokeDefinition<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > =
    | StoredInvokeConfig<States, Events, Emits, StateId, InputEvents, ParentEvents>
    | ReadonlyArray<StoredInvokeConfig<States, Events, Emits, StateId, InputEvents, ParentEvents>>

  type LogicInitialEffectOf<Value> = Value extends { readonly initial: infer Initial } ?
    Initial extends (...args: ReadonlyArray<any>) => infer Result ? Result : never
    : never

  type LogicRunEffectOf<Value> = Value extends { readonly run: infer Run } ?
    Run extends (...args: ReadonlyArray<any>) => infer Result ? Result : never
    : never

  export type LogicStateOf<Value> = Effect.Success<LogicInitialEffectOf<Value>>
  export type LogicEventOf<Value> = Value extends { readonly initial: infer Initial } ?
    Initial extends (scope: infer LogicScope, ...args: ReadonlyArray<any>) => any ?
      LogicScope extends Logic.Scope<infer Event> ? Event : never
    : never
    : never
  export type LogicErrorOf<Value> = Effect.Error<LogicRunEffectOf<Value>>
  export type LogicServicesOf<Value> = Effect.Services<LogicInitialEffectOf<Value> | LogicRunEffectOf<Value>>
  export type LogicOutputOf<Value> = Effect.Success<LogicRunEffectOf<Value>>
  export type LogicInitialErrorOf<Value> = Effect.Error<LogicInitialEffectOf<Value>>

  type RequiredInvokeChannel<Value, Channel extends string> = IsAny<Value> extends true ? Channel
    : [Value] extends [never] ? never
    : Channel

  type InvokeBuilderResult<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema>,
    ParentEvents extends ReadonlyArray<TaggedSchema>,
    Output,
    Error,
    Requirements,
    InitialError,
    ChildEmits,
    ChildParentEvent,
    Outcomes
  > =
    & InvokeOwned<States, Events, Emits, StateId, InputEvents, ParentEvents>
    & InvokeTyped<Output, Error, Requirements, InitialError, ChildEmits, ChildParentEvent, Outcomes>
    & { readonly [InvokeBuilderTypeId]: true }

  type InvokeBuilder<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema>,
    ParentEvents extends ReadonlyArray<TaggedSchema>,
    Output,
    Error,
    Requirements,
    InitialError,
    ChildEmits,
    ChildParentEvent,
    Element,
    Pending extends string,
    SnapshotHandler,
    Outcomes = never
  > =
    & ([Pending] extends [never] ? InvokeBuilderResult<
        States,
        Events,
        Emits,
        StateId,
        InputEvents,
        ParentEvents,
        Output,
        Error,
        Requirements,
        InitialError,
        ChildEmits,
        ChildParentEvent,
        Outcomes
      >
      : {})
    & ("done" extends Pending ? {
        readonly onDone: <
          const Handler extends InvokeTransition<
            States,
            Events,
            Emits,
            StateId,
            InvokeDoneContext<States, Events, Emits, StateId, Output, InputEvents, ParentEvents>
          >
        >(
          handler:
            & Handler
            & InvokeTransition<
              States,
              Events,
              Emits,
              StateId,
              InvokeDoneContext<States, Events, Emits, StateId, Output, InputEvents, ParentEvents>
            >
        ) => InvokeBuilder<
          States,
          Events,
          Emits,
          StateId,
          InputEvents,
          ParentEvents,
          Output,
          Error,
          Requirements,
          InitialError,
          ChildEmits,
          ChildParentEvent,
          Element,
          Exclude<Pending, "done">,
          SnapshotHandler,
          Outcomes | Handler
        >
      }
      : {})
    & ("failure" extends Pending ? {
        readonly onFailure: <
          const Handler extends InvokeTransition<
            States,
            Events,
            Emits,
            StateId,
            InvokeFailureContext<States, Events, Emits, StateId, Error, InputEvents, ParentEvents>
          >
        >(
          handler:
            & Handler
            & InvokeTransition<
              States,
              Events,
              Emits,
              StateId,
              InvokeFailureContext<States, Events, Emits, StateId, Error, InputEvents, ParentEvents>
            >
        ) => InvokeBuilder<
          States,
          Events,
          Emits,
          StateId,
          InputEvents,
          ParentEvents,
          Output,
          Error,
          Requirements,
          InitialError,
          ChildEmits,
          ChildParentEvent,
          Element,
          Exclude<Pending, "failure">,
          SnapshotHandler,
          Outcomes | Handler
        >
      }
      : {})
    & ("element" extends Pending ? {
        readonly onElement: <
          const Handler extends InvokeTransition<
            States,
            Events,
            Emits,
            StateId,
            InvokeElementContext<States, Events, Emits, StateId, Element, InputEvents, ParentEvents>
          >
        >(
          handler:
            & Handler
            & InvokeTransition<
              States,
              Events,
              Emits,
              StateId,
              InvokeElementContext<States, Events, Emits, StateId, Element, InputEvents, ParentEvents>
            >
        ) => InvokeBuilder<
          States,
          Events,
          Emits,
          StateId,
          InputEvents,
          ParentEvents,
          Output,
          Error,
          Requirements,
          InitialError,
          ChildEmits,
          ChildParentEvent,
          Element,
          Exclude<Pending, "element">,
          SnapshotHandler,
          Outcomes | Handler
        >
      }
      : {})
    & ([SnapshotHandler] extends [never] ? {} : {
      readonly onSnapshot: <const Handler extends SnapshotHandler>(handler: Handler & SnapshotHandler) => InvokeBuilder<
        States,
        Events,
        Emits,
        StateId,
        InputEvents,
        ParentEvents,
        Output,
        Error,
        Requirements,
        InitialError,
        ChildEmits,
        ChildParentEvent,
        Element,
        Pending,
        never,
        Outcomes | Handler
      >
    })

  type EffectInvokeBuilder<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema>,
    ParentEvents extends ReadonlyArray<TaggedSchema>,
    Source extends (...args: ReadonlyArray<any>) => Effect.Effect<any, any, any>
  > = InvokeBuilder<
    States,
    Events,
    Emits,
    StateId,
    InputEvents,
    ParentEvents,
    Effect.Success<ReturnType<Source>>,
    Effect.Error<ReturnType<Source>>,
    Effect.Services<ReturnType<Source>>,
    never,
    never,
    never,
    never,
    | RequiredInvokeChannel<Effect.Success<ReturnType<Source>>, "done">
    | RequiredInvokeChannel<Effect.Error<ReturnType<Source>>, "failure">,
    never
  >

  type StreamInvokeBuilder<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema>,
    ParentEvents extends ReadonlyArray<TaggedSchema>,
    Source extends (...args: ReadonlyArray<any>) => Stream.Stream<any, any, any>
  > = InvokeBuilder<
    States,
    Events,
    Emits,
    StateId,
    InputEvents,
    ParentEvents,
    void,
    Stream.Error<ReturnType<Source>>,
    Stream.Services<ReturnType<Source>>,
    never,
    never,
    never,
    Stream.Success<ReturnType<Source>>,
    | "done"
    | RequiredInvokeChannel<Stream.Success<ReturnType<Source>>, "element">
    | RequiredInvokeChannel<Stream.Error<ReturnType<Source>>, "failure">,
    never
  >

  type LogicInvokeBuilder<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema>,
    ParentEvents extends ReadonlyArray<TaggedSchema>,
    ChildLogic
  > = InvokeBuilder<
    States,
    Events,
    Emits,
    StateId,
    InputEvents,
    ParentEvents,
    LogicOutputOf<ChildLogic>,
    LogicErrorOf<ChildLogic>,
    LogicServicesOf<ChildLogic>,
    LogicInitialErrorOf<ChildLogic>,
    never,
    never,
    never,
    | RequiredInvokeChannel<LogicOutputOf<ChildLogic>, "done">
    | RequiredInvokeChannel<LogicErrorOf<ChildLogic>, "failure">,
    InvokeTransition<
      States,
      Events,
      Emits,
      StateId,
      InvokeSnapshotContext<
        States,
        Events,
        Emits,
        StateId,
        LogicStateOf<ChildLogic>,
        LogicErrorOf<ChildLogic>,
        LogicOutputOf<ChildLogic>,
        InputEvents,
        ParentEvents
      >
    >
  >

  type ChildInvokeBuilder<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema>,
    ParentEvents extends ReadonlyArray<TaggedSchema>,
    Child extends ChildMachine.Any,
    ChildDefinition extends Machine.Any = Child["machine"]
  > = InvokeBuilder<
    States,
    Events,
    Emits,
    StateId,
    InputEvents,
    ParentEvents,
    Output<ChildDefinition>,
    Error<ChildDefinition> | ActionError<Services<ChildDefinition>>,
    Services<ChildDefinition>,
    InitialError<ChildDefinition>,
    Emit<ChildDefinition>,
    EventOf<Machine.ParentEvents<ChildDefinition>>,
    never,
    | RequiredInvokeChannel<Output<ChildDefinition>, "done">
    | RequiredInvokeChannel<Error<ChildDefinition> | ActionError<Services<ChildDefinition>>, "failure">,
    InvokeTransition<
      States,
      Events,
      Emits,
      StateId,
      InvokeSnapshotContext<
        States,
        Events,
        Emits,
        StateId,
        Snapshot<Machine.States<ChildDefinition>>,
        Error<ChildDefinition>,
        Output<ChildDefinition>,
        InputEvents,
        ParentEvents
      >
    >
  >

  /**
   * Selects state-owned work and begins its lifecycle-handler chain.
   *
   * Each source exposes exactly the lifecycle methods that it can produce. A
   * chain becomes returnable from `invoke` only after every reachable required
   * channel has been handled.
   *
   * @category models
   * @since 0.18.0
   */
  export interface InvokeSelector<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > {
    /** Starts a fresh Effect each time the owning state is entered. */
    readonly effect: <
      const Source extends (
        context: InvokeContext<States, Events, Emits, StateId, InputEvents, ParentEvents>
      ) => Effect.Effect<unknown, unknown, unknown>
    >(
      id: InvokeLifecycleId,
      source: Source
    ) => EffectInvokeBuilder<States, Events, Emits, StateId, InputEvents, ParentEvents, Source>

    /** Starts a fresh, backpressured Stream each time the owning state is entered. */
    readonly stream: <
      const Source extends (
        context: InvokeContext<States, Events, Emits, StateId, InputEvents, ParentEvents>
      ) => Stream.Stream<unknown, unknown, any>
    >(
      id: InvokeLifecycleId,
      source: Source
    ) => StreamInvokeBuilder<States, Events, Emits, StateId, InputEvents, ParentEvents, Source>

    /** Starts a cancellable state-scoped timer. */
    readonly timer: (
      id: InvokeLifecycleId,
      duration: InvokeSource<
        Duration.Input,
        InvokeContext<States, Events, Emits, StateId, InputEvents, ParentEvents>
      >
    ) => InvokeBuilder<
      States,
      Events,
      Emits,
      StateId,
      InputEvents,
      ParentEvents,
      void,
      never,
      never,
      never,
      never,
      never,
      never,
      "done",
      never
    >

    /** Starts reusable process logic at a typed parent-local address. */
    readonly logic: {
      <
        const Source extends (
          context: InvokeContext<States, Events, Emits, StateId, InputEvents, ParentEvents>
        ) => unknown,
        Address extends ChildAddress<never>
      >(
        id: InvokeLifecycleId,
        options: {
          readonly address:
            & Address
            & ChildAddress.Compatibility<Address, LogicEventOf<ReturnType<NoInfer<Source>>>>
          readonly logic: Source
        },
        ..._validation: ReturnType<Source> extends { readonly initial: unknown; readonly run: unknown } ? [] : [
          "logic factory must return Machine.Logic"
        ]
      ): LogicInvokeBuilder<
        States,
        Events,
        Emits,
        StateId,
        InputEvents,
        ParentEvents,
        ReturnType<Source>
      >
      <const Source, Address extends ChildAddress<never>>(
        id: InvokeLifecycleId,
        options: {
          readonly address: Address & ChildAddress.Compatibility<Address, LogicEventOf<NoInfer<Source>>>
          readonly logic: Source
        },
        ..._validation: Source extends { readonly initial: unknown; readonly run: unknown } ? [] : [
          "logic must implement Machine.Logic"
        ]
      ): LogicInvokeBuilder<
        States,
        Events,
        Emits,
        StateId,
        InputEvents,
        ParentEvents,
        Source
      >
    }

    /** Starts a complete child statechart represented by a reusable descriptor. */
    readonly child: <const Child extends ChildMachine.Any>(
      child:
        & Child
        & (Child["machine"] extends EnsureExecutable<
          Machine.States<Child["machine"]>,
          Machine.UnhandledStates<Child["machine"]>,
          Machine.OutputStates<Child["machine"]>
        > ? unknown
          : never),
      ...options: InputSchema<Child["machine"]> extends typeof Schema.Void ? [options?: { readonly input?: never }]
        : [options: {
          readonly input: InvokeSource<
            Input<Child["machine"]>,
            InvokeContext<States, Events, Emits, StateId, InputEvents, ParentEvents>
          >
        }]
    ) => ChildInvokeBuilder<States, Events, Emits, StateId, InputEvents, ParentEvents, Child>
  }

  /**
   * Inline invocation declaration accepted by an active state handler.
   *
   * Return one completed source chain or an array of completed chains. Source
   * computations and child descriptors may be extracted, but the chain stays
   * local to preserve the owning state and machine protocols.
   *
   * @category models
   * @since 0.18.0
   */
  export type InvokeBuilderInput<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = (
    from: InvokeSelector<States, Events, Emits, StateId, InputEvents, ParentEvents>
  ) =>
    | (InvokeOwned<States, Events, Emits, StateId, InputEvents, ParentEvents> & {
      readonly [InvokeBuilderTypeId]: true
    })
    | ReadonlyArray<
      InvokeOwned<States, Events, Emits, StateId, InputEvents, ParentEvents> & {
        readonly [InvokeBuilderTypeId]: true
      }
    >

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
   * @since 0.4.0
   */
  export type ActiveStateConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    E,
    R,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = {
    readonly entry?: (
      context: StateActionContext<States, Events, Emits, StateId, InputEvents, ParentEvents>,
      enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
    ) => StateActionResult<any, any>
    readonly exit?: (
      context: StateActionContext<States, Events, Emits, StateId, InputEvents, ParentEvents>,
      enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
    ) => StateActionResult<any, any>
    readonly invoke?: InvokeBuilderInput<States, Events, Emits, StateId, InputEvents, ParentEvents>
    readonly always?: TransitionConfig<
      States,
      Events,
      Emits,
      StateId,
      AlwaysContext<States, Events, Emits, StateId, InputEvents, ParentEvents>,
      false,
      TransitionAcceptance
    >
    readonly onDone?: TransitionConfig<
      States,
      Events,
      Emits,
      StateId,
      DoneContext<States, Events, Emits, StateId, InputEvents, ParentEvents>,
      false,
      TransitionAcceptance
    >
    readonly on?: {
      readonly [EventTag in TagOf<Events[number]>]?: TransitionConfig<
        States,
        Events,
        Emits,
        StateId,
        HandlerContext<States, Events, Emits, StateId, EventTag, E, R, InputEvents, ParentEvents>,
        true,
        TransitionAcceptance
      >
    }
    readonly initialize?: StateInitializeHandler<States, Events, Emits, StateId, InputEvents, ParentEvents>
  } & ActiveOutputHandlerConfig<States, Events, StateId>

  /**
   * Values constructed for a state's schema-valued direct initial children.
   *
   * @category utility types
   * @since 0.13.0
   */
  export type StateInitializeValue<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = NodeByIdentifier<States, StateId> extends infer Node ?
    Node extends { readonly type: "parallel"; readonly states: infer Children extends StateSchemas } ? {
        readonly [Key in ActiveStateKey<Children> as NodeSchema<Children[Key]> extends never ? never : Key]: NodeValue<
          Children[Key]
        >
      }
    : Node extends { readonly states: infer Children extends StateSchemas; readonly initial: infer Initial } ?
      Initial extends ActiveStateKey<Children> ? NodeSchema<Children[Initial]> extends never ? never
        : { readonly [Key in Initial]: NodeValue<Children[Initial]> }
      : never
    : never
    : never

  type StateInitializeCompoundBuilder<Node, Initial extends PropertyKey> = Node extends {
    readonly states: infer Children extends StateSchemas
  } ? Initial extends ActiveStateKey<Children> ? NodeSchema<Children[Initial]> extends never ? never
      : NodeBuilderMethod<
        Children[Initial],
        readonly [value: NodeValue<Children[Initial]>],
        SnapshotBuilderComplete<{ readonly [Key in Initial]: NodeValue<Children[Initial]> }>,
        readonly [input: NodeMakeInput<Children[Initial]>],
        SnapshotBuilderComplete<{ readonly [Key in Initial]: NodeValue<Children[Initial]> }, true>
      >
    : never
    : never

  type StateInitializeParallelBuilder<
    Children extends StateSchemas,
    Remaining extends ActiveStateKey<Children> = {
      readonly [Key in ActiveStateKey<Children>]: NodeSchema<Children[Key]> extends never ? never : Key
    }[ActiveStateKey<Children>],
    Values = {},
    Constructed extends boolean = false
  > =
    & SnapshotBuilderComplete<Values, Constructed>
    & {
      readonly [Key in Remaining]: NodeBuilderMethod<
        Children[Key],
        readonly [value: NodeValue<Children[Key]>],
        StateInitializeParallelBuilder<
          Children,
          Exclude<Remaining, Key>,
          Values & { readonly [Region in Key]: NodeValue<Children[Key]> },
          Constructed
        >,
        readonly [input: NodeMakeInput<Children[Key]>],
        StateInitializeParallelBuilder<
          Children,
          Exclude<Remaining, Key>,
          Values & { readonly [Region in Key]: NodeValue<Children[Key]> },
          true
        >
      >
    }

  /**
   * Builder bound to the direct initial child or regions owned by a state.
   *
   * @category utility types
   * @since 0.13.0
   */
  export type StateInitializeBuilder<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>,
    Node = NodeByIdentifier<States, StateId>
  > = Node extends { readonly type: "parallel"; readonly states: infer Children extends StateSchemas } ?
    StateInitializeParallelBuilder<Children>
    : Node extends { readonly initial: infer Initial } ? StateInitializeCompoundBuilder<Node, Initial & PropertyKey>
    : never

  /**
   * Context passed to an implicit child-state initializer.
   *
   * @category models
   * @since 0.13.0
   */
  export type StateInitializeContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = StateActionContext<States, Events, Emits, StateId, InputEvents, ParentEvents> & {
    readonly builder: StateInitializeBuilder<States, StateId>
  }

  /**
   * Initial child value implementation for a compound or parallel state.
   *
   * @category models
   * @since 0.13.0
   */
  export type StateInitializeHandler<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = (
    context: StateInitializeContext<States, Events, Emits, StateId, InputEvents, ParentEvents>,
    enqueue: Enqueue<EventOf<Events>, EmitOf<Emits>>
  ) => SnapshotBuilderComplete<StateInitializeValue<States, StateId>, boolean>

  /** Context used only when a history node has no previously captured record. */
  export interface HistoryDefaultContext<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    ParentId extends StateIdentifier<States>
  > {
    readonly event: LifecycleEvent<Events>
    readonly target: HistoryDefaultTargetBuilder<States, ParentId>
    readonly owner: ParentId
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
    ChoiceId extends ChoiceIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > {
    readonly choice: TransitionConfig<
      States,
      Events,
      Emits,
      ChoiceId,
      ChoiceContext<States, Events, Emits, ChoiceId, InputEvents, ParentEvents>
    >
    readonly entry?: never
    readonly exit?: never
    readonly invoke?: never
    readonly always?: never
    readonly on?: never
    readonly onDone?: never
    readonly output?: never
    readonly initialize?: never
  }

  /**
   * Configuration accepted for a final state.
   *
   * @category models
   * @since 0.4.0
   */
  export type FinalStateConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = {
    readonly entry?: (
      context: StateActionContext<States, Events, Emits, StateId, InputEvents, ParentEvents>,
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
   * @since 0.4.0
   */
  export type HandlerConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    E,
    R,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > = NodeByIdentifier<States, StateId> extends { readonly type: "final" } ?
    FinalStateConfig<States, Events, Emits, StateId, InputEvents, ParentEvents>
    : ActiveStateConfig<States, Events, Emits, StateId, E, R, InputEvents, ParentEvents>

  type HandlerNodeConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Path extends StateNodeIdentifier<States>,
    E,
    R,
    InputEvents extends ReadonlyArray<TaggedSchema>,
    ParentEvents extends ReadonlyArray<TaggedSchema>
  > = Path extends ChoiceIdentifier<States> ? ChoiceStateConfig<States, Events, Emits, Path, InputEvents, ParentEvents>
    : Path extends StateIdentifier<States> ? HandlerConfig<States, Events, Emits, Path, E, R, InputEvents, ParentEvents>
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
    InputEvents extends ReadonlyArray<TaggedSchema>,
    ParentEvents extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<AllStates>
  > =
    & HandlerNodeConfig<AllStates, Events, Emits, StateId, E, R, InputEvents, ParentEvents>
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
            InputEvents,
            ParentEvents,
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
    InputEvents extends ReadonlyArray<TaggedSchema>,
    ParentEvents extends ReadonlyArray<TaggedSchema>,
    Prefix extends string
  > = {
    readonly [Key in ActiveStateKey<States> | ChoiceStateKey<States>]?: HandlerNode<
      AllStates,
      States[Key],
      Events,
      Emits,
      E,
      R,
      InputEvents,
      ParentEvents,
      HandlerNodeId<AllStates, JoinPath<Prefix, Key>>
    >
  }

  type HandlerNodeConfigKey =
    | "always"
    | "choice"
    | "entry"
    | "exit"
    | "history"
    | "initialize"
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

  type TransitionResultInitialTargetPath<Result> = IsAny<Result> extends true ? never
    : Result extends Effect.Effect<infer Success, any, any> ? TransitionResultInitialTargetPath<Success>
    : Result extends SelectedBranch<any, infer Selected> ? TransitionResultInitialTargetPath<Selected>
    : Result extends StateConstruction<infer Constructed> ? TransitionResultInitialTargetPath<Constructed>
    : Result extends {
      readonly [Topology.InitialTargetTypeId]: typeof Topology.InitialTargetTypeId
      readonly _tag: "InitialTarget"
    } ? Result extends { readonly path: infer Path extends string } ? Path : never
    : never

  type HandlerConfigInitialTargetPath<Config> = TransitionResultInitialTargetPath<
    | EventHandlerReturn<Config>
    | AlwaysReturn<Config>
    | DoneReturn<Config>
    | ChoiceReturn<Config>
    | InvokeOutcomeReturn<InvokeReturn<Config>>
  >

  type RequiredInitializersForTargetPath<
    AllStates extends StateSchemas,
    Path
  > = string extends Path ? never : Path extends StateIdentifier<AllStates> ? InitializerClosureForNode<
      AllStates,
      NodeByIdentifier<AllStates, Path>,
      Path
    >
  : never

  type HandlerInitializeValidationAtPath<Config, Path extends string> = HandlerConfigAtPath<Config, Path> extends
    infer StateConfig ? [StateConfig] extends [never] ? HandlerValidationAtPath<Path, {
        readonly initialize: HandlerValidationError<
          "State requires initialize because a transition enters its declared initial configuration",
          Path
        >
      }>
    : "initialize" extends keyof StateConfig ? never
    : HandlerValidationAtPath<Path, {
      readonly initialize: HandlerValidationError<
        "State requires initialize because a transition enters its declared initial configuration",
        Path
      >
    }>
    : never

  type HandlerInitialTargetValidationForPaths<
    AllStates extends StateSchemas,
    Config,
    Required
  > = Types.UnionToIntersection<
    Required extends string ? HandlerInitializeValidationAtPath<Config, Required> : unknown
  >

  type HandlerTreeInitialTargetPath<Config> = string extends keyof Config ? never
    : Config extends object ? {
        readonly [Key in keyof Config]:
          | HandlerConfigInitialTargetPath<HandlerConfigPart<Config[Key]>>
          | (Config[Key] extends { readonly states: infer Children } ? HandlerTreeInitialTargetPath<Children> : never)
      }[keyof Config]
    : never

  type HandlerInitialTargetValidation<
    AllStates extends StateSchemas,
    Config
  > = HandlerTreeInitialTargetPath<Config> extends infer TargetPath ? HandlerInitialTargetValidationForPaths<
      AllStates,
      Config,
      RequiredInitializersForTargetPath<AllStates, TargetPath>
    >
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

  type HandlerRequiredHistoryInitializeValidation<
    AllStates extends StateSchemas,
    StateId extends StateIdentifier<AllStates>,
    Config
  > = [HistoryIdentifier<AllStates>] extends [never] ? unknown
    : StateId extends RequiredHistoryInitializers<AllStates> ? "initialize" extends keyof Config ? unknown : {
        readonly initialize: HandlerValidationError<
          "State requires initialize for shallow history restoration",
          StateId
        >
      }
    : unknown

  type HandlerNodeValidation<
    AllStates extends StateSchemas,
    Node,
    Events extends ReadonlyArray<TaggedSchema>,
    InputEvents extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<AllStates>,
    Config,
    AvailableOutputStates extends StateIdentifier<AllStates>
  > = StateId extends ChoiceIdentifier<AllStates> ?
      & HandlerChoiceUnknownConfigKeyValidation<StateId, Config>
      & HandlerRuntimeValidation<Events, Emits, StateId, Config>
    : StateId extends StateIdentifier<AllStates> ?
        & HandlerUnknownConfigKeyValidation<StateId, Config>
        & HandlerOnKeyValidation<Events, StateId, Config>
        & HandlerInvokeParentEventsValidation<InputEvents, StateId, Config>
        & HandlerChildrenValidation<Node, StateId, Config>
        & HandlerOutputRequirementValidation<AllStates, StateId, AvailableOutputStates, Config>
        & HandlerRequiredHistoryInitializeValidation<AllStates, StateId, Config>
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

  type HandlerInvokeParentEventsValidation<
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends string,
    Config
  > = [InvokeReturn<Config>] extends [never] ? unknown
    : [Exclude<InvokeParentEvents<InvokeReturn<Config>>, EventOf<Events>>] extends [never] ? unknown
    : {
      readonly invoke: HandlerValidationError<
        "Invoked child expects parent events not accepted by this machine",
        StateId,
        Exclude<InvokeParentEvents<InvokeReturn<Config>>, EventOf<Events>>
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
    InputEvents extends ReadonlyArray<TaggedSchema>,
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
      InputEvents,
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
    InputEvents extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Config,
    AvailableOutputStates extends StateIdentifier<AllStates>
  > = Types.UnionToIntersection<
    StateNodeIdentifier<AllStates> extends infer StateId extends StateNodeIdentifier<AllStates> ?
      StateId extends StateNodeIdentifier<AllStates> ? HandlerNodeValidationAtPath<
          AllStates,
          Events,
          InputEvents,
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
    InputEvents extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Config,
    AvailableOutputStates extends StateIdentifier<AllStates>
  > =
    & HandlerUnknownStateKeyValidation<AllStates, "", Config>
    & HandlerTreeNodeValidations<AllStates, Events, InputEvents, Emits, Config, AvailableOutputStates>

  type HandlerHasRequiredInitial<
    AllStates extends StateSchemas,
    StateId extends StateIdentifier<AllStates>,
    Config
  > = StateId extends RequiredHistoryInitializers<AllStates> ? "initialize" extends keyof Config ? true : false : true

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
    ParentEvents extends ReadonlyArray<TaggedSchema>,
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
    InputEvents,
    ParentEvents
  >

  /**
   * Adds state handlers from a root state object.
   *
   * @category combinators
   * @since 0.4.0
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
    InputEvents extends ReadonlyArray<TaggedSchema>,
    ParentEvents extends ReadonlyArray<TaggedSchema>
  > {
    <
      const Config extends HandlerTree<
        States,
        States,
        Events,
        Emits,
        E,
        R,
        InputEvents,
        ParentEvents,
        ""
      >
    >(
      config:
        & Config
        & HandlerTreeValidation<
          States,
          Events,
          InputEvents,
          Emits,
          NoInfer<Config>,
          | OutputStates
          | Extract<
            HandlerTreeEvidence<States, NoInfer<Config>>["outputState"],
            StateIdentifier<States>
          >
        >
        & ([StateIdentifier<States>] extends [UnhandledStates] ? HandlerInitialTargetValidation<
            States,
            NoInfer<Config>
          >
          : unknown)
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
      ParentEvents,
      Config
    >
  }

  /**
   * Any state config.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type AnyStateConfig =
    | StateConfig<any, any, any, any, any, any, any>
    | ChoiceStateConfig<any, any, any, any>

  /**
   * Runtime event-handler map stored for a single state tag.
   *
   * @category models
   * @since 0.4.0
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
      TransitionConfig<
        States,
        Events,
        Emits,
        StateId,
        HandlerContext<States, Events, Emits, StateId, EventTag, E, R>,
        true,
        TransitionAcceptance
      >
    >
  >

  /**
   * Runtime state config stored for a single state tag.
   *
   * @category models
   * @since 0.4.0
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
    readonly invoke?: StoredInvokeDefinition<States, Events, Emits, StateId>
    readonly always?: TransitionConfig<
      States,
      Events,
      Emits,
      StateId,
      AlwaysContext<States, Events, Emits, StateId>,
      false,
      TransitionAcceptance
    >
    readonly onDone?: TransitionConfig<
      States,
      Events,
      Emits,
      StateId,
      DoneContext<States, Events, Emits, StateId>,
      false,
      TransitionAcceptance
    >
    readonly output?:
      | ((context: FinalOutputContext<States, Events, StateId>) => unknown)
      | ((context: ParallelOutputContext<States, Events, StateId>) => unknown)
    readonly on?: EventHandlerMap<States, Events, Emits, StateId, EventTag, E, R>
  }

  /**
   * Runtime handler table stored on a machine.
   *
   * @category models
   * @since 0.4.0
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

type StateSource = Machine.DefinedStates<any> | Machine.Any

type StateSchemasOf<Source extends StateSource> = Source extends Machine.DefinedStates<infer States> ? States
  : Source extends Machine.Any ? Machine.States<Source>
  : never

/**
 * Extracts the complete logical snapshot represented by a state definition or
 * machine.
 *
 * @category utility types
 * @since 0.15.0
 */
export type Snapshot<Source extends StateSource> = Machine.Snapshot<StateSchemasOf<Source>>

/**
 * Extracts the decoded value owned by a schema-backed state path.
 *
 * The source may be the object returned by {@link states} or a machine
 * definition. Control-only state paths are intentionally excluded.
 *
 * @category utility types
 * @since 0.18.0
 */
export type Value<
  Source extends StateSource,
  Path extends Machine.ValuedStateIdentifier<StateSchemasOf<Source>>
> = Machine.StateByIdentifier<StateSchemasOf<Source>, Path>

/**
 * Extracts the logical snapshot rooted at a state path.
 *
 * The source may be the object returned by {@link states} or a machine
 * definition. This is the type-level counterpart of
 * `DefinedStates.getSnapshot`.
 *
 * @category utility types
 * @since 0.18.0
 */
export type SnapshotAt<
  Source extends StateSource,
  Path extends Machine.StateIdentifier<StateSchemasOf<Source>>
> = Machine.SnapshotByIdentifier<StateSchemasOf<Source>, Path>

/**
 * Returns `true` if a value is a `Machine`.
 *
 * @category guards
 * @since 0.4.0
 */
export const isMachine: (u: unknown) => u is Machine.Any = internal.isMachine

/**
 * Returns `true` if a state snapshot is final for a machine.
 *
 * @category guards
 * @since 0.4.0
 */
export const isFinal: <
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
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
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
    InputEvents,
    ParentEvents
  >,
  state: Machine.Snapshot<States>
) => state is Machine.SnapshotContainingFinal<States, FinalStates> = internal.isFinal as any

/**
 * Defines one reusable active state while preserving its exact child topology.
 *
 * Prefer declaring state nodes inline in {@link states}. Use this constructor
 * only when the same state definition is mounted more than once.
 * Tagged schemas are already reusable and do not need this constructor.
 *
 * **Example** (Repeated compound state)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * const TradingState = Schema.TaggedUnion({
 *   InSession: {},
 *   Applying: {}
 * })
 * const TradingSlot = Machine.state({
 *   initial: "Idle",
 *   states: {
 *     Idle: {},
 *     InSession: TradingState.cases.InSession,
 *     Applying: TradingState.cases.Applying
 *   }
 * })
 *
 * const States = Machine.states({
 *   slot1: TradingSlot,
 *   slot2: TradingSlot
 * })
 * ```
 *
 * @category constructors
 * @since 0.15.0
 */
export const state: StateConstructor = internal.state as StateConstructor

/**
 * Defines the complete state tree while preserving literal state paths.
 *
 * **When to use**
 *
 * Use when you want to pass a state tree to `make` and also get typed
 * snapshot matching and access helpers.
 *
 * **Details**
 *
 * The returned `states` property is an immutable structural capture of the
 * supplied tree.
 * `Machine.make` derives its initial target selector from that tree and
 * enforces compound and parallel initial-state rules. Active nodes may omit
 * `schema` when they own no value and still participate fully in targeting,
 * matching, and snapshots.
 *
 * **Example** (Atomic initial snapshot)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
 *
 * const States = Machine.states({ idle: Idle })
 *
 * Machine.make({
 *   states: States.states,
 *   events: Machine.events(),
 *   initial: (to) => to.idle().resolve(({ target }) => target.from())
 * })
 * ```
 *
 * @category constructors
 * @since 0.4.0
 */
export const states: StatesConstructor = internal.states

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
    config:
      & Omit<
        MakeConfig<States, InputEvents, Emits, Input, InitialE, InitialR, InternalEvents, ParentDeclaration>,
        "initial"
      >
      & { readonly initial: Machine.InitialBuilderInput<States, Input["Type"]> },
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

/**
 * Creates a schema-first machine definition.
 *
 * **Details**
 *
 * State and event schemas provide runtime boundary validation while their
 * decoded types drive handler, state, event, target, error, and service
 * inference. State-tree validation is applied whether `states` comes from
 * `states` or is passed inline. Call `handle` on the returned definition
 * to implement state behavior with ordinary TypeScript control flow.
 *
 * `initial` is a target-first callback. Its outer selector runs once while the
 * definition is captured; an attached `.resolve(...)` callback remains lazy
 * until initial planning. Return a bare selected state when its schema supports
 * default construction.
 *
 * `Machine.events` defines the public input protocol. `Machine.internalEvents`
 * adds raised events and other machine-local deliveries.
 * `Machine.emittedEvents` defines outward ephemeral notifications. The
 * `parent` configuration accepts `Machine.parent(events)` for a required owner
 * or `Machine.optionalParent(events)` for a root-capable machine. All
 * descriptors expose deferred constructors while retaining their
 * schemas opaquely for runtime validation. Public and internal tags must be
 * disjoint.
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
 * const States = Machine.states({ Count })
 * const Events = Machine.events(Increment)
 *
 * const counter = Machine.make({
 *   states: States.states,
 *   events: Events,
 *   initial: (to) => to.Count().resolve(({ target }) => target(new Count({ value: 0 })))
 * }).handle({
 *   Count: {
 *     on: {
 *       Increment: (to) =>
 *         to.full.Count().resolve(({ event, state, target }) =>
 *           target(new Count({ value: state.value + event.by })))
 *     }
 *   }
 * })
 * ```
 *
 * @see {@link states} for typed state-tree helpers.
 * @category constructors
 * @since 0.4.0
 */
export const make: Make = internal.make

/**
 * Extracts the decoded event union carried by an event protocol descriptor.
 *
 * @category utility types
 * @since 0.10.0
 */
export type EventOf<Protocol extends Machine.EventProtocol.Any> = Machine.EventOf<
  Machine.EventProtocolSchemas<Protocol>
>

/**
 * Defines a public event protocol and returns deferred constructors for every
 * statically finite configured event tag.
 *
 * Constructor inputs retain their schema-derived required fields, defaults,
 * and transformations. Construction is deferred until delivery so failures
 * enter the machine's `MachineSchemaDecodeError` channel rather than throwing
 * at the call site.
 *
 * **Example**
 *
 * ```ts
 * export const Event = Machine.events(
 *   Schema.TaggedUnion({
 *     Increment: { by: Schema.Number },
 *     Reset: {}
 *   })
 * )
 * const machine = Machine.make({ events: Event, ... })
 * yield* ref.send(Event.Increment({ by: 1 }))
 * ```
 *
 * @category constructors
 * @since 0.10.0
 */
export const events: {
  <const Schemas extends ReadonlyArray<Machine.TaggedSchema>>(
    ...schemas: Schemas & ValidateInputEventProtocol<NoInfer<Schemas>>
  ): Machine.EventProtocol<"public", readonly [...Schemas]>
  <const Inputs extends ReadonlyArray<Machine.EventProtocolInput<"public">>>(
    ...inputs: Inputs & ValidateEventProtocolBuilder<"public", Inputs>
  ): Machine.EventProtocol<"public", Machine.EventProtocolInputSchemasOf<"public", Inputs>>
} = internal.events as any

/**
 * Requires the machine to run as an owned child whose parent accepts the
 * supplied public event protocol.
 *
 * Required-parent machines expose a non-optional `parent` target in behavior
 * contexts and are rejected by root execution APIs.
 *
 * @category constructors
 * @since 0.17.0
 */
export const parent: <const Events extends ReadonlyArray<Machine.TaggedSchema>>(
  events: Machine.EventProtocol<"public", Events>
) => Parent<"required", Events> = internal.parent

/**
 * Declares public events a machine may send to its owner while preserving the
 * ability to run that machine as a root.
 *
 * Optional-parent machines expose `parent` as a possibly absent target.
 *
 * @category constructors
 * @since 0.17.0
 */
export const optionalParent: <const Events extends ReadonlyArray<Machine.TaggedSchema>>(
  events: Machine.EventProtocol<"public", Events>
) => Parent<"optional", Events> = internal.optionalParent

/**
 * Defines an internal event protocol and returns deferred constructors for
 * every statically finite configured event tag.
 *
 * Use these constructors for raised events and other machine-local deliveries.
 * Construction failures are reported through the
 * owning machine's `MachineSchemaDecodeError` channel.
 *
 * **Example**
 *
 * ```ts
 * const Internal = Machine.internalEvents(
 *   Schema.TaggedUnion({
 *     Loaded: { value: Schema.String },
 *     Failed: { message: Schema.String }
 *   })
 * )
 * const machine = Machine.make({ internalEvents: Internal, ... })
 *
 * // Inside a transition callback:
 * enqueue.raise(Internal.Loaded({ value }))
 * ```
 *
 * @category constructors
 * @since 0.10.0
 */
export const internalEvents: {
  <const Schemas extends ReadonlyArray<Machine.TaggedSchema>>(
    ...schemas: Schemas & ValidateInternalEventProtocol<readonly [], NoInfer<Schemas>>
  ): Machine.EventProtocol<"internal", readonly [...Schemas]>
  <const Inputs extends ReadonlyArray<Machine.EventProtocolInput<"internal">>>(
    ...inputs: Inputs & ValidateEventProtocolBuilder<"internal", Inputs>
  ): Machine.EventProtocol<"internal", Machine.EventProtocolInputSchemasOf<"internal", Inputs>>
} = internal.internalEvents as any

/**
 * Defines the ephemeral notifications a machine may publish to external
 * observers. Emitted events are separate from machine input and are never sent
 * implicitly to a parent machine. Observe them through `MachineRef.emissions` or
 * the AtomMachine emission stream adapters.
 *
 * **Example**
 *
 * ```ts
 * const Emitted = Machine.emittedEvents(
 *   Schema.TaggedUnion({
 *     Saved: { id: Schema.String }
 *   })
 * )
 * const machine = Machine.make({ emittedEvents: Emitted, ... })
 * ```
 *
 * @category constructors
 * @since 0.10.0
 */
export const emittedEvents: {
  <const Schemas extends ReadonlyArray<Machine.TaggedSchema>>(
    ...schemas: Schemas & ValidateEmittedEventProtocol<NoInfer<Schemas>>
  ): Machine.EventProtocol<"emitted", readonly [...Schemas]>
  <const Inputs extends ReadonlyArray<Machine.EventProtocolInput<"emitted">>>(
    ...inputs: Inputs & ValidateEventProtocolBuilder<"emitted", Inputs>
  ): Machine.EventProtocol<"emitted", Machine.EventProtocolInputSchemasOf<"emitted", Inputs>>
} = internal.emittedEvents as any

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
 * **Example**
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
 * const States = Machine.states({ Idle })
 * const machine = Machine.make({
 *   states: States.states,
 *   events: Machine.events(),
 *   initial: (to) => to.Idle().resolve(({ target }) => target.from())
 * }).handle({ Idle: {} })
 *
 * const encoded = Effect.gen(function*() {
 *   const initial = yield* Machine.planInitial(machine)
 *   return yield* Machine.encodeSnapshot(machine, initial.state)
 * })
 * ```
 *
 * @see {@link decodeSnapshot} for restoring an encoded snapshot.
 * @category encoding
 * @since 0.4.0
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
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
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
    InputEvents,
    ParentEvents
  >,
  snapshot: Machine.Snapshot<States>
) => Effect.Effect<
  Machine.EncodedSnapshot,
  MachineSchemaEncodeError,
  Machine.SnapshotEncodingServices<States>
> = internal.encodeSnapshot as any

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
 * **Example**
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
 * const States = Machine.states({ Idle })
 * const machine = Machine.make({
 *   states: States.states,
 *   events: Machine.events(),
 *   initial: (to) => to.Idle().resolve(({ target }) => target.from())
 * }).handle({ Idle: {} })
 *
 * const roundTrip = Effect.gen(function*() {
 *   const initial = yield* Machine.planInitial(machine)
 *   const encoded = yield* Machine.encodeSnapshot(machine, initial.state)
 *   return yield* Machine.decodeSnapshot(machine, encoded)
 * })
 * ```
 *
 * @see {@link encodeSnapshot} for creating the normalized representation.
 * @category decoding
 * @since 0.4.0
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
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
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
    InputEvents,
    ParentEvents
  >,
  encoded: unknown
) => Effect.Effect<
  Machine.Snapshot<States>,
  MachineSchemaDecodeError,
  Machine.SnapshotDecodingServices<States>
> = internal.decodeSnapshot as any

type TransitionBranchRecordError<Message extends string, Key extends PropertyKey = never> = {
  readonly "~effect/Machine/TransitionBranchRecordError": Message
  readonly key: Key
}

type InvalidStaticTransitionBranchKey<Branches> = Extract<keyof Branches, "" | number | symbol>

type ValidateTransitionBranchRecord<Branches> = [keyof Branches] extends [never] ?
  TransitionBranchRecordError<"Branch records must contain at least one branch">
  : [InvalidStaticTransitionBranchKey<Branches>] extends [never] ? unknown
  : TransitionBranchRecordError<
    "Branch keys must be non-empty, non-index strings",
    InvalidStaticTransitionBranchKey<Branches>
  >

/**
 * Plans the initial state for a machine without executing machine commands.
 *
 * **Details**
 *
 * The returned plan contains the settled initial snapshot, machine commands,
 * emitted events, optional final output, and every startup microstep. Planning
 * may evaluate transition logic and follow completion, eventless, and
 * raised-event steps. Transition callbacks are evaluated synchronously.
 * `startingState` and `initialEntryPaths` describe the normalized
 * configuration before entry callbacks and settlement begin.
 *
 * **Gotchas**
 *
 * `start` executes the closed command list as part of the managed machine commit
 * protocol. Manual planners may inspect commands but need running machine targets
 * to execute child-addressed operations.
 *
 * **Example**
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
 * const States = Machine.states({ Idle })
 * const machine = Machine.make({
 *   states: States.states,
 *   events: Machine.events(),
 *   initial: (to) => to.Idle().resolve(({ target }) => target.from())
 * }).handle({ Idle: {} })
 *
 * const initialState = Effect.map(Machine.planInitial(machine), (plan) => plan.state)
 * ```
 *
 * @see {@link plan} for planning a received event.
 * @see {@link start} for the managed runtime protocol.
 * @category constructors
 * @since 0.4.0
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
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
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
      InputEvents,
      ParentEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>
    & Machine.RootCompatible<ParentEvents>,
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
> = internal.planInitial as any

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
 * @since 0.4.0
 */
export const stateNodes: <M extends Machine.Any>(machine: M) => ReadonlyArray<
  Machine.StateNode<
    Machine.StateIdentifier<Machine.States<M>>,
    Machine.HistoryIdentifier<Machine.States<M>>,
    Machine.ChoiceIdentifier<Machine.States<M>>
  >
> = internal.stateNodes

/**
 * Returns the statically selected root entry used during machine startup.
 *
 * This function does not execute the initial resolver or require machine
 * input. `kind: "initial"` means that the selected root enters its declared
 * initial configuration.
 *
 * @category getters
 * @since 0.14.0
 */
export const initialDefinition: <M extends Machine.Any>(machine: M) => Machine.InitialDefinition<
  Machine.RootStateIdentifier<Machine.StateIdentifier<Machine.States<M>>>
> = internal.initialDefinition

/**
 * Returns every registered transition handler in state definition order.
 *
 * **Details**
 *
 * Event handlers retain their handler-key order within each source state and
 * are followed by eventless and completion handlers. This function does not
 * execute resolvers. Every direct, named, and targetless branch exposes the
 * destination selected by its required static `target` declaration, while
 * `acceptance` reports whether the resolver may decline the transition.
 *
 * @category getters
 * @since 0.4.0
 */
export const transitionDefinitions: <M extends Machine.Any>(machine: M) => ReadonlyArray<
  Machine.TransitionDefinition<
    Machine.StateNodeIdentifier<Machine.States<M>>,
    Machine.TagOf<Machine.Events<M>[number]>,
    Machine.StateNodeIdentifier<Machine.States<M>>
  >
> = internal.transitionDefinitions

/**
 * Returns serializable descriptions of every state-owned activity.
 *
 * **Details**
 *
 * Static inline invocation definitions expose stable ownership and lifecycle
 * metadata without serializing runtime values. Function-valued sources are
 * represented as dynamic and are never evaluated during inspection.
 *
 * @category getters
 * @since 0.4.0
 */
export const activityDefinitions: <M extends Machine.Any>(
  machine: M
) => ReadonlyArray<Machine.ActivityDefinition<Machine.StateIdentifier<Machine.States<M>>>> =
  internal.activityDefinitions

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
 * @since 0.4.0
 */
export const configuration: <M extends Machine.Any>(
  machine: M,
  state: Machine.Snapshot<Machine.States<M>>
) => ReadonlyArray<
  Machine.ActiveStateNode<
    Machine.StateIdentifier<Machine.States<M>>,
    Machine.ChoiceIdentifier<Machine.States<M>>
  >
> = internal.configuration

/**
 * Returns event tags with at least one structurally eligible handler in the
 * current state snapshot.
 *
 * A `declinable` handler may still reject a concrete event at planning time,
 * so this is a static candidate query rather than a guarantee that every value
 * with the returned tag will be handled.
 *
 * @category getters
 * @since 0.4.0
 */
export const enabled: <
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
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
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
    InputEvents,
    ParentEvents
  >,
  state: Machine.Snapshot<States>
) => ReadonlyArray<Machine.TagOf<Events[number]>> = internal.enabled as any

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
 * `plan` returns data; it does not implement the managed machine commit protocol.
 * `start` executes child commands, publishes `next`, and then delivers
 * `emittedEvents`. Events with no enabled transition are ignored and produce
 * an unchanged plan.
 *
 * **Example**
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * class Off extends Schema.TaggedClass<Off>("Off")("Off", {}) {}
 * class On extends Schema.TaggedClass<On>("On")("On", {}) {}
 * class Toggle extends Schema.TaggedClass<Toggle>("Toggle")("Toggle", {}) {}
 * const States = Machine.states({ Off, On })
 * const machine = Machine.make({
 *   states: States.states,
 *   events: Machine.events(Toggle),
 *   initial: (to) => to.Off().resolve(({ target }) => target.from())
 * }).handle({
 *   Off: {
 *     on: {
 *       Toggle: (to) =>
 *         to.full.On().resolve(({ target }) => target.from())
 *     }
 *   },
 *   On: {}
 * })
 *
 * const nextState = Effect.gen(function*() {
 *   const initial = yield* Machine.planInitial(machine)
 *   return (yield* Machine.plan(machine, initial.state, new Toggle({}))).next
 * })
 * ```
 *
 * @see {@link planInitial} for planning machine startup.
 * @see {@link start} for managed execution and lifecycle observation.
 * @category combinators
 * @since 0.4.0
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
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
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
      InputEvents,
      ParentEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>
    & Machine.RootCompatible<ParentEvents>,
  state: Machine.Snapshot<States>,
  event: Machine.EventInputOf<InputEvents>
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
> = internal.plan as any

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
 * addresses, or invocation lifecycle transitions when possible.
 *
 * Use an inline `invoke` with an `effect` source for one-shot work.
 * @see {@link transition} for event-driven state.
 * @category constructors
 * @since 0.4.0
 */
export const logic: <
  State,
  Event = never,
  Output = void,
  Error = never,
  Requirements = never,
  InitialError = never,
  InitialRequirements = never
>(options: {
  readonly initial:
    | State
    | ((
      scope: Logic.Scope<Event>
    ) => Effect.Effect<State, InitialError, InitialRequirements>)
  readonly run: (
    context: Logic.Context<State, Event>
  ) => Effect.Effect<Output, Error, Requirements>
}) => Logic<State, Event, Error, Requirements | InitialRequirements, Output, InitialError> = internal.logic

/**
 * Creates a typed descriptor for a complete child machine.
 *
 * Descriptors identify a child by id and machine identity, so independently
 * constructed descriptors for the same pair address the same invoked child.
 *
 * @category constructors
 * @since 0.4.0
 */
export const child: <const Id extends string, M extends Machine.Any>(id: Id, machine: M) => ChildMachine<Id, M> =
  internal.child

/**
 * Creates a typed parent-local address for lower-level child process logic.
 *
 * The default event protocol is `never`; provide an event type before using
 * the address with `spawn`, a state-owned logic invocation, or `sendTo`.
 *
 * @category constructors
 * @since 0.4.0
 */
export const childAddress: <Event = never>(id: string) => ChildAddress<Event> = internal.childAddress

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
 * Use a state's `invoke: (from) => from.logic(...)` declaration for children
 * that start and stop with that state.
 * @see {@link sendTo} for sending events to named children.
 * @category runtime
 * @since 0.4.0
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
} = internal.spawn

/**
 * Sends an event to a named child process of the running machine.
 *
 * @category runtime
 * @since 0.4.0
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
} = internal.sendTo

/**
 * Stops a named child process of the running machine.
 *
 * @category runtime
 * @since 0.4.0
 */
export const stopChild: {
  <Event>(child: ChildAddress<Event>): Effect.Effect<void, never, MachineRuntimeRequirement>
  <Child extends ChildMachine.Any>(child: Child): Effect.Effect<void, never, MachineRuntimeRequirement>
} = internal.stopChild

/**
 * Returns a stream of terminal lifecycle outcomes for a running machine.
 *
 * @category combinators
 * @since 0.4.0
 */
export const watch: <State, Event, Error = never, Output = never>(
  ref: MachineRef<State, Event, Error, Output>
) => Stream.Stream<RuntimeOutcome<State, Error, Output>> = internal.watch

/**
 * Prepares a fresh machine without initializing it.
 *
 * Use this constructor when observation must be composed before initial-entry
 * actions run. Subscribe to `prepared.emissions`, then evaluate
 * `prepared.start`. Ordinary callers can continue to use {@link start}, which
 * starts directly and does not allocate the prepared lifecycle boundary.
 *
 * ```ts
 * const prepared = yield* Machine.prepare(machine)
 *
 * yield* prepared.emissions.pipe(
 *   Stream.runForEach(handleEmission),
 *   Effect.forkScoped({ startImmediately: true })
 * )
 *
 * const ref = yield* prepared.start
 * ```
 *
 * @category constructors
 * @since 0.11.0
 */
export const prepare: <
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
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
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
      InputEvents,
      ParentEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>
    & Machine.RootCompatible<ParentEvents>,
  ...args: [...Machine.InputArgs<Input>]
) => Effect.Effect<
  Prepared<
    Machine.Snapshot<States>,
    Machine.EventInputOf<InputEvents>,
    | E
    | ActionError<R>
    | InfiniteTransitionError
    | MachineSchemaDecodeError
    | StoppedError,
    Output,
    Machine.EmittedEventOf<Emits>,
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
  >
> = internal.prepare as any

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
 * macrostep, executes closed machine commands, stops invokes for exited states,
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
 * **Example**
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
 * const States = Machine.states({ Idle })
 * const machine = Machine.make({
 *   states: States.states,
 *   events: Machine.events(),
 *   initial: (to) => to.Idle().resolve(({ target }) => target.from())
 * }).handle({ Idle: {} })
 *
 * const state = Effect.gen(function*() {
 *   const ref = yield* Machine.start(machine)
 *   return yield* ref.state
 * })
 * ```
 *
 * @see {@link plan} for inspecting the same transition plan without executing it.
 * @see {@link watch} for classified terminal outcomes.
 * @category constructors
 * @since 0.4.0
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
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
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
      InputEvents,
      ParentEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>
    & Machine.RootCompatible<ParentEvents>,
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
> = internal.start as any

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
 * timer invocations restart their complete duration and child-machine
 * invocations start from their own initial state.
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
 * **Example**
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 *
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
 * const States = Machine.states({ Idle })
 * const machine = Machine.make({
 *   states: States.states,
 *   events: Machine.events(),
 *   initial: (to) => to.Idle().resolve(({ target }) => target.from())
 * }).handle({ Idle: {} })
 *
 * const resumed = Effect.gen(function*() {
 *   const initial = yield* Machine.planInitial(machine)
 *   const encoded = yield* Machine.encodeSnapshot(machine, initial.state)
 *   const snapshot = yield* Machine.decodeSnapshot(machine, encoded)
 *   return yield* Machine.resume(machine, snapshot)
 * })
 * ```
 *
 * @see {@link decodeSnapshot} for the schema and transport boundary.
 * @see {@link start} for ordinary initial startup.
 * @category constructors
 * @since 0.4.0
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
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
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
      InputEvents,
      ParentEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>
    & Machine.RootCompatible<ParentEvents>,
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
> = internal.resume as any
