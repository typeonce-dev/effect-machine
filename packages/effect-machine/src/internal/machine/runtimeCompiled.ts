/** Compiled statechart execution strategy. */
import * as Cause from "effect/Cause"
import * as Channel from "effect/Channel"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Stream from "effect/Stream"
import type * as Take from "effect/Take"
import type { Inspection } from "../../Machine.js"
import { type ChildSelector } from "./childRegistry.js"
import { StoppedError } from "./errors.js"
import * as InspectionRuntime from "./inspectionRuntime.js"
import {
  type AcknowledgedDelivery,
  AcknowledgedMessageTypeId,
  acknowledgedSend,
  childlessRuntime,
  type ChildRuntime,
  classifyOutcome,
  closeCompactMailbox,
  type CompactProcessMailbox,
  type CompiledProcessContext,
  type CompiledProcessExecution,
  type CompiledProcessInitial,
  type EmissionRuntime,
  EmissionsClosed,
  failAcknowledgedMessage,
  inspectionSubject,
  isAcknowledgedMessage,
  isMachineTarget,
  type LazyEmissions,
  type MachineRef,
  makeChildRuntime,
  makeChildRuntimeSync,
  makeInspectedMessage,
  messageCausation,
  messageEvent,
  noInspectInitial,
  noParentSend,
  notifyActiveSnapshot,
  offerCompactMailbox,
  type OwnedChildRuntime,
  pollCompactMailbox,
  type ProcessAddress,
  type ProcessContext,
  type ProcessLogic,
  type ProcessMessage,
  type ProcessRuntime,
  type ProcessScope,
  publishInspectedSent,
  type RuntimeSnapshot,
  sendMachineTarget,
  type StartInternalOptions,
  type StartProcess,
  stopAcknowledgedMessage,
  succeedAcknowledgedMessage,
  type VersionedSnapshot
} from "./runtimeProtocol.js"

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
  readonly inspectionSubject?: Inspection.Subject
  readonly send: (event: unknown) => Effect.Effect<void, StoppedError>
  sendInspected(
    event: unknown,
    source: Inspection.Subject | undefined,
    causedBy: Inspection.Causation | undefined
  ): Effect.Effect<void, StoppedError> {
    return this.offerEvent(event, source, causedBy)
  }
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
  private readonly activity?: Inspection.Activity
  private initialEntryPaths?: ReadonlyArray<string>
  private initialMicrosteps?: ReadonlyArray<unknown>
  private initializing?: boolean

  constructor(
    private readonly logic: ProcessLogic<any, any, any, any, any, any>,
    private readonly options: StartInternalOptions,
    private readonly services: Context.Context<any>,
    sessionId: string
  ) {
    this.sessionId = sessionId
    this.id = options.id ?? sessionId
    const inspector = options.runtime.inspection
    if (inspector !== undefined) {
      this.inspectionSubject = inspectionSubject(logic, this.id, sessionId)
      this.initializing = true
      if (options.activity !== undefined) this.activity = { ...options.activity, sessionId }
    }
    this.externalEmissions = options.emissions
    this.send = inspector === undefined
      ? (event) => this.offerMessage(event)
      : (event) => this.offerEvent(event, undefined, undefined)
    this.address = {
      id: this.id,
      sessionId,
      stop: Effect.suspend(() => this.stopFromProcess()),
      send: this.send,
      ...(inspector === undefined
        ? undefined
        : {
          inspectionSubject: this.inspectionSubject!,
          sendInspected: (
            event: unknown,
            source: Inspection.Subject | undefined,
            causedBy: Inspection.Causation | undefined
          ) => this.offerEvent(event, source, causedBy)
        })
    }
  }

  private get inspector(): InspectionRuntime.Runtime | undefined {
    return this.options.runtime.inspection
  }

  private causation(): Inspection.Causation | undefined {
    return messageCausation(this.inFlightMessage, this.initializing === true)
  }

  private publishCreated(): void {
    const inspector = this.inspector
    const subject = this.inspectionSubject
    if (inspector === undefined || subject === undefined) return
    inspector.publishUnsafe(
      this.activity === undefined
        ? {
          _tag: "Created",
          subject,
          parent: this.options.parent?.inspectionSubject,
          origin: this.options.origin ?? { _tag: "Root" },
          definition: this.logic.inspection?.definition
        }
        : { _tag: "ActivityStarted", subject: this.activity.owner, activity: this.activity }
    )
  }

  private publishInitialized(state: unknown): void {
    this.initializing = false
    if (this.activity !== undefined) return
    const inspector = this.inspector
    const subject = this.inspectionSubject
    if (inspector === undefined || subject === undefined) return
    inspector.publishUnsafe({
      _tag: "Initialized",
      subject,
      snapshot: { status: "active", state },
      initialEntryPaths: this.initialEntryPaths ?? [],
      microsteps: InspectionRuntime.microsteps({ microsteps: this.initialMicrosteps ?? [] })
    })
  }

  private publishStartFailed(cause: Cause.Cause<unknown>): void {
    this.initializing = false
    const inspector = this.inspector
    const subject = this.inspectionSubject
    if (inspector === undefined || subject === undefined) return
    inspector.publishUnsafe(
      this.activity === undefined
        ? { _tag: "StartFailed", subject, cause }
        : {
          _tag: "ActivityStopped",
          subject: this.activity.owner,
          activity: this.activity,
          exit: Exit.failCause(cause)
        }
    )
  }

  private get execution(): CompiledProcessExecution<any, any, any, any, any, any> {
    return this.logic.execution as CompiledProcessExecution<any, any, any, any, any, any>
  }

  initializeCompiledSync(): Effect.Effect<MachineRef<any, any, any, any>, unknown> {
    this.publishCreated()
    if (!this.execution.childless) {
      this.childRuntime = makeChildRuntimeSync(
        this.address,
        this.options.runtime,
        this.services,
        (event) => this.sendAcknowledgedEffect(event)
      )
    }
    const parent = this.options.parent
    const sendParent = this.options.sendParent ?? (parent === undefined
      ? noParentSend
      : this.inspector === undefined
      ? parent.send
      : (event: unknown) => sendMachineTarget(parent, event, this.inspectionSubject, this.causation()))
    this.processScope = {
      self: this.address,
      parent,
      spawn: this.childRuntime.spawn,
      sendParent,
      emit: (event) => this.emitEvent(event),
      sendTo: ((target: unknown, event: unknown) =>
        isMachineTarget(target)
          ? this.inspector === undefined
            ? target.send(event)
            : sendMachineTarget(target, event, this.inspectionSubject, this.causation())
          : this.childRuntime.sendTo(
            target as ChildSelector,
            event,
            this.inspectionSubject,
            this.causation()
          )) as ProcessScope<unknown>["sendTo"],
      stopChild: this.childRuntime.stop,
      failCause: (cause: Cause.Cause<unknown>) => this.failCause(cause),
      inspectInitial: this.inspector === undefined
        ? noInspectInitial
        : (paths, microsteps = []) => {
          this.initialEntryPaths = paths
          this.initialMicrosteps = microsteps
        }
    }
    const compiledInitial = this.execution.initialSync!
    let initialized: CompiledInitialized
    try {
      initialized = compiledInitial(this.processScope)
    } catch (error) {
      this.runState = "Idle"
      this.publishStartFailed(Cause.fail(error))
      return Effect.fail(error)
    }
    this.runState = "Idle"
    this.current = {
      revision: 0,
      terminalizing: false,
      changes: undefined,
      snapshot: { status: "active", state: initialized.state }
    }
    this.publishInitialized(initialized.state)
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
      self.publishCreated()
      if (!self.execution.childless) {
        self.childRuntime = yield* makeChildRuntime(
          self.address,
          self.options.runtime,
          self.services,
          (event) => self.sendAcknowledgedEffect(event)
        )
      }
      const parent = self.options.parent
      const sendParent = self.options.sendParent ?? (parent === undefined
        ? noParentSend
        : self.inspector === undefined
        ? parent.send
        : (event: unknown) => sendMachineTarget(parent, event, self.inspectionSubject, self.causation()))
      self.processScope = {
        self: self.address,
        parent,
        spawn: self.childRuntime.spawn,
        sendParent,
        emit: (event) => self.emitEvent(event),
        sendTo: ((target: unknown, event: unknown) =>
          isMachineTarget(target)
            ? self.inspector === undefined
              ? target.send(event)
              : sendMachineTarget(target, event, self.inspectionSubject, self.causation())
            : self.childRuntime.sendTo(
              target as ChildSelector,
              event,
              self.inspectionSubject,
              self.causation()
            )) as ProcessScope<unknown>["sendTo"],
        stopChild: self.childRuntime.stop,
        failCause: (cause: Cause.Cause<unknown>) => self.failCause(cause),
        inspectInitial: self.inspector === undefined
          ? noInspectInitial
          : (paths, microsteps = []) => {
            self.initialEntryPaths = paths
            self.initialMicrosteps = microsteps
          }
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
        Effect.onExit((exit) => {
          if (Exit.isFailure(exit)) self.publishStartFailed(exit.cause)
          return cleanupStartupFailure(exit)
        }),
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
      self.publishInitialized(initial)
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
          this.offerEvent(event, undefined, undefined, deferred).pipe(
            Effect.andThen(restore(Deferred.await(deferred)))
          )
        )
      )
    )
  }

  private offerEvent(
    event: unknown,
    source: Inspection.Subject | undefined,
    causedBy: Inspection.Causation | undefined,
    deferred?: Deferred.Deferred<AcknowledgedDelivery<unknown>, unknown>
  ): Effect.Effect<void, StoppedError> {
    return Effect.suspend(() => {
      const inspector = this.inspector
      const subject = this.inspectionSubject
      const message: ProcessMessage<unknown> = inspector?.isActive() === true && subject !== undefined
        ? makeInspectedMessage(
          inspector,
          subject,
          event,
          source,
          causedBy,
          deferred
        )
        : deferred === undefined
        ? event
        : { [AcknowledgedMessageTypeId]: true as const, event, deferred }
      return this.offerMessage(message)
    })
  }

  private offerMessage(message: ProcessMessage<unknown>): Effect.Effect<void, StoppedError> {
    return Effect.uninterruptible(
      Effect.suspend(() => {
        if (this.mailbox.closed || this.lifecycle !== "Active") {
          return Effect.fail(new StoppedError())
        }
        offerCompactMailbox(this.mailbox, message)
        const inspector = this.inspector
        const subject = this.inspectionSubject
        if (inspector !== undefined && subject !== undefined) publishInspectedSent(inspector, subject, message)
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
      this.inspector !== undefined ||
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
      const inspector = this.inspector
      const subject = this.inspectionSubject
      const closeEmissionsAndInspect = inspector === undefined || subject === undefined
        ? this.closeEmissions()
        : this.closeEmissions().pipe(
          Effect.andThen(Effect.sync(() =>
            inspector.publishUnsafe(
              this.activity === undefined
                ? { _tag: "Terminated", subject, snapshot }
                : {
                  _tag: "ActivityStopped",
                  subject: this.activity.owner,
                  activity: this.activity,
                  exit: snapshot.status === "stopped" ? Exit.interrupt() : exit
                }
            )
          ))
        )
      return Effect.uninterruptible(
        Effect.sync(() => {
          closeCompactMailbox(this.mailbox)
        }).pipe(
          Effect.andThen(this.childRuntime.close(exit)),
          Effect.andThen(this.setAndPublishSnapshot(snapshot)),
          Effect.andThen(closeEmissionsAndInspect),
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
          Effect.andThen(
            this.options.inspectionRoot === true && this.inspector !== undefined
              ? this.inspector.close
              : Effect.void
          ),
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
    const publish = this.externalEmissions !== undefined ?
      this.externalEmissions.emit(event) :
      Effect.suspend(() =>
        this.emissionsPubSub === undefined || this.emissionsPubSub === EmissionsClosed
          ? Effect.void
          : PubSub.publish(this.emissionsPubSub, event).pipe(Effect.asVoid)
      )
    const inspector = this.inspector
    const subject = this.inspectionSubject
    if (inspector === undefined || subject === undefined) return publish
    return publish.pipe(Effect.tap(() =>
      Effect.sync(() =>
        inspector.publishUnsafe({
          _tag: "Emitted",
          subject,
          emission: event,
          causedBy: this.causation()
        })
      )
    ))
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

export const startCompactCompiledInternal: StartProcess = Effect.fnUntraced(function*(
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
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? process.shutdownEmissions().pipe(
          Effect.andThen(
            options.inspectionRoot === true && options.runtime.inspection !== undefined
              ? options.runtime.inspection.close
              : Effect.void
          )
        )
        : Effect.void
    )
  )
}) as StartProcess

/** Preserves synchronous startup for owned compiled children. */
export const startCompiledSync: ProcessRuntime["startCompiledSync"] = (logic, options, services, sessionId) =>
  new CompiledProcess(logic, options, services, sessionId).initializeCompiledSync()

type CompiledTermination =
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Done"; readonly output: unknown }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }

type CompiledInitialized = CompiledProcessInitial<unknown, unknown>

// Stopping is commonly used only for resource cleanup. Keep that path free of
// Error stack capture and materialize the typed join failure only if observed.
