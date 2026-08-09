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
    readonly ownerKey?: string
    readonly ownerPath?: string
    ownerActive?: boolean
  }
  | {
    readonly _tag: "Started"
    readonly token: symbol
    readonly descriptor: ChildDescriptor | undefined
    readonly ref: MachineRef<any, any, any, any>
    readonly ownerKey?: string
    readonly ownerPath?: string
    ownerActive?: boolean
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
export const compiledProcessDrain: unique symbol = Symbol.for("effect/Machine/compiledProcessDrain")

/** @internal */
export const compiledProcessInitial: unique symbol = Symbol.for("effect/Machine/compiledProcessInitial")

/** @internal */
export const sendParentOverride: unique symbol = Symbol.for("effect/Machine/sendParentOverride")

type ChildObservation = Option.Option<MachineRef<any, any, any, any>>
type ChildObservationBatch = [ChildObservation, ...Array<ChildObservation>]

interface ChildObserver {
  readonly child: ChildSelector
  readonly id: string
  values: ChildObservationBatch | undefined
  waiter: Deferred.Deferred<void> | undefined
}

const offerChildObservation = (
  observer: ChildObserver,
  value: ChildObservation
): void => {
  if (observer.values === undefined) {
    observer.values = [value]
  } else {
    observer.values.push(value)
  }
  if (observer.waiter !== undefined) {
    const waiter = observer.waiter
    observer.waiter = undefined
    Deferred.doneUnsafe(waiter, Effect.void)
  }
}

const takeChildObservations = (
  observer: ChildObserver
): Effect.Effect<ChildObservationBatch> =>
  Effect.suspend(() => {
    if (observer.values !== undefined) {
      const values = observer.values
      observer.values = undefined
      return Effect.succeed(values)
    }
    const waiter = Deferred.makeUnsafe<void>()
    observer.waiter = waiter
    return Deferred.await(waiter).pipe(Effect.andThen(takeChildObservations(observer)))
  })

interface ChildRegistry {
  closed: boolean
  readonly children: Map<ChildKey, ChildEntry>
  observers: Set<ChildObserver> | undefined
  scope: Scope.Closeable | undefined
}

const matchesChild = (
  entry: ChildEntry,
  child: ChildSelector
): entry is Extract<ChildEntry, { readonly _tag: "Started" }> =>
  entry._tag === "Started" && (typeof child === "string" || (
    entry.descriptor !== undefined &&
    entry.descriptor.id === child.id &&
    entry.descriptor.machine === child.machine
  ))

const selectRegistryChild = (
  registry: ChildRegistry,
  id: string,
  child: ChildSelector
): ChildObservation => {
  if (registry.closed) return Option.none()
  const entry = registry.children.get(id)
  return entry !== undefined && matchesChild(entry, child) ? Option.some(entry.ref) : Option.none()
}

const publishRegistryChange = (registry: ChildRegistry): void => {
  if (registry.observers === undefined) return
  for (const observer of registry.observers) {
    offerChildObservation(observer, selectRegistryChild(registry, observer.id, observer.child))
  }
}

const unregisterChild = (registry: ChildRegistry, key: ChildKey, token: symbol): void => {
  const entry = registry.children.get(key)
  if (entry === undefined || entry.token !== token) return
  registry.children.delete(key)
  if (typeof key === "string") publishRegistryChange(registry)
}

const registerChild = (
  registry: ChildRegistry,
  key: ChildKey,
  token: symbol,
  ref: MachineRef<any, any, any, any>,
  descriptor: ChildDescriptor | undefined
): boolean => {
  const entry = registry.children.get(key)
  if (registry.closed || entry === undefined || entry._tag !== "Starting" || entry.token !== token) {
    return false
  }
  registry.children.delete(key)
  const started: ChildEntry = entry.ownerKey === undefined
    ? { _tag: "Started", token, descriptor, ref }
    : {
      _tag: "Started",
      token,
      descriptor,
      ref,
      ownerKey: entry.ownerKey,
      ownerPath: entry.ownerPath!,
      ownerActive: entry.ownerActive === true
    }
  registry.children.set(key, started)
  if (typeof key === "string") publishRegistryChange(registry)
  return true
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
  /** Compiled drains retain one non-empty publication chunk until their next Effect boundary. */
  pendingChanges?: VersionedSnapshotBatch<State, Error, Output> | undefined
}

type VersionedSnapshotBatch<State, Error, Output> = [
  VersionedSnapshot<State, Error, Output>,
  ...Array<VersionedSnapshot<State, Error, Output>>
]

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

/**
 * Owner-local execution context for compiled statecharts.
 *
 * Unlike `ProcessContext`, synchronous mailbox and state operations do not
 * introduce an Effect boundary. The compiled drain still returns an Effect so
 * actor commands, invokes, observation callbacks, interruption, and the Effect
 * scheduler remain explicit at their actual boundaries.
 *
 * @internal
 */
export interface CompiledProcessContext<State, Event> {
  readonly scope: ProcessScope<Event>
  readonly ownedChildren: OwnedChildRuntime
  readonly poll: () => Option.Option<Event>
  readonly state: () => State
  readonly commit: (state: State) => Effect.Effect<void> | undefined
  /** Publishes every committed snapshot accumulated by the current synchronous segment. */
  readonly flush: () => void
  executionState: unknown
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
  /** @internal */
  readonly [compiledProcessInitial]?: (
    scope: ProcessScope<Event>
  ) => Effect.Effect<
    | { readonly state: State; readonly done: false; readonly output: undefined }
    | { readonly state: State; readonly done: true; readonly output: Output }
    | {
      readonly state: State
      readonly done: boolean
      readonly output: Output | undefined
      readonly executionState: unknown
    },
    InitialError,
    Requirements
  >
  run(context: ProcessContext<State, Event>): Effect.Effect<Output, Error, Requirements>
  /** @internal */
  readonly drain?: (
    context: ProcessContext<State, Event>
  ) => Effect.Effect<Option.Option<Output>, Error, Requirements>
  /** @internal */
  readonly [compiledProcessDrain]?: (
    context: CompiledProcessContext<State, Event>
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
  readonly onReadySync?: (ref: MachineRef<any, any, any, any>) => boolean
  readonly onStop?: Effect.Effect<void>
  readonly onStopSync?: () => void
  readonly skipStoppedOutcome?: boolean
  readonly parent?: ProcessAddress<unknown>
  readonly runtime: ProcessRuntime
  readonly sendParent?: (event: unknown) => Effect.Effect<void, StoppedError>
}

interface OwnedChildSpawnOptions {
  readonly key: string
  readonly path: string
  readonly id: string
  readonly duplicateId: string
  readonly descriptor?: ChildDescriptor
  readonly onOutcome: (
    isCurrent: () => boolean,
    outcome: RuntimeOutcome<any, any, any>
  ) => Effect.Effect<void>
  readonly onSnapshot?: (
    isCurrent: () => boolean,
    snapshot: Extract<RuntimeSnapshot<any, any, any>, { readonly status: "active" }>
  ) => Effect.Effect<void>
  readonly sendParent: (
    isCurrent: () => boolean,
    event: unknown
  ) => Effect.Effect<void, StoppedError>
}

interface OwnedChildRuntime {
  readonly spawn: (
    logic: ProcessLogic<any, any, any, any, any, any>,
    options: OwnedChildSpawnOptions
  ) => Effect.Effect<void, any, any>
  readonly stopAll: () => Effect.Effect<void>
  readonly stopPaths: (paths: ReadonlyArray<string>) => Effect.Effect<void> | undefined
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
  readonly owned: OwnedChildRuntime
}

class OwnedChildRuntimeImpl implements OwnedChildRuntime {
  constructor(
    private readonly registry: ChildRegistry,
    private readonly self: ProcessAddress<any>,
    private readonly runtime: ProcessRuntime
  ) {}

  private has(key: string): boolean {
    for (const entry of this.registry.children.values()) {
      if (entry.ownerActive && entry.ownerKey === key) return true
    }
    return false
  }

  private stopEntry(entry: ChildEntry): Effect.Effect<void> {
    entry.ownerActive = false
    return entry._tag === "Started" ? entry.ref.stop : Effect.void
  }

  spawn(
    logic: ProcessLogic<any, any, any, any, any, any>,
    options: OwnedChildSpawnOptions
  ): Effect.Effect<void, any, any> {
    const token = Symbol()
    let startedChild: MachineRef<any, any, any, any> | undefined
    const isCurrent = (): boolean => {
      const entry = this.registry.children.get(options.id)
      return entry?.token === token && entry.ownerKey === options.key && entry.ownerActive === true
    }
    return Effect.suspend(() => {
      if (this.registry.closed) return Effect.interrupt
      if (this.has(options.key) || this.registry.children.has(options.id)) {
        return Effect.fail(new ChildAlreadyExistsError({ id: options.duplicateId }))
      }
      this.registry.scope ??= Scope.makeUnsafe("parallel")
      this.registry.children.set(options.id, {
        _tag: "Starting",
        token,
        ownerKey: options.key,
        ownerPath: options.path,
        ownerActive: true
      })
      return startLogicInternal(logic, {
        detached: true,
        id: options.id,
        sendParent: (event) => options.sendParent(isCurrent, event),
        onOutcome: (outcome) => options.onOutcome(isCurrent, outcome),
        ...(options.onSnapshot === undefined
          ? undefined
          : { onSnapshot: (snapshot) => options.onSnapshot!(isCurrent, snapshot) }),
        onReadySync: (child) => {
          startedChild = child
          return registerChild(this.registry, options.id, token, child, options.descriptor)
        },
        onStopSync: () => unregisterChild(this.registry, options.id, token),
        skipStoppedOutcome: true,
        parent: this.self,
        runtime: this.runtime
      }).pipe(
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return Effect.void
          unregisterChild(this.registry, options.id, token)
          return startedChild === undefined ? Effect.void : startedChild.stop
        }),
        Scope.provide(this.registry.scope),
        Effect.asVoid
      )
    })
  }

  stopAll(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const effects: Array<Effect.Effect<void>> = []
      for (const entry of this.registry.children.values()) {
        if (entry.ownerActive) effects.push(this.stopEntry(entry))
      }
      return effects.length === 0
        ? Effect.void
        : effects.length === 1
        ? effects[0]!
        : Effect.all(effects, { concurrency: "unbounded", discard: true })
    })
  }

  stopPaths(paths: ReadonlyArray<string>): Effect.Effect<void> | undefined {
    if (paths.length === 0) return undefined
    const pathSet = new Set(paths)
    const effects: Array<Effect.Effect<void>> = []
    for (const entry of this.registry.children.values()) {
      if (entry.ownerActive && entry.ownerPath !== undefined && pathSet.has(entry.ownerPath)) {
        effects.push(this.stopEntry(entry))
      }
    }
    return effects.length === 0
      ? undefined
      : effects.length === 1
      ? effects[0]!
      : Effect.all(effects, { concurrency: "unbounded", discard: true })
  }
}

