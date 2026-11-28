/**
 * Runs a machine on its owned step, as a compiled process of the local runtime.
 *
 * The step decides everything a machine does: its next state, its commands and
 * emissions, the work it starts and stops, and what the result of that work
 * means. This module only carries a step out, in the order of the step: the
 * commands, the work of exited states, the new state, the emitted events, then
 * the work of entered states. Work runs as an owned process of the machine, so
 * it starts in the turn of the event that entered its state, and its result
 * reaches the step through the mailbox of the machine, in a later turn.
 *
 * @since 0.48.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import type { Inspection } from "../../LocalMachine.js"
import type { ChildMachine, Machine } from "../../Machine.js"
import * as ChildRegistry from "./childRegistry.js"
import * as CommandRuntime from "./commandRuntime.js"
import { ChildAlreadyExistsError, failPlanning } from "./errors.js"
import type * as InvocationEvent from "./invocationEvent.js"
import * as InvocationOutcome from "./invocationOutcome.js"
import type * as InvocationResolution from "./invocationResolution.js"
import * as Runtime from "./runtimeProtocol.js"
import * as Step from "./step.js"

type OwnedStep = Step.Step<"Owned">
type Kernel = Step.Kernel<"Owned">
type Context = Runtime.CompiledProcessContext<Machine.Snapshot<any>, unknown>
type Scope = Runtime.ProcessInitialContext<unknown>
type AnyProcessLogic = Runtime.ProcessLogic<any, any, any, any, any, any>
type Drain = Effect.Effect<Option.Option<unknown>, unknown, unknown>

/** How a process of the machine begins: started with input, or resumed from a snapshot. */
export type Entry =
  | { readonly _tag: "Initial"; readonly args: ReadonlyArray<unknown> }
  | { readonly _tag: "Resume"; readonly snapshot: Machine.Snapshot<any> }

/**
 * The host of a step in a process, which is also the execution state of the
 * process: the latest state of its step, and the step whose work is still to
 * start, which only its first step has. Work runs as a process of the
 * machine, which finds the services of the machine in its own: every process
 * of the runtime provides them. The children of the machine are the children
 * its process owns.
 */
class Host extends Step.Planning implements Step.Children {
  state!: Step.State<"Owned">
  pending: OwnedStep | undefined
  liveRuntime: CommandRuntime.LiveRuntime | undefined

  constructor(machine: Machine.Any, kernel: Kernel, private readonly scope: Scope) {
    super(machine, kernel.plan, scope.self, scope.parent, undefined, true)
  }

  spawn(child: ChildMachine.Any, options: { readonly input: unknown } | undefined) {
    const spawn = this.scope.spawn as (child: unknown, ...options: ReadonlyArray<unknown>) => Effect.Effect<unknown>
    return options === undefined ? spawn(child) : spawn(child, options)
  }
  spawnLogic(
    logic: Parameters<Step.Children["spawnLogic"]>[0],
    options: { readonly id?: string | undefined } | undefined
  ) {
    const spawn = this.scope.spawn as (logic: unknown, options?: unknown) => Effect.Effect<unknown>
    return options === undefined ? spawn(logic) : spawn(logic, options)
  }
  sendTo(child: string | ChildMachine.Any, event: unknown) {
    return this.scope.sendTo(child, event)
  }
  stop(child: string | ChildMachine.Any) {
    return this.scope.stopChild(child)
  }
}

/** Whether the process reports what it does, so its steps keep their microsteps. */
const isInspected = (scope: Scope): boolean => scope.self.inspectionSubject !== undefined

const runSequentialDiscard = (effects: ReadonlyArray<Effect.Effect<void, any, any>>): Effect.Effect<void, any, any> =>
  effects.length === 1 ? effects[0]! : Effect.all(effects, { discard: true })

/** Carries out the commands of a step, in order. */
const runCommands = (commands: ReadonlyArray<Step.Command>, scope: Scope): Effect.Effect<void, any, any> =>
  Effect.forEach(commands, (command) => {
    switch (command._tag) {
      case "Send":
        return scope.sendTo(command.target, command.event)
      case "SendToChild":
        return scope.sendTo(command.child, command.event)
      case "StopChild":
        return scope.stopChild(command.child)
    }
  }, { discard: true })

