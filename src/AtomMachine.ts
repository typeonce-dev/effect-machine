/**
 * Atom bridge for running machines.
 *
 * @since 4.0.0
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity"
import * as Model from "./internal/machineModel.js"
import * as Machine from "./Machine.js"

/**
 * Error returned when a machine command is issued before startup completes.
 *
 * @category errors
 * @since 4.0.0
 */
export class NotReadyError extends Data.TaggedError("NotReadyError") {}

/**
 * Error returned when a command targets a child machine that is not active.
 *
 * @category errors
 * @since 4.0.0
 */
export class ChildNotActiveError extends Data.TaggedError("ChildNotActiveError")<{
  readonly id: string
}> {}

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

const startMachineAtomEffect = <
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
  InputEvents extends ReadonlyArray<Machine.Machine.TaggedSchema> = Events
>(
  get: Atom.AtomContext,
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
      InputEvents
    >
    & Machine.Machine.EnsureOutputImplementations<States, OutputStates>,
  args: [...Machine.Machine.InputArgs<Input>]
): Effect.Effect<
  Machine.MachineRef<
    Machine.Machine.Snapshot<States>,
    Machine.Machine.EventOf<InputEvents>,
    MachineRuntimeError<E, R>,
    Output
  >,
  MachineStartError<InitialE, E, InitialR, R>,
  MachineRequirements<InitialR, R, Machine.Machine.EventOf<Events>, Machine.Machine.EmitOf<Emits>>
> =>
  Effect.scoped(
    Effect.acquireRelease(
      Machine.start(machine, ...args),
      (ref) => ref.stop
    ).pipe(
      Effect.tap((ref) => Effect.sync(() => get.setSelf(AsyncResult.success(ref)))),
      Effect.flatMap(() => Effect.never)
    )
  )

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
 * @since 4.0.0
 */
export interface MachineAtom<State, Event, Error = never, Output = never, StartError = never> {
  /**
   * Atom containing the running machine handle once startup succeeds.
   *
   * @since 4.0.0
   */
  readonly ref: Atom.Atom<
    AsyncResult.AsyncResult<Machine.MachineRef<State, Event, Error, Output>, StartError>
  >

  /**
   * Atom containing the latest machine lifecycle snapshot.
   *
   * @since 4.0.0
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
   * @since 4.0.0
   */
  readonly state: Atom.Atom<AsyncResult.AsyncResult<State, StartError>>

  /**
   * Atom containing the current state, with startup and runtime failures in
   * one typed failure channel.
   *
   * @since 4.0.0
   */
  readonly result: Atom.Atom<AsyncResult.AsyncResult<State, StartError | Error>>

  /**
   * Writable atom that sends events to the machine. Writes before startup
   * completes fail with `NotReadyError`.
   *
   * @since 4.0.0
   */
  readonly send: Atom.Writable<
    AsyncResult.AsyncResult<void, StartError | NotReadyError | Machine.StoppedError>,
    Event
  >

  /**
   * Writable atom that stops the machine. Writes before startup completes fail
   * with `NotReadyError`.
   *
   * @since 4.0.0
   */
  readonly stop: Atom.Writable<AsyncResult.AsyncResult<void, StartError | NotReadyError>, void>

  /**
   * Creates a reactive bridge for a directly invoked child machine.
   * Reusing the same descriptor returns the same live bridge while it remains
   * referenced.
   *
   * @since 4.0.0
   */
  readonly child: <Child extends Machine.ChildMachine.Any>(
    child: Child
  ) => ChildMachineAtom<Child, StartError>
}

type RefState<Ref> = Ref extends Machine.MachineRef<infer State, any, any, any> ? State : never
type RefError<Ref> = Ref extends Machine.MachineRef<any, any, infer Error, any> ? Error : never
type RefOutput<Ref> = Ref extends Machine.MachineRef<any, any, any, infer Output> ? Output : never

/**
 * Reactive access to one invoked child machine selected by its descriptor.
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
 * @since 4.0.0
 */
export interface ChildMachineAtom<Child extends Machine.ChildMachine.Any, StartError = unknown> {
  /**
   * Atom containing the current child reference when the child is active.
   *
   * @since 4.0.0
   */
  readonly ref: Atom.Atom<
    AsyncResult.AsyncResult<Option.Option<Machine.ChildMachine.Ref<Child>>, StartError>
  >

