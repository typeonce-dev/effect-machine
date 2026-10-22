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
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as Machine from "../../Machine.js"
import type { Bound, ChildMachineAtom, MachineAtom } from "../../unstable/reactivity/AtomMachine.js"
import * as internalMachine from "./machine.js"
import * as PlannedSnapshot from "./plannedSnapshot.js"
import type { EnsureExecutable } from "./readiness.js"
import type { ExcludeCompatibleRuntime as ExcludeCompatibleMachineRuntime, IsAny } from "./requirements.js"
import * as Topology from "./topology.js"

export class ChildNotActiveError extends Data.TaggedError("ChildNotActiveError")<{
  readonly id: string
}> {}

type AtomSupportedRequirements = Scope.Scope | AtomRegistry.AtomRegistry

type ExternalRequirements<Requirements> = Exclude<Requirements, AtomSupportedRequirements>

const ExternalRequirementsTypeId = "~effect/reactivity/AtomMachine/ExternalRequirements"

type EnsureNoExternalRequirements<Requirements> = [ExternalRequirements<Requirements>] extends [never] ? unknown : {
  readonly [ExternalRequirementsTypeId]: ExternalRequirements<Requirements>
}

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

const machineByMachineAtom = new WeakMap<object, Machine.Machine.Any>()

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
) => runMachineAtomEffect(get, internalMachine.resume(machine, snapshot))

// Server reads. A server read renders the planned startup snapshot and never
// evaluates a bridge ref, because evaluating it starts the machine. Effect
// passes plain registry reads to a server value, so every exported atom carries
// its own server value derived from the bridge plan.

type ServerRead = <A>(atom: Atom.Atom<A>) => A

interface ServerValued<A> {
  readonly [Atom.ServerValueTypeId]: (get: ServerRead) => A
}

// Effect stores the server read on the atom without exposing it in `Atom`'s
// type. This is the only erased boundary of the server protocol.
const readServerValue = <A>(atom: Atom.Atom<A>, get: ServerRead): A =>
  Atom.ServerValueTypeId in atom ? (atom as Atom.Atom<A> & ServerValued<A>)[Atom.ServerValueTypeId](get) : get(atom)

// React requires a referentially stable server snapshot, but Effect does not
// cache server reads. A server value is a pure function of the bridge plan and
// of the server values it reads, so each atom memoizes its latest result on the
// identity of those inputs. Unchanged inputs therefore return the same value
// for every read and registry, and derived atoms stay stable because their
// sources are.
const stableServerValue = <const Inputs extends ReadonlyArray<unknown>, A>(
  read: (get: ServerRead) => Inputs,
  compute: (...inputs: Inputs) => A
): (get: ServerRead) => A => {
  let memo: { readonly inputs: Inputs; readonly value: A } | undefined
  return (get) => {
    const inputs = read(get)
    if (
      memo === undefined ||
      memo.inputs.length !== inputs.length ||
      !memo.inputs.every((input, index) => Object.is(input, inputs[index]))
    ) {
      memo = { inputs, value: compute(...inputs) }
    }
    return memo.value
  }
}

/** A bridge plan: `undefined` when no snapshot can be planned synchronously. */
type ServerPlan = () => PlannedSnapshot.PlannedSnapshot | undefined

/**
 * A child bridge plan: `Option.none()` when the planned parent does not run
 * the child, `undefined` when the parent or child cannot be planned.
 */
type ChildServerPlan = () => Option.Option<PlannedSnapshot.PlannedSnapshot> | undefined

// Plans are computed on the first server read, at most once per bridge, so
// client starts never pay for them.
const lazyPlan = <A>(plan: () => A): () => A => {
  let planned: { readonly value: A } | undefined
  return () => {
    if (planned === undefined) planned = { value: plan() }
    return planned.value
  }
}

// Planned snapshots are erased to the machine's snapshot schema; the bridge
// that owns a plan types its state, error and output.
const plannedSnapshot = <State, Error, Output>(
  planned: PlannedSnapshot.PlannedSnapshot
): Machine.RuntimeSnapshot<State, Error, Output> => planned.snapshot as Machine.RuntimeSnapshot<State, Error, Output>

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

// A write context exposes no registry, but a read through it does. Commands
// written before a machine is ready wait on that registry for the ref.
const registryAtom: Atom.Atom<AtomRegistry.AtomRegistry> = Atom.readable((get) => get.registry).pipe(
  Atom.keepAlive
)

/**
 * Ordered delivery of held commands for one bridge in one registry.
 *
 * Commands written while the machine ref is still `Initial` are held here and
 * delivered in write order once it settles. While held commands remain, later
 * commands join the same queue so they cannot overtake earlier writes.
 */
interface CommandQueue {
  readonly pending: Array<Effect.Effect<void>>
  draining: boolean
}

