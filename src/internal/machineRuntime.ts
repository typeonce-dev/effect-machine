/**
 * Internal machine process runtime helpers.
 *
 * @since 4.0.0
 */

import * as Cause from "effect/Cause"
import * as Channel from "effect/Channel"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import * as SynchronizedRef from "effect/SynchronizedRef"
import type * as Take from "effect/Take"
import { ChildAlreadyExistsError, StoppedError } from "./machineErrors.js"

type ChildDescriptor = {
  readonly id: string
  readonly machine: object
}

type ChildEntry =
  | {
    readonly _tag: "Starting"
    readonly token: symbol
  }
  | {
    readonly _tag: "Started"
    readonly token: symbol
    readonly descriptor: ChildDescriptor | undefined
    readonly ref: MachineRef<any, any, any, any>
  }

type ChildSelector = string | ChildDescriptor

interface ChildRegistry {
  readonly revision: number
  readonly children: HashMap.HashMap<string, ChildEntry>
}

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

interface VersionedSnapshot<State, Error, Output> {
  readonly revision: number
  readonly snapshot: RuntimeSnapshot<State, Error, Output>
}

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

export interface MachineRef<out State, in Event, out Error = never, out Output = never> {
  readonly id: string
  readonly sessionId: string
  readonly state: Effect.Effect<State>
  readonly snapshot: Effect.Effect<RuntimeSnapshot<State, Error, Output>>
  readonly changes: Stream.Stream<RuntimeSnapshot<State, Error, Output>>
  readonly join: Effect.Effect<Output, Error | StoppedError>
  readonly stop: Effect.Effect<void>
  readonly send: (event: Event) => Effect.Effect<void, StoppedError>
  readonly child: (child: any) => Effect.Effect<Option.Option<any>>
  readonly childChanges: (child: any) => Stream.Stream<Option.Option<any>>
}

interface ProcessAddress<in Event> {
  readonly id: string
  readonly sessionId: string
  readonly stop: Effect.Effect<void>
  readonly send: (event: Event) => Effect.Effect<void, StoppedError>
}

export interface ProcessScope<Event> {
  readonly self: ProcessAddress<Event>
  readonly parent: ProcessAddress<unknown> | undefined
  readonly spawn: ProcessSpawn
  readonly sendParent: (event: unknown) => Effect.Effect<void, StoppedError>
  readonly sendTo: (child: ChildSelector, event: unknown) => Effect.Effect<void, StoppedError>
  readonly stopChild: (child: ChildSelector) => Effect.Effect<void>
  /** @internal */
  readonly failCause: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
}

export interface ProcessContext<State, Event> extends ProcessScope<Event> {
  readonly receive: Effect.Effect<Event>
  readonly state: Effect.Effect<State>
  readonly setState: (state: State) => Effect.Effect<void>
  readonly updateState: <E, R>(
    f: (state: State) => Effect.Effect<State, E, R>
  ) => Effect.Effect<void, E, R>
}

export interface ProcessLogic<
  State,
  Event,
  out Error = never,
  out Requirements = never,
  out Output = never,
  out InitialError = never
> {
  initial(scope: ProcessScope<Event>): Effect.Effect<State, InitialError, Requirements>
  run(context: ProcessContext<State, Event>): Effect.Effect<Output, Error, Requirements>
}

export interface ProcessSpawn {
  <ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError = never>(
    logic: ProcessLogic<ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError>
  ): Effect.Effect<
    MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
    ChildInitialError,
    Exclude<ChildRequirements, Scope.Scope>
  >
  <ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError = never>(
    logic: ProcessLogic<ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError>,
    options: {
      readonly id: string
      readonly descriptor?: ChildDescriptor
    }
  ): Effect.Effect<
    MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
    ChildAlreadyExistsError | ChildInitialError,
    Exclude<ChildRequirements, Scope.Scope>
  >
}

export class MachineRuntime extends Context.Service<MachineRuntime, ProcessScope<any>>()(
  "effect/Machine/MachineRuntime"
) {}

export const provideMachineRuntime = <A, E, R, Event>(
  effect: Effect.Effect<A, E, R>,
  scope: ProcessScope<Event>
): Effect.Effect<A, E, Exclude<R, MachineRuntime>> =>
  Effect.provideService(effect, MachineRuntime, scope as ProcessScope<any>)