  /**
   * Atom containing the current child lifecycle snapshot when active.
   *
   * @since 4.0.0
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
   * @since 4.0.0
   */
  readonly state: Atom.Atom<
    AsyncResult.AsyncResult<Option.Option<RefState<Machine.ChildMachine.Ref<Child>>>, StartError>
  >
  /**
   * Atom containing the current child state when active, with startup and
   * runtime failures in one typed failure channel.
   *
   * @since 4.0.0
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
   * @since 4.0.0
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
   * @since 4.0.0
   */
  readonly stop: Atom.Writable<
    AsyncResult.AsyncResult<void, StartError | NotReadyError | ChildNotActiveError>,
    void
  >
  /**
   * Creates a reactive bridge for a directly owned nested child. Reusing the
   * same descriptor returns the same live bridge while it remains referenced.
   *
   * @since 4.0.0
   */
  readonly child: <Nested extends Machine.ChildMachine.Any>(
    child: Nested
  ) => ChildMachineAtom<Nested, StartError>
}

type BridgeStartError<Bridge> = Bridge extends MachineAtom<any, any, any, any, infer StartError> ? StartError
  : Bridge extends ChildMachineAtom<any, infer StartError> ? StartError
  : never

/**
 * Derives the exact child bridge type from a parent bridge and child
 * descriptor.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ChildOf<
  Parent extends MachineAtom<any, any, any, any, any> | ChildMachineAtom<any, any>,
  Child extends Machine.ChildMachine.Any
> = ChildMachineAtom<Child, BridgeStartError<Parent>>

const makeRuntimeResultAtom = <State, Error, Output, StartError>(
  snapshot: Atom.Atom<AsyncResult.AsyncResult<Machine.RuntimeSnapshot<State, Error, Output>, StartError>>
): Atom.Atom<AsyncResult.AsyncResult<State, StartError | Error>> =>
  Atom.readable((get): AsyncResult.AsyncResult<State, StartError | Error> => {
    const current = get(snapshot)
    if (AsyncResult.isInitial(current)) {
      return AsyncResult.initial(current.waiting)
    } else if (AsyncResult.isFailure(current)) {
      return AsyncResult.failureWithPrevious(current.cause, {
        previous: get.self(),
        waiting: current.waiting
      })
    } else if (current.value.status === "error") {
      return AsyncResult.failureWithPrevious(current.value.cause, {
        previous: get.self(),
        waiting: current.waiting
      })
    }
    return AsyncResult.success(current.value.state, {
      waiting: current.waiting
    })
  }).pipe(Atom.withEquality(Equal.equals))

const makeChildRuntimeResultAtom = <State, Error, Output, StartError>(
  snapshot: Atom.Atom<
    AsyncResult.AsyncResult<Option.Option<Machine.RuntimeSnapshot<State, Error, Output>>, StartError>
  >
): Atom.Atom<AsyncResult.AsyncResult<Option.Option<State>, StartError | Error>> =>
  Atom.readable((get): AsyncResult.AsyncResult<Option.Option<State>, StartError | Error> => {
    const current = get(snapshot)
    if (AsyncResult.isInitial(current)) {
      return AsyncResult.initial(current.waiting)
    } else if (AsyncResult.isFailure(current)) {
      return AsyncResult.failureWithPrevious(current.cause, {
        previous: get.self(),
        waiting: current.waiting
      })
    } else if (Option.isNone(current.value)) {
      const previous = get.self<AsyncResult.AsyncResult<Option.Option<State>, StartError | Error>>()
      if (Option.isSome(previous) && AsyncResult.isFailure(previous.value)) {
        return previous.value
      }
      return AsyncResult.success(Option.none(), {
        waiting: current.waiting
      })
    } else if (current.value.value.status === "error") {
      return AsyncResult.failureWithPrevious(current.value.value.cause, {
        previous: get.self(),
        waiting: current.waiting
      })
    }
    return AsyncResult.success(Option.some(current.value.value.state), {
      waiting: current.waiting
    })
  }).pipe(Atom.withEquality(Equal.equals))

const makeChildRefAtom = <Child extends Machine.ChildMachine.Any, StartError>(
  parentRef: Atom.Atom<
    AsyncResult.AsyncResult<Option.Option<Machine.MachineRef<any, any, any, any>>, StartError>
  >,
  child: Child
): Atom.Atom<AsyncResult.AsyncResult<Option.Option<Machine.ChildMachine.Ref<Child>>, StartError>> =>
  Atom.readable((get) => {
    const parent = get(parentRef)
    if (AsyncResult.isInitial(parent)) {
      return AsyncResult.initial(parent.waiting)
    } else if (AsyncResult.isFailure(parent)) {
      return AsyncResult.failureWithPrevious(parent.cause, {
        previous: get.self(),
        waiting: parent.waiting
      })
    } else if (Option.isNone(parent.value)) {
      return AsyncResult.success(Option.none())
    }

    const handle = parent.value.value
    const current = Effect.runSync(handle.child(child))
    const cancel = Effect.runCallback(
      Effect.yieldNow.pipe(
        Effect.andThen(
          handle.childChanges(child).pipe(
            Stream.runForEach((ref) => Effect.sync(() => get.setSelf(AsyncResult.success(ref))))
          )
        )
      )
    )
    get.addFinalizer(cancel)
    return AsyncResult.success(current)
  })

const makeChildFromRefAtom = <Child extends Machine.ChildMachine.Any, StartError>(
  ref: Atom.Atom<AsyncResult.AsyncResult<Option.Option<Machine.ChildMachine.Ref<Child>>, StartError>>,
  descriptor: Child
): ChildMachineAtom<Child, StartError> => {
  type Ref = Machine.ChildMachine.Ref<Child>
  type State = RefState<Ref>
  type Error = RefError<Ref>
  type Output = RefOutput<Ref>

  const snapshot = Atom.readable((get): AsyncResult.AsyncResult<
    Option.Option<Machine.RuntimeSnapshot<State, Error, Output>>,
    StartError
  > => {
    const result = get(ref)
    if (AsyncResult.isInitial(result)) {
      return AsyncResult.initial(result.waiting)
    } else if (AsyncResult.isFailure(result)) {
      return AsyncResult.failureWithPrevious(result.cause, {
        previous: get.self(),
        waiting: result.waiting
      })
    } else if (Option.isNone(result.value)) {
      return AsyncResult.success(Option.none())
    }

    const handle = result.value.value as unknown as Machine.MachineRef<State, any, Error, Output>
    const cancel = Effect.runCallback(
      handle.changes.pipe(
        Stream.runForEach((snapshot) => Effect.sync(() => get.setSelf(AsyncResult.success(Option.some(snapshot)))))
      )
    )
    get.addFinalizer(cancel)
    return AsyncResult.success(Option.some(Effect.runSync(handle.snapshot)))
  })

  const send = Atom.writable<
    AsyncResult.AsyncResult<void, StartError | NotReadyError | ChildNotActiveError | Machine.StoppedError>,
    Machine.ChildMachine.Event<Child>
  >(
    (get) => AsyncResult.map(get(ref), () => undefined),
    (ctx, event) => {
      const result = ctx.get(ref)
      if (AsyncResult.isInitial(result)) {
        ctx.setSelf(AsyncResult.fail(new NotReadyError()))
      } else if (AsyncResult.isFailure(result)) {
        ctx.setSelf(AsyncResult.map(result, () => undefined))
      } else if (Option.isNone(result.value)) {
        ctx.setSelf(AsyncResult.fail(new ChildNotActiveError({ id: descriptor.id })))
      } else {
        Effect.runCallback(result.value.value.send(event as never), {
          onExit: (exit) => ctx.setSelf(AsyncResult.fromExit(exit))
        })
      }
    }
  )

  const stop = Atom.writable<
    AsyncResult.AsyncResult<void, StartError | NotReadyError | ChildNotActiveError>,
    void
  >(
    (get) => AsyncResult.map(get(ref), () => undefined),
    (ctx) => {
      const result = ctx.get(ref)
      if (AsyncResult.isInitial(result)) {
        ctx.setSelf(AsyncResult.fail(new NotReadyError()))
      } else if (AsyncResult.isFailure(result)) {
        ctx.setSelf(AsyncResult.map(result, () => undefined))
      } else if (Option.isNone(result.value)) {
        ctx.setSelf(AsyncResult.fail(new ChildNotActiveError({ id: descriptor.id })))
      } else {
        Effect.runCallback(result.value.value.stop)
      }
    }
  )

  const childFamily = Atom.family((nested: Machine.ChildMachine.Any) =>
    makeChildFromRefAtom(
      makeChildRefAtom(ref as any, nested),
      nested
    )
  )
  const child = <Nested extends Machine.ChildMachine.Any>(
    nested: Nested
  ): ChildMachineAtom<Nested, StartError> => childFamily(nested) as ChildMachineAtom<Nested, StartError>

  return {
    ref,
    snapshot,
    state: Atom.mapResult(snapshot, Option.map((snapshot) => snapshot.state)),
    result: makeChildRuntimeResultAtom(snapshot),
    send,
    stop,
    child
  }
}

const makeFromRefAtom = <State, Event, Error, Output, StartError>(
  ref: Atom.Atom<AsyncResult.AsyncResult<Machine.MachineRef<State, Event, Error, Output>, StartError>>
): MachineAtom<State, Event, Error, Output, StartError> => {
  const snapshot = Atom.readable((
    get
  ): AsyncResult.AsyncResult<Machine.RuntimeSnapshot<State, Error, Output>, StartError> => {
    const result = get(ref)
    if (AsyncResult.isInitial(result)) {
      return AsyncResult.initial(result.waiting)
    } else if (AsyncResult.isFailure(result)) {
      return AsyncResult.failureWithPrevious(result.cause, {
        previous: get.self<AsyncResult.AsyncResult<Machine.RuntimeSnapshot<State, Error, Output>, StartError>>(),
        waiting: result.waiting
      })
    }

    const handle = result.value
    const cancel = Effect.runCallback(
      handle.changes.pipe(
        Stream.runForEach((snapshot) =>
          Effect.sync(() =>
            get.setSelf(
              AsyncResult.success(snapshot, {
                waiting: snapshot.status === "active"
              })
            )
          )
        )
      )
    )
    get.addFinalizer(cancel)

    const current = Effect.runSync(handle.snapshot)
    return AsyncResult.success(current, {
      waiting: current.status === "active"
    })
  })

  const send = Atom.writable<
    AsyncResult.AsyncResult<void, StartError | NotReadyError | Machine.StoppedError>,
    Event
  >(
    (get) => AsyncResult.map(get(ref), () => undefined),
    (ctx, event: Event) => {
      const result = ctx.get(ref)
      if (AsyncResult.isInitial(result)) {
        ctx.setSelf(AsyncResult.fail(new NotReadyError()))
      } else if (AsyncResult.isFailure(result)) {
        ctx.setSelf(AsyncResult.map(result, () => undefined))
      } else {
        Effect.runCallback(result.value.send(event), {
          onExit: (exit) =>
            ctx.setSelf(
              AsyncResult.fromExit(exit)
            )
        })
      }
    }
  )

  const stop = Atom.writable<AsyncResult.AsyncResult<void, StartError | NotReadyError>, void>(
    (get) => AsyncResult.map(get(ref), () => undefined),
    (ctx) => {
      const result = ctx.get(ref)
      if (AsyncResult.isInitial(result)) {
        ctx.setSelf(AsyncResult.fail(new NotReadyError()))
      } else if (AsyncResult.isFailure(result)) {
        ctx.setSelf(AsyncResult.map(result, () => undefined))
      } else {
        Effect.runCallback(result.value.stop)
      }
    }
  )

  const optionalRef = Atom.mapResult(ref, Option.some)
  const childFamily = Atom.family((descriptor: Machine.ChildMachine.Any) =>
    makeChildFromRefAtom(
      makeChildRefAtom(optionalRef as any, descriptor),
      descriptor
    )
  )
  const child = <Child extends Machine.ChildMachine.Any>(
    descriptor: Child
  ): ChildMachineAtom<Child, StartError> => childFamily(descriptor) as ChildMachineAtom<Child, StartError>

  return {
    ref,
    snapshot,
    state: Atom.mapResult(snapshot, (snapshot) => snapshot.state),
    result: makeRuntimeResultAtom(snapshot),
    send,
    stop,
    child
  }
}

type SnapshotNode<State> = State extends Machine.Machine.AtomicSnapshot<string, unknown> ?
    | State
    | (State extends { readonly state: infer Child } ? SnapshotNode<Child>
      : State extends { readonly states: infer Regions } ? SnapshotNode<Regions[keyof Regions]>
      : never)
  : never

type SnapshotIdentifier<State> = SnapshotNode<State> extends infer Node ?
  Node extends { readonly path: infer Path extends string } ? Path : never
  : never

type SnapshotValueByIdentifier<State, Path extends SnapshotIdentifier<State>> = SnapshotNode<State> extends infer Node ?
  Node extends { readonly path: Path; readonly value: infer Value } ? Value : never
  : never

type ChildState<Child extends Machine.ChildMachine.Any> = RefState<Machine.ChildMachine.Ref<Child>>

const selectSnapshot = <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Path extends SnapshotIdentifier<State>
>(
  snapshot: State,
  path: Path
): Option.Option<SnapshotValueByIdentifier<State, Path>> =>
  Model.getSnapshotByPath(snapshot, path).pipe(
    Option.map((snapshot) => snapshot.value)
  ) as Option.Option<SnapshotValueByIdentifier<State, Path>>

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
 * const readyAtom = AtomMachine.select(machineAtom, "Ready")
 * // Atom<AsyncResult<Option<Ready>, StartError | RuntimeError>>
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const select = <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Event,
  Error,
  Output,
  StartError,
  const Path extends SnapshotIdentifier<State>
>(
  self: MachineAtom<State, Event, Error, Output, StartError>,
  path: Path
): Atom.Atom<
  AsyncResult.AsyncResult<Option.Option<SnapshotValueByIdentifier<State, Path>>, StartError | Error>
> =>
  Atom.mapResult(self.result, (snapshot) => selectSnapshot(snapshot, path)).pipe(
    Atom.withEquality(Equal.equals)
  )

/**
 * Selects the typed value for an active state path in an invoked child.
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
 * @since 4.0.0
 */
