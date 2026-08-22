/**
 * Atom bridge for running machines.
 *
 * @since 0.4.0
 */

import type * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import type { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
import * as internal from "../../internal/machine/atom.js"
import type { ChildNotActiveError, NotReadyError } from "../../internal/machine/atom.js"
import type { EnsureExecutable } from "../../internal/machine/readiness.js"
import type * as Machine from "../../Machine.js"

/**
 * Error returned when a machine command is issued before startup completes.
 *
 * @category errors
 * @since 0.4.0
 */
export { NotReadyError } from "../../internal/machine/atom.js"

/**
 * Error returned when a command targets a child machine that is not active.
 *
 * @category errors
 * @since 0.4.0
 */
export { ChildNotActiveError } from "../../internal/machine/atom.js"

type AtomSupportedRequirements = Scope.Scope | AtomRegistry.AtomRegistry

type ExternalRequirements<Requirements> = Exclude<Requirements, AtomSupportedRequirements>

const ExternalRequirementsTypeId = "~effect/reactivity/AtomMachine/ExternalRequirements"

type EnsureNoExternalRequirements<Requirements> = [ExternalRequirements<Requirements>] extends [never] ? unknown : {
  readonly [ExternalRequirementsTypeId]: ExternalRequirements<Requirements>
}

type IsAny<A> = 0 extends (1 & A) ? true : false

type ExcludeCompatibleMachineRuntime<Requirements, Events, Emits> = Requirements extends
  Machine.Runtime.Requirement<infer RequiredEvents, infer RequiredEmits> ?
  IsAny<Requirements> extends true ? Requirements
  : [RequiredEvents] extends [Events] ? [RequiredEmits] extends [Emits] ? never : Requirements
  : Requirements
  : Requirements

type MachineRequirements<InitialR, R, Events, Emits> = ExcludeCompatibleMachineRuntime<
  Machine.ExecutionServices<InitialR | R>,
  Events,
  Emits
>

type MachineResumeRequirements<R, Events, Emits> = ExcludeCompatibleMachineRuntime<
  Machine.ExecutionServices<R>,
  Events,
  Emits
>

type MachineRuntimeError<E, R> =
  | E
  | Machine.ActionError<R>
  | Machine.InfiniteTransitionError
  | Machine.MachineSchemaDecodeError
  | Machine.StoppedError

type MachineStartError<InitialE, E, InitialR, R, RuntimeError = never> =
  | InitialE
  | E
  | Machine.ActionError<InitialR | R>
  | Machine.InfiniteTransitionError
  | Machine.MachineSchemaDecodeError
  | Machine.StartupError
  | Machine.StoppedError
  | RuntimeError

/**
 * Atoms backed by one running machine instance in an `AtomRegistry`.
 *
 * **Details**
 *
 * The machine starts when one of the returned atoms is mounted or read in
 * a registry, and it is stopped when the registry disposes the ref atom. The
 * same atom values share one running machine per registry.
 *
 * @category models
 * @since 0.4.0
 */
export interface MachineAtom<State, Event, Error = never, Output = never, StartError = never, Emitted = never> {
  /**
   * Atom containing the running machine handle once startup succeeds.
   *
   * @since 0.4.0
   */
  readonly ref: Atom.Atom<
    AsyncResult.AsyncResult<Machine.MachineRef<State, Event, Error, Output, Emitted>, StartError>
  >

  /**
   * Atom containing the latest machine lifecycle snapshot.
   *
   * @since 0.4.0
   */
  readonly snapshot: Atom.Atom<
    AsyncResult.AsyncResult<Machine.RuntimeSnapshot<State, Error, Output>, StartError>
  >

  /**
   * Atom containing the state value from the latest runtime snapshot.
   *
   * This preserves the historical behavior of exposing a state even when the
   * runtime snapshot reports a terminal error. Use `result` when runtime
   * failures must be represented in the atom failure channel.
   *
   * @since 0.4.0
   */
  readonly state: Atom.Atom<AsyncResult.AsyncResult<State, StartError>>

  /**
   * Atom containing the current state, with startup and runtime failures in
   * one typed failure channel.
   *
   * @since 0.4.0
   */
  readonly result: Atom.Atom<AsyncResult.AsyncResult<State, StartError | Error>>

  /**
   * Writable atom that sends events to the machine. Writes before startup
   * completes fail with `NotReadyError`.
   *
   * @since 0.4.0
   */
  readonly send: Atom.Writable<
    AsyncResult.AsyncResult<void, StartError | NotReadyError | Machine.StoppedError>,
    Event
  >

  /**
   * Writable atom that stops the machine. Writes before startup completes fail
   * with `NotReadyError`.
   *
   * @since 0.4.0
   */
  readonly stop: Atom.Writable<AsyncResult.AsyncResult<void, StartError | NotReadyError>, void>

  /**
   * Creates a reactive bridge for a directly owned child machine.
   * Descriptors with the same id and machine definition return the same live
   * bridge while it remains referenced.
   *
   * @since 0.4.0
   */
  readonly child: <Child extends Machine.ChildMachine.Any>(
    child: Child
  ) => ChildMachineAtom<Child, StartError>
}

type RefState<Ref> = Ref extends Machine.MachineRef<infer State, any, any, any, any> ? State : never

type RefError<Ref> = Ref extends Machine.MachineRef<any, any, infer Error, any, any> ? Error : never

type RefOutput<Ref> = Ref extends Machine.MachineRef<any, any, any, infer Output, any> ? Output : never
type RefEmitted<Ref> = Ref extends Machine.MachineRef<any, any, any, any, infer Emitted> ? Emitted : never

/**
 * Observes ephemeral notifications from the running machine owned by a machine
 * atom. When this stream activates a fresh bridge, it subscribes before machine
 * initialization and observes initial-entry emissions. It never replays
 * emissions from a machine that was already running.
 *
 * @category getters
 * @since 0.10.0
 */
export const emissions: <State, Event, Error, Output, StartError, Emitted>(
  self: MachineAtom<State, Event, Error, Output, StartError, Emitted>
) => Stream.Stream<Emitted, StartError, AtomRegistry.AtomRegistry> = internal.emissions

/**
 * Observes the ordered local inspection records for the machine atom's root
 * ownership tree. The stream starts before machine initialization, is hot and
 * non-replayed, and completes with the root machine.
 *
 * @category getters
 * @since 0.13.0
 */
export const inspection: <State, Event, Error, Output, StartError, Emitted>(
  self: MachineAtom<State, Event, Error, Output, StartError, Emitted>
) => Stream.Stream<Machine.Inspection.Event, StartError, AtomRegistry.AtomRegistry> = internal.inspection

/**
 * Observes emissions from each active instance selected by a child bridge.
 *
 * @category getters
 * @since 0.10.0
 */
export const childEmissions: <Child extends Machine.ChildMachine.Any, StartError>(
  self: ChildMachineAtom<Child, StartError>
) => Stream.Stream<
  RefEmitted<Machine.ChildMachine.Ref<Child>>,
  StartError,
  AtomRegistry.AtomRegistry
> = internal.childEmissions

/**
 * Reactive access to one directly owned child machine selected by its
 * descriptor.
 *
 * **Details**
 *
 * Each atom contains `Option.none()` while the state that owns the invocation
 * is inactive or while the child is starting. It contains `Option.some(...)`
 * for the current child instance and follows replacements after re-entry.
 *
 * **Gotchas**
 *
 * Lookup is direct-child scoped. Use `child` again on this bridge to reach a
 * machine invoked by the selected child.
 *
 * @category models
 * @since 0.4.0
 */
export interface ChildMachineAtom<Child extends Machine.ChildMachine.Any, StartError = unknown> {
  /**
   * Atom containing the current child reference when the child is active.
   *
   * @since 0.4.0
   */
  readonly ref: Atom.Atom<
    AsyncResult.AsyncResult<Option.Option<Machine.ChildMachine.Ref<Child>>, StartError>
  >

  /**
   * Atom containing the current child lifecycle snapshot when active.
   *
   * @since 0.4.0
   */
  readonly snapshot: Atom.Atom<
    AsyncResult.AsyncResult<
      Option.Option<
        Machine.RuntimeSnapshot<
          RefState<Machine.ChildMachine.Ref<Child>>,
          RefError<Machine.ChildMachine.Ref<Child>>,
          RefOutput<Machine.ChildMachine.Ref<Child>>
        >
      >,
      StartError
    >
  >
  /**
   * Atom containing the current child state when active.
   *
   * Runtime failures retain the last successful state. Use `result` when they
   * must be represented in the atom failure channel.
   *
   * @since 0.4.0
   */
  readonly state: Atom.Atom<
    AsyncResult.AsyncResult<Option.Option<RefState<Machine.ChildMachine.Ref<Child>>>, StartError>
  >
  /**
   * Atom containing the current child state when active, with startup and
   * runtime failures in one typed failure channel.
   *
   * @since 0.4.0
   */
  readonly result: Atom.Atom<
    AsyncResult.AsyncResult<
      Option.Option<RefState<Machine.ChildMachine.Ref<Child>>>,
      StartError | RefError<Machine.ChildMachine.Ref<Child>>
    >
  >
  /**
   * Writable atom that sends events to the active child.
   *
   * Writes fail with `ChildNotActiveError` while the child is inactive.
   *
   * @since 0.4.0
   */
  readonly send: Atom.Writable<
    AsyncResult.AsyncResult<void, StartError | NotReadyError | ChildNotActiveError | Machine.StoppedError>,
    Machine.ChildMachine.Event<Child>
  >
  /**
   * Writable atom that stops the active child.
   *
   * Writes fail with `ChildNotActiveError` while the child is inactive.
   *
   * @since 0.4.0
   */
  readonly stop: Atom.Writable<
    AsyncResult.AsyncResult<void, StartError | NotReadyError | ChildNotActiveError>,
    void
  >
  /**
   * Creates a reactive bridge for a directly owned nested child. Descriptors
   * with the same id and machine definition return the same live bridge while
   * it remains referenced.
   *
   * @since 0.4.0
   */
  readonly child: <Nested extends Machine.ChildMachine.Any>(
    child: Nested
  ) => ChildMachineAtom<Nested, StartError>
}

type BridgeStartError<Bridge> = Bridge extends MachineAtom<any, never, any, any, infer StartError, any> ? StartError
  : Bridge extends ChildMachineAtom<any, infer StartError> ? StartError
  : never

/**
 * Derives the exact child bridge type from a parent bridge and child
 * descriptor.
 *
 * @category utility types
 * @since 0.4.0
 */
export type ChildOf<
  Parent extends MachineAtom<any, never, any, any, any, any> | ChildMachineAtom<any, any>,
  Child extends Machine.ChildMachine.Any
> = ChildMachineAtom<Child, BridgeStartError<Parent>>

type SnapshotNode<State> = State extends Machine.Machine.AtomicSnapshot<string, unknown> ?
    | State
    | (State extends { readonly state: infer Child } ? SnapshotNode<Child>
      : State extends { readonly states: infer Regions } ? SnapshotNode<Regions[keyof Regions]>
      : never)
  : never

type SnapshotIdentifier<State> = SnapshotNode<State> extends infer Node ?
  Node extends { readonly path: infer Path extends string } ? Path : never
  : never

type ValuedSnapshotIdentifier<State> = SnapshotNode<State> extends infer Node ?
  Node extends { readonly path: infer Path extends string; readonly value: infer Value } ?
    [Value] extends [undefined] ? never
    : Path
  : never
  : never

type SnapshotValueByIdentifier<State, Path extends SnapshotIdentifier<State>> = SnapshotNode<State> extends infer Node ?
  Node extends { readonly path: Path; readonly value: infer Value } ? Value : never
  : never

type SnapshotByIdentifier<State, Path extends SnapshotIdentifier<State>> = SnapshotNode<State> extends infer Node ?
  Node extends { readonly path: Path } ? Node : never
  : never

type ChildState<Child extends Machine.ChildMachine.Any> = RefState<Machine.ChildMachine.Ref<Child>>

/**
 * Selects the typed value for an active state path.
 *
 * Valid paths and their selected value types are inferred from the bridge.
 * The derived atom suppresses structurally equal updates. Keep the returned
 * atom stable when constructing it inside a component.
 *
 * **Example**
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 * import { AtomMachine } from "@typeonce/effect-machine/reactivity"
 *
 * class Count extends Schema.TaggedClass<Count>("Count")("Count", {
 *   value: Schema.Number
 * }) {}
 * const States = Machine.states({ Count })
 * const machine = Machine.make({
 *   states: States.states,
 *   events: Machine.events(),
 *   initial: {
 *     target: (to) => to.Count(),
 *     resolve: ({ target }) => target(new Count({ value: 0 }))
 *   }
 * }).handle({ Count: {} })
 * const machineAtom = AtomMachine.make(machine)
 *
 * const countAtom = AtomMachine.select(machineAtom, "Count")
 * ```
 *
 * @category combinators
 * @since 0.4.0
 */
export const select: <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Event,
  Error,
  Output,
  StartError,
  Emitted,
  const Path extends ValuedSnapshotIdentifier<State>
>(self: MachineAtom<State, Event, Error, Output, StartError, Emitted>, path: Path) => Atom.Atom<
  AsyncResult.AsyncResult<Option.Option<SnapshotValueByIdentifier<State, Path>>, StartError | Error>
> = internal.select

/**
 * Selects the typed logical snapshot for an active state path.
 *
 * Unlike {@link select}, the selected value retains its child snapshot
 * topology. The derived atom suppresses structurally equal updates. Keep the
 * returned atom stable when constructing it inside a component.
 *
 * @category combinators
 * @since 0.7.0
 */
export const selectSnapshot: <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Event,
  Error,
  Output,
  StartError,
  Emitted,
  const Path extends SnapshotIdentifier<State>
>(self: MachineAtom<State, Event, Error, Output, StartError, Emitted>, path: Path) => Atom.Atom<
  AsyncResult.AsyncResult<Option.Option<SnapshotByIdentifier<State, Path>>, StartError | Error>
> = internal.selectSnapshot

/**
 * Selects the typed value for an active state path in a directly owned child.
 *
 * Valid paths and their selected value types are inferred from the child
 * bridge. An inactive child produces `Option.none()`. Keep the returned atom
 * stable when constructing it inside a component.
 *
 * **Example**
 *
 * ```ts
 * const editingAtom = AtomMachine.selectChild(editorAtom, "Editing")
 * // Atom<AsyncResult<Option<Editing>, StartError | ChildRuntimeError>>
 * ```
 *
 * @category combinators
 * @since 0.4.0
 */
export const selectChild: <
  Child extends Machine.ChildMachine.Any,
  StartError,
  const Path extends ValuedSnapshotIdentifier<ChildState<Child>>
>(self: ChildMachineAtom<Child, StartError>, path: Path) => Atom.Atom<
  AsyncResult.AsyncResult<
    Option.Option<SnapshotValueByIdentifier<ChildState<Child>, Path>>,
    StartError | RefError<Machine.ChildMachine.Ref<Child>>
  >
> = internal.selectChild

/**
 * Selects the typed logical snapshot for an active state path in an invoked
 * child.
 *
 * An inactive child or state path produces `Option.none()`. Unlike
 * {@link selectChild}, the selected value retains its child snapshot topology.
 * The derived atom suppresses structurally equal updates.
 *
 * @category combinators
 * @since 0.7.0
 */
export const selectSnapshotChild: <
  Child extends Machine.ChildMachine.Any,
  StartError,
  const Path extends SnapshotIdentifier<ChildState<Child>>
>(self: ChildMachineAtom<Child, StartError>, path: Path) => Atom.Atom<
  AsyncResult.AsyncResult<
    Option.Option<SnapshotByIdentifier<ChildState<Child>, Path>>,
    StartError | RefError<Machine.ChildMachine.Ref<Child>>
  >
> = internal.selectSnapshotChild

/**
 * Returns whether a state path is active.
 *
 * Valid paths are inferred from the bridge snapshot.
 * The derived atom suppresses equal updates. Runtime failures remain in the
 * typed failure channel.
 *
 * **Example**
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 * import { AtomMachine } from "@typeonce/effect-machine/reactivity"
 *
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
 * const States = Machine.states({ Idle })
 * const machine = Machine.make({
 *   states: States.states,
 *   events: Machine.events(),
 *   initial: {
 *     target: (to) => to.Idle(),
 *     resolve: ({ target }) => target.from()
 *   }
 * }).handle({ Idle: {} })
 * const machineAtom = AtomMachine.make(machine)
 *
 * const isIdleAtom = AtomMachine.matches(machineAtom, "Idle")
 * ```
 *
 * @category combinators
 * @since 0.4.0
 */
export const matches: <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Event,
  Error,
  Output,
  StartError,
  Emitted,
  const Path extends SnapshotIdentifier<State>
>(
  self: MachineAtom<State, Event, Error, Output, StartError, Emitted>,
  path: Path
) => Atom.Atom<AsyncResult.AsyncResult<boolean, StartError | Error>> = internal.matches

/**
 * Returns whether a state path is active in a directly owned child.
 *
 * Valid paths are inferred from the child bridge snapshot.
 * An inactive child produces `false`. Keep the returned atom stable when
 * constructing it inside a component.
 *
 * @category combinators
 * @since 0.4.0
 */
export const matchesChild: <
  Child extends Machine.ChildMachine.Any,
  StartError,
  const Path extends SnapshotIdentifier<ChildState<Child>>
>(self: ChildMachineAtom<Child, StartError>, path: Path) => Atom.Atom<
  AsyncResult.AsyncResult<boolean, StartError | RefError<Machine.ChildMachine.Ref<Child>>>
> = internal.matchesChild

const BoundRequirementsTypeId = "~effect/reactivity/AtomMachine/BoundRequirements"

type MachineRequirementsOf<M extends Machine.Machine.Any> = MachineRequirements<
  Machine.Machine.InitialServices<M>,
  Machine.Machine.Services<M>,
  Machine.Machine.Event<M>,
  Machine.Machine.Emit<M>
>

type MissingBoundRequirements<Services, M extends Machine.Machine.Any> = Exclude<
  ExternalRequirements<MachineRequirementsOf<M>>,
  Services
>

type EnsureBoundRequirements<Services, M extends Machine.Machine.Any> = IsAny<MachineRequirementsOf<M>> extends true ? {
    readonly [BoundRequirementsTypeId]: MachineRequirementsOf<M>
  }
  : [MissingBoundRequirements<Services, M>] extends [never] ? unknown
  : {
    readonly [BoundRequirementsTypeId]: MissingBoundRequirements<Services, M>
  }

type MachineResumeRequirementsOf<M extends Machine.Machine.Any> = MachineResumeRequirements<
  Machine.Machine.Services<M>,
  Machine.Machine.Event<M>,
  Machine.Machine.Emit<M>
>

type MissingBoundResumeRequirements<Services, M extends Machine.Machine.Any> = Exclude<
  ExternalRequirements<MachineResumeRequirementsOf<M>>,
  Services
>

type EnsureBoundResumeRequirements<Services, M extends Machine.Machine.Any> =
  IsAny<MachineResumeRequirementsOf<M>> extends true ? {
      readonly [BoundRequirementsTypeId]: MachineResumeRequirementsOf<M>
    }
    : [MissingBoundResumeRequirements<Services, M>] extends [never] ? unknown
    : {
      readonly [BoundRequirementsTypeId]: MissingBoundResumeRequirements<Services, M>
    }

type EnsureMachineExecutable<M extends Machine.Machine.Any> = IsAny<Machine.Machine.States<M>> extends true ? {
    readonly "~effect/reactivity/AtomMachine/ConcreteMachineRequired": M
  }
  : EnsureExecutable<
    Machine.Machine.States<M>,
    Machine.Machine.UnhandledStates<M>,
    Machine.Machine.OutputStates<M>
  >

type MachineInputArgsOf<M extends Machine.Machine.Any> = [
  ...Machine.Machine.InputArgs<Machine.Machine.InputSchema<M>>
]

type MachineAtomOf<M extends Machine.Machine.Any, RuntimeError> = MachineAtom<
  Machine.Machine.Snapshot<Machine.Machine.States<M>>,
  Machine.Machine.EventInput<Machine.Machine.InputEvent<M>>,
  MachineRuntimeError<Machine.Machine.Error<M>, Machine.Machine.Services<M>>,
  Machine.Machine.Output<M>,
  MachineStartError<
    Machine.Machine.InitialError<M>,
    Machine.Machine.Error<M>,
    Machine.Machine.InitialServices<M>,
    Machine.Machine.Services<M>,
    RuntimeError
  >,
  Machine.Machine.EmittedEvent<M>
>

type ResumedMachineAtomOf<M extends Machine.Machine.Any, RuntimeError> = MachineAtom<
  Machine.Machine.Snapshot<Machine.Machine.States<M>>,
  Machine.Machine.EventInput<Machine.Machine.InputEvent<M>>,
  MachineRuntimeError<Machine.Machine.Error<M>, Machine.Machine.Services<M>>,
  Machine.Machine.Output<M>,
  Machine.MachineSchemaDecodeError | RuntimeError,
  Machine.Machine.EmittedEvent<M>
>

/**
 * An `AtomMachine` factory with one owned Effect runtime.
 *
 * @category models
 * @since 0.4.0
 */
export interface Bound<Services, RuntimeError = never> {
  /**
   * Creates an independent machine bridge using the bound runtime.
   *
   * The machine's external service requirements must be provided by the
   * runtime. Machine-native runtime requirements are supplied automatically.
   *
   * @since 0.4.0
   */
  readonly make: <M extends Machine.Machine.Any>(
    machine:
      & M
      & EnsureBoundRequirements<Services, NoInfer<M>>
      & EnsureMachineExecutable<NoInfer<M>>
      & Machine.Machine.RootCompatible<Machine.Machine.ParentEvents<NoInfer<M>>>,
    ...args: MachineInputArgsOf<M>
  ) => MachineAtomOf<M, RuntimeError>

  /** Creates a lazy bridge from a decoded logical snapshot. */
  readonly resume: <M extends Machine.Machine.Any>(
    machine:
      & M
      & EnsureBoundResumeRequirements<Services, NoInfer<M>>
      & EnsureMachineExecutable<NoInfer<M>>
      & Machine.Machine.RootCompatible<Machine.Machine.ParentEvents<NoInfer<M>>>,
    snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  ) => ResumedMachineAtomOf<M, RuntimeError>
}

/**
 * Creates atoms backed by a running machine.
 *
 * Use `bind(runtime).make(machine)` when the machine requires external
 * services.
 *
 * **Example**
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Machine } from "@typeonce/effect-machine"
 * import { AtomMachine } from "@typeonce/effect-machine/reactivity"
 *
 * class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
 * const States = Machine.states({ Idle })
 * const machine = Machine.make({
 *   states: States.states,
 *   events: Machine.events(),
 *   initial: {
 *     target: (to) => to.Idle(),
 *     resolve: ({ target }) => target.from()
 *   }
 * }).handle({ Idle: {} })
 *
 * const machineAtom = AtomMachine.make(machine)
 * ```
 *
 * @category constructors
 * @since 0.4.0
 */
export const make: {
  <
    const States extends Machine.Machine.StateSchemas,
    const Events extends ReadonlyArray<Machine.Machine.TaggedSchema>,
    const Emits extends ReadonlyArray<Machine.Machine.TaggedSchema> = any,
    const Input extends Schema.Top = typeof Schema.Void,
    UnhandledStates extends Machine.Machine.StateIdentifier<States> = Machine.Machine.StateIdentifier<States>,
    E = never,
    R = never,
    InitialE = never,
    InitialR = never,
    FinalStates extends Machine.Machine.StateIdentifier<States> = never,
    Output = never,
    OutputStates extends Machine.Machine.StateIdentifier<States> = never,
    InputEvents extends ReadonlyArray<Machine.Machine.TaggedSchema> = Events,
    ParentEvents extends ReadonlyArray<Machine.Machine.TaggedSchema> = readonly []
  >(
    machine:
      & Machine.Machine<
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
      & EnsureNoExternalRequirements<
        MachineRequirements<
          InitialR,
          R,
          Machine.Machine.EventOf<Events>,
          Machine.Machine.EmitOf<Emits>
        >
      >
      & EnsureExecutable<States, UnhandledStates, OutputStates>
      & Machine.Machine.RootCompatible<ParentEvents>,
    ...args: [...Machine.Machine.InputArgs<Input>]
  ): MachineAtom<
    Machine.Machine.Snapshot<States>,
    Machine.Machine.EventInputOf<InputEvents>,
    MachineRuntimeError<E, R>,
    Output,
    MachineStartError<InitialE, E, InitialR, R>,
    Machine.Machine.EmittedEventOf<Emits>
  >
} = internal.make

/**
 * Creates a lazy atom bridge from a decoded logical snapshot.
 *
 * The bridge owns one freshly resumed runtime per `AtomRegistry`, with the same
 * lazy start and disposal semantics as {@link make}. The machine initial
 * function and its input, errors, and services are not involved.
 *
 * @category constructors
 * @since 0.4.0
 */
export const resume: {
  <M extends Machine.Machine.Any>(
    machine:
      & M
      & EnsureNoExternalRequirements<MachineResumeRequirementsOf<NoInfer<M>>>
      & EnsureMachineExecutable<NoInfer<M>>
      & Machine.Machine.RootCompatible<Machine.Machine.ParentEvents<NoInfer<M>>>,
    snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  ): ResumedMachineAtomOf<M, never>
} = internal.resume

/**
 * Creates an `AtomMachine` factory that owns a shared Effect runtime.
 *
 * Use this when an application runs many machines from the same service layer.
 * The returned factory keeps runtime provisioning at the composition boundary,
 * while every call to `make` still creates an independent machine bridge.
 *
 * @category constructors
 * @since 0.4.0
 */
export const bind: <Services, RuntimeError>(
  runtime: Atom.AtomRuntime<Services, RuntimeError>
) => Bound<Services, RuntimeError> = internal.bind
