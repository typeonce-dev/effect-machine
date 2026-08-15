/**
 * Atom bridge for running machines.
 *
 * @since 0.4.0
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
import type * as Machine from "../../Machine.js"
import type { Bound, ChildMachineAtom, MachineAtom } from "../../unstable/reactivity/AtomMachine.js"
import * as internalMachine from "./machine.js"
import type { EnsureExecutable } from "./readiness.js"
import * as Topology from "./topology.js"

export class NotReadyError extends Data.TaggedError("NotReadyError") {}

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

const preparedByMachineAtom = new WeakMap<
  object,
  Atom.Atom<AsyncResult.AsyncResult<Machine.Prepared<any, any, any, any, any, any, any>, any>>
>()

const runMachineAtomEffect = <State, Event, Error, Output, Emitted, StartError, Requirements>(
  get: Atom.AtomContext,
  start: Effect.Effect<Machine.MachineRef<State, Event, Error, Output, Emitted>, StartError, Requirements>
): Effect.Effect<never, StartError, Requirements> =>
  Effect.scoped(
    Effect.acquireRelease(start, (ref) => ref.stop).pipe(
      Effect.tap((ref) => Effect.sync(() => get.setSelf(AsyncResult.success(ref)))),
      Effect.flatMap(() => Effect.never)
    )
  )

const startPreparedMachineAtomEffect = <State, Event, Error, Output, Emitted, StartError, Requirements>(
  get: Atom.AtomContext,
  prepared: Atom.Atom<
    AsyncResult.AsyncResult<
      Machine.Prepared<State, Event, Error, Output, Emitted, StartError, Requirements>,
      never
    >
  >
): Effect.Effect<never, StartError, Requirements> =>
  runMachineAtomEffect(get, get.result(prepared).pipe(Effect.flatMap((prepared) => prepared.start)))

const resumeMachineAtomEffect = (
  get: Atom.AtomContext,
  machine: Machine.Machine.Any,
  snapshot: Machine.Machine.Snapshot<any>
) => runMachineAtomEffect(get, internalMachine.resume(machine as any, snapshot as any))

type RefState<Ref> = Ref extends Machine.MachineRef<infer State, any, any, any> ? State : never
type RefError<Ref> = Ref extends Machine.MachineRef<any, any, infer Error, any> ? Error : never
type RefOutput<Ref> = Ref extends Machine.MachineRef<any, any, any, infer Output> ? Output : never
type RefEmitted<Ref> = Ref extends Machine.MachineRef<any, any, any, any, infer Emitted> ? Emitted : never

export const emissions = <State, Event, Error, Output, StartError, Emitted>(
  self: MachineAtom<State, Event, Error, Output, StartError, Emitted>
): Stream.Stream<Emitted, StartError, AtomRegistry.AtomRegistry> => {
  const prepared = preparedByMachineAtom.get(self as object)
  if (prepared === undefined) {
    return Atom.toStreamResult(self.ref).pipe(Stream.flatMap((ref) => ref.emissions))
  }
  return Stream.unwrap(
    Effect.gen(function*() {
      const registry = yield* AtomRegistry.AtomRegistry
      const releasePrepared = yield* Effect.sync(() => registry.mount(prepared))
      yield* Effect.addFinalizer(() => Effect.sync(releasePrepared))
      const machine = yield* Atom.getResult(prepared)
      const pull = yield* Stream.toPull(machine.emissions as Stream.Stream<Emitted>)
      const firstPull = yield* pull.pipe(Effect.forkScoped({ startImmediately: true }))
      const releaseRef = yield* Effect.sync(() => registry.mount(self.ref))
      yield* Effect.addFinalizer(() => Effect.sync(releaseRef))
      yield* Atom.getResult(self.ref)
      let first = true
      return Stream.fromPull(Effect.succeed(Effect.suspend(() => {
        if (!first) return pull
        first = false
        return Fiber.join(firstPull)
      })))
    })
  )
}

export const childEmissions = <Child extends Machine.ChildMachine.Any, StartError>(
  self: ChildMachineAtom<Child, StartError>
): Stream.Stream<RefEmitted<Machine.ChildMachine.Ref<Child>>, StartError, AtomRegistry.AtomRegistry> =>
  Atom.toStreamResult(self.ref).pipe(
    Stream.flatMap(
      Option.match({
        onNone: () => Stream.empty,
        onSome: (ref) => ref.emissions
      })
    )
  )

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

const selectValueByPath = <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Path extends ValuedSnapshotIdentifier<State>
>(
  snapshot: State,
  path: Path
): Option.Option<SnapshotValueByIdentifier<State, Path>> =>
  Topology.getSnapshotByPath(snapshot, path).pipe(
    Option.map((snapshot) => snapshot.value)
  ) as Option.Option<SnapshotValueByIdentifier<State, Path>>

const selectSnapshotByPath = <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Path extends SnapshotIdentifier<State>
>(
  snapshot: State,
  path: Path
): Option.Option<SnapshotByIdentifier<State, Path>> =>
  Topology.getSnapshotByPath(snapshot, path) as Option.Option<SnapshotByIdentifier<State, Path>>

export const select = <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Event,
  Error,
  Output,
  StartError,
  const Path extends ValuedSnapshotIdentifier<State>
>(
  self: MachineAtom<State, Event, Error, Output, StartError>,
  path: Path
): Atom.Atom<
  AsyncResult.AsyncResult<Option.Option<SnapshotValueByIdentifier<State, Path>>, StartError | Error>
> =>
  Atom.mapResult(self.result, (snapshot) => selectValueByPath(snapshot, path)).pipe(
    Atom.withEquality(Equal.equals)
  )

export const selectSnapshot = <
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
  AsyncResult.AsyncResult<Option.Option<SnapshotByIdentifier<State, Path>>, StartError | Error>
> =>
  Atom.mapResult(self.result, (snapshot) => selectSnapshotByPath(snapshot, path)).pipe(
    Atom.withEquality(Equal.equals)
  )

export const selectChild = <
  Child extends Machine.ChildMachine.Any,
  StartError,
  const Path extends ValuedSnapshotIdentifier<ChildState<Child>>
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
    Option.flatMap((snapshot) => selectValueByPath(snapshot, path))
  ).pipe(Atom.withEquality(Equal.equals))

export const selectSnapshotChild = <
  Child extends Machine.ChildMachine.Any,
  StartError,
  const Path extends SnapshotIdentifier<ChildState<Child>>
>(
  self: ChildMachineAtom<Child, StartError>,
  path: Path
): Atom.Atom<
  AsyncResult.AsyncResult<
    Option.Option<SnapshotByIdentifier<ChildState<Child>, Path>>,
    StartError | RefError<Machine.ChildMachine.Ref<Child>>
  >
> =>
  Atom.mapResult(
    self.result,
    Option.flatMap((snapshot) => selectSnapshotByPath(snapshot, path))
  ).pipe(Atom.withEquality(Equal.equals))

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
  Atom.mapResult(self.result, (snapshot) => Option.isSome(Topology.getSnapshotByPath(snapshot, path))).pipe(
    Atom.withEquality(Equal.equals)
  )

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
    Option.exists((snapshot) => Option.isSome(Topology.getSnapshotByPath(snapshot, path)))
  ).pipe(Atom.withEquality(Equal.equals))

type MachineResumeRequirementsOf<M extends Machine.Machine.Any> = MachineResumeRequirements<
  Machine.Machine.Services<M>,
  Machine.Machine.Event<M>,
  Machine.Machine.Emit<M>
>

type EnsureMachineExecutable<M extends Machine.Machine.Any> = IsAny<Machine.Machine.States<M>> extends true ? {
    readonly "~effect/reactivity/AtomMachine/ConcreteMachineRequired": M
  }
  : EnsureExecutable<
    Machine.Machine.States<M>,
    Machine.Machine.UnhandledStates<M>,
    Machine.Machine.OutputStates<M>
  >

type ResumedMachineAtomOf<M extends Machine.Machine.Any, RuntimeError> = MachineAtom<
  Machine.Machine.Snapshot<Machine.Machine.States<M>>,
  Machine.Machine.EventInput<Machine.Machine.InputEvent<M>>,
  MachineRuntimeError<Machine.Machine.Error<M>, Machine.Machine.Services<M>>,
  Machine.Machine.Output<M>,
  Machine.MachineSchemaDecodeError | RuntimeError,
  Machine.Machine.EmittedEvent<M>
>

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
      & EnsureExecutable<States, UnhandledStates, OutputStates>,
    ...args: [...Machine.Machine.InputArgs<Input>]
  ): MachineAtom<
    Machine.Machine.Snapshot<States>,
    Machine.Machine.EventInputOf<InputEvents>,
    MachineRuntimeError<E, R>,
    Output,
    MachineStartError<InitialE, E, InitialR, R>,
    Machine.Machine.EmittedEventOf<Emits>
  >
} = ((machine: Machine.Machine.Any, ...args: ReadonlyArray<unknown>) => {
  const prepared = Atom.make(() => internalMachine.prepare(machine as any, ...(args as [])))
  const ref = Atom.make((get) => startPreparedMachineAtomEffect(get, prepared as any))
  const result = makeFromRefAtom(ref as any)
  preparedByMachineAtom.set(result, prepared as any)
  return result
}) as any

export const resume: {
  <M extends Machine.Machine.Any>(
    machine:
      & M
      & EnsureNoExternalRequirements<MachineResumeRequirementsOf<NoInfer<M>>>
      & EnsureMachineExecutable<NoInfer<M>>,
    snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  ): ResumedMachineAtomOf<M, never>
} = ((machine: Machine.Machine.Any, snapshot: Machine.Machine.Snapshot<any>) => {
  const ref = Atom.make((get) => resumeMachineAtomEffect(get, machine, snapshot))
  return makeFromRefAtom(ref as any)
}) as any

const makeWithRuntime = (
  runtime: Atom.AtomRuntime<any, any>,
  machine: Machine.Machine.Any,
  args: ReadonlyArray<unknown>
): MachineAtom<any, any, any, any, any> => {
  const prepared = runtime.atom(() => internalMachine.prepare(machine as any, ...(args as [])))
  const ref = runtime.atom((get) => startPreparedMachineAtomEffect(get, prepared as any))
  const result = makeFromRefAtom(ref as any)
  preparedByMachineAtom.set(result, prepared as any)
  return result
}

const resumeWithRuntime = (
  runtime: Atom.AtomRuntime<any, any>,
  machine: Machine.Machine.Any,
  snapshot: Machine.Machine.Snapshot<any>
): MachineAtom<any, any, any, any, any> => {
  const ref = runtime.atom((get) => resumeMachineAtomEffect(get, machine, snapshot))
  return makeFromRefAtom(ref as any)
}

export const bind = <Services, RuntimeError>(
  runtime: Atom.AtomRuntime<Services, RuntimeError>
): Bound<Services, RuntimeError> => ({
  make:
    ((machine: Machine.Machine.Any, ...args: ReadonlyArray<unknown>) =>
      makeWithRuntime(runtime, machine, args)) as Bound<
        Services,
        RuntimeError
      >["make"],
  resume:
    ((machine: Machine.Machine.Any, snapshot: Machine.Machine.Snapshot<any>) =>
      resumeWithRuntime(runtime, machine, snapshot)) as Bound<Services, RuntimeError>["resume"]
})