export const selectChild = <
  Child extends Machine.ChildMachine.Any,
  StartError,
  const Path extends SnapshotIdentifier<ChildState<Child>>
>(
  self: ChildMachineAtom<Child, StartError>,
  path: Path
): Atom.Atom<
  AsyncResult.AsyncResult<
    Option.Option<SnapshotValueByIdentifier<ChildState<Child>, Path>>,
    StartError | RefError<Machine.ChildMachine.Ref<Child>>
  >
> =>
  Atom.mapResult(
    self.result,
    Option.flatMap((snapshot) => selectSnapshot(snapshot, path))
  ).pipe(Atom.withEquality(Equal.equals))

/**
 * Returns whether a state path is active.
 *
 * Valid paths are inferred from the bridge snapshot.
 * The derived atom suppresses equal updates. Runtime failures remain in the
 * typed failure channel.
 *
 * @category combinators
 * @since 4.0.0
 */
export const matches = <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Event,
  Error,
  Output,
  StartError,
  const Path extends SnapshotIdentifier<State>
>(
  self: MachineAtom<State, Event, Error, Output, StartError>,
  path: Path
): Atom.Atom<AsyncResult.AsyncResult<boolean, StartError | Error>> =>
  Atom.mapResult(self.result, (snapshot) => Option.isSome(Model.getSnapshotByPath(snapshot, path))).pipe(
    Atom.withEquality(Equal.equals)
  )

