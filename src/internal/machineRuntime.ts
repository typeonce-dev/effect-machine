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
import * as Fiber from "effect/Fiber"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
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
type ChildKey = string | symbol

/** @internal */
export const activeSnapshotObserver: unique symbol = Symbol.for("effect/Machine/activeSnapshotObserver")

/** @internal */
export const childlessProcess: unique symbol = Symbol.for("effect/Machine/childlessProcess")

/** @internal */
export const compiledProcess: unique symbol = Symbol.for("effect/Machine/compiledProcess")

/** @internal */
export const sendParentOverride: unique symbol = Symbol.for("effect/Machine/sendParentOverride")

interface ChildRegistrySnapshot {
  readonly closed: boolean
  readonly revision: number
  readonly children: ReadonlyMap<ChildKey, ChildEntry>
}

interface ChildRegistry {
  closed: boolean
  revision: number
  readonly children: Map<ChildKey, ChildEntry>
  changes: PubSub.PubSub<ChildRegistrySnapshot> | undefined
  scope: Scope.Closeable | undefined
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
  readonly terminalizing: boolean
  readonly changes: PubSub.PubSub<Take.Take<VersionedSnapshot<State, Error, Output>>> | undefined
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
  /** @internal */
  readonly mailbox?: Queue.Dequeue<Event>
  /** @internal */
  readonly poll?: Effect.Effect<Option.Option<Event>>
  readonly state: Effect.Effect<State>
  readonly setState: (state: State) => Effect.Effect<void>
  readonly updateState: <E, R>(
    f: (state: State) => Effect.Effect<State, E, R>
  ) => Effect.Effect<void, E, R>
}

interface CompactProcessMailbox<Event> {
  items: Array<Event> | undefined
  index: number
  closed: boolean
}

const offerCompactMailbox = <Event>(mailbox: CompactProcessMailbox<Event>, event: Event): void => {
  const items = mailbox.items ?? []
  mailbox.items = items
  items.push(event)
}

const pollCompactMailbox = <Event>(mailbox: CompactProcessMailbox<Event>): Option.Option<Event> => {
  if (mailbox.items === undefined) {
    return Option.none()
  }
  const event = mailbox.items[mailbox.index]!
  mailbox.index += 1
  if (mailbox.index === mailbox.items.length) {
    mailbox.items = undefined
    mailbox.index = 0
  }
  return Option.some(event)
}

const closeCompactMailbox = (mailbox: CompactProcessMailbox<unknown>): void => {
  mailbox.closed = true
  mailbox.items = undefined
  mailbox.index = 0
}

export interface ProcessLogic<
  State,
  Event,
  out Error = never,
  out Requirements = never,
  out Output = never,
  out InitialError = never
