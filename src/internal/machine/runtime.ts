/**
 * Internal machine process runtime helpers.
 *
 * @since 0.4.0
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
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as SynchronizedRef from "effect/SynchronizedRef"
import type * as Take from "effect/Take"
import type { MachineTarget } from "../../Machine.js"
import { ChildAlreadyExistsError, StoppedError } from "./errors.js"

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
export const sendParentOverride: unique symbol = Symbol.for("effect/Machine/sendParentOverride")

/** @internal */
export const acknowledgedSend: unique symbol = Symbol.for("effect/Machine/acknowledgedSend")

/** @internal */
export interface AcknowledgedDelivery<State> {
  readonly before: State
  readonly plan: unknown
  readonly after: State
}

const AcknowledgedMessageTypeId: unique symbol = Symbol("effect/Machine/AcknowledgedMessage")

/** @internal */
export interface AcknowledgedMessage<Event> {
  readonly [AcknowledgedMessageTypeId]: true
  readonly event: Event
  readonly deferred: Deferred.Deferred<AcknowledgedDelivery<unknown>, unknown>
}

/** @internal */
export type ProcessMessage<Event> = Event | AcknowledgedMessage<Event>

/** @internal */
export const isAcknowledgedMessage = <Event>(
  message: ProcessMessage<Event>
): message is AcknowledgedMessage<Event> =>
  typeof message === "object" && message !== null && AcknowledgedMessageTypeId in message

/** @internal */
export const messageEvent = <Event>(message: ProcessMessage<Event>): Event =>
  isAcknowledgedMessage(message) ? message.event : message

const succeedAcknowledgedMessage = <State>(
  message: ProcessMessage<unknown> | undefined,
  delivery: AcknowledgedDelivery<State>
): void => {
  if (message !== undefined && isAcknowledgedMessage(message)) {
    Deferred.doneUnsafe(message.deferred, Effect.succeed(delivery as AcknowledgedDelivery<unknown>))
  }
}

const failAcknowledgedMessage = (
  message: ProcessMessage<unknown> | undefined,
  cause: Cause.Cause<unknown>
): void => {
  if (message !== undefined && isAcknowledgedMessage(message)) {
    Deferred.doneUnsafe(message.deferred, Effect.failCause(cause))
  }
}

const stopAcknowledgedMessage = (message: ProcessMessage<unknown> | undefined): void => {
  if (message !== undefined && isAcknowledgedMessage(message)) {
    Deferred.doneUnsafe(message.deferred, Effect.fail(new StoppedError()))
  }
}

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

export interface MachineRef<out State, in Event, out Error = never, out Output = never, out Emitted = never> {
  readonly id: string
  readonly sessionId: string
  readonly state: Effect.Effect<State>
  readonly snapshot: Effect.Effect<RuntimeSnapshot<State, Error, Output>>
  readonly changes: Stream.Stream<RuntimeSnapshot<State, Error, Output>>
  readonly emissions: Stream.Stream<Emitted>
  readonly join: Effect.Effect<Output, Error | StoppedError>
  readonly stop: Effect.Effect<void>
  readonly send: (event: Event) => Effect.Effect<void, StoppedError>
  readonly [acknowledgedSend]?: (
    event: Event
  ) => Effect.Effect<AcknowledgedDelivery<State>, Error | StoppedError>
  readonly child: (child: any) => Effect.Effect<Option.Option<any>>
  readonly childChanges: (child: any) => Stream.Stream<Option.Option<any>>
}

export interface PreparedProcess<
  out State,
  in Event,
  out Error,
  out Output,
  out Emitted,
  out StartError,
  StartRequirements
> {
  readonly id: string
  readonly sessionId: string
  readonly changes: Stream.Stream<RuntimeSnapshot<State, Error, Output>, StartError>
  readonly emissions: Stream.Stream<Emitted>
  readonly start: Effect.Effect<MachineRef<State, Event, Error, Output, Emitted>, StartError, StartRequirements>
}

interface ProcessAddress<in Event> {
  readonly id: string
  readonly sessionId: string
  readonly stop: Effect.Effect<void>
  readonly send: (event: Event) => Effect.Effect<void, StoppedError>
}

const isProcessAddress = (value: unknown): value is MachineTarget<unknown> =>
  typeof value === "object" && value !== null && "send" in value && typeof value.send === "function"

export interface ProcessScope<Event> {
  readonly self: ProcessAddress<Event>
  readonly parent: ProcessAddress<unknown> | undefined
  readonly spawn: ProcessSpawn
  readonly sendParent: (event: unknown) => Effect.Effect<void, StoppedError>
  readonly emit: (event: unknown) => Effect.Effect<void>
  readonly sendTo: {
    <TargetEvent>(target: MachineTarget<TargetEvent>, event: TargetEvent): Effect.Effect<void, StoppedError>
    (child: ChildSelector, event: unknown): Effect.Effect<void, StoppedError>
  }
  readonly stopChild: (child: ChildSelector) => Effect.Effect<void>
  /** @internal */
  readonly failCause: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
}

