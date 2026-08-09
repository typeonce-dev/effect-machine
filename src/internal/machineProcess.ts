/**
 * Internal machine process integration.
 *
 * @since 4.0.0
 */

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import type * as Schema from "effect/Schema"
import type { ActionError, ExecutionServices, Machine, Runtime } from "../Machine.js"
import { ChildAlreadyExistsError, InfiniteTransitionError, MachineSchemaDecodeError } from "./machineErrors.js"
import type { StartupError, StoppedError } from "./machineErrors.js"
import * as Model from "./machineModel.js"
import * as internalPlanner from "./machinePlanner.js"
import * as internalRuntime from "./machineRuntime.js"

type IsAny<A> = 0 extends (1 & A) ? true : false

type ExcludeCompatibleRuntime<Requirements, Events, Emits> = Requirements extends Runtime.Requirement<
  infer RequiredEvents,
  infer RequiredEmits
> ? IsAny<Requirements> extends true ? Requirements
  : [RequiredEvents] extends [Events] ? [RequiredEmits] extends [Emits] ? never : Requirements
  : Requirements
  : Requirements

type AnyInvokeConfig = Machine.InvokeConfig<any, any, any, any, any, any, any, any, any, any, any, any, any>

interface InvokeSession {
  readonly token: symbol
  readonly childId: string
  readonly path: string
}

type ProcessEntry<States extends Machine.StateSchemas, Input extends Schema.Top> =
  | {
    readonly _tag: "Initial"
    readonly args: [...Machine.InputArgs<Input>]
  }
  | {
    readonly _tag: "Resume"
    readonly snapshot: Machine.Snapshot<States>
  }

const getInvokes = (
  config: Machine.AnyStateConfig | undefined,
  context: Machine.InvokeContext<any, any, any, any>
): ReadonlyArray<AnyInvokeConfig> => {
  const definition = config?.invoke
  const invokes = typeof definition === "function" ? definition(context) : definition
  if (invokes === undefined) {
    return []
  }
  return Array.isArray(invokes) ? invokes as ReadonlyArray<AnyInvokeConfig> : [invokes as AnyInvokeConfig]
}

const runSequentialDiscard = <E, R>(
  effects: ReadonlyArray<Effect.Effect<void, E, R>>
): Effect.Effect<void, E, R> =>
  effects.length === 0
    ? Effect.void
    : effects.length === 1
    ? effects[0]!
    : Effect.all(effects, { discard: true })

const runParallelDiscard = <E, R>(
  effects: ReadonlyArray<Effect.Effect<void, E, R>>
): Effect.Effect<void, E, R> =>
  effects.length === 0
    ? Effect.void
    : effects.length === 1
    ? effects[0]!
    : Effect.all(effects, { discard: true, concurrency: "unbounded" })

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

const isCurrentInvoke = (
  sessions: Map<string, InvokeSession>,
  key: string,
  token: symbol
): Effect.Effect<boolean> => Effect.sync(() => sessions.get(key)?.token === token)

const makeInvokeSendParent = (
  sessions: Map<string, InvokeSession>,
  self: internalRuntime.ProcessScope<any>["self"],
  key: string,
  token: symbol
): (event: unknown) => Effect.Effect<void, StoppedError> => {
  return (event) =>
    isCurrentInvoke(sessions, key, token).pipe(
      Effect.flatMap((isCurrent) => isCurrent ? self.send(event) : Effect.void)
    )
}

const makeInvokeOutcomeHandler = (
  sessions: Map<string, InvokeSession>,
  self: internalRuntime.ProcessScope<any>["self"],
  failCause: internalRuntime.ProcessScope<any>["failCause"],
  config: AnyInvokeConfig,
  key: string,
  token: symbol
): (outcome: internalRuntime.RuntimeOutcome<any, any, any>) => Effect.Effect<void> => {
  return (outcome) => {
    if (outcome._tag === "Stopped") {
      return Effect.void
    }
    return isCurrentInvoke(sessions, key, token).pipe(
      Effect.flatMap((isCurrent) => {
        if (!isCurrent) {
          return Effect.void
        }
        if (outcome._tag === "Done") {
          const mappedEvent = config.onDone === undefined
            ? outcome.output
            : config.onDone({ id: config.id, output: outcome.output })
          return mappedEvent === undefined
            ? Effect.void
            : self.send(mappedEvent).pipe(Effect.catchTag("StoppedError", () => Effect.void))
        }
        return failCause(outcome.cause)
      })
    )
  }
}

