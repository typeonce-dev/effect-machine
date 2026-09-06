/** Shared local process contracts, ownership, and observation. */
import * as Cause from "effect/Cause"
import * as Channel from "effect/Channel"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as Take from "effect/Take"
import type {
  MachineRef as PublicMachineRef,
  Prepared as PublicPrepared,
  RuntimeOutcome as PublicRuntimeOutcome,
  RuntimeSnapshot as PublicRuntimeSnapshot
} from "../../Machine.js"
import type { ChildMachine, Inspection, Machine as MachineDefinition, MachineTarget } from "../../Machine.js"
import {
  type ChildDescriptor,
  type ChildEntry,
  type ChildKey,
  type ChildObserver,
  type ChildRegistry,
  type ChildSelector,
  matchesChild,
  offerChildObservation,
  registerChild,
  selectRegistryChild,
  takeChildObservations,
  unregisterChild
} from "./childRegistry.js"
import { ChildAlreadyExistsError, StoppedError } from "./errors.js"
import * as InspectionRuntime from "./inspectionRuntime.js"
import { ChildMachineLogicTypeId } from "./symbols.js"

/** @internal */
export const activeSnapshotObserver: unique symbol = Symbol.for("effect/Machine/activeSnapshotObserver")

/** @internal */
const sendParentOverride: unique symbol = Symbol.for("effect/Machine/sendParentOverride")

/** @internal */
export const acknowledgedSend: unique symbol = Symbol.for("effect/Machine/acknowledgedSend")

/** @internal */
export interface AcknowledgedDelivery<State> {
  readonly before: State
  readonly plan: unknown
  readonly after: State
}

export const AcknowledgedMessageTypeId: unique symbol = Symbol("effect/Machine/AcknowledgedMessage")

