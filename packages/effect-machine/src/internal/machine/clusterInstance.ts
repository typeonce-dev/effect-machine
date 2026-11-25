/**
 * The live instance behind one active Cluster entity.
 *
 * @since 0.48.0
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type { EntityAddress, MessageStorage, Snowflake } from "effect/cluster"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type * as Machine from "../../Machine.js"
import type { Checkpoint } from "../../unstable/cluster/ClusterMachine.js"
import { ChildMachineRuntime } from "./capability.js"
import * as CapturedInvocation from "./capturedInvocation.js"
import { isChildMachine } from "./child.js"
import * as ClusterChild from "./clusterChild.js"
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
import * as InvocationEventModule from "./invocationEvent.js"
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
 * A request: an event, or the start or stop of a child machine by its parent.
 * A start carries the arguments of the initial plan.
 */
interface RequestInput extends Input {
  readonly lifecycle?: "Start" | "Stop" | undefined
  readonly initial?: ReadonlyArray<unknown> | undefined
  /** An encoded snapshot of a child, which is the event of the request. */
  readonly child?: { readonly entityId: string; readonly snapshot: unknown } | undefined
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

  /**
   * Applies an event that another machine sent. An event that cannot be applied
   * fails the machine, and a failure of the infrastructure is retried.
   */
  readonly deliver: (input: Input) => Effect.Effect<void, never, R>

  /**
   * Starts the machine with its input, committing its initial state if absent.
   * An active machine accepts it as a no-op; a failed or stopped one rejects it.
   */
  readonly start: (
    input: { readonly requestId: Snowflake; readonly input: unknown }
  ) => Effect.Effect<SendResult, never, R>

  /** Stops a child machine, which then rejects every later request. */
  readonly stop: (requestId: Snowflake) => Effect.Effect<void, never, R>

  /**
   * Applies the end of the child `entityId`, read from `Storage`, when this
   * machine still runs it.
   */
  readonly childEnded: (entityId: string) => Effect.Effect<void, never, R>