/**
 * Returns whether a state path is active in an invoked child.
 *
 * Valid paths are inferred from the child bridge snapshot.
 * An inactive child produces `false`. Keep the returned atom stable when
 * constructing it inside a component.
 *
 * @category combinators
 * @since 4.0.0
 */
export const matchesChild = <
  Child extends Machine.ChildMachine.Any,
  StartError,
  const Path extends SnapshotIdentifier<ChildState<Child>>
>(
  self: ChildMachineAtom<Child, StartError>,
  path: Path
): Atom.Atom<
  AsyncResult.AsyncResult<boolean, StartError | RefError<Machine.ChildMachine.Ref<Child>>>
> =>
  Atom.mapResult(
    self.result,
    Option.exists((snapshot) => Option.isSome(Model.getSnapshotByPath(snapshot, path)))
  ).pipe(Atom.withEquality(Equal.equals))

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

type EnsureMachineOutputImplementations<M extends Machine.Machine.Any> = IsAny<Machine.Machine.States<M>> extends true ?
  {
    readonly "~effect/reactivity/AtomMachine/ConcreteMachineRequired": M
  }
  : Machine.Machine.EnsureOutputImplementations<Machine.Machine.States<M>, Machine.Machine.OutputStates<M>>

type MachineInputArgsOf<M extends Machine.Machine.Any> = [
  ...Machine.Machine.InputArgs<Machine.Machine.Input<M>>
]