/** @internal */
interface AcknowledgedMessage<Event> {
  readonly [AcknowledgedMessageTypeId]: true
  readonly event: Event
  readonly deferred?: Deferred.Deferred<AcknowledgedDelivery<unknown>, unknown>
  readonly inspection?: InspectedDelivery
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

export const succeedAcknowledgedMessage = <State>(
  message: ProcessMessage<unknown> | undefined,
  delivery: AcknowledgedDelivery<State>
): void => {
  if (message !== undefined && isAcknowledgedMessage(message)) {
    if (message.deferred !== undefined) {
      Deferred.doneUnsafe(message.deferred, Effect.succeed(delivery as AcknowledgedDelivery<unknown>))
    }
    message.inspection?.complete(delivery as AcknowledgedDelivery<unknown>)
  }
}

export const failAcknowledgedMessage = (
  message: ProcessMessage<unknown> | undefined,
  cause: Cause.Cause<unknown>
): void => {
  if (message !== undefined && isAcknowledgedMessage(message)) {
    if (message.deferred !== undefined) Deferred.doneUnsafe(message.deferred, Effect.failCause(cause))
  }
}

export const stopAcknowledgedMessage = (message: ProcessMessage<unknown> | undefined): void => {
  if (message !== undefined && isAcknowledgedMessage(message)) {
    if (message.deferred !== undefined) Deferred.doneUnsafe(message.deferred, Effect.fail(new StoppedError()))
  }
}

interface InspectedDelivery {
  readonly deliveryId: number
  readonly macrostepId: number
  readonly source: Inspection.Subject | undefined
  readonly event: unknown
  readonly causedBy: Inspection.Causation | undefined
  readonly complete: (delivery: AcknowledgedDelivery<unknown>) => void
}

export type InspectedOffer<Event> = (
  event: Event,
  source: Inspection.Subject | undefined,
  causedBy: Inspection.Causation | undefined,
  deferred?: Deferred.Deferred<AcknowledgedDelivery<unknown>, unknown>
) => Effect.Effect<void, StoppedError>

export type RuntimeSnapshot<State, Error = never, Output = never> = PublicRuntimeSnapshot<State, Error, Output>

export interface VersionedSnapshot<State, Error, Output> {
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

export type RuntimeOutcome<State, Error = never, Output = never> = PublicRuntimeOutcome<State, Error, Output>

export interface MachineRef<out State, in Event, out Error = never, out Output = never, out Emitted = never>
  extends Omit<PublicMachineRef<State, Event, Error, Output, Emitted>, "child" | "childChanges">
{
  /** @internal */
  readonly inspectionSubject?: Inspection.Subject
  /** @internal */
  readonly sendInspected?: ProcessAddress<Event>["sendInspected"]
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
> extends Omit<PublicPrepared<State, Event, Error, Output, Emitted, StartError, StartRequirements>, "start"> {
  readonly start: Effect.Effect<MachineRef<State, Event, Error, Output, Emitted>, StartError, StartRequirements>
}

export interface ProcessAddress<in Event> {
  readonly id: string
  readonly sessionId: string
  readonly inspectionSubject?: Inspection.Subject
  readonly stop: Effect.Effect<void>
  readonly send: (event: Event) => Effect.Effect<void, StoppedError>
  readonly sendInspected?: (
    event: Event,
    source: Inspection.Subject | undefined,
    causedBy: Inspection.Causation | undefined
  ) => Effect.Effect<void, StoppedError>
  readonly [acknowledgedSend]?: (
    event: Event
  ) => Effect.Effect<AcknowledgedDelivery<unknown>, unknown | StoppedError>
}

export const isMachineTarget = (value: unknown): value is MachineTarget<unknown> =>
  typeof value === "object" && value !== null && "send" in value && typeof value.send === "function"

export const sendMachineTarget = (
  target: MachineTarget<unknown>,
  event: unknown,
  source: Inspection.Subject | undefined,
  causedBy: Inspection.Causation | undefined
): Effect.Effect<void, StoppedError> =>
  "inspectionSubject" in target && "sendInspected" in target && typeof target.sendInspected === "function"
    ? target.sendInspected(event, source, causedBy)
    : target.send(event)

export interface ProcessScope<Event> {
  readonly self: ProcessAddress<Event>
  readonly parent: ProcessAddress<unknown> | undefined
  readonly spawn: ProcessSpawn<Event>
  readonly sendParent: (event: unknown) => Effect.Effect<void, StoppedError>
  readonly emit: (event: unknown) => Effect.Effect<void>
  readonly sendTo: {
    <TargetEvent>(target: MachineTarget<TargetEvent>, event: TargetEvent): Effect.Effect<void, StoppedError>
    (child: ChildSelector, event: unknown): Effect.Effect<void, StoppedError>
  }
  readonly stopChild: (child: ChildSelector) => Effect.Effect<void>
  /** @internal */
  readonly failCause: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
  /** @internal */
  readonly inspectInitial: (
    initialEntryPaths: ReadonlyArray<string>,
    microsteps?: ReadonlyArray<unknown>
  ) => void
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

export type CompiledProcessInitial<State, Output> =
  | { readonly state: State; readonly done: false; readonly output: undefined }
  | { readonly state: State; readonly done: true; readonly output: Output }
  | {
    readonly state: State
    readonly done: boolean
    readonly output: Output | undefined
    readonly executionState: unknown
  }

type CompiledProcessDrain<State, Event, Error, Requirements, Output> =
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

type ProcessExecution<State, Event, Error, Requirements, Output, InitialError> =
  | {
    readonly _tag: "Childless"
  }
  | CompiledProcessExecution<State, Event, Error, Requirements, Output, InitialError>

export const executionIsChildless = (
  execution: ProcessExecution<any, any, any, any, any, any> | undefined
): boolean => execution?._tag === "Childless" || execution?.childless === true

export interface CompactProcessMailbox<Event> {
  items: Array<ProcessMessage<Event>> | undefined
  index: number
  closed: boolean
}

export const offerCompactMailbox = <Event>(
  mailbox: CompactProcessMailbox<Event>,
  event: ProcessMessage<Event>
): void => {
  const items = mailbox.items ?? []
  mailbox.items = items
  items.push(event)
}

export const pollCompactMailbox = <Event>(
  mailbox: CompactProcessMailbox<Event>
): Option.Option<ProcessMessage<Event>> => {
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

export const closeCompactMailbox = (mailbox: CompactProcessMailbox<unknown>): void => {
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
  /** @internal */
  readonly inspection?: {
    readonly kind: Inspection.Subject["kind"]
    readonly definition?: MachineDefinition.Any
  }
  initial(scope: ProcessScope<Event>): Effect.Effect<State, InitialError, Requirements>
  run(context: ProcessContext<State, Event>): Effect.Effect<Output, Error, Requirements>
}

interface ProcessSpawn<OwnerEvent = unknown> {
  <const Child extends ChildMachine.Any>(
    child: Child & ChildMachine.Executable<Child> & ChildMachine.ParentCompatibility<Child, OwnerEvent>,
    ...options: ChildMachine.SpawnArgs<Child>
  ): Effect.Effect<
    ChildMachine.Ref<Child>,
    ChildAlreadyExistsError | ChildMachine.StartError<Child>,
    ChildMachine.StartRequirements<Child>
  >
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

export const classifyOutcome = <State, Error, Output>(
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

export const notifyActiveSnapshot = <State, Error, Output>(
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

export interface ProcessRuntime {
  readonly start: StartProcess
  readonly startCompiledSync: (
    logic: ProcessLogic<any, any, any, any, any, any>,
    options: StartInternalOptions,
    services: Context.Context<any>,
    sessionId: string
  ) => Effect.Effect<MachineRef<any, any, any, any>, any, any>
  readonly nextSessionId: Effect.Effect<string>
  inspection?: InspectionRuntime.Runtime
}

export const makeProcessRuntime = (
  start: StartProcess,
  startCompiledSync: ProcessRuntime["startCompiledSync"]
): Effect.Effect<ProcessRuntime> =>
  Effect.sync(() => {
    let sessionIdCounter = 0
    return {
      start,
      startCompiledSync,
      nextSessionId: Effect.sync(() => `machine:${sessionIdCounter++}`)
    }
  })

export const inspectionSubject = (
  logic: ProcessLogic<any, any, any, any, any, any>,
  id: string,
  sessionId: string
): Inspection.Subject => ({
  id,
  sessionId,
  kind: logic.inspection?.kind ?? "Logic"
})

export const messageCausation = (
  message: ProcessMessage<unknown> | undefined,
  initializing: boolean
): Inspection.Causation | undefined =>
  initializing
    ? { _tag: "Initialization" }
    : message !== undefined && isAcknowledgedMessage(message) && message.inspection !== undefined
    ? { _tag: "Macrostep", macrostepId: message.inspection.macrostepId }
    : undefined

export const makeInspectedMessage = <Event>(
  inspection: InspectionRuntime.Runtime,
  subject: Inspection.Subject,
  event: Event,
  source: Inspection.Subject | undefined,
  causedBy: Inspection.Causation | undefined,
  deferred?: Deferred.Deferred<AcknowledgedDelivery<unknown>, unknown>
): AcknowledgedMessage<Event> => {
  const deliveryId = inspection.nextDeliveryId()
  const macrostepId = inspection.nextMacrostepId()
  const inspected: InspectedDelivery = {
    deliveryId,
    macrostepId,
    source,
    event,
    causedBy,
    complete: (delivery) => {
      const microsteps = InspectionRuntime.microsteps(delivery.plan)
      inspection.publishUnsafe({
        _tag: "EventProcessed",
        subject,
        macrostepId,
        deliveryId,
        source,
        event,
        before: { status: "active", state: delivery.before },
        after: { status: "active", state: delivery.after },
        handled: microsteps.some((microstep) => microstep.transitions.length > 0),
        configurationChanged: microsteps.some((microstep) => microstep.changed),
        microsteps
      })
    }
  }
  return {
    [AcknowledgedMessageTypeId]: true,
    event,
    ...(deferred === undefined ? undefined : { deferred }),
    inspection: inspected
  }
}

export const publishInspectedSent = (
  inspection: InspectionRuntime.Runtime,
  subject: Inspection.Subject,
  message: ProcessMessage<unknown>
): void => {
  if (!isAcknowledgedMessage(message) || message.inspection === undefined) return
  const delivery = message.inspection
  inspection.publishUnsafe({
    _tag: "EventSent",
    subject,
    deliveryId: delivery.deliveryId,
    source: delivery.source,
    target: InspectionRuntime.endpoint(subject),
    event: delivery.event,
    causedBy: delivery.causedBy
  })
}

export interface StartInternalOptions {
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
  readonly origin?: Inspection.Origin
  readonly activity?: {
    readonly id: string
    readonly owner: Inspection.Subject
    readonly ownerPath: string
    readonly kind: Inspection.Activity["kind"]
  }
  readonly inspectionRoot?: boolean
}

/** @internal */
interface OwnedChildSpawnOptions {
  readonly key: string
  readonly path: string
  readonly id: string
  readonly duplicateId: string
  readonly descriptor?: ChildDescriptor
  readonly onOutcome: (
    isCurrent: () => boolean,
    outcome: RuntimeOutcome<any, any, any>,
    activitySessionId: string | undefined
  ) => Effect.Effect<void>
  readonly onSnapshot?: (
    isCurrent: () => boolean,
    snapshot: Extract<RuntimeSnapshot<any, any, any>, { readonly status: "active" }>
  ) => Effect.Effect<void>
  readonly sendParent: (
    isCurrent: () => boolean,
    event: unknown
  ) => Effect.Effect<void, StoppedError>
  readonly activityKind?: Inspection.Activity["kind"]
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

export interface ChildRuntime {
  readonly close: <A, E>(exit: Exit.Exit<A, E>) => Effect.Effect<void>
  readonly spawn: ProcessSpawn
  readonly get: <ChildState, ChildEvent, ChildError, ChildOutput>(
    child: ChildSelector
  ) => Effect.Effect<Option.Option<MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>>>
  readonly changes: <ChildState, ChildEvent, ChildError, ChildOutput>(
    child: ChildSelector
  ) => Stream.Stream<Option.Option<MachineRef<ChildState, ChildEvent, ChildError, ChildOutput>>>
  readonly sendTo: (
    child: ChildSelector,
    event: unknown,
    source?: Inspection.Subject,
    causedBy?: Inspection.Causation
  ) => Effect.Effect<void, StoppedError>
  readonly stop: (child: ChildSelector) => Effect.Effect<void>
  readonly owned: OwnedChildRuntime
}

class OwnedChildRuntimeImpl implements OwnedChildRuntime {
  private scopedServices: Context.Context<any> | undefined

  constructor(
    private readonly registry: ChildRegistry,
    private readonly self: ProcessAddress<any>,
    private readonly runtime: ProcessRuntime,
    private readonly services?: Context.Context<any>,
    private readonly sendAcknowledged?: (
      event: unknown
    ) => Effect.Effect<AcknowledgedDelivery<unknown>, unknown | StoppedError>
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
        send: (event) => options.sendParent(isCurrent, event),
        sendInspected: (event, source, causedBy) =>
          isCurrent() ? sendMachineTarget(this.self, event, source, causedBy) : Effect.void,
        ...(this.sendAcknowledged === undefined
          ? undefined
          : {
            [acknowledgedSend]: (event: unknown) =>
              isCurrent()
                ? this.sendAcknowledged!(event)
                : Effect.interrupt
          })
      }
      const startOptions: StartInternalOptions = {
        detached: true,
        id: options.id,
        sendParent: (event) => options.sendParent(isCurrent, event),
        onOutcome: (outcome) => options.onOutcome(isCurrent, outcome, startedChild?.sessionId),
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
        runtime: this.runtime,
        origin: { _tag: "Invoke", ownerPath: options.path, invokeId: options.duplicateId },
        ...(options.activityKind === undefined || this.runtime.inspection === undefined ||
            this.self.inspectionSubject === undefined
          ? undefined
          : {
            activity: {
              id: options.duplicateId,
              owner: this.self.inspectionSubject,
              ownerPath: options.path,
              kind: options.activityKind
            }
          })
      }
      const execution = logic.execution
      const synchronous = this.services !== undefined && options.onSnapshot === undefined &&
        execution?._tag === "Compiled" && execution.childless && execution.drain._tag === "Owned" &&
        execution.initialSync !== undefined
      const start = synchronous
        ? Effect.flatMap(
          this.runtime.nextSessionId,
          (sessionId) =>
            this.runtime.startCompiledSync(
              logic,
              startOptions,
              this.scopedServices ??= Context.add(this.services!, Scope.Scope, scope),
              sessionId
            )
        )
        : this.runtime.start(logic, startOptions)
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
export const noParentSend = (_event: unknown): Effect.Effect<void, StoppedError> => Effect.void
export const noInspectInitial = (_paths: ReadonlyArray<string>, _microsteps?: ReadonlyArray<unknown>): void => {}
export const noCausation = (): Inspection.Causation | undefined => undefined
export const EmissionsClosed: unique symbol = Symbol("effect/Machine/EmissionsClosed")

export type LazyEmissions = PubSub.PubSub<unknown> | typeof EmissionsClosed | undefined

export interface EmissionRuntime {
  readonly emit: (event: unknown) => Effect.Effect<void>
  readonly close: () => Effect.Effect<void>
  readonly stream: Stream.Stream<unknown>
}

export const makeEmissionRuntime = (): EmissionRuntime => {
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

export const childlessRuntime: ChildRuntime = {
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

export const makeChildRuntimeSync = (
  self: ProcessAddress<any>,
  runtime: ProcessRuntime,
  services?: Context.Context<any>,
  sendAcknowledged?: (
    event: unknown
  ) => Effect.Effect<AcknowledgedDelivery<unknown>, unknown | StoppedError>
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

  const sendTo = (
    child: ChildSelector,
    event: unknown,
    source?: Inspection.Subject,
    causedBy?: Inspection.Causation
  ): Effect.Effect<void, StoppedError> => {
    const id = typeof child === "string" ? child : child.id
    return Effect.suspend(() => {
      if (registry.closed) {
        return Effect.void
      }
      const entry = registry.children.get(id)
      return entry !== undefined && matchesChild(entry, child)
        ? sendMachineTarget(entry.ref, event, source, causedBy)
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

  function spawn<const Child extends ChildMachine.Any>(
    child: Child & ChildMachine.Executable<Child> & ChildMachine.ParentCompatibility<Child, unknown>,
    ...options: ChildMachine.SpawnArgs<Child>
  ): Effect.Effect<
    ChildMachine.Ref<Child>,
    ChildAlreadyExistsError | ChildMachine.StartError<Child>,
    ChildMachine.StartRequirements<Child>
  >
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
  function spawn(
    logicOrChild: ProcessLogic<any, any, any, any, any, any> | ChildMachine.Any,
    options?: {
      readonly id: string
      readonly descriptor?: ChildDescriptor
      readonly onOutcome?: (
        outcome: RuntimeOutcome<any, any, any>
      ) => Effect.Effect<void>
      readonly [activeSnapshotObserver]?: (
        snapshot: Extract<RuntimeSnapshot<any, any, any>, { readonly status: "active" }>
      ) => Effect.Effect<void>
      readonly [sendParentOverride]?: (event: unknown) => Effect.Effect<void, StoppedError>
    } | { readonly input?: unknown }
  ): Effect.Effect<MachineRef<any, any, any, any>, any, any> {
    const descriptor = typeof logicOrChild === "object" && logicOrChild !== null &&
        ChildMachineLogicTypeId in logicOrChild
      ? logicOrChild as ChildMachine.Any
      : undefined
    const logic = descriptor === undefined
      ? logicOrChild as ProcessLogic<any, any, any, any, any, any>
      : descriptor[ChildMachineLogicTypeId](
        (options as { readonly input?: unknown } | undefined)?.input
      ) as unknown as ProcessLogic<any, any, any, any, any, any>
    const spawnOptions = descriptor === undefined
      ? options as {
        readonly id: string
        readonly descriptor?: ChildDescriptor
        readonly onOutcome?: (outcome: RuntimeOutcome<any, any, any>) => Effect.Effect<void>
        readonly [activeSnapshotObserver]?: (
          snapshot: Extract<RuntimeSnapshot<any, any, any>, { readonly status: "active" }>
        ) => Effect.Effect<void>
        readonly [sendParentOverride]?: (event: unknown) => Effect.Effect<void, StoppedError>
      } | undefined
      : { id: descriptor.id, descriptor }
    const token = Symbol()
    const key = spawnOptions?.id ?? token
    let startedChild: MachineRef<any, any, any, any> | undefined
    return Effect.suspend(() => {
      if (registry.closed) {
        return Effect.interrupt
      }
      if (typeof key === "string" && registry.children.has(key)) {
        return Effect.fail(new ChildAlreadyExistsError({ id: key }))
      }
      registry.scope ??= Scope.makeUnsafe("parallel")
      registry.children.set(key, { _tag: "Starting", token })
      return runtime.start(logic, {
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
        runtime,
        origin: { _tag: "Spawn", address: spawnOptions?.id }
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
    owned: new OwnedChildRuntimeImpl(registry, self, runtime, services, sendAcknowledged)
  }
}

export const makeChildRuntime = (
  self: ProcessAddress<any>,
  runtime: ProcessRuntime,
  services?: Context.Context<any>,
  sendAcknowledged?: (
    event: unknown
  ) => Effect.Effect<AcknowledgedDelivery<unknown>, unknown | StoppedError>
): Effect.Effect<ChildRuntime> => Effect.sync(() => makeChildRuntimeSync(self, runtime, services, sendAcknowledged))

export type StartProcess = <
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
>
