/**
 * Atom bridge for running machines.
 *
 * @since 0.4.0
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Fiber from "effect/Fiber"
import * as MutableHashMap from "effect/MutableHashMap"
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

type WeakFamilyEntry<Value extends object> = {
  readonly ref: WeakRef<Value>
}

// This follows Atom.family, but cleanup is generation-aware. A finalizer for a
// collected value must not remove a newer value installed for the same key.
const retainedFamily = <Key, Value extends object>(
  makeValue: (key: Key) => Value
): (key: Key) => Value => {
  if (typeof WeakRef === "undefined" || typeof FinalizationRegistry === "undefined") {
    return Atom.family(makeValue)
  }

  const values = MutableHashMap.empty<Key, WeakFamilyEntry<Value>>()
  const registry = new FinalizationRegistry<{
    readonly key: Key
    readonly entry: WeakFamilyEntry<Value>
  }>(({ entry, key }) => {
    const current = MutableHashMap.get(values, key)
    if (Option.isSome(current) && current.value === entry) {
      MutableHashMap.remove(values, key)
    }
  })

  return (key) => {
    const current = MutableHashMap.get(values, key)
    if (Option.isSome(current)) {
      const value = current.value.ref.deref()
      if (value !== undefined) {
        return value
      }
    }

    const value = makeValue(key)
    const entry = { ref: new WeakRef(value) }
    MutableHashMap.set(values, key, entry)
    registry.register(value, { key, entry })
    return value
  }
}

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

type RefState<Ref> = Ref extends Machine.MachineRef<infer State, any, any, any, any> ? State : never
type RefError<Ref> = Ref extends Machine.MachineRef<any, any, infer Error, any, any> ? Error : never
type RefOutput<Ref> = Ref extends Machine.MachineRef<any, any, any, infer Output, any> ? Output : never
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

export const inspection = <State, Event, Error, Output, StartError, Emitted>(
  self: MachineAtom<State, Event, Error, Output, StartError, Emitted>
): Stream.Stream<Machine.Inspection.Event, StartError, AtomRegistry.AtomRegistry> => {
  const prepared = preparedByMachineAtom.get(self as object)
  if (prepared === undefined) return Stream.empty
  return Stream.unwrap(
    Effect.gen(function*() {
      const registry = yield* AtomRegistry.AtomRegistry
      const releasePrepared = yield* Effect.sync(() => registry.mount(prepared))
      yield* Effect.addFinalizer(() => Effect.sync(releasePrepared))
      const machine = yield* Atom.getResult(prepared)
      const pull = yield* Stream.toPull(machine.inspection)
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
    AsyncResult.AsyncResult<Option.Option<Machine.MachineRef<any, any, any, any, any>>, StartError>
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

    const handle = result.value.value as unknown as Machine.MachineRef<State, any, Error, Output, any>
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

  const child = makeChildSelector<StartError>(ref as any)

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

const makeChildSelector = <StartError>(
  parentRef: Atom.Atom<
    AsyncResult.AsyncResult<Option.Option<Machine.MachineRef<any, any, any, any, any>>, StartError>
  >
) => {
  const byMachine = new WeakMap<object, (id: string) => ChildMachineAtom<Machine.ChildMachine.Any, StartError>>()
  return <Child extends Machine.ChildMachine.Any>(descriptor: Child): ChildMachineAtom<Child, StartError> => {
    let family = byMachine.get(descriptor.machine)
    if (family === undefined) {
      const machine = descriptor.machine
      const atoms = Atom.family((id: string) => {
        const child = internalMachine.child(id, machine)
        return makeChildFromRefAtom(
          makeChildRefAtom(parentRef as any, child),
          child
        )
      })
      family = (id) => atoms(id) as ChildMachineAtom<Machine.ChildMachine.Any, StartError>
      byMachine.set(machine, family)
    }
    return family(descriptor.id) as ChildMachineAtom<Child, StartError>
  }
}

const makeFromRefAtom = <State, Event, Error, Output, StartError, Emitted>(
  ref: Atom.Atom<AsyncResult.AsyncResult<Machine.MachineRef<State, Event, Error, Output, Emitted>, StartError>>
): MachineAtom<State, Event, Error, Output, StartError, Emitted> => {
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
  const child = makeChildSelector<StartError>(optionalRef as any)

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

type SelectorKind =
  | "matches"
  | "matchesChild"
  | "select"
  | "selectChild"
  | "selectSnapshot"
  | "selectSnapshotChild"

const selectorsByBridge = new WeakMap<object, Map<SelectorKind, Map<string, Atom.Atom<any>>>>()

const cachedSelector = <A>(
  bridge: object,
  kind: SelectorKind,
  path: string,
  make: () => Atom.Atom<A>
): Atom.Atom<A> => {
  let selectorsByKind = selectorsByBridge.get(bridge)
  if (selectorsByKind === undefined) {
    selectorsByKind = new Map()
    selectorsByBridge.set(bridge, selectorsByKind)
  }
  let selectorsByPath = selectorsByKind.get(kind)
  if (selectorsByPath === undefined) {
    selectorsByPath = new Map()
    selectorsByKind.set(kind, selectorsByPath)
  }
  const cached = selectorsByPath.get(path)
  if (cached !== undefined) {
    return cached as Atom.Atom<A>
  }
  const selector = make()
  selectorsByPath.set(path, selector)
  return selector
}

export const select = <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Event,
  Error,
  Output,
  StartError,
  Emitted,
  const Path extends ValuedSnapshotIdentifier<State>
>(
  self: MachineAtom<State, Event, Error, Output, StartError, Emitted>,
  path: Path
): Atom.Atom<
  AsyncResult.AsyncResult<Option.Option<SnapshotValueByIdentifier<State, Path>>, StartError | Error>
> =>
  cachedSelector(
    self,
    "select",
    path,
    () =>
      Atom.mapResult(self.result, (snapshot) => selectValueByPath(snapshot, path)).pipe(
        Atom.withEquality(Equal.equals)
      )
  )

export const selectSnapshot = <
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
): Atom.Atom<
  AsyncResult.AsyncResult<Option.Option<SnapshotByIdentifier<State, Path>>, StartError | Error>
> =>
  cachedSelector(
    self,
    "selectSnapshot",
    path,
    () =>
      Atom.mapResult(self.result, (snapshot) => selectSnapshotByPath(snapshot, path)).pipe(
        Atom.withEquality(Equal.equals)
      )
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
  cachedSelector(self, "selectChild", path, () =>
    Atom.mapResult(
      self.result,
      Option.flatMap((snapshot) => selectValueByPath(snapshot, path))
    ).pipe(Atom.withEquality(Equal.equals)))

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
  cachedSelector(self, "selectSnapshotChild", path, () =>
    Atom.mapResult(
      self.result,
      Option.flatMap((snapshot) => selectSnapshotByPath(snapshot, path))
    ).pipe(Atom.withEquality(Equal.equals)))

export const matches = <
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
): Atom.Atom<AsyncResult.AsyncResult<boolean, StartError | Error>> =>
  cachedSelector(
    self,
    "matches",
    path,
    () =>
      Atom.mapResult(self.result, (snapshot) => Option.isSome(Topology.getSnapshotByPath(snapshot, path))).pipe(
        Atom.withEquality(Equal.equals)
      )
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
  cachedSelector(self, "matchesChild", path, () =>
    Atom.mapResult(
      self.result,
      Option.exists((snapshot) => Option.isSome(Topology.getSnapshotByPath(snapshot, path)))
    ).pipe(Atom.withEquality(Equal.equals)))

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
} = ((machine: Machine.Machine.Any, ...args: ReadonlyArray<unknown>) => {
  const prepared = Atom.make(() => internalMachine.prepare(machine as any, ...(args as [])))
  const ref = Atom.make((get) => startPreparedMachineAtomEffect(get, prepared as any))
  const result = makeFromRefAtom(ref as any)
  preparedByMachineAtom.set(result, prepared as any)
  return result
}) as any

export const factory =
  ((machine: Machine.Machine.Any) => (...args: ReadonlyArray<unknown>) => (make as any)(machine, ...args)) as any

export const resume: {
  <M extends Machine.Machine.Any>(
    machine:
      & M
      & EnsureNoExternalRequirements<MachineResumeRequirementsOf<NoInfer<M>>>
      & EnsureMachineExecutable<NoInfer<M>>
      & Machine.Machine.RootCompatible<Machine.Machine.ParentEvents<NoInfer<M>>>,
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
): MachineAtom<any, any, any, any, any, any> => {
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
): MachineAtom<any, any, any, any, any, any> => {
  const ref = runtime.atom((get) => resumeMachineAtomEffect(get, machine, snapshot))
  return makeFromRefAtom(ref as any)
}

type FamilyBridge = MachineAtom<any, never, any, any, any, any> | ChildMachineAtom<any, any>

type FamilyOptions = {
  readonly atoms: Readonly<Record<string, (bridge: FamilyBridge) => Atom.Atom<any>>>
  readonly label?: (key: any, atomName: string) => string | undefined
}

const retainFamilyOwner = <Source extends Atom.Atom<any>>(
  owner: { readonly bridge: FamilyBridge },
  source: Source,
  label: string | undefined
): Atom.WithoutSerializable<Source> => {
  const retained = { owner, source }
  let atom: Atom.Atom<any> = Atom.transform(
    source,
    (get) => get(retained.source),
    { initialValueTarget: source }
  ).pipe(
    Atom.withEquality((value, next) => retained.source.equals(value, next))
  )
  if (label !== undefined) {
    atom = atom.pipe(Atom.withLabel(label))
  }
  return atom as unknown as Atom.WithoutSerializable<Source>
}

const makeFamily = (
  makeBridge: (key: any) => FamilyBridge,
  options: FamilyOptions
): Readonly<Record<string, (key: any) => Atom.Atom<any>>> => {
  const owners = retainedFamily((key: any) => ({ bridge: makeBridge(key) }))
  const atoms: Record<string, (key: any) => Atom.Atom<any>> = {}

  for (const atomName of Object.keys(options.atoms)) {
    const project = options.atoms[atomName]!
    atoms[atomName] = retainedFamily((key: any) => {
      const owner = owners(key)
      const source = project(owner.bridge)
      return retainFamilyOwner(owner, source, options.label?.(key, atomName))
    })
  }

  return atoms
}

export const family = (
  machine: Machine.Machine.Any,
  options: FamilyOptions
): Readonly<Record<string, (key: any) => Atom.Atom<any>>> =>
  makeFamily(
    (input) => (make as any)(machine, input),
    options
  )

export const familyChild = (
  parent: MachineAtom<any, never, any, any, any, any> | ChildMachineAtom<any, any>,
  options: FamilyOptions & { readonly child: (key: any) => Machine.ChildMachine.Any }
): Readonly<Record<string, (key: any) => Atom.Atom<any>>> =>
  makeFamily(
    (key) => parent.child(options.child(key)),
    options
  )

export const bind = <Services, RuntimeError>(
  runtime: Atom.AtomRuntime<Services, RuntimeError>
): Bound<Services, RuntimeError> => {
  const makeBound =
    ((machine: Machine.Machine.Any, ...args: ReadonlyArray<unknown>) =>
      makeWithRuntime(runtime, machine, args)) as Bound<
        Services,
        RuntimeError
      >["make"]
  return {
    make: makeBound,
    factory:
      ((machine: Machine.Machine.Any) => (...args: ReadonlyArray<unknown>) =>
        (makeBound as any)(machine, ...args)) as Bound<Services, RuntimeError>["factory"],
    resume:
      ((machine: Machine.Machine.Any, snapshot: Machine.Machine.Snapshot<any>) =>
        resumeWithRuntime(runtime, machine, snapshot)) as Bound<Services, RuntimeError>["resume"],
    family: ((machine: Machine.Machine.Any, options: FamilyOptions) =>
      makeFamily(
        (input) => makeWithRuntime(runtime, machine, [input]),
        options
      )) as Bound<Services, RuntimeError>["family"]
  }
}