const classifyOutcome = <State, Error, Output>(
  snapshot: RuntimeSnapshot<State, Error, Output>
): RuntimeOutcome<State, Error, Output> | undefined => {
  switch (snapshot.status) {
    case "active": {
      return undefined
    }
    case "done": {
      return {
        _tag: "Done",
        output: snapshot.output,
        snapshot
      }
    }
    case "error": {
      const failure = snapshot.cause.reasons.find(Cause.isFailReason)
      if (failure !== undefined) {
        return {
          _tag: "Failure",
          error: failure.error,
          cause: snapshot.cause,
          snapshot
        }
      }
      const defect = snapshot.cause.reasons.find(Cause.isDieReason)
      if (defect !== undefined) {
        return {
          _tag: "Defect",
          defect: defect.defect,
          cause: snapshot.cause,
          snapshot
        }
      }
      const interrupted = snapshot.cause.reasons.find(Cause.isInterruptReason)
      if (interrupted !== undefined) {
        return {
          _tag: "Interrupted",
          cause: snapshot.cause,
          snapshot
        }
      }
      return {
        _tag: "Cause",
        cause: snapshot.cause,
        snapshot
      }
    }
    case "stopped": {
      return {
        _tag: "Stopped",
        snapshot
      }
    }
  }
}

export const watch = <State, Event, Error = never, Output = never>(
  ref: MachineRef<State, Event, Error, Output>
): Stream.Stream<RuntimeOutcome<State, Error, Output>> =>
  ref.changes.pipe(
    Stream.filter((snapshot) => snapshot.status !== "active"),
    Stream.map((snapshot) => classifyOutcome(snapshot)!),
    Stream.take(1)
  )

interface ProcessRuntime {
  readonly close: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>
  readonly nextSessionId: Effect.Effect<string>
  readonly rootScope: Scope.Closeable
}

const makeProcessRuntime: Effect.Effect<ProcessRuntime> = Effect.gen(function*() {
  let sessionIdCounter = 0
  const rootScope = yield* Scope.make("parallel")
  return {
    close: (exit) => Scope.close(rootScope, exit),
    nextSessionId: Effect.sync(() => `machine:${sessionIdCounter++}`),
    rootScope
  }
})

interface StartInternalOptions {
  readonly detached?: boolean
  readonly fiberScope?: Scope.Scope
  readonly finalizer?: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>
  readonly id?: string
  readonly onReady?: (ref: MachineRef<any, any, any, any>) => Effect.Effect<void>
  readonly onStop?: Effect.Effect<void>
  readonly parent?: ProcessAddress<unknown>
  readonly runtime: ProcessRuntime
}

const startInternal: <
  State,
  Event,
  Error = never,
  Requirements = never,
  Output = never,
  InitialError = never
>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  options: StartInternalOptions
) => Effect.Effect<
  MachineRef<State, Event, Error, Output>,
  InitialError,
  Requirements