type CommandQueues = WeakMap<AtomRegistry.AtomRegistry, CommandQueue>

const drainCommands = (queue: CommandQueue): Effect.Effect<void> =>
  Effect.suspend(() => {
    const next = queue.pending.shift()
    if (next === undefined) {
      queue.draining = false
      return Effect.void
    }
    return Effect.andThen(next, drainCommands(queue))
  })

const getCommandQueue = (queues: CommandQueues, registry: AtomRegistry.AtomRegistry): CommandQueue => {
  let queue = queues.get(registry)
  if (queue === undefined) {
    queue = { pending: [], draining: false }
    queues.set(registry, queue)
  }
  return queue
}

/**
 * Builds a command atom over a bridge ref.
 *
 * A write runs the command at once when the ref is ready and no earlier
 * command is held. Otherwise the command is held until the ref settles, the
 * write result stays waiting, and it settles with the command exit or with the
 * startup failure.
 */
const makeCommandAtom = <Ref, StartError, E, W>(
  ref: Atom.Atom<AsyncResult.AsyncResult<Ref, StartError>>,
  queues: CommandQueues,
  command: (ref: Ref, value: W) => Effect.Effect<void, E>
): Atom.Writable<AsyncResult.AsyncResult<void, StartError | E>, W> =>
  Atom.writable<AsyncResult.AsyncResult<void, StartError | E>, W>(
    (get): AsyncResult.AsyncResult<void, StartError | E> => {
      const current = AsyncResult.map(get(ref), () => undefined)
      const queue = queues.get(get.registry)
      if (queue === undefined || !queue.draining) {
        return current
      }
      return Option.getOrElse(
        Option.map(get.self<AsyncResult.AsyncResult<void, StartError | E>>(), AsyncResult.waiting),
        () => AsyncResult.initial(true)
      )
    },
    (ctx, value) => {
      const current = ctx.get(ref)
      const registry = ctx.get(registryAtom)
      const queue = getCommandQueue(queues, registry)
      if (AsyncResult.isInitial(current) || queue.draining) {
        ctx.setSelf(AsyncResult.initial(true))
        queue.pending.push(
          AtomRegistry.getResult(registry, ref).pipe(
            Effect.flatMap((ready) => command(ready, value)),
            Effect.exit,
            Effect.map((exit) => {
              const result = AsyncResult.fromExit(exit)
              ctx.setSelf(queue.pending.length === 0 ? result : AsyncResult.waiting(result))
            })
          )
        )
        if (!queue.draining) {
          queue.draining = true
          Effect.runFork(drainCommands(queue))
        }
      } else if (AsyncResult.isFailure(current)) {
        ctx.setSelf(AsyncResult.map(current, () => undefined))
      } else {
        Effect.runCallback(command(current.value, value), {
          onExit: (exit) => ctx.setSelf(AsyncResult.fromExit(exit))
        })
      }
    }
  ).pipe(Atom.withServerValueInitial)

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
  }).pipe(
    Atom.withEquality(Equal.equals),
    // A planned snapshot is never an error, so its state is the server result.
    Atom.withServerValue(
      stableServerValue(
        (get) => [readServerValue(snapshot, get)],
        (current) => AsyncResult.map(current, (current) => current.state)
      )
    )
  )

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
  }).pipe(
    Atom.withEquality(Equal.equals),
    Atom.withServerValue(
      stableServerValue(
        (get) => [readServerValue(snapshot, get)],
        (current) => AsyncResult.map(current, Option.map((current) => current.state))
      )
    )
  )

const makeChildRefAtom = <Child extends Machine.ChildMachine.Any, StartError>(
  parentRef: Atom.Atom<
    AsyncResult.AsyncResult<Option.Option<Machine.MachineRef<any, any, any, any, any>>, StartError>
  >,
  child: Child
): Atom.Atom<AsyncResult.AsyncResult<Option.Option<Machine.ChildMachine.Ref<Child>>, StartError>> =>
  Atom.readable((get): AsyncResult.AsyncResult<Option.Option<Machine.ChildMachine.Ref<Child>>, StartError> => {
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
  }).pipe(Atom.withServerValueInitial)