type MachineAtomOf<M extends Machine.Machine.Any, RuntimeError> = MachineAtom<
  Machine.Machine.Snapshot<Machine.Machine.States<M>>,
  Machine.Machine.InputEvent<M>,
  MachineRuntimeError<Machine.Machine.Error<M>, Machine.Machine.Services<M>>,
  Machine.Machine.Output<M>,
  MachineStartError<
    Machine.Machine.InitialError<M>,
    Machine.Machine.Error<M>,
    Machine.Machine.InitialServices<M>,
    Machine.Machine.Services<M>,
    RuntimeError
  >
>

/**
 * An `AtomMachine` factory with one owned Effect runtime.
 *
 * @category models
 * @since 4.0.0
 */
export interface Bound<Services, RuntimeError = never> {
  /**
   * Creates an independent machine bridge using the bound runtime.
   *
   * The machine's external service requirements must be provided by the
   * runtime. Machine-native runtime requirements are supplied automatically.
   *
   * @since 4.0.0
   */
  readonly make: <M extends Machine.Machine.Any>(
    machine:
      & M
      & EnsureBoundRequirements<Services, NoInfer<M>>
      & EnsureMachineOutputImplementations<NoInfer<M>>,
    ...args: MachineInputArgsOf<M>
  ) => MachineAtomOf<M, RuntimeError>
}

