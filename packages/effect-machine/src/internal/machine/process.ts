/**
 * Internal machine process integration.
 *
 * @since 0.4.0
 */

import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { Machine, Runtime } from "../../Machine.js"
import * as CommandRuntime from "./commandRuntime.js"
import * as Configuration from "./configuration.js"
import { failPlanning, toStartupFailure } from "./errors.js"
import * as ExecutionPlan from "./executionPlan.js"
import { type CapturedStateConfig, toImpl } from "./implementation.js"
import * as Invocation from "./invocation.js"
import * as internalPlanner from "./planner.js"
import * as internalRuntime from "./runtime.js"
import * as internalRuntimeProtocol from "./runtimeProtocol.js"
import * as Serialization from "./serialization.js"

type ProcessEntry =
  | {
    readonly _tag: "Initial"
    readonly args: ReadonlyArray<unknown>
  }
  | {
    readonly _tag: "Resume"
    readonly snapshot: Machine.Snapshot<any>
  }

const runSequentialDiscard = <E, R>(
  effects: ReadonlyArray<Effect.Effect<void, E, R>>
): Effect.Effect<void, E, R> =>
  effects.length === 0
    ? Effect.void
    : effects.length === 1
    ? effects[0]!
    : Effect.all(effects, { discard: true })

const acknowledgedPlan = (
  planned: {
    readonly event: unknown
    readonly next: unknown
    readonly commands: ReadonlyArray<unknown>
    readonly emittedEvents: ReadonlyArray<unknown>
    readonly microsteps: ReadonlyArray<{
      readonly next: unknown
      readonly event: unknown
      readonly transitions?: ReadonlyArray<unknown>
      readonly commands: ReadonlyArray<unknown>
      readonly raisedEvents: ReadonlyArray<unknown>
      readonly emittedEvents: ReadonlyArray<unknown>
      readonly exitPaths: ReadonlyArray<string>
      readonly entryPaths: ReadonlyArray<string>
      readonly changed: boolean
    }>
    readonly done: boolean
    readonly output: unknown
  },
  snapshot: (state: unknown) => unknown
): unknown => ({
  event: planned.event,
  next: snapshot(planned.next),
  commands: planned.commands,
  emittedEvents: planned.emittedEvents,
  microsteps: planned.microsteps.map((microstep) => {
    return { ...microstep, transitions: microstep.transitions ?? [], next: snapshot(microstep.next) }
  }),
  done: planned.done,
  output: planned.output
})

const invokeCapabilityCache = new WeakMap<Machine.Any, boolean>()

const hasInvokeCapability = (machine: Machine.Any): boolean => {
  const cached = invokeCapabilityCache.get(machine)
  if (cached !== undefined) {
    return cached
  }
  const hasInvokes = Object.values(
    toImpl(machine).handlers as Record<string, CapturedStateConfig>
  ).some((config) => config.invoke !== undefined)
  invokeCapabilityCache.set(machine, hasInvokes)
  return hasInvokes
}

