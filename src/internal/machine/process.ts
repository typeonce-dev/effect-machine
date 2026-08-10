/**
 * Internal machine process integration.
 *
 * @since 4.0.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type { ActionError, ExecutionServices, Machine, Runtime } from "../../Machine.js"
import * as CommandRuntime from "./commandRuntime.js"
import * as Configuration from "./configuration.js"
import { InfiniteTransitionError, MachineSchemaDecodeError, StartupError } from "./errors.js"
import type { StoppedError } from "./errors.js"
import * as ExecutionPlan from "./executionPlan.js"
import * as Invocation from "./invocation.js"
import * as internalPlanner from "./planner.js"
import * as internalRuntime from "./runtime.js"
import * as Serialization from "./serialization.js"

type IsAny<A> = 0 extends (1 & A) ? true : false

type ExcludeCompatibleRuntime<Requirements, Events, Emits> = Requirements extends Runtime.Requirement<
  infer RequiredEvents,
  infer RequiredEmits
> ? IsAny<Requirements> extends true ? Requirements
  : [RequiredEvents] extends [Events] ? [RequiredEmits] extends [Emits] ? never : Requirements
  : Requirements
  : Requirements

type ProcessEntry<States extends Machine.StateSchemas, Input extends Schema.Top> =
  | {
    readonly _tag: "Initial"
    readonly args: [...Machine.InputArgs<Input>]
  }
  | {
    readonly _tag: "Resume"
    readonly snapshot: Machine.Snapshot<States>
  }

const runSequentialDiscard = <E, R>(
  effects: ReadonlyArray<Effect.Effect<void, E, R>>
): Effect.Effect<void, E, R> =>
  effects.length === 0
    ? Effect.void
    : effects.length === 1
    ? effects[0]!
    : Effect.all(effects, { discard: true })

const invokeCapabilityCache = new WeakMap<Machine.Any, boolean>()

const hasInvokeCapability = (machine: Machine.Any): boolean => {
  const cached = invokeCapabilityCache.get(machine)
  if (cached !== undefined) {
    return cached
  }
  const hasInvokes = Object.values(
    machine.handlers as Record<string, Machine.AnyStateConfig>
  ).some((config) => config.invoke !== undefined)
  invokeCapabilityCache.set(machine, hasInvokes)
  return hasInvokes
}

const makeChildlessCompiledDrain = (
  machine: Machine.Any,
  checkInitialFinal: boolean
): (
  context: internalRuntime.CompiledProcessContext<any, any>
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
      const acknowledged = internalRuntime.isAcknowledgedMessage(message)
      const event = acknowledged ? message.event : message
      const before = current

      let planned
      try {
        planned = executionPlan.plan(
          configuration ?? executionPlan.fromConfiguration(Configuration.normalizeConfigurationSync(machine, current)),
          event
        )
      } catch (error) {
        return error instanceof InfiniteTransitionError || error instanceof MachineSchemaDecodeError
          ? Effect.fail(error)
          : Effect.die(error)
      }
      configuration = planned.next
      context.executionState = configuration
      if (planned.microsteps.length === 0) {
        if (acknowledged) context.completeMessage({ before, plan: planned, after: current })
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
          if (acknowledged) context.completeMessage({ before, plan: planned, after: next })
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
    return internalRuntime.provideMachineRuntime(loop, context.scope)
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
  context: internalRuntime.CompiledProcessContext<any, any>
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
      const acknowledged = internalRuntime.isAcknowledgedMessage(message)
      const event = acknowledged ? message.event : message
      const before = current

      let planned
      try {
        planned = executionPlan.plan(
          configuration ??
            executionPlan.fromConfiguration(Configuration.normalizeConfigurationSync(machine, current)),
          event
        )
      } catch (error) {
        return error instanceof InfiniteTransitionError || error instanceof MachineSchemaDecodeError
          ? Effect.fail(error)
          : Effect.die(error)
      }
      configuration = planned.next
      if (planned.microsteps.length === 0) {
        if (acknowledged) context.completeMessage({ before, plan: planned, after: current })
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
          if (acknowledged) context.completeMessage({ before, plan: planned, after: next })
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
    return internalRuntime.provideMachineRuntime(Effect.suspend(initialize), scope)
  }
}

const makeProcessLogic: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  entry: ProcessEntry<States, Input>
) => internalRuntime.ProcessLogic<
  Machine.Snapshot<States>,
  Machine.EventOf<Events>,
  E | ActionError<R> | InfiniteTransitionError | MachineSchemaDecodeError | StoppedError,
  ExcludeCompatibleRuntime<
    Exclude<ExecutionServices<InitialR | R>, internalRuntime.MachineRuntime>,
    Machine.EventOf<Events>,
    Machine.EmitOf<Emits>
  >,
  Output,
  | InitialE
  | E
  | ActionError<InitialR | R>
  | InfiniteTransitionError
  | MachineSchemaDecodeError
  | StartupError
  | StoppedError
> = <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  entry: ProcessEntry<States, Input>
) => {
  const hasInvokes = hasInvokeCapability(machine)
  const executionPlan = ExecutionPlan.compileExecutionPlan(machine)
  const initialArgs = entry._tag === "Initial" ? entry.args : []
  const compiledInitial = entry._tag === "Initial" ? executionPlan.initial : undefined
  const makeCompiledInitial = compiledInitial === undefined ? undefined : () => {
    try {
      const planned = compiledInitial(initialArgs)
      const result = {
        state: planned.state as Machine.Snapshot<States>,
        done: planned.done,
        output: planned.output as Output | undefined
      }
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
      throw error instanceof InfiniteTransitionError || error instanceof MachineSchemaDecodeError
        ? error
        : new StartupError({ cause: Cause.die(error) })
    }
  }
  const makeInitial = (
    scope: internalRuntime.ProcessScope<Machine.EventOf<Events>>
  ) =>
    compiledInitial === undefined
      ? internalRuntime.provideMachineRuntime(
        internalPlanner.planInitial(machine, ...initialArgs).pipe(
          Effect.flatMap((planned) => {
            const commands = planned.commands.length === 0
              ? undefined
              : CommandRuntime.runCommands(planned.commands, scope)
            const emitted = planned.emittedEvents.length === 0
              ? undefined
              : CommandRuntime.runEmittedEvents(
                planned.emittedEvents,
                CommandRuntime.makeLiveRuntime<Machine.EventOf<Events>, Machine.EmitOf<Emits>>(machine, scope)
              )
            const result = Effect.succeed({
              state: planned.state,
              done: planned.done,
              output: planned.output
            })
            return commands === undefined
              ? emitted === undefined ? result : emitted.pipe(Effect.andThen(result))
              : emitted === undefined
              ? commands.pipe(Effect.andThen(result))
              : commands.pipe(Effect.andThen(emitted), Effect.andThen(result))
          })
        ),
        scope
      )
      : Effect.try({ try: makeCompiledInitial!, catch: (error) => error as any })
  return ({
    execution: {
      _tag: "Compiled",
      childless: !hasInvokes,
      initial: entry._tag === "Initial" ? makeInitial : undefined,
      initialSync: makeCompiledInitial,
      drain: {
        _tag: "Owned",
        run: hasInvokes
          ? makeInvokingCompiledDrain(machine, entry._tag === "Resume")
          : makeChildlessCompiledDrain(machine, entry._tag === "Resume")
      }
    },
    initial: (scope) =>
      entry._tag === "Resume"
        ? internalRuntime.provideMachineRuntime(Serialization.normalizeSnapshotEffect(machine, entry.snapshot), scope)
        : makeInitial(scope).pipe(Effect.map((initialized) => initialized.state)),
    run: (context) =>
      internalRuntime.provideMachineRuntime(
        Effect.gen(function*() {
          const { completeMessage, pollMessage, receiveMessage, state, setState } = context
          if (completeMessage === undefined || pollMessage === undefined || receiveMessage === undefined) {
            return yield* Effect.die(new Error("Machine statechart started without acknowledged mailbox access"))
          }
          let terminal: { readonly output: Output } | undefined

          let current = yield* state
          if (internalPlanner.isFinalState(machine, current)) {
            return yield* internalPlanner.getFinalOutputEffect<States, Events, Output>(
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
            let pendingMessage: Option.Option<internalRuntime.ProcessMessage<Machine.EventOf<Events>>> = Option.none()
            let liveRuntime: Runtime<Machine.EventOf<Events>, Machine.EmitOf<Emits>> | undefined
            while (terminal === undefined) {
              const message = Option.isSome(pendingMessage) ? pendingMessage.value : yield* receiveMessage
              pendingMessage = Option.none()
              const acknowledged = internalRuntime.isAcknowledgedMessage(message)
              const event = acknowledged ? message.event : message
              const before = current
              let planned
              try {
                planned = internalPlanner.planConfiguration(
                  machine,
                  configuration ?? Configuration.normalizeConfigurationSync(machine, current),
                  event
                )
              } catch (error) {
                if (error instanceof InfiniteTransitionError || error instanceof MachineSchemaDecodeError) {
                  return yield* error
                }
                throw error
              }
              configuration = planned.next

              if (planned.microsteps.length > 0) {
                const next = Configuration.snapshotFromConfiguration<States>(machine, planned.next)
                yield* CommandRuntime.runCommands(planned.commands, context)
                yield* setState(next)
                current = next
                if (planned.emittedEvents.length > 0) {
                  yield* CommandRuntime.runEmittedEvents(
                    planned.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>,
                    liveRuntime ??= CommandRuntime.makeLiveRuntime(machine, context)
                  )
                }

                if (planned.done) {
                  terminal = { output: planned.output }
                }
              }

              if (acknowledged) completeMessage({ before, plan: planned, after: current })

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
            event: Machine.LifecycleEvent<Events>
          ) => Effect.Effect<void, E | MachineSchemaDecodeError, R> = (configuration, paths, event) =>
            (Invocation.startAll(
              machine,
              context,
              ownedChildren,
              configuration,
              paths,
              event
            ) ?? Effect.void) as Effect.Effect<void, E | MachineSchemaDecodeError, R>
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
            let pendingMessage: Option.Option<internalRuntime.ProcessMessage<Machine.EventOf<Events>>> = Option.none()
            let liveRuntime: Runtime<Machine.EventOf<Events>, Machine.EmitOf<Emits>> | undefined

            // Match the compact non-invoke loop while retaining state-scoped
            // child lifecycle work at the same ordered Effect boundaries.
            while (terminal === undefined) {
              const message = Option.isSome(pendingMessage) ? pendingMessage.value : yield* receiveMessage
              pendingMessage = Option.none()
              const acknowledged = internalRuntime.isAcknowledgedMessage(message)
              const event = acknowledged ? message.event : message
              const before = current
              let planned
              try {
                planned = internalPlanner.planConfiguration(
                  machine,
                  configuration ?? Configuration.normalizeConfigurationSync(machine, current),
                  event
                )
              } catch (error) {
                if (error instanceof InfiniteTransitionError || error instanceof MachineSchemaDecodeError) {
                  return yield* error
                }
                throw error
              }
              configuration = planned.next
              if (planned.microsteps.length > 0) {
                const changed = planned.microsteps.some((step) => step.changed)
                const exitPaths = planned.microsteps.flatMap((step) => step.exitPaths)
                const entryEvents = new Map<string, Machine.LifecycleEvent<Events>>()
                for (const step of planned.microsteps) {
                  if (step.changed) {
                    for (const path of step.entryPaths) {
                      entryEvents.set(path, step.event as Machine.LifecycleEvent<Events>)
                    }
                  }
                }

                const next = Configuration.snapshotFromConfiguration<States>(machine, planned.next)
                yield* CommandRuntime.runCommands(planned.commands, context)
                if (changed) {
                  yield* stopInvokes(exitPaths)
                }
                yield* setState(next)
                current = next
                if (planned.emittedEvents.length > 0) {
                  yield* CommandRuntime.runEmittedEvents(
                    planned.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>,
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

              if (acknowledged) completeMessage({ before, plan: planned, after: current })

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
  }) as internalRuntime.ProcessLogic<
    Machine.Snapshot<States>,
    Machine.EventOf<Events>,
    E | ActionError<R> | InfiniteTransitionError | MachineSchemaDecodeError | StoppedError,
    ExcludeCompatibleRuntime<
      Exclude<ExecutionServices<InitialR | R>, internalRuntime.MachineRuntime>,
      Machine.EventOf<Events>,
      Machine.EmitOf<Emits>
    >,
    Output,
    | InitialE
    | E
    | ActionError<InitialR | R>
    | InfiniteTransitionError
    | MachineSchemaDecodeError
    | StartupError
    | StoppedError
  >
}

const initialProcessLogicCache = new WeakMap<
  Machine.Any,
  internalRuntime.ProcessLogic<any, any, any, any, any, any>
>()

export const toProcessLogic: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  ...args: [...Machine.InputArgs<Input>]
) => internalRuntime.ProcessLogic<
  Machine.Snapshot<States>,
  Machine.EventOf<Events>,
  E | ActionError<R> | InfiniteTransitionError | MachineSchemaDecodeError | StoppedError,
  ExcludeCompatibleRuntime<
    Exclude<ExecutionServices<InitialR | R>, internalRuntime.MachineRuntime>,
    Machine.EventOf<Events>,
    Machine.EmitOf<Emits>
  >,
  Output,
  | InitialE
  | E
  | ActionError<InitialR | R>
  | InfiniteTransitionError
  | MachineSchemaDecodeError
  | StartupError
  | StoppedError
> = (machine, ...args) => {
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
): internalRuntime.ProcessLogic<any, any, any, any, any, any> =>
  (makeProcessLogic as any)(machine, { _tag: "Resume", snapshot })

/** @internal Test-only runtime strategy selection for a fresh machine. */
export const startWithRuntimeStrategyForTesting = (
  machine: Machine.Any,
  strategy: internalRuntime.ProcessRuntimeStrategy,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<internalRuntime.MachineRef<any, any, any, any>, any, any> =>
  internalRuntime.startProcessWithStrategyForTesting(
    (toProcessLogic as any)(machine, ...args),
    strategy,
    machine.id === undefined ? undefined : { id: machine.id }
  )

/** @internal Test-only runtime strategy selection for a resumed machine. */
export const resumeWithRuntimeStrategyForTesting = (
  machine: Machine.Any,
  snapshot: Machine.Snapshot<any>,
  strategy: internalRuntime.ProcessRuntimeStrategy
): Effect.Effect<internalRuntime.MachineRef<any, any, any, any>, any, any> =>
  internalRuntime.startProcessWithStrategyForTesting(
    toResumedProcessLogic(machine, snapshot),
    strategy,
    machine.id === undefined ? undefined : { id: machine.id }
  )

export const start: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  ...args: [...Machine.InputArgs<Input>]
) => Effect.Effect<
  internalRuntime.MachineRef<
    Machine.Snapshot<States>,
    Machine.EventOf<Events>,
    | E
    | ActionError<R>
    | InfiniteTransitionError
    | MachineSchemaDecodeError
    | StoppedError,
    Output
  >,
  | InitialE
  | E
  | ActionError<InitialR | R>
  | InfiniteTransitionError
  | MachineSchemaDecodeError
  | StartupError
  | StoppedError,
  ExcludeCompatibleRuntime<
    Exclude<ExecutionServices<InitialR | R>, internalRuntime.MachineRuntime>,
    Machine.EventOf<Events>,
    Machine.EmitOf<Emits>
  >
> = (machine, ...args) =>
  internalRuntime.startProcess(
    toProcessLogic(machine, ...args),
    machine.id === undefined ? undefined : { id: machine.id }
  ) as any

export const resume: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  InitialE = never,
  InitialR = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never
>(
  machine: Machine<States, Events, Input, UnhandledStates, E, R, InitialE, InitialR, FinalStates, Output, Emits>,
  snapshot: Machine.Snapshot<States>
) => Effect.Effect<
  internalRuntime.MachineRef<
    Machine.Snapshot<States>,
    Machine.EventOf<Events>,
    E | ActionError<R> | InfiniteTransitionError | MachineSchemaDecodeError | StoppedError,
    Output
  >,
  MachineSchemaDecodeError,
  ExcludeCompatibleRuntime<
    Exclude<ExecutionServices<R>, internalRuntime.MachineRuntime>,
    Machine.EventOf<Events>,
    Machine.EmitOf<Emits>
  >
> = (machine, snapshot) =>
  internalRuntime.startProcess(
    toResumedProcessLogic(machine, snapshot),
    machine.id === undefined ? undefined : { id: machine.id }
  ) as any
