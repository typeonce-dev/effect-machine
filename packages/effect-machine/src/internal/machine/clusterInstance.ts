/**
 * The live instance behind one active Cluster entity.
 *
 * @since 0.48.0
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type { EntityAddress, MessageStorage, Snowflake } from "effect/cluster"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type * as Machine from "../../Machine.js"
import type { Checkpoint } from "../../unstable/cluster/ClusterMachine.js"
import * as CapturedInvocation from "./capturedInvocation.js"
import { renderFailure } from "./clusterFailure.js"
import { ClusterKeepAlive, untilDone } from "./clusterKeepAlive.js"
import * as ClusterProgress from "./clusterProgress.js"
import { Accepted, Rejected, type RejectionReason, type Storage } from "./clusterProtocol.js"
import * as ClusterTarget from "./clusterTarget.js"
import * as ClusterTimer from "./clusterTimer.js"
import * as ClusterWork from "./clusterWork.js"
import * as Configuration from "./configuration.js"
import { toImpl } from "./implementation.js"
import * as InvocationChanges from "./invocationChanges.js"
import type { InvocationEvent } from "./invocationEvent.js"
import * as InvocationOutcome from "./invocationOutcome.js"
import * as InvocationResolution from "./invocationResolution.js"
import * as internalMachine from "./machine.js"
import * as Planner from "./planner.js"

type EntityAddress = EntityAddress.EntityAddress
type Snowflake = Snowflake.Snowflake
type Snapshot = Machine.Machine.Snapshot<any>
type SendResult = Accepted | Rejected
type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

/** One event to apply, under the id that deduplicates it in `Storage`. */
export interface Input {
  readonly requestId: Snowflake
  readonly event: unknown
}

/**
 * One live instance of a machine, owned by one set of entity handlers.
 *
 * Cluster builds the handlers when an entity becomes active, and again when a
 * defect restarts it, so an instance lives exactly as long as its handlers.
 *
 * It owns the decoded machine state, as a cache of what `Storage` holds:
 *
 * - Memory is either unknown, or the state of one stored revision. An unknown
 *   memory is loaded by the next turn.
 * - Requests, outcomes of work, and recovery are turns. Turns run one at a time,
 *   whatever the concurrency of their callers, and are the only way to advance
 *   the instance.
 * - Memory is forgotten when a step starts, and set again only by an ending
 *   that proves what `Storage` holds: the whole transaction succeeded, or the
 *   input was refused before a commit was attempted. Every other ending,
 *   including a defect or an interruption, leaves it unknown.
 * - Memory may fall behind `Storage` while another instance still runs during a
 *   shard handover. Nothing is decided from memory alone: an advance is
 *   compared by `Storage.commit`, and a refusal is confirmed with `Storage`.
 *
 * It owns the work of the stored state, and the keep-alive request of the
 * entity:
 *
 * - Both follow the stored state. They change at the end of a turn, after the
 *   state they belong to is known to be stored, never from a planned state.
 * - Running work belongs to one stored revision. A step from that revision stops
 *   and starts the work of the states it changed. Every other revision stops all
 *   work and starts it from the beginning, with the initial event.
 * - The end of work becomes a turn of its own. The turn decides what the outcome
 *   means against the state of that moment, so an outcome whose state exited is
 *   ignored.
 * - Work that this instance stops never reports an outcome, whatever stops it.
 * - A timer is work that waits for the due time stored with its state. A step
 *   stores the due times of the timers it enters, so work that starts finds
 *   them. A loaded state can lack one, when the deployment that stored it did
 *   not declare the timer. Its due time is stored as a checkpoint of its own
 *   before any work of that state starts.
 * - A duration that cannot be evaluated does not refuse its step. It fails the
 *   machine once the step is stored, when the timer would have started.
 * - An outcome the model does not handle, or that cannot be applied, stores the
 *   machine as failed. A failure of `Storage`, of its transaction, or of
 *   `enqueue` is retried for as long as the instance lives.
 * - Whenever a turn leaves memory or the keep-alive unknown, recovery loads and
 *   aligns them again without waiting for another input.
 *
 * Ending the scope of the instance stops its work, its recovery, and every turn
 * that has not started. The keep-alive request stays, so the entity comes up
 * again.
 *
 * @internal
 */
export interface ClusterInstance<R> {
  /**
   * Applies one input as one step and returns its reply.
   *
   * Only interruption leaves this effect, and it never leaves memory behind
   * that `Storage` does not hold.
   */
  readonly apply: (input: Input) => Effect.Effect<SendResult, never, R>

  /**
   * Answers the delayed message of a timer once the timer is no longer waiting
   * for that due time, which ignores a message whose activation has ended.
   */
  readonly wake: (timer: Timer) => Effect.Effect<void, never, R>
}