const makeChildFromRefAtom = <Child extends Machine.ChildMachine.Any, StartError>(
  ref: Atom.Atom<AsyncResult.AsyncResult<Option.Option<Machine.ChildMachine.Ref<Child>>, StartError>>,
  descriptor: Child,
  plan: ChildServerPlan
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
  }).pipe(
    Atom.withServerValue(stableServerValue(() => [], (): AsyncResult.AsyncResult<
      Option.Option<Machine.RuntimeSnapshot<State, Error, Output>>,
      StartError
    > => {
      const planned = plan()
      return planned === undefined
        ? AsyncResult.initial(true)
        : AsyncResult.success(Option.map(planned, plannedSnapshot<State, Error, Output>), { waiting: true })
    }))
  )

  const commands: CommandQueues = new WeakMap()
  const activeChild = (current: Option.Option<Ref>): Effect.Effect<Ref, ChildNotActiveError> =>
    Option.isSome(current)
      ? Effect.succeed(current.value)
      : Effect.fail(new ChildNotActiveError({ id: descriptor.id }))

  const send: ChildMachineAtom<Child, StartError>["send"] = makeCommandAtom(
    ref,
    commands,
    (current, event: Machine.ChildMachine.Event<Child>) =>
      Effect.flatMap(activeChild(current), (child) => child.send(event as never))
  )

  const stop: ChildMachineAtom<Child, StartError>["stop"] = makeCommandAtom(
    ref,
    commands,
    (current, _: void) => Effect.flatMap(activeChild(current), (child) => child.stop)
  )

  const child = makeChildSelector<StartError>(ref as any, plan)

  return {
    ref,
    snapshot,
    result: makeChildRuntimeResultAtom(snapshot),
    send,
    stop,
    child
  }
}

const makeChildSelector = <StartError>(
  parentRef: Atom.Atom<
    AsyncResult.AsyncResult<Option.Option<Machine.MachineRef<any, any, any, any, any>>, StartError>
  >,
  parentPlan: ChildServerPlan
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
          child,
          lazyPlan(() => {
            const parent = parentPlan()
            return parent === undefined || Option.isNone(parent)
              ? parent
              : PlannedSnapshot.planInvokedChild(parent.value, child)
          })
        )
      })
      family = (id) => atoms(id) as ChildMachineAtom<Machine.ChildMachine.Any, StartError>
      byMachine.set(machine, family)
    }
    return family(descriptor.id) as ChildMachineAtom<Child, StartError>
  }
}

const makeFromRefAtom = <State, Event, Error, Output, StartError, Emitted>(
  liveRef: Atom.Atom<AsyncResult.AsyncResult<Machine.MachineRef<State, Event, Error, Output, Emitted>, StartError>>,
  machine: Machine.Machine.Any,
  plan: ServerPlan
): MachineAtom<State, Event, Error, Output, StartError, Emitted> => {
  const ref = Atom.withServerValueInitial(liveRef)
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
  }).pipe(
    Atom.withServerValue(
      stableServerValue(
        () => [],
        (): AsyncResult.AsyncResult<Machine.RuntimeSnapshot<State, Error, Output>, StartError> => {
          const planned = plan()
          return planned === undefined
            ? AsyncResult.initial(true)
            : AsyncResult.success(plannedSnapshot<State, Error, Output>(planned), { waiting: true })
        }
      )
    )
  )

  const commands: CommandQueues = new WeakMap()

  const send: MachineAtom<State, Event, Error, Output, StartError, Emitted>["send"] = makeCommandAtom(
    ref,
    commands,
    (handle, event: Event) => handle.send(event)
  )

  const stop: MachineAtom<State, Event, Error, Output, StartError, Emitted>["stop"] = makeCommandAtom(
    ref,
    commands,
    (handle, _: void) => handle.stop
  )

  const optionalRef = Atom.mapResult(ref, Option.some)
  const child = makeChildSelector<StartError>(optionalRef as any, () => {
    const planned = plan()
    return planned === undefined ? undefined : Option.some(planned)
  })

  const result = {
    ref,
    snapshot,
    result: makeRuntimeResultAtom(snapshot),
    send,
    stop,
    child
  }
  machineByMachineAtom.set(result, machine)
  return result
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

// Selectors project the bridge result live and its planned result on the server.
const mapResultSelector = <A, B, E>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  f: (value: A) => B
): Atom.Atom<AsyncResult.AsyncResult<B, E>> =>
  Atom.mapResult(source, f).pipe(
    Atom.withEquality(Equal.equals),
    Atom.withServerValue(
      stableServerValue((get) => [readServerValue(source, get)], (current) => AsyncResult.map(current, f))
    )
  )

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
    () => mapResultSelector(self.result, (snapshot) => selectValueByPath(snapshot, path))
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
    () => mapResultSelector(self.result, (snapshot) => selectSnapshotByPath(snapshot, path))
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
    mapResultSelector(
      self.result,
      Option.flatMap((snapshot) => selectValueByPath(snapshot, path))
    ))

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
    mapResultSelector(
      self.result,
      Option.flatMap((snapshot) => selectSnapshotByPath(snapshot, path))
    ))

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
    () => mapResultSelector(self.result, (snapshot) => Option.isSome(Topology.getSnapshotByPath(snapshot, path)))
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
    mapResultSelector(
      self.result,
      Option.exists((snapshot) => Option.isSome(Topology.getSnapshotByPath(snapshot, path)))
    ))

