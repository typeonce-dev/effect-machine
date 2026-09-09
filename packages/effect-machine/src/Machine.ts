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
import type { ExcludeCompatibleRuntime } from "./internal/machine/requirements.js"
import type * as internalRuntime from "./internal/machine/runtimeProtocol.js"
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
 * Use `guard` to decline a transition before constructing its next state.
 * Use `declinable: true` when a named branch resolver may return `decline()`.
 * Register cancellable state-scoped delays in `make({ timers })`.
 *
 * **Example**
 *
 * ```ts
 * import { Machine } from "@typeonce/effect-machine"
 * import { Schema } from "effect"
 * const events = Machine.events({ Add: { by: Schema.Number } })
 * const Root = Machine.state({ fields: { count: Schema.Number } })
 * const targets = Machine.targets(Root)
 * export const counter = Machine.make({
 *   root: Root,
 *   events
 * }).handle({
 *   root: () => ({ count: 0 }),
 *   on: {
 *     Add: {
 *       update: targets.root,
 *       guard: ({ event }) => event.by > 0,
 *       data: ({ root, event }) => ({ count: root.count + event.by })
 *     }
 *   }
 * })
 * ```
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

  /** Root descriptor for topology and snapshot access. */
  readonly root: State<Extract<Omit<States[""], "~effect/Machine/ExplicitInitial">, Machine.StateNodeConfig>>

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
  readonly handlers: Readonly<Record<string, unknown>>

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
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  Registrations extends Machine.Registrations = {}
> extends
  Omit<
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
    >,
    TypeId | "stateNodes" | "makeTargetBuilder" | "handlers" | "initial" | "initialDefinition"
  >
{
  /**
   * Adds typed state handlers and returns an independent machine
   * implementation. Event dispatch maps and transition descriptors are
   * captured by value, so later mutation of the supplied objects cannot alter
   * the resulting machine.
   *
   * **Example**
   *
   * ```ts
   * const targets = Machine.targets(States)
   * const counter = definition.handle({ states: {
   *   Count: {
   *     on: {
   *       Increment: {
   *         update: targets.root.Count,
   *         decoded: ({ event, state }) => new Count({ value: state.value + event.by })
   *       }
   *     }
   *   }
   * } })
   * ```
   *
   * @since 0.4.0
   */
  readonly handle: Machine.Handler<
    States,
    Events,
    Emits,
    Input,
    InitialE,
    InitialR,
    FinalStates,
    Output,
    InputEvents,
    ParentEvents,
    Registrations
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
  export interface Any
    extends
      Omit<Machine.Any, TypeId | "stateNodes" | "makeTargetBuilder" | "handlers" | "initial" | "initialDefinition">
  {
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
 * selected.
 *
 * Enqueuing records statechart and machine operations for the selected
 * transition. It never executes an Effect while the transition is evaluated.
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

type IncompatibleRuntime<Requirements, Events, Emits> = Requirements extends Runtime.Requirement<
  infer RequiredEvents,
  infer RequiredEmits
> ? IsAny<Requirements> extends true ? never
  : [RequiredEvents] extends [Events] ? [RequiredEmits] extends [Emits] ? never : Requirements
  : Requirements
  : never

const InvokeTypeId: typeof internal.InvokeTypeId = internal.InvokeTypeId

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
> = "initial" extends keyof Node ? StateDefinitionError<"Declare initial edges in handle", Path>
  : ValidateInitialSelectorChild<Children, Path> & ValidateWithSelectorChild<Node, Children, Path> & {
    readonly states: ValidateStateTree<Children, true, Extract<Path, string>>
  }

type ValidateStateNodeWithoutChildren<Node extends Machine.StateNodeConfig> = "initial" extends keyof Node ?
  StateDefinitionError<"Atomic states cannot declare an initial child">
  : Node extends { readonly type: infer Type } ? Type extends "final" ? ValidateOutputSchema<Node>
    : Type extends "active" | undefined ?
      "output" extends keyof Node ? StateDefinitionError<"Only final and parallel states can declare output">
      : unknown
    : StateDefinitionError<"State node type must be active, final, or parallel">
  : "output" extends keyof Node ? StateDefinitionError<"Only final and parallel states can declare output">
  : unknown

type ReusableStateNodeConfig =
  | Machine.AtomicStateNodeConfig
  | Machine.CompoundStateNodeConfig
  | Machine.ParallelStateNodeConfig

type ReusableStateValidation<Node> = Node extends ReusableStateNodeConfig ? ValidateStateNode<Node, false, "state">
  : StateDefinitionError<"Reusable states must be active state nodes", "state">

type ValidateDefinedState<Node> = [Node] extends [ReusableStateValidation<Node>] ? []
  : [validation: ReusableStateValidation<Node>]

const StateTypeId = "~effect/Machine/State"

/** An immutable state descriptor, usable as a root or a nested state.
 * @category models
 * @since 0.32.0
 */
export interface State<Node extends Machine.StateNodeConfig> extends Machine.StateAccessors<{ readonly "": Node }> {
  readonly [StateTypeId]: typeof StateTypeId
  readonly node: Node
}

type NormalizeState<Node, Tag extends string = ""> = Node extends
  { readonly [StateTypeId]: typeof StateTypeId; readonly node: infer Config } ? Config
  : Node extends Machine.TaggedSchema ? Node
  : "fields" extends keyof Node ? NormalizeStateFields<Node, Tag>
  : Node extends { readonly states: infer Children } ?
    Children extends Readonly<Record<string, Machine.TaggedSchema>> ? Node : NormalizeStateFields<Node, Tag>
  : Node

type NormalizeStateFields<Node, Tag extends string> = {
  readonly [Key in keyof Node as Key extends "fields" ? "schema" : Key]: Key extends "fields" ?
    Node[Key] extends Schema.Struct.Fields ? Schema.TaggedStruct<Tag, Node[Key]> : never
    : Key extends "states" ?
      { readonly [Child in keyof Node[Key]]: NormalizeState<Node[Key][Child], Extract<Child, string>> }
    : Node[Key]
}

type NormalizedState<Node> = Extract<NormalizeState<Node>, Machine.StateNodeConfig>
type StateFieldsValidation<Node> = Node extends { readonly [StateTypeId]: typeof StateTypeId } | Machine.TaggedSchema ?
  unknown :
  & (Node extends { readonly fields: infer Fields } ?
    "schema" extends keyof Node ? StateDefinitionError<"Declare fields or schema, not both", "">
    : Fields extends Schema.Struct.Fields ?
      "_tag" extends keyof Fields ? StateDefinitionError<"State fields cannot declare _tag", ""> : unknown
    : StateDefinitionError<"State fields must be schema fields", "">
    : unknown)
  & (Node extends { readonly states: infer Children } ? {
      readonly states: {
        readonly [Key in keyof Children]: StateFieldsValidation<Children[Key]>
      }
    } :
    unknown)

interface StateInput {
  readonly schema?: Machine.TaggedSchema
  readonly fields?: Schema.Struct.Fields
  readonly type?: "active" | "parallel" | "final" | "history" | "choice"
  readonly initial?: string
  readonly states?: Readonly<
    Record<
      string,
      Machine.TaggedSchema | StateInput | {
        readonly [StateTypeId]: typeof StateTypeId
        readonly node: Machine.StateNodeConfig
      }
    >
  >
  readonly history?: "shallow" | "deep"
  readonly output?: Schema.Top
  readonly annotations?: Machine.SchemaLessStateAnnotations
}

interface StateConstructor {
  <const Node extends StateInput>(
    node: Node & StateFieldsValidation<NoInfer<Node>>,
    ..._validation: ValidateDefinedState<NormalizeState<NoInfer<Node>>>
  ): State<NormalizedState<Node>>
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

type FromMethod<in out Arguments extends ReadonlyArray<unknown>, out Result> = {
  /**
   * Constructs the selected state from its schema make input while the
   * machine plans the resulting configuration. The input may be omitted when
   * the schema accepts an empty constructor object.
   *
   * @since 0.4.0
   */
  readonly from: FromCallable<Arguments, Machine.StateConstruction<Result>>
}

type DecodedMethod<Arguments extends ReadonlyArray<unknown>, Result> = {
  /**
   * Constructs the selected state from an already-decoded schema value. The
   * machine validates the value against the schema's type side while planning.
   *
   * @since 0.22.0
   */
  readonly decoded: (...args: Arguments) => Result
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
  : DecodedMethod<Arguments, Result> & { readonly from: FromCallable<FromArguments, FromResult> }

type NodeMethod<
  Node,
  Arguments extends ReadonlyArray<unknown>,
  Result,
  FromArguments extends ReadonlyArray<unknown>
> = Machine.NodeSchema<Node> extends never ? FromMethod<FromArguments, Result>
  : DecodedMethod<Arguments, Result> & FromMethod<FromArguments, Result>

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
    & DecodedMethod<Arguments, Result>
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
  readonly from: FromCallable<
    WithNodeInput<Node, readonly []>,
    Machine.StateConstruction<Machine.InitialTarget<Path>>
  >
  readonly decoded: (...args: WithNodeValue<Node, readonly []>) => Machine.InitialTarget<Path>
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
  : {
    readonly decoded: <Selected extends ConstructionResult<Result>>(
      value: NodeValue<Node>,
      state: (builder: Builder) => Selected
    ) => Selected
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

type FullSnapshotBuilderWithPrefix<
  in out States extends Machine.StateSchemas,
  in out Prefix extends string = ""
> = {
  readonly [Key in ActiveStateKey<States> | ChoiceStateKey<States>]: Key extends ActiveStateKey<States>
    ? FullSnapshotMethod<States, Key, Prefix>
    : () => Machine.ChoiceTargetInstruction<Machine.JoinPath<Prefix, Key>>
}

type FullSnapshotMethod<
  in out States extends Machine.StateSchemas,
  in out StateId extends ActiveStateKey<States>,
  in out Prefix extends string
> = {
  readonly [
    /** Constructs this node using schema make input or an already decoded value. */
    Method in Machine.NodeSchema<States[StateId]> extends never ? "from" : "from" | "decoded"
  ]: Method extends "from" ? FromCallable<
      FullSnapshotFromArguments<States, StateId, Prefix>,
      Machine.StateConstruction<FullSnapshotResult<States, StateId, Prefix>>
    >
    : (...args: FullSnapshotArguments<States, StateId, Prefix>) => FullSnapshotResult<States, StateId, Prefix>
}

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
  in out States extends Machine.StateSchemas,
  in out StateId extends ActiveStateKey<States>,
  in out Prefix extends string,
  in out Owner extends string
> = {
  readonly [Key in Machine.NodeSchema<States[StateId]> extends never ? "from" : "from" | "decoded"]: Key extends
    "from" ? FromCallable<
      HistorySnapshotFromArguments<States, StateId, Prefix, Owner>,
      Machine.StateConstruction<HistorySnapshotResult<States, StateId, Prefix, Owner>>
    > :
    (
      ...args: HistorySnapshotArguments<States, StateId, Prefix, Owner>
    ) => HistorySnapshotResult<States, StateId, Prefix, Owner>
}

type HistorySnapshotWithPrefix<
  States extends Machine.StateSchemas,
  Owner extends string,
  Prefix extends string
> = {
  readonly [Key in ActiveStateKey<States>]: Owner extends
    | Machine.JoinPath<Prefix, Key>
    | (Machine.JoinPath<Prefix, Key> extends "" ? string : `${Machine.JoinPath<Prefix, Key>}.${string}`) ?
    HistorySnapshotResult<States, Key, Prefix, Owner>
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
      | (Machine.JoinPath<Prefix, Key> extends "" ? string : `${Machine.JoinPath<Prefix, Key>}.${string}`) ? Key
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
    | (Machine.JoinPath<Prefix, Key> extends "" ? string : `${Machine.JoinPath<Prefix, Key>}.${string}`) ?
    HistorySnapshotResult<States, Key, Prefix, Owner>
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
      | (Machine.JoinPath<Prefix, Key> extends "" ? string : `${Machine.JoinPath<Prefix, Key>}.${string}`) ?
      NodeBuilderMethod<
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

type ParentPath<Path extends string> = Machine.ImmediateParentStateIdentifier<Path>

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
    Source extends Path | (Path extends "" ? string : `${Path}.${string}`) ? NestedTargetMethod<
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
        readonly with: {
          readonly decoded: <Result extends ConstructionResult<LocalTargetResultWithPrefix<States, Children, Scope>>>(
            value: Machine.StateByIdentifier<States, Scope>,
            state: (
              builder: LocalTargetBuilderWithPrefix<States, Children, Scope, Source>
            ) => Result
          ) => Result
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
    Source extends Path | (Path extends "" ? string : `${Path}.${string}`) ?
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

type RequiresInitialValue<Node> = Machine.NodeSchema<Node> extends never ? false
  : {} extends NodeMakeInput<Node> ? false
  : true

type HasRequiredActiveChild<States extends Machine.StateSchemas> = {
  readonly [Key in ActiveStateKey<States>]: RequiresInitialValue<States[Key]> extends true ? Key : never
}[ActiveStateKey<States>] extends never ? false : true

type InitializerClosureForNode<
  AllStates extends Machine.StateSchemas,
  Node,
  Path extends string
> = Node extends { readonly states: infer Declared extends Machine.StateSchemas } ?
  string extends keyof Declared ? never :
  Node extends { readonly type: "parallel"; readonly states: infer Children extends Machine.StateSchemas } ?
      | (HasRequiredActiveChild<Children> extends true ? Extract<Path, Machine.StateIdentifier<AllStates>> : never)
      | InitializerClosuresForChildren<AllStates, Children, Path>
  : Node extends { readonly states: infer Children extends Machine.StateSchemas } ?
      | Extract<Path, Machine.StateIdentifier<AllStates>>
      | InitializerClosuresForChildren<AllStates, Children, Path>
  : never
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
 * Records retain decoded local events and snapshots and are not themselves a
 * stable JSON export format. Telemetry exporters must project process-local
 * values into an explicit portable representation.
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
  export interface Spawn<OwnerEvent = unknown> {
    <const Child extends ChildMachine.Any>(
      child: Child & ChildMachine.Executable<Child> & ChildMachine.ParentCompatibility<Child, OwnerEvent>,
      ...options: ChildMachine.SpawnArgs<Child>
    ): Effect.Effect<
      ChildMachine.Ref<Child>,
      ChildAlreadyExistsError | ChildMachine.StartError<Child>,
      ChildMachine.StartRequirements<Child>
    >
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
    readonly spawn: Spawn<Event>

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
const ChildParentCompatibilityErrorTypeId = "~effect/Machine/ChildParentCompatibilityError"
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
   * Bound constructor for an open family of child descriptors that share one
   * machine definition.
   *
   * @category models
   * @since 0.20.0
   */
  export interface Family<M extends Machine.Any> {
    <const Id extends string>(id: Id): ChildMachine<Id, M>
  }

  /**
   * Ensures a child machine's declared owner protocol is accepted by the
   * process that will own it.
   *
   * @category utility types
   * @since 0.20.0
   */
  export type ParentCompatibility<Child extends Any, OwnerEvent> = Child extends ChildMachine<string, infer M> ?
    Machine.Any extends M ? {
        readonly [ChildParentCompatibilityErrorTypeId]: {
          readonly child: unknown
          readonly owner: OwnerEvent
        }
      }
    : [Machine.EventOf<Machine.ParentEvents<M>>] extends [OwnerEvent] ? unknown :
    {
      readonly [ChildParentCompatibilityErrorTypeId]: {
        readonly child: Machine.EventOf<Machine.ParentEvents<M>>
        readonly owner: OwnerEvent
      }
    }
    : never

  /**
   * Ensures the selected child machine has complete handlers and outputs.
   *
   * @category utility types
   * @since 0.20.0
   */
  export type Executable<Child extends Any> = Child["machine"] extends EnsureExecutable<
    Machine.States<Child["machine"]>,
    Machine.UnhandledStates<Child["machine"]>,
    Machine.OutputStates<Child["machine"]>
  > ? unknown
    : never

  /**
   * Startup arguments accepted while spawning a child machine.
   *
   * @category utility types
   * @since 0.20.0
   */
  export type SpawnArgs<Child extends Any> = Machine.InputSchema<Child["machine"]> extends typeof Schema.Void ?
    [options?: { readonly input?: never }]
    : [options: { readonly input: Machine.Input<Child["machine"]> }]

  /**
   * Typed failures that may occur before a spawned child becomes active.
   *
   * @category utility types
   * @since 0.20.0
   */
  export type StartError<Child extends Any> = Child extends ChildMachine<string, infer M> ?
      | Machine.InitialError<M>
      | Machine.Error<M>
      | ActionError<Machine.InitialServices<M> | Machine.Services<M>>
      | InfiniteTransitionError
      | MachineSchemaDecodeError
      | StartupError
      | StoppedError
    : never

  /**
   * Services needed to initialize a spawned child machine.
   *
   * @category utility types
   * @since 0.20.0
   */
  export type StartRequirements<Child extends Any> = Child extends ChildMachine<string, infer M> ? Exclude<
      ExcludeCompatibleRuntime<
        Exclude<ExecutionServices<Machine.InitialServices<M> | Machine.Services<M>>, MachineRuntimeRequirement>,
        Machine.Event<M>,
        Machine.EmittedEvent<M>
      >,
      Scope.Scope
    >
    : never

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
 * Effectful operations for child machines owned directly by the current
 * machine process.
 *
 * @category models
 * @since 0.20.0
 */
export interface ChildOwner<OwnerEvent> {
  /** Starts a process-owned child and returns once initialization succeeds. */
  readonly spawn: <const Child extends ChildMachine.Any>(
    child: Child & ChildMachine.Executable<Child> & ChildMachine.ParentCompatibility<Child, OwnerEvent>,
    ...options: ChildMachine.SpawnArgs<Child>
  ) => Effect.Effect<
    ChildMachine.Ref<Child>,
    ChildAlreadyExistsError | ChildMachine.StartError<Child>,
    ChildMachine.StartRequirements<Child>
  >

  /** Sends an event to one active child. Missing children are ignored. */
  readonly sendTo: <Child extends ChildMachine.Any>(
    child: Child,
    event: ChildMachine.Event<Child>
  ) => Effect.Effect<void, StoppedError>

  /** Stops one active child. Missing children are ignored. */
  readonly stop: <Child extends ChildMachine.Any>(child: Child) => Effect.Effect<void>
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
    readonly root: Pick<State<Machine.StateNodeConfig>, typeof StateTypeId | "node">
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
  export type EmittedEvent<M extends Any> = EmittedEventOf<EmittedEvents<M>>

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
    /** Human-readable label used by visualization and documentation tooling. */
    readonly title?: string | undefined
    /** Short explanation of the state node's domain meaning. */
    readonly description?: string | undefined
    /** Longer documentation text associated with the state node. */
    readonly documentation?: string | undefined
  }

  /** Descriptive annotations accepted by schema-less active and pseudo-states. */
  export type SchemaLessStateAnnotations = Pick<
    StateNodeAnnotations,
    "title" | "description" | "documentation"
  >

  /**
   * Configuration accepted for an atomic object state node.
   *
   * Omit `schema` when the state owns no value. A schema-less final may still
   * declare `output`.
   *
   * @category models
   * @since 0.4.0
   */
  export type AtomicStateNodeConfig =
    | {
      /** Tagged schema that owns the state's decoded value. */
      readonly schema: TaggedSchema
      /** Declares an ordinary active state. Omitted values default to `"active"`. */
      readonly type?: "active"
      /** Atomic active states cannot declare terminal output. */
      readonly output?: never
      /** Schema-backed states take their annotations from the schema. */
      readonly annotations?: never
    }
    | {
      readonly schema: TaggedSchema
      readonly type: "final"
      /** Optional schema describing the terminal value produced by this final state. */
      readonly output?: Schema.Top
      readonly annotations?: never
    }
    | {
      readonly schema?: never
      readonly type?: "active"
      readonly output?: never
      /** Descriptive metadata for a schema-less state. */
      readonly annotations?: SchemaLessStateAnnotations
    }
    | {
      readonly schema?: never
      readonly type: "final"
      /** Optional schema describing the terminal value produced by this final state. */
      readonly output?: Schema.Top
      /** Descriptive metadata for a schema-less state. */
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
      /** Tagged schema that owns the compound state's decoded value. */
      readonly schema: TaggedSchema
      /** Compound states are ordinary active states. */
      readonly type?: "active"
      /** Direct child selected when the compound state is entered initially. */
      /** Nested state nodes owned by this compound state. */
      readonly states: StateTree
      /** Schema-backed states take their annotations from the schema. */
      readonly annotations?: never
    }
    | {
      readonly schema?: never
      readonly type?: "active"
      readonly states: StateTree
      /** Descriptive metadata for a schema-less state. */
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
      /** Tagged schema that owns the parallel state's decoded value. */
      readonly schema: TaggedSchema
      /** Selects parallel-region semantics for the node. */
      readonly type: "parallel"
      /** Optional schema describing the value produced after every region completes. */
      readonly output?: Schema.Top
      /** Child regions that are entered and remain active simultaneously. */
      readonly states: StateTree
      /** Schema-backed states take their annotations from the schema. */
      readonly annotations?: never
    }
    | {
      readonly schema?: never
      readonly type: "parallel"
      readonly output?: Schema.Top
      readonly states: StateTree
      /** Descriptive metadata for a schema-less state. */
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
    /** Selects history pseudo-state semantics. */
    readonly type: "history"
    /**
     * Restores only the direct child for shallow history or the complete
     * descendant configuration for deep history.
     *
     * @defaultValue `"shallow"`
     */
    readonly history?: "shallow" | "deep"
    /** Descriptive metadata used by visualization and documentation tooling. */
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
    /** Selects transient choice pseudo-state semantics. */
    readonly type: "choice"
    /** Descriptive metadata used by visualization and documentation tooling. */
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

  /**
   * Typed snapshot access shared by state descriptors.
   *
   * **Details**
   *
   * The helpers match and read snapshots for the same captured topology.
   *
   * @category models
   * @since 0.4.0
   */
  export interface StateAccessors<States extends StateSchemas> {
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
        path:
          & Path
          & (Path extends NoInfer<From> | (NoInfer<From> extends "" ? string : `${NoInfer<From>}.${string}`) ? unknown
            : never)
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
        path:
          & Path
          & (Path extends NoInfer<From> | (NoInfer<From> extends "" ? string : `${NoInfer<From>}.${string}`) ? unknown
            : never)
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
        path:
          & Path
          & (Path extends NoInfer<From> | (NoInfer<From> extends "" ? string : `${NoInfer<From>}.${string}`) ? unknown
            : never)
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
      readonly updates: ReadonlyArray<string>
    }
    | {
      readonly type: "branch"
      readonly key: string
      readonly title: string
      readonly target: Path | undefined
      readonly selection: TransitionTargetSelection<Path | undefined>
      readonly updates: ReadonlyArray<string>
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
   * Every branch exposes its static selection without executing its resolver.
   * A compound local or branch target covers its descendants. An `update`
   * selection keeps `target` undefined and records its value owner in
   * `selection.path`; `none` identifies an explicitly targetless branch.
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
    /** Retained valued owners replaced by this transition. */
    readonly updates: ReadonlyArray<string>
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
  > = IsAny<States> extends true ? unknown : [ChoiceIdentifier<States>] extends [never] ? unknown
  : [MissingChoiceImplementations<States, UnhandledStates>] extends [never] ? unknown
  : {
    readonly "~effect/Machine/MissingChoiceImplementation": MissingChoiceImplementations<States, UnhandledStates>
  }

  /** @internal Readiness proof required by planning and managed execution. */
  export type EnsureHistoryImplementations<
    States extends StateSchemas,
    UnhandledStates extends StateIdentifier<States>
  > = IsAny<States> extends true ? unknown :
    & ([HistoryIdentifier<States>] extends [never] ? unknown
      : [MissingHistoryImplementations<States, UnhandledStates>] extends [never] ? unknown :
      {
        readonly "~effect/Machine/MissingHistoryImplementation": MissingHistoryImplementations<States, UnhandledStates>
      })
    & EnsureChoiceImplementations<States, UnhandledStates>

  /** Owners that require a handler-owned initial edge or region data. */
  export type RequiredInitializers<States extends StateSchemas> = string extends keyof States ? never :
    "" extends keyof States ? InitializerClosureForNode<States, States[""], ""> :
    never

  /** Proof that initialization can construct every required default value. */
  export type EnsureInitialImplementations<
    States extends StateSchemas,
    UnhandledStates extends StateIdentifier<States>
  > = [UnhandledStates] extends [never] ? unknown
    : [Extract<RequiredInitializers<States>, UnhandledStates>] extends [never] ? unknown :
    {
      readonly "~effect/Machine/MissingInitialImplementation": Extract<RequiredInitializers<States>, UnhandledStates>
    }

  /**
   * Extracts a state-tree node by state path.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type NodeByIdentifier<
    States extends StateSchemas,
    StateId extends StateIdentifier<States>
  > = string extends keyof States ? NodeByNamedIdentifier<States, StateId>
    : "" extends keyof States ? StateId extends "" ? States[""]
      : States[""] extends { readonly states: infer Children extends StateSchemas }
        ? NodeByIdentifier<Children, Extract<StateId, StateIdentifier<Children>>> :
      never
    : NodeByNamedIdentifier<States, StateId>

  type NodeByNamedIdentifier<States extends StateSchemas, StateId extends string> = StateId extends
    `${infer Head}.${infer Rest}`
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
  export type ParentStateIdentifier<StateId extends string> = StateId extends "" ? never
    : "" | NamedParentStateIdentifier<StateId>

  type NamedParentStateIdentifier<StateId extends string> = StateId extends `${infer Parent}.${infer Child}`
    ? Parent | (Child extends `${string}.${string}` ? `${Parent}.${NamedParentStateIdentifier<Child>}` : never)
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
    : StateId extends "" ? never
    : ""

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
  > = Prefix extends "" ? TerminalOutput<Children> : {
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
    readonly value?: Schema.Json
  }

  /**
   * Encoded output for one completed state path in a normalized machine
   * snapshot. An omitted output means the final state declares no output
   * schema; a declared `Schema.Void` or `Schema.Undefined` output encodes as
   * canonical JSON `null`.
   *
   * @category models
   * @since 0.4.0
   */
  export interface EncodedSnapshotCompletion {
    readonly path: string
    readonly output?: Schema.Json
  }

  /** Encoded values and paths retained by one history pseudo-state. */
  export interface EncodedSnapshotHistoryEntry {
    readonly mode: "shallow" | "deep"
    readonly active: ReadonlyArray<string>
    readonly values: Readonly<Record<string, Schema.Json>>
  }

  /**
   * Normalized data representation of a machine snapshot.
   *
   * **Details**
   *
   * Active state and completion values use the canonical JSON representations
   * derived from their declared schemas. A successfully encoded snapshot is
   * safe to pass to JSON-backed persistence and transport. Runtime process state
   * such as children, fibers, scopes, queues, and subscriptions is not included.
   *
   * @category models
   * @since 0.4.0
   */
  export interface EncodedSnapshot {
    readonly version: 2
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
  export type RootStateIdentifier<StateId extends string> = StateId extends string ? "" : never

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
  export interface StateConstruction<out Result> {
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
   * Opaque instruction that replaces one active compound or parallel state's
   * value without changing its active descendants.
   *
   * @category models
   * @since 0.21.0
   */
  export interface StateUpdate<
    States extends StateSchemas,
    StateId extends ValuedStateIdentifier<States>
  > {
    readonly [Topology.StateUpdateTypeId]: {
      readonly states: Types.Covariant<States>
      readonly owner: Types.Covariant<StateId>
    }
  }

  /**
   * Opaque result that combines one topology target with one retained owner
   * value replacement in the same microstep.
   *
   * @category models
   * @since 0.22.0
   */
  export interface CombinedTarget<
    Result,
    States extends StateSchemas,
    Owner extends ValuedStateIdentifier<States>
  > {
    readonly [Topology.CombinedTargetTypeId]: {
      readonly result: Types.Covariant<Result>
      readonly states: Types.Covariant<States>
      readonly owner: Types.Covariant<Owner>
    }
  }

  /** @internal */
  type StateUpdateBuilder<
    States extends StateSchemas,
    StateId extends ValuedStateIdentifier<States>
  > = {
    readonly decoded: (value: StateByIdentifier<States, StateId>) => StateUpdate<States, StateId>
    readonly from: FromCallable<
      readonly [input: SchemaByIdentifier<States, StateId>["~type.make.in"]],
      StateUpdate<States, StateId>
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
  > = HistorySnapshotMethod<
    { readonly "": Extract<Omit<States[""], "~effect/Machine/ExplicitInitial">, StateNodeConfig> },
    "" & ActiveStateKey<{ readonly "": Extract<Omit<States[""], "~effect/Machine/ExplicitInitial">, StateNodeConfig> }>,
    "",
    Owner
  >

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
    Extract<"" extends keyof States ? "" : RootStateIdentifier<Source>, ActiveStateKey<States>>,
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
    in out States extends StateSchemas,
    in out Source extends StateNodeIdentifier<States>
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
    out Kind extends Topology.TargetSelectionKind = Topology.TargetSelectionKind,
    out Scope extends Topology.TargetSelectionScope | undefined = Topology.TargetSelectionScope | undefined
  > {
    readonly [Topology.TargetSelectionTypeId]: typeof Topology.TargetSelectionTypeId
    readonly kind: Kind
    readonly scope: Scope
    readonly path: Path
    readonly "~effect/Machine/TargetSelectionResult"?: Types.Covariant<Result>
  }

  type SelectionValue<
    Builder,
    Path extends string,
    Kind extends Topology.TargetSelectionKind = "state",
    Scope extends Topology.TargetSelectionScope | undefined = Topology.TargetSelectionScope | undefined
  > = TargetSelection<Builder, Path, Kind, Scope>

  type SelectionMethod<
    Builder,
    Path extends string,
    Kind extends Topology.TargetSelectionKind = "state",
    Scope extends Topology.TargetSelectionScope | undefined = Topology.TargetSelectionScope | undefined
  > = () => SelectionValue<Builder, Path, Kind, Scope>

  type RootBuilder<Builder> = Builder extends { readonly "": infer Root } ? Root : never

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
    /** Value owned by the state whose handler is running. */
    readonly state: StateByIdentifier<States, StateId>
    /** Value owned by the nearest schema-backed ancestor, when one exists. */
    readonly containingState: ParentStateValue<States, StateId>
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: ParentStateValues<States, StateId>
    /** Complete logical configuration captured at the start of this microstep. */
    readonly snapshot: Snapshot<States>
    /** Event that selected this handler, narrowed by its `_tag`. */
    readonly event: EventByTag<Events, EventTag>

    /** Value owned by the logical root. */
    readonly root: StateByIdentifier<States, Extract<"", StateIdentifier<States>>>
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
    /** Value owned by the state entering or exiting. */
    readonly state: StateByIdentifier<States, StateId>
    /** Value owned by the nearest schema-backed ancestor, when one exists. */
    readonly containingState: ParentStateValue<States, StateId>
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: ParentStateValues<States, StateId>
    /** Event or initial-entry marker responsible for the lifecycle action. */
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
    /** Process-owned child operations for dynamic child machine lifecycles. */
    readonly children: ChildOwner<EventOf<InputEvents>>
    /** Value owned by the state that owns this invocation. */
    readonly state: StateByIdentifier<States, StateId>
    /** Value owned by the logical root. */
    readonly root: StateByIdentifier<States, Extract<"", StateIdentifier<States>>>
    /** Value owned by the nearest schema-backed ancestor, when one exists. */
    readonly containingState: ParentStateValue<States, StateId>
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: ParentStateValues<States, StateId>
    /** Event or initial-entry marker responsible for starting the invocation. */
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
    /** Parent-local invocation identifier. */
    readonly id: string
    /** Current value of the state that owns the invocation. */
    readonly state: StateByIdentifier<States, StateId>
    /** Value owned by the nearest schema-backed ancestor, when one exists. */
    readonly containingState: ParentStateValue<States, StateId>
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: ParentStateValues<States, StateId>
    /** Value owned by the logical root. */
    readonly root: StateByIdentifier<States, Extract<"", StateIdentifier<States>>>
    /** Latest active lifecycle snapshot published by the invoked logic or child. */
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
    /** Parent-local invocation identifier. */
    readonly id: string
    /** Current value of the state that owns the invocation. */
    readonly state: StateByIdentifier<States, StateId>
    /** Value owned by the nearest schema-backed ancestor, when one exists. */
    readonly containingState: ParentStateValue<States, StateId>
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: ParentStateValues<States, StateId>
    /** Complete owning-machine configuration captured for this transition. */
    readonly snapshot: Snapshot<States>
    /** Value owned by the logical root. */
    readonly root: StateByIdentifier<States, Extract<"", StateIdentifier<States>>>
    /** Successful output produced by the invocation. */
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
    /** Parent-local invocation identifier. */
    readonly id: string
    /** Current value of the state that owns the Stream invocation. */
    readonly state: StateByIdentifier<States, StateId>
    /** Value owned by the nearest schema-backed ancestor, when one exists. */
    readonly containingState: ParentStateValue<States, StateId>
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: ParentStateValues<States, StateId>
    /** Complete owning-machine configuration captured for this transition. */
    readonly snapshot: Snapshot<States>
    /** Value owned by the logical root. */
    readonly root: StateByIdentifier<States, Extract<"", StateIdentifier<States>>>
    /** Next element emitted by the invoked Stream. */
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
    /** Parent-local invocation identifier. */
    readonly id: string
    /** Current value of the state that owns the invocation. */
    readonly state: StateByIdentifier<States, StateId>
    /** Value owned by the nearest schema-backed ancestor, when one exists. */
    readonly containingState: ParentStateValue<States, StateId>
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: ParentStateValues<States, StateId>
    /** Complete owning-machine configuration captured for this transition. */
    readonly snapshot: Snapshot<States>
    /** Value owned by the logical root. */
    readonly root: StateByIdentifier<States, Extract<"", StateIdentifier<States>>>
    /** Typed failure produced by the invocation. */
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
    /** Current value of the state evaluating the eventless transition. */
    readonly state: StateByIdentifier<States, StateId>
    /** Value owned by the nearest schema-backed ancestor, when one exists. */
    readonly containingState: ParentStateValue<States, StateId>
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: ParentStateValues<States, StateId>
    /** Complete logical configuration captured at the start of this microstep. */
    readonly snapshot: Snapshot<States>
    /** Lifecycle event retained while the eventless transition is evaluated. */
    readonly event: LifecycleEvent<Events>

    /** Value owned by the logical root. */
    readonly root: StateByIdentifier<States, Extract<"", StateIdentifier<States>>>
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
    /** Current value of the state whose child configuration completed. */
    readonly state: StateByIdentifier<States, StateId>
    /** Value owned by the nearest schema-backed ancestor, when one exists. */
    readonly containingState: ParentStateValue<States, StateId>
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: ParentStateValues<States, StateId>
    /** Complete logical configuration captured at the start of this microstep. */
    readonly snapshot: Snapshot<States>
    /** Lifecycle event retained while state completion is processed. */
    readonly event: LifecycleEvent<Events>
    /** Output produced by the completed final child or parallel regions. */
    readonly output: CompletionOutputByIdentifier<States, StateId>

    /** Value owned by the logical root. */
    readonly root: StateByIdentifier<States, Extract<"", StateIdentifier<States>>>
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
    /** Value owned by the choice node's immediate schema-backed parent. */
    readonly containingState: StateByIdentifier<
      States,
      Extract<ImmediateParentStateIdentifier<ChoiceId>, StateIdentifier<States>>
    >
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: {
      readonly [Parent in Extract<ParentStateIdentifier<ChoiceId>, ValuedStateIdentifier<States>>]: StateByIdentifier<
        States,
        Parent
      >
    }
    /** Lifecycle event that led to the transient choice. */
    readonly event: LifecycleEvent<Events>
    /** Value owned by the logical root. */
    readonly root: StateByIdentifier<States, Extract<"", StateIdentifier<States>>>
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
    /** Decoded value owned by the final state. */
    readonly state: StateByIdentifier<States, StateId>
    /** Value owned by the nearest schema-backed ancestor, when one exists. */
    readonly containingState: ParentStateValue<States, StateId>
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: ParentStateValues<States, StateId>
    /** Lifecycle event responsible for entering the final state. */
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
    /** Decoded value owned by the completed parallel state. */
    readonly state: StateByIdentifier<States, StateId>
    /** Value owned by the nearest schema-backed ancestor, when one exists. */
    readonly containingState: ParentStateValue<States, StateId>
    /** Schema-backed ancestor values keyed by their complete state paths. */
    readonly ancestors: ParentStateValues<States, StateId>
    /** Lifecycle event retained while parallel completion is processed. */
    readonly event: LifecycleEvent<Events>
    /** Completion output from every direct parallel region. */
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
  export type InitialResult<States extends StateSchemas, E, R> = InitialTarget<StateIdentifier<States>>

  /**
   * Return value accepted from transition handlers.
   *
   * **Details**
   *
   * Handlers return snapshots for complete state replacement, target builder
   * results for path-safe partial transitions, state-value updates, or
   * an explicit targetless result. In a machine definition, select `{ none: true }`;
   * its optional resolver returns `undefined`. Raw decoded state values are
   * not accepted as transition targets.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type HandlerResult<States extends StateSchemas, E, R> =
    | Snapshot<States>
    | Target<States, StateIdentifier<States>>
    | HistoryTarget<States, HistoryIdentifier<States>>
    | ChoiceTarget<States, ChoiceIdentifier<States>>
    | StateUpdate<States, ValuedStateIdentifier<States>>
    | CombinedTarget<
      Target<States, StateIdentifier<States>> | Snapshot<States>,
      States,
      ValuedStateIdentifier<States>
    >
    | StateConstruction<
      | Snapshot<States>
      | Target<States, StateIdentifier<States>>
      | HistoryTarget<States, HistoryIdentifier<States>>
      | ChoiceTarget<States, ChoiceIdentifier<States>>
      | StateUpdate<States, ValuedStateIdentifier<States>>
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
  export type EventTransitionReturn<Transition> = Transition extends
    { readonly initial: TargetReference<any, infer P, any> } ? InitialTarget<P>
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
  export type InvokeResolvedSource<Source> = Source extends LazyProgramValue ? Source
    : Source extends (...args: any) => infer Resolved ? Resolved
    : Source

  type InvokeFactoryResult<Source> = Source extends (...args: any) => infer Resolved ? Resolved : never

  type ChildMachineLogic<Child> = Child extends ChildMachine<string, infer M> ? Logic<
      Snapshot<States<M>>,
      EventInput<InputEvent<M>>,
      Error<M> | ActionError<Services<M>> | InfiniteTransitionError | MachineSchemaDecodeError | StoppedError,
      ExcludeCompatibleRuntime<
        Exclude<ExecutionServices<InitialServices<M> | Services<M>>, internalRuntime.MachineRuntime>,
        Event<M>,
        EmittedEvent<M>
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
    : LogicInitialErrorOf<InvokeLogic<Invoke>>
  /**
   * Extracts the runtime error from an invoked child process.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InvokeRuntimeError<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly error: Types.Covariant<infer Error> }
  } ? Error
    : LogicErrorOf<InvokeLogic<Invoke>>
  /**
   * Extracts the output from an invoked child process.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InvokeOutput<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly output: Types.Covariant<infer Output> }
  } ? Output
    : LogicOutputOf<InvokeLogic<Invoke>>
  /**
   * Extracts the service requirements from an invoke source child process logic.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InvokeServices<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly requirements: Types.Covariant<infer Requirements> }
  } ? Requirements
    : LogicServicesOf<InvokeLogic<Invoke>>
  /**
   * Extracts events emitted directly by an invoked child.
   *
   * @category utility types
   * @since 0.4.0
   */
  export type InvokeEmits<Invoke> = Invoke extends {
    readonly [InvokeTypeId]: { readonly emits: Types.Covariant<infer Emitted> }
  } ? Emitted
    : Invoke extends { readonly child: ChildMachine<string, infer M> } ? EmittedEvent<M>
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
  export type ConfigServices<Config> = Config extends unknown ? [keyof Config] extends [never] ? never :
    | Effect.Services<EventHandlerReturn<Config>>
    | Effect.Services<AlwaysReturn<Config>>
    | Effect.Services<DoneReturn<Config>>
    | Effect.Services<StateActionReturn<Config, "entry">>
    | Effect.Services<StateActionReturn<Config, "exit">>
    | Effect.Services<HistoryDefaultReturn<Config>>
    | Effect.Services<ChoiceReturn<Config>>
    | InvokeRequirements<Config>
    : never

  /** The only transition value accepted by machine handler APIs. */
  type TransitionConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context,
    Reenter extends boolean = false,
    Acceptance extends TransitionAcceptance = "required"
  > = Transition<States, StateId, Context, Events, Emits, {}, Reenter, Acceptance>

  export type SelectionBuilder<Selection> = Selection extends TargetSelection<infer Builder, any, any, any> ? Builder
    : never
  export type SelectionKind<Selection> = Selection extends TargetSelection<any, any, infer Kind, any> ? Kind : never
  export type SelectionPath<Selection> = Selection extends TargetSelection<any, infer Path, any, any> ? Path : never
  export type TargetBuilderResult<Builder> =
    | (Builder extends (...args: any) => infer Result ? Result : never)
    | (Builder extends { readonly decoded: (...args: any) => infer Result } ? Result : never)
    | (Builder extends { readonly from: (...args: any) => infer Result } ? Result : never)
  export type SelectedTargetResult<Selection> = SelectionBuilder<Selection> extends infer Builder ?
    TargetBuilderResult<Builder>
    : never

  /**
   * Destination construction returned when a transition declares one retained
   * valued owner with a `{ target, update }` declaration.
   *
   * @category models
   * @since 0.22.0
   */
  export interface UpdatingStateConstruction<
    Result,
    States extends StateSchemas,
    Owner extends ValuedStateIdentifier<States>
  > {
    /** Combines the selected topology with the required owner replacement. */
    readonly update: (
      update: StateUpdate<States, Owner>
    ) => CombinedTarget<UnwrapConstruction<Result>, States, Owner>
  }

  type UpdatingCallable<
    Callable,
    States extends StateSchemas,
    Owner extends ValuedStateIdentifier<States>
  > = Callable extends {
    (...args: infer Arguments1): infer Result1
    (...args: infer Arguments2): infer Result2
  } ? {
      (...args: Arguments1): UpdatingStateConstruction<Result1, States, Owner>
      (...args: Arguments2): UpdatingStateConstruction<Result2, States, Owner>
    }
    : Callable extends (...args: infer Arguments) => infer Result ?
      (...args: Arguments) => UpdatingStateConstruction<Result, States, Owner>
    : never

  type UpdatingTargetBuilder<
    Builder,
    States extends StateSchemas,
    Owner extends ValuedStateIdentifier<States>
  > = {
    readonly [Key in keyof Builder]: Key extends "from" | "decoded" ? UpdatingCallable<Builder[Key], States, Owner>
      : Builder[Key]
  }

  type SelectionSupportsDefaultConstruction<Selection> = SelectionKind<Selection> extends "none" ? true
    : SelectionBuilder<Selection> extends { readonly from: (...args: infer Args) => any } ? [] extends Args ? true
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
    /** Declines this candidate and continues hierarchical transition selection. */
    readonly decline: () => Declined
  }

  /** One named destination declared by a branching transition. */
  export interface TransitionBranchInput<
    Selection extends TargetSelection<any, any, any> = TargetSelection<any, any, any>
  > {
    /** Exact topology destination available to the branching resolver. */
    readonly target: Selection
    /** Optional human-readable branch label used by visualization tooling. */
    readonly title?: string
  }

  /** Opaque evidence that a branching resolver selected one declared branch. */
  export interface SelectedBranch<out Key extends string, out Result> {
    readonly [Topology.SelectedBranchTypeId]: {
      readonly key: Types.Covariant<Key>
      readonly result: Types.Covariant<Result>
    }
  }

  type CompletedBranchResult<R> = R extends { readonly update: unknown }
    ? R extends UpdatingStateConstruction<infer Target, infer S, infer Owner>
      ? CombinedTarget<UnwrapConstruction<Target>, S, Owner>
    : R
    : R
  type SelectedConstruction<K extends string, R> = R extends { readonly update: unknown } ?
    R extends UpdatingStateConstruction<infer Target, infer S, infer Owner> ? {
        readonly update: SelectedBranchBuilder<StateUpdateBuilder<S, Owner>, K> extends infer B ? {
            readonly [M in keyof B]:
              StateUpdateBuilder<S, Owner>[Extract<M, keyof StateUpdateBuilder<S, Owner>>] extends
                (...args: infer A) => unknown
                ? (...args: A) => SelectedBranch<K, CombinedTarget<UnwrapConstruction<Target>, S, Owner>>
                : never
          } :
          never
      }
    : SelectedBranch<K, R> :
    SelectedBranch<K, R>
  type SelectedBranchCallable<Callable, Key extends string> = Callable extends {
    (...args: infer Arguments1): infer Result1
    (...args: infer Arguments2): infer Result2
  } ? {
      (...args: Arguments1): SelectedConstruction<Key, Result1>
      (...args: Arguments2): SelectedConstruction<Key, Result2>
    }
    : Callable extends (...args: infer Arguments) => infer Result ?
      (...args: Arguments) => SelectedConstruction<Key, Result>
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
      CompletedBranchResult<SelectedTargetResult<Branches[Key]["target"]>>
    >
  }[Extract<keyof Branches, string>]

  export type TransitionBranchesResolveContext<
    Context,
    Branches extends Readonly<Record<string, TransitionBranchInput>>
  > = Omit<Context, "target"> & { readonly select: BranchSelectors<Branches> }

  export type InvokeTransition<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    StateId extends StateNodeIdentifier<States>,
    Context
  > = TransitionConfig<States, Events, Emits, StateId, Context, true, TransitionAcceptance>

  export type InvokeSource<Value, Context> = Value | ((context: Context) => Value)

  /** Inline state-owned work that runs for the lifetime of its active state. */
  interface InvokeOwned<
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

  /** Output construction available to final and output-producing parallel states. */
  type OutputHandlerConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    StateId extends StateIdentifier<States>,
    Context
  > = NodeByIdentifier<States, StateId> extends { readonly output: Schema.Top } ? {
      /** Constructs the decoded output declared by the state's `output` schema. */
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

  /** Context used only when a history node has no previously captured record. */
  export interface HistoryDefaultContext<
    in out States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    in out ParentId extends StateIdentifier<States>
  > {
    /** Lifecycle event that attempted to restore this history node. */
    readonly event: LifecycleEvent<Events>
    /** Complete target builder rooted at the history owner. */
    readonly target: HistoryDefaultTargetBuilder<States, ParentId>
    /** State path whose child configuration is restored by this history node. */
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
    enqueue: Enqueue<EventOf<Events>, EmittedEventOf<Emits>>
  ) =>
    | CompleteSnapshotContaining<States, ParentId>
    | StateConstruction<CompleteSnapshotContaining<States, ParentId>>

  /**
   * Fallback implementation for one direct history pseudo-state.
   *
   * @inline
   */
  interface HistoryDefaultEntry<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    ParentId extends StateIdentifier<States>
  > {
    /** Builds the complete fallback configuration used before history is first captured. */
    readonly default: HistoryDefaultHandler<States, Events, Emits, ParentId>
  }

  /**
   * Default implementations keyed by direct history child.
   *
   * @inlineType HistoryDefaultEntry
   */
  export type HistoryDefaultConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    ParentId extends StateIdentifier<States>,
    Children extends StateSchemas
  > = {
    readonly [Key in HistoryStateKey<Children>]?: HistoryDefaultEntry<States, Events, Emits, ParentId>
  }

  /** Required implementation for a choice pseudo-state. */
  interface ChoiceStateConfig<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    ChoiceId extends ChoiceIdentifier<States>,
    InputEvents extends ReadonlyArray<TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<TaggedSchema> = readonly []
  > {
    /** Required transition that resolves this transient choice to a concrete destination. */
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
  }

  type HandlerChildren<Node> = Node extends { readonly states: infer Children extends StateSchemas } ? Children : never

  type HandlerConfigPart<Config> = {
    readonly [Key in keyof Config as Key extends "states" | "initial" | "root" ? never : Key]: Config[Key]
  }

  type HandlerNodeChildrenConfig<Config> = "states" extends keyof Config ?
    Config extends { readonly states?: infer Children } ? NonNullable<Children>
    : never
    : never

  type HandlerNodeByPath<States extends StateSchemas, Path extends string> = "" extends keyof States ?
    Path extends "" ? States[""]
    : States[""] extends { readonly states: infer Children extends StateSchemas } ? HandlerNodeByPath<Children, Path>
    : never
    : Path extends `${infer Head}.${infer Rest}` ? Head extends keyof States ? States[Head] extends {
          readonly states: infer Children extends StateSchemas
        } ? HandlerNodeByPath<Children, Rest>
        : never
      : never
    : Path extends keyof States ? States[Path]
    : never

  // Resolve only the supplied branch for a flattened state-node path. Keeping
  // this recursion on the finite path avoids recursively expanding an open
  // generic handler config.
  type HandlerConfigAtPath<Config, Path extends string> = [Config] extends [never] ? never :
    "" extends keyof Config ? Path extends "" ? Config[""]
      : HandlerConfigAtPath<HandlerNodeChildrenConfig<Config[""]>, Path>
    : Path extends `${infer Head}.${infer Rest}` ?
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

  type HandlerNodeConfigKey =
    | "always"
    | "choice"
    | "entry"
    | "exit"
    | "history"
    | "initial"
    | "root"
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
    UnknownKeys extends string = Exclude<Extract<keyof Config, string>, ActiveStateKey<States> | ChoiceStateKey<States>>
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

  type HandlerTreeInitialTargetPath<Config> = string extends keyof Config ? never
    : Config extends object ? {
        readonly [Key in keyof Config]:
          | HandlerConfigInitialTargetPath<HandlerConfigPart<Config[Key]>>
          | (Config[Key] extends { readonly states: infer Children } ? HandlerTreeInitialTargetPath<Children> : never)
      }[keyof Config]
    : never

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
    : StateId extends RequiredHistoryInitializers<AllStates> | RequiredInitializers<AllStates> ?
      "initial" extends keyof Config ? unknown : {
        readonly initial: HandlerValidationError<
          "State requires an initial declaration for shallow history restoration",
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
        & ValidateConstructionDeclarations<Node, Config>
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
    Incompatible = keyof Config extends never ? never : IncompatibleRuntime<
      ConfigServices<HandlerConfigPart<Config>>,
      EventOf<Events>,
      EmittedEventOf<Emits>
    >
  > = [Incompatible] extends [never] ? unknown
    : HandlerValidationError<"Handler config requires an incompatible machine runtime", StateId, Incompatible>

  type RootInitialTargetValidation<States extends StateSchemas, Config> =
    RequiredInitializersForTargetPath<States, HandlerTreeInitialTargetPath<{ readonly "": Config }>> extends
      infer Required ? Types.UnionToIntersection<
        Required extends string ?
          HandlerConfigAtPath<{ readonly "": Config }, Required> extends infer NodeConfig ?
            [NodeConfig] extends [never] ? RootInitializeError<Required>
            : "initial" extends keyof NodeConfig ? never
            : RootInitializeError<Required>
          : never :
          unknown
      > :
      unknown

  type RootInitializeError<Path extends string> = Path extends "" ? {
      readonly initialize: HandlerValidationError<
        "State requires initialize because a transition enters its declared initial configuration",
        Path
      >
    } :
    {
      readonly states: HandlerValidationAtPath<Path, {
        readonly initialize: HandlerValidationError<
          "State requires initialize because a transition enters its declared initial configuration",
          Path
        >
      }>
    }

  type HandlerTreeValidation<
    States extends StateSchemas,
    Node,
    Events extends ReadonlyArray<TaggedSchema>,
    InputEvents extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Path extends StateNodeIdentifier<States>,
    Config,
    OutputStates extends StateIdentifier<States>
  > =
    & HandlerNodeValidation<
      States,
      Node,
      Events,
      InputEvents,
      Emits,
      Path,
      Config,
      OutputStates
    >
    & (Config extends { readonly states: infer Handlers }
      ? Node extends { readonly states: infer Children extends StateSchemas } ? {
          readonly states: {
            readonly [K in keyof Handlers]: K extends keyof Children ? HandlerTreeValidation<
                States,
                Children[K],
                Events,
                InputEvents,
                Emits,
                Extract<JoinPath<Path, Extract<K, string>>, StateNodeIdentifier<States>>,
                Handlers[K],
                OutputStates
              > :
              unknown
          }
        } :
      unknown
      : unknown)

  type RootHandlerValidation<
    States extends StateSchemas,
    Events extends ReadonlyArray<TaggedSchema>,
    InputEvents extends ReadonlyArray<TaggedSchema>,
    Emits extends ReadonlyArray<TaggedSchema>,
    Config,
    OutputStates extends StateIdentifier<States>
  > = HandlerTreeValidation<
    States,
    States[""],
    Events,
    InputEvents,
    Emits,
    Extract<"", StateNodeIdentifier<States>>,
    Config,
    OutputStates
  >

  type HandlerHasRequiredInitial<
    Node,
    Config
  > = Node extends { readonly states: infer Children extends StateSchemas }
    ? Node extends { readonly type: "parallel" }
      ? HasRequiredActiveChild<Children> extends true ? "initial" extends keyof Config ? true : false : true
    : "initial" extends keyof Config ? true
    : false
    : true

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
  > = HandlerHasRequiredInitial<Node, Config> extends true ?
    HandlerHasRequiredHistoryDefaults<Node, Config> extends true ?
      HandlerHasRequiredChoices<Node, Config> extends true ? StateId : never
    : never
    : never

  type HandlerConfigError<Config> = Config extends unknown ? [keyof Config] extends [never] ? never :
    | Effect.Error<EventHandlerReturn<Config>>
    | Effect.Error<AlwaysReturn<Config>>
    | Effect.Error<DoneReturn<Config>>
    | Effect.Error<StateActionReturn<Config, "entry">>
    | Effect.Error<StateActionReturn<Config, "exit">>
    | Effect.Error<HistoryDefaultReturn<Config>>
    | Effect.Error<ChoiceReturn<Config>>
    | InvokeError<Config>
    : never

  type HandlerNodeEvidence<
    AllStates extends StateSchemas,
    Node,
    StateId extends StateNodeIdentifier<AllStates>,
    NodeConfig
  > = [NodeConfig] extends [never] ? never : {
    readonly stateId: StateId extends StateIdentifier<AllStates> ? HandlerImplementedStateId<
        AllStates,
        Node,
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
  type HandlerTreeEvidence<
    AllStates extends StateSchemas,
    Config,
    Nodes extends StateSchemas = AllStates,
    Prefix extends string = ""
  > = {
    readonly [K in Extract<keyof Config & keyof Nodes, string>]:
      | HandlerNodeEvidence<
        AllStates,
        Nodes[K],
        Extract<JoinPath<Prefix, K>, StateNodeIdentifier<AllStates>>,
        Config[K]
      >
      | (Nodes[K] extends { readonly states: infer Children extends StateSchemas }
        ? Config[K] extends { readonly states: infer Handlers }
          ? HandlerTreeEvidence<AllStates, Handlers, Children, JoinPath<Prefix, K>>
        : never
        : never)
  }[Extract<keyof Config & keyof Nodes, string>]

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
      EmittedEventOf<Emits>
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

  type ObjectCompoundPath<S extends StateSchemas> = {
    readonly [P in StateIdentifier<S>]: NodeByIdentifier<S, P> extends {
      /** Child handlers nested according to the declared root topology. */
      readonly states: StateSchemas
    } ? P :
      never
  }[StateIdentifier<S>]
  type LazyProgramValue = Effect.Effect<unknown, unknown, unknown> | Stream.Stream<unknown, unknown, unknown>

  /** Registered lazy programs and their optional explicit input adapters. */
  export type Program<Value> = Value | ((...args: never[]) => Value)
  export type EffectSources = Readonly<Record<string, Program<Effect.Effect<unknown, unknown, unknown>>>>
  export type StreamSources = Readonly<Record<string, Program<Stream.Stream<unknown, unknown, unknown>>>>
  export type TimerSources = Readonly<Record<string, Program<Duration.Input>>>
  export type LogicSources = Readonly<Record<string, unknown>>
  export type ValidateLogicSources<Sources> = {
    readonly [K in keyof Sources]: InvokeResolvedSource<Sources[K]> extends {
      /** Enters a compound or parallel subtree through its declared initialization. */
      readonly initial: (...args: never[]) => Effect.Effect<unknown, unknown, unknown>
      readonly run: (...args: never[]) => Effect.Effect<unknown, unknown, unknown>
    } ? unknown
      : never
  }

  export type ChildSources = Readonly<Record<string, ChildMachine.Any>>
  export type ValidatePrograms<Sources> = {
    readonly [K in keyof Sources]: Sources[K] extends LazyProgramValue ? unknown :
      Sources[K] extends (...args: never[]) => unknown ? Parameters<Sources[K]>["length"] extends 1 ? unknown : never
      : unknown
  }
  type ReferenceRoot<S extends StateSchemas> = Extract<S[""], StateNodeConfig>
  type ReferenceAt<S extends StateSchemas, P extends StateNodeIdentifier<S> | HistoryIdentifier<S>> = TargetReference<
    ReferenceRoot<S>,
    P,
    P extends HistoryIdentifier<S> ? "history" : P extends ChoiceIdentifier<S> ? "choice" : "state"
  >
  type ReferenceUnion<S extends StateSchemas, Paths extends StateNodeIdentifier<S> | HistoryIdentifier<S>> = {
    readonly [P in Paths]: ReferenceAt<S, P>
  }[Paths]
  type DestinationPath<S extends StateSchemas> = Exclude<StateNodeIdentifier<S>, "">
  type RootSchemas<Root extends StateNodeConfig> = { readonly "": Root }

  /** A topology declaration; its state values are constructed by a resolver. */
  export type BranchDeclaration<Root extends StateNodeConfig, S extends StateSchemas = RootSchemas<Root>> =
    & {
      /** Optional presentation label for this named branch. */
      readonly title?: string
    }
    & (
      | {
        /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
        readonly target: ReferenceUnion<S, DestinationPath<S>>
        /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
        readonly update?: ReferenceUnion<S, ValuedStateIdentifier<S>>
        /** Enters a compound or parallel subtree through its declared initialization. */
        readonly initial?: never
        /** Restores the declared history reference, using its fallback on first entry. */
        readonly history?: never
        /** Accepts the event without selecting a new destination. */
        readonly none?: never
      }
      | {
        /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
        readonly update: ReferenceUnion<S, ValuedStateIdentifier<S>>
        /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
        readonly target?: never
        /** Enters a compound or parallel subtree through its declared initialization. */
        readonly initial?: never
        /** Restores the declared history reference, using its fallback on first entry. */
        readonly history?: never
        /** Accepts the event without selecting a new destination. */
        readonly none?: never
      }
      | {
        /** Enters a compound or parallel subtree through its declared initialization. */
        readonly initial: ReferenceUnion<S, Exclude<ObjectCompoundPath<S>, "">>
        /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
        readonly target?: never
        /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
        readonly update?: never
        /** Restores the declared history reference, using its fallback on first entry. */
        readonly history?: never
        /** Accepts the event without selecting a new destination. */
        readonly none?: never
      }
      | {
        /** Restores the declared history reference, using its fallback on first entry. */
        readonly history: ReferenceUnion<S, HistoryIdentifier<S>>
        /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
        readonly target?: never
        /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
        readonly update?: never
        /** Enters a compound or parallel subtree through its declared initialization. */
        readonly initial?: never
        /** Accepts the event without selecting a new destination. */
        readonly none?: never
      }
      | {
        /** Accepts the event without selecting a new destination. */
        readonly none: true
        /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
        readonly target?: never
        /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
        readonly update?: never
        /** Enters a compound or parallel subtree through its declared initialization. */
        readonly initial?: never
        /** Restores the declared history reference, using its fallback on first entry. */
        readonly history?: never
      }
    )
  export type BranchDefinitions<Root extends StateNodeConfig> = Readonly<
    Record<string, Readonly<Record<string, BranchDeclaration<Root>>>>
  >
  /** Source programs and named topology declarations captured by a machine definition. */
  export interface Registrations {
    /** Lazy Effects or functions with one required input, invoked by registered name. */
    readonly effects?: EffectSources
    /** Lazy Streams or functions with one required input, invoked by registered name. */
    readonly streams?: StreamSources
    /** Cancellable delays, supplied as durations or functions of one required input. */
    readonly timers?: TimerSources
    /** Logic values or functions of one required input; their Effect channels remain inferred. */
    readonly logic?: LogicSources
    /** Child machine descriptors registered for state-owned invocation. */
    readonly children?: ChildSources
    /** Named groups of inspectable destinations used by transition resolvers. */
    readonly branches?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  }
  type Registered<R, Kind extends PropertyKey> = Kind extends keyof R ? NonNullable<R[Kind]> : {}
  type AtBuilder<T, P extends string> = P extends "" ? T
    : P extends `${infer H}.${infer Rest}` ? H extends keyof T ? AtBuilder<T[H], Rest> : never
    : P extends keyof T ? T[P]
    : never
  type BranchBuilderAt<S extends StateSchemas, Src extends StateNodeIdentifier<S>, P extends string> = AtBuilder<
    RootBuilder<BranchTargetBuilder<S, Src>>,
    P
  >
  type RefPath<R> = R extends TargetReference<any, infer P, any> ? P : never
  type SelectionOf<S extends StateSchemas, Src extends StateNodeIdentifier<S>, D> = D extends {
    /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
    readonly target: infer Ref
  } ? RefPath<Ref> extends infer P extends StateNodeIdentifier<S> ? D extends {
        /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
        readonly update: infer Update
      } ?
        RefPath<Update> extends
          infer Owner extends Extract<ParentStateIdentifier<Src>, ParentStateIdentifier<P> & ValuedStateIdentifier<S>>
          ? TargetSelection<UpdatingTargetBuilder<BranchBuilderAt<S, Src, P>, S, Owner>, P, "state", "branch"> :
        never
      : TargetSelection<BranchBuilderAt<S, Src, P>, P, P extends ChoiceIdentifier<S> ? "choice" : "state", "branch">
    : never
    : D extends {
      /** Enters a compound or parallel subtree through its declared initialization. */
      readonly initial: infer Ref
    } ? RefPath<Ref> extends infer P extends string ? BranchBuilderAt<S, Src, P> extends {
          /** Enters a compound or parallel subtree through its declared initialization. */
          readonly initial: infer B
        } ? TargetSelection<B, P, "initial", "branch">
        : never :
      never
    : D extends {
      /** Restores the declared history reference, using its fallback on first entry. */
      readonly history: infer Ref
    } ?
      RefPath<Ref> extends infer P extends string
        ? TargetSelection<AtBuilder<RootBuilder<HistoryTargetBuilder<S>>, P>, P, "history", "full"> :
      never
    : D extends {
      /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
      readonly update: infer Ref
    } ?
      RefPath<Ref> extends infer P extends Extract<Src | ParentStateIdentifier<Src>, ValuedStateIdentifier<S>>
        ? TargetSelection<StateUpdateBuilder<S, P>, P, "update", "branch"> :
      never
    : D extends {
      /** Accepts the event without selecting a new destination. */
      readonly none: true
    } ? TargetSelection<() => NoTarget, never, "none", "local">
    : never
  type BuilderArgs<B, K extends PropertyKey> = K extends keyof B
    ? B[K] extends (...args: infer A) => unknown ? A : never
    : never
  type ObjectConstruction<C, B> = {
    readonly [M in Extract<keyof B, "from" | "decoded">]: BuilderArgs<B, M> extends readonly [unknown?] ?
        & { readonly [K in M]: (context: C) => BuilderArgs<B, M>[0] }
        & { readonly [K in Exclude<"from" | "decoded", M>]?: never }
      : never
  }[Extract<keyof B, "from" | "decoded">]
  type ObjectDefault<B> = B extends {
    /** Constructs schema make input from the typed source context. */
    readonly from: () => unknown
  } | (() => unknown) ? {
      /** Constructs schema make input from the typed source context. */
      readonly from?: never /** Supplies an already decoded schema value from the typed source context. */
      readonly decoded?: never
    }
    : never
  type ObjectPolicy<C, Reenter extends boolean, Acceptance extends TransitionAcceptance> = {
    /** Set to true to exit and reenter the handler source. */
    readonly reenter?: Reenter extends true ? boolean : never
    /** Declines the transition before construction when the predicate returns false. */
    readonly guard?: "declinable" extends Acceptance ? ((context: C) => boolean) | undefined : never
  }
  // Leaf construction needs only schema inputs; expanding the path builder also
  // computes unrelated nested targets for each contextual event callback.
  type InlineNodeConstruction<C, Node> = [NodeSchema<Node>] extends [never] ? {
      readonly from?: (context: C) => undefined
      readonly decoded?: never
    } :
    | { readonly from: (context: C) => NodeMakeInput<Node>; readonly decoded?: never }
    | { readonly decoded: (context: C) => NodeValue<Node>; readonly from?: never }
    | ({} extends NodeMakeInput<Node> ? { readonly from?: never; readonly decoded?: never } : never)
  type InlineDestinationConstruction<
    S extends StateSchemas,
    Src extends StateNodeIdentifier<S>,
    P extends DestinationPath<S>,
    C
  > = P extends ChoiceIdentifier<S> ? { readonly from?: never; readonly decoded?: never }
    : P extends StateIdentifier<S> ?
      NodeByIdentifier<S, P> extends { readonly states: StateSchemas }
        ? [NodeSchema<NodeByIdentifier<S, P>>] extends [never]
          ? ObjectConstruction<C, BranchBuilderAt<S, Src, P>> | ObjectDefault<BranchBuilderAt<S, Src, P>>
        : never
      : InlineNodeConstruction<C, NodeByIdentifier<S, P>>
    : never
  type InlineDestination<S extends StateSchemas, Src extends StateNodeIdentifier<S>, C> = {
    readonly [P in DestinationPath<S>]:
      & {
        /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
        readonly target: ReferenceAt<S, P>
        /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
        readonly update?: never
        /** Enters a compound or parallel subtree through its declared initialization. */
        readonly initial?: never
        /** Restores the declared history reference, using its fallback on first entry. */
        readonly history?: never
        /** Accepts the event without selecting a new destination. */
        readonly none?: never
        /** Named groups of inspectable destinations used by transition resolvers. */
        readonly branches?: never
        /** Selects one declared branch and may enqueue synchronous commands. */
        readonly resolve?: never
        /** Set to true when the resolver can explicitly return decline(). */
        readonly declinable?: never
      }
      & InlineDestinationConstruction<S, Src, P, C>
  }[DestinationPath<S>]
  type InlinePairConstruction<
    S extends StateSchemas,
    Src extends StateNodeIdentifier<S>,
    P extends string,
    Owner extends ValuedStateIdentifier<S>,
    C
  > = P extends StateIdentifier<S> ? NodeByIdentifier<S, P> extends { readonly states: StateSchemas } ? {
        readonly [
          M in Extract<keyof BranchBuilderAt<S, Src, P> & keyof StateUpdateBuilder<S, Owner>, "from" | "decoded">
        ]: BuilderArgs<BranchBuilderAt<S, Src, P>, M> extends readonly [unknown?] ?
            & {
              readonly [K in M]: (
                context: C
              ) => {
                /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
                readonly target: BuilderArgs<BranchBuilderAt<S, Src, P>, M>[0]
                /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
                readonly update: BuilderArgs<StateUpdateBuilder<S, Owner>, M>[0]
              }
            }
            & { readonly [K in Exclude<"from" | "decoded", M>]?: never }
          : never
      }[Extract<keyof BranchBuilderAt<S, Src, P> & keyof StateUpdateBuilder<S, Owner>, "from" | "decoded">]
    :
      | {
        readonly from: (
          context: C
        ) => {
          readonly target: [NodeSchema<NodeByIdentifier<S, P>>] extends [never] ? undefined
            : NodeMakeInput<NodeByIdentifier<S, P>>
          readonly update: SchemaByIdentifier<S, Owner>["~type.make.in"]
        }
        readonly decoded?: never
      }
      | ([NodeSchema<NodeByIdentifier<S, P>>] extends [never] ? never
        : {
          readonly decoded: (
            context: C
          ) => { readonly target: NodeValue<NodeByIdentifier<S, P>>; readonly update: StateByIdentifier<S, Owner> }
          readonly from?: never
        })
    : never
  type InlineCombined<S extends StateSchemas, Src extends StateNodeIdentifier<S>, C> = Src extends ChoiceIdentifier<S> ?
    never :
    [Extract<ParentStateIdentifier<Src>, ValuedStateIdentifier<S>>] extends [never] ? never :
    {
      readonly [P in DestinationPath<S>]: {
        readonly [Owner in Extract<ParentStateIdentifier<Src>, ParentStateIdentifier<P> & ValuedStateIdentifier<S>>]:
          & {
            /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
            readonly target: ReferenceAt<S, P>
            /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
            readonly update: ReferenceAt<S, Owner>
            /** Enters a compound or parallel subtree through its declared initialization. */
            readonly initial?: never
            /** Restores the declared history reference, using its fallback on first entry. */
            readonly history?: never
            /** Accepts the event without selecting a new destination. */
            readonly none?: never
            /** Named groups of inspectable destinations used by transition resolvers. */
            readonly branches?: never
            /** Selects one declared branch and may enqueue synchronous commands. */
            readonly resolve?: never
            /** Set to true when the resolver can explicitly return decline(). */
            readonly declinable?: never
          }
          & InlinePairConstruction<S, Src, P, Owner, C>
      }[Extract<ParentStateIdentifier<Src>, ParentStateIdentifier<P> & ValuedStateIdentifier<S>>]
    }[DestinationPath<S>]
  type InlineUpdate<S extends StateSchemas, Src extends StateNodeIdentifier<S>, C> = Src extends ChoiceIdentifier<S> ?
    never :
    {
      readonly [P in Extract<Src | ParentStateIdentifier<Src>, ValuedStateIdentifier<S>>]:
        & {
          /** Set to true to exit and reenter the handler source. */
          readonly reenter?: P extends Src ? never : boolean
          /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
          readonly update: ReferenceAt<S, P>
          /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
          readonly target?: never
          /** Enters a compound or parallel subtree through its declared initialization. */
          readonly initial?: never
          /** Restores the declared history reference, using its fallback on first entry. */
          readonly history?: never
          /** Accepts the event without selecting a new destination. */
          readonly none?: never
          /** Named groups of inspectable destinations used by transition resolvers. */
          readonly branches?: never
          /** Selects one declared branch and may enqueue synchronous commands. */
          readonly resolve?: never
          /** Set to true when the resolver can explicitly return decline(). */
          readonly declinable?: never
        }
        & ObjectConstruction<C, StateUpdateBuilder<S, P>>
    }[Extract<Src | ParentStateIdentifier<Src>, ValuedStateIdentifier<S>>]
  type InlineInitial<S extends StateSchemas, Src extends StateNodeIdentifier<S>, C> =
    [Exclude<ObjectCompoundPath<S>, "">] extends [never] ? never : {
      readonly [P in Exclude<ObjectCompoundPath<S>, "">]: InitialTargetFactory<NodeByIdentifier<S, P>, P> extends
        infer B ?
          & {
            /** Enters a compound or parallel subtree through its declared initialization. */
            readonly initial: ReferenceAt<S, P>
            /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
            readonly target?: never
            /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
            readonly update?: never
            /** Restores the declared history reference, using its fallback on first entry. */
            readonly history?: never
            /** Accepts the event without selecting a new destination. */
            readonly none?: never
            /** Named groups of inspectable destinations used by transition resolvers. */
            readonly branches?: never
            /** Selects one declared branch and may enqueue synchronous commands. */
            readonly resolve?: never
            /** Set to true when the resolver can explicitly return decline(). */
            readonly declinable?: never
          }
          & (ObjectConstruction<C, B> | ObjectDefault<B>) :
        never
    }[Exclude<ObjectCompoundPath<S>, "">]
  type BranchSelections<S extends StateSchemas, Src extends StateNodeIdentifier<S>, Group> = {
    readonly [K in Extract<keyof Group, string>]: {
      /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
      readonly target: SelectionOf<S, Src, Group[K]>
    }
  }
  type ObjectBranchResolver<
    Ev extends ReadonlyArray<TaggedSchema>,
    Em extends ReadonlyArray<TaggedSchema>,
    C,
    B extends Readonly<Record<string, TransitionBranchInput>>,
    Declinable extends boolean
  > = (
    context: C & { readonly select: BranchSelectors<B> } & DeclineCapability,
    enqueue: Enqueue<EventOf<Ev>, EmittedEventOf<Em>>
  ) => BranchSelectionResult<B> | (Declinable extends true ? Declined : never)
  type InvalidBranchSelection<S extends StateSchemas, Src extends StateNodeIdentifier<S>, Group> = {
    readonly [K in keyof Group]: Src extends ChoiceIdentifier<S> ? Group[K] extends {
        /** Accepts the event without selecting a new destination. */
        readonly none: true
      } | {
        /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
        readonly update: unknown
      } ? K
      : [SelectionBuilder<SelectionOf<S, Src, Group[K]>>] extends [never] ? K
      : never
      : [SelectionBuilder<SelectionOf<S, Src, Group[K]>>] extends [never] ? K
      : never
  }[keyof Group]
  type ObjectBranches<
    S extends StateSchemas,
    Src extends StateNodeIdentifier<S>,
    C,
    Ev extends ReadonlyArray<TaggedSchema>,
    Em extends ReadonlyArray<TaggedSchema>,
    R,
    Acceptance extends TransitionAcceptance
  > = {
    readonly [K in Extract<keyof Registered<R, "branches">, string>]:
      & ([InvalidBranchSelection<S, Src, Registered<R, "branches">[K]>] extends [never] ? unknown : never)
      & {
        /** Named groups of inspectable destinations used by transition resolvers. */
        readonly branches: K
        /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
        readonly target?: never
        /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
        readonly update?: never
        /** Enters a compound or parallel subtree through its declared initialization. */
        readonly initial?: never
        /** Restores the declared history reference, using its fallback on first entry. */
        readonly history?: never
        /** Accepts the event without selecting a new destination. */
        readonly none?: never
        /** Constructs schema make input from the typed source context. */
        readonly from?: never
        /** Supplies an already decoded schema value from the typed source context. */
        readonly decoded?: never
      }
      & {
        /** Set to true when the resolver can explicitly return decline(). */
        readonly declinable?: "declinable" extends Acceptance ? boolean : false
        /** Selects one declared branch and may enqueue synchronous commands. */
        readonly resolve: ObjectBranchResolver<Ev, Em, C, BranchSelections<S, Src, Registered<R, "branches">[K]>, true>
      }
  }[Extract<keyof Registered<R, "branches">, string>]
  type DataValue<C, A> = A | ((context: C) => A)
  type DeclarationData<T> = T extends { readonly from: (context: infer C) => infer A }
    ? Omit<T, "from" | "decoded"> & { readonly data: DataValue<C, A>; readonly decoded?: false }
    : T extends { readonly decoded: (context: infer C) => infer A }
      ? Omit<T, "from" | "decoded"> & { readonly data: DataValue<C, A>; readonly decoded: true }
    : T extends unknown ? Omit<T, "from" | "decoded"> & { readonly data?: never; readonly decoded?: never }
    : never
  /**
   * A transition with an inspectable destination and source-specific construction.
   *
   * @category models
   * @since 0.34.0
   */
  export type Transition<
    S extends StateSchemas,
    Src extends StateNodeIdentifier<S>,
    C,
    Ev extends ReadonlyArray<TaggedSchema>,
    Em extends ReadonlyArray<TaggedSchema>,
    R,
    Reenter extends boolean = false,
    Acceptance extends TransitionAcceptance = "required"
  > =
    & ObjectPolicy<C, Reenter, Acceptance>
    & DeclarationData<
      (
        | InlineDestination<S, Src, C>
        | InlineUpdate<S, Src, C>
        | InlineCombined<S, Src, C>
        | InlineInitial<S, Src, C>
        | {
          /** Restores the declared history reference, using its fallback on first entry. */
          readonly history: ReferenceUnion<S, HistoryIdentifier<S>>
          /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
          readonly target?: never
          /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
          readonly update?: never
          /** Enters a compound or parallel subtree through its declared initialization. */
          readonly initial?: never
          /** Accepts the event without selecting a new destination. */
          readonly none?: never
          /** Named groups of inspectable destinations used by transition resolvers. */
          readonly branches?: never
          /** Selects one declared branch and may enqueue synchronous commands. */
          readonly resolve?: never
          /** Constructs schema make input from the typed source context. */
          readonly from?: never
          /** Supplies an already decoded schema value from the typed source context. */
          readonly decoded?: never
          /** Set to true when the resolver can explicitly return decline(). */
          readonly declinable?: never
        }
        | (Src extends ChoiceIdentifier<S> ? never : {
          /** Accepts the event without selecting a new destination. */
          readonly none: true
          /** Selects a declared descendant; its transition or bound branch constructor supplies required values. */
          readonly target?: never
          /** Replaces the complete value of a retained source or ancestor without replacing its active children. */
          readonly update?: never
          /** Enters a compound or parallel subtree through its declared initialization. */
          readonly initial?: never
          /** Restores the declared history reference, using its fallback on first entry. */
          readonly history?: never
          /** Named groups of inspectable destinations used by transition resolvers. */
          readonly branches?: never
          /** Constructs schema make input from the typed source context. */
          readonly from?: never
          /** Supplies an already decoded schema value from the typed source context. */
          readonly decoded?: never
          /** Set to true when the resolver can explicitly return decline(). */
          readonly declinable?: "declinable" extends Acceptance ? boolean : false
          /** Selects one declared branch and may enqueue synchronous commands. */
          readonly resolve?: (
            context: C & DeclineCapability,
            enqueue: Enqueue<EventOf<Ev>, EmittedEventOf<Em>>
          ) => undefined | Declined
        })
        | ObjectBranches<S, Src, C, Ev, Em, R, Acceptance>
      )
    >
  type SourceValue<R, K extends PropertyKey> = {
    readonly [Kind in "effects" | "streams" | "timers" | "logic" | "children"]: K extends keyof Registered<R, Kind>
      ? Registered<R, Kind>[K]
      : never
  }["effects" | "streams" | "timers" | "logic" | "children"]
  type SourceKind<R, K extends PropertyKey> = {
    readonly [Kind in "effects" | "streams" | "timers" | "logic" | "children"]: K extends keyof Registered<R, Kind>
      ? Kind
      : never
  }["effects" | "streams" | "timers" | "logic" | "children"]
  type SourceKeys<R> = {
    readonly [Kind in "effects" | "streams" | "timers" | "logic" | "children"]: keyof Registered<R, Kind>
  }["effects" | "streams" | "timers" | "logic" | "children"]
  type SourceInput<F, C> = F extends LazyProgramValue ? { readonly input?: never } :
    F extends (...args: never[]) => unknown ? Parameters<F>["length"] extends 1 ? {
          /** Maps the owning state context to the registered source input. */
          readonly input: (context: C) => Parameters<F>[0]
        } :
      never
    : {
      /** Maps the owning state context to the registered source input. */
      readonly input?: never
    }
  type ResolvedInvoke<R, K extends PropertyKey> = SourceKind<R, K> extends "effects" ?
    { readonly effect: () => InvokeResolvedSource<SourceValue<R, K>> }
    : SourceKind<R, K> extends "streams" ? { readonly stream: () => InvokeResolvedSource<SourceValue<R, K>> }
    : SourceKind<R, K> extends "timers" ? { readonly after: Duration.Input }
    : SourceKind<R, K> extends "logic" ? {
        /** Logic values or functions of one required input; their Effect channels remain inferred. */
        readonly logic: InvokeResolvedSource<SourceValue<R, K>>
      }
    : SourceKind<R, K> extends "children" ?
        & { readonly child: SourceValue<R, K> }
        & (SourceValue<R, K> extends ChildMachine<string, infer M> ? {
            readonly [InvokeTypeId]: {
              readonly error: Types.Covariant<Error<M> | ActionError<Services<M>>>
              readonly initialError: Types.Covariant<InitialError<M>>
              readonly requirements: Types.Covariant<Services<M>>
            }
          } :
          never) :
    never
  type RegisteredInvocationInput<R, K extends PropertyKey, C> = SourceKind<R, K> extends "children" ?
    SourceValue<R, K> extends ChildMachine<string, infer M> ? InputSchema<M> extends typeof Schema.Void ? {
          /** Maps the owning state context to the registered source input. */
          readonly input?: never
        }
      : {
        /** Maps the owning state context to the registered source input. */
        readonly input: (context: C) => Input<M>
      } :
    never
    : SourceInput<SourceValue<R, K>, C>
  type ObjectOutcome<
    S extends StateSchemas,
    Ev extends ReadonlyArray<TaggedSchema>,
    Em extends ReadonlyArray<TaggedSchema>,
    Src extends StateIdentifier<S>,
    In extends ReadonlyArray<TaggedSchema>,
    Pa extends ReadonlyArray<TaggedSchema>,
    R,
    V,
    Channel extends "onDone" | "onFailure" | "onElement" | "onSnapshot"
  > = [V] extends [never] ? {} : Channel extends "onDone" ? {
      /** Handles successful invocation or state completion with its exact output type. */
      readonly onDone: Transition<
        S,
        Src,
        InvokeDoneContext<S, Ev, Em, Src, V, In, Pa>,
        Ev,
        Em,
        R,
        true,
        TransitionAcceptance
      >
    } :
  Channel extends "onFailure" ? {
      /** Handles the typed failure of the invoked source; required exactly when that channel is reachable. */
      readonly onFailure: Transition<
        S,
        Src,
        InvokeFailureContext<S, Ev, Em, Src, V, In, Pa>,
        Ev,
        Em,
        R,
        true,
        TransitionAcceptance
      >
    } :
  Channel extends "onElement" ? {
      /** Handles each Stream element; required when the element type is reachable. */
      readonly onElement: Transition<
        S,
        Src,
        InvokeElementContext<S, Ev, Em, Src, V, In, Pa>,
        Ev,
        Em,
        R,
        true,
        TransitionAcceptance
      >
    } :
  {
    /** Optionally handles active snapshots of invoked logic or a child machine. */
    readonly onSnapshot: Transition<
      S,
      Src,
      InvokeSnapshotContext<S, Ev, Em, Src, V, never, never, In, Pa>,
      Ev,
      Em,
      R,
      true,
      TransitionAcceptance
    >
  }
  type RegisteredInvokeError<R, K extends PropertyKey> = SourceKind<R, K> extends "children"
    ? SourceValue<R, K> extends ChildMachine<string, infer M> ? Error<M> | ActionError<Services<M>> : never
    : InvokeRuntimeError<ResolvedInvoke<R, K>>
  /**
   * A registered source invocation with its required input and reachable outcomes.
   *
   * @category models
   * @since 0.34.0
   */
  export type Invocation<
    S extends StateSchemas,
    Ev extends ReadonlyArray<TaggedSchema>,
    Em extends ReadonlyArray<TaggedSchema>,
    Src extends StateIdentifier<S>,
    In extends ReadonlyArray<TaggedSchema>,
    Pa extends ReadonlyArray<TaggedSchema>,
    R
  > = {
    readonly [K in Extract<SourceKeys<R>, string>]: Types.Simplify<
      & {
        /** Name of the source registered in make. */
        readonly src: K
      }
      & (SourceKind<R, K> extends "children" ? {
          /** Lifecycle identifier; Effects, Streams, and timers default to their registered source name. */
          readonly id?:
            never /** Typed runtime address required for invoked logic; child descriptors carry their own address. */
          readonly address?: never
        }
        : SourceKind<R, K> extends "logic" ? {
            /** Lifecycle identifier; Effects, Streams, and timers default to their registered source name. */
            readonly id: InvokeLifecycleId
            /** Typed runtime address required for invoked logic; child descriptors carry their own address. */
            readonly address: ChildAddress<LogicEventOf<InvokeResolvedSource<SourceValue<R, K>>>>
          }
        : {
          /** Lifecycle identifier; Effects, Streams, and timers default to their registered source name. */
          readonly id?:
            InvokeLifecycleId /** Typed runtime address required for invoked logic; child descriptors carry their own address. */
          readonly address?: never
        })
      & (SourceKind<R, K> extends "children"
        ? SourceValue<R, K> extends ChildMachine<string, infer M>
          ? M extends EnsureExecutable<States<M>, UnhandledStates<M>, OutputStates<M>> ? unknown : never
        : never
        : unknown)
      & RegisteredInvocationInput<R, K, InvokeContext<S, Ev, Em, Src, In, Pa>>
      & ObjectOutcome<S, Ev, Em, Src, In, Pa, R, InvokeOutput<ResolvedInvoke<R, K>>, "onDone">
      & ObjectOutcome<S, Ev, Em, Src, In, Pa, R, RegisteredInvokeError<R, K>, "onFailure">
      & ObjectOutcome<
        S,
        Ev,
        Em,
        Src,
        In,
        Pa,
        R,
        SourceKind<R, K> extends "streams"
          ? Stream.Success<Extract<InvokeResolvedSource<SourceValue<R, K>>, Stream.Stream<any, any, any>>> :
          never,
        "onElement"
      >
      & (SourceKind<R, K> extends "logic" | "children" ? Partial<
          ObjectOutcome<S, Ev, Em, Src, In, Pa, R, LogicStateOf<InvokeLogic<ResolvedInvoke<R, K>>>, "onSnapshot">
        >
        : {})
    >
  }[Extract<SourceKeys<R>, string>]
  type OrdinaryData<A> = A extends unknown ?
      & A
      & (
        | { readonly decoded?: false | undefined }
        | { readonly data?: never }
      ) :
    never
  type ShortConstruction<C, Node> = [NodeSchema<Node>] extends [never] ? never
    : OrdinaryData<NodeMakeInput<Node>> | ((context: C) => NodeMakeInput<Node>) | {
      readonly decoded: true
      readonly data: DataValue<C, NodeValue<Node>>
    }
  type InitialData<C, Node> = [NodeSchema<Node>] extends [never] ? { readonly data?: never; readonly decoded?: never }
    :
      | (
        & { readonly decoded?: false }
        & ({} extends NodeMakeInput<Node> ? { readonly data?: DataValue<C, NodeMakeInput<Node>> }
          : { readonly data: DataValue<C, NodeMakeInput<Node>> })
      )
      | { readonly decoded: true; readonly data: DataValue<C, NodeValue<Node>> }
  type InitialEdge<S extends StateSchemas, Node, Src extends StateNodeIdentifier<S>, C> = Node extends
    { readonly states: infer Children extends StateSchemas } ? {
      readonly [K in ActiveStateKey<Children> | ChoiceStateKey<Children>]:
        & {
          readonly target: TargetReference<
            ReferenceRoot<S>,
            JoinPath<Src, K>,
            Children[K] extends ChoiceStateNodeConfig ? "choice" : "state"
          >
        }
        & InitialData<C, Children[K]>
    }[ActiveStateKey<Children> | ChoiceStateKey<Children>]
    : never
  type InitialRegions<C, Children extends StateSchemas> =
    & { readonly [K in ActiveStateKey<Children> as [NodeSchema<Children[K]>] extends [never] ? K : never]?: never }
    & {
      readonly [
        K in ActiveStateKey<Children> as [NodeSchema<Children[K]>] extends [never] ? never
          : {} extends NodeMakeInput<Children[K]> ? never
          : K
      ]: ShortConstruction<C, Children[K]>
    }
    & {
      readonly [
        K in ActiveStateKey<Children> as [NodeSchema<Children[K]>] extends [never] ? never
          : {} extends NodeMakeInput<Children[K]> ? K
          : never
      ]?: ShortConstruction<C, Children[K]>
    }
  type RequiresInitialHandler<Node> = Node extends { readonly states: StateSchemas } ? true : false
  type ChildHandlerMap<
    S extends StateSchemas,
    Children extends StateSchemas,
    Ev extends ReadonlyArray<TaggedSchema>,
    Em extends ReadonlyArray<TaggedSchema>,
    Src extends StateNodeIdentifier<S>,
    In extends ReadonlyArray<TaggedSchema>,
    Pa extends ReadonlyArray<TaggedSchema>,
    R
  > =
    & {
      readonly [
        K in ActiveStateKey<Children> | ChoiceStateKey<Children> as RequiresInitialHandler<Children[K]> extends true ? K
          : never
      ]: StateHandler<S, Children[K], Ev, Em, Extract<JoinPath<Src, K>, StateNodeIdentifier<S>>, In, Pa, R>
    }
    & {
      readonly [
        K in ActiveStateKey<Children> | ChoiceStateKey<Children> as RequiresInitialHandler<Children[K]> extends true
          ? never
          : K
      ]?: StateHandler<S, Children[K], Ev, Em, Extract<JoinPath<Src, K>, StateNodeIdentifier<S>>, In, Pa, R>
    }
  type ChildHandlers<
    S extends StateSchemas,
    Children extends StateSchemas,
    Ev extends ReadonlyArray<TaggedSchema>,
    Em extends ReadonlyArray<TaggedSchema>,
    Src extends StateNodeIdentifier<S>,
    In extends ReadonlyArray<TaggedSchema>,
    Pa extends ReadonlyArray<TaggedSchema>,
    R
  > = [
    {
      [K in ActiveStateKey<Children> | ChoiceStateKey<Children>]: RequiresInitialHandler<Children[K]> extends true ? K
        : never
    }[ActiveStateKey<Children> | ChoiceStateKey<Children>]
  ] extends [never] ? { readonly states?: ChildHandlerMap<S, Children, Ev, Em, Src, In, Pa, R> }
    : { readonly states: ChildHandlerMap<S, Children, Ev, Em, Src, In, Pa, R> }
  type InitialHandler<S extends StateSchemas, Node, Src extends StateNodeIdentifier<S>, C> = Node extends
    { readonly type: "parallel"; readonly states: infer Children extends StateSchemas }
    ? {} extends InitialRegions<C, Children> ? { readonly initial?: InitialRegions<C, Children> }
    : { readonly initial: InitialRegions<C, Children> }
    : Node extends { readonly states: StateSchemas } ? { readonly initial: InitialEdge<S, Node, Src, C> }
    : { readonly initial?: never }
  type RootConstruction<Node, Input> = [NodeSchema<Node>] extends [never] ?
    { /** Root-owned data is available only when the root declares a schema. */ readonly root?: never }
    : {} extends NodeMakeInput<Node> ? {
        /** Constructs root-owned data once from startup input. */ readonly root?: ShortConstruction<
          { readonly input: Input },
          Node
        >
      }
    : {
      /** Constructs root-owned data once from startup input. */ readonly root: ShortConstruction<
        { readonly input: Input },
        Node
      >
    }
  type ExactConstruction<C> = C extends { readonly decoded: true; readonly data: unknown }
    ? { readonly [K in Exclude<keyof C, "decoded" | "data">]: never }
    : unknown
  type ValidateInitialDeclaration<Node, C> = Node extends {
    readonly type: "parallel"
    readonly states: infer Children extends StateSchemas
  } ? { readonly [K in keyof C]: K extends ActiveStateKey<Children> ? ExactConstruction<C[K]> : never }
    : { readonly [K in Exclude<keyof C, "target" | "data" | "decoded">]: never }
  type ValidateConstructionDeclarations<Node, C> = {
    readonly [K in Extract<keyof C, "root" | "initial">]: K extends "root" ? ExactConstruction<C[K]>
      : K extends "initial" ? ValidateInitialDeclaration<Node, C[K]>
      : unknown
  }
  type ObjectLifecycle<
    S extends StateSchemas,
    Node,
    Ev extends ReadonlyArray<TaggedSchema>,
    Em extends ReadonlyArray<TaggedSchema>,
    Src extends StateNodeIdentifier<S>,
    In extends ReadonlyArray<TaggedSchema>,
    Pa extends ReadonlyArray<TaggedSchema>
  > = Src extends StateIdentifier<S> ?
      & {
        /** Runs synchronously on entry and may enqueue commands. */
        readonly entry?: (
          context: StateActionContext<S, Ev, Em, Src, In, Pa>,
          enqueue: Enqueue<EventOf<Ev>, EmittedEventOf<Em>>
        ) => StateActionResult<any, any>
      }
      & (Node extends { readonly type: "final" } ?
          & {
            /** Runs synchronously on exit and may enqueue commands. */
            readonly exit?: never
          }
          & OutputHandlerConfig<S, Ev, Src, FinalOutputContext<S, Ev, Src>>
        : {
          /** Runs synchronously on exit and may enqueue commands. */
          readonly exit?: (
            context: StateActionContext<S, Ev, Em, Src, In, Pa>,
            enqueue: Enqueue<EventOf<Ev>, EmittedEventOf<Em>>
          ) => StateActionResult<any, any>
        } & ActiveOutputHandlerConfig<S, Ev, Src>)
    : {
      /** Runs synchronously on entry and may enqueue commands. */
      readonly entry?: never /** Runs synchronously on exit and may enqueue commands. */
      readonly exit?: never /** Constructs the decoded output declared by the state schema. */
      readonly output?: never
    }
  /**
   * Handlers for a node of the declared root tree.
   *
   * @category models
   * @since 0.34.0
   */
  export type StateHandler<
    S extends StateSchemas,
    Node,
    Ev extends ReadonlyArray<TaggedSchema>,
    Em extends ReadonlyArray<TaggedSchema>,
    Src extends StateNodeIdentifier<S>,
    In extends ReadonlyArray<TaggedSchema>,
    Pa extends ReadonlyArray<TaggedSchema>,
    R
  > =
    & ObjectLifecycle<S, Node, Ev, Em, Src, In, Pa>
    & InitialHandler<
      S,
      Node,
      Src,
      StateActionContext<S, Ev, Em, Extract<Src, StateIdentifier<S>>, In, Pa> & {
        /** Root-owned data constructed before initial descendant values. */
        readonly root: StateByIdentifier<S, Extract<"", StateIdentifier<S>>>
      }
    >
    & (Src extends ChoiceIdentifier<S> ? {
        /** Required total transition for a transient choice state. */
        readonly choice: Transition<S, Src, ChoiceContext<S, Ev, Em, Src, In, Pa>, Ev, Em, R>
        /** Event handlers keyed by the public or internal event tag. */
        readonly on?: never
        /** Eventless transition evaluated during stabilization. */
        readonly always?: never
        /** Handles successful invocation or state completion with its exact output type. */
        readonly onDone?: never
        /** One registered invocation or an array with distinct lifecycle identities. */
        readonly invoke?: never
        /** Child handlers nested according to the declared root topology. */
        readonly states?: never
        /** Restores the declared history reference, using its fallback on first entry. */
        readonly history?: never
      }
      : Src extends StateIdentifier<S> ? Node extends { readonly type: "final" } ? {
            /** Event handlers keyed by the public or internal event tag. */
            readonly on?: never
            /** Eventless transition evaluated during stabilization. */
            readonly always?: never
            /** Handles successful invocation or state completion with its exact output type. */
            readonly onDone?: never
            /** Required total transition for a transient choice state. */
            readonly choice?: never
            /** One registered invocation or an array with distinct lifecycle identities. */
            readonly invoke?: never
            /** Child handlers nested according to the declared root topology. */
            readonly states?: never
            /** Restores the declared history reference, using its fallback on first entry. */
            readonly history?: never
          }
        :
          & {
            /** Event handlers keyed by the public or internal event tag. */
            readonly on?: {
              readonly [Tag in TagOf<Ev[number]>]?: Transition<
                S,
                Src,
                HandlerContext<S, Ev, Em, Src, Tag, never, never, In, Pa>,
                Ev,
                Em,
                R,
                true,
                TransitionAcceptance
              >
            }
            /** Eventless transition evaluated during stabilization. */
            readonly always?: Transition<
              S,
              Src,
              AlwaysContext<S, Ev, Em, Src, In, Pa>,
              Ev,
              Em,
              R,
              false,
              TransitionAcceptance
            >
            /** Handles successful invocation or state completion with its exact output type. */
            readonly onDone?: Transition<
              S,
              Src,
              DoneContext<S, Ev, Em, Src, In, Pa>,
              Ev,
              Em,
              R,
              false,
              TransitionAcceptance
            >
            /** Required total transition for a transient choice state. */
            readonly choice?: never
            /** One registered invocation or an array with distinct lifecycle identities. */
            readonly invoke?:
              | Invocation<S, Ev, Em, Src, In, Pa, R>
              | (ReadonlyArray<Invocation<S, Ev, Em, Src, In, Pa, R>> & {
                /** Name of the source registered in make. */
                readonly src?: never
              })
          }
          & (Node extends {
            /** Child handlers nested according to the declared root topology. */
            readonly states: infer Children extends StateSchemas
          } ? {
              /** Child handlers nested according to the declared root topology. */
              /** Restores the declared history reference, using its fallback on first entry. */
              readonly history?: HistoryDefaultConfig<S, Ev, Em, Src, Children>
            } & ChildHandlers<S, Children, Ev, Em, Src, In, Pa, R> :
            {
              /** Child handlers nested according to the declared root topology. */
              readonly states?: never /** Restores the declared history reference, using its fallback on first entry. */
              readonly history?: never
            }) :
      never)
  type ValidateObjectTransition<T> =
    & {
      readonly [
        K in Exclude<
          keyof T,
          | "target"
          | "update"
          | "initial"
          | "history"
          | "none"
          | "branches"
          | "data"
          | "decoded"
          | "resolve"
          | "guard"
          | "reenter"
          | "declinable"
        >
      ]: never
    }
    & (T extends {
      /** Set to true when the resolver can explicitly return decline(). */
      readonly declinable: infer D
    } ? boolean extends D ? {
          /** Set to true when the resolver can explicitly return decline(). */
          readonly declinable: never
        } :
      unknown
      : unknown)
    & (T extends {
      /** Set to true when the resolver can explicitly return decline(). */
      readonly declinable: true
    } ? unknown
      : T extends {
        /** Selects one declared branch and may enqueue synchronous commands. */
        readonly resolve: (...args: any[]) => infer Result
      } ? [Extract<Result, Declined>] extends [never] ? unknown : {
          /** Selects one declared branch and may enqueue synchronous commands. */
          readonly resolve: never
        }
      : unknown)
  type AllowedInvokeChannels<R, K extends PropertyKey> =
    | ([InvokeOutput<ResolvedInvoke<R, K>>] extends [never] ? never : "onDone")
    | ([RegisteredInvokeError<R, K>] extends [never] ? never : "onFailure")
    | (SourceKind<R, K> extends "streams"
      ? [Stream.Success<Extract<InvokeResolvedSource<SourceValue<R, K>>, Stream.Stream<any, any, any>>>] extends [never]
        ? never
      : "onElement"
      : never)
    | (SourceKind<R, K> extends "logic" | "children" ? "onSnapshot" : never)
  type ValidateObjectInvoke<I, R> = I extends ReadonlyArray<unknown> ?
    { readonly [K in keyof I]: ValidateObjectInvoke<I[K], R> } :
    I extends {
      /** Name of the source registered in make. */
      readonly src: infer Src extends PropertyKey
    } ? {
        readonly [K in keyof I]: K extends AllowedInvokeChannels<R, Src> ? ValidateObjectTransition<I[K]>
          : K extends "src" | "id" | "address" | "input" ? unknown
          : never
      } :
    never
  type ObjectDeclarations<C> =
    | Extract<keyof C, "on" | "always" | "onDone" | "choice" | "invoke">
    | (C extends { readonly states: infer Children }
      ? { readonly [K in keyof Children]: ObjectDeclarations<Children[K]> }[keyof Children]
      : never)
  type ValidateObjectConfig<C, R> = [ObjectDeclarations<C>] extends [never] ? unknown : {
    readonly [K in keyof C]: K extends "states" ? { readonly [P in keyof C[K]]: ValidateObjectConfig<C[K][P], R> }
      : K extends "on" ? { readonly [P in keyof C[K]]: ValidateObjectTransition<C[K][P]> }
      : K extends "always" | "onDone" | "choice" ? ValidateObjectTransition<C[K]>
      : K extends "invoke" ? ValidateObjectInvoke<C[K], R>
      : unknown
  }
  type NormalizeObjectInvoke<I, R> = I extends ReadonlyArray<unknown> ?
    { readonly [K in keyof I]: NormalizeObjectInvoke<I[K], R> }
    : I extends {
      /** Name of the source registered in make. */
      readonly src: infer K extends PropertyKey
    } ? Omit<I, "src"> & ResolvedInvoke<R, K>
    : I
  type NormalizeObjectConfig<C, R> = [SourceKeys<R>] extends [never] ? C : {
    readonly [K in keyof C]: K extends "states" ? { readonly [P in keyof C[K]]: NormalizeObjectConfig<C[K][P], R> }
      : K extends "invoke" ? NormalizeObjectInvoke<C[K], R>
      : C[K]
  }
  // Reverse-map authored fields to avoid expanding every possible transition.
  // Retain missing fields from H for required handlers and editor completion.
  type HandlerShape<C, H> =
    & {
      readonly [K in keyof C]: K extends keyof H ? K extends "states" ? {
            readonly [P in keyof C[K]]: P extends keyof NonNullable<H[K]>
              ? HandlerShape<C[K][P], NonNullable<NonNullable<H[K]>[P]>>
              : never
          }
        : H[K]
        : never
    }
    & Omit<H, keyof C>
  /**
   * Adds object handlers while checking topology, protocols, invocation outcomes, and readiness.
   *
   * @category combinators
   * @since 0.34.0
   */
  export interface Handler<
    S extends StateSchemas,
    Ev extends ReadonlyArray<TaggedSchema>,
    Em extends ReadonlyArray<TaggedSchema>,
    I extends Schema.Top,
    IE,
    IR,
    Final extends StateIdentifier<S>,
    Out,
    In extends ReadonlyArray<TaggedSchema>,
    Pa extends ReadonlyArray<TaggedSchema>,
    R
  > {
    <const C>(
      config:
        & C
        & (C extends (...args: never[]) => unknown ? never : unknown)
        & HandlerShape<
          C,
          & StateHandler<S, S[""], Ev, Em, Extract<"", StateNodeIdentifier<S>>, In, Pa, R>
          & RootConstruction<S[""], I["Type"]>
        >
        & RootConstruction<S[""], I["Type"]>
        & ValidateObjectConfig<NoInfer<C>, R>
        & RootHandlerValidation<
          S,
          Ev,
          In,
          Em,
          NormalizeObjectConfig<NoInfer<C>, R>,
          Extract<
            HandlerTreeEvidence<S, { readonly "": NormalizeObjectConfig<NoInfer<C>, R> }>["outputState"],
            StateIdentifier<S>
          >
        >
    ): HandleTreeResult<
      S,
      Ev,
      Em,
      I,
      StateIdentifier<S>,
      never,
      never,
      IE,
      IR,
      Final,
      Out,
      never,
      In,
      Pa,
      { readonly "": NormalizeObjectConfig<C, R> }
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
    /** Runs synchronously on entry and may enqueue commands. */
    readonly entry?: (
      context: StateActionContext<States, Events, Emits, StateId>,
      enqueue: Enqueue<EventOf<Events>, EmittedEventOf<Emits>>
    ) => StateActionResult<E, R>
    /** Runs synchronously on exit and may enqueue commands. */
    readonly exit?: (
      context: StateActionContext<States, Events, Emits, StateId>,
      enqueue: Enqueue<EventOf<Events>, EmittedEventOf<Emits>>
    ) => StateActionResult<E, R>
    /** One registered invocation or an array with distinct lifecycle identities. */
    readonly invoke?: StoredInvokeDefinition<States, Events, Emits, StateId>
    /** Eventless transition evaluated during stabilization. */
    readonly always?: TransitionConfig<
      States,
      Events,
      Emits,
      StateId,
      AlwaysContext<States, Events, Emits, StateId>,
      false,
      TransitionAcceptance
    >
    /** Handles successful invocation or state completion with its exact output type. */
    readonly onDone?: TransitionConfig<
      States,
      Events,
      Emits,
      StateId,
      DoneContext<States, Events, Emits, StateId>,
      false,
      TransitionAcceptance
    >
    /** Constructs the decoded output declared by the state schema. */
    readonly output?:
      | ((context: FinalOutputContext<States, Events, StateId>) => unknown)
      | ((context: ParallelOutputContext<States, Events, StateId>) => unknown)
    /** Event handlers keyed by the public or internal event tag. */
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

type StateSource = State<any> | Machine.Any

type StateSchemasOf<Source extends StateSource> = Source extends State<infer Node> ? { readonly "": Node }
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

/** Type utilities for logical snapshots, including snapshots carried by atom bridges. */
/** Typed traversal of root and child logical snapshots.
 * @category utility types
 * @since 0.32.0
 */
export declare namespace Snapshot {
  /** Every active node represented by a logical snapshot type. */
  export type Node<State> = State extends { readonly path: string; readonly value: unknown } ?
      | State
      | (State extends { readonly state: infer Child } ? Node<Child>
        : State extends {
          /** Child handlers nested according to the declared root topology. */
          readonly states: infer Regions
        } ? Node<Regions[keyof Regions]>
        : never) :
    never
  /** Every valid absolute path in a logical snapshot type. */
  export type Path<State> = Node<State> extends infer Current
    ? Current extends { readonly path: infer Path extends string } ? Path : never
    : never
  /** The node at one absolute path. Runtime access can still be inactive. */
  export type At<State, Path extends Snapshot.Path<State>> = Node<State> extends infer Current
    ? Current extends { readonly path: Path } ? Current : never
    : never
}

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
 * `State.getSnapshot`.
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
 * Defines root or nested state schemas while preserving the exact child topology.
 *
 * Pass the root descriptor to {@link make} and {@link targets}. Nested states
 * can be declared inline or reused by mounting a descriptor in multiple places.
 * Initial edges and value constructors belong in the handler tree.
 *
 * **Example** (Repeated compound state)
 *
 * ```ts
 * import { Machine } from "@typeonce/effect-machine"
 * import { Schema } from "effect"
 *
 * const TradingState = Schema.TaggedUnion({
 *   InSession: {},
 *   Applying: {}
 * })
 * const TradingSlot = Machine.state({
 *   states: {
 *     Idle: {},
 *     InSession: TradingState.cases.InSession,
 *     Applying: TradingState.cases.Applying
 *   }
 * })
 *
 * const States = Machine.state({
 *   states: {
 *     slot1: TradingSlot,
 *     slot2: TradingSlot
 *   }
 * })
 * ```
 *
 * @category constructors
 * @since 0.15.0
 */
export const state: StateConstructor = internal.state as StateConstructor

/**
 * An opaque reference to one node in a declared state tree.
 *
 * @category models
 * @since 0.34.0
 */
export interface TargetReference<
  Root extends Machine.StateNodeConfig,
  Path extends string,
  Kind extends "state" | "choice" | "history"
> {
  readonly [internal.TargetReferenceTypeId]: {
    readonly root: { readonly node: Root }
    readonly path: Path
    readonly kind: Kind
  }
}

type TargetReferenceTree<Root extends Machine.StateNodeConfig, Node, Path extends string> =
  & TargetReference<
    Root,
    Path,
    Node extends { readonly type: "history" } ? "history"
      : Node extends { readonly type: "choice" } ? "choice"
      : "state"
  >
  & (Node extends {
    /** Child handlers nested according to the declared root topology. */
    readonly states: infer Children
  } ? {
      readonly [Key in Extract<keyof Children, string>]: TargetReferenceTree<
        Root,
        Children[Key],
        Machine.JoinPath<Path, Key>
      >
    } :
    {})

/**
 * References for every path in a declared root tree.
 *
 * @category models
 * @since 0.34.0
 */
export interface Targets<Root extends Machine.StateNodeConfig> {
  /** Root data owner and the starting point for descendant state references. */
  readonly root: TargetReferenceTree<Root, Root, "">
}

/**
 * Derives immutable state references from a root descriptor.
 *
 * References follow the declared tree: `targets.root.Checkout.Review`.
 * Creating references does not construct state values or start machine work.
 *
 * @category constructors
 * @since 0.34.0
 */
export const targets: <const Root extends Machine.StateNodeConfig>(root: State<Root>) => Targets<Root> = internal
  .targets as unknown as <const Root extends Machine.StateNodeConfig>(
    root: State<Root>
  ) => Targets<Root>

type UniqueSourceNames<F, S, T, L, C> = [
  | Extract<keyof F, keyof S | keyof T | keyof L | keyof C>
  | Extract<keyof S, keyof T | keyof L | keyof C>
  | Extract<keyof T, keyof L | keyof C>
  | Extract<keyof L, keyof C>
] extends [never] ? unknown : { readonly "~effect/Machine/DuplicateSourceName": never }

type MakeConfig<
  Root extends Machine.StateNodeConfig,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  Emits extends ReadonlyArray<Machine.TaggedSchema>,
  Input extends Schema.Top,
  InitialE,
  InitialR,
  InternalEvents extends ReadonlyArray<Machine.TaggedSchema>,
  ParentDeclaration extends Parent.Any | undefined,
  Effects extends Machine.EffectSources,
  Streams extends Machine.StreamSources,
  Timers extends Machine.TimerSources,
  Logics extends Machine.LogicSources,
  Children extends Machine.ChildSources,
  Branches extends Machine.BranchDefinitions<Root>
> = {
  /** Lazy Effects or functions with one required input, invoked by registered name. */
  readonly effects?: Effects & Machine.ValidatePrograms<Effects>
  /** Lazy Streams or functions with one required input, invoked by registered name. */
  readonly streams?: Streams & Machine.ValidatePrograms<Streams>
  /** Cancellable delays, supplied as durations or functions of one required input. */
  readonly timers?: Timers & Machine.ValidatePrograms<Timers>
  /** Logic values or functions of one required input; their Effect channels remain inferred. */
  readonly logic?: Logics & Machine.ValidatePrograms<Logics> & Machine.ValidateLogicSources<NoInfer<Logics>>
  /** Child machine descriptors registered for state-owned invocation. */
  readonly children?: Children
  /** Named groups of inspectable destinations used by transition resolvers. */
  readonly branches?:
    & Branches
    & { readonly [K in keyof Branches]: ValidateTransitionBranchRecord<NoInfer<Branches[K]>> }
  /** Stable definition identifier used by inspection and visualization. */
  readonly id?: string
  /** State topology and value schemas, captured by a `Machine.state` descriptor. */
  readonly root: { readonly [StateTypeId]: typeof StateTypeId; readonly node: Root }
  /** Public events accepted by independently running machine references. */
  readonly events:
    & Machine.EventProtocol<"public", InputEvents>
    & ValidateInputEventProtocol<NoInfer<InputEvents>>
  /** Machine-local events used by raised events and other internal deliveries. */
  readonly internalEvents?:
    & Machine.EventProtocol<"internal", InternalEvents>
    & ValidateInternalEventProtocol<
      NoInfer<InputEvents>,
      NoInfer<InternalEvents>
    >
  /** Ephemeral notifications that handlers may publish to observers. */
  readonly emittedEvents?: Machine.EventProtocol<"emitted", Emits>
  /** Required or optional owning-machine protocol for this definition. */
  readonly parent?: ParentDeclaration
  /** Schema used to decode input before initial-state construction. */
  readonly input?: Input
}

type MakeResult<
  Root extends Machine.StateNodeConfig,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
  Emits extends ReadonlyArray<Machine.TaggedSchema>,
  Input extends Schema.Top,
  InitialE,
  InitialR,
  InternalEvents extends ReadonlyArray<Machine.TaggedSchema>,
  ParentDeclaration extends Parent.Any | undefined,
  Effects extends Machine.EffectSources,
  Streams extends Machine.StreamSources,
  Timers extends Machine.TimerSources,
  Logics extends Machine.LogicSources,
  Children extends Machine.ChildSources,
  Branches extends Readonly<Record<string, Readonly<Record<string, unknown>>>>
> = Definition<
  { readonly "": Root },
  readonly [...InputEvents, ...InternalEvents],
  Input,
  InitialE,
  InitialR,
  Machine.FinalStateFromDefinition<{ readonly "": Root }>,
  Machine.TerminalOutput<{ readonly "": Root }>,
  Emits,
  InputEvents,
  Machine.ParentEventsOf<ParentDeclaration>,
  {
    /** Lazy Effects or functions with one required input, invoked by registered name. */
    readonly effects: Effects
    /** Lazy Streams or functions with one required input, invoked by registered name. */
    readonly streams: Streams
    /** Cancellable delays, supplied as durations or functions of one required input. */
    readonly timers: Timers
    /** Logic values or functions of one required input; their Effect channels remain inferred. */
    readonly logic: Logics
    /** Child machine descriptors registered for state-owned invocation. */
    readonly children: Children
    /** Named groups of inspectable destinations used by transition resolvers. */
    readonly branches: Branches
  }
>

/** @inline */
interface Make {
  /** @param config Complete schema-first machine definition. */
  <
    const Root extends Machine.StateNodeConfig,
    const InputEvents extends ReadonlyArray<Machine.TaggedSchema>,
    const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
    const Input extends Schema.Top = typeof Schema.Void,
    InitialE = never,
    InitialR = never,
    const InternalEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
    const ParentDeclaration extends Parent.Any | undefined = undefined,
    const Effects extends Machine.EffectSources = {},
    const Streams extends Machine.StreamSources = {},
    const Timers extends Machine.TimerSources = {},
    const Logics extends Machine.LogicSources = {},
    const Children extends Machine.ChildSources = {},
    const Branches extends Machine.BranchDefinitions<NoInfer<Root>> = {}
  >(
    config:
      & MakeConfig<
        Root,
        InputEvents,
        Emits,
        Input,
        InitialE,
        InitialR,
        InternalEvents,
        ParentDeclaration,
        Effects,
        Streams,
        Timers,
        Logics,
        Children,
        Branches
      >
      & UniqueSourceNames<NoInfer<Effects>, NoInfer<Streams>, NoInfer<Timers>, NoInfer<Logics>, NoInfer<Children>>
  ): MakeResult<
    Root,
    InputEvents,
    Emits,
    Input,
    InitialE,
    InitialR,
    InternalEvents,
    ParentDeclaration,
    Effects,
    Streams,
    Timers,
    Logics,
    Children,
    Branches
  >
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
 * import { Machine } from "@typeonce/effect-machine"
 * import { Schema } from "effect"
 * class Count extends Schema.TaggedClass<Count>("Count")("Count", {
 *   value: Schema.Number
 * }) {
 * }
 * class Increment extends Schema.TaggedClass<Increment>("Increment")("Increment", {
 *   by: Schema.Number
 * }) {
 * }
 * const States = Machine.state({ states: { Count } })
 * const Events = Machine.eventsFromSchemas(Increment)
 * const targets = Machine.targets(States)
 * const counter = Machine.make({
 *   root: States,
 *   events: Events
 * }).handle({
 *   initial: {
 *     target: Machine.targets(States).root.Count,
 *     decoded: true,
 *     data: new Count({ value: 0 })
 *   },
 *   states: {
 *     Count: {
 *       on: {
 *         Increment: {
 *           update: targets.root.Count,
 *           decoded: true,
 *           data: ({ event, state }) => new Count({ value: state.value + event.by })
 *         }
 *       }
 *     }
 *   }
 * })
 * ```
 *
 * @see {@link state} for typed state-tree helpers.
 * @inlineType MakeConfig
 * @category constructors
 * @since 0.4.0
 */
export const make: Make = internal.make as unknown as Make

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
 * export const Event = Machine.eventsFromSchemas(
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
type EventFieldsSchemas<Cases extends Readonly<Record<string, Schema.Struct.Fields>>> = keyof Cases extends never
  ? readonly []
  : readonly [
    Extract<
      Schema.TaggedUnion<{ readonly [Tag in keyof Cases & string]: Schema.TaggedStruct<Tag, Cases[Tag]> }>,
      Machine.TaggedSchema
    >
  ]
type ValidateEventFields<Cases> = {
  readonly [Tag in keyof Cases]: "_tag" extends keyof Cases[Tag]
    ? EventProtocolError<"Event fields cannot declare _tag", Extract<Tag, PropertyKey>>
    : unknown
}

/** Defines a public event protocol from tagged field records.
 *
 * ```ts
 * const Events = Machine.events({ Increment: { by: Schema.Number }, Reset: {} })
 * const increment = Events.Increment({ by: 1 })
 * ```
 *
 * Constructors defer schema validation until delivery. Use eventsFromSchemas
 * when importing existing tagged schemas or protocol descriptors.
 * @category constructors
 * @since 0.32.0
 */
export const events: <const Cases extends Readonly<Record<string, Schema.Struct.Fields>>>(
  cases: Cases & ValidateEventFields<NoInfer<Cases>> & ValidateEventProtocolBuilder<"public", EventFieldsSchemas<Cases>>
) => Machine.EventProtocol<"public", EventFieldsSchemas<Cases>> = internal.eventsFromFields as any

/** Imports existing schemas and protocols without rebuilding their contracts.
 * @category constructors
 * @since 0.32.0
 */
export const eventsFromSchemas: {
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
 * const Internal = Machine.internalEventsFromSchemas(
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
export const internalEvents: <const Cases extends Readonly<Record<string, Schema.Struct.Fields>>>(
  cases:
    & Cases
    & ValidateEventFields<NoInfer<Cases>>
    & ValidateEventProtocolBuilder<"internal", EventFieldsSchemas<Cases>>
) => Machine.EventProtocol<"internal", EventFieldsSchemas<Cases>> = internal.internalEventsFromFields as any

/** Imports existing schemas and protocols without rebuilding their contracts.
 * @category constructors
 * @since 0.32.0
 */
export const internalEventsFromSchemas: {
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
 * const Emitted = Machine.emittedEventsFromSchemas(
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
export const emittedEvents: <const Cases extends Readonly<Record<string, Schema.Struct.Fields>>>(
  cases:
    & Cases
    & ValidateEventFields<NoInfer<Cases>>
    & ValidateEventProtocolBuilder<"emitted", EventFieldsSchemas<Cases>>
) => Machine.EventProtocol<"emitted", EventFieldsSchemas<Cases>> = internal.emittedEventsFromFields as any

/** Imports existing schemas and protocols without rebuilding their contracts.
 * @category constructors
 * @since 0.32.0
 */
export const emittedEventsFromSchemas: {
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
 * Each active state value and completed output is encoded with the canonical
 * JSON codec derived from the schema declared for its state path. Success
 * guarantees that every state, output, and history value is `Schema.Json`.
 * Non-JSON values, including cyclic process-local capabilities, fail with
 * {@link MachineSchemaEncodeError} at their declared boundary.
 *
 * **Gotchas**
 *
 * The encoded snapshot does not contain the machine definition, machine
 * version, running children, invoked process state, services, or subscriptions.
 * Store machine identity and migration metadata alongside the result when the
 * snapshot crosses deployment versions. Opaque declarations without a JSON
 * codec can encode only when their current value is already JSON-compatible.
 * Define an explicit JSON codec or keep process-local capabilities outside the
 * logical snapshot.
 *
 * **Example**
 *
 * ```ts
 * import { Machine } from "@typeonce/effect-machine"
 * import { Effect, Schema } from "effect"
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {
 * }
 * const States = Machine.state({ states: { Idle } })
 * const machine = Machine.make({
 *   root: States,
 *   events: Machine.eventsFromSchemas()
 * }).handle({
 *   initial: {
 *     target: Machine.targets(States).root.Idle
 *   },
 *   states: {
 *     Idle: {}
 *   }
 * })
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
 * import { Machine } from "@typeonce/effect-machine"
 * import { Effect, Schema } from "effect"
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {
 * }
 * const States = Machine.state({ states: { Idle } })
 * const machine = Machine.make({
 *   root: States,
 *   events: Machine.eventsFromSchemas()
 * }).handle({
 *   initial: {
 *     target: Machine.targets(States).root.Idle
 *   },
 *   states: {
 *     Idle: {}
 *   }
 * })
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

type InvalidStaticTransitionBranchKey<Branches> = Extract<
  keyof Branches,
  "" | number | symbol | `${number}` | "NaN" | "Infinity" | "-Infinity"
>

type ValidateTransitionBranchRecord<Branches> = [keyof Branches] extends [never] ?
  TransitionBranchRecordError<"Branch records must contain at least one branch">
  : [InvalidStaticTransitionBranchKey<Branches>] extends [never] ? {
      readonly [K in keyof Branches]:
        & {
          readonly [
            Extra in Exclude<keyof Branches[K], "target" | "update" | "initial" | "history" | "none" | "title">
          ]: never
        }
        & (Branches[K] extends { readonly title: "" } ? { readonly title: never } : unknown)
    } :
  TransitionBranchRecordError<
    "Branch keys must be non-empty, non-numeric strings",
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
 * import { Machine } from "@typeonce/effect-machine"
 * import { Effect, Schema } from "effect"
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {
 * }
 * const States = Machine.state({ states: { Idle } })
 * const machine = Machine.make({
 *   root: States,
 *   events: Machine.eventsFromSchemas()
 * }).handle({
 *   initial: {
 *     target: Machine.targets(States).root.Idle
 *   },
 *   states: {
 *     Idle: {}
 *   }
 * })
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
    readonly emittedEvents: ReadonlyArray<Machine.EmittedEventOf<Emits>>
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
      readonly emittedEvents: ReadonlyArray<Machine.EmittedEventOf<Emits>>
      readonly exitPaths: ReadonlyArray<string>
      readonly entryPaths: ReadonlyArray<string>
      readonly changed: boolean
    }>
  }
  & (
    | {
      readonly done: true
      /** Constructs the decoded output declared by the state schema. */
      readonly output: Output
    }
    | {
      readonly done: false
      /** Constructs the decoded output declared by the state schema. */
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
 * Returns the schemas accepted by the machine's public event protocol.
 *
 * **Details**
 *
 * The returned tuple retains the schemas supplied to {@link events}, including
 * grouped tagged unions. Internal and emitted event schemas are excluded. This
 * getter is intended for tooling that needs to describe or construct valid
 * external inputs without reaching into the opaque event protocol.
 *
 * @category getters
 * @since 0.24.0
 */
export const inputEventSchemas: <M extends Machine.Any>(machine: M) => Machine.InputEvents<M> =
  internal.inputEventSchemas

/**
 * Returns every registered transition handler in state definition order.
 *
 * **Details**
 *
 * Event handlers retain their handler-key order within each source state and
 * are followed by eventless and completion handlers. This function does not
 * execute resolvers. Every branch exposes its static selection. State updates
 * retain the updated owner in `selection.path` while leaving `target`
 * undefined because they do not change topology. `acceptance` reports whether
 * the resolver may decline the transition.
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
 * Tests whether a concrete event would select at least one transition from a
 * decoded snapshot.
 *
 * **Details**
 *
 * Required handlers are accepted from their structural eligibility.
 * Declinable handlers run their resolver only far enough to decide whether
 * they accept the event. Any commands, emissions, or raised events collected
 * during that check are discarded.
 *
 * Event input is decoded through the machine's public and internal event protocols.
 * Invalid input fails with `MachineSchemaDecodeError`. Final snapshots and valid events
 * with no accepting handler return `false`.
 *
 * **Gotchas**
 *
 * This query does not execute transitions or stabilize the resulting machine.
 * It does not run entry, exit, always, completion, child lifecycle, or command
 * effects. A `true` result therefore describes event acceptance only, for this
 * snapshot. It does not guarantee acceptance after the machine advances.
 *
 * This Effect can also be used by machine effects to query internal events.
 * Synchronous transition resolvers cannot execute it. Querying an internal event
 * does not make that event available to `MachineRef.send`.
 *
 * **Example**
 *
 * ```ts
 * import { Machine } from "@typeonce/effect-machine"
 * import { Effect, Schema } from "effect"
 *
 * const internalEvents = Machine.internalEventsFromSchemas(Schema.TaggedStruct("Loaded", {}))
 * const Root = Machine.state({ states: { Idle: {} } })
 * const machine = Machine.make({
 *   root: Root,
 *   events: Machine.eventsFromSchemas(),
 *   internalEvents
 * }).handle({
 *   initial: { target: Machine.targets(Root).root.Idle },
 *   states: { Idle: { on: { Loaded: { none: true } } } }
 * })
 *
 * export const canLoad = Effect.gen(function*() {
 *   const initial = yield* Machine.planInitial(machine)
 *   return yield* Machine.can(machine, initial.state, internalEvents.Loaded())
 * })
 * ```
 *
 * @category getters
 * @since 0.30.0
 */
export const can: {
  <
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
      & Machine.RootCompatible<ParentEvents>
  ): (
    state: Machine.Snapshot<States>,
    event: Machine.EventInputOf<Events>
  ) => Effect.Effect<boolean, MachineSchemaDecodeError>
  <
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
    event: Machine.EventInputOf<Events>
  ): Effect.Effect<boolean, MachineSchemaDecodeError>
} = internal.can as any

/**
 * Returns an Effect that plans the next state snapshot without running command effects.
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
 * import { Machine } from "@typeonce/effect-machine"
 * import { Effect, Schema } from "effect"
 * class Off extends Schema.TaggedClass<Off>("Off")("Off", {}) {
 * }
 * class On extends Schema.TaggedClass<On>("On")("On", {}) {
 * }
 * class Toggle extends Schema.TaggedClass<Toggle>("Toggle")("Toggle", {}) {
 * }
 * const States = Machine.state({ states: { Off, On } })
 * const targets = Machine.targets(States)
 * const machine = Machine.make({
 *   root: States,
 *   events: Machine.eventsFromSchemas(Toggle)
 * }).handle({
 *   initial: {
 *     target: Machine.targets(States).root.Off
 *   },
 *   states: {
 *     Off: {
 *       on: {
 *         Toggle: { target: targets.root.On }
 *       }
 *     },
 *     On: {}
 *   }
 * })
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
    readonly event: Machine.EventOf<InputEvents>
    readonly next: Machine.Snapshot<States>
    readonly commands: ReadonlyArray<Command>
    readonly emittedEvents: ReadonlyArray<Machine.EmittedEventOf<Emits>>
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
      readonly emittedEvents: ReadonlyArray<Machine.EmittedEventOf<Emits>>
      readonly exitPaths: ReadonlyArray<string>
      readonly entryPaths: ReadonlyArray<string>
      readonly changed: boolean
    }>
  }
  & (
    | {
      readonly done: true
      /** Constructs the decoded output declared by the state schema. */
      readonly output: Output
    }
    | {
      readonly done: false
      /** Constructs the decoded output declared by the state schema. */
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
  /** Enters a compound or parallel subtree through its declared initialization. */
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
 * Binds one machine definition to an open family of runtime child ids.
 *
 * Descriptors created by the returned function are interchangeable with
 * {@link child} descriptors for the same id and machine definition.
 *
 * @category constructors
 * @since 0.20.0
 */
export const childFamily: <M extends Machine.Any>(machine: M) => ChildMachine.Family<M> = internal.childFamily

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
 * Register logic in `make({ logic })` and use `invoke: { src, id, address, ...outcomes }` for children
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
      Machine.EmittedEventOf<Emits>
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
 * import { Machine } from "@typeonce/effect-machine"
 * import { Effect, Schema } from "effect"
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {
 * }
 * const States = Machine.state({ states: { Idle } })
 * const machine = Machine.make({
 *   root: States,
 *   events: Machine.eventsFromSchemas()
 * }).handle({
 *   initial: {
 *     target: Machine.targets(States).root.Idle
 *   },
 *   states: {
 *     Idle: {}
 *   }
 * })
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
    Machine.EmittedEventOf<Emits>
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
 * import { Machine } from "@typeonce/effect-machine"
 * import { Effect, Schema } from "effect"
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {
 * }
 * const States = Machine.state({ states: { Idle } })
 * const machine = Machine.make({
 *   root: States,
 *   events: Machine.eventsFromSchemas()
 * }).handle({
 *   initial: {
 *     target: Machine.targets(States).root.Idle
 *   },
 *   states: {
 *     Idle: {}
 *   }
 * })
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
    Machine.EmittedEventOf<Emits>
  >
> = internal.resume as any
