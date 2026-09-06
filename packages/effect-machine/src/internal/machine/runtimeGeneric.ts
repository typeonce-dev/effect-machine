/** General Effect process worker and supervisor strategy. */
import * as Cause from "effect/Cause"
import * as Channel from "effect/Channel"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import * as SynchronizedRef from "effect/SynchronizedRef"
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
  classifyOutcome,
  executionIsChildless,
  failAcknowledgedMessage,
  type InspectedOffer,
  inspectionSubject,
  isAcknowledgedMessage,
  isMachineTarget,
  type MachineRef,
  makeChildRuntime,
  makeEmissionRuntime,
  makeInspectedMessage,
  messageCausation,
  messageEvent,
  noCausation,
  noInspectInitial,
  noParentSend,
  notifyActiveSnapshot,
  type ProcessAddress,
  type ProcessContext,
  type ProcessLogic,
  type ProcessMessage,
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

// `Machine.logic` permits an arbitrary Effect program, including programs that
// suspend or supervise their own fibers. Keep its two-fiber worker/supervisor
// protocol as the general contract rather than weakening it for statecharts.
export const startGenericInternal: StartProcess = Effect.fnUntraced(
  function*<State, Event, Error, Requirements, Output, InitialError>(
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
    const inspector = runtime.inspection
    const subject = inspector === undefined ? undefined : inspectionSubject(logic, id, sessionId)
    const activity: Inspection.Activity | undefined = inspector === undefined || options.activity === undefined
      ? undefined
      : { ...options.activity, sessionId }
    let initialEntryPaths: ReadonlyArray<string> | undefined
    let initialMicrosteps: ReadonlyArray<unknown> | undefined
    const queue = yield* Queue.unbounded<ProcessMessage<Event>>()
    const emissions = options.emissions ?? makeEmissionRuntime()
    const termination = yield* Deferred.make<ProcessTermination>()
    const done = yield* Deferred.make<Output, Error | StoppedError>()
    const awaitCompletion = Deferred.await(done).pipe(Effect.exit, Effect.asVoid)
    let initializing = true
    let inFlightMessage: ProcessMessage<Event> | undefined
    const requestStop = Deferred.succeed(termination, { _tag: "Stopped" }).pipe(Effect.asVoid)
    const offerDirect = (message: ProcessMessage<Event>): Effect.Effect<void, StoppedError> =>
      Queue.offer(queue, message).pipe(
        Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(new StoppedError()))
      )
    const offerInspected: InspectedOffer<Event> | undefined = inspector === undefined ? undefined : (
      event,
      source,
      causedBy,
      deferred?: Deferred.Deferred<AcknowledgedDelivery<unknown>, unknown>
    ) =>
      Effect.suspend(() => {
        const message: ProcessMessage<Event> = inspector.isActive()
          ? makeInspectedMessage(inspector, subject!, event, source, causedBy, deferred)
          : deferred === undefined
          ? event
          : { [AcknowledgedMessageTypeId]: true as const, event, deferred }
        return offerDirect(message).pipe(
          Effect.tap(() => Effect.sync(() => publishInspectedSent(inspector, subject!, message)))
        )
      })
    const sendAcknowledged:
      | ((event: Event) => Effect.Effect<AcknowledgedDelivery<State>, Error | StoppedError>)
      | undefined = logic.execution?._tag !== "Compiled"
        ? undefined
        : (event) =>
          Effect.uninterruptibleMask((restore) =>
            Deferred.make<AcknowledgedDelivery<unknown>, unknown>().pipe(
              Effect.flatMap((deferred) => {
                const offered = inspector === undefined
                  ? offerDirect({ [AcknowledgedMessageTypeId]: true as const, event, deferred })
                  : offerInspected!(event, undefined, undefined, deferred)
                return offered.pipe(Effect.andThen(restore(Deferred.await(deferred))))
              }),
              Effect.map((delivery) => delivery as AcknowledgedDelivery<State>)
            )
          ) as Effect.Effect<AcknowledgedDelivery<State>, Error | StoppedError>

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
      send: inspector === undefined
        ? (event) => offerDirect(event)
        : (event) => offerInspected!(event, undefined, undefined),
      ...(inspector === undefined
        ? undefined
        : { inspectionSubject: subject!, sendInspected: offerInspected! })
    }

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
      } = yield* makeChildRuntime(
        self,
        runtime,
        undefined,
        sendAcknowledged === undefined ? undefined : (event) => sendAcknowledged(event as Event)
      ))
    }
    const cleanupStartupFailure = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> => {
      if (Exit.isSuccess(exit)) return Effect.void
      if (inspector !== undefined) {
        inspector.publishUnsafe(
          activity === undefined
            ? { _tag: "StartFailed", subject: subject!, cause: exit.cause }
            : { _tag: "ActivityStopped", subject: activity.owner, activity, exit }
        )
      }
      return closeChildren(exit).pipe(
        Effect.andThen(emissions.close()),
        Effect.andThen(options.inspectionRoot === true && inspector !== undefined ? inspector.close : Effect.void)
      )
    }
    const cleanup = onStopSync === undefined ? onStop ?? Effect.void : Effect.sync(onStopSync)
    const currentCausation = inspector === undefined
      ? noCausation
      : (): Inspection.Causation | undefined => messageCausation(inFlightMessage, initializing)
    const sendParent = overrideSendParent ?? (parent === undefined
      ? noParentSend
      : inspector === undefined
      ? parent.send
      : (event) => sendMachineTarget(parent, event, subject, currentCausation()))
    const emit = inspector === undefined
      ? emissions.emit
      : (event: unknown) =>
        emissions.emit(event).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              inspector.publishUnsafe({
                _tag: "Emitted",
                subject: subject!,
                emission: event,
                causedBy: currentCausation()
              })
            )
          )
        )
    const sendToTarget: ProcessScope<Event>["sendTo"] = inspector === undefined
      ? ((target: unknown, event: unknown) =>
        isMachineTarget(target) ? target.send(event) : sendTo(target as ChildSelector, event)) as ProcessScope<
          Event
        >["sendTo"]
      : ((target: unknown, event: unknown) =>
        isMachineTarget(target)
          ? sendMachineTarget(target, event, subject, currentCausation())
          : sendTo(target as ChildSelector, event, subject, currentCausation())) as ProcessScope<Event>["sendTo"]

    const scope: ProcessScope<Event> = {
      self,
      parent,
      spawn,
      sendParent,
      emit,
      sendTo: sendToTarget,
      stopChild,
      failCause: (cause) =>
        Deferred.succeed(termination, {
          _tag: "Failure",
          cause: cause as Cause.Cause<Error>
        }).pipe(Effect.asVoid),
      inspectInitial: inspector === undefined
        ? noInspectInitial
        : (paths, microsteps = []) => {
          initialEntryPaths = paths
          initialMicrosteps = microsteps
        }
    }

    if (inspector !== undefined) {
      inspector.publishUnsafe(
        activity === undefined
          ? {
            _tag: "Created",
            subject: subject!,
            parent: parent?.inspectionSubject,
            origin: options.origin ?? { _tag: "Root" },
            definition: logic.inspection?.definition
          }
          : { _tag: "ActivityStarted", subject: activity.owner, activity }
      )
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
    if (activity === undefined) {
      inspector?.publishUnsafe({
        _tag: "Initialized",
        subject: subject!,
        snapshot: { status: "active", state: initial },
        initialEntryPaths: initialEntryPaths ?? [],
        microsteps: InspectionRuntime.microsteps({ microsteps: initialMicrosteps ?? [] })
      })
    }
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
        Effect.flatMap((versioned) =>
          versioned === undefined ? Effect.succeed(undefined) : publishIfCurrent(versioned)
        ),
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

    const setActiveStateDirect = (state: State) =>
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

    const setActiveState = inspector === undefined ?
      setActiveStateDirect :
      (state: State) =>
        SynchronizedRef.get(current).pipe(
          Effect.flatMap((before) =>
            updateSnapshot((snapshot) =>
              Effect.succeed(
                snapshot.status === "active"
                  ? {
                    status: "active",
                    state
                  }
                  : undefined
              )
            ).pipe(
              Effect.tap((after) =>
                Effect.sync(() => {
                  if (logic.inspection?.kind === "Machine" || after === undefined) return
                  inspector.publishUnsafe({
                    _tag: "StateChanged",
                    subject: subject!,
                    before: before.snapshot.state,
                    after: state,
                    causedByDeliveryId: inFlightMessage !== undefined && isAcknowledgedMessage(inFlightMessage)
                      ? inFlightMessage.inspection?.deliveryId
                      : undefined
                  })
                })
              )
            )
          ),
          Effect.asVoid
        )

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
      const closeEmissionsAndInspect = inspector === undefined
        ? emissions.close()
        : emissions.close().pipe(
          Effect.andThen(Effect.sync(() =>
            inspector.publishUnsafe(
              activity === undefined
                ? { _tag: "Terminated", subject: subject!, snapshot }
                : {
                  _tag: "ActivityStopped",
                  subject: activity.owner,
                  activity,
                  exit: snapshot.status === "stopped" ? Exit.interrupt() : exit
                }
            )
          ))
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
          Effect.andThen(closeEmissionsAndInspect),
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
          Effect.andThen(options.inspectionRoot === true && inspector !== undefined ? inspector.close : Effect.void),
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
    const receive = inspector === undefined || logic.execution?._tag === "Compiled"
      ? Queue.take(queue).pipe(Effect.map(messageEvent))
      : Queue.take(queue).pipe(
        Effect.tap((message) =>
          Effect.sync(() => {
            inFlightMessage = message
          })
        ),
        Effect.map(messageEvent)
      )
    const poll = inspector === undefined || logic.execution?._tag === "Compiled"
      ? Queue.poll(queue).pipe(Effect.map(Option.map(messageEvent)))
      : Queue.poll(queue).pipe(
        Effect.tap((message) =>
          Effect.sync(() => {
            if (Option.isSome(message)) inFlightMessage = message.value
          })
        ),
        Effect.map(Option.map(messageEvent))
      )
    const updateStateDirect = <E2, R2>(f: (state: State) => Effect.Effect<State, E2, R2>) =>
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
    const updateState: ProcessContext<State, Event>["updateState"] = inspector === undefined
      ? updateStateDirect
      : (f) =>
        SynchronizedRef.get(current).pipe(
          Effect.flatMap((before) =>
            updateSnapshot((snapshot) =>
              snapshot.status === "active"
                ? f(snapshot.state).pipe(
                  Effect.map((state) => ({
                    status: "active" as const,
                    state
                  }))
                )
                : Effect.succeed(undefined)
            ).pipe(
              Effect.tap((after) =>
                Effect.sync(() => {
                  if (logic.inspection?.kind === "Machine" || after?.status !== "active") return
                  inspector.publishUnsafe({
                    _tag: "StateChanged",
                    subject: subject!,
                    before: before.snapshot.state,
                    after: after.state,
                    causedByDeliveryId: inFlightMessage !== undefined && isAcknowledgedMessage(inFlightMessage)
                      ? inFlightMessage.inspection?.deliveryId
                      : undefined
                  })
                })
              )
            )
          ),
          Effect.asVoid
        )
    const context: ProcessContext<State, Event> = {
      ...scope,
      ...(logic.execution?._tag === "Compiled" && !logic.execution.childless ? { ownedChildren } : undefined),
      ...acknowledgedContext,
      receive,
      poll,
      state: SynchronizedRef.get(current).pipe(Effect.map((current) => current.snapshot.state)),
      setState: setActiveState,
      updateState
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
      ...(inspector === undefined
        ? undefined
        : { inspectionSubject: subject!, sendInspected: offerInspected! }),
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
  }
)