/**
 * Creates atoms backed by a running machine.
 *
 * Use `bind(runtime).make(machine)` when the machine requires external
 * services.
 *
 * @category constructors
 * @since 4.0.0
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
    InputEvents extends ReadonlyArray<Machine.Machine.TaggedSchema> = Events
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
        InputEvents
      >
      & EnsureNoExternalRequirements<
        MachineRequirements<
          InitialR,
          R,
          Machine.Machine.EventOf<Events>,
          Machine.Machine.EmitOf<Emits>
        >
      >
      & Machine.Machine.EnsureOutputImplementations<States, OutputStates>,
    ...args: [...Machine.Machine.InputArgs<Input>]
  ): MachineAtom<
    Machine.Machine.Snapshot<States>,
    Machine.Machine.EventOf<InputEvents>,
    MachineRuntimeError<E, R>,
    Output,
    MachineStartError<InitialE, E, InitialR, R>
  >
} = ((machine: Machine.Machine.Any, ...args: ReadonlyArray<unknown>) => {
  const ref = Atom.make((get) => startMachineAtomEffect(get, machine as any, args as []))
  return makeFromRefAtom(ref as any)
}) as any

const makeWithRuntime = (
  runtime: Atom.AtomRuntime<any, any>,
  machine: Machine.Machine.Any,
  args: ReadonlyArray<unknown>
): MachineAtom<any, any, any, any, any> => {
  const ref = runtime.atom((get) => startMachineAtomEffect(get, machine as any, args as []))
  return makeFromRefAtom(ref as any)
}

/**
 * Creates an `AtomMachine` factory that owns a shared Effect runtime.
 *
 * Use this when an application runs many machines from the same service layer.
 * The returned factory keeps runtime provisioning at the composition boundary,
 * while every call to `make` still creates an independent machine bridge.
 *
 * @category constructors
 * @since 4.0.0
 */
export const bind = <Services, RuntimeError>(
  runtime: Atom.AtomRuntime<Services, RuntimeError>
): Bound<Services, RuntimeError> => ({
  make:
    ((machine: Machine.Machine.Any, ...args: ReadonlyArray<unknown>) =>
      makeWithRuntime(runtime, machine, args)) as Bound<
        Services,
        RuntimeError
      >["make"]
})