const makeInvokeSnapshotHandler = (
  sessions: Map<string, InvokeSession>,
  self: internalRuntime.ProcessScope<any>["self"],
  config: AnyInvokeConfig,
  key: string,
  token: symbol
): (
  snapshot: Extract<internalRuntime.RuntimeSnapshot<any, any, any>, { readonly status: "active" }>
) => Effect.Effect<void> => {
  return (snapshot) =>
    isCurrentInvoke(sessions, key, token).pipe(
      Effect.flatMap((isCurrent) => {
        if (!isCurrent || config.snapshot === undefined) {
          return Effect.void
        }
        const mappedEvent = config.snapshot({ id: config.id, snapshot })
        return mappedEvent === undefined
          ? Effect.void
          : self.send(mappedEvent).pipe(Effect.catchTag("StoppedError", () => Effect.void))
      })
    )
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
  // A process logic value may be reused for multiple starts. Key retained
  // invoke state by the stable process address so each running instance owns
  // its own table even when an invoke wrapper decorates the context object.
  const invokeSessionsByContext = new WeakMap<object, {
    readonly sessions: Map<string, InvokeSession>
    initialized: boolean
  }>()
  return ({
    [internalRuntime.childlessProcess]: hasInvokes ? undefined : true,
    [internalRuntime.compiledProcess]: true,
    initial: (scope) =>
      internalRuntime.provideMachineRuntime(
        Effect.gen(function*() {
          if (entry._tag === "Resume") {
            return yield* Model.normalizeSnapshotEffect(machine, entry.snapshot)
          }
          const planned = yield* internalPlanner.planInitial(machine, ...entry.args)
          yield* internalPlanner.runCommands(
            planned.commands,
            scope
          )
          if (planned.emittedEvents.length > 0) {
            yield* internalPlanner.runEmittedEvents(
              planned.emittedEvents,
              internalPlanner.makeLiveRuntime<Machine.EventOf<Events>, Machine.EmitOf<Emits>>(machine, scope)
            )
          }
          return planned.state
        }),
        scope
      ),
    drain: (context: internalRuntime.ProcessContext<Machine.Snapshot<States>, Machine.EventOf<Events>>) =>
      internalRuntime.provideMachineRuntime(
        Effect.gen(function*() {
          const poll = context.poll ?? Queue.poll(context.mailbox!)
          const { state, setState } = context
          let current = yield* state
          if (internalPlanner.isFinalState(machine, current)) {
            return Option.some(
              yield* internalPlanner.getFinalOutputEffect<States, Events, Output>(
                machine,
                current,
                internalPlanner.InitialEvent
              )
            )
          }

          let configuration: Model.ActiveConfiguration | undefined
          let liveRuntime: Runtime<Machine.EventOf<Events>, Machine.EmitOf<Emits>> | undefined

          let stopAllInvokes: Effect.Effect<void> | undefined
          let startInvokes:
            | ((
              configuration: Model.ActiveConfiguration,
              paths: ReadonlyArray<string>,
              event: Machine.LifecycleEvent<Events>
            ) => Effect.Effect<void, E | MachineSchemaDecodeError, R>)
            | undefined
          let stopInvokes: ((paths: ReadonlyArray<string>) => Effect.Effect<void>) | undefined

          if (hasInvokes) {
            let session = invokeSessionsByContext.get(context.self)
            if (session === undefined) {
              session = { sessions: new Map(), initialized: false }
              invokeSessionsByContext.set(context.self, session)
            }
            const invokeSessions = session.sessions
            const makeInvokeSessionKey = (path: string, id: string): string => `${path.length}:${path}${id}`
            const makeInvokeChildId = (path: string, id: string): string =>
              `Machine.invoke:${makeInvokeSessionKey(path, id)}`
            const stopInvokeSession = (session: InvokeSession): Effect.Effect<void> =>
              context.stopChild(session.childId)
            const removeInvoke = (
              key: string,
              token: symbol | undefined
            ): Effect.Effect<void> =>
              Effect.sync(() => {
                const current = invokeSessions.get(key)
                if (current === undefined || (token !== undefined && current.token !== token)) {
                  return undefined
                }
                invokeSessions.delete(key)
                return current
              }).pipe(
                Effect.flatMap((session) =>
                  session === undefined
                    ? Effect.void
                    : stopInvokeSession(session)
                )
              )
            const stopInvoke = (key: string): Effect.Effect<void> => removeInvoke(key, undefined)
            stopAllInvokes = Effect.suspend(() => {
              const effects = Array.from(invokeSessions.values(), stopInvokeSession)
              invokeSessions.clear()
              return runParallelDiscard(effects)
            })
            const startInvoke = Effect.fnUntraced(function*<StateId extends Machine.StateIdentifier<States>>(
              path: StateId,
              config: AnyInvokeConfig
            ) {
              const token = Symbol()
              const invokeId = String(config.id)
              const key = makeInvokeSessionKey(path, invokeId)
              const childId = config.address === undefined ? makeInvokeChildId(path, invokeId) : String(config.address)
              const reserved = yield* Effect.sync(() => {
                if (invokeSessions.has(key)) {
                  return false
                }
                invokeSessions.set(key, { token, childId, path })
                return true
              })
              if (!reserved) {
                return yield* Effect.fail(new ChildAlreadyExistsError({ id: invokeId }))
              }
              const logic = config.src()
              const processLogic = logic as internalRuntime.ProcessLogic<any, any, any, any, any, any>
              const sendParent = makeInvokeSendParent(invokeSessions, context.self, key, token)
              yield* context.spawn(
                processLogic,
                {
                  id: childId,
                  ...(config.descriptor === undefined ? undefined : { descriptor: config.descriptor }),
                  [internalRuntime.sendParentOverride]: sendParent,
                  onOutcome: makeInvokeOutcomeHandler(
                    invokeSessions,
                    context.self,
                    context.failCause,
                    config,
                    key,
                    token
                  ),
                  ...(config.snapshot === undefined ? undefined : {
                    [internalRuntime.activeSnapshotObserver]: makeInvokeSnapshotHandler(
                      invokeSessions,
                      context.self,
                      config,
                      key,
                      token
                    )
                  })
                }
              ).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? removeInvoke(key, token)
                    : Effect.void
                )
              )
            })
            startInvokes = (
              configuration: Model.ActiveConfiguration,
              paths: ReadonlyArray<string>,
              event: Machine.LifecycleEvent<Events>
            ) =>
              runSequentialDiscard(
                internalPlanner.sortEntryPaths(machine, paths)
                  .filter((path) => configuration.active.has(path))
                  .flatMap((path) =>
                    getInvokes(Model.getStateConfigByPath(machine, path), {
                      state: Model.getActiveValue(configuration, path),
                      parent: Model.getParentValue(machine, configuration, path),
                      parents: Model.getParentValues(machine, configuration, path),
                      event
                    }).map((config) =>
                      startInvoke(
                        path as Machine.StateIdentifier<States>,
                        config
                      ) as Effect.Effect<void, E | MachineSchemaDecodeError, R>
                    )
                  )
              )
            stopInvokes = (paths) =>
              Effect.suspend(() =>
                runParallelDiscard(
                  internalPlanner.sortExitPaths(machine, paths).flatMap((path) =>
                    Array.from(invokeSessions.entries())
                      .filter(([, session]) => session.path === path)
                      .map(([key]) => stopInvoke(key))
                  )
                )
              )

            configuration = Model.normalizeConfigurationSync(machine, current)
            if (!session.initialized) {
              yield* startInvokes(
                configuration,
                Model.getInitialEntryPaths(machine, configuration),
                internalPlanner.InitialEvent
              )
              session.initialized = true
            }
          }

          while (true) {
            const pending = yield* poll
            if (Option.isNone(pending)) {
              return Option.none<Output>()
            }
            const event = pending.value
            let planned
            try {
              planned = internalPlanner.planConfiguration(
                machine,
                configuration ?? Model.normalizeConfigurationSync(machine, current),
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
              let changed = false
              let exitPaths: ReadonlyArray<string> = []
              let entryEvents: Map<string, Machine.LifecycleEvent<Events>> | undefined
              if (hasInvokes) {
                changed = planned.microsteps.some((step) => step.changed)
                exitPaths = planned.microsteps.flatMap((step) => step.exitPaths)
                entryEvents = new Map()
                for (const step of planned.microsteps) {
                  if (step.changed) {
                    for (const path of step.entryPaths) {
                      entryEvents.set(path, step.event as Machine.LifecycleEvent<Events>)
                    }
                  }
                }
              }
              const next = Model.snapshotFromConfiguration<States>(machine, planned.next)
              yield* internalPlanner.runCommands(planned.commands, context)
              if (changed) {
                yield* stopInvokes!(exitPaths)
              }
              yield* setState(next)
              current = next
              if (planned.emittedEvents.length > 0) {
                yield* internalPlanner.runEmittedEvents(
                  planned.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>,
                  liveRuntime ??= internalPlanner.makeLiveRuntime(machine, context)
                )
              }
              if (planned.done) {
                if (stopAllInvokes !== undefined) {
                  yield* stopAllInvokes
                }
                return Option.some(planned.output as Output)
              } else if (changed) {
                for (const [path, entryEvent] of entryEvents!) {
                  yield* startInvokes!(planned.next, [path], entryEvent)
                }
              }
            }
          }
        }),
        context
      ),
    run: (context) =>
      internalRuntime.provideMachineRuntime(
        Effect.gen(function*() {
          const poll = context.poll ?? Queue.poll(context.mailbox!)
          const { receive, state, setState } = context
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
            let configuration: Model.ActiveConfiguration | undefined
            let pendingEvent: Option.Option<Machine.EventOf<Events>> = Option.none()
            let pollEvent: Effect.Effect<Option.Option<Machine.EventOf<Events>>> | undefined
            let liveRuntime: Runtime<Machine.EventOf<Events>, Machine.EmitOf<Emits>> | undefined
            while (terminal === undefined) {
              const event = Option.isSome(pendingEvent) ? pendingEvent.value : yield* receive
              pendingEvent = Option.none()
              let planned
              try {
                planned = internalPlanner.planConfiguration(
                  machine,
                  configuration ?? Model.normalizeConfigurationSync(machine, current),
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
                const next = Model.snapshotFromConfiguration<States>(machine, planned.next)
                yield* internalPlanner.runCommands(planned.commands, context)
                yield* setState(next)
                current = next
                if (planned.emittedEvents.length > 0) {
                  yield* internalPlanner.runEmittedEvents(
                    planned.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>,
                    liveRuntime ??= internalPlanner.makeLiveRuntime(machine, context)
                  )
                }

                if (planned.done) {
                  terminal = { output: planned.output as Output }
                }
              }

              if (terminal === undefined) {
                pendingEvent = yield* (pollEvent ??= poll)
                if (Option.isNone(pendingEvent)) {
                  configuration = undefined
                  pollEvent = undefined
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

          // Every session mutation is deferred inside `Effect.sync`, making a
          // compact mutable table atomic with respect to Effect fiber steps.
          // Tokens still distinguish stale child callbacks after reentry.
          const invokeSessions = new Map<string, InvokeSession>()
          const makeInvokeSessionKey = (path: string, id: string): string => `${path.length}:${path}${id}`
          const makeInvokeChildId = (path: string, id: string): string =>
            `Machine.invoke:${makeInvokeSessionKey(path, id)}`
          const stopInvokeSession = (session: InvokeSession): Effect.Effect<void> => context.stopChild(session.childId)
          const removeInvoke = (
            key: string,
            token: symbol | undefined
          ): Effect.Effect<void> =>
            Effect.sync(() => {
              const current = invokeSessions.get(key)
              if (current === undefined || (token !== undefined && current.token !== token)) {
                return undefined
              }
              invokeSessions.delete(key)
              return current
            }).pipe(
              Effect.flatMap((session) =>
                session === undefined
                  ? Effect.void
                  : stopInvokeSession(session)
              )
            )
          const stopInvoke = (key: string): Effect.Effect<void> => removeInvoke(key, undefined)
          const stopAllInvokes: Effect.Effect<void> = Effect.suspend(() => {
            const effects = Array.from(invokeSessions.values(), stopInvokeSession)
            invokeSessions.clear()
            return runParallelDiscard(effects)
          })
          const startInvoke = Effect.fnUntraced(function*<StateId extends Machine.StateIdentifier<States>>(
            path: StateId,
            config: AnyInvokeConfig
          ) {
            const token = Symbol()
            const invokeId = String(config.id)
            const key = makeInvokeSessionKey(path, invokeId)
            const childId = config.address === undefined ? makeInvokeChildId(path, invokeId) : String(config.address)
            const reserved = yield* Effect.sync(() => {
              if (invokeSessions.has(key)) {
                return false
              }
              invokeSessions.set(key, { token, childId, path })
              return true
            })
            if (!reserved) {
              return yield* Effect.fail(new ChildAlreadyExistsError({ id: invokeId }))
            }
            const logic = config.src()
            const processLogic = logic as internalRuntime.ProcessLogic<any, any, any, any, any, any>
            const sendParent = makeInvokeSendParent(invokeSessions, context.self, key, token)
            yield* context.spawn(
              processLogic,
              {
                id: childId,
                ...(config.descriptor === undefined ? undefined : { descriptor: config.descriptor }),
                [internalRuntime.sendParentOverride]: sendParent,
                onOutcome: makeInvokeOutcomeHandler(
                  invokeSessions,
                  context.self,
                  context.failCause,
                  config,
                  key,
                  token
                ),
                ...(config.snapshot === undefined ? undefined : {
                  [internalRuntime.activeSnapshotObserver]: makeInvokeSnapshotHandler(
                    invokeSessions,
                    context.self,
                    config,
                    key,
                    token
                  )
                })
              }
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? removeInvoke(key, token)
                  : Effect.void
              )
            )
          })
          const startInvokes: (
            configuration: Model.ActiveConfiguration,
            paths: ReadonlyArray<string>,
            event: Machine.LifecycleEvent<Events>
          ) => Effect.Effect<void, E | MachineSchemaDecodeError, R> = Effect.fnUntraced(function*(
            configuration: Model.ActiveConfiguration,
            paths: ReadonlyArray<string>,
            event: Machine.LifecycleEvent<Events>
          ) {
            yield* runSequentialDiscard(
              internalPlanner.sortEntryPaths(machine, paths)
                .filter((path) => configuration.active.has(path))
                .flatMap((path) =>
                  getInvokes(Model.getStateConfigByPath(machine, path), {
                    state: Model.getActiveValue(configuration, path),
                    parent: Model.getParentValue(machine, configuration, path),
                    parents: Model.getParentValues(machine, configuration, path),
                    event
                  }).map((config) =>
                    startInvoke(
                      path as Machine.StateIdentifier<States>,
                      config
                    ) as Effect.Effect<void, E | MachineSchemaDecodeError, R>
                  )
                )
            )
          })
          const stopInvokes = (paths: ReadonlyArray<string>): Effect.Effect<void> =>
            Effect.suspend(() =>
              runParallelDiscard(
                internalPlanner.sortExitPaths(machine, paths).flatMap((path) =>
                  Array.from(invokeSessions.entries())
                    .filter(([, session]) => session.path === path)
                    .map(([key]) => stopInvoke(key))
                )
              )
            )

          return yield* Effect.gen(function*() {
            let configuration: Model.ActiveConfiguration | undefined = yield* Model.normalizeConfigurationEffect(
              machine,
              current
            )
            yield* startInvokes(
              configuration,
              Model.getInitialEntryPaths(machine, configuration),
              internalPlanner.InitialEvent
            )
            // As above, keep the normalized configuration only while this
            // worker can continue draining an already queued batch.
            configuration = undefined
            let pendingEvent: Option.Option<Machine.EventOf<Events>> = Option.none()
            let pollEvent: Effect.Effect<Option.Option<Machine.EventOf<Events>>> | undefined
            let liveRuntime: Runtime<Machine.EventOf<Events>, Machine.EmitOf<Emits>> | undefined

            // Match the compact non-invoke loop while retaining state-scoped
            // child lifecycle work at the same ordered Effect boundaries.
            while (terminal === undefined) {
              const event = Option.isSome(pendingEvent) ? pendingEvent.value : yield* receive
              pendingEvent = Option.none()
              let planned
              try {
                planned = internalPlanner.planConfiguration(
                  machine,
                  configuration ?? Model.normalizeConfigurationSync(machine, current),
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

                const next = Model.snapshotFromConfiguration<States>(machine, planned.next)
                yield* internalPlanner.runCommands(planned.commands, context)
                if (changed) {
                  yield* stopInvokes(exitPaths)
                }
                yield* setState(next)
                current = next
                if (planned.emittedEvents.length > 0) {
                  yield* internalPlanner.runEmittedEvents(
                    planned.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>,
                    liveRuntime ??= internalPlanner.makeLiveRuntime(machine, context)
                  )
                }

                if (planned.done) {
                  terminal = { output: planned.output as Output }
                  yield* stopAllInvokes
                } else if (changed) {
                  for (const [path, entryEvent] of entryEvents) {
                    yield* startInvokes(planned.next, [path], entryEvent)
                  }
                }
              }

              if (terminal === undefined) {
                pendingEvent = yield* (pollEvent ??= poll)
                if (Option.isNone(pendingEvent)) {
                  configuration = undefined
                  pollEvent = undefined
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
            Effect.onExit(() => stopAllInvokes)
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