/** @internal */
export const makeKey = (path: string, id: string): string => `${path.length}:${path}${id}`

/** Stops running work, all at once, as the local runtime stops the children of exited states. */
const stopWork = (context: Context, work: ReadonlyArray<Step.Work>): Effect.Effect<void> | undefined =>
  work.length === 0
    ? undefined
    : work.length === 1
    ? context.ownedChildren.stopKey(makeKey(work[0]!.path, work[0]!.id))
    : Effect.all(work.map((one) => context.ownedChildren.stopKey(makeKey(one.path, one.id))), {
      concurrency: "unbounded",
      discard: true
    })

// Invocations the runtime hosts as an inspected and traced program.
type ProgramInvocation =
  | InvocationResolution.EffectInvocation
  | InvocationResolution.TimerInvocation
  | InvocationResolution.StreamInvocation

const isProgram = (invocation: InvocationResolution.ResolvedInvocation): invocation is ProgramInvocation =>
  invocation._tag === "Effect" || invocation._tag === "Timer" || invocation._tag === "Stream"

// Logic addresses and child descriptor ids are caller-chosen; every other id is
// owned by the runtime.
const childId = (invocation: InvocationResolution.ResolvedInvocation): string => {
  switch (invocation._tag) {
    case "Effect":
    case "Timer":
    case "Stream":
      return `${ChildRegistry.invocationChildIdPrefix}${makeKey(invocation.path, invocation.id)}`
    case "Logic":
      return invocation.address
    case "Child":
      return invocation.child.id
  }
}

/**
 * The value of an accessor of work. Its failure is thrown inside the startup
 * boundary of the process that would run the work, which fails the machine.
 */