> {
  readonly [childlessProcess]?: true
  readonly [compiledProcess]?: true
  initial(scope: ProcessScope<Event>): Effect.Effect<State, InitialError, Requirements>
  run(context: ProcessContext<State, Event>): Effect.Effect<Output, Error, Requirements>
  /** @internal */
  readonly drain?: (
    context: ProcessContext<State, Event>
  ) => Effect.Effect<Option.Option<Output>, Error, Requirements>
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
      readonly onOutcome?: (
        outcome: RuntimeOutcome<ChildState, ChildError, ChildOutput>
      ) => Effect.Effect<void>
      readonly [activeSnapshotObserver]?: (
        snapshot: Extract<RuntimeSnapshot<ChildState, ChildError, ChildOutput>, { readonly status: "active" }>
      ) => Effect.Effect<void>
      readonly [sendParentOverride]?: (event: unknown) => Effect.Effect<void, StoppedError>
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

const notifyActiveSnapshot = <State, Error, Output>(
  onSnapshot: (
    snapshot: Extract<RuntimeSnapshot<State, Error, Output>, { readonly status: "active" }>
  ) => Effect.Effect<void>,
  snapshot: Extract<RuntimeSnapshot<State, Error, Output>, { readonly status: "active" }>
): Effect.Effect<void> =>
  Effect.suspend(() => onSnapshot(snapshot)).pipe(
    Effect.exit,
    Effect.asVoid
  )

export const watch = <State, Event, Error = never, Output = never>(
  ref: MachineRef<State, Event, Error, Output>
): Stream.Stream<RuntimeOutcome<State, Error, Output>> =>
  ref.changes.pipe(
    Stream.filter((snapshot) => snapshot.status !== "active"),
    Stream.map((snapshot) => classifyOutcome(snapshot)!),
    Stream.take(1)
  )

interface ProcessRuntime {
  readonly nextSessionId: Effect.Effect<string>
}

const makeProcessRuntime: Effect.Effect<ProcessRuntime> = Effect.sync(() => {
  let sessionIdCounter = 0
  return {
    nextSessionId: Effect.sync(() => `machine:${sessionIdCounter++}`)
  }
})

interface StartInternalOptions {
  readonly detached?: boolean
  readonly id?: string
  readonly onOutcome?: (outcome: RuntimeOutcome<any, any, any>) => Effect.Effect<void>
  readonly onSnapshot?: (
    snapshot: Extract<RuntimeSnapshot<any, any, any>, { readonly status: "active" }>
  ) => Effect.Effect<void>
  readonly onReady?: (
    ref: MachineRef<any, any, any, any>,
    requestStop: Effect.Effect<void>
  ) => Effect.Effect<void>
  readonly onStop?: Effect.Effect<void>
  readonly parent?: ProcessAddress<unknown>
  readonly runtime: ProcessRuntime
  readonly sendParent?: (event: unknown) => Effect.Effect<void, StoppedError>
}

interface ChildRuntime {
  readonly close: <A, E>(exit: Exit.Exit<A, E>) => Effect.Effect<void>
  readonly spawn: ProcessSpawn
  readonly get: <ChildState, ChildEvent, ChildError, ChildOutput>(
    child: ChildSelector
  ) => Effect.Effect<Option.Option<MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>>>
  readonly changes: <ChildState, ChildEvent, ChildError, ChildOutput>(
    child: ChildSelector
  ) => Stream.Stream<Option.Option<MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>>>
  readonly sendTo: (child: ChildSelector, event: unknown) => Effect.Effect<void, StoppedError>
  readonly stop: (child: ChildSelector) => Effect.Effect<void>
}

const noChildChanges = Stream.succeed(Option.none()).pipe(Stream.concat(Stream.never))
const noParentSend = (_event: unknown): Effect.Effect<void, StoppedError> => Effect.void

const childlessRuntime: ChildRuntime = {
  close: () => Effect.void,
  spawn: (() => Effect.die(new Error("Childless machine logic cannot spawn a process"))) as ProcessSpawn,
  get: () => Effect.succeed(Option.none()),
  changes: () => noChildChanges,
  sendTo: () => Effect.void,
  stop: () => Effect.void
}

const makeChildRuntime = (
  self: ProcessAddress<any>,
  runtime: ProcessRuntime
): Effect.Effect<ChildRuntime> =>
  Effect.sync(() => {
    // Child-registry decisions are synchronous and every access below runs in
    // one Effect.sync / Effect.suspend step. Keep the unobserved representation
    // compact; a replay PubSub is installed only when childChanges is used.
    const registry: ChildRegistry = {
      closed: false,
      revision: 0,
      children: new Map(),
      changes: undefined,
      scope: undefined
    }

    const snapshot = (registry: ChildRegistry): ChildRegistrySnapshot => ({
      closed: registry.closed,
      revision: registry.revision,
      children: new Map(registry.children)
    })

    const publishRegistryChange = (): void => {
      if (registry.changes !== undefined) {
        PubSub.publishUnsafe(registry.changes, snapshot(registry))
      }
    }

    const close = <A, E>(_exit: Exit.Exit<A, E>): Effect.Effect<void> =>
      Effect.sync(() => {
        if (registry.closed) {
          return undefined
        }
        registry.closed = true
        if (registry.scope === undefined) {
          return undefined
        }
        const children = Array.from(registry.children.values()).flatMap((entry) =>
          entry._tag === "Started" ? [entry.ref] : []
        )
        return { children, scope: registry.scope }
      }).pipe(
        Effect.flatMap((resources) =>
          resources === undefined
            ? Effect.void
            : Effect.all(
              [
                ...resources.children.map((child) => child.stop),
                ...(resources.scope === undefined ? [] : [Scope.close(resources.scope, _exit)])
              ],
              { concurrency: "unbounded", discard: true }
            )
        )
      )

    const getOrCreateScope: Effect.Effect<Scope.Closeable | undefined> = Effect.sync(() => {
      if (registry.closed) {
        return undefined
      }
      if (registry.scope === undefined) {
        registry.scope = Scope.makeUnsafe("parallel")
      }
      return registry.scope
    })

    const reserve = (
      key: ChildKey,
      token: symbol
    ): Effect.Effect<boolean, ChildAlreadyExistsError> =>
      Effect.suspend(() => {
        if (registry.closed) {
          return Effect.succeed(false)
        }
        if (typeof key === "string" && registry.children.has(key)) {
          return Effect.fail(new ChildAlreadyExistsError({ id: key }))
        }
        registry.children.set(key, { _tag: "Starting", token })
        return Effect.succeed(true)
      })

    const unregister = (
      key: ChildKey,
      token: symbol
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const entry = registry.children.get(key)
        if (entry === undefined || entry.token !== token) {
          return
        }
        const observable = typeof key === "string"
        if (observable) {
          registry.revision += 1
        }
        registry.children.delete(key)
        if (observable) {
          publishRegistryChange()
        }
      })

    const register = (
      key: ChildKey,
      token: symbol,
      ref: MachineRef<any, any, any, any>,
      descriptor: ChildDescriptor | undefined
    ): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const entry = registry.children.get(key)
        if (
          registry.closed ||
          entry === undefined ||
          entry._tag !== "Starting" ||
          entry.token !== token
        ) {
          return false
        }
        const observable = typeof key === "string"
        if (observable) {
          registry.revision += 1
        }
        registry.children.delete(key)
        registry.children.set(key, { _tag: "Started", token, descriptor, ref })
        if (observable) {
          publishRegistryChange()
        }
        return true
      })

    const matches = (
      entry: ChildEntry,
      child: ChildSelector
    ): entry is Extract<ChildEntry, { readonly _tag: "Started" }> =>
      entry._tag === "Started" && (typeof child === "string" || (
        entry.descriptor !== undefined &&
        entry.descriptor.id === child.id &&
        entry.descriptor.machine === child.machine
      ))

    const get: ChildRuntime["get"] = (child) => {
      const id = typeof child === "string" ? child : child.id
      return Effect.sync(() => {
        if (registry.closed) {
          return Option.none()
        }
        const entry = registry.children.get(id)
        return entry !== undefined && matches(entry, child)
          ? Option.some(entry.ref)
          : Option.none()
      })
    }

    const changes: ChildRuntime["changes"] = (child) => {
      const id = typeof child === "string" ? child : child.id
      return Stream.unwrap(
        Effect.suspend(() => {
          if (registry.closed) {
            return Effect.succeed(undefined)
          }
          if (registry.changes !== undefined) {
            return Effect.succeed(registry.changes)
          }
          return PubSub.unbounded<ChildRegistrySnapshot>({ replay: 1 }).pipe(
            Effect.flatMap((candidate) =>
              Effect.sync(() => {
                if (registry.closed) {
                  return [undefined, true] as const
                }
                if (registry.changes !== undefined) {
                  return [registry.changes, true] as const
                }
                registry.changes = candidate
                PubSub.publishUnsafe(candidate, snapshot(registry))
                return [candidate, false] as const
              }).pipe(
                Effect.flatMap(([changes, discardCandidate]) =>
                  discardCandidate
                    ? PubSub.shutdown(candidate).pipe(Effect.as(changes))
                    : Effect.succeed(changes)
                )
              )
            )
          )
        }).pipe(
          Effect.flatMap((changes) => {
            if (changes === undefined) {
              return Effect.succeed(noChildChanges)
            }
            const select = (registry: ChildRegistrySnapshot) => {
              if (registry.closed) {
                return Option.none()
              }
              const entry = registry.children.get(id)
              return entry !== undefined && matches(entry, child)
                ? Option.some(entry.ref)
                : Option.none()
            }
            return Effect.succeed(Stream.fromPubSub(changes).pipe(Stream.map(select)))
          })
        )
      )
    }

    const sendTo = (child: ChildSelector, event: unknown): Effect.Effect<void, StoppedError> => {
      const id = typeof child === "string" ? child : child.id
      return Effect.suspend(() => {
        if (registry.closed) {
          return Effect.void
        }
        const entry = registry.children.get(id)
        return entry !== undefined && matches(entry, child)
          ? entry.ref.send(event)
          : Effect.void
      })
    }

    const stop = (child: ChildSelector): Effect.Effect<void> => {
      const id = typeof child === "string" ? child : child.id
      return Effect.suspend(() => {
        if (registry.closed) {
          return Effect.void
        }
        const entry = registry.children.get(id)
        return entry !== undefined && matches(entry, child)
          ? entry.ref.stop
          : Effect.void
      })
    }

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
        readonly onOutcome?: (
          outcome: RuntimeOutcome<ChildState, ChildError, ChildOutput>
        ) => Effect.Effect<void>
        readonly [activeSnapshotObserver]?: (
          snapshot: Extract<RuntimeSnapshot<ChildState, ChildError, ChildOutput>, { readonly status: "active" }>
        ) => Effect.Effect<void>
        readonly [sendParentOverride]?: (event: unknown) => Effect.Effect<void, StoppedError>
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
        readonly onOutcome?: (
          outcome: RuntimeOutcome<ChildState, ChildError, ChildOutput>
        ) => Effect.Effect<void>
        readonly [activeSnapshotObserver]?: (
          snapshot: Extract<RuntimeSnapshot<ChildState, ChildError, ChildOutput>, { readonly status: "active" }>
        ) => Effect.Effect<void>
        readonly [sendParentOverride]?: (event: unknown) => Effect.Effect<void, StoppedError>
      }
    ): Effect.Effect<
      MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
      ChildAlreadyExistsError | ChildInitialError,
      Exclude<ChildRequirements, Scope.Scope>
    > {
      const token = Symbol()
      const key = spawnOptions?.id ?? token
      let startedChild: MachineRef<any, any, any, any> | undefined
      return getOrCreateScope.pipe(
        Effect.flatMap((childScope) =>
          childScope === undefined
            ? Effect.interrupt
            : Effect.gen(function*() {
              const reserved = yield* reserve(key, token)
              if (!reserved) {
                return yield* Effect.interrupt
              }
              return yield* startLogicInternal(logic, {
                detached: true,
                ...(spawnOptions?.id === undefined ? undefined : { id: spawnOptions.id }),
                ...(spawnOptions?.onOutcome === undefined ? undefined : { onOutcome: spawnOptions.onOutcome }),
                ...(spawnOptions?.[activeSnapshotObserver] === undefined
                  ? undefined
                  : { onSnapshot: spawnOptions[activeSnapshotObserver] }),
                ...(spawnOptions?.[sendParentOverride] === undefined
                  ? undefined
                  : { sendParent: spawnOptions[sendParentOverride] }),
                onReady: (child, requestChildStop) =>
                  Effect.sync(() => {
                    startedChild = child
                  }).pipe(
                    Effect.andThen(register(key, token, child, spawnOptions?.descriptor)),
                    Effect.flatMap((registered) => registered ? Effect.void : requestChildStop)
                  ),
                onStop: unregister(key, token),
                parent: self,
                runtime
              }).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? unregister(key, token).pipe(
                      Effect.andThen(startedChild === undefined ? Effect.void : startedChild.stop)
                    )
                    : Effect.void
                )
              )
            }).pipe(Scope.provide(childScope))
        )
      ) as Effect.Effect<
        MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
        ChildAlreadyExistsError | ChildInitialError,
        Exclude<ChildRequirements, Scope.Scope>
      >
    }

    return { close, spawn, get, changes, sendTo, stop }
  })