const makeChildlessCompiledDrain = (
  machine: Machine.Any,
  checkInitialFinal: boolean
): (
  context: internalRuntimeProtocol.CompiledProcessContext<any, any>
) => Effect.Effect<Option.Option<any>, any, any> => {
  const executionPlan = ExecutionPlan.compileExecutionPlan(machine)
  return (context) => {
    let current = context.state()
    if (checkInitialFinal && internalPlanner.isFinalState(machine, current)) {
      return internalPlanner.getFinalOutputEffect(
        machine,
        current,
        internalPlanner.InitialEvent
      ).pipe(Effect.map(Option.some))
    }

    let configuration = context.executionState
    let liveRuntime: Runtime<unknown, unknown> | undefined
    let loop: Effect.Effect<Option.Option<any>, any, any>
    loop = Effect.suspend(() => {
      const pending = context.pollMessage()
      if (Option.isNone(pending)) {
        context.executionState = undefined
        return Effect.succeed(Option.none())
      }

      const message = pending.value
      const acknowledged = internalRuntimeProtocol.isAcknowledgedMessage(message)
      const event = acknowledged ? message.event : message
      const before = current

      let planned
      try {
        planned = executionPlan.plan(
          configuration ?? executionPlan.fromConfiguration(Configuration.normalizeConfigurationSync(machine, current)),
          event,
          acknowledged,
          context.scope
        )
      } catch (error) {
        return failPlanning(error)
      }
      configuration = planned.next
      context.executionState = configuration
      if (planned.microsteps.length === 0) {
        if (acknowledged) {
          context.completeMessage({ before, plan: acknowledgedPlan(planned, executionPlan.snapshot), after: current })
        }
        return loop
      }

      const next = executionPlan.snapshot(planned.next)
      const beforeCommit = planned.commands.length === 0
        ? undefined
        : CommandRuntime.runCommands(planned.commands, context.scope)
      const afterCommit = planned.emittedEvents.length === 0
        ? undefined
        : CommandRuntime.runEmittedEvents(
          planned.emittedEvents,
          liveRuntime ??= CommandRuntime.makeLiveRuntime(machine, context.scope)
        )
      const commit = (): Effect.Effect<void> | undefined => {
        const notification = context.commit(next)
        current = next
        return notification
      }
      const continueAfterCommit = (): Effect.Effect<Option.Option<any>, any, any> => {
        const continued = Effect.suspend(() => {
          if (acknowledged) {
            context.completeMessage({ before, plan: acknowledgedPlan(planned, executionPlan.snapshot), after: next })
          }
          return planned.done ? Effect.succeed(Option.some(planned.output)) : loop
        })
        return afterCommit === undefined ? continued : afterCommit.pipe(Effect.andThen(continued))
      }
      const commitAndContinue = (): Effect.Effect<Option.Option<any>, any, any> => {
        const notification = commit()
        const continued = continueAfterCommit()
        const effect = notification === undefined ? continued : notification.pipe(Effect.andThen(continued))
        return notification === undefined && afterCommit === undefined
          ? effect
          : context.runAfterChanges(effect)
      }

      if (beforeCommit === undefined) {
        return commitAndContinue()
      }
      return context.runAfterChanges(
        beforeCommit.pipe(Effect.andThen(Effect.suspend(commitAndContinue)))
      )
    })
    return internalRuntimeProtocol.provideMachineRuntime(loop, context.scope)
  }
}

class InvokeExecutionState {
  initialized = false
  initial:
    | {
      readonly configuration: unknown
      readonly activeConfiguration: Configuration.ActiveConfiguration
      readonly entryPaths: ReadonlyArray<string>
    }
    | undefined

  constructor(initial?: {
    readonly configuration: unknown
    readonly activeConfiguration: Configuration.ActiveConfiguration
    readonly entryPaths: ReadonlyArray<string>
  }) {
    this.initial = initial
  }
}