export const can = (event: unknown) => {
  const byBridge = new WeakMap<object, Atom.Atom<AsyncResult.AsyncResult<boolean, any>>>()
  return (self: MachineAtom<any, any, any, any, any, any>): Atom.Atom<AsyncResult.AsyncResult<boolean, any>> => {
    const cached = byBridge.get(self)
    if (cached !== undefined) return cached

    const machine = machineByMachineAtom.get(self)
    const query: (
      state: Machine.Machine.Snapshot<any>,
      event: unknown
    ) => Effect.Effect<boolean, Machine.MachineSchemaDecodeError> = machine === undefined
      ? () => Effect.die(new Error("AtomMachine.can requires a machine atom created by AtomMachine"))
      : internalMachine.can(machine)

    const evaluate = (
      current: AsyncResult.AsyncResult<Machine.RuntimeSnapshot<any, any, any>, any>,
      input: unknown,
      previous: Option.Option<AsyncResult.AsyncResult<boolean, any>>
    ): AsyncResult.AsyncResult<boolean, any> => {
      if (AsyncResult.isInitial(current)) {
        return AsyncResult.initial(current.waiting)
      } else if (AsyncResult.isFailure(current)) {
        return AsyncResult.failureWithPrevious(current.cause, {
          previous,
          waiting: current.waiting
        })
      } else if (current.value.status === "error") {
        return AsyncResult.failureWithPrevious(current.value.cause, {
          previous,
          waiting: current.waiting
        })
      } else if (current.value.status !== "active") {
        return AsyncResult.success(false, { waiting: current.waiting })
      }

      const exit = Effect.runSyncExit(query(current.value.state, input))
      return exit._tag === "Success"
        ? AsyncResult.success(exit.value, { waiting: current.waiting })
        : AsyncResult.failureWithPrevious(exit.cause, {
          previous,
          waiting: current.waiting
        })
    }

    const result = Atom.readable((get): AsyncResult.AsyncResult<boolean, any> =>
      evaluate(
        get(self.snapshot),
        Atom.isAtom(event) ? get(event) : event,
        get.self<AsyncResult.AsyncResult<boolean, any>>()
      )
    ).pipe(
      Atom.withEquality(Equal.equals),
      Atom.withServerValue(
        stableServerValue(
          (get) => [readServerValue(self.snapshot, get), Atom.isAtom(event) ? readServerValue(event, get) : event],
          (current, input) => evaluate(current, input, Option.none())
        )
      )
    )

    byBridge.set(self, result)
    return result
  }
}

type MachineResumeRequirementsOf<M extends Machine.Machine.Any> = MachineResumeRequirements<
  Machine.Machine.Services<M>,
  Machine.Machine.Event<M>,
  Machine.Machine.EmittedEvent<M>
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
          Machine.Machine.EmittedEventOf<Emits>
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
  const prepared = Atom.make(() => internalMachine.prepare(machine, ...args))
  const ref = Atom.make((get) => startPreparedMachineAtomEffect(get, prepared as any))
  const result = makeFromRefAtom(ref as any, machine, lazyPlan(() => PlannedSnapshot.planStart(machine, args)))
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
  return makeFromRefAtom(ref as any, machine, lazyPlan(() => PlannedSnapshot.planResume(machine, snapshot)))
}) as any

const makeWithRuntime = (
  runtime: Atom.AtomRuntime<any, any>,
  machine: Machine.Machine.Any,
  args: ReadonlyArray<unknown>
): MachineAtom<any, any, any, any, any, any> => {
  const prepared = runtime.atom(() => internalMachine.prepare(machine, ...args))
  const ref = runtime.atom((get) => startPreparedMachineAtomEffect(get, prepared as any))
  const result = makeFromRefAtom(ref as any, machine, lazyPlan(() => PlannedSnapshot.planStart(machine, args)))
  preparedByMachineAtom.set(result, prepared as any)
  return result
}

const resumeWithRuntime = (
  runtime: Atom.AtomRuntime<any, any>,
  machine: Machine.Machine.Any,
  snapshot: Machine.Machine.Snapshot<any>
): MachineAtom<any, any, any, any, any, any> => {
  const ref = runtime.atom((get) => resumeMachineAtomEffect(get, machine, snapshot))
  return makeFromRefAtom(ref as any, machine, lazyPlan(() => PlannedSnapshot.planResume(machine, snapshot)))
}

type FamilyBridge = MachineAtom.Any | ChildMachineAtom.Any

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
    Atom.withEquality((value, next) => retained.source.equals(value, next)),
    // The source's server value is already stable, so it passes through as is.
    Atom.withServerValue((get) => readServerValue(retained.source, get))
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
  parent: FamilyBridge,
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