// `Machine.logic` permits an arbitrary Effect program, including programs that
// suspend or supervise their own fibers. Keep its two-fiber worker/supervisor
// protocol as the general contract rather than weakening it for statecharts.
const startGenericInternal: <
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
  const {
    detached,
    id: requestedId,
    onOutcome,
    onReady,
    onSnapshot,
    onStop,
    parent,
    runtime,
    sendParent: overrideSendParent
  } = options
  type ProcessTermination =
    | { readonly _tag: "Stopped" }
    | { readonly _tag: "Done"; readonly output: Output }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<Error> }

  const sessionId = yield* runtime.nextSessionId
  const id = requestedId ?? sessionId
  const queue = yield* Queue.unbounded<Event>()
  const termination = yield* Deferred.make<ProcessTermination>()
  const done = yield* Deferred.make<Output, Error | StoppedError>()
  const awaitCompletion = Deferred.await(done).pipe(Effect.exit, Effect.asVoid)
  let initializing = true
  const requestStop = Deferred.succeed(termination, { _tag: "Stopped" }).pipe(Effect.asVoid)
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

  let {
    changes: childChanges,
    close: closeChildren,
    get: getChild,
    sendTo,
    spawn,
    stop: stopChild
  } = childlessRuntime
  if (logic[childlessProcess] !== true) {
    ;({
      changes: childChanges,
      close: closeChildren,
      get: getChild,
      sendTo,
      spawn,
      stop: stopChild
    } = yield* makeChildRuntime(self, runtime))
  }
  const cleanupStartupFailure = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> =>
    Exit.isFailure(exit)
      ? closeChildren(exit)
      : Effect.void
  const cleanup = onStop ?? Effect.void
  const sendParent = overrideSendParent ?? (parent === undefined ? noParentSend : parent.send)

  const scope: ProcessScope<Event> = {
    self,
    parent,
    spawn,
    sendParent,
    sendTo,
    stopChild,
    failCause: (cause) =>
      Deferred.succeed(termination, {
        _tag: "Failure",
        cause: cause as Cause.Cause<Error>
      }).pipe(Effect.asVoid)
  }

  const initial = yield* logic.initial(scope).pipe(
    Effect.onExit(cleanupStartupFailure),
    Effect.ensuring(Effect.sync(() => {
      initializing = false
    }))
  )
  const current = yield* SynchronizedRef.make<VersionedSnapshot<State, Error, Output>>({
    revision: 0,
    terminalizing: false,
    changes: undefined,
    snapshot: {
      status: "active",
      state: initial
    }
  })
  const publishSnapshot: (
    snapshot: VersionedSnapshot<State, Error, Output>
  ) => Effect.Effect<VersionedSnapshot<State, Error, Output>> = onSnapshot === undefined
    ? (snapshot) =>
      snapshot.changes === undefined
        ? Effect.succeed(snapshot)
        : PubSub.publish(snapshot.changes, [snapshot] as const).pipe(Effect.as(snapshot))
    : (snapshot) => {
      const publish = snapshot.changes === undefined
        ? Effect.succeed(snapshot)
        : PubSub.publish(snapshot.changes, [snapshot] as const).pipe(Effect.as(snapshot))
      const runtimeSnapshot = snapshot.snapshot
      return runtimeSnapshot.status !== "active"
        ? publish
        : publish.pipe(Effect.tap(() => notifyActiveSnapshot(onSnapshot, runtimeSnapshot)))
    }

  const completeChanges = (
    snapshot: VersionedSnapshot<State, Error, Output>
  ): Effect.Effect<void> =>
    snapshot.changes === undefined
      ? Effect.void
      : PubSub.publish(snapshot.changes, Exit.succeed<void>(undefined)).pipe(Effect.asVoid)

  const completeIfTerminal = (
    snapshot: VersionedSnapshot<State, Error, Output>
  ): Effect.Effect<VersionedSnapshot<State, Error, Output>> => {
    if (snapshot.snapshot.status === "active") {
      return Effect.succeed(snapshot)
    }
    return completeChanges(snapshot).pipe(Effect.as(snapshot))
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
        current.terminalizing
          ? Effect.succeed([undefined, current] as const)
          : Effect.map(
            f(current.snapshot),
            (next) => {
              if (next === undefined) {
                return [undefined, current] as const
              }
              const versioned = {
                revision: current.revision + 1,
                snapshot: next,
                terminalizing: false,
                changes: current.changes
              }
              return [versioned, versioned] as const
            }
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
    SynchronizedRef.modify(
      current,
      (current): SnapshotModification => {
        if (current.terminalizing || current.snapshot.status !== "active") {
          return [undefined, current]
        }
        return [
          {
            revision: current.revision + 1,
            snapshot: f(current.snapshot),
            terminalizing: true,
            changes: current.changes
          },
          { ...current, terminalizing: true }
        ]
      }
    ).pipe(Effect.map((versioned) => versioned?.snapshot))

  const setAndPublishSnapshot = (
    snapshot: RuntimeSnapshot<State, Error, Output>
  ): Effect.Effect<void> =>
    SynchronizedRef.updateAndGet(current, (current) => ({
      revision: current.revision + 1,
      snapshot,
      terminalizing: true,
      changes: current.changes
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
  ): Effect.Effect<void> => {
    const notifyOutcome = onOutcome === undefined
      ? Effect.void
      : Effect.suspend(() => onOutcome(classifyOutcome(snapshot)!)).pipe(
        Effect.exit,
        Effect.asVoid
      )
    return Effect.uninterruptible(
      Queue.shutdown(queue).pipe(
        Effect.andThen(closeChildren(exit)),
        Effect.andThen(setAndPublishSnapshot(snapshot)),
        Effect.andThen(notifyOutcome),
        Effect.andThen(cleanup),
        Effect.andThen(completeDone)
      )
    )
  }

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

  const stop: Effect.Effect<void> = Effect.uninterruptible(
    requestStop.pipe(Effect.andThen(awaitCompletion))
  )

  const context: ProcessContext<State, Event> = {
    ...scope,
    receive: Queue.take(queue),
    mailbox: queue,
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

  const getOrCreateChanges = SynchronizedRef.modifyEffect(
    current,
    (current) => {
      if (current.snapshot.status !== "active") {
        return Effect.succeed([undefined, current] as const)
      }
      if (current.changes !== undefined) {
        return Effect.succeed([current.changes, current] as const)
      }
      return PubSub.unbounded<Take.Take<VersionedSnapshot<State, Error, Output>>>({ replay: 1 }).pipe(
        Effect.map((changes) => [changes, { ...current, changes }] as const)
      )
    }
  )

  const changesStream: Stream.Stream<RuntimeSnapshot<State, Error, Output>> = Stream.unwrap(
    Effect.gen(function*() {
      const changes = yield* getOrCreateChanges
      if (changes === undefined) {
        return Stream.succeed((yield* SynchronizedRef.get(current)).snapshot)
      }
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

  if (onReady !== undefined) {
    yield* onReady(ref, requestStop)
  }
  if (onSnapshot !== undefined) {
    yield* notifyActiveSnapshot(onSnapshot, { status: "active", state: initial })
  }

  const reserveTermination = (termination: ProcessTermination) => {
    switch (termination._tag) {
      case "Stopped":
        return reserveStoppedSnapshot
      case "Done":
        return reserveSuccessSnapshot(termination.output)
      case "Failure":
        return reserveFailureSnapshot(termination.cause)
    }
  }

  const completeTermination = (
    termination: ProcessTermination,
    snapshot: RuntimeSnapshot<State, Error, Output>
  ) => {
    switch (termination._tag) {
      case "Stopped":
        return terminalizeReservedStop(snapshot)
      case "Done":
        return terminalizeReservedSuccess(snapshot, termination.output)
      case "Failure":
        return terminalizeReservedFailure(snapshot, termination.cause)
    }
  }

  const forkRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    detached === true
      ? Effect.forkDetach(effect)
      : Effect.forkChild(effect)

  const pendingTermination = yield* Deferred.poll(termination)
  const worker = Option.isNone(pendingTermination)
    ? yield* Effect.uninterruptibleMask((restore) =>
      restore(Effect.suspend(() => logic.run(context))).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Deferred.succeed(
            termination,
            Exit.isFailure(exit)
              ? { _tag: "Failure", cause: exit.cause }
              : { _tag: "Done", output: exit.value }
          )
        )
      )
    ).pipe(forkRuntime)
    : undefined

  // One Deferred arbitrates all terminal causes. The supervisor reserves the
  // terminal snapshot before interrupting the worker, so worker finalizers
  // cannot mutate the frozen state. It then waits for those finalizers before
  // publishing and completing `join` / `stop`.
  const runFiber: Effect.Effect<void, never, Requirements> = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      const requested = Option.isSome(pendingTermination)
        ? yield* pendingTermination.value
        : yield* restore(Deferred.await(termination))

      const snapshot = yield* reserveTermination(requested)
      if (worker !== undefined) {
        yield* Fiber.interrupt(worker)
      }
      if (snapshot === undefined) {
        return yield* awaitCompletion
      }
      return yield* completeTermination(requested, snapshot)
    })
  )

  yield* forkRuntime(runFiber)
  yield* Effect.yieldNow

  return ref
})

// Compiled statecharts have a bounded runtime shape. Their optional `drain`
// protocol lets a fiber own event processing and terminal publication only
// while work exists; custom process logic keeps the persistent `run` contract.
const startCompiledInternal: <
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
  const {
    detached,
    id: requestedId,
    onOutcome,
    onReady,
    onSnapshot,
    onStop,
    parent,
    runtime,
    sendParent: overrideSendParent
  } = options
  type ProcessTermination =
    | { readonly _tag: "Stopped" }
    | { readonly _tag: "Done"; readonly output: Output }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<Error> }

  const sessionId = yield* runtime.nextSessionId
  const id = requestedId ?? sessionId
  const onDemand = logic.drain !== undefined
  const queue = onDemand ? undefined : yield* Queue.unbounded<Event>()
  // An on-demand drain never blocks on mailbox input: send schedules its owner
  // whenever the FIFO becomes non-empty. Keep persistent custom processes on
  // Queue, but avoid retaining Queue's waiting/backpressure machinery for the
  // compiled protocol that only needs synchronous offer and poll operations.
  const compactMailbox: CompactProcessMailbox<Event> | undefined = onDemand
    ? { items: undefined, index: 0, closed: false }
    : undefined
  const poll = compactMailbox === undefined
    ? Queue.poll(queue!)
    : Effect.sync(() => pollCompactMailbox(compactMailbox))
  const shutdownMailbox = compactMailbox === undefined
    ? Queue.shutdown(queue!)
    : Effect.sync(() => closeCompactMailbox(compactMailbox))
  const done = yield* Deferred.make<Output, Error | StoppedError>()
  const awaitCompletion = Deferred.await(done).pipe(Effect.exit, Effect.asVoid)
  const drainServices = onDemand ? yield* Effect.context<Requirements>() : undefined
  let worker: Fiber.Fiber<any, never> | undefined
  let draining = false
  let offerRevision = 0
  let interruptRequested = false
  let requestedTermination: ProcessTermination | undefined
  let reservedTerminationSnapshot: RuntimeSnapshot<State, Error, Output> | undefined
  let reserveRequestedTermination:
    | ((requested: ProcessTermination) => RuntimeSnapshot<State, Error, Output> | undefined)
    | undefined
  // A compiled process never suspends waiting for a terminal request: its
  // active drain owns completion, while stop/failure either interrupts that
  // owner or terminalizes an idle drain directly. An owner-local cell can
  // therefore arbitrate the first request atomically without retaining a
  // second Deferred in every compiled machine.
  const requestRuntimeTermination = (requested: ProcessTermination): Effect.Effect<boolean> =>
    Effect.sync(() => {
      if (requestedTermination !== undefined) {
        return false
      }
      requestedTermination = requested
      reservedTerminationSnapshot = reserveRequestedTermination?.(requested)
      return true
    })
  let sendEvent = compactMailbox !== undefined
    ? (event: Event): Effect.Effect<void, StoppedError> => Effect.sync(() => offerCompactMailbox(compactMailbox, event))
    : (event: Event): Effect.Effect<void, StoppedError> =>
      Queue.offer(queue!, event).pipe(
        Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(new StoppedError()))
      )
  let settleRequestedTermination = (_requested: ProcessTermination): Effect.Effect<void> => Effect.void
  const interruptWorker: Effect.Effect<void> = Effect.suspend(() =>
    worker === undefined
      ? onDemand
        ? Effect.sync(() => {
          interruptRequested = true
        })
        : Effect.void
      : Fiber.interrupt(worker)
  )
  let initializing = true
  const requestStop = requestRuntimeTermination({ _tag: "Stopped" }).pipe(Effect.asVoid)
  const self: ProcessAddress<Event> = {
    id,
    sessionId,
    // Initialization must finish constructing a state before a stopped
    // snapshot can be published. A stop requested there is therefore recorded
    // and returns so initialization can finish. Once running, a compiled
    // process owns terminalization in this fiber, so self-stop interrupts it
    // directly after atomically freezing the active snapshot.
    stop: Effect.suspend(() => {
      if (initializing) {
        return requestStop
      }
      return requestRuntimeTermination({ _tag: "Stopped" }).pipe(Effect.andThen(Effect.interrupt))
    }),
    send: (event: Event) => Effect.suspend(() => sendEvent(event))
  }

  let {
    changes: childChanges,
    close: closeChildren,
    get: getChild,
    sendTo,
    spawn,
    stop: stopChild
  } = childlessRuntime
  if (logic[childlessProcess] !== true) {
    ;({
      changes: childChanges,
      close: closeChildren,
      get: getChild,
      sendTo,
      spawn,
      stop: stopChild
    } = yield* makeChildRuntime(self, runtime))
  }
  const cleanupStartupFailure = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> =>
    Exit.isFailure(exit)
      ? closeChildren(exit)
      : Effect.void
  const cleanup = onStop ?? Effect.void
  const sendParent = overrideSendParent ?? (parent === undefined ? noParentSend : parent.send)

  const scope: ProcessScope<Event> = {
    self,
    parent,
    spawn,
    sendParent,
    sendTo,
    stopChild,
    failCause: (cause) => {
      const requested = {
        _tag: "Failure",
        cause: cause as Cause.Cause<Error>
      } as const
      return requestRuntimeTermination(requested).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.forkDetach(settleRequestedTermination(requested)).pipe(Effect.asVoid)
            : Effect.void
        )
      )
    }
  }

  const initial = yield* logic.initial(scope).pipe(
    Effect.onExit(cleanupStartupFailure),
    Effect.ensuring(Effect.sync(() => {
      initializing = false
    }))
  )
  // Compiled drains have one active-state writer. MutableRef operations run in
  // synchronous Effect steps, so external terminal reservation and lazy
  // observer installation still arbitrate atomically without retaining a
  // semaphore per process. Effectful custom updates validate the revision
  // again before committing across their asynchronous boundary.
  const current = MutableRef.make<VersionedSnapshot<State, Error, Output>>({
    revision: 0,
    terminalizing: false,
    changes: undefined,
    snapshot: {
      status: "active",
      state: initial
    }
  })
  const getCurrent = Effect.sync(() => MutableRef.get(current))
  const publishSnapshot: (
    snapshot: VersionedSnapshot<State, Error, Output>
  ) => Effect.Effect<VersionedSnapshot<State, Error, Output>> = onSnapshot === undefined
    ? (snapshot) =>
      snapshot.changes === undefined
        ? Effect.succeed(snapshot)
        : PubSub.publish(snapshot.changes, [snapshot] as const).pipe(Effect.as(snapshot))
    : (snapshot) => {
      const publish = snapshot.changes === undefined
        ? Effect.succeed(snapshot)
        : PubSub.publish(snapshot.changes, [snapshot] as const).pipe(Effect.as(snapshot))
      const runtimeSnapshot = snapshot.snapshot
      return runtimeSnapshot.status !== "active"
        ? publish
        : publish.pipe(Effect.tap(() => notifyActiveSnapshot(onSnapshot, runtimeSnapshot)))
    }

  const completeChanges = (
    snapshot: VersionedSnapshot<State, Error, Output>
  ): Effect.Effect<void> =>
    snapshot.changes === undefined
      ? Effect.void
      : PubSub.publish(snapshot.changes, Exit.succeed<void>(undefined)).pipe(Effect.asVoid)

  const completeIfTerminal = (
    snapshot: VersionedSnapshot<State, Error, Output>
  ): Effect.Effect<VersionedSnapshot<State, Error, Output>> => {
    if (snapshot.snapshot.status === "active") {
      return Effect.succeed(snapshot)
    }
    return completeChanges(snapshot).pipe(Effect.as(snapshot))
  }

  const publishIfCurrent = (
    snapshot: VersionedSnapshot<State, Error, Output>
  ): Effect.Effect<VersionedSnapshot<State, Error, Output> | undefined> =>
    getCurrent.pipe(
      Effect.flatMap((
        currentSnapshot
      ): Effect.Effect<VersionedSnapshot<State, Error, Output> | undefined> =>
        currentSnapshot.revision === snapshot.revision
          ? publishSnapshot(snapshot).pipe(Effect.flatMap(completeIfTerminal))
          : Effect.succeed(undefined)
      )
    )

  const updateSnapshot = <E2, R2>(
    f: (
      snapshot: RuntimeSnapshot<State, Error, Output>
    ) => Effect.Effect<RuntimeSnapshot<State, Error, Output> | undefined, E2, R2>
  ): Effect.Effect<RuntimeSnapshot<State, Error, Output> | undefined, E2, R2> =>
    Effect.suspend(() => {
      const observed = MutableRef.get(current)
      if (observed.terminalizing) {
        return Effect.succeed(undefined)
      }
      return f(observed.snapshot).pipe(
        Effect.flatMap((next) =>
          Effect.sync(() => {
            const latest = MutableRef.get(current)
            if (next === undefined || latest.terminalizing || latest.revision !== observed.revision) {
              return undefined
            }
            const versioned = {
              revision: latest.revision + 1,
              snapshot: next,
              terminalizing: false,
              changes: latest.changes
            }
            MutableRef.set(current, versioned)
            return versioned
          })
        ),
        Effect.flatMap((versioned) =>
          versioned === undefined ? Effect.succeed(undefined) : publishIfCurrent(versioned)
        ),
        Effect.map((published) => published?.snapshot)
      )
    })

  const setActiveState = (state: State) =>
    Effect.sync(() => {
      const latest = MutableRef.get(current)
      if (latest.terminalizing || latest.snapshot.status !== "active") {
        return undefined
      }
      const versioned = {
        revision: latest.revision + 1,
        snapshot: { status: "active" as const, state },
        terminalizing: false,
        changes: latest.changes
      }
      MutableRef.set(current, versioned)
      return versioned
    }).pipe(
      Effect.flatMap((versioned) => versioned === undefined ? Effect.succeed(undefined) : publishIfCurrent(versioned)),
      Effect.asVoid
    )

  const setAndPublishSnapshot = (
    snapshot: RuntimeSnapshot<State, Error, Output>
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      const latest = MutableRef.get(current)
      const versioned = {
        revision: latest.revision + 1,
        snapshot,
        terminalizing: true,
        changes: latest.changes
      }
      MutableRef.set(current, versioned)
      return versioned
    }).pipe(
      Effect.flatMap(publishSnapshot),
      Effect.flatMap(completeIfTerminal),
      Effect.asVoid
    )

  const terminalizeWith = (
    snapshot: RuntimeSnapshot<State, Error, Output>,
    exit: Exit.Exit<unknown, unknown>,
    completeDone: Effect.Effect<void>
  ): Effect.Effect<void> => {
    const notifyOutcome = onOutcome === undefined
      ? Effect.void
      : Effect.suspend(() => onOutcome(classifyOutcome(snapshot)!)).pipe(
        Effect.exit,
        Effect.asVoid
      )
    return Effect.uninterruptible(
      shutdownMailbox.pipe(
        Effect.andThen(closeChildren(exit)),
        Effect.andThen(setAndPublishSnapshot(snapshot)),
        Effect.andThen(notifyOutcome),
        Effect.andThen(cleanup),
        Effect.andThen(completeDone)
      )
    )
  }

  reserveRequestedTermination = (termination) => {
    const latest = MutableRef.get(current)
    if (latest.terminalizing || latest.snapshot.status !== "active") {
      return undefined
    }
    const snapshot: RuntimeSnapshot<State, Error, Output> = termination._tag === "Stopped"
      ? { status: "stopped", state: latest.snapshot.state }
      : termination._tag === "Done"
      ? { status: "done", state: latest.snapshot.state, output: termination.output }
      : { status: "error", state: latest.snapshot.state, cause: termination.cause }
    MutableRef.set(current, { ...latest, terminalizing: true })
    return snapshot
  }

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

  const reserveTermination = (termination: ProcessTermination) =>
    Effect.sync(() => reserveRequestedTermination!(termination))

  const completeTermination = (
    termination: ProcessTermination,
    snapshot: RuntimeSnapshot<State, Error, Output>
  ) => {
    switch (termination._tag) {
      case "Stopped":
        return terminalizeReservedStop(snapshot)
      case "Done":
        return terminalizeReservedSuccess(snapshot, termination.output)
      case "Failure":
        return terminalizeReservedFailure(snapshot, termination.cause)
    }
  }

  const finishRequestedTermination = (requested: ProcessTermination): Effect.Effect<void> =>
    Effect.gen(function*() {
      const snapshot = reservedTerminationSnapshot ?? (yield* reserveTermination(requested))
      if (snapshot === undefined) {
        return yield* awaitCompletion
      }
      return yield* completeTermination(requested, snapshot)
    })

  settleRequestedTermination = (requested) =>
    Effect.suspend(() =>
      onDemand && !draining
        ? finishRequestedTermination(requested)
        : interruptWorker.pipe(Effect.andThen(awaitCompletion))
    )

  const stop: Effect.Effect<void> = Effect.uninterruptible(
    Effect.suspend(() => {
      const requested = { _tag: "Stopped" } as const
      return requestRuntimeTermination(requested).pipe(
        Effect.flatMap((accepted) => accepted ? settleRequestedTermination(requested) : awaitCompletion)
      )
    })
  )

  const context: ProcessContext<State, Event> = {
    ...scope,
    receive: queue === undefined ? Effect.never : Queue.take(queue),
    poll,
    state: getCurrent.pipe(Effect.map((current) => current.snapshot.state)),
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

  const getOrCreateChanges = Effect.suspend(() => {
    const observed = MutableRef.get(current)
    if (observed.snapshot.status !== "active") {
      return Effect.succeed(undefined)
    }
    if (observed.changes !== undefined) {
      return Effect.succeed(observed.changes)
    }
    return PubSub.unbounded<Take.Take<VersionedSnapshot<State, Error, Output>>>({ replay: 1 }).pipe(
      Effect.flatMap((candidate) =>
        Effect.sync(() => {
          const latest = MutableRef.get(current)
          if (latest.snapshot.status !== "active") {
            return [undefined, true] as const
          }
          if (latest.changes !== undefined) {
            return [latest.changes, true] as const
          }
          MutableRef.set(current, { ...latest, changes: candidate })
          return [candidate, false] as const
        }).pipe(
          Effect.flatMap(([changes, discardCandidate]) =>
            discardCandidate
              ? PubSub.shutdown(candidate).pipe(Effect.as(changes))
              : Effect.succeed(changes)
          )
        )
      )
    )
  })

  const changesStream: Stream.Stream<RuntimeSnapshot<State, Error, Output>> = Stream.unwrap(
    Effect.gen(function*() {
      const changes = yield* getOrCreateChanges
      if (changes === undefined) {
        return Stream.succeed((yield* getCurrent).snapshot)
      }
      const subscription = yield* PubSub.subscribe(changes)
      const captured = yield* getCurrent
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
    state: getCurrent.pipe(Effect.map((current) => current.snapshot.state)),
    snapshot: getCurrent.pipe(Effect.map((current) => current.snapshot)),
    changes: changesStream,
    join: Deferred.await(done),
    stop,
    send: self.send,
    child: getChild,
    childChanges
  }

  if (onReady !== undefined) {
    yield* onReady(ref, requestStop)
  }
  if (onSnapshot !== undefined) {
    yield* notifyActiveSnapshot(onSnapshot, { status: "active", state: initial })
  }

  if (onDemand) {
    const drainRuntime: Effect.Effect<void, never, Requirements> = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        let observedRevision = offerRevision
        while (true) {
          if (requestedTermination !== undefined) {
            return yield* finishRequestedTermination(requestedTermination)
          }

          const exit = yield* restore(Effect.suspend(() => logic.drain!(context))).pipe(Effect.exit)
          if (Exit.isFailure(exit)) {
            const completed: ProcessTermination = { _tag: "Failure", cause: exit.cause }
            yield* requestRuntimeTermination(completed)
            return yield* finishRequestedTermination(requestedTermination!)
          }
          if (Option.isSome(exit.value)) {
            const completed: ProcessTermination = { _tag: "Done", output: exit.value.value }
            yield* requestRuntimeTermination(completed)
            return yield* finishRequestedTermination(requestedTermination!)
          }

          if (requestedTermination !== undefined) {
            return yield* finishRequestedTermination(requestedTermination)
          }

          const continueDraining = yield* Effect.sync(() => {
            if (offerRevision !== observedRevision) {
              observedRevision = offerRevision
              return true
            }
            draining = false
            worker = undefined
            return false
          })
          if (!continueDraining) {
            return
          }
        }
      })
    )

    const providedDrainRuntime = Effect.provideContext(drainRuntime, drainServices!)
    // Claim ownership before yielding so a concurrent stop can always find or
    // request interruption of this worker. The yield also keeps `send` as a
    // mailbox operation: user transition work never runs inline in the sender.
    const scheduledDrainRuntime = Effect.uninterruptible(
      Effect.yieldNow.pipe(Effect.andThen(providedDrainRuntime))
    )
    const forkDrain = detached === true
      ? Effect.forkDetach(scheduledDrainRuntime, { startImmediately: true })
      : Effect.forkChild(scheduledDrainRuntime, { startImmediately: true })

    sendEvent = (event) =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          if (compactMailbox!.closed || requestedTermination !== undefined) {
            return Effect.fail(new StoppedError())
          }
          offerCompactMailbox(compactMailbox!, event)
          offerRevision += 1
          if (draining) {
            return Effect.void
          }
          draining = true
          return forkDrain.pipe(
            Effect.flatMap((fiber) =>
              Effect.sync(() => {
                worker = fiber
                if (!interruptRequested) {
                  return false
                }
                interruptRequested = false
                return true
              }).pipe(
                Effect.flatMap((interrupt) => interrupt ? Fiber.interrupt(fiber) : Effect.void)
              )
            )
          )
        })
      )

    draining = true
    yield* providedDrainRuntime
    return ref
  }

  const pendingTermination = requestedTermination
  const compiledRuntime: Effect.Effect<void, never, Requirements> = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      let requested: ProcessTermination
      if (pendingTermination !== undefined) {
        requested = pendingTermination
      } else {
        const exit = yield* restore(Effect.suspend(() => logic.run(context))).pipe(Effect.exit)
        const completed: ProcessTermination = Exit.isFailure(exit)
          ? { _tag: "Failure", cause: exit.cause }
          : { _tag: "Done", output: exit.value }
        yield* requestRuntimeTermination(completed)
        requested = requestedTermination!
      }

      const snapshot = reservedTerminationSnapshot ?? (yield* reserveTermination(requested))
      if (snapshot === undefined) {
        return yield* awaitCompletion
      }
      return yield* completeTermination(requested, snapshot)
    })
  )

  worker = yield* (detached === true
    ? Effect.forkDetach(compiledRuntime, { startImmediately: true })
    : Effect.forkChild(compiledRuntime, { startImmediately: true }))
  return ref
})

const startLogicInternal: typeof startGenericInternal = ((
  logic: ProcessLogic<any, any, any, any, any, any>,
  options: StartInternalOptions
) =>
  logic[compiledProcess] === true
    ? startCompiledInternal(logic, options)
    : startGenericInternal(logic, options)) as typeof startGenericInternal

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
  return yield* startLogicInternal(
    logic,
    options === undefined
      ? {
        detached: true,
        runtime
      }
      : {
        ...options,
        detached: true,
        runtime
      }
  )
})