export interface ProcessContext<State, Event> extends ProcessScope<Event> {
  readonly receive: Effect.Effect<Event>
  /** @internal */
  readonly poll?: Effect.Effect<Option.Option<Event>>
  /** @internal */
  readonly receiveMessage?: Effect.Effect<ProcessMessage<Event>>
  /** @internal */
  readonly pollMessage?: Effect.Effect<Option.Option<ProcessMessage<Event>>>
  /** @internal */
  readonly completeMessage?: (delivery: AcknowledgedDelivery<State>) => void
  readonly state: Effect.Effect<State>
  readonly setState: (state: State) => Effect.Effect<void>
  readonly updateState: <E, R>(
    f: (state: State) => Effect.Effect<State, E, R>
  ) => Effect.Effect<void, E, R>
  /** Present only when a compiled statechart is forced through the generic runtime. @internal */
  readonly ownedChildren?: OwnedChildRuntime
}

/**
 * Owner-local execution context for compiled statecharts.
 *
 * Unlike `ProcessContext`, synchronous mailbox and state operations do not
 * introduce an Effect boundary. The compiled drain still returns an Effect so
 * machine commands, invokes, observation callbacks, interruption, and the Effect
 * scheduler remain explicit at their actual boundaries.
 *
 * @internal
 */
export interface CompiledProcessContext<State, Event> {
  readonly scope: ProcessScope<Event>
  readonly ownedChildren: OwnedChildRuntime
  readonly poll: () => Option.Option<Event>
  readonly pollMessage: () => Option.Option<ProcessMessage<Event>>
  readonly state: () => State
  readonly completeMessage: (delivery: AcknowledgedDelivery<State>) => void
  readonly commit: (state: State) => Effect.Effect<void> | undefined
  /**
   * Publishes the current synchronous segment before continuing with work that
   * may suspend, run user effects, or make the committed state observable.
   */
  readonly runAfterChanges: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  executionState: unknown
}

type CompiledProcessInitial<State, Output> =
  | { readonly state: State; readonly done: false; readonly output: undefined }
  | { readonly state: State; readonly done: true; readonly output: Output }
  | {
    readonly state: State
    readonly done: boolean
    readonly output: Output | undefined
    readonly executionState: unknown
  }

export type CompiledProcessDrain<State, Event, Error, Requirements, Output> =
  | {
    readonly _tag: "Process"
    readonly run: (
      context: ProcessContext<State, Event>
    ) => Effect.Effect<Option.Option<Output>, Error, Requirements>
  }
  | {
    readonly _tag: "Owned"
    readonly run: (
      context: CompiledProcessContext<State, Event>
    ) => Effect.Effect<Option.Option<Output>, Error, Requirements>
  }

/**
 * The complete capability descriptor consumed by the compact process runtime.
 * Generic process logic omits this field entirely.
 *
 * @internal
 */
export interface CompiledProcessExecution<
  State,
  Event,
  Error,
  Requirements,
  Output,
  InitialError
> {
  readonly _tag: "Compiled"
  readonly childless: boolean
  readonly initial?: (
    scope: ProcessScope<Event>
  ) => Effect.Effect<CompiledProcessInitial<State, Output>, InitialError, Requirements>
  readonly initialSync?: (
    scope: ProcessScope<Event>
  ) => CompiledProcessInitial<State, Output>
  readonly drain: CompiledProcessDrain<State, Event, Error, Requirements, Output>
}

export type ProcessExecution<State, Event, Error, Requirements, Output, InitialError> =
  | {
    readonly _tag: "Childless"
  }
  | CompiledProcessExecution<State, Event, Error, Requirements, Output, InitialError>

const executionIsChildless = (
  execution: ProcessExecution<any, any, any, any, any, any> | undefined
): boolean => execution?._tag === "Childless" || execution?.childless === true

interface CompactProcessMailbox<Event> {
  items: Array<ProcessMessage<Event>> | undefined
  index: number
  closed: boolean
}

const offerCompactMailbox = <Event>(mailbox: CompactProcessMailbox<Event>, event: ProcessMessage<Event>): void => {
  const items = mailbox.items ?? []
  mailbox.items = items
  items.push(event)
}