const makeInvokingCompiledDrain = (
  machine: Machine.Any,
  checkInitialFinal: boolean
): (
  context: internalRuntimeProtocol.CompiledProcessContext<any, any>
) => Effect.Effect<Option.Option<any>, any, any> => {
  const executionPlan = ExecutionPlan.compileExecutionPlan(machine)
  return (context) => {
    let current = context.state()
    if (checkInitialFinal && internalPlanner.isFinalState(machine, current)) {
      return internalPlanner.getFinalOutputEffect(
        machine,
        current,
        internalPlanner.InitialEvent
      ).pipe(Effect.map(Option.some))
    }

    const scope = context.scope
    const stored = context.executionState
    const execution = stored instanceof InvokeExecutionState
      ? stored
      : new InvokeExecutionState()
    context.executionState = execution
    let liveRuntime: Runtime<any, any> | undefined
    let configuration: unknown

    let loop: Effect.Effect<Option.Option<any>, any, any>
    loop = Effect.suspend(() => {
      const pending = context.pollMessage()
      if (Option.isNone(pending)) {
        configuration = undefined
        return Effect.succeed(Option.none())
      }

      const message = pending.value
      const acknowledged = internalRuntimeProtocol.isAcknowledgedMessage(message)
      const event = acknowledged ? message.event : message
      const before = current

      let planned
      try {
        planned = executionPlan.plan(
          configuration ??
            executionPlan.fromConfiguration(Configuration.normalizeConfigurationSync(machine, current)),
          event,
          acknowledged,
          scope
        )
      } catch (error) {
        return failPlanning(error)
      }
      configuration = planned.next
      if (planned.microsteps.length === 0) {
        if (acknowledged) {
          context.completeMessage({ before, plan: acknowledgedPlan(planned, executionPlan.snapshot), after: current })
        }
        return loop
      }

      const changed = planned.microsteps.some((step) => step.changed)
      const exitPaths = changed ? planned.microsteps.flatMap((step) => step.exitPaths) : []
      const entryEvents = new Map<string, Machine.LifecycleEvent<any>>()
      if (changed) {
        for (const step of planned.microsteps) {
          if (step.changed) {
            for (const path of step.entryPaths) {
              entryEvents.set(path, step.event)
            }
          }
        }
      }

      const activeConfiguration = executionPlan.toConfiguration(planned.next)
      const next = executionPlan.snapshot(planned.next)
      const beforeCommit: Array<Effect.Effect<void, any, any>> = []
      if (planned.commands.length > 0) {
        beforeCommit.push(CommandRuntime.runCommands(planned.commands, scope))
      }
      if (changed) {
        const stopping = context.ownedChildren.stopPaths(exitPaths)
        if (stopping !== undefined) beforeCommit.push(stopping)
      }
      const afterCommit: Array<Effect.Effect<void, any, any>> = []
      if (planned.emittedEvents.length > 0) {
        afterCommit.push(
          CommandRuntime.runEmittedEvents(
            planned.emittedEvents,
            liveRuntime ??= CommandRuntime.makeLiveRuntime(machine, scope)
          )
        )
      }
      if (planned.done) {
        afterCommit.push(context.ownedChildren.stopAll())
      } else if (changed) {
        for (const [path, entryEvent] of entryEvents) {
          const starting = Invocation.startAll(
            machine,
            scope,
            context.ownedChildren,
            activeConfiguration,
            [path],
            entryEvent
          )
          if (starting !== undefined) afterCommit.push(starting)
        }
      }

      const commit = (): Effect.Effect<void> | undefined => {
        const notification = context.commit(next)
        current = next
        return notification
      }
      const continueAfterCommit = (): Effect.Effect<Option.Option<any>, any, any> => {
        const continued = Effect.suspend(() => {
          if (acknowledged) {
            context.completeMessage({ before, plan: acknowledgedPlan(planned, executionPlan.snapshot), after: next })
          }
          return planned.done ? Effect.succeed(Option.some(planned.output)) : loop
        })
        return afterCommit.length === 0
          ? continued
          : runSequentialDiscard(afterCommit).pipe(Effect.andThen(continued))
      }
      const commitAndContinue = (): Effect.Effect<Option.Option<any>, any, any> => {
        const notification = commit()
        const continued = continueAfterCommit()
        const effect = notification === undefined ? continued : notification.pipe(Effect.andThen(continued))
        return notification === undefined && afterCommit.length === 0
          ? effect
          : context.runAfterChanges(effect)
      }
      if (beforeCommit.length === 0) {
        return commitAndContinue()
      }
      return context.runAfterChanges(
        runSequentialDiscard(beforeCommit).pipe(Effect.andThen(Effect.suspend(commitAndContinue)))
      )
    })

    const initialize = (): Effect.Effect<Option.Option<any>, any, any> => {
      if (execution.initialized) {
        return loop
      }
      const seeded = execution.initial
      const initialConfiguration = seeded?.activeConfiguration ??
        Configuration.normalizeConfigurationSync(machine, current)
      configuration = seeded?.configuration ?? executionPlan.fromConfiguration(initialConfiguration)
      const starting = Invocation.startAll(
        machine,
        scope,
        context.ownedChildren,
        initialConfiguration,
        seeded?.entryPaths ?? Configuration.getInitialEntryPaths(machine, initialConfiguration),
        internalPlanner.InitialEvent
      )
      execution.initial = undefined
      execution.initialized = true
      return starting === undefined ? loop : starting.pipe(Effect.andThen(loop))
    }
    return internalRuntimeProtocol.provideMachineRuntime(Effect.suspend(initialize), scope)
  }
}