/** @internal */
export interface Options<R> {
  readonly machine: Machine.Machine.Any
  readonly definitionId: string
  readonly version: string
  /** Arguments for the initial plan of an entity without a checkpoint. */
  readonly input: ReadonlyArray<unknown>
  readonly address: EntityAddress
  readonly storage: Storage["Service"]
  readonly messageStorage: MessageStorage.MessageStorage["Service"]
  readonly enqueue: ((event: any) => Effect.Effect<void, unknown, R>) | undefined
  /** `Entity.keepAlive` for the entity of the instance. */
  readonly keepAlive: (enabled: boolean) => Effect.Effect<void>
  /**
   * Saves the delayed message that wakes the entity for a timer that waits
   * longer than `threshold` milliseconds. Inside a transaction of
   * `MessageStorage` it joins that transaction, and saving one that is already
   * saved does nothing.
   */
  readonly wake: {
    readonly threshold: number
    readonly save: (timer: Timer) => Effect.Effect<void, unknown>
  }
  /**
   * How the machine sends to Cluster machines: `self` names its own entity,
   * `save` saves an event a step sends inside the transaction of its
   * checkpoint, and `poll` lets the runner read what was saved. Without it, a
   * step that sends is refused.
   */
  readonly sends?: {
    readonly self: ClusterTarget.Target
    readonly save: (sent: ClusterTarget.Sent) => Effect.Effect<void, unknown>
    readonly poll: Effect.Effect<void>
  } | undefined
}

/** A timer that waits, as its delayed message names it. */
export interface Timer extends Checkpoint.InvocationKey {
  readonly dueAt: number
}

/** What `Storage` holds at one stored revision. */
type Memory =
  /** No checkpoint; the next step plans the initial state. */
  | { readonly _tag: "Absent"; readonly revision: 0 }
  | {
    readonly _tag: "Active"
    readonly revision: number
    readonly state: Snapshot
    readonly progress: ClusterProgress.Progress
  }
  | { readonly _tag: "Failed"; readonly revision: number; readonly failure: string }

/** A memory from which a step can be planned. */
type Base = Exclude<Memory, { readonly _tag: "Failed" }>

type StepInput =
  | ({ readonly _tag: "Request" } & Input)
  | { readonly _tag: "Invocation"; readonly key: Checkpoint.InvocationKey; readonly event: InvocationEvent }

/** The part of a machine plan that a step keeps. */
interface PlannedStep {
  readonly state: Snapshot
  readonly emitted: ReadonlyArray<unknown>
  readonly sent: ReadonlyArray<ClusterTarget.Sent>
  readonly changes: InvocationChanges.InvocationChanges | undefined
}

/** A stored step, from the revision it was planned on. */
interface StoredStep {
  readonly base: number
  readonly changes: InvocationChanges.InvocationChanges | undefined

  /** Timers of the state it led to that could not be given a due time. */
  readonly unscheduled: ReadonlyArray<ClusterTimer.Unscheduled>

  /** Timers whose delayed messages the step saved. */
  readonly woken: ReadonlyArray<Timer>

  /** Whether the step saved an event it sends. */
  readonly sent: boolean
}

/** What a step leaves behind once the transaction around it has succeeded. */
interface StepResult {
  readonly memory: Memory | undefined

  /** The step, when it was stored. */
  readonly stored: StoredStep | undefined
}

/** Ends a step, rolling its transaction back. */
class Refused extends Data.TaggedError("Refused")<{
  readonly rejected: Rejected

  /** What memory may hold after the rollback. */
  readonly memory: Memory | undefined

  /**
   * Whether an earlier delivery may have committed this input. `Storage` must
   * then be asked before the rejection is returned.
   */
  readonly confirm: boolean

  /**
   * The reason, when applying the same input to the same state would be refused
   * again. Without one, the refusal comes from the infrastructure.
   */
  readonly failure: string | undefined
}> {}

/** Ends a step that was based on a state `Storage` no longer holds. */
class Conflicted extends Data.TaggedError("Conflicted") {}

const reject = (reason: RejectionReason, message: string): Rejected => new Rejected({ reason, message })

const fail = (reason: RejectionReason, message: string): Effect.Effect<never, Rejected> =>
  Effect.fail(reject(reason, message))

const persistenceFailure = (error: { readonly cause: unknown }): Rejected =>
  reject("PersistenceFailure", String(error.cause))

const messageFromCause = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause)
  return squashed instanceof globalThis.Error ? squashed.message : String(squashed)
}

const rejectionFromCause = (cause: Cause.Cause<unknown>, reason: RejectionReason): Rejected => {
  const error = Cause.findErrorOption(cause)
  if (Option.isSome(error) && error.value instanceof Rejected) {
    return error.value
  }
  if (Option.isSome(error) && error.value instanceof internalMachine.ProcessLocalError) {
    return reject("UnsupportedProcessLocal", `${error.value.operation} is process-local and is not supported`)
  }
  return reject(reason, messageFromCause(cause))
}

const failureFromCause = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.findErrorOption(cause)
  return Option.isSome(error) && error.value instanceof Rejected
    ? `${error.value.reason}: ${error.value.message}`
    : renderFailure(cause)
}

/** Propagates an interruption without the typed failures that accompany it. */
const propagate = (cause: Cause.Cause<unknown>): Effect.Effect<never> =>
  Effect.failCause(
    Cause.fromReasons(
      cause.reasons.filter((reason): reason is Cause.Die | Cause.Interrupt => !Cause.isFailReason(reason))
    )
  )

/** Turns every failure of one stage of a step into a refusal. */
const refuse = (options: {
  readonly memory: Memory | undefined
  readonly confirm: boolean
  /** `Decision` stages depend only on the state and the input. */
  readonly stage: "Decision" | "Infrastructure"
}) =>
<A, E, R>(stage: Effect.Effect<A, E, R>): Effect.Effect<A, Refused, R> =>
  Effect.catchCause(stage, (cause): Effect.Effect<never, Refused> =>
    Cause.hasInterrupts(cause)
      ? propagate(cause)
      : Effect.fail(
        new Refused({
          rejected: rejectionFromCause(cause, "TransitionFailure"),
          memory: options.memory,
          confirm: options.confirm,
          failure: options.stage === "Decision" ? failureFromCause(cause) : undefined
        })
      ))