> = Effect.fnUntraced(function*<State, Event, Error, Requirements, Output, InitialError>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  options: StartInternalOptions
) {
  const sessionId = yield* options.runtime.nextSessionId
  const id = options.id ?? sessionId
  const queue = yield* Queue.unbounded<Event>()
  const stopRequested = yield* Deferred.make<void>()
  const terminalized = yield* Deferred.make<void>()
  const externalFailure = yield* Deferred.make<never, Error>()
  const done = yield* Deferred.make<Output, Error | StoppedError>()
  const changes = yield* PubSub.unbounded<Take.Take<VersionedSnapshot<State, Error, Output>>>({
    replay: 1
  })
  const childrenScope = yield* Scope.make("parallel")
  const childRegistry = yield* SubscriptionRef.make<ChildRegistry>({ revision: 0, children: HashMap.empty() })
  const currentChildrenScope = yield* SynchronizedRef.make<Scope.Closeable>(childrenScope)

  const closeChildren = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> =>
    SynchronizedRef.get(currentChildrenScope).pipe(
      Effect.flatMap((scope) => Scope.close(scope, exit))
    )

  const cleanupStartupFailure = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> =>
    Exit.isFailure(exit)
      ? closeChildren(exit).pipe(
        Effect.ensuring(Deferred.succeed(terminalized, void 0))
      )
      : Effect.void

  const finalize = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
    options.finalizer === undefined ? Effect.void : options.finalizer(exit)

  const cleanup = options.onStop ?? Effect.void

  const reserveChildId = (
    id: string,
    token: symbol
  ): Effect.Effect<void, ChildAlreadyExistsError> =>
    SubscriptionRef.modifyEffect(childRegistry, (registry) =>
      HashMap.has(registry.children, id)
        ? Effect.fail(new ChildAlreadyExistsError({ id }))
        : Effect.succeed(
          [undefined, {
            revision: registry.revision,
            children: HashMap.set(registry.children, id, { _tag: "Starting", token })
          }] as const
        ))

  const unregisterChild = (id: string, token: symbol): Effect.Effect<void> =>
    SubscriptionRef.modify(childRegistry, (registry) => {
      const entry = HashMap.get(registry.children, id)
      if (Option.isNone(entry) || entry.value.token !== token) {
        return [undefined, registry] as const
      }
      const next = {
        revision: registry.revision + 1,
        children: HashMap.remove(registry.children, id)
      }
      return [next, next] as const
    }).pipe(Effect.asVoid)

  const registerStartedChild = (
    id: string,
    token: symbol,
    ref: MachineRef<any, any, any, any>,
    descriptor: ChildDescriptor | undefined
  ): Effect.Effect<boolean> =>
    SubscriptionRef.modify<ChildRegistry, boolean>(
      childRegistry,
      (registry) => {
        const entry = HashMap.get(registry.children, id)
        if (Option.isNone(entry) || entry.value._tag !== "Starting" || entry.value.token !== token) {
          return [false, registry] as const
        }
        const next = {
          revision: registry.revision + 1,
          children: HashMap.set(
            HashMap.remove(registry.children, id),
            id,
            { _tag: "Started", token, descriptor, ref }
          )
        }
        return [true, next] as const
      }
    )

  const matchesChildSelector = (
    entry: ChildEntry,
    child: ChildSelector
  ): entry is Extract<ChildEntry, { readonly _tag: "Started" }> =>
    entry._tag === "Started" && (typeof child === "string" || (
      entry.descriptor !== undefined &&
      entry.descriptor.id === child.id &&
      entry.descriptor.machine === child.machine
    ))

  const getChild = <ChildState, ChildEvent, ChildError, ChildOutput>(
    child: ChildSelector
  ): Effect.Effect<Option.Option<MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>>> => {
    const id = typeof child === "string" ? child : child.id
    return (
      SubscriptionRef.get(childRegistry).pipe(
        Effect.map((registry) => {
          const entry = HashMap.get(registry.children, id)
          return Option.isSome(entry) && matchesChildSelector(entry.value, child)
            ? Option.some(entry.value.ref as MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>)
            : Option.none()
        })
      )
    )
  }

  const childChanges = <ChildState, ChildEvent, ChildError, ChildOutput>(
    child: ChildSelector
  ): Stream.Stream<Option.Option<MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>>> => {
    const id = typeof child === "string" ? child : child.id
    return SubscriptionRef.changes(childRegistry).pipe(
      Stream.map((registry) => {
        const entry = HashMap.get(registry.children, id)
        return Option.isSome(entry) && matchesChildSelector(entry.value, child)
          ? Option.some(entry.value.ref as MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>)
          : Option.none()
      })
    )
  }

  const sendTo = (child: ChildSelector, event: unknown): Effect.Effect<void, StoppedError> => {
    const id = typeof child === "string" ? child : child.id
    return (
      SubscriptionRef.get(childRegistry).pipe(
        Effect.flatMap((registry) => {
          const entry = HashMap.get(registry.children, id)
          return Option.isSome(entry) && matchesChildSelector(entry.value, child)
            ? entry.value.ref.send(event)
            : Effect.void
        })
      )
    )
  }

  const stopChild = (child: ChildSelector): Effect.Effect<void> => {
    const id = typeof child === "string" ? child : child.id
    return (
      SubscriptionRef.get(childRegistry).pipe(
        Effect.flatMap((registry) => {
          const entry = HashMap.get(registry.children, id)
          return Option.isSome(entry) && matchesChildSelector(entry.value, child) ? entry.value.ref.stop : Effect.void
        })
      )
    )
  }

  const sendParent = (event: unknown): Effect.Effect<void, StoppedError> =>
    options.parent === undefined ? Effect.void : options.parent.send(event)

  function spawn<ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError = never>(
    logic: ProcessLogic<ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError>
  ): Effect.Effect<
    MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
    ChildInitialError,
    Exclude<ChildRequirements, Scope.Scope>
  >
  function spawn<ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError = never>(
    logic: ProcessLogic<ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError>,
    spawnOptions: {
      readonly id: string
      readonly descriptor?: ChildDescriptor
    }
  ): Effect.Effect<
    MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
    ChildAlreadyExistsError | ChildInitialError,
    Exclude<ChildRequirements, Scope.Scope>
  >
  function spawn<ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError = never>(
    logic: ProcessLogic<ChildState, ChildEvent, ChildError, ChildRequirements, ChildOutput, ChildInitialError>,
    spawnOptions?: {
      readonly id: string
      readonly descriptor?: ChildDescriptor
    }
  ): Effect.Effect<
    MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
    ChildAlreadyExistsError | ChildInitialError,
    Exclude<ChildRequirements, Scope.Scope>
  > {
    if (spawnOptions?.id === undefined) {
      return SynchronizedRef.get(currentChildrenScope).pipe(
        Effect.flatMap((childrenScope) =>
          Effect.acquireRelease(
            startInternal(logic, {
              fiberScope: childrenScope,
              parent: self as MachineRef<unknown, unknown, unknown, unknown>,
              runtime: options.runtime
            }),
            (child) => child.stop
          ).pipe(Scope.provide(childrenScope))
        )
      ) as Effect.Effect<
        MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
        ChildInitialError,
        Exclude<ChildRequirements, Scope.Scope>
      >
    }

    const childId = spawnOptions.id
    return SynchronizedRef.get(currentChildrenScope).pipe(
      Effect.flatMap((childrenScope) =>
        Effect.acquireRelease(
          Effect.gen(function*() {
            const token = Symbol()
            yield* reserveChildId(childId, token)
            const child = yield* startInternal(logic, {
              fiberScope: childrenScope,
              id: childId,
              onReady: (child) =>
                registerStartedChild(
                  childId,
                  token,
                  child,
                  spawnOptions.descriptor
                ).pipe(Effect.asVoid),
              onStop: unregisterChild(childId, token),
              parent: self as ProcessAddress<unknown>,
              runtime: options.runtime
            }).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? unregisterChild(childId, token)
                  : Effect.void
              )
            )
            return child
          }),
          (child) => child.stop
        ).pipe(Scope.provide(childrenScope))
      )
    ) as Effect.Effect<
      MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
      ChildAlreadyExistsError | ChildInitialError,
      Exclude<ChildRequirements, Scope.Scope>
    >
  }

  let initializing = true
  const requestStop = Deferred.succeed(stopRequested, void 0).pipe(Effect.asVoid)
  const self: ProcessAddress<Event> = {
    id,
    sessionId,
    // Initialization must finish constructing a state before a stopped
    // snapshot can be published. A stop requested there is therefore recorded
    // and returns so initialization can finish. Once running, the requesting
    // process waits forever and is interrupted by the supervisor after the
    // stop request wins, so execution never continues after `self.stop`.
    stop: Effect.suspend(() =>
      initializing
        ? requestStop
        : requestStop.pipe(Effect.andThen(Effect.never))
    ),
    send: (event: Event) =>
      Queue.offer(queue, event).pipe(
        Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(new StoppedError()))
      )
  }

  const scope: ProcessScope<Event> = {
    self,
    parent: options.parent,
    spawn: spawn as ProcessSpawn,
    sendParent,
    sendTo,
    stopChild,
    failCause: (cause) => Deferred.failCause(externalFailure, cause as Cause.Cause<Error>)
  }

  const initial = yield* logic.initial(scope).pipe(
    Effect.onExit(cleanupStartupFailure),
    Effect.ensuring(Effect.sync(() => {
      initializing = false
    }))
  )
  const current = yield* SynchronizedRef.make<VersionedSnapshot<State, Error, Output>>({
    revision: 0,
    snapshot: {
      status: "active",
      state: initial
    }
  })
  const terminalizing = yield* Ref.make(false)
  const publishSnapshot = (
    snapshot: VersionedSnapshot<State, Error, Output>
  ): Effect.Effect<VersionedSnapshot<State, Error, Output>> =>
    PubSub.publish(changes, [snapshot] as const).pipe(Effect.as(snapshot))

  const completeChanges: Effect.Effect<void> = PubSub.publish(changes, Exit.succeed<void>(undefined)).pipe(
    Effect.asVoid
  )

  const completeIfTerminal = (
    snapshot: VersionedSnapshot<State, Error, Output>
  ): Effect.Effect<VersionedSnapshot<State, Error, Output>> => {
    if (snapshot.snapshot.status === "active") {
      return Effect.succeed(snapshot)
    }
    return completeChanges.pipe(Effect.as(snapshot))
  }

  const publishIfCurrent = (
    snapshot: VersionedSnapshot<State, Error, Output>
  ): Effect.Effect<VersionedSnapshot<State, Error, Output> | undefined> =>
    SynchronizedRef.get(current).pipe(
      Effect.flatMap((
        currentSnapshot
      ): Effect.Effect<VersionedSnapshot<State, Error, Output> | undefined> =>
        currentSnapshot.revision === snapshot.revision
          ? publishSnapshot(snapshot).pipe(Effect.flatMap(completeIfTerminal))
          : Effect.succeed(undefined)
      )
    )

  type SnapshotModification = readonly [
    VersionedSnapshot<State, Error, Output> | undefined,
    VersionedSnapshot<State, Error, Output>
  ]

  const updateSnapshot = <E2, R2>(
    f: (
      snapshot: RuntimeSnapshot<State, Error, Output>
    ) => Effect.Effect<RuntimeSnapshot<State, Error, Output> | undefined, E2, R2>
  ): Effect.Effect<RuntimeSnapshot<State, Error, Output> | undefined, E2, R2> =>
    SynchronizedRef.modifyEffect(
      current,
      (current) =>
        Ref.get(terminalizing).pipe(
          Effect.flatMap((isTerminalizing) =>
            isTerminalizing
              ? Effect.succeed([undefined, current] as const)
              : Effect.map(
                f(current.snapshot),
                (next) => {
                  if (next === undefined) {
                    return [undefined, current] as const
                  }
                  const versioned = {
                    revision: current.revision + 1,
                    snapshot: next
                  }
                  return [versioned, versioned] as const
                }
              )
          )
        )
    ).pipe(
      Effect.flatMap((versioned) => versioned === undefined ? Effect.succeed(undefined) : publishIfCurrent(versioned)),
      Effect.map((published) => published?.snapshot)
    )

  const reserveTerminalSnapshot = (
    f: (
      snapshot: Extract<RuntimeSnapshot<State, Error, Output>, { readonly status: "active" }>
    ) => RuntimeSnapshot<State, Error, Output>
  ): Effect.Effect<RuntimeSnapshot<State, Error, Output> | undefined> =>
    SynchronizedRef.modifyEffect(
      current,
      (current) =>
        Ref.get(terminalizing).pipe(
          Effect.flatMap((isTerminalizing): Effect.Effect<SnapshotModification> => {
            if (isTerminalizing || current.snapshot.status !== "active") {
              return Effect.succeed([undefined, current] as SnapshotModification)
            }
            return Ref.set(terminalizing, true).pipe(
              Effect.as([
                {
                  revision: current.revision + 1,
                  snapshot: f(current.snapshot)
                },
                current
              ] as SnapshotModification)
            )
          })
        )
    ).pipe(Effect.map((versioned) => versioned?.snapshot))

  const setAndPublishSnapshot = (
    snapshot: RuntimeSnapshot<State, Error, Output>
  ): Effect.Effect<void> =>
    SynchronizedRef.updateAndGet(current, (current) => ({
      revision: current.revision + 1,
      snapshot
    })).pipe(
      Effect.flatMap(publishSnapshot),
      Effect.flatMap(completeIfTerminal),
      Effect.asVoid
    )

  const setActiveState = (state: State) =>
    updateSnapshot((snapshot) =>
      Effect.succeed(
        snapshot.status === "active"
          ? {
            status: "active",
            state
          }
          : undefined
      )
    ).pipe(Effect.asVoid)

  const terminalizeWith = (
    snapshot: RuntimeSnapshot<State, Error, Output>,
    exit: Exit.Exit<unknown, unknown>,
    completeDone: Effect.Effect<void>
  ): Effect.Effect<void> =>
    Effect.uninterruptible(
      Queue.shutdown(queue).pipe(
        Effect.andThen(closeChildren(exit)),
        Effect.andThen(setAndPublishSnapshot(snapshot)),
        Effect.andThen(cleanup),
        Effect.andThen(finalize(exit)),
        Effect.andThen(completeDone),
        Effect.ensuring(Deferred.succeed(terminalized, void 0))
      )
    )

  const reserveStoppedSnapshot = reserveTerminalSnapshot((snapshot) => ({
    status: "stopped",
    state: snapshot.state
  }))

  const reserveFailureSnapshot = (cause: Cause.Cause<Error>) =>
    reserveTerminalSnapshot((snapshot) => ({
      status: "error",
      state: snapshot.state,
      cause
    }))

  const reserveSuccessSnapshot = (output: Output) =>
    reserveTerminalSnapshot((snapshot) => ({
      status: "done",
      state: snapshot.state,
      output
    }))

  const terminalizeReservedStop = (
    snapshot: RuntimeSnapshot<State, Error, Output>
  ): Effect.Effect<void> => {
    const exit = Exit.void
    return terminalizeWith(
      snapshot,
      exit,
      Deferred.fail(done, new StoppedError())
    )
  }

  const terminalizeReservedFailure = (
    snapshot: RuntimeSnapshot<State, Error, Output>,
    cause: Cause.Cause<Error>
  ): Effect.Effect<void> => {
    const exit = Exit.failCause(cause)
    return terminalizeWith(snapshot, exit, Deferred.failCause(done, cause))
  }

  const terminalizeReservedSuccess = (
    snapshot: RuntimeSnapshot<State, Error, Output>,
    output: Output
  ): Effect.Effect<void> => {
    const exit = Exit.succeed(output)
    return terminalizeWith(snapshot, exit, Deferred.succeed(done, output))
  }

  const terminalizeStop: Effect.Effect<void> = Effect.uninterruptible(
    reserveStoppedSnapshot.pipe(
      Effect.flatMap((snapshot) =>
        snapshot === undefined
          ? Deferred.await(terminalized)
          : terminalizeReservedStop(snapshot)
      )
    )
  )

  const stop: Effect.Effect<void> = Effect.uninterruptible(
    requestStop.pipe(Effect.andThen(Deferred.await(terminalized)))
  )

  const context: ProcessContext<State, Event> = {
    ...scope,
    receive: Queue.take(queue),
    state: SynchronizedRef.get(current).pipe(Effect.map((current) => current.snapshot.state)),
    setState: setActiveState,
    updateState: (f) =>
      updateSnapshot((snapshot) =>
        snapshot.status === "active"
          ? f(snapshot.state).pipe(
            Effect.map((state) => ({
              status: "active" as const,
              state
            }))
          )
          : Effect.succeed(undefined)
      ).pipe(Effect.asVoid)
  }

  yield* publishSnapshot(yield* SynchronizedRef.get(current))

  const changesStream: Stream.Stream<RuntimeSnapshot<State, Error, Output>> = Stream.unwrap(
    Effect.gen(function*() {
      const subscription = yield* PubSub.subscribe(changes)
      const captured = yield* SynchronizedRef.get(current)
      if (captured.snapshot.status !== "active") {
        return Stream.succeed(captured.snapshot)
      }
      return Stream.succeed(captured.snapshot).pipe(
        Stream.concat(
          Stream.fromChannel(Channel.fromEffectTake(PubSub.take(subscription))).pipe(
            Stream.filter((next) => next.revision > captured.revision),
            Stream.map((next) => next.snapshot)
          )
        )
      )
    })
  )

  const ref: MachineRef<State, Event, Error, Output> = {
    id,
    sessionId,
    state: SynchronizedRef.get(current).pipe(Effect.map((current) => current.snapshot.state)),
    snapshot: SynchronizedRef.get(current).pipe(Effect.map((current) => current.snapshot)),
    changes: changesStream,
    join: Deferred.await(done),
    stop,
    send: self.send,
    child: getChild,
    childChanges
  }

  if (options.onReady !== undefined) {
    yield* options.onReady(ref)
  }

  type ProcessTermination =
    | { readonly _tag: "Stopped"; readonly snapshot: RuntimeSnapshot<State, Error, Output> }
    | {
      readonly _tag: "Done"
      readonly snapshot: RuntimeSnapshot<State, Error, Output>
      readonly output: Output
    }
    | {
      readonly _tag: "Failure"
      readonly snapshot: RuntimeSnapshot<State, Error, Output>
      readonly cause: Cause.Cause<Error>
    }

  const arbitration = yield* Deferred.make<ProcessTermination>()
  // Only the actual worker and stop waiter are restored to interruptibility.
  // Reserving a terminal snapshot, publishing the shared arbitration result,
  // and terminalizing stay masked so scope interruption cannot abandon a
  // reservation. Both contenders read the same result: a contender that loses
  // the reservation cannot finish the race with a different outcome.
  const runFiber: Effect.Effect<void, never, Requirements> = Effect.uninterruptibleMask((restore) =>
    Deferred.poll(stopRequested).pipe(
      Effect.flatMap((requested) => {
        if (Option.isSome(requested)) {
          return terminalizeStop
        }
        const awaitArbitration = Deferred.await(arbitration)
        const completeArbitration = (termination: ProcessTermination) =>
          Deferred.succeed(arbitration, termination).pipe(
            Effect.andThen(awaitArbitration)
          )
        const stopContender = restore(Deferred.await(stopRequested)).pipe(
          Effect.andThen(reserveStoppedSnapshot),
          Effect.flatMap((snapshot) =>
            snapshot === undefined
              ? awaitArbitration
              : completeArbitration({ _tag: "Stopped", snapshot })
          )
        )
        const workerContender: Effect.Effect<ProcessTermination, never, Requirements> = restore(
          Effect.raceFirst(
            Effect.suspend(() => logic.run(context)),
            Deferred.await(externalFailure)
          )
        ).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Exit.isFailure(exit)
              ? reserveFailureSnapshot(exit.cause).pipe(
                Effect.flatMap((snapshot) =>
                  snapshot === undefined
                    ? awaitArbitration
                    : completeArbitration({ _tag: "Failure", snapshot, cause: exit.cause })
                )
              )
              : reserveSuccessSnapshot(exit.value).pipe(
                Effect.flatMap((snapshot) =>
                  snapshot === undefined
                    ? awaitArbitration
                    : completeArbitration({ _tag: "Done", snapshot, output: exit.value })
                )
              )
          )
        )
        return Effect.raceFirst(workerContender, stopContender).pipe(
          Effect.flatMap((termination) => {
            switch (termination._tag) {
              case "Stopped":
                return terminalizeReservedStop(termination.snapshot)
              case "Done":
                return terminalizeReservedSuccess(termination.snapshot, termination.output)
              case "Failure":
                return terminalizeReservedFailure(termination.snapshot, termination.cause)
            }
          })
        )
      })
    )
  )

  yield* runFiber.pipe(
    (effect) =>
      options.fiberScope !== undefined ?
        Effect.forkIn(effect, options.fiberScope)
        : options.detached === true ?
        Effect.forkDetach(effect)
        : Effect.forkChild(effect)
  )
  yield* Effect.yieldNow

  return ref
})

export const startProcess: <
  State,
  Event,
  Error = never,
  Requirements = never,
  Output = never,
  InitialError = never
>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  options?: {
    readonly id?: string
  }
) => Effect.Effect<
  MachineRef<State, Event, Error, Output>,
  InitialError,
  Requirements
> = Effect.fnUntraced(function*<State, Event, Error, Requirements, Output, InitialError>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  options?: {
    readonly id?: string
  }
) {
  const runtime = yield* makeProcessRuntime
  return yield* startInternal(
    logic,
    options === undefined
      ? {
        detached: true,
        finalizer: runtime.close,
        runtime
      }
      : {
        ...options,
        detached: true,
        finalizer: runtime.close,
        runtime
      }
  ).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? runtime.close(exit) : Effect.void))
})