const pollCompactMailbox = <Event>(mailbox: CompactProcessMailbox<Event>): Option.Option<ProcessMessage<Event>> => {
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
  if (mailbox.items !== undefined) {
    for (let index = mailbox.index; index < mailbox.items.length; index += 1) {
      stopAcknowledgedMessage(mailbox.items[index])
    }
  }
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
  /** @internal */
  readonly execution?: ProcessExecution<State, Event, Error, Requirements, Output, InitialError>
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
  readonly sessionId?: string
  readonly emissions?: EmissionRuntime
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

/** @internal */
export interface OwnedChildSpawnOptions {
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

/** @internal */
export interface OwnedChildRuntime {
  readonly spawn: (
    makeLogic: () => ProcessLogic<any, any, any, any, any, any>,
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
  private scopedServices: Context.Context<any> | undefined

  constructor(
    private readonly registry: ChildRegistry,
    private readonly self: ProcessAddress<any>,
    private readonly runtime: ProcessRuntime,
    private readonly services?: Context.Context<any>
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
    makeLogic: () => ProcessLogic<any, any, any, any, any, any>,
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
      const logic = makeLogic()
      const scope = this.registry.scope ??= Scope.makeUnsafe("parallel")
      this.registry.children.set(options.id, {
        _tag: "Starting",
        token,
        ownerKey: options.key,
        ownerPath: options.path,
        ownerActive: true
      })
      const parent: ProcessAddress<unknown> = {
        ...this.self,
        send: (event) => options.sendParent(isCurrent, event)
      }
      const startOptions: StartInternalOptions = {
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
        parent,
        runtime: this.runtime
      }
      const execution = logic.execution
      const synchronous = this.services !== undefined && options.onSnapshot === undefined &&
        execution?._tag === "Compiled" && execution.childless && execution.drain._tag === "Owned" &&
        execution.initialSync !== undefined
      const start = synchronous
        ? Effect.flatMap(
          this.runtime.nextSessionId,
          (sessionId) =>
            new CompiledProcess(
              logic,
              startOptions,
              this.scopedServices ??= Context.add(this.services!, Scope.Scope, scope),
              sessionId
            ).initializeCompiledSync()
        )
        : startLogicInternal(logic, startOptions)
      const guarded = start.pipe(
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return Effect.void
          unregisterChild(this.registry, options.id, token)
          return startedChild === undefined ? Effect.void : startedChild.stop
        })
      )
      return (synchronous ? guarded : Scope.provide(guarded, scope)).pipe(Effect.asVoid)
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
const EmissionsClosed: unique symbol = Symbol("effect/Machine/EmissionsClosed")

type LazyEmissions = PubSub.PubSub<unknown> | typeof EmissionsClosed | undefined

interface EmissionRuntime {
  readonly emit: (event: unknown) => Effect.Effect<void>
  readonly close: () => Effect.Effect<void>
  readonly stream: Stream.Stream<unknown>
}

const makeEmissionRuntime = (): EmissionRuntime => {
  let emissions: LazyEmissions
  const getOrCreate: Effect.Effect<PubSub.PubSub<unknown> | undefined> = Effect.suspend(() => {
    const observed = emissions
    if (observed === EmissionsClosed) return Effect.succeed(undefined)
    if (observed !== undefined) return Effect.succeed(observed)
    return PubSub.unbounded<unknown>().pipe(
      Effect.flatMap((candidate) =>
        Effect.sync(() => {
          const latest = emissions
          if (latest === EmissionsClosed) return [undefined, true] as const
          if (latest !== undefined) return [latest, true] as const
          emissions = candidate
          return [candidate, false] as const
        }).pipe(
          Effect.flatMap(([selected, discard]) =>
            discard ? PubSub.shutdown(candidate).pipe(Effect.as(selected)) : Effect.succeed(selected)
          )
        )
      )
    )
  })
  return {
    emit: (event) =>
      Effect.suspend(() =>
        emissions === undefined || emissions === EmissionsClosed
          ? Effect.void
          : PubSub.publish(emissions, event).pipe(Effect.asVoid)
      ),
    close: () => {
      const observed = emissions
      emissions = EmissionsClosed
      return observed === undefined || observed === EmissionsClosed ? Effect.void : PubSub.shutdown(observed)
    },
    stream: Stream.unwrap(
      getOrCreate.pipe(
        Effect.map((emissions) => emissions === undefined ? Stream.empty : Stream.fromPubSub(emissions))
      )
    )
  }
}

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

const makeChildRuntimeSync = (
  self: ProcessAddress<any>,
  runtime: ProcessRuntime,
  services?: Context.Context<any>
): ChildRuntime => {
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
    })
  }

  return {
    close,
    spawn,
    get,
    changes,
    sendTo,
    stop,
    owned: new OwnedChildRuntimeImpl(registry, self, runtime, services)
  }
}