/** The status of a checkpoint, in the form memory holds it. */
export type ReadStatus =
  | { readonly _tag: "Active"; readonly progress: ClusterProgress.Progress }
  | { readonly _tag: "Failed"; readonly failure: string }

/** Reads the status of a checkpoint, whose store may hold anything. */
export const readStatus = (status: unknown): ReadStatus | undefined => {
  if (!Predicate.hasProperty(status, "_tag")) return undefined
  if (status._tag === "Failed") {
    return Predicate.hasProperty(status, "failure") && Predicate.isString(status.failure)
      ? { _tag: "Failed", failure: status.failure }
      : undefined
  }
  if (status._tag !== "Active" || !Predicate.hasProperty(status, "invocations")) return undefined
  const progress = ClusterProgress.fromStored(status.invocations)
  return progress && { _tag: "Active", progress }
}

const absent: Memory = { _tag: "Absent", revision: 0 }

const progressOf = (memory: Memory): ClusterProgress.Progress =>
  memory._tag === "Active" ? memory.progress : ClusterProgress.empty

const accepted = new Accepted({})

/** @internal */
export const make = <R>(options: Options<R>): Effect.Effect<ClusterInstance<R>, never, R | Scope.Scope> =>
  Effect.gen(function*() {
    const { address, definitionId, enqueue, machine, messageStorage, storage, version } = options
    const context = yield* Effect.context<R>()
    const support = ClusterWork.supportOf(toImpl(machine).handlers)
    const hostsWork = support._tag === "Hosted"
    const targets = options.sends
    const capabilities = ClusterWork.makeCapabilities(definitionId, targets?.self)
    // Planned with the target of its own entity as `self`.
    const planned = options.sends === undefined
      ? machine
      : Planner.withMachineReferences(machine, { self: options.sends.self, parent: undefined })
    const clock = yield* Clock.Clock
    const semaphore = Semaphore.makeUnsafe(1)

    // Owned by the running turn.
    let memory: Memory | undefined
    let recovering = false

    const work = new ClusterWork.ClusterWork<R>({
      definitionId,
      address,
      context,
      onEnd: (ended, exit) => untilDone(deliver(ended, exit))
    })
    const keepAlive = new ClusterKeepAlive(options.keepAlive)

    // The timers whose delayed messages are saved, by key, with their due time.
    // Such a timer does not keep the entity alive: its message brings the entity
    // back when it is due, here or on another runner.
    const wakes = new Map<string, number>()
    const timerKey = ({ id, path }: Checkpoint.InvocationKey): string => `${path}\u0000${id}`

    // A timer that never ends needs no message, and one that ends soon stays in
    // memory, as `DurableClock` keeps a short sleep.
    const waitsLong = (dueAt: number): boolean =>
      dueAt < ClusterProgress.maxDueAt && dueAt - clock.currentTimeMillisUnsafe() > options.wake.threshold

    // The timers of `after` that wait long for a due time they did not wait for
    // in `before`.
    const longWaits = (before: ClusterProgress.Progress, after: ClusterProgress.Progress): Array<Timer> =>
      ClusterProgress.entries(after).flatMap(([key, progress]): Array<Timer> => {
        if (progress._tag !== "Waiting" || !waitsLong(progress.dueAt)) return []
        const previous = ClusterProgress.get(before, key)
        return previous?._tag === "Waiting" && previous.dueAt === progress.dueAt
          ? []
          : [{ path: key.path, id: key.id, dueAt: progress.dueAt }]
      })

    const saveWakes = (timers: ReadonlyArray<Timer>): Effect.Effect<void, unknown> =>
      Effect.forEach(timers, options.wake.save, { discard: true })

    const recordWakes = (timers: ReadonlyArray<Timer>): void => {
      for (const timer of timers) wakes.set(timerKey(timer), timer.dueAt)
    }

    const waitingFor = (current: Memory | undefined, key: Checkpoint.InvocationKey): number | undefined => {
      if (current?._tag !== "Active") return undefined
      const progress = ClusterProgress.get(current.progress, key)
      return progress?._tag === "Waiting" ? progress.dueAt : undefined
    }

    // Whether work may run without keeping the entity alive.
    const released = (current: Memory, running: ClusterWork.Work): boolean => {
      if (running.invocation._tag !== "Timer") return false
      const dueAt = waitingFor(current, running.invocation)
      return dueAt !== undefined &&
        (dueAt >= ClusterProgress.maxDueAt || wakes.get(timerKey(running.invocation)) === dueAt)
    }

    // Callers waiting for memory to change, woken at the end of every turn that
    // changed it.
    const waiters = new Set<() => void>()

    const annotate = Effect.annotateLogs({ module: "ClusterMachine", definitionId, address })

    const serialized = <A, E, R1>(run: (restore: Restore) => Effect.Effect<A, E, R1>): Effect.Effect<A, E, R1> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const before = memory
          return Effect.ensuring(
            run(restore),
            Effect.sync(() => {
              if (memory === before || waiters.size === 0) return
              const woken = Array.from(waiters)
              waiters.clear()
              for (const wake of woken) wake()
            })
          )
        })
      ).pipe(Semaphore.withPermit(semaphore))

    // Runs one turn. A turn that leaves something unknown hands it to recovery,
    // whatever ended it.
    const turn = <A, E, R1>(run: (restore: Restore) => Effect.Effect<A, E, R1>): Effect.Effect<A, E, R1> =>
      serialized((restore) => Effect.ensuring(Effect.suspend(() => run(restore)), recoverUnknown))

    const recoverUnknown: Effect.Effect<void> = Effect.suspend(() => {
      if (!hostsWork || work.closed || recovering || (memory !== undefined && !keepAlive.unknown)) {
        return Effect.void
      }
      recovering = true
      return Effect.asVoid(work.fork(untilDone(recover)))
    })

    // One attempt to recover, as a turn that does not ask for recovery itself.
    const recover: Effect.Effect<boolean, never, R> = Effect.suspend(() =>
      serialized((restore) =>
        Effect.suspend(() =>
          memory === undefined ? reload(restore) : Effect.map(align(restore, undefined), () => memory !== undefined)
        ).pipe(
          Effect.tap((recovered) =>
            Effect.sync(() => {
              recovering = !recovered
            })
          )
        )
      )
    )

    const loadForRequest = (input: Input) =>
      Effect.suspend(() => storage.loadForRequest(address, input.requestId)).pipe(
        Effect.mapError(persistenceFailure),
        Effect.filterOrFail(
          (loaded) => !loaded.processed || Option.isSome(loaded.checkpoint),
          () => reject("InvalidCheckpoint", "The request was recorded without a checkpoint")
        )
      )

    const decode = Effect.fnUntraced(function*(
      checkpoint: Checkpoint
    ): Effect.fn.Return<Memory, Rejected, R> {
      if (checkpoint.definitionId !== definitionId) {
        return yield* fail(
          "DefinitionIdMismatch",
          `Expected machine definition id ${definitionId}, received ${checkpoint.definitionId}`
        )
      }
      if (checkpoint.version !== version) {
        return yield* fail(
          "VersionMismatch",
          `Expected version ${version}, received ${checkpoint.version}`
        )
      }
      if (!Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1) {
        return yield* fail(
          "InvalidCheckpoint",
          `Expected a positive integer revision, received ${checkpoint.revision}`
        )
      }
      const status = readStatus(checkpoint.status)
      if (status === undefined) {
        return yield* fail("InvalidCheckpoint", "Expected an active or failed status")
      }
      if (status._tag === "Failed") {
        return { _tag: "Failed", revision: checkpoint.revision, failure: status.failure }
      }
      const state: Snapshot = yield* internalMachine.decodeSnapshot(machine, checkpoint.snapshot).pipe(
        Effect.mapError((error) => reject("InvalidCheckpoint", String(error.cause)))
      )
      const contradiction = contradictionOf(state, status.progress)
      if (contradiction !== undefined) {
        return yield* fail("InvalidCheckpoint", contradiction)
      }
      return { _tag: "Active", revision: checkpoint.revision, state, progress: status.progress }
    })

    const declaresTimer = ({ id, path }: Checkpoint.InvocationKey): boolean =>
      CapturedInvocation.list(Configuration.getStateConfigByPath(machine, path)?.invoke).some((definition) =>
        "after" in definition && definition.id === id
      )

    // What makes progress impossible for a state of this machine.
    const contradictionOf = (state: Snapshot, progress: ClusterProgress.Progress): string | undefined => {
      if (progress.size === 0) return undefined
      const { active } = Configuration.normalizeConfigurationSync(machine, state)
      const inactive = Array.from(progress.keys()).find((path) => !active.has(path))
      if (inactive !== undefined) {
        return `Expected invocations of active states, received state ${inactive}`
      }
      const waiting = ClusterProgress.entries(progress).filter(([, { _tag }]) => _tag === "Waiting")
      if (waiting.length > 0 && internalMachine.isFinal(machine, state)) {
        return "Expected no timer to wait in a final state"
      }
      const unknown = waiting.find(([key]) => !declaresTimer(key))
      return unknown && `Expected only timers to wait, received invocation ${unknown[0].id} of state ${unknown[0].path}`
    }

    // The events that commands send to Cluster machines, in order, decoded by
    // the protocols of their targets.
    const sendsOf = Effect.fnUntraced(function*(
      commands: ReadonlyArray<Machine.Command>,
      sent: Array<ClusterTarget.Sent>
    ): Effect.fn.Return<void, Rejected> {
      for (const command of commands) {
        if (command._tag !== "SendTo" || !ClusterTarget.isTarget(command.target) || options.sends === undefined) {
          return yield* fail(
            "UnsupportedProcessLocal",
            command._tag === "SendTo"
              ? "Machine commands on Cluster send only to a ClusterMachine target"
              : "Machine commands require a managed local process"
          )
        }
        const target = command.target
        const event = yield* target.protocol.decode(command.event).pipe(
          Effect.mapError((rejected) =>
            reject("TransitionFailure", `The step sends ${target.sessionId} an event it refuses: ${rejected.message}`)
          )
        )
        sent.push({ target, event })
      }
    })

    const plan = Effect.fnUntraced(function*(base: Base, event: unknown): Effect.fn.Return<PlannedStep, unknown> {
      const emitted: Array<unknown> = []
      const sent: Array<ClusterTarget.Sent> = []
      let state: Snapshot
      if (base._tag === "Active") {
        state = base.state
      } else {
        const initial = yield* internalMachine.planInitial(planned, ...options.input)
        yield* sendsOf(initial.commands, sent)
        state = initial.state
        emitted.push(...initial.emittedEvents)
      }
      let changes: InvocationChanges.InvocationChanges | undefined
      if (!internalMachine.isFinal(machine, state)) {
        const step = yield* internalMachine.plan(planned, state, event)
        yield* sendsOf(step.commands, sent)
        state = step.next
        emitted.push(...step.emittedEvents)
        changes = InvocationChanges.fromMicrosteps(step.microsteps)
      }
      return { state, emitted, sent, changes }
    })

    // Gives a due time to the timers of a state that have none, from now on.
    const schedule = (
      state: Snapshot,
      progress: ClusterProgress.Progress,
      changes: InvocationChanges.InvocationChanges | undefined
    ): ClusterTimer.Schedule => {
      if (!hostsWork) return { progress, unscheduled: [] }
      if (internalMachine.isFinal(machine, state)) {
        return { progress: ClusterProgress.cancelTimers(progress), unscheduled: [] }
      }
      const configuration = Configuration.normalizeConfigurationSync(machine, state)
      return ClusterTimer.schedule({
        machine,
        configuration,
        paths: entryPaths(configuration),
        eventOf: (path) => entryEvent(changes, path),
        capabilities,
        progress,
        now: clock.currentTimeMillisUnsafe()
      })
    }

    const entryPaths = (configuration: Configuration.ActiveConfiguration): ReadonlyArray<string> =>
      Planner.sortEntryPaths(machine, Configuration.getInitialEntryPaths(machine, configuration))

    // A state that no step of this instance entered counts as entered initially.
    const entryEvent = (
      changes: InvocationChanges.InvocationChanges | undefined,
      path: string
    ): Machine.Machine.LifecycleEvent<any> => changes?.entered.get(path) ?? Planner.InitialEvent

    // An invocation keeps its progress until its state exits, which includes the
    // exit its own outcome causes.
    const progressAfter = (
      base: Base,
      input: StepInput,
      { changes, state }: PlannedStep
    ): ClusterTimer.Schedule => {
      const before = base._tag === "Active" ? base.progress : ClusterProgress.empty
      const ended = input._tag === "Invocation" ? ClusterProgress.settle(before, input.key) : before
      return schedule(state, changes === undefined ? ended : ClusterProgress.exit(ended, changes.exited), changes)
    }

    // Everything a step decides before it changes `Storage`.
    const prepare = Effect.fnUntraced(function*(
      base: Base,
      input: StepInput
    ): Effect.fn.Return<
      {
        readonly planned: PlannedStep
        readonly checkpoint: Checkpoint
        readonly next: Memory
        readonly unscheduled: ReadonlyArray<ClusterTimer.Unscheduled>
      },
      unknown,
      R
    > {
      const planned = yield* plan(base, input.event)
      const snapshot = yield* internalMachine.encodeSnapshot(machine, planned.state).pipe(
        Effect.mapError((error) => reject("SnapshotEncodeFailure", String(error.cause)))
      )
      if (planned.emitted.length > 0 && enqueue === undefined) {
        return yield* fail("EmissionFailure", "No durable enqueue handler was configured")
      }
      const revision = base.revision + 1
      // Last, so a step that is refused evaluates no duration.
      const { progress, unscheduled } = yield* Effect.sync(() => progressAfter(base, input, planned))
      return {
        planned,
        unscheduled,
        checkpoint: {
          definitionId,
          version,
          revision,
          origin: input._tag === "Request"
            ? { _tag: "Request", requestId: input.requestId }
            : { _tag: "Invocation", path: input.key.path, id: input.key.id },
          snapshot,
          status: { _tag: "Active", invocations: ClusterProgress.toStored(progress) }
        },
        next: { _tag: "Active", revision, state: planned.state, progress }
      }
    })

    // The transaction body of a step from a known state. Its value holds once the
    // transaction around it has succeeded.
    const step = Effect.fnUntraced(function*(
      input: StepInput,
      base: Base,
      options: {
        /** Whether an earlier delivery of a request may have committed it. */
        readonly confirm: boolean
      }
    ): Effect.fn.Return<StepResult, Refused | Conflicted, R> {
      const { checkpoint, next, planned, unscheduled } = yield* prepare(base, input).pipe(
        refuse({ memory: base, confirm: options.confirm, stage: "Decision" })
      )
      const committed = yield* storage.commit(address, checkpoint).pipe(
        Effect.mapError(persistenceFailure),
        refuse({ memory: undefined, confirm: true, stage: "Infrastructure" })
      )
      switch (committed._tag) {
        case "Duplicate":
          return input._tag === "Request"
            ? { memory: base, stored: undefined }
            : yield* Effect.die(new Error("Storage reported a duplicate of a checkpoint without a request id"))
        case "RevisionConflict":
          return yield* new Conflicted()
        case "Committed": {
          if (enqueue !== undefined) {
            // `Committed` proves that no earlier delivery committed this input.
            yield* Effect.forEach(planned.emitted, enqueue, { discard: true }).pipe(
              Effect.mapError((error) => reject("EmissionFailure", String(error))),
              refuse({ memory: undefined, confirm: false, stage: "Infrastructure" })
            )
          }
          // In the transaction of the checkpoint, so a stored wait has its message.
          const woken = longWaits(base._tag === "Active" ? base.progress : ClusterProgress.empty, progressOf(next))
          yield* saveWakes(woken).pipe(
            Effect.mapError((error) => reject("PersistenceFailure", String(error))),
            refuse({ memory: undefined, confirm: false, stage: "Infrastructure" })
          )
          // In the transaction of the checkpoint, so each event is sent once.
          if (targets !== undefined) {
            yield* Effect.forEach(planned.sent, targets.save, { discard: true }).pipe(
              Effect.mapError((error) => reject("PersistenceFailure", String(error))),
              refuse({ memory: undefined, confirm: false, stage: "Infrastructure" })
            )
          }
          return {
            memory: next,
            stored: {
              base: base.revision,
              changes: planned.changes,
              unscheduled,
              woken,
              sent: planned.sent.length > 0
            }
          }
        }
      }
    })

    const requestStep = Effect.fnUntraced(function*(
      input: Input,
      known: Memory | undefined
    ): Effect.fn.Return<StepResult, Refused | Conflicted, R> {
      if (support._tag === "Unsupported") {
        return yield* fail("UnsupportedProcessLocal", support.message).pipe(
          refuse({ memory: known, confirm: true, stage: "Decision" })
        )
      }

      let base = known
      if (base === undefined) {
        // A refusal that follows this answer needs no confirmation.
        const refuseLoad = refuse({ memory: undefined, confirm: false, stage: "Infrastructure" })
        const loaded = yield* refuseLoad(loadForRequest(input))
        if (loaded.processed) {
          return { memory: undefined, stored: undefined }
        }
        base = Option.isNone(loaded.checkpoint) ? absent : yield* refuseLoad(decode(loaded.checkpoint.value))
      }

      const confirm = known !== undefined
      return base._tag === "Failed"
        ? yield* fail("MachineFailed", base.failure).pipe(refuse({ memory: base, confirm, stage: "Decision" }))
        : yield* step({ _tag: "Request", ...input }, base, { confirm })
    })

    // Runs after the failed transaction, so the answer excludes its writes. A
    // commit whose transaction failed afterwards may still have taken effect.
    const confirm = (
      restore: Restore,
      input: Input,
      refused: { readonly rejected: Rejected; readonly memory: Memory | undefined }
    ): Effect.Effect<SendResult, Conflicted> =>
      restore(messageStorage.withTransaction(loadForRequest(input))).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Cause.hasInterrupts(cause)
              ? propagate(cause)
              : Effect.succeed(rejectionFromCause(cause, "PersistenceFailure")),
          onSuccess: ({ checkpoint, processed }) => {
            const revision = Option.isNone(checkpoint) ? 0 : checkpoint.value.revision
            const stale = refused.memory !== undefined && refused.memory.revision !== revision
            if (stale && !processed) {
              return Effect.fail(new Conflicted())
            }
            return Effect.sync(() => {
              memory = stale ? undefined : refused.memory
              return processed ? accepted : refused.rejected
            })
          }
        })
      )

    const attempt = (restore: Restore, input: Input): Effect.Effect<SendResult, Conflicted, R> =>
      Effect.suspend(() => {
        const known = memory
        memory = undefined
        return restore(messageStorage.withTransaction(requestStep(input, known))).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause): Effect.Effect<SendResult, Conflicted> => {
              if (Cause.hasInterrupts(cause)) {
                return propagate(cause)
              }
              const error = Option.getOrUndefined(Cause.findErrorOption(cause))
              if (error instanceof Conflicted) {
                return Effect.fail(error)
              }
              if (!(error instanceof Refused)) {
                return confirm(restore, input, {
                  rejected: reject("PersistenceFailure", messageFromCause(cause)),
                  memory: undefined
                })
              }
              // A rollback that failed as well says nothing about `Storage`.
              const refused = Cause.hasDies(cause) ? { rejected: error.rejected, memory: undefined } : error
              if (error.confirm) {
                return confirm(restore, input, refused)
              }
              return Effect.sync(() => {
                memory = refused.memory
                return refused.rejected
              })
            },
            onSuccess: (result) => {
              memory = result.memory
              return Effect.as(align(restore, result.stored), accepted)
            }
          })
        )
      })

    // Ends an attempt that leaves memory unknown, and is made again. An
    // interruption is no exception: when it is not this fiber that was
    // interrupted, it is how the infrastructure failed.
    const notDone = (message: string, cause: Cause.Cause<unknown>): Effect.Effect<false> =>
      Effect.as(work.closed ? Effect.void : Effect.logWarning(message, cause), false as const)

    // Loads what `Storage` holds, for an instance that does not know it. The
    // value is whether nothing is left to load.
    const reload = (restore: Restore): Effect.Effect<boolean, never, R> =>
      restore(messageStorage.withTransaction(
        Effect.suspend(() => storage.load(address)).pipe(
          Effect.mapError(persistenceFailure),
          Effect.flatMap(Option.match({
            onNone: () => Effect.succeedSome(absent),
            onSome: (checkpoint) =>
              decode(checkpoint).pipe(
                Effect.map(Option.some),
                // A checkpoint this deployment cannot read belongs to another one.
                Effect.catch((unreadable) =>
                  Effect.logWarning("Could not read the checkpoint of a Cluster machine", unreadable.message).pipe(
                    Effect.as(Option.none<Memory>())
                  )
                )
              )
          }))
        )
      )).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => notDone("Could not load the checkpoint of a Cluster machine", cause),
          onSuccess: (loaded) => {
            // Its work stops, and its keep-alive request stays for a deployment
            // that can read it.
            if (Option.isNone(loaded)) return Effect.as(stopWork, true)
            memory = loaded.value
            return Effect.map(align(restore, undefined), () => memory !== undefined)
          }
        }),
        annotate
      )

    const stopWork = Effect.suspend(() => {
      work.revision = undefined
      return work.stopAll
    })

    // Makes the work and the keep-alive match the known memory. `stored` is the
    // step that led to it from the previous state.
    const align = (restore: Restore, stored: StoredStep | undefined): Effect.Effect<void> =>
      Effect.andThen(
        // The runner reads the events the step sent now, rather than at its next poll.
        stored?.sent === true && options.sends !== undefined ? options.sends.poll : Effect.void,
        alignStored(restore, stored)
      )

    const alignStored = (restore: Restore, stored: StoredStep | undefined): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (!hostsWork || work.closed || memory === undefined) return Effect.void
        if (stored !== undefined) recordWakes(stored.woken)
        return Effect.flatMap(
          stored === undefined ? scheduleLoaded(restore, memory) : Effect.succeed(stored.unscheduled),
          (unscheduled) => {
            if (memory === undefined) return Effect.void
            return Effect.flatMap(alignWork(memory, stored, unscheduled), (failure) =>
              failure === undefined
                ? Effect.andThen(
                  stored === undefined ? wakeLoaded(restore) : Effect.void,
                  Effect.suspend(() => {
                    const current = memory
                    if (current === undefined) return Effect.void
                    forgetWakes(current)
                    // A request is answered after this, so a crash in between redelivers it.
                    return restore(keepAlive.switchTo(work.pendingExcept((running) => released(current, running))))
                      .pipe(annotate)
                  })
                )
                : Effect.asVoid(storeFailure(restore, failure.key, renderFailure(failure.cause))))
          }
        )
      })

    // Saves the messages that the long waits of a loaded state may lack, as
    // they lack them when a deployment before this one stored the wait. A
    // message that is not saved keeps its timer, and the entity, in memory.
    const wakeLoaded = (restore: Restore): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (memory === undefined) return Effect.void
        const timers = longWaits(ClusterProgress.empty, progressOf(memory)).filter((timer) =>
          wakes.get(timerKey(timer)) !== timer.dueAt
        )
        return Effect.forEach(timers, (timer) =>
          restore(options.wake.save(timer)).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) =>
                Cause.hasInterrupts(cause)
                  ? propagate(cause)
                  : Effect.logWarning("Could not save the message that wakes a Cluster machine", cause),
              onSuccess: () => Effect.sync(() => recordWakes([timer]))
            })
          ), { discard: true }).pipe(annotate)
      })

    // Keeps only the messages of timers that still wait for their due time.
    const forgetWakes = (current: Memory): void => {
      for (const [key, dueAt] of wakes) {
        const [path, id] = key.split("\u0000") as [string, string]
        if (waitingFor(current, { path, id }) !== dueAt) wakes.delete(key)
      }
    }

    // Stores the due times that a loaded state lacks, as a checkpoint of its own.
    // Memory is left unknown when that fails.
    const scheduleLoaded = (
      restore: Restore,
      loaded: Memory
    ): Effect.Effect<ReadonlyArray<ClusterTimer.Unscheduled>> =>
      Effect.suspend(() => {
        if (
          loaded._tag !== "Active" || work.revision === loaded.revision ||
          internalMachine.isFinal(machine, loaded.state)
        ) {
          return Effect.succeed([])
        }
        const { progress, unscheduled } = schedule(loaded.state, loaded.progress, undefined)
        if (progress === loaded.progress) return Effect.succeed(unscheduled)
        const woken = longWaits(loaded.progress, progress)
        return amend(restore, {
          origin: { _tag: "Timers" },
          status: { _tag: "Active", invocations: ClusterProgress.toStored(progress) }
        }, woken).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => notDone("Could not store the due times of a Cluster machine", cause),
            onSuccess: (revision) =>
              Effect.sync(() => {
                memory = { ...loaded, revision, progress }
                recordWakes(woken)
              })
          }),
          annotate,
          Effect.as(unscheduled)
        )
      })

    const alignWork = (
      current: Memory,
      stored: StoredStep | undefined,
      unscheduled: ReadonlyArray<ClusterTimer.Unscheduled>
    ): Effect.Effect<ClusterWork.StartFailure | undefined> =>
      Effect.suspend(() => {
        if (work.revision === current.revision) return Effect.succeed(undefined)
        if (current._tag !== "Active" || internalMachine.isFinal(machine, current.state)) {
          return Effect.as(stopWork, undefined)
        }
        const configuration = Configuration.normalizeConfigurationSync(machine, current.state)
        const continues = stored !== undefined && work.revision === stored.base
        const entered = continues
          ? Array.from(stored.changes?.entered ?? [])
          : entryPaths(configuration).map((path) => [path, entryEvent(stored?.changes, path)] as const)
        const stop = continues ? work.stopPaths(stored.changes?.exited ?? []) : work.stopAll
        return stop.pipe(
          Effect.andThen(Effect.suspend(() => {
            work.revision = current.revision
            const groups = entered.flatMap(([path, event]) =>
              InvocationResolution.resolve(machine, configuration, [path], event, capabilities)
            )
            return work.start(groups, { progress: current.progress, unscheduled })
          })),
          Effect.tap((failure) => failure === undefined ? Effect.void : stopWork)
        )
      })

    // Replaces the stored checkpoint by one of the same state, whose snapshot is
    // kept as it is. Memory is forgotten first, and the value is the revision that
    // is stored.
    const amend = (
      restore: Restore,
      amended: Pick<Checkpoint, "origin" | "status">,
      woken: ReadonlyArray<Timer> = []
    ): Effect.Effect<number, unknown> =>
      Effect.suspend(() => {
        const revision = memory?.revision
        memory = undefined
        return restore(messageStorage.withTransaction(Effect.gen(function*() {
          const loaded = yield* storage.load(address)
          if (Option.isNone(loaded) || loaded.value.revision !== revision) {
            return yield* new Conflicted()
          }
          const checkpoint: Checkpoint = { ...loaded.value, ...amended, revision: revision + 1 }
          const committed = yield* storage.commit(address, checkpoint)
          if (committed._tag !== "Committed") {
            return yield* new Conflicted()
          }
          yield* saveWakes(woken)
          return checkpoint.revision
        })))
      })

    // Stores the machine as failed, in the state it has. The value is whether the
    // failure is stored.
    const storeFailure = (
      restore: Restore,
      key: Checkpoint.InvocationKey,
      failure: string
    ): Effect.Effect<boolean> =>
      amend(restore, {
        origin: { _tag: "Invocation", path: key.path, id: key.id },
        status: { _tag: "Failed", failure }
      }).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => notDone("Could not store the failure of a Cluster machine", cause),
          onSuccess: (revision) => {
            memory = { _tag: "Failed", revision, failure }
            return Effect.logError("A Cluster machine failed", failure).pipe(
              Effect.andThen(align(restore, undefined)),
              Effect.as(true)
            )
          }
        }),
        annotate
      )

    // One attempt to apply the end of work. The value is whether nothing is left
    // to do.
    const deliver = (ended: ClusterWork.Work, exit: Exit.Exit<unknown, unknown>): Effect.Effect<boolean, never, R> =>
      turn((restore) =>
        Effect.andThen(
          memory === undefined && !ended.stopped ? reload(restore) : Effect.void,
          Effect.suspend((): Effect.Effect<boolean, never, R> => {
            const decision = InvocationOutcome.decide(
              ended.invocation,
              ended.generation,
              ClusterWork.outcomeOf(ended, InvocationOutcome.fromExit(exit))
            )
            if (decision._tag === "Ignore") return Effect.succeed(true)
            if (memory === undefined || memory._tag !== "Active") return Effect.succeed(false)
            return decision._tag === "Fail"
              ? storeFailure(restore, ended.invocation, renderFailure(decision.cause))
              : applyOutcome(restore, ended, memory, decision.event)
          })
        )
      )

    const applyOutcome = (
      restore: Restore,
      ended: ClusterWork.Work,
      base: Base,
      event: InvocationEvent
    ): Effect.Effect<boolean, never, R> => {
      memory = undefined
      const key = { path: ended.invocation.path, id: ended.invocation.id }
      return restore(
        messageStorage.withTransaction(step({ _tag: "Invocation", key, event }, base, { confirm: false }))
      ).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => {
            const error = Option.getOrUndefined(Cause.findErrorOption(cause))
            if (error instanceof Refused && error.failure !== undefined && !Cause.hasDies(cause)) {
              memory = error.memory
              return storeFailure(restore, key, error.failure)
            }
            return notDone("Could not store the outcome of an invocation", cause)
          },
          onSuccess: (result) => {
            memory = result.memory
            work.settle(ended)
            return Effect.as(align(restore, result.stored), true)
          }
        }),
        annotate
      )
    }

    yield* Effect.addFinalizer(() => Effect.andThen(work.close, keepAlive.close))

    if (hostsWork) {
      // After a crash no request may ever come.
      recovering = true
      yield* work.fork(untilDone(recover))
    } else if (support._tag === "Idle") {
      // A deployment whose machine invoked effects may have left a request behind.
      yield* options.keepAlive(false)
    }

    // One look at a timer, as a turn. `undefined` means nothing is left to wait
    // for, and a deferred is completed once memory changes.
    const lookAt = (timer: Timer) =>
      serialized((restore) =>
        Effect.andThen(
          memory === undefined ? reload(restore) : Effect.void,
          Effect.sync(() => {
            if (memory !== undefined && waitingFor(memory, timer) !== timer.dueAt) return undefined
            const changed = Deferred.makeUnsafe<void>()
            waiters.add(() => Deferred.doneUnsafe(changed, Exit.void))
            return { changed, known: memory !== undefined }
          })
        )
      )

    const wake = (timer: Timer): Effect.Effect<void, never, R> =>
      Effect.gen(function*() {
        while (true) {
          const waiting = yield* lookAt(timer)
          if (waiting === undefined) return
          // A store that cannot be read is read again later.
          yield* waiting.known
            ? Deferred.await(waiting.changed)
            : Effect.raceFirst(Deferred.await(waiting.changed), Effect.sleep("1 second"))
        }
      }).pipe(annotate)

    return {
      wake,
      apply: (input) =>
        turn((restore) =>
          attempt(restore, input).pipe(
            // A conflict leaves memory unknown, so the retry loads.
            Effect.catchTag("Conflicted", () => attempt(restore, input)),
            Effect.catchTag("Conflicted", () =>
              Effect.succeed(reject(
                "RevisionConflict",
                "Another instance advanced the checkpoint while this request was applied"
              ))),
            Effect.tap(() => align(restore, undefined))
          )
        )
    }
  })