// Planned initial states only carry an output once the machine is done.
const initialResult = (
  planned: { readonly state: Machine.Snapshot<any>; readonly done: boolean; readonly output: unknown }
): internalRuntimeProtocol.CompiledProcessInitial<Machine.Snapshot<any>, unknown> =>
  planned.done
    ? { state: planned.state, done: true, output: planned.output }
    : { state: planned.state, done: false, output: undefined }

// Process logic executes erased machine definitions. The public `Machine`
// module owns the typed contract that specializes this boundary.
const makeProcessLogic = (
  machine: Machine.Any,
  entry: ProcessEntry
): internalRuntimeProtocol.ProcessLogic<any, any, any, any, any, any> => {
  const hasInvokes = hasInvokeCapability(machine)
  const executionPlan = ExecutionPlan.compileExecutionPlan(machine)
  const initialArgs = entry._tag === "Initial" ? entry.args : []
  const compiledInitial = entry._tag === "Initial" ? executionPlan.initial : undefined
  const makeCompiledInitial = compiledInitial === undefined ? undefined : (
    scope: internalRuntimeProtocol.ProcessScope<Machine.EventOf<any>>
  ) => {
    try {
      const planned = compiledInitial(initialArgs, scope)
      scope.inspectInitial(planned.initialEntryPaths)
      const result = initialResult(planned)
      return hasInvokes
        ? {
          ...result,
          executionState: new InvokeExecutionState({
            configuration: planned.configuration,
            activeConfiguration: planned.activeConfiguration,
            entryPaths: planned.initialEntryPaths
          })
        }
        : result
    } catch (error) {
      throw toStartupFailure(error)
    }
  }
  const makeInitial = (
    scope: internalRuntimeProtocol.ProcessScope<Machine.EventOf<any>>
  ) =>
    compiledInitial === undefined
      ? internalRuntimeProtocol.provideMachineRuntime(
        internalPlanner.planInitial(internalPlanner.withMachineReferences(machine, scope), ...initialArgs).pipe(
          Effect.flatMap((planned) => {
            scope.inspectInitial(planned.initialEntryPaths, planned.microsteps)
            const commands = planned.commands.length === 0
              ? undefined
              : CommandRuntime.runCommands(planned.commands, scope)
            const emitted = planned.emittedEvents.length === 0
              ? undefined
              : CommandRuntime.runEmittedEvents(
                planned.emittedEvents,
                CommandRuntime.makeLiveRuntime(machine, scope)
              )
            const result = Effect.succeed(initialResult(planned))
            return commands === undefined
              ? emitted === undefined ? result : emitted.pipe(Effect.andThen(result))
              : emitted === undefined
              ? commands.pipe(Effect.andThen(result))
              : commands.pipe(Effect.andThen(emitted), Effect.andThen(result))
          })
        ),
        scope
      )
      : Effect.try({ try: () => makeCompiledInitial!(scope), catch: toStartupFailure })
  return ({
    inspection: { kind: "Machine", definition: machine },
    execution: {
      _tag: "Compiled",
      childless: !hasInvokes,
      ...(entry._tag === "Initial" ? { initial: makeInitial } : {}),
      ...(makeCompiledInitial === undefined ? {} : { initialSync: makeCompiledInitial }),
      drain: {
        _tag: "Owned",
        run: hasInvokes
          ? makeInvokingCompiledDrain(machine, entry._tag === "Resume")
          : makeChildlessCompiledDrain(machine, entry._tag === "Resume")
      }
    },
    initial: (scope) =>
      entry._tag === "Resume"
        ? internalRuntimeProtocol.provideMachineRuntime(
          Serialization.normalizeSnapshotEffect(machine, entry.snapshot),
          scope
        )
        : makeInitial(scope).pipe(Effect.map((initialized) => initialized.state)),
    run: (context) =>
      internalRuntimeProtocol.provideMachineRuntime(
        Effect.gen(function*() {
          const { completeMessage, pollMessage, receiveMessage, state, setState } = context
          if (completeMessage === undefined || pollMessage === undefined || receiveMessage === undefined) {
            return yield* Effect.die(new Error("Machine statechart started without acknowledged mailbox access"))
          }
          let terminal: { readonly output: any } | undefined

          let current = yield* state
          if (internalPlanner.isFinalState(machine, current)) {
            return yield* internalPlanner.getFinalOutputEffect(
              machine,
              current,
              internalPlanner.InitialEvent
            )
          }

          if (!hasInvokes) {
            // A queued batch is produced entirely by this worker, so its
            // configuration is already validated. Drop both caches before
            // blocking again so idle machines retain only the public snapshot.
            // Keeping the loop in this generator avoids a suspended generator
            // per iteration; every iteration still crosses Effect boundaries,
            // so the Effect scheduler remains responsible for cooperative yield.
            let configuration: Configuration.ActiveConfiguration | undefined
            let pendingMessage: Option.Option<internalRuntimeProtocol.ProcessMessage<Machine.EventOf<any>>> = Option
              .none()
            let liveRuntime: Runtime<Machine.EventOf<any>, Machine.EmittedEventOf<any>> | undefined
            while (terminal === undefined) {
              const message = Option.isSome(pendingMessage) ? pendingMessage.value : yield* receiveMessage
              pendingMessage = Option.none()
              const acknowledged = internalRuntimeProtocol.isAcknowledgedMessage(message)
              const event = acknowledged ? message.event : message
              const before = current
              let planned
              try {
                planned = internalPlanner.planConfiguration(
                  machine,
                  Configuration.withMachineReferences(
                    configuration ?? Configuration.normalizeConfigurationSync(machine, current),
                    context
                  ),
                  event
                )
              } catch (error) {
                return yield* failPlanning(error)
              }
              configuration = planned.next

              if (planned.microsteps.length > 0) {
                const next = Configuration.snapshotFromConfiguration(machine, planned.next)
                yield* CommandRuntime.runCommands(planned.commands, context)
                yield* setState(next)
                current = next
                if (planned.emittedEvents.length > 0) {
                  yield* CommandRuntime.runEmittedEvents(
                    planned.emittedEvents,
                    liveRuntime ??= CommandRuntime.makeLiveRuntime(machine, context)
                  )
                }

                if (planned.done) {
                  terminal = { output: planned.output }
                }
              }

              if (acknowledged) {
                completeMessage({
                  before,
                  plan: acknowledgedPlan(
                    planned,
                    (state) =>
                      Configuration.snapshotFromConfiguration(machine, state as Configuration.ActiveConfiguration)
                  ),
                  after: current
                })
              }

              if (terminal === undefined) {
                pendingMessage = yield* pollMessage
                if (Option.isNone(pendingMessage)) {
                  configuration = undefined
                }
              }
            }

            if (terminal === undefined) {
              return yield* Effect.die(
                new Error("Machine process stopped receiving events before reaching a terminal configuration")
              )
            }
            return terminal.output
          }

          // The execution descriptor requests this owner-local capability only
          // when an invoking statechart is deliberately run by the generic
          // reference strategy.
          const ownedChildren = context.ownedChildren
          if (ownedChildren === undefined) {
            return yield* Effect.die(new Error("Invoking statechart started without an owned child runtime"))
          }
          const startInvokes: (
            configuration: Configuration.ActiveConfiguration,
            paths: ReadonlyArray<string>,
            event: Machine.LifecycleEvent<any>
          ) => Effect.Effect<void, any, any> = (configuration, paths, event) => (Invocation.startAll(
            machine,
            context,
            ownedChildren,
            configuration,
            paths,
            event
          ) ?? Effect.void)
          const stopInvokes = (paths: ReadonlyArray<string>): Effect.Effect<void> =>
            ownedChildren.stopPaths(paths) ?? Effect.void

          return yield* Effect.gen(function*() {
            let configuration: Configuration.ActiveConfiguration | undefined = yield* Configuration
              .normalizeConfigurationEffect(
                machine,
                current
              )
            yield* startInvokes(
              configuration,
              Configuration.getInitialEntryPaths(machine, configuration),
              internalPlanner.InitialEvent
            )
            // As above, keep the normalized configuration only while this
            // worker can continue draining an already queued batch.
            configuration = undefined
            let pendingMessage: Option.Option<internalRuntimeProtocol.ProcessMessage<Machine.EventOf<any>>> = Option
              .none()
            let liveRuntime: Runtime<Machine.EventOf<any>, Machine.EmittedEventOf<any>> | undefined

            // Match the compact non-invoke loop while retaining state-scoped
            // child lifecycle work at the same ordered Effect boundaries.
            while (terminal === undefined) {
              const message = Option.isSome(pendingMessage) ? pendingMessage.value : yield* receiveMessage
              pendingMessage = Option.none()
              const acknowledged = internalRuntimeProtocol.isAcknowledgedMessage(message)
              const event = acknowledged ? message.event : message
              const before = current
              let planned
              try {
                planned = internalPlanner.planConfiguration(
                  machine,
                  Configuration.withMachineReferences(
                    configuration ?? Configuration.normalizeConfigurationSync(machine, current),
                    context
                  ),
                  event
                )
              } catch (error) {
                return yield* failPlanning(error)
              }
              configuration = planned.next
              if (planned.microsteps.length > 0) {
                const changed = planned.microsteps.some((step) => step.changed)
                const exitPaths = planned.microsteps.flatMap((step) => step.exitPaths)
                const entryEvents = new Map<string, Machine.LifecycleEvent<any>>()
                for (const step of planned.microsteps) {
                  if (step.changed) {
                    for (const path of step.entryPaths) {
                      entryEvents.set(path, step.event)
                    }
                  }
                }

                const next = Configuration.snapshotFromConfiguration(machine, planned.next)
                yield* CommandRuntime.runCommands(planned.commands, context)
                if (changed) {
                  yield* stopInvokes(exitPaths)
                }
                yield* setState(next)
                current = next
                if (planned.emittedEvents.length > 0) {
                  yield* CommandRuntime.runEmittedEvents(
                    planned.emittedEvents,
                    liveRuntime ??= CommandRuntime.makeLiveRuntime(machine, context)
                  )
                }

                if (planned.done) {
                  terminal = { output: planned.output }
                  yield* ownedChildren.stopAll()
                } else if (changed) {
                  for (const [path, entryEvent] of entryEvents) {
                    yield* startInvokes(planned.next, [path], entryEvent)
                  }
                }
              }

              if (acknowledged) {
                completeMessage({
                  before,
                  plan: acknowledgedPlan(
                    planned,
                    (state) =>
                      Configuration.snapshotFromConfiguration(machine, state as Configuration.ActiveConfiguration)
                  ),
                  after: current
                })
              }

              if (terminal === undefined) {
                pendingMessage = yield* pollMessage
                if (Option.isNone(pendingMessage)) {
                  configuration = undefined
                }
              }
            }

            if (terminal === undefined) {
              return yield* Effect.die(
                new Error("Machine process stopped receiving events before reaching a terminal configuration")
              )
            }
            return terminal.output
          }).pipe(
            Effect.onExit(() => ownedChildren.stopAll())
          )
        }),
        context
      )
  })
}