const makeChildRuntime = (
  self: ProcessAddress<any>,
  runtime: ProcessRuntime,
  services?: Context.Context<any>
): Effect.Effect<ChildRuntime> => Effect.sync(() => makeChildRuntimeSync(self, runtime, services))

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

  const sessionId = options.sessionId ?? (yield* runtime.nextSessionId)
  const id = requestedId ?? sessionId
  const queue = yield* Queue.unbounded<ProcessMessage<Event>>()
  const emissions = options.emissions ?? makeEmissionRuntime()
  const termination = yield* Deferred.make<ProcessTermination>()
  const done = yield* Deferred.make<Output, Error | StoppedError>()
  const awaitCompletion = Deferred.await(done).pipe(Effect.exit, Effect.asVoid)
  let initializing = true
  let inFlightMessage: ProcessMessage<Event> | undefined
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
  const sendAcknowledged:
    | ((event: Event) => Effect.Effect<AcknowledgedDelivery<State>, Error | StoppedError>)
    | undefined = logic.execution?._tag !== "Compiled"
      ? undefined
      : (event) =>
        Effect.uninterruptibleMask((restore) =>
          Deferred.make<AcknowledgedDelivery<unknown>, unknown>().pipe(
            Effect.flatMap((deferred) =>
              Queue.offer(queue, {
                [AcknowledgedMessageTypeId]: true as const,
                event,
                deferred
              }).pipe(
                Effect.flatMap((accepted) =>
                  accepted
                    ? restore(Deferred.await(deferred))
                    : Effect.fail(new StoppedError())
                )
              )
            ),
            Effect.map((delivery) => delivery as AcknowledgedDelivery<State>)
          )
        ) as Effect.Effect<AcknowledgedDelivery<State>, Error | StoppedError>

  let {
    changes: childChanges,
    close: closeChildren,
    get: getChild,
    owned: ownedChildren,
    sendTo,
    spawn,
    stop: stopChild
  } = childlessRuntime
  if (!executionIsChildless(logic.execution)) {
    ;({
      changes: childChanges,
      close: closeChildren,
      get: getChild,
      owned: ownedChildren,
      sendTo,
      spawn,
      stop: stopChild
    } = yield* makeChildRuntime(self, runtime))
  }
  const cleanupStartupFailure = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> =>
    Exit.isFailure(exit)
      ? closeChildren(exit).pipe(Effect.andThen(emissions.close()))
      : Effect.void
  const cleanup = onStopSync === undefined ? onStop ?? Effect.void : Effect.sync(onStopSync)
  const sendParent = overrideSendParent ?? (parent === undefined ? noParentSend : parent.send)

  const scope: ProcessScope<Event> = {
    self,
    parent,
    spawn,
    sendParent,
    emit: emissions.emit,
    sendTo: ((target: unknown, event: unknown) =>
      isProcessAddress(target) ? target.send(event) : sendTo(target as ChildSelector, event)) as ProcessScope<
        Event
      >["sendTo"],
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
        : publish.pipe(Effect.tap(() =>
          notifyActiveSnapshot(onSnapshot, runtimeSnapshot)
        ))
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
      Effect.sync(() => {
        while (true) {
          const pending = Queue.takeUnsafe(queue)
          if (pending === undefined || Exit.isFailure(pending)) break
          stopAcknowledgedMessage(pending.value)
        }
      }).pipe(
        Effect.andThen(Queue.shutdown(queue)),
        Effect.andThen(closeChildren(exit)),
        Effect.andThen(setAndPublishSnapshot(snapshot)),
        Effect.andThen(emissions.close()),
        Effect.andThen(Effect.sync(() => {
          if (Exit.isFailure(exit)) {
            failAcknowledgedMessage(inFlightMessage, exit.cause)
          } else {
            stopAcknowledgedMessage(inFlightMessage)
          }
          inFlightMessage = undefined
        })),
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

  const acknowledgedContext:
    | Pick<
      ProcessContext<State, Event>,
      "receiveMessage" | "pollMessage" | "completeMessage"
    >
    | undefined = logic.execution?._tag !== "Compiled" ? undefined : {
      receiveMessage: Queue.take(queue).pipe(
        Effect.tap((message) =>
          Effect.sync(() => {
            inFlightMessage = isAcknowledgedMessage(message) ? message : undefined
          })
        )
      ),
      pollMessage: Queue.poll(queue).pipe(
        Effect.tap((message) =>
          Effect.sync(() => {
            if (Option.isSome(message)) {
              inFlightMessage = isAcknowledgedMessage(message.value) ? message.value : undefined
            }
          })
        )
      ),
      completeMessage: (delivery) => {
        succeedAcknowledgedMessage(inFlightMessage, delivery)
        inFlightMessage = undefined
      }
    }
  const context: ProcessContext<State, Event> = {
    ...scope,
    ...(logic.execution?._tag === "Compiled" && !logic.execution.childless ? { ownedChildren } : undefined),
    ...acknowledgedContext,
    receive: Queue.take(queue).pipe(Effect.map(messageEvent)),
    poll: Queue.poll(queue).pipe(Effect.map(Option.map(messageEvent))),
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
    emissions: emissions.stream as Stream.Stream<never>,
    join: Deferred.await(done),
    stop,
    send: self.send,
    ...(sendAcknowledged === undefined ? undefined : { [acknowledgedSend]: sendAcknowledged }),
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

type CompiledInitialized = CompiledProcessInitial<unknown, unknown>

// Stopping is commonly used only for resource cleanup. Keep that path free of
// Error stack capture and materialize the typed join failure only if observed.
const CompiledStoppedCompletion: unique symbol = Symbol("effect/Machine/CompiledStoppedCompletion")

type CompiledCompletion =
  | Effect.Effect<unknown, unknown>
  | typeof CompiledStoppedCompletion

type CompiledLifecycle = "Active" | "TerminationRequested" | "Completed"
type CompiledRunState = "Initializing" | "Idle" | "Draining"

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
  readonly send: (event: unknown) => Effect.Effect<void, StoppedError>;
  [acknowledgedSend](
    event: unknown
  ): Effect.Effect<AcknowledgedDelivery<unknown>, unknown | StoppedError> {
    return this.sendAcknowledgedEffect(event)
  }

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
  /**
   * `Active` has no terminal payload, `TerminationRequested` owns
   * `termination` and its optional reserved snapshot, and `Completed` owns
   * `completion`. `runState` independently tracks worker activity.
   */
  private lifecycle: CompiledLifecycle = "Active"
  private runState: CompiledRunState = "Initializing"
  private completion: CompiledCompletion | undefined
  private waiter: Deferred.Deferred<unknown, unknown> | undefined
  private termination: CompiledTermination | undefined
  private terminationSnapshot: RuntimeSnapshot<unknown, unknown, unknown> | undefined
  private worker: Fiber.Fiber<any, never> | undefined
  private interruptRequested = false
  private offerRevision = 0
  private inFlightMessage: ProcessMessage<unknown> | undefined
  private readonly externalEmissions: EmissionRuntime | undefined
  private emissionsPubSub: LazyEmissions

  constructor(
    private readonly logic: ProcessLogic<any, any, any, any, any, any>,
    private readonly options: StartInternalOptions,
    private readonly services: Context.Context<any>,
    sessionId: string
  ) {
    this.sessionId = sessionId
    this.id = options.id ?? sessionId
    this.externalEmissions = options.emissions
    this.send = (event) => this.offerMessage(event)
    this.address = {
      id: this.id,
      sessionId,
      stop: Effect.suspend(() => this.stopFromProcess()),
      send: this.send
    }
  }

  private get execution(): CompiledProcessExecution<any, any, any, any, any, any> {
    return this.logic.execution as CompiledProcessExecution<any, any, any, any, any, any>
  }

  initializeCompiledSync(): Effect.Effect<MachineRef<any, any, any, any>, unknown> {
    if (!this.execution.childless) {
      this.childRuntime = makeChildRuntimeSync(this.address, this.options.runtime, this.services)
    }
    const parent = this.options.parent
    const sendParent = this.options.sendParent ?? (parent === undefined ? noParentSend : parent.send)
    this.processScope = {
      self: this.address,
      parent,
      spawn: this.childRuntime.spawn,
      sendParent,
      emit: (event) => this.emitEvent(event),
      sendTo: ((target: unknown, event: unknown) =>
        isProcessAddress(target)
          ? target.send(event)
          : this.childRuntime.sendTo(target as ChildSelector, event)) as ProcessScope<unknown>["sendTo"],
      stopChild: this.childRuntime.stop,
      failCause: (cause: Cause.Cause<unknown>) => this.failCause(cause)
    }
    const compiledInitial = this.execution.initialSync!
    let initialized: CompiledInitialized
    try {
      initialized = compiledInitial(this.processScope)
    } catch (error) {
      this.runState = "Idle"
      return Effect.fail(error)
    }
    this.runState = "Idle"
    this.current = {
      revision: 0,
      terminalizing: false,
      changes: undefined,
      snapshot: { status: "active", state: initialized.state }
    }
    this.compiledContext = new CompiledProcessContextImpl(this.processScope, this.childRuntime.owned, this)
    if ("executionState" in initialized) {
      this.compiledContext.executionState = initialized.executionState
    }
    if (this.options.onReadySync !== undefined && !this.options.onReadySync(this)) {
      this.requestTerminationSync({ _tag: "Stopped" })
    }
    if (initialized.done === true && this.lifecycle === "Active") {
      this.requestTerminationSync({ _tag: "Done", output: initialized.output })
    }
    if (
      initialized.done === false && this.execution.childless &&
      this.lifecycle === "Active" &&
      this.mailbox.items === undefined
    ) {
      return Effect.succeed(this)
    }
    this.runState = "Draining"
    return Effect.provideContext(this.drainRuntime(), this.services).pipe(Effect.as(this))
  }

  initialize(): Effect.Effect<MachineRef<any, any, any, any>, unknown, any> {
    const self = this
    return Effect.gen(function*() {
      if (!self.execution.childless) {
        self.childRuntime = yield* makeChildRuntime(self.address, self.options.runtime, self.services)
      }
      const parent = self.options.parent
      const sendParent = self.options.sendParent ?? (parent === undefined ? noParentSend : parent.send)
      self.processScope = {
        self: self.address,
        parent,
        spawn: self.childRuntime.spawn,
        sendParent,
        emit: (event) => self.emitEvent(event),
        sendTo: ((target: unknown, event: unknown) =>
          isProcessAddress(target)
            ? target.send(event)
            : self.childRuntime.sendTo(target as ChildSelector, event)) as ProcessScope<unknown>["sendTo"],
        stopChild: self.childRuntime.stop,
        failCause: (cause: Cause.Cause<unknown>) => self.failCause(cause)
      }

      const cleanupStartupFailure = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> =>
        Exit.isFailure(exit) ? self.childRuntime.close(exit) : Effect.void
      const compiledInitial = self.execution.initial
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
          self.runState = "Idle"
        }))
      )
      const initial = initialized.state
      self.current = {
        revision: 0,
        terminalizing: false,
        changes: undefined,
        snapshot: { status: "active", state: initial }
      }
      if (self.execution.drain._tag === "Process") {
        self.processContext = {
          ...self.processScope,
          receive: Effect.never,
          poll: Effect.sync(() => Option.map(pollCompactMailbox(self.mailbox), messageEvent)),
          receiveMessage: Effect.never,
          pollMessage: Effect.sync(() => self.pollCompiledMessage()),
          completeMessage: (delivery) => self.completeCompiledMessage(delivery),
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
      if (initialized.done === true && self.lifecycle === "Active") {
        yield* self.requestTermination({ _tag: "Done", output: initialized.output })
      }

      // A compiled machine startup plan has already settled entry actions,
      // raised events, and eventless transitions. If it is known active and
      // neither startup hooks nor emitted work queued an event, there is no
      // first drain to perform. Future sends observe an idle run state and
      // schedule the ordinary compiled worker.
      if (
        initialized.done === false && self.execution.childless &&
        self.lifecycle === "Active" && self.mailbox.items === undefined
      ) {
        return self
      }

      self.runState = "Draining"
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

  get emissions(): Stream.Stream<never> {
    return (this.externalEmissions?.stream ?? this.emissionsStream()) as Stream.Stream<never>
  }

  get join(): Effect.Effect<unknown, unknown> {
    return Effect.suspend(() => {
      if (this.lifecycle === "Completed") {
        return this.resolveCompletion(this.completion!)
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
    return Effect.sync(() => this.requestTerminationSync(requested))
  }

  private hasTerminationRequest(): boolean {
    return this.lifecycle === "TerminationRequested"
  }

  private requestTerminationSync(requested: CompiledTermination): boolean {
    if (this.lifecycle !== "Active") {
      return false
    }
    this.lifecycle = "TerminationRequested"
    this.termination = requested
    this.terminationSnapshot = this.reserveTermination(requested)
    return true
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
    return this.runState === "Initializing" ? request : request.pipe(Effect.andThen(Effect.interrupt))
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

  private sendAcknowledgedEffect(
    event: unknown
  ): Effect.Effect<AcknowledgedDelivery<unknown>, unknown | StoppedError> {
    return Effect.uninterruptibleMask((restore) =>
      Deferred.make<AcknowledgedDelivery<unknown>, unknown>().pipe(
        Effect.flatMap((deferred) =>
          this.offerMessage({
            [AcknowledgedMessageTypeId]: true as const,
            event,
            deferred
          }).pipe(
            Effect.andThen(restore(Deferred.await(deferred)))
          )
        )
      )
    )
  }

  private offerMessage(message: ProcessMessage<unknown>): Effect.Effect<void, StoppedError> {
    return Effect.uninterruptible(
      Effect.suspend(() => {
        if (this.mailbox.closed || this.lifecycle !== "Active") {
          return Effect.fail(new StoppedError())
        }
        offerCompactMailbox(this.mailbox, message)
        this.offerRevision += 1
        if (this.runState === "Draining") {
          return Effect.void
        }
        this.runState = "Draining"
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
      if (this.lifecycle === "Completed") {
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
      !this.execution.childless || this.runState !== "Idle" || this.worker !== undefined ||
      this.lifecycle !== "Active" ||
      (this.options.onOutcome !== undefined && this.options.skipStoppedOutcome !== true) ||
      this.options.onStop !== undefined ||
      this.current.changes !== undefined ||
      this.current.terminalizing || this.current.snapshot.status !== "active"
    ) {
      return false
    }
    const snapshot = { status: "stopped" as const, state: this.current.snapshot.state }
    this.lifecycle = "TerminationRequested"
    this.termination = { _tag: "Stopped" }
    this.terminationSnapshot = snapshot
    closeCompactMailbox(this.mailbox)
    this.current = {
      revision: this.current.revision + 1,
      terminalizing: true,
      changes: undefined,
      snapshot
    }
    stopAcknowledgedMessage(this.inFlightMessage)
    this.inFlightMessage = undefined
    this.interruptRequested = false
    if (this.compiledContext !== undefined) {
      this.compiledContext.executionState = undefined
    }
    this.options.onStopSync?.()
    this.completion = CompiledStoppedCompletion
    this.lifecycle = "Completed"
    if (this.waiter !== undefined) {
      Deferred.doneUnsafe(this.waiter, this.resolveCompletion(CompiledStoppedCompletion))
      this.waiter = undefined
    }
    return true
  }

  private settleRequestedTermination(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.runState !== "Draining") {
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
          this.lifecycle !== "Completed"
            ? this.finishRequestedTermination()
            : Effect.void
        )
      )
    )
  }

  private awaitCompletion(): Effect.Effect<void> {
    return this.lifecycle !== "Completed"
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
          if (self.hasTerminationRequest()) {
            return yield* self.finishRequestedTermination()
          }

          const exit = yield* restore(
            Effect.suspend(() => {
              const drain = self.execution.drain
              return drain._tag === "Process"
                ? drain.run(self.processContext!)
                : drain.run(self.compiledContext!)
            })
          ).pipe(Effect.exit)
          self.flushPendingChanges()
          if (Exit.isFailure(exit)) {
            if (self.lifecycle === "Active") {
              yield* self.requestTermination({ _tag: "Failure", cause: exit.cause })
            }
            return yield* self.finishRequestedTermination()
          }
          if (Option.isSome(exit.value)) {
            yield* self.requestTermination({ _tag: "Done", output: exit.value.value })
            return yield* self.finishRequestedTermination()
          }
          if (self.hasTerminationRequest()) {
            return yield* self.finishRequestedTermination()
          }

          if (self.offerRevision !== observedRevision) {
            observedRevision = self.offerRevision
            continue
          }
          self.runState = "Idle"
          self.worker = undefined
          return
        }
      })
    )
  }

  private finishRequestedTermination(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.lifecycle !== "TerminationRequested") {
        return Effect.void
      }
      const requested = this.termination
      if (requested === undefined) {
        return Effect.void
      }
      const snapshot = this.terminationSnapshot ?? this.reserveTermination(requested)
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
        Effect.sync(() => {
          closeCompactMailbox(this.mailbox)
        }).pipe(
          Effect.andThen(this.childRuntime.close(exit)),
          Effect.andThen(this.setAndPublishSnapshot(snapshot)),
          Effect.andThen(this.closeEmissions()),
          Effect.andThen(Effect.sync(() => {
            if (requested._tag === "Failure") {
              failAcknowledgedMessage(this.inFlightMessage, requested.cause)
            } else {
              stopAcknowledgedMessage(this.inFlightMessage)
            }
            this.inFlightMessage = undefined
          })),
          Effect.andThen(notifyOutcome),
          Effect.andThen(this.options.onStop ?? Effect.void),
          Effect.andThen(Effect.sync(() => {
            this.options.onStopSync?.()
            this.runState = "Idle"
            this.worker = undefined
            this.interruptRequested = false
            if (this.compiledContext !== undefined) {
              this.compiledContext.executionState = undefined
            }
            this.completion = completion
            this.lifecycle = "Completed"
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

  private emitEvent(event: unknown): Effect.Effect<void> {
    if (this.externalEmissions !== undefined) return this.externalEmissions.emit(event)
    return Effect.suspend(() =>
      this.emissionsPubSub === undefined || this.emissionsPubSub === EmissionsClosed
        ? Effect.void
        : PubSub.publish(this.emissionsPubSub, event).pipe(Effect.asVoid)
    )
  }

  shutdownEmissions(): Effect.Effect<void> {
    return this.closeEmissions()
  }

  private closeEmissions(): Effect.Effect<void> {
    if (this.externalEmissions !== undefined) return this.externalEmissions.close()
    const observed = this.emissionsPubSub
    this.emissionsPubSub = EmissionsClosed
    return observed === undefined || observed === EmissionsClosed ? Effect.void : PubSub.shutdown(observed)
  }

  private getOrCreateEmissions(): Effect.Effect<PubSub.PubSub<unknown> | undefined> {
    return Effect.suspend(() => {
      const observed = this.emissionsPubSub
      if (observed === EmissionsClosed) return Effect.succeed(undefined)
      if (observed !== undefined) return Effect.succeed(observed)
      return PubSub.unbounded<unknown>().pipe(
        Effect.flatMap((candidate) =>
          Effect.sync(() => {
            const latest = this.emissionsPubSub
            if (latest === EmissionsClosed) return [undefined, true] as const
            if (latest !== undefined) return [latest, true] as const
            this.emissionsPubSub = candidate
            return [candidate, false] as const
          }).pipe(
            Effect.flatMap(([selected, discard]) =>
              discard ? PubSub.shutdown(candidate).pipe(Effect.as(selected)) : Effect.succeed(selected)
            )
          )
        )
      )
    })
  }

  private emissionsStream(): Stream.Stream<unknown> {
    return Stream.unwrap(
      this.getOrCreateEmissions().pipe(
        Effect.map((emissions) => emissions === undefined ? Stream.empty : Stream.fromPubSub(emissions))
      )
    )
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

  pollCompiledMessage(): Option.Option<ProcessMessage<unknown>> {
    const message = pollCompactMailbox(this.mailbox)
    if (Option.isSome(message)) {
      this.inFlightMessage = isAcknowledgedMessage(message.value) ? message.value : undefined
    }
    return message
  }

  completeCompiledMessage(delivery: AcknowledgedDelivery<unknown>): void {
    succeedAcknowledgedMessage(this.inFlightMessage, delivery)
    this.inFlightMessage = undefined
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
    return Option.map(this.process.pollCompiledMessage(), messageEvent)
  }

  pollMessage(): Option.Option<ProcessMessage<unknown>> {
    return this.process.pollCompiledMessage()
  }

  state(): unknown {
    return this.process.compiledState()
  }

  completeMessage(delivery: AcknowledgedDelivery<unknown>): void {
    this.process.completeCompiledMessage(delivery)
  }

  commit(state: unknown): Effect.Effect<void> | undefined {
    return this.process.commitCompiledState(state)
  }

  runAfterChanges<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    this.process.flushPendingChanges()
    return effect
  }
}

const startCompactCompiledInternal: typeof startGenericInternal = Effect.fnUntraced(function*(
  logic: ProcessLogic<any, any, any, any, any, any>,
  options: StartInternalOptions
) {
  const sessionId = options.sessionId ?? (yield* options.runtime.nextSessionId)
  const services = yield* Effect.context<any>()
  const execution = logic.execution as CompiledProcessExecution<any, any, any, any, any, any>
  const process = new CompiledProcess(logic, options, services, sessionId)
  // A compiled initializer is synchronous by construction. Only startup
  // callbacks that themselves return Effects need the generic initialization
  // program; the compiled drain is still provided the complete service context.
  const initialize = execution.initialSync !== undefined &&
      options.onReady === undefined && options.onSnapshot === undefined
    ? process.initializeCompiledSync()
    : process.initialize()
  return yield* initialize.pipe(
    Effect.onExit((exit) => Exit.isFailure(exit) ? process.shutdownEmissions() : Effect.void)
  )
}) as typeof startGenericInternal

const startLogicInternal: typeof startGenericInternal = ((
  logic: ProcessLogic<any, any, any, any, any, any>,
  options: StartInternalOptions
) =>
  logic.execution?._tag === "Compiled"
    ? startCompactCompiledInternal(logic, options)
    : startGenericInternal(logic, options)) as typeof startGenericInternal

export type ProcessRuntimeStrategy = "generic" | "compiled" | "auto"

const startProcessWithStrategy = Effect.fnUntraced(function*(
  logic: ProcessLogic<any, any, any, any, any, any>,
  strategy: ProcessRuntimeStrategy,
  options?: {
    readonly id?: string
  }
) {
  const runtime = yield* makeProcessRuntime
  const internalOptions: StartInternalOptions = options === undefined
    ? {
      detached: true,
      runtime
    }
    : {
      ...options,
      detached: true,
      runtime
    }
  if (strategy === "generic") {
    return yield* startGenericInternal(logic, internalOptions)
  }
  if (strategy === "compiled") {
    if (logic.execution?._tag !== "Compiled") {
      return yield* Effect.die(new Error("Machine cannot force the compiled runtime for generic process logic"))
    }
    return yield* startCompactCompiledInternal(logic, internalOptions)
  }
  return yield* startLogicInternal(logic, internalOptions)
})

/** @internal Test-only startup strategy selection. */
export const startProcessWithStrategyForTesting = <
  State,
  Event,
  Error = never,
  Requirements = never,
  Output = never,
  InitialError = never
>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  strategy: ProcessRuntimeStrategy,
  options?: {
    readonly id?: string
  }
): Effect.Effect<
  MachineRef<State, Event, Error, Output>,
  InitialError,
  Requirements
> => startProcessWithStrategy(logic, strategy, options) as any

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

const prepareProcessWithStrategy = Effect.fnUntraced(function*<
  State,
  Event,
  Error,
  Requirements,
  Output,
  InitialError,
  Emitted
>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  strategy: ProcessRuntimeStrategy,
  options?: {
    readonly id?: string
  }
) {
  const runtime = yield* makeProcessRuntime
  const sessionId = yield* runtime.nextSessionId
  const emissions = makeEmissionRuntime()
  const started = yield* Deferred.make<MachineRef<State, Event, Error, Output, Emitted>, InitialError>()
  const internalOptions: StartInternalOptions = options === undefined
    ? {
      detached: true,
      emissions,
      runtime,
      sessionId
    }
    : {
      ...options,
      detached: true,
      emissions,
      runtime,
      sessionId
    }
  const initialize = strategy === "generic"
    ? startGenericInternal(logic, internalOptions)
    : strategy === "compiled"
    ? logic.execution?._tag === "Compiled"
      ? startCompactCompiledInternal(logic, internalOptions)
      : Effect.die(new Error("Machine cannot force the compiled runtime for generic process logic"))
    : startLogicInternal(logic, internalOptions)
  const start = yield* Effect.cached(
    initialize.pipe(
      Effect.onExit((exit) => Deferred.done(started, exit))
    ) as Effect.Effect<MachineRef<State, Event, Error, Output, Emitted>, InitialError, Requirements>
  )
  return {
    id: options?.id ?? sessionId,
    sessionId,
    changes: Stream.unwrap(
      Deferred.await(started).pipe(Effect.map((ref) => ref.changes))
    ),
    emissions: emissions.stream as Stream.Stream<Emitted>,
    start
  }
})

export const prepareProcess: <
  State,
  Event,
  Error = never,
  Requirements = never,
  Output = never,
  InitialError = never,
  Emitted = never
>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  options?: {
    readonly id?: string
  }
) => Effect.Effect<
  PreparedProcess<State, Event, Error, Output, Emitted, InitialError, Requirements>
> =
  ((logic: ProcessLogic<any, any, any, any, any, any>, options?: { readonly id?: string }) =>
    prepareProcessWithStrategy(logic, "auto", options)) as any

/** @internal Test-only prepared startup strategy selection. */
export const prepareProcessWithStrategyForTesting = <
  State,
  Event,
  Error = never,
  Requirements = never,
  Output = never,
  InitialError = never,
  Emitted = never
>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  strategy: ProcessRuntimeStrategy,
  options?: {
    readonly id?: string
  }
): Effect.Effect<
  PreparedProcess<State, Event, Error, Output, Emitted, InitialError, Requirements>
> => prepareProcessWithStrategy(logic, strategy, options) as any