const noChildChanges = Stream.succeed(Option.none()).pipe(Stream.concat(Stream.never))
const noParentSend = (_event: unknown): Effect.Effect<void, StoppedError> => Effect.void

const childlessRuntime: ChildRuntime = {
  close: () => Effect.void,
  spawn: (() => Effect.die(new Error("Childless machine logic cannot spawn a process"))) as ProcessSpawn,
  get: () => Effect.succeed(Option.none()),
  changes: () => noChildChanges,
  sendTo: () => Effect.void,
  stop: () => Effect.void,
  owned: {
    spawn: () => Effect.die(new Error("Childless machine logic cannot spawn an owned process")),
    stopAll: () => Effect.void,
    stopPaths: () => undefined
  }
}

const makeChildRuntime = (
  self: ProcessAddress<any>,
  runtime: ProcessRuntime
): Effect.Effect<ChildRuntime> =>
  Effect.sync(() => {
    // Child-registry decisions are synchronous and every access below runs in
    // one Effect.sync / Effect.suspend step. Keep the unobserved representation
    // compact; selector-specific handoffs are installed only while
    // childChanges streams are running.
    const registry: ChildRegistry = {
      closed: false,
      children: new Map(),
      observers: undefined,
      scope: undefined
    }

    const close = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (registry.closed) {
          return Effect.void
        }
        registry.closed = true
        if (registry.scope === undefined) {
          return Effect.void
        }
        const finalizers = Scope.closeUnsafe(registry.scope, exit)
        let first: Effect.Effect<void> | undefined
        let rest: Array<Effect.Effect<void>> | undefined
        for (const entry of registry.children.values()) {
          if (entry._tag !== "Started") {
            continue
          }
          if (first === undefined) {
            first = entry.ref.stop
          } else {
            rest ??= [first]
            rest.push(entry.ref.stop)
          }
        }
        if (finalizers !== undefined) {
          if (first === undefined) {
            first = finalizers
          } else {
            rest ??= [first]
            rest.push(finalizers)
          }
        }
        const cleanup = rest ?? first
        return cleanup === undefined
          ? Effect.void
          : Array.isArray(cleanup)
          ? Effect.all(cleanup, { concurrency: "unbounded", discard: true })
          : cleanup
      })

    const unregister = (
      key: ChildKey,
      token: symbol
    ): Effect.Effect<void> => Effect.sync(() => unregisterChild(registry, key, token))

    const register = (
      key: ChildKey,
      token: symbol,
      ref: MachineRef<any, any, any, any>,
      descriptor: ChildDescriptor | undefined
    ): Effect.Effect<boolean> => Effect.sync(() => registerChild(registry, key, token, ref, descriptor))

    const get: ChildRuntime["get"] = (child) => {
      const id = typeof child === "string" ? child : child.id
      return Effect.sync(() => {
        if (registry.closed) {
          return Option.none()
        }
        const entry = registry.children.get(id)
        return entry !== undefined && matchesChild(entry, child)
          ? Option.some(entry.ref)
          : Option.none()
      })
    }

    const changes: ChildRuntime["changes"] = (child) => {
      const id = typeof child === "string" ? child : child.id
      return Stream.fromChannel(
        Channel.fromTransform((_, streamScope) =>
          Effect.sync((): ChildObserver => ({ child, id, values: undefined, waiter: undefined })).pipe(
            Effect.flatMap((observer) => {
              const removeObserver = Effect.sync(() => {
                if (registry.observers !== undefined) {
                  registry.observers.delete(observer)
                  if (registry.observers.size === 0) {
                    registry.observers = undefined
                  }
                }
                observer.values = undefined
                observer.waiter = undefined
              })
              return Scope.addFinalizer(streamScope, removeObserver).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (!registry.closed && streamScope.state._tag !== "Closed") {
                      registry.observers ??= new Set()
                      registry.observers.add(observer)
                    }
                    offerChildObservation(observer, selectRegistryChild(registry, id, child))
                  })
                ),
                Effect.as(takeChildObservations(observer))
              )
            })
          )
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
        return entry !== undefined && matchesChild(entry, child)
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
        return entry !== undefined && matchesChild(entry, child)
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
      return Effect.suspend((): Effect.Effect<
        MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
        ChildAlreadyExistsError | ChildInitialError,
        Exclude<ChildRequirements, Scope.Scope>
      > => {
        if (registry.closed) {
          return Effect.interrupt
        }
        if (typeof key === "string" && registry.children.has(key)) {
          return Effect.fail(new ChildAlreadyExistsError({ id: key }))
        }
        registry.scope ??= Scope.makeUnsafe("parallel")
        registry.children.set(key, { _tag: "Starting", token })
        return startLogicInternal(logic, {
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
          ),
          Scope.provide(registry.scope)
        )
      }) as Effect.Effect<
        MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>,
        ChildAlreadyExistsError | ChildInitialError,
        Exclude<ChildRequirements, Scope.Scope>
      >
    }

    return {
      close,
      spawn,
      get,
      changes,
      sendTo,
      stop,
      owned: new OwnedChildRuntimeImpl(registry, self, runtime)
    }
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
    onReadySync,
    onSnapshot,
    onStop,
    onStopSync,
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
  const cleanup = onStopSync === undefined ? onStop ?? Effect.void : Effect.sync(onStopSync)
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
    const notifyOutcome =
      onOutcome === undefined || (snapshot.status === "stopped" && options.skipStoppedOutcome === true)
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

  if (onReadySync !== undefined && !onReadySync(ref)) {
    yield* requestStop
  } else if (onReady !== undefined) {
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

type CompiledTermination =
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Done"; readonly output: unknown }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }

// Stopping is commonly used only for resource cleanup. Keep that path free of
// Error stack capture and materialize the typed join failure only if observed.
const CompiledStoppedCompletion: unique symbol = Symbol("effect/Machine/CompiledStoppedCompletion")

type CompiledCompletion =
  | Effect.Effect<unknown, unknown>
  | typeof CompiledStoppedCompletion

/**
 * Compact runtime for compiled statecharts.
 *
 * All long-lived state is stored directly on this object. Operations are
 * implemented by shared prototype methods, and public Effect / Stream values
 * are materialized only when accessed. Arbitrary process logic continues to
 * use the general runtime above.
 */
class CompiledProcess implements MachineRef<any, any, any, any> {
  readonly id: string
  readonly sessionId: string
  readonly send: (event: unknown) => Effect.Effect<void, StoppedError>

  private readonly mailbox: CompactProcessMailbox<unknown> = {
    items: undefined,
    index: 0,
    closed: false
  }
  private readonly address: ProcessAddress<unknown>
  private childRuntime: ChildRuntime = childlessRuntime
  private processScope!: ProcessScope<unknown>
  private processContext: ProcessContext<unknown, unknown> | undefined
  private compiledContext: CompiledProcessContext<unknown, unknown> | undefined
  private current!: VersionedSnapshot<unknown, unknown, unknown>
  private completion: CompiledCompletion | undefined
  private waiter: Deferred.Deferred<unknown, unknown> | undefined
  private requestedTermination: CompiledTermination | undefined
  private reservedTerminationSnapshot: RuntimeSnapshot<unknown, unknown, unknown> | undefined
  private worker: Fiber.Fiber<any, never> | undefined
  private draining = false
  private interruptRequested = false
  private offerRevision = 0
  private initializing = true

  constructor(
    private readonly logic: ProcessLogic<any, any, any, any, any, any>,
    private readonly options: StartInternalOptions,
    private readonly services: Context.Context<any>,
    sessionId: string
  ) {
    this.sessionId = sessionId
    this.id = options.id ?? sessionId
    this.send = (event) => this.sendEffect(event)
    this.address = {
      id: this.id,
      sessionId,
      stop: Effect.suspend(() => this.stopFromProcess()),
      send: this.send
    }
  }

  initialize(): Effect.Effect<MachineRef<any, any, any, any>, unknown, any> {
    const self = this
    return Effect.gen(function*() {
      if (self.logic[childlessProcess] !== true) {
        self.childRuntime = yield* makeChildRuntime(self.address, self.options.runtime)
      }
      const parent = self.options.parent
      const sendParent = self.options.sendParent ?? (parent === undefined ? noParentSend : parent.send)
      self.processScope = {
        self: self.address,
        parent,
        spawn: self.childRuntime.spawn,
        sendParent,
        sendTo: self.childRuntime.sendTo,
        stopChild: self.childRuntime.stop,
        failCause: (cause: Cause.Cause<unknown>) => self.failCause(cause)
      }

      const cleanupStartupFailure = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> =>
        Exit.isFailure(exit) ? self.childRuntime.close(exit) : Effect.void
      const compiledInitial = self.logic[compiledProcessInitial]
      const initializeEffect: Effect.Effect<
        {
          readonly state: unknown
          readonly done: boolean | undefined
          readonly output: unknown
        },
        unknown,
        any
      > = compiledInitial === undefined
        ? self.logic.initial(self.processScope).pipe(
          Effect.map((state) => ({ state, done: undefined, output: undefined } as const))
        )
        : compiledInitial(self.processScope)
      const initialized = yield* initializeEffect.pipe(
        Effect.onExit(cleanupStartupFailure),
        Effect.ensuring(Effect.sync(() => {
          self.initializing = false
        }))
      )
      const initial = initialized.state
      self.current = {
        revision: 0,
        terminalizing: false,
        changes: undefined,
        snapshot: { status: "active", state: initial }
      }
      if (self.logic[compiledProcessDrain] === undefined) {
        self.processContext = {
          ...self.processScope,
          receive: Effect.never,
          poll: Effect.sync(() => pollCompactMailbox(self.mailbox)),
          state: Effect.sync(() => self.current.snapshot.state),
          setState: (state: unknown) => self.setActiveState(state),
          updateState: (f) => self.updateState(f)
        }
      } else {
        self.compiledContext = new CompiledProcessContextImpl(self.processScope, self.childRuntime.owned, self)
        if ("executionState" in initialized) {
          self.compiledContext.executionState = initialized.executionState
        }
      }

      if (self.options.onReadySync !== undefined && !self.options.onReadySync(self)) {
        yield* self.requestTermination({ _tag: "Stopped" })
      } else if (self.options.onReady !== undefined) {
        yield* self.options.onReady(self, self.requestTermination({ _tag: "Stopped" }).pipe(Effect.asVoid))
      }
      if (self.options.onSnapshot !== undefined) {
        yield* notifyActiveSnapshot(self.options.onSnapshot, { status: "active", state: initial })
      }
      if (initialized.done === true && self.requestedTermination === undefined) {
        yield* self.requestTermination({ _tag: "Done", output: initialized.output })
      }

      // A compiled machine startup plan has already settled entry actions,
      // raised events, and eventless transitions. If it is known active and
      // neither startup hooks nor emitted work queued an event, there is no
      // first drain to perform. Future sends observe `draining === false` and
      // schedule the ordinary compiled worker.
      if (
        initialized.done === false && self.logic[childlessProcess] === true &&
        self.requestedTermination === undefined && self.mailbox.items === undefined
      ) {
        return self
      }

      self.draining = true
      yield* self.drainRuntime()
      return self
    })
  }

  get state(): Effect.Effect<unknown> {
    return Effect.sync(() => this.current.snapshot.state)
  }

  get snapshot(): Effect.Effect<RuntimeSnapshot<unknown, unknown, unknown>> {
    return Effect.sync(() => this.current.snapshot)
  }

  get changes(): Stream.Stream<RuntimeSnapshot<unknown, unknown, unknown>> {
    return this.changesStream()
  }

  get join(): Effect.Effect<unknown, unknown> {
    return Effect.suspend(() => {
      if (this.completion !== undefined) {
        return this.resolveCompletion(this.completion)
      }
      this.waiter ??= Deferred.makeUnsafe<unknown, unknown>()
      return Deferred.await(this.waiter)
    })
  }

  get stop(): Effect.Effect<void> {
    return Effect.uninterruptible(this.stopEffect())
  }

  child(child: ChildSelector): Effect.Effect<Option.Option<any>> {
    return this.childRuntime.get(child)
  }

  childChanges(child: ChildSelector): Stream.Stream<Option.Option<any>> {
    return this.childRuntime.changes(child)
  }

  private requestTermination(requested: CompiledTermination): Effect.Effect<boolean> {
    return Effect.sync(() => {
      if (this.requestedTermination !== undefined) {
        return false
      }
      this.requestedTermination = requested
      this.reservedTerminationSnapshot = this.reserveTermination(requested)
      return true
    })
  }

  private reserveTermination(
    requested: CompiledTermination
  ): RuntimeSnapshot<unknown, unknown, unknown> | undefined {
    const latest = this.current
    if (latest === undefined || latest.terminalizing || latest.snapshot.status !== "active") {
      return undefined
    }
    const snapshot: RuntimeSnapshot<unknown, unknown, unknown> = requested._tag === "Stopped"
      ? { status: "stopped", state: latest.snapshot.state }
      : requested._tag === "Done"
      ? { status: "done", state: latest.snapshot.state, output: requested.output }
      : { status: "error", state: latest.snapshot.state, cause: requested.cause }
    this.current = { ...latest, terminalizing: true }
    return snapshot
  }

  private stopFromProcess(): Effect.Effect<void> {
    const request = this.requestTermination({ _tag: "Stopped" }).pipe(Effect.asVoid)
    return this.initializing ? request : request.pipe(Effect.andThen(Effect.interrupt))
  }

  private failCause(cause: Cause.Cause<unknown>): Effect.Effect<void> {
    const requested = { _tag: "Failure", cause } as const
    return this.requestTermination(requested).pipe(
      Effect.flatMap((accepted) =>
        accepted
          ? Effect.forkDetach(this.settleRequestedTermination()).pipe(Effect.asVoid)
          : Effect.void
      )
    )
  }

  private sendEffect(event: unknown): Effect.Effect<void, StoppedError> {
    return Effect.uninterruptible(
      Effect.suspend(() => {
        if (this.mailbox.closed || this.requestedTermination !== undefined) {
          return Effect.fail(new StoppedError())
        }
        offerCompactMailbox(this.mailbox, event)
        this.offerRevision += 1
        if (this.draining) {
          return Effect.void
        }
        this.draining = true
        const scheduled = Effect.yieldNow.pipe(
          Effect.andThen(Effect.provideContext(this.drainRuntime(), this.services))
        )
        const fork = this.options.detached === true
          ? Effect.forkDetach(scheduled, { startImmediately: true })
          : Effect.forkChild(scheduled, { startImmediately: true })
        return fork.pipe(
          Effect.flatMap((fiber) =>
            Effect.sync(() => {
              this.worker = fiber
              if (!this.interruptRequested) {
                return false
              }
              this.interruptRequested = false
              return true
            }).pipe(
              Effect.flatMap((interrupt) => interrupt ? this.interruptAndFinish(fiber) : Effect.void)
            )
          ),
          Effect.asVoid
        )
      })
    )
  }

  private stopEffect(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.completion !== undefined) {
        return Effect.void
      }
      if (this.finishIdleChildlessStop()) {
        return Effect.void
      }
      const requested = { _tag: "Stopped" } as const
      return this.requestTermination(requested).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? this.settleRequestedTermination()
            : this.awaitCompletion()
        )
      )
    })
  }

  private finishIdleChildlessStop(): boolean {
    if (
      this.logic[childlessProcess] !== true || this.draining || this.worker !== undefined ||
      this.requestedTermination !== undefined || this.options.onOutcome !== undefined ||
      this.options.onStop !== undefined || this.options.onStopSync !== undefined ||
      this.current.changes !== undefined ||
      this.current.terminalizing || this.current.snapshot.status !== "active"
    ) {
      return false
    }
    const snapshot = { status: "stopped" as const, state: this.current.snapshot.state }
    this.requestedTermination = { _tag: "Stopped" }
    this.reservedTerminationSnapshot = snapshot
    closeCompactMailbox(this.mailbox)
    this.current = {
      revision: this.current.revision + 1,
      terminalizing: true,
      changes: undefined,
      snapshot
    }
    this.interruptRequested = false
    if (this.compiledContext !== undefined) {
      this.compiledContext.executionState = undefined
    }
    this.completion = CompiledStoppedCompletion
    if (this.waiter !== undefined) {
      Deferred.doneUnsafe(this.waiter, this.resolveCompletion(CompiledStoppedCompletion))
      this.waiter = undefined
    }
    return true
  }

  private settleRequestedTermination(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.draining) {
        return this.finishRequestedTermination()
      }
      if (this.worker === undefined) {
        this.interruptRequested = true
        return this.awaitCompletion()
      }
      return this.interruptAndFinish(this.worker).pipe(
        Effect.andThen(this.awaitCompletion())
      )
    })
  }

  private interruptAndFinish(worker: Fiber.Fiber<any, never>): Effect.Effect<void> {
    return Fiber.interrupt(worker).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          this.completion === undefined
            ? this.finishRequestedTermination()
            : Effect.void
        )
      )
    )
  }

  private awaitCompletion(): Effect.Effect<void> {
    return this.completion === undefined
      ? this.join.pipe(Effect.exit, Effect.asVoid)
      : Effect.void
  }

  private resolveCompletion(completion: CompiledCompletion): Effect.Effect<unknown, unknown> {
    if (completion !== CompiledStoppedCompletion) {
      return completion
    }
    const stopped = Effect.fail(new StoppedError())
    this.completion = stopped
    return stopped
  }

  private drainRuntime(): Effect.Effect<void, never, any> {
    const self = this
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        let observedRevision = self.offerRevision
        while (true) {
          if (self.requestedTermination !== undefined) {
            return yield* self.finishRequestedTermination()
          }

          const exit = yield* restore(
            Effect.suspend(() => {
              const compiledDrain = self.logic[compiledProcessDrain]
              return compiledDrain === undefined
                ? self.logic.drain!(self.processContext!)
                : compiledDrain(self.compiledContext!)
            })
          ).pipe(Effect.exit)
          self.flushPendingChanges()
          if (Exit.isFailure(exit)) {
            if (self.requestedTermination === undefined) {
              yield* self.requestTermination({ _tag: "Failure", cause: exit.cause })
            }
            return yield* self.finishRequestedTermination()
          }
          if (Option.isSome(exit.value)) {
            yield* self.requestTermination({ _tag: "Done", output: exit.value.value })
            return yield* self.finishRequestedTermination()
          }
          if (self.requestedTermination !== undefined) {
            return yield* self.finishRequestedTermination()
          }

          if (self.offerRevision !== observedRevision) {
            observedRevision = self.offerRevision
            continue
          }
          self.draining = false
          self.worker = undefined
          return
        }
      })
    )
  }

  private finishRequestedTermination(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const requested = this.requestedTermination
      if (requested === undefined) {
        return Effect.void
      }
      const snapshot = this.reservedTerminationSnapshot ?? this.reserveTermination(requested)
      if (snapshot === undefined) {
        return this.awaitCompletion()
      }
      const exit = requested._tag === "Stopped"
        ? Exit.void
        : requested._tag === "Done"
        ? Exit.succeed(requested.output)
        : Exit.failCause(requested.cause)
      const completion: CompiledCompletion = requested._tag === "Stopped"
        ? CompiledStoppedCompletion
        : requested._tag === "Done"
        ? Effect.succeed(requested.output)
        : Effect.failCause(requested.cause)
      const notifyOutcome = this.options.onOutcome === undefined ||
          (requested._tag === "Stopped" && this.options.skipStoppedOutcome === true)
        ? Effect.void
        : Effect.suspend(() => this.options.onOutcome!(classifyOutcome(snapshot)!)).pipe(
          Effect.exit,
          Effect.asVoid
        )
      return Effect.uninterruptible(
        Effect.sync(() => closeCompactMailbox(this.mailbox)).pipe(
          Effect.andThen(this.childRuntime.close(exit)),
          Effect.andThen(this.setAndPublishSnapshot(snapshot)),
          Effect.andThen(notifyOutcome),
          Effect.andThen(this.options.onStop ?? Effect.void),
          Effect.andThen(Effect.sync(() => {
            this.options.onStopSync?.()
            this.draining = false
            this.worker = undefined
            this.interruptRequested = false
            if (this.compiledContext !== undefined) {
              this.compiledContext.executionState = undefined
            }
            this.completion = completion
            if (this.waiter !== undefined) {
              Deferred.doneUnsafe(this.waiter, this.resolveCompletion(completion))
              this.waiter = undefined
            }
          }))
        )
      )
    })
  }

  private publishSnapshot(
    snapshot: VersionedSnapshot<unknown, unknown, unknown>
  ): Effect.Effect<VersionedSnapshot<unknown, unknown, unknown>> {
    const publish = snapshot.changes === undefined
      ? Effect.succeed(snapshot)
      : PubSub.publish(snapshot.changes, [snapshot] as const).pipe(Effect.as(snapshot))
    const current = snapshot.snapshot
    return this.options.onSnapshot === undefined || current.status !== "active"
      ? publish
      : publish.pipe(Effect.tap(() => notifyActiveSnapshot(this.options.onSnapshot!, current)))
  }

  private completeChanges(snapshot: VersionedSnapshot<unknown, unknown, unknown>): Effect.Effect<void> {
    return snapshot.changes === undefined
      ? Effect.void
      : PubSub.publish(snapshot.changes, Exit.succeed<void>(undefined)).pipe(Effect.asVoid)
  }

  private setAndPublishSnapshot(snapshot: RuntimeSnapshot<unknown, unknown, unknown>): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.flushPendingChanges()
      const versioned = {
        revision: this.current.revision + 1,
        snapshot,
        terminalizing: true,
        changes: this.current.changes
      }
      this.current = versioned
      return this.publishSnapshot(versioned).pipe(
        Effect.flatMap((published) => this.completeChanges(published)),
        Effect.asVoid
      )
    })
  }

  private setActiveState(state: unknown): Effect.Effect<void> {
    return Effect.suspend(() => this.commitActiveState(state) ?? Effect.void)
  }

  pollCompiledEvent(): Option.Option<unknown> {
    return pollCompactMailbox(this.mailbox)
  }

  compiledState(): unknown {
    return this.current.snapshot.state
  }

  commitCompiledState(state: unknown): Effect.Effect<void> | undefined {
    return this.commitActiveState(state, true)
  }

  private commitActiveState(state: unknown, batchChanges = false): Effect.Effect<void> | undefined {
    const latest = this.current
    if (latest.terminalizing || latest.snapshot.status !== "active") {
      return undefined
    }
    const pendingChanges = latest.pendingChanges
    if (pendingChanges !== undefined) {
      latest.pendingChanges = undefined
    }
    const activeSnapshot = { status: "active" as const, state }
    const versioned = {
      revision: latest.revision + 1,
      snapshot: activeSnapshot,
      terminalizing: false,
      changes: latest.changes
    } as VersionedSnapshot<unknown, unknown, unknown>
    this.current = versioned
    if (versioned.changes !== undefined) {
      if (pendingChanges === undefined) {
        if (batchChanges) {
          versioned.pendingChanges = [versioned]
        } else {
          PubSub.publishUnsafe(versioned.changes, [versioned] as const)
        }
      } else {
        pendingChanges.push(versioned)
        if (batchChanges) {
          versioned.pendingChanges = pendingChanges
        } else {
          PubSub.publishUnsafe(versioned.changes, pendingChanges)
        }
      }
    }
    return this.options.onSnapshot === undefined
      ? undefined
      : notifyActiveSnapshot(this.options.onSnapshot, activeSnapshot)
  }

  flushPendingChanges(): void {
    const current = this.current
    const pendingChanges = current?.pendingChanges
    if (pendingChanges === undefined || current.changes === undefined) {
      return
    }
    current.pendingChanges = undefined
    PubSub.publishUnsafe(current.changes, pendingChanges)
  }

  private updateState<E, R>(
    f: (state: unknown) => Effect.Effect<unknown, E, R>
  ): Effect.Effect<void, E, R> {
    return Effect.suspend(() => {
      const observed = this.current
      if (observed.terminalizing || observed.snapshot.status !== "active") {
        return Effect.void
      }
      return f(observed.snapshot.state).pipe(
        Effect.flatMap((state) => {
          const latest = this.current
          return latest.terminalizing || latest.revision !== observed.revision
            ? Effect.void
            : this.setActiveState(state)
        })
      )
    })
  }

  private getOrCreateChanges(): Effect.Effect<
    PubSub.PubSub<Take.Take<VersionedSnapshot<unknown, unknown, unknown>>> | undefined
  > {
    return Effect.suspend(() => {
      const observed = this.current
      if (observed.snapshot.status !== "active") {
        return Effect.succeed(undefined)
      }
      if (observed.changes !== undefined) {
        return Effect.succeed(observed.changes)
      }
      return PubSub.unbounded<Take.Take<VersionedSnapshot<unknown, unknown, unknown>>>({ replay: 1 }).pipe(
        Effect.flatMap((candidate) =>
          Effect.sync(() => {
            const latest = this.current
            if (latest.snapshot.status !== "active") {
              return [undefined, true] as const
            }
            if (latest.changes !== undefined) {
              return [latest.changes, true] as const
            }
            this.current = { ...latest, changes: candidate }
            return [candidate, false] as const
          }).pipe(
            Effect.flatMap(([changes, discard]) =>
              discard ? PubSub.shutdown(candidate).pipe(Effect.as(changes)) : Effect.succeed(changes)
            )
          )
        )
      )
    })
  }

  private changesStream(): Stream.Stream<RuntimeSnapshot<unknown, unknown, unknown>> {
    const self = this
    return Stream.unwrap(
      Effect.gen(function*() {
        const changes = yield* self.getOrCreateChanges()
        if (changes === undefined) {
          return Stream.succeed(self.current.snapshot)
        }
        const subscription = yield* PubSub.subscribe(changes)
        const captured = self.current
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
  }
}

class CompiledProcessContextImpl implements CompiledProcessContext<unknown, unknown> {
  executionState: unknown

  constructor(
    readonly scope: ProcessScope<unknown>,
    readonly ownedChildren: OwnedChildRuntime,
    private readonly process: CompiledProcess
  ) {}

  poll(): Option.Option<unknown> {
    return this.process.pollCompiledEvent()
  }

  state(): unknown {
    return this.process.compiledState()
  }

  commit(state: unknown): Effect.Effect<void> | undefined {
    return this.process.commitCompiledState(state)
  }

  flush(): void {
    this.process.flushPendingChanges()
  }
}

const startCompactCompiledInternal: typeof startGenericInternal = Effect.fnUntraced(function*(
  logic: ProcessLogic<any, any, any, any, any, any>,
  options: StartInternalOptions
) {
  const sessionId = yield* options.runtime.nextSessionId
  const services = yield* Effect.context<any>()
  const process = new CompiledProcess(logic, options, services, sessionId)
  return yield* process.initialize()
}) as typeof startGenericInternal

const startLogicInternal: typeof startGenericInternal = ((
  logic: ProcessLogic<any, any, any, any, any, any>,
  options: StartInternalOptions
) =>
  logic[compiledProcess] === true && (logic.drain !== undefined || logic[compiledProcessDrain] !== undefined)
    ? startCompactCompiledInternal(logic, options)
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