const initialProcessLogicCache = new WeakMap<
  Machine.Any,
  internalRuntimeProtocol.ProcessLogic<any, any, any, any, any, any>
>()

export const toProcessLogic = (
  machine: Machine.Any,
  ...args: ReadonlyArray<unknown>
): internalRuntimeProtocol.ProcessLogic<any, any, any, any, any, any> => {
  if (args.length > 0) {
    return makeProcessLogic(machine, { _tag: "Initial", args })
  }
  // The execution descriptor stores process-local invoke sessions by each
  // runtime address and evaluates initialization/services on every start. A
  // zero-argument descriptor is therefore safe to share for the lifetime of
  // its immutable machine definition. Input-bearing and resumed starts retain
  // their instance-specific entry values below.
  const cached = initialProcessLogicCache.get(machine)
  if (cached !== undefined) {
    return cached as any
  }
  const logic = makeProcessLogic(machine, { _tag: "Initial", args })
  initialProcessLogicCache.set(machine, logic as any)
  return logic
}

const toResumedProcessLogic = (
  machine: Machine.Any,
  snapshot: Machine.Snapshot<any>
): internalRuntimeProtocol.ProcessLogic<any, any, any, any, any, any> =>
  makeProcessLogic(machine, { _tag: "Resume", snapshot })