const valueOf = <A>(exit: Exit.Exit<A>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

// The planner reads currency from a generation. The registry of the process
// decides currency for the work it hosts, so each decision gets a current one.
const current = (): InvocationEvent.Generation => ({ current: true })

/** The exit of work as its step settles it. */
const exitOf = (outcome: InvocationOutcome.Outcome): Exit.Exit<unknown, unknown> =>
  outcome._tag === "Done"
    ? Exit.succeed(outcome.output)
    : Exit.failCause((outcome as { cause: Cause.Cause<unknown> }).cause)

const traced = (scope: Scope, invocation: ProgramInvocation, logic: AnyProcessLogic): AnyProcessLogic => ({
  ...logic,
  run: (context: Runtime.ProcessRunContext<any, any>) =>
    Effect.withSpan(
      Effect.suspend(() => logic.run(context)),
      "Machine.invoke",
      {
        attributes: {
          "machine.id": scope.self.id,
          "machine.sessionId": scope.self.sessionId,
          "machine.state.path": invocation.path,
          "machine.invoke.id": invocation.id,
          "machine.invoke.source": invocation.sourceName ?? invocation.id,
          "machine.invoke.kind": invocation._tag,
          "machine.invoke.sessionId": context.self.sessionId
        },
        captureStackTrace: false
      }
    )
})

/** The process that runs a program, built when its process starts. */
const programLogic = (scope: Scope, work: Step.Work, invocation: ProgramInvocation): AnyProcessLogic => {
  switch (work._tag) {
    case "Effect": {
      const effect = valueOf(work.effect())
      return traced(scope, invocation, { initial: () => Effect.void, run: () => effect })
    }
    case "Timer": {
      const duration = valueOf(work.duration())
      return traced(scope, invocation, { initial: () => Effect.void, run: () => Effect.sleep(duration) })
    }
    case "Stream": {
      const stream = valueOf(work.stream())
      const inspected = isInspected(scope)
      return traced(scope, invocation, {
        initial: () => Effect.void,
        run: ({ parent }: Runtime.ProcessRunContext<any, any>) => {
          const send = parent?.[Runtime.acknowledgedSend]
          if (send === undefined) {
            return Effect.die(new Error("Stream invocation requires an acknowledged parent machine"))
          }
          // Each element waits for the machine to take it, which paces the stream.
          return Effect.scoped(Stream.runForEach(
            stream,
            (element) =>
              send(
                new Runtime.WorkMessage(
                  "Element",
                  work,
                  element,
                  inspected
                    ? (InvocationOutcome.decideElement(
                      invocation as InvocationResolution.StreamInvocation,
                      current(),
                      element
                    ) as InvocationOutcome.Deliver).event
                    : undefined
                )
              ).pipe(
                Effect.asVoid,
                Effect.catchCause(() => Effect.interrupt)
              )
          ))
        }
      })
    }
    default:
      throw new Error(`Work of kind ${work._tag} is not a program`)
  }
}

/** Reports the result of work to its machine, which plans it in a later turn. */
const report = (
  scope: Scope,
  message: Runtime.WorkMessage,
  invocationSessionId: string | undefined
): Effect.Effect<void> =>
  (invocationSessionId === undefined || scope.self.sendInspected === undefined
    ? scope.self.send(message)
    : scope.self.sendInspected(
      message,
      scope.self.inspectionSubject,
      { _tag: "ProgramInvocation", invocationSessionId } satisfies Inspection.Causation
    )).pipe(Effect.catchTag("StoppedError", () => Effect.void))

/** Starts one piece of work that a step listed, as an owned process of the machine. */
const startWork = (context: Context, work: Step.Work): Effect.Effect<void, any, any> => {
  const scope = context.scope
  const invocation = work[Step.WorkTypeId]
  const program = isProgram(invocation)
  // Keep caller-chosen ids out of the namespace reserved for runtime-owned
  // invocation ids; runtime-owned ids skip this check.
  if (!program && ChildRegistry.isReservedChildId(childId(invocation))) {
    return Effect.fail(new ChildAlreadyExistsError({ id: invocation.id }))
  }
  return Effect.suspend(() =>
    context.ownedChildren.spawn(
      program
        ? () => programLogic(scope, work, invocation)
        : work._tag === "Logic"
        ? () => valueOf(work.logic()) as AnyProcessLogic
        // The runtime builds the child's logic from this description, so a
        // running parent retains no closure for it.
        : invocation as Extract<InvocationResolution.ResolvedInvocation, { readonly _tag: "Child" }>,
      {
        key: makeKey(work.path, work.id),
        path: work.path,
        id: childId(invocation),
        duplicateId: work.id,
        ...(program ? { programKind: invocation._tag } : undefined),
        sendParent: (isCurrent, event) => isCurrent() ? scope.self.send(event) : Effect.void,
        // The work starts while the event that entered its state is processed,
        // and its outcome is handled in a later turn, even when the work
        // completes without suspending. The entered state is therefore always
        // observed before the outcome leaves it, and the outcome of a state that
        // was exited in between is discarded.
        onOutcome: (isCurrent, outcome, invocationSessionId) =>
          Effect.andThen(
            Effect.yieldNow,
            Effect.suspend(() => {
              if (!isCurrent()) return Effect.void
              // The step decides what the outcome means. A failure fails the
              // machine at once, as the step would when it settles the work.
              const decision = InvocationOutcome.decide(invocation, current(), outcome)
              switch (decision._tag) {
                case "Deliver":
                  return report(
                    scope,
                    new Runtime.WorkMessage("Settle", work, exitOf(outcome), decision.event),
                    program ? invocationSessionId : undefined
                  )
                case "Fail":
                  return scope.failCause(decision.cause)
                case "Ignore":
                  return Effect.void
              }
            })
          ),
        ...(invocation.channels.snapshot
          ? {
            onSnapshot: (isCurrent: () => boolean, snapshot: { readonly state: unknown }) => {
              if (!isCurrent()) return Effect.void
              const decision = InvocationOutcome.decideSnapshot(invocation, current(), snapshot)
              return decision._tag === "Ignore"
                ? Effect.void
                : report(scope, new Runtime.WorkMessage("Report", work, snapshot.state, decision.event), undefined)
            }
          }
          : undefined)
      }
    )
  )
}

const startAll = (context: Context, work: ReadonlyArray<Step.Work>): Effect.Effect<void, any, any> | undefined =>
  work.length === 0 ? undefined : runSequentialDiscard(work.map((one) => startWork(context, one)))

/** The plan of a step, as an acknowledged delivery reports it. */
const planOf = (step: OwnedStep): unknown => {
  const microsteps = step.microsteps
  const exit = step.exit
  return {
    event: step.event,
    next: step.snapshot,
    commands: microsteps.length === 0 ? microsteps : microsteps.flatMap((microstep) => microstep.commands),
    emittedEvents: step.emitted,
    microsteps,
    done: exit !== undefined && Exit.isSuccess(exit),
    output: exit !== undefined && Exit.isSuccess(exit) ? exit.value : undefined
  }
}

const noQueuedMessages: Drain = Effect.succeed(Option.none())

/**
 * The drain of a machine on `kernel`. It plans each message with the step,
 * commits steps that need no effectful work in the caller, and returns the
 * drain continuing from the first step that does.
 */
const makeDrain = (machine: Machine.Any, kernel: Kernel, childless: boolean) => {
  // A machine that invokes no work keeps only its snapshot until it takes a
  // message, and its state from then on.
  const hostOf = (context: Context): Host => {
    let host = context.executionState as Host | undefined
    if (host === undefined) {
      host = new Host(machine, kernel, context.scope)
      host.state = kernel.fromSnapshot(host, context.state())
      context.executionState = host
    }
    return host
  }

  const takeMessage = (state: Step.State<"Owned">, event: unknown, retain: boolean): OwnedStep => {
    if (event instanceof Runtime.WorkMessage) {
      const work = event.work as Step.Work
      switch (event._tag) {
        case "Settle":
          return kernel.settle(state, work, event.value as Exit.Exit<unknown, unknown>, retain)
        case "Element":
          return kernel.element(state, work, event.value, retain)
        case "Report":
          return kernel.report(state, work, event.value, retain)
      }
    }
    return kernel.sendDecoded(state, event as Machine.EventOf<any>, retain)
  }

  const loop = (context: Context): Drain => Effect.suspend(() => drainSync(context) ?? noQueuedMessages)

  /** Starts the work of the first step of the process, then drains. */
  const startPending = (context: Context, host: Host, step: OwnedStep): Drain => {
    host.pending = undefined
    const starting = startAll(context, step.start)
    return starting === undefined ? loop(context) : starting.pipe(Effect.andThen(loop(context)))
  }

  /** Carries out a step that needs effectful work, then continues the drain. */
  const continueEffectful = (
    context: Context,
    host: Host,
    step: OwnedStep,
    acknowledged: boolean,
    before: Machine.Snapshot<any>,
    settled: Step.Work | undefined
  ): Drain => {
    const scope = context.scope
    const exit = step.exit
    const done = exit !== undefined
    // A machine that ends stops the work of the states it exited before its
    // new state, and then the rest of its work, after its emitted events.
    // Work that ended in a state the step exits is awaited with the rest, so
    // its process has stopped before the state is entered again.
    let stopBefore: ReadonlyArray<Step.Work> = settled === undefined ? step.stop : [settled, ...step.stop]
    let stopAfter: ReadonlyArray<Step.Work> = []
    if (done && step.stop.length > 0) {
      const exited = new Set(step.exited)
      stopBefore = stopBefore.filter((work) => exited.has(work.path))
      stopAfter = step.stop.filter((work) => !exited.has(work.path))
    }
    const beforeCommit: Array<Effect.Effect<void, any, any>> = []
    if (step.commands.length > 0) beforeCommit.push(runCommands(step.commands, scope))
    const stopping = stopWork(context, stopBefore)
    if (stopping !== undefined) beforeCommit.push(stopping)
    const afterCommit: Array<Effect.Effect<void, any, any>> = []
    if (step.emitted.length > 0) {
      afterCommit.push(
        CommandRuntime.runEmittedEvents(
          step.emitted,
          host.liveRuntime ??= CommandRuntime.makeLiveRuntime(machine, scope)
        )
      )
    }
    if (done) {
      const stopped = stopWork(context, stopAfter)
      if (stopped !== undefined) afterCommit.push(stopped)
    } else {
      const starting = startAll(context, step.start)
      if (starting !== undefined) afterCommit.push(starting)
    }
    const planned = step.planned
    const after = planned ? step.snapshot : before
    const continueAfterCommit = (): Drain => {
      const continued = Effect.suspend((): Drain => {
        if (acknowledged) context.completeMessage({ before, plan: planOf(step), after })
        return done ? Effect.succeed(Option.some((exit as Exit.Success<unknown>).value)) : loop(context)
      })
      return afterCommit.length === 0 ? continued : runSequentialDiscard(afterCommit).pipe(Effect.andThen(continued))
    }
    const commitAndContinue = (): Drain => {
      const notification = planned ? context.commit(after) : undefined
      const continued = continueAfterCommit()
      const effect = notification === undefined ? continued : notification.pipe(Effect.andThen(continued))
      return notification === undefined && afterCommit.length === 0 ? effect : context.runAfterChanges(effect)
    }
    return beforeCommit.length === 0
      ? commitAndContinue()
      : context.runAfterChanges(
        runSequentialDiscard(beforeCommit).pipe(Effect.andThen(Effect.suspend(commitAndContinue)))
      )
  }

  // Commits queued messages whose steps need no effectful work. Returns the
  // drain continuing from the first message that does, or `undefined` once the
  // mailbox is empty.
  const drainSync = (context: Context, first?: Runtime.ProcessMessage<unknown>): Drain | undefined => {
    const host = hostOf(context)
    if (host.pending !== undefined) {
      if (first !== undefined) context.beginMessage(first)
      return startPending(context, host, host.pending)
    }
    let delivered = first
    while (true) {
      let message: Runtime.ProcessMessage<unknown>
      if (delivered !== undefined) {
        message = delivered
        delivered = undefined
        context.beginMessage(message)
      } else {
        const pending = context.pollMessage()
        if (Option.isNone(pending)) {
          // A machine that runs work keeps, while it is idle, only what the
          // work needs: its execution state is built again for its next message.
          if (!childless) host.state = kernel.rest(host.state)
          return undefined
        }
        message = pending.value
      }
      const acknowledged = Runtime.isAcknowledgedMessage(message)
      const event = Runtime.messageEvent(message)
      if (event instanceof Runtime.RefusedEvent) return failPlanning(event.error)
      const before = context.state()
      // Only an acknowledged delivery reads the microsteps of its step.
      const step = takeMessage(host.state, event, acknowledged)
      host.state = step.state
      const exit = step.exit
      if (exit !== undefined && Exit.isFailure(exit)) return Effect.failCause(exit.cause)
      const settled = event instanceof Runtime.WorkMessage && event._tag === "Settle" && step.planned &&
          step.exited.includes((event.work as Step.Work).path)
        ? event.work as Step.Work
        : undefined
      if (
        exit === undefined && settled === undefined && step.commands.length === 0 && step.stop.length === 0 &&
        step.start.length === 0 && step.emitted.length === 0
      ) {
        if (!step.planned) {
          if (acknowledged) context.completeMessage({ before, plan: planOf(step), after: before })
          continue
        }
        const next = step.snapshot
        const notification = context.commit(next)
        if (notification !== undefined) {
          return context.runAfterChanges(notification.pipe(Effect.andThen(Effect.suspend(() => {
            if (acknowledged) context.completeMessage({ before, plan: planOf(step), after: next })
            return loop(context)
          }))))
        }
        if (acknowledged) context.completeMessage({ before, plan: planOf(step), after: next })
        continue
      }
      return continueEffectful(context, host, step, acknowledged, before, settled)
    }
  }

  return {
    run: (context: Context): Drain =>
      Runtime.provideMachineRuntime(Effect.suspend(() => drainSync(context) ?? noQueuedMessages), context.scope),
    runSync: (context: Context, message: Runtime.ProcessMessage<unknown>): Drain | undefined => {
      const remaining = drainSync(context, message)
      return remaining === undefined ? undefined : Runtime.provideMachineRuntime(remaining, context.scope)
    }
  }
}

/** The result of the first step of a process, as the compiled process takes it. */
const initialOf = (
  step: OwnedStep,
  host: Host | undefined
): Runtime.CompiledProcessInitial<Machine.Snapshot<any>, unknown> => {
  const exit = step.exit
  const done = exit !== undefined && Exit.isSuccess(exit)
  if (host === undefined) {
    return done
      ? { state: step.snapshot, done: true, output: (exit as Exit.Success<unknown>).value }
      : { state: step.snapshot, done: false, output: undefined }
  }
  return done
    ? { state: step.snapshot, done: true, output: (exit as Exit.Success<unknown>).value, executionState: host }
    : { state: step.snapshot, done: false, output: undefined, executionState: host }
}

/**
 * The execution of a machine on its owned step, which plans with `planner`.
 *
 * @internal
 */
export const makeExecution = (
  machine: Machine.Any,
  entry: Entry,
  planner: "Compiled" | "Reference",
  childless: boolean,
  decodeEvent: Runtime.EventDecoder
): Runtime.CompiledProcessExecution<Machine.Snapshot<any>, unknown, any, any, any, any> => {
  const kernel = Step.kernel(machine, "Owned", planner)
  const drain = makeDrain(machine, kernel, childless)

  const first = (scope: Scope): Exit.Exit<OwnedStep, unknown> =>
    entry._tag === "Initial"
      ? kernel.start(new Host(machine, kernel, scope), entry.args, isInspected(scope))
      : kernel.resume(new Host(machine, kernel, scope), entry.snapshot)

  // An idle machine that invokes no work holds only its snapshot.
  const host = (step: OwnedStep): Host | undefined => {
    if (childless) return undefined
    const host = step.state.planning as Host
    host.state = step.state
    if (step.start.length > 0) host.pending = step
    return host
  }

  // A machine that its execution plan starts runs no command and emits nothing
  // when it starts, so it starts without an Effect.
  const initialSync = entry._tag === "Initial" && kernel.plan.initial !== undefined
    ? (scope: Scope): Runtime.CompiledProcessInitial<Machine.Snapshot<any>, unknown> => {
      const started = first(scope)
      if (Exit.isFailure(started)) throw Cause.squash(started.cause)
      const step = started.value
      if (step.commands.length > 0 || step.emitted.length > 0) {
        throw new Error("Machine started by its execution plan planned startup commands or emissions")
      }
      if (entry._tag === "Initial" && isInspected(scope)) scope.inspectInitial(step.entered, step.microsteps)
      return initialOf(step, host(step))
    }
    : undefined

  const initial = (
    scope: Scope
  ): Effect.Effect<Runtime.CompiledProcessInitial<Machine.Snapshot<any>, unknown>, unknown, unknown> =>
    Runtime.provideMachineRuntime(
      Effect.suspend(() => {
        const started = first(scope)
        if (Exit.isFailure(started)) return Effect.failCause(started.cause)
        const step = started.value
        if (entry._tag === "Initial" && isInspected(scope)) scope.inspectInitial(step.entered, step.microsteps)
        const result = Effect.succeed(initialOf(step, host(step)))
        const commands = step.commands.length === 0 ? undefined : runCommands(step.commands, scope)
        const emitted = step.emitted.length === 0
          ? undefined
          : CommandRuntime.runEmittedEvents(step.emitted, CommandRuntime.makeLiveRuntime(machine, scope))
        return commands === undefined
          ? emitted === undefined ? result : emitted.pipe(Effect.andThen(result))
          : emitted === undefined
          ? commands.pipe(Effect.andThen(result))
          : commands.pipe(Effect.andThen(emitted), Effect.andThen(result))
      }),
      scope
    )

  return {
    _tag: "Compiled",
    childless,
    decodeEvent,
    initial,
    ...(initialSync === undefined ? undefined : { initialSync }),
    drain: { _tag: "Owned", run: drain.run, runSync: drain.runSync }
  }
}