  /**
   * Applies an encoded snapshot of the child `entityId` as a snapshot of its
   * invocation, when this machine still runs it. A transition that cannot be
   * applied fails the machine.
   */
  readonly childSnapshot: (input: {
    readonly requestId: Snowflake
    readonly entityId: string
    readonly snapshot: unknown
  }) => Effect.Effect<void, never, R>
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
  /**
   * The child machines that the states invoke, by their ids, how to save a
   * request to one, and the parent of this machine when it is a child itself.
   */
  readonly children?: {
    readonly protocols: ReadonlyMap<string, ClusterTarget.Protocol>
    readonly save: ClusterTarget.Save
    readonly address: (target: ClusterTarget.Target) => EntityAddress
    readonly parent: ClusterTarget.Target | undefined
    /** Whether this machine sends its parent its snapshots. */
    readonly snapshots: boolean
    /**
     * Saves a request to a child from work, outside the transaction of a step,
     * and lets the runner read it.
     */
    readonly dispatch: (target: ClusterTarget.Target, tag: string, payload: unknown) => Effect.Effect<void, unknown>
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
  /** A child that its parent stopped. */
  | { readonly _tag: "Stopped"; readonly revision: number }

/** A memory from which a step can be planned. */
type Base = Exclude<Memory, { readonly _tag: "Failed" | "Stopped" }>

type StepInput =
  | ({ readonly _tag: "Request" } & Input & {
    /** Arguments of the initial plan, which the start of a child carries. */
    readonly initial?: ReadonlyArray<unknown> | undefined
  })
  | { readonly _tag: "Invocation"; readonly key: Checkpoint.InvocationKey; readonly event: InvocationEvent }

/** The part of a machine plan that a step keeps. */
interface PlannedStep {
  readonly state: Snapshot
  readonly emitted: ReadonlyArray<unknown>
  readonly commands: ReadonlyArray<Machine.Command>
  readonly changes: InvocationChanges.InvocationChanges | undefined
  /** Whether the step planned the initial state or took a transition. */
  readonly moved: boolean
}

/** A request that a step saves, to another machine. */
interface Outgoing {
  readonly target: ClusterTarget.Target
  readonly tag: string
  readonly payload: unknown
}

/** A stored step, from the revision it was planned on. */
interface StoredStep {
  readonly base: number
  readonly changes: InvocationChanges.InvocationChanges | undefined

  /** Timers of the state it led to that could not be given a due time. */
  readonly unscheduled: ReadonlyArray<ClusterTimer.Unscheduled>

  /** Timers whose delayed messages the step saved. */
  readonly woken: ReadonlyArray<Timer>

  /** Whether the step saved a request to another machine. */
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
  | { readonly _tag: "Stopped" }

/** Reads the status of a checkpoint, whose store may hold anything. */
export const readStatus = (status: unknown): ReadStatus | undefined => {
  if (!Predicate.hasProperty(status, "_tag")) return undefined
  if (status._tag === "Failed") {
    return Predicate.hasProperty(status, "failure") && Predicate.isString(status.failure)
      ? { _tag: "Failed", failure: status.failure }
      : undefined
  }
  if (status._tag === "Stopped") return { _tag: "Stopped" }
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
    // Work acts on the children that run when it acts, read from memory or,
    // while a turn changes memory, from `Storage`.
    const childRuntime: ChildMachineRuntime["Service"] = {
      sendTo: (child, event) =>
        Effect.flatMap(runningChild(child), (target) =>
          target === undefined ? Effect.void : Effect.flatMap(
            Effect.orDie(target.protocol.decode(event)),
            (decoded) => dispatchToChild(target, "deliver", decoded)
          )),
      stopChild: (child) =>
        Effect.flatMap(
          runningChild(child),
          (target) => target === undefined ? Effect.void : dispatchToChild(target, "stop", undefined)
        )
    }
    const context = Context.add(yield* Effect.context<R>(), ChildMachineRuntime, childRuntime)
    const support = ClusterWork.supportOf(toImpl(machine).handlers)
    const hostsWork = support._tag === "Hosted"
    const targets = options.sends
    const parent = options.children?.parent
    const capabilities = ClusterWork.makeCapabilities(definitionId, targets?.self, parent)
    // Planned with the target of its own entity as `self`.
    const planned = options.sends === undefined
      ? machine
      : Planner.withMachineReferences(machine, { self: options.sends.self, parent })
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
      if (status._tag === "Stopped") {
        return { _tag: "Stopped", revision: checkpoint.revision }
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

    const wasFinal = (base: Base): boolean => base._tag === "Active" && internalMachine.isFinal(machine, base.state)

    // The running entry and target for a child descriptor in a progress.
    const runningChildEntry = (
      progress: ClusterProgress.Progress,
      child: Machine.ChildMachine.Any
    ): readonly [key: Checkpoint.InvocationKey, target: ClusterTarget.Target] | undefined => {
      const protocol = options.children?.protocols.get(child.id)
      const running = ClusterProgress.children(progress).find(([key]) => key.id === child.id)
      return protocol && running && [running[0], new ClusterTarget.Target(protocol, running[1])]
    }

    // The child that runs for a child descriptor in a progress.
    const childTarget = (
      progress: ClusterProgress.Progress,
      child: Machine.ChildMachine.Any
    ): ClusterTarget.Target | undefined => runningChildEntry(progress, child)?.[1]

    const runningChild = (child: Machine.ChildMachine.Any): Effect.Effect<ClusterTarget.Target | undefined> =>
      Effect.suspend(() => {
        const known = memory
        if (known !== undefined) {
          return Effect.succeed(known._tag === "Active" ? childTarget(known.progress, child) : undefined)
        }
        return storage.load(address).pipe(
          Effect.map((loaded) => {
            const status = Option.isSome(loaded) ? readStatus(loaded.value.status) : undefined
            return status?._tag === "Active" ? childTarget(status.progress, child) : undefined
          }),
          // A store that cannot be read now is read again.
          Effect.retry({ schedule: Schedule.spaced("1 second") }),
          Effect.orDie
        )
      })

    const dispatchToChild = (target: ClusterTarget.Target, tag: string, payload: unknown): Effect.Effect<void> =>
      options.children === undefined
        ? Effect.void
        : options.children.dispatch(target, tag, payload).pipe(
          // A runner that cannot take the request now takes it later.
          Effect.retry({ schedule: Schedule.spaced("1 second") }),
          Effect.orDie
        )

    // The sends and child stops that commands enqueue, in order, decoded by
    // the protocols of their targets. A child is the one that runs once the step
    // is stored, and a send or stop for a child that does not run is dropped, as
    // a local runtime drops it. Stopping a child settles its progress entry so
    // it does not restart while its state stays active.
    const commandsOf = Effect.fnUntraced(function*(
      commands: ReadonlyArray<Machine.Command>,
      initialProgress: ClusterProgress.Progress
    ): Effect.fn.Return<
      {
        readonly outgoing: Array<Outgoing>
        readonly progress: ClusterProgress.Progress
        readonly stoppedIds: ReadonlySet<string>
      },
      Rejected
    > {
      const outgoing: Array<Outgoing> = []
      const stoppedIds = new Set<string>()
      let progress = initialProgress
      for (const command of commands) {
        if (command._tag === "Stop") {
          if (!isChildMachine(command.child)) {
            return yield* fail(
              "UnsupportedProcessLocal",
              "Machine commands on Cluster stop only an invoked child machine"
            )
          }
          const running = runningChildEntry(progress, command.child)
          if (running === undefined) continue
          const [key, target] = running
          progress = ClusterProgress.settle(progress, key)
          stoppedIds.add(target.entityId)
          outgoing.push({ target, tag: "stop", payload: undefined })
          continue
        }
        const child = command._tag === "SendTo" && isChildMachine(command.target) ? command.target : undefined
        if (
          command._tag !== "SendTo" || options.sends === undefined ||
          (child === undefined && !ClusterTarget.isTarget(command.target))
        ) {
          return yield* fail(
            "UnsupportedProcessLocal",
            command._tag === "SendTo"
              ? "Machine commands on Cluster send only to a ClusterMachine target or an invoked child machine"
              : "Machine commands require a managed local process"
          )
        }
        const target = child === undefined ? command.target as ClusterTarget.Target : childTarget(progress, child)
        if (target === undefined) continue
        const event = yield* target.protocol.decode(command.event).pipe(
          Effect.mapError((rejected) =>
            reject("TransitionFailure", `The step sends ${target.sessionId} an event it refuses: ${rejected.message}`)
          )
        )
        outgoing.push({ target, tag: "send", payload: event })
      }
      return { outgoing, progress, stoppedIds }
    })

    // Starts the child machines of the states of a step that run no child yet.
    // Each gets an entity of its own, named by the revision of the step.
    const startChildren = (
      state: Snapshot,
      progress: ClusterProgress.Progress,
      changes: InvocationChanges.InvocationChanges | undefined,
      revision: number
    ): { readonly progress: ClusterProgress.Progress; readonly starts: ReadonlyArray<Outgoing> } => {
      const children = options.children
      if (children === undefined || children.protocols.size === 0 || internalMachine.isFinal(machine, state)) {
        return { progress, starts: [] }
      }
      const configuration = Configuration.normalizeConfigurationSync(machine, state)
      const starts: Array<Outgoing> = []
      for (const path of entryPaths(configuration)) {
        const groups = InvocationResolution.resolve(
          machine,
          configuration,
          [path],
          entryEvent(changes, path),
          capabilities
        )
        for (const invocation of groups.flatMap((group) => group.invocations)) {
          if (invocation._tag !== "Child" || ClusterProgress.get(progress, invocation) !== undefined) continue
          const protocol = children.protocols.get(invocation.child.id)
          if (protocol === undefined) continue
          const entityId = ClusterChild.entityIdOf(address.entityId, invocation.child.id, revision)
          progress = ClusterProgress.child(progress, invocation, entityId)
          starts.push({
            target: new ClusterTarget.Target(protocol, entityId),
            tag: "start",
            payload: { input: invocation.input?.() }
          })
        }
      }
      return { progress, starts }
    }

    // Stops the children that ran before a step and do not after it, except the
    // one whose end the step applies or ones already stopped by commands.
    const stopsOf = (
      before: ClusterProgress.Progress,
      after: ClusterProgress.Progress,
      ended: Checkpoint.InvocationKey | undefined,
      alreadyStopped?: ReadonlySet<string>
    ): ReadonlyArray<Outgoing> => {
      const children = options.children
      if (children === undefined) return []
      const kept = new Set(ClusterProgress.children(after).map(([, entityId]) => entityId))
      return ClusterProgress.children(before).flatMap(([key, entityId]): Array<Outgoing> => {
        const protocol = children.protocols.get(key.id)
        return protocol === undefined || kept.has(entityId) || alreadyStopped?.has(entityId) === true ||
            (ended !== undefined && key.path === ended.path && key.id === ended.id)
          ? []
          : [{ target: new ClusterTarget.Target(protocol, entityId), tag: "stop", payload: undefined }]
      })
    }

    // Tells the parent of a child that it ended, in the step that ends it.
    const endedFor = (ends: boolean): ReadonlyArray<Outgoing> => {
      const parent = options.children?.parent
      return parent === undefined || !ends
        ? []
        : [{ target: parent, tag: "ended", payload: { entityId: address.entityId } }]
    }

    // Gives the parent of a child the snapshot of a step that changed it, while
    // the child is active, when the parent takes its snapshots.
    const snapshotFor = (planned: PlannedStep, snapshot: Machine.Machine.EncodedSnapshot): ReadonlyArray<Outgoing> => {
      const parent = options.children?.parent
      return parent === undefined || options.children?.snapshots !== true || !planned.moved ||
          internalMachine.isFinal(machine, planned.state)
        ? []
        : [{ target: parent, tag: "snapshot", payload: { entityId: address.entityId, snapshot } }]
    }

    const saveOutgoing = (outgoing: ReadonlyArray<Outgoing>): Effect.Effect<void, unknown> =>
      Effect.forEach(
        outgoing,
        ({ payload, tag, target }) =>
          tag === "send" && targets !== undefined
            ? targets.save({ target, event: payload })
            : options.children === undefined
            ? Effect.die(new Error(`Cannot save ${tag} for ${target.sessionId} without children`))
            : options.children.save(target, tag, payload),
        { discard: true }
      )

    const plan = Effect.fnUntraced(function*(base: Base, input: StepInput): Effect.fn.Return<PlannedStep, unknown> {
      const emitted: Array<unknown> = []
      const commands: Array<Machine.Command> = []
      const initialArgs = input._tag === "Request" ? input.initial : undefined
      let state: Snapshot
      if (base._tag === "Active") {
        state = base.state
      } else {
        if (options.children?.parent !== undefined && initialArgs === undefined) {
          return yield* fail("InvalidEvent", "A child machine takes events once its parent has started it")
        }
        if (machine.input !== undefined && initialArgs === undefined && options.input.length === 0) {
          return yield* fail("InvalidEvent", "A machine with input must be started before it takes events")
        }
        const initial = yield* internalMachine.planInitial(planned, ...initialArgs ?? options.input)
        commands.push(...initial.commands)
        state = initial.state
        emitted.push(...initial.emittedEvents)
      }
      let changes: InvocationChanges.InvocationChanges | undefined
      let moved = base._tag !== "Active"
      // The start of a child plans its initial state only.
      if (initialArgs === undefined && !internalMachine.isFinal(machine, state)) {
        const step = yield* internalMachine.plan(planned, state, input.event)
        commands.push(...step.commands)
        state = step.next
        emitted.push(...step.emittedEvents)
        changes = InvocationChanges.fromMicrosteps(step.microsteps)
        moved ||= step.microsteps.length > 0
      }
      return { state, emitted, commands, changes, moved }
    })

    // Gives a due time to the timers of a state that have none, from now on.
    const schedule = (
      state: Snapshot,
      progress: ClusterProgress.Progress,
      changes: InvocationChanges.InvocationChanges | undefined
    ): ClusterTimer.Schedule => {
      if (!hostsWork) return { progress, unscheduled: [] }
      if (internalMachine.isFinal(machine, state)) {
        return { progress: ClusterProgress.stopChildren(ClusterProgress.cancelTimers(progress)), unscheduled: [] }
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
        readonly outgoing: ReadonlyArray<Outgoing>
      },
      unknown,
      R
    > {
      const planned = yield* plan(base, input)
      const snapshot = yield* internalMachine.encodeSnapshot(machine, planned.state).pipe(
        Effect.mapError((error) => reject("SnapshotEncodeFailure", String(error.cause)))
      )
      if (planned.emitted.length > 0 && enqueue === undefined) {
        return yield* fail("EmissionFailure", "No durable enqueue handler was configured")
      }
      const revision = base.revision + 1
      // Last, so a step that is refused evaluates no duration.
      const scheduled = yield* Effect.sync(() => progressAfter(base, input, planned))
      const { starts, progress: startedProgress } = yield* Effect.try({
        try: () => startChildren(planned.state, scheduled.progress, planned.changes, revision),
        catch: (error) => reject("TransitionFailure", `The input of a child machine cannot be built: ${String(error)}`)
      })
      const unscheduled = scheduled.unscheduled
      const { outgoing: commandOutgoing, progress, stoppedIds } = yield* commandsOf(planned.commands, startedProgress)
      const before = base._tag === "Active" ? base.progress : ClusterProgress.empty
      const outgoing = [
        ...stopsOf(before, progress, input._tag === "Invocation" ? input.key : undefined, stoppedIds),
        ...starts,
        ...commandOutgoing,
        ...snapshotFor(planned, snapshot),
        ...endedFor(internalMachine.isFinal(machine, planned.state) && !wasFinal(base))
      ]
      return {
        planned,
        unscheduled,
        outgoing,
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
      const { checkpoint, next, outgoing, planned, unscheduled } = yield* prepare(base, input).pipe(
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
          // In the transaction of the checkpoint, so each request is saved once.
          yield* saveOutgoing(outgoing).pipe(
            Effect.mapError((error) => reject("PersistenceFailure", String(error))),
            refuse({ memory: undefined, confirm: false, stage: "Infrastructure" })
          )
          return {
            memory: next,
            stored: {
              base: base.revision,
              changes: planned.changes,
              unscheduled,
              woken,
              sent: outgoing.length > 0
            }
          }
        }
      }
    })

    // Stores a child as stopped, in the state it has, and stops its own children.
    const stopStep = Effect.fnUntraced(function*(
      requestId: Snowflake,
      base: Extract<Memory, { readonly _tag: "Active" }>
    ): Effect.fn.Return<StepResult, Refused | Conflicted, R> {
      const snapshot = yield* internalMachine.encodeSnapshot(machine, base.state).pipe(
        Effect.mapError((error) => reject("SnapshotEncodeFailure", String(error.cause))),
        refuse({ memory: base, confirm: true, stage: "Decision" })
      )
      const revision = base.revision + 1
      const committed = yield* storage.commit(address, {
        definitionId,
        version,
        revision,
        origin: { _tag: "Request", requestId },
        snapshot,
        status: { _tag: "Stopped" }
      }).pipe(
        Effect.mapError(persistenceFailure),
        refuse({ memory: undefined, confirm: true, stage: "Infrastructure" })
      )
      if (committed._tag === "Duplicate") return { memory: base, stored: undefined }
      if (committed._tag === "RevisionConflict") return yield* new Conflicted()
      const stops = stopsOf(base.progress, ClusterProgress.empty, undefined)
      yield* saveOutgoing(stops).pipe(
        Effect.mapError((error) => reject("PersistenceFailure", String(error))),
        refuse({ memory: undefined, confirm: false, stage: "Infrastructure" })
      )
      return { memory: { _tag: "Stopped", revision }, stored: undefined }
    })

    const requestStep = Effect.fnUntraced(function*(
      input: RequestInput,
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
      // A start of an active machine, and a stop of one that does not run,
      // change nothing. A start of a failed or stopped machine is rejected below.
      if (input.lifecycle === "Start" && base._tag === "Active") return { memory: base, stored: undefined }
      if (input.lifecycle === "Stop") {
        return base._tag === "Active" ? yield* stopStep(input.requestId, base) : { memory: base, stored: undefined }
      }
      if (base._tag === "Failed") {
        return yield* fail("MachineFailed", base.failure).pipe(refuse({ memory: base, confirm, stage: "Decision" }))
      }
      if (base._tag === "Stopped") {
        return yield* fail("MachineFailed", "The child machine was stopped by its parent").pipe(
          refuse({ memory: base, confirm, stage: "Decision" })
        )
      }
      let event = input.event
      if (input.child !== undefined) {
        // The snapshot of a child that no longer runs changes nothing.
        const { entityId } = input.child
        const running = base._tag === "Active"
          ? ClusterProgress.children(base.progress).find(([, id]) => id === entityId)
          : undefined
        const protocol = running && options.children?.protocols.get(running[0].id)
        if (running === undefined || protocol === undefined) return { memory: base, stored: undefined }
        const [key] = running
        const state = yield* internalMachine.decodeSnapshot(protocol.machine, input.child.snapshot).pipe(
          Effect.mapError((error) =>
            reject("TransitionFailure", `The snapshot of child ${entityId} cannot be decoded: ${String(error)}`)
          ),
          refuse({ memory: base, confirm, stage: "Decision" })
        )
        event = InvocationEventModule.snapshot(key.path, key.id, { current: true }, { status: "active", state })
      }
      return yield* step(
        { _tag: "Request", requestId: input.requestId, event, initial: input.initial },
        base,
        { confirm }
      )
    })

    // Runs after the failed transaction, so the answer excludes its writes. A
    // commit whose transaction failed afterwards may still have taken effect.
    const confirm = (
      restore: Restore,
      input: RequestInput,
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

    const attempt = (restore: Restore, input: RequestInput): Effect.Effect<SendResult, Conflicted, R> =>
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
      woken: ReadonlyArray<Timer> = [],
      outgoing: ReadonlyArray<Outgoing> = []
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
          yield* saveOutgoing(outgoing)
          return checkpoint.revision
        })))
      })

    // Stores the machine as failed, in the state it has. The value is whether the
    // failure is stored.
    const storeFailure = (
      restore: Restore,
      cause: Checkpoint.InvocationKey | { readonly requestId: Snowflake },
      failure: string
    ): Effect.Effect<boolean> =>
      // A machine that fails stops its children, and a child tells its parent.
      amend(
        restore,
        {
          origin: "requestId" in cause
            ? { _tag: "Request", requestId: cause.requestId }
            : { _tag: "Invocation", path: cause.path, id: cause.id },
          status: { _tag: "Failed", failure }
        },
        [],
        [
          ...stopsOf(
            memory === undefined ? ClusterProgress.empty : progressOf(memory),
            ClusterProgress.empty,
            undefined
          ),
          ...endedFor(true)
        ]
      ).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => notDone("Could not store the failure of a Cluster machine", cause),
          onSuccess: (revision) => {
            memory = { _tag: "Failed", revision, failure }
            return Effect.logError("A Cluster machine failed", failure).pipe(
              // The runner reads the requests to its children and parent now.
              Effect.andThen(options.sends?.poll ?? Effect.void),
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
              : applyOutcome(restore, ended.invocation, memory, decision.event, () => work.settle(ended))
          })
        )
      )

    const applyOutcome = (
      restore: Restore,
      invocation: Checkpoint.InvocationKey,
      base: Base,
      event: InvocationEvent,
      settle: () => void
    ): Effect.Effect<boolean, never, R> => {
      memory = undefined
      const key = { path: invocation.path, id: invocation.id }
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
            settle()
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

    // How a child ended, read from `Storage`. `undefined` means it has not.
    const readChild = Effect.fnUntraced(function*(
      target: ClusterTarget.Target
    ): Effect.fn.Return<
      | { readonly _tag: "Done"; readonly output: unknown }
      | { readonly _tag: "Failed"; readonly failure: string }
      | undefined,
      unknown,
      R
    > {
      const children = options.children
      if (children === undefined) return undefined
      const loaded = yield* storage.load(children.address(target)).pipe(
        // A store that cannot be read now is read again.
        Effect.retry({ schedule: Schedule.spaced("1 second") })
      )
      if (Option.isNone(loaded)) return undefined
      const status = readStatus(loaded.value.status)
      if (status?._tag === "Failed") return { _tag: "Failed", failure: status.failure }
      if (status?._tag !== "Active") return undefined
      const child = target.protocol.machine
      const state: Snapshot = yield* internalMachine.decodeSnapshot(child, loaded.value.snapshot)
      if (!internalMachine.isFinal(child, state)) return undefined
      const output = yield* Planner.getFinalOutputEffect(child, state, Planner.InitialEvent)
      return { _tag: "Done", output }
    })

    const childEnded = (entityId: string): Effect.Effect<void, never, R> =>
      turn((restore) =>
        Effect.gen(function*() {
          if (memory === undefined) yield* reload(restore)
          const current = memory
          if (current?._tag !== "Active") return
          const running = ClusterProgress.children(current.progress).find(([, id]) => id === entityId)
          const protocol = running && options.children?.protocols.get(running[0].id)
          if (running === undefined || protocol === undefined) return
          const [key] = running
          const ended = yield* Effect.exit(readChild(new ClusterTarget.Target(protocol, entityId)))
          if (Exit.isFailure(ended)) {
            yield* storeFailure(
              restore,
              key,
              `The end of child ${entityId} cannot be read: ${renderFailure(ended.cause)}`
            )
            return
          }
          if (ended.value === undefined) return
          if (ended.value._tag === "Failed") {
            yield* storeFailure(restore, key, ended.value.failure)
            return
          }
          yield* applyOutcome(
            restore,
            key,
            current,
            InvocationEventModule.done(key.path, key.id, { current: true }, ended.value.output),
            () => {}
          )
        }).pipe(annotate)
      )

    // One attempt to apply an event that another machine sent. Nobody waits for
    // its answer, so an event that cannot be applied fails the machine, as it
    // does locally, and a failure of the infrastructure is retried. The value is
    // whether nothing is left to do.
    const deliverOnce = (input: RequestInput): Effect.Effect<boolean, never, R> =>
      turn((restore) =>
        Effect.suspend(() => {
          // Loaded with the request, so a refusal is never one of an earlier
          // delivery that committed.
          memory = undefined
          return restore(messageStorage.withTransaction(requestStep(input, undefined))).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause): Effect.Effect<boolean, never, R> => {
                if (Cause.hasInterrupts(cause)) return propagate(cause)
                const error = Option.getOrUndefined(Cause.findErrorOption(cause))
                if (!(error instanceof Refused) || error.failure === undefined || Cause.hasDies(cause)) {
                  return notDone("Could not apply an event that another machine sent", cause)
                }
                memory = error.memory
                // A machine that ended takes no event, as a local one that stopped,
                // and neither does a child that has not started.
                if (error.rejected.reason === "MachineFailed" || (memory?._tag === "Absent" && parent !== undefined)) {
                  return Effect.succeed(true)
                }
                return memory?._tag === "Absent"
                  ? storeInitialFailure(restore, input.requestId, error.failure)
                  : storeFailure(restore, input, error.failure)
              },
              onSuccess: (result) => {
                memory = result.memory
                return Effect.as(align(restore, result.stored), true)
              }
            })
          )
        })
      ).pipe(annotate)

    // Stores a machine without a checkpoint as failed in its initial state, when
    // the first event another machine sent it cannot be applied. A machine
    // whose initial state cannot be planned stores nothing, and drops the event.
    const storeInitialFailure = (
      restore: Restore,
      requestId: Snowflake,
      failure: string
    ): Effect.Effect<boolean, never, R> =>
      Effect.suspend(() => {
        memory = undefined
        return restore(messageStorage.withTransaction(Effect.gen(function*() {
          const initial = yield* Effect.option(internalMachine.planInitial(planned, ...options.input))
          if (Option.isNone(initial)) return false
          const snapshot = yield* internalMachine.encodeSnapshot(machine, initial.value.state)
          const committed = yield* storage.commit(address, {
            definitionId,
            version,
            revision: 1,
            origin: { _tag: "Request", requestId },
            snapshot,
            status: { _tag: "Failed", failure }
          })
          if (committed._tag === "RevisionConflict") return yield* new Conflicted()
          yield* saveOutgoing(endedFor(true))
          return true
        }))).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => notDone("Could not store the failure of a Cluster machine", cause),
            onSuccess: (stored) => {
              memory = stored ? { _tag: "Failed", revision: 1, failure } : undefined
              return Effect.logError(
                stored ? "A Cluster machine failed" : "A Cluster machine cannot plan its initial state",
                failure
              ).pipe(Effect.as(true))
            }
          }),
          annotate
        )
      })

    const lifecycle = (input: RequestInput): Effect.Effect<void, never, R> =>
      turn((restore) =>
        attempt(restore, input).pipe(
          Effect.catchTag("Conflicted", () => attempt(restore, input)),
          Effect.catchTag("Conflicted", () => Effect.void),
          // A stop saves the stops of the children of the child.
          Effect.tap(() => input.lifecycle === "Stop" ? options.sends?.poll ?? Effect.void : Effect.void),
          Effect.tap(() => align(restore, undefined)),
          Effect.asVoid
        )
      )

    const applyRequest = (input: RequestInput): Effect.Effect<SendResult, never, R> =>
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

    return {
      wake,
      childEnded,
      deliver: (input) => untilDone(deliverOnce(input)),
      childSnapshot: ({ entityId, requestId, snapshot }) =>
        untilDone(deliverOnce({ requestId, event: undefined, child: { entityId, snapshot } })),
      start: ({ input, requestId }) =>
        applyRequest({
          requestId,
          event: undefined,
          lifecycle: "Start",
          initial: machine.input === undefined ? [] : [input]
        }),
      stop: (requestId) => lifecycle({ requestId, event: undefined, lifecycle: "Stop" }),
      apply: (input) => applyRequest(input)
    }
  })