/** @internal Test-only runtime strategy selection for a fresh machine. */
export const startWithRuntimeStrategyForTesting = (
  machine: Machine.Any,
  strategy: internalRuntime.ProcessRuntimeStrategy,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<internalRuntimeProtocol.MachineRef<any, any, any, any>, any, any> =>
  internalRuntime.startProcessWithStrategyForTesting(
    toProcessLogic(machine, ...args),
    strategy,
    machine.id === undefined ? undefined : { id: machine.id }
  )

/** @internal Test-only prepared startup strategy selection for a fresh machine. */
export const prepareWithRuntimeStrategyForTesting = (
  machine: Machine.Any,
  strategy: internalRuntime.ProcessRuntimeStrategy,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<internalRuntimeProtocol.PreparedProcess<any, any, any, any, any, any, any>, any, any> =>
  internalRuntime.prepareProcessWithStrategyForTesting(
    toProcessLogic(machine, ...args),
    strategy,
    machine.id === undefined ? undefined : { id: machine.id }
  )

/** @internal Test-only runtime strategy selection for a resumed machine. */
export const resumeWithRuntimeStrategyForTesting = (
  machine: Machine.Any,
  snapshot: Machine.Snapshot<any>,
  strategy: internalRuntime.ProcessRuntimeStrategy
): Effect.Effect<internalRuntimeProtocol.MachineRef<any, any, any, any>, any, any> =>
  internalRuntime.startProcessWithStrategyForTesting(
    toResumedProcessLogic(machine, snapshot),
    strategy,
    machine.id === undefined ? undefined : { id: machine.id }
  )

// The public `Machine` module owns the typed start, prepare, and resume
// signatures. These implementations are the erased boundary they specialize.
export const start = (
  machine: Machine.Any,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<internalRuntimeProtocol.MachineRef<any, any, any, any, any>, any, any> =>
  internalRuntime.startProcess(
    toProcessLogic(machine, ...args),
    machine.id === undefined ? undefined : { id: machine.id }
  )

export const prepare = (
  machine: Machine.Any,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<internalRuntimeProtocol.PreparedProcess<any, any, any, any, any, any, any>> =>
  internalRuntime.prepareProcess(
    toProcessLogic(machine, ...args),
    machine.id === undefined ? undefined : { id: machine.id }
  )

export const resume = (
  machine: Machine.Any,
  snapshot: Machine.Snapshot<any>
): Effect.Effect<internalRuntimeProtocol.MachineRef<any, any, any, any, any>, any, any> =>
  internalRuntime.startProcess(
    toResumedProcessLogic(machine, snapshot),
    machine.id === undefined ? undefined : { id: machine.id }
  )
