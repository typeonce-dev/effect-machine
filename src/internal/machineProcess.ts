/**
 * Internal machine process integration.
 *
 * @since 4.0.0
 */

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
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
  readonly watcher: Fiber.Fiber<void> | undefined
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
  return ({
    initial: (scope) =>
      internalRuntime.provideMachineRuntime(
        Effect.gen(function*() {
          if (entry._tag === "Resume") {
            return yield* Model.normalizeSnapshotEffect(machine, entry.snapshot)
          }
          const planned = yield* internalPlanner.planInitial(machine, ...entry.args)
          const runtime = internalPlanner.makeLiveRuntime<Machine.EventOf<Events>, Machine.EmitOf<Emits>>(
            machine,
            scope
          )
          yield* internalPlanner.runCommands(
            planned.commands,
            scope
          )
          yield* internalPlanner.runEmittedEvents(planned.emittedEvents, runtime)
          return planned.state
        }),
        scope
      ),
    run: (context) =>
      internalRuntime.provideMachineRuntime(
        Effect.gen(function*() {
          const { mailbox, receive, state, setState } = context
          let terminal: { readonly output: Output } | undefined

          let current = yield* state
          if (internalPlanner.isFinalState(machine, current)) {
            return yield* internalPlanner.getFinalOutputEffect<States, Events, Output>(
              machine,
              current,
              internalPlanner.InitialEvent
            )
          }

          const liveRuntime = internalPlanner.makeLiveRuntime<Machine.EventOf<Events>, Machine.EmitOf<Emits>>(
            machine,
            context
          )

          if (!hasInvokes) {
            // A queued batch is produced entirely by this worker, so its
            // configuration is already validated. Drop both caches before
            // blocking again so idle machines retain only the public snapshot.
            let configuration: Model.ActiveConfiguration | undefined
            let pendingEvent: Option.Option<Machine.EventOf<Events>> = Option.none()
            let pollEvent: Effect.Effect<Option.Option<Machine.EventOf<Events>>> | undefined
            yield* Effect.whileLoop({
              while: () => terminal === undefined,
              body: () =>
                Effect.gen(function*() {
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
                    yield* internalPlanner.runEmittedEvents(
                      planned.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>,
                      liveRuntime
                    )

                    if (planned.done) {
                      terminal = { output: planned.output as Output }
                    }
                  }

                  if (terminal === undefined) {
                    pendingEvent = yield* (pollEvent ??= Queue.poll(mailbox))
                    if (Option.isNone(pendingEvent)) {
                      configuration = undefined
                      pollEvent = undefined
                    }
                  }
                }),
              step: () => undefined
            })

            if (terminal === undefined) {
              return yield* Effect.die(
                new Error("Machine process stopped receiving events before reaching a terminal configuration")
              )
            }
            return terminal.output
          }

          const invokeSessions = yield* Ref.make<HashMap.HashMap<string, InvokeSession>>(
            HashMap.empty()
          )
          const makeInvokeSessionKey = (path: string, id: string): string => `${path.length}:${path}${id}`
          const makeInvokeChildId = (path: string, id: string): string =>
            `Machine.invoke:${makeInvokeSessionKey(path, id)}`
          const isCurrentInvoke = (key: string, token: symbol): Effect.Effect<boolean> =>
            Ref.get(invokeSessions).pipe(
              Effect.map((sessions) => {
                const current = HashMap.get(sessions, key)
                return Option.isSome(current) && current.value.token === token
              })
            )
          const stopInvokeSession = (session: InvokeSession): Effect.Effect<void> =>
            Effect.all(
              [
                ...(session.watcher === undefined ? [] : [Fiber.interrupt(session.watcher)]),
                context.stopChild(session.childId)
              ],
              { discard: true, concurrency: "unbounded" }
            )
          const removeInvoke = (
            key: string,
            token: symbol | undefined
          ): Effect.Effect<void> =>
            Ref.modify(invokeSessions, (sessions) => {
              const current = HashMap.get(sessions, key)
              return Option.isSome(current) && (token === undefined || current.value.token === token)
                ? [current.value, HashMap.remove(sessions, key)] as const
                : [undefined, sessions] as const
            }).pipe(
              Effect.flatMap((session) =>
                session === undefined
                  ? Effect.void
                  : stopInvokeSession(session)
              )
            )
          const stopInvoke = (key: string): Effect.Effect<void> => removeInvoke(key, undefined)
          const stopAllInvokes: Effect.Effect<void> = Ref.modify(invokeSessions, (sessions) =>
            [HashMap.toEntries(sessions), HashMap.empty()] as const).pipe(
              Effect.flatMap((sessions) =>
                Effect.all(
                  sessions.map(([, session]) =>
                    stopInvokeSession(session)
                  ),
                  { discard: true, concurrency: "unbounded" }
                )
              )
            )
          const handleInvokeOutcome = (
            config: AnyInvokeConfig,
            key: string,
            token: symbol,
            outcome: internalRuntime.RuntimeOutcome<any, any, any>
          ): Effect.Effect<void> => {
            if (outcome._tag === "Stopped") {
              return Effect.void
            }
            return isCurrentInvoke(key, token).pipe(
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
                    : context.self.send(mappedEvent as Machine.EventOf<Events>).pipe(
                      Effect.catchTag("StoppedError", () => Effect.void)
                    )
                }
                return context.failCause(outcome.cause)
              })
            )
          }
          const startInvokeSnapshotWatcher = Effect.fnUntraced(function*(
            config: AnyInvokeConfig,
            child: internalRuntime.MachineRef<any, any, any, any>,
            key: string,
            token: symbol
          ) {
            if (config.snapshot === undefined) {
              return
            }
            const mapSnapshot = config.snapshot
            const watcher = yield* child.changes.pipe(
              Stream.filter((snapshot) => snapshot.status === "active"),
              Stream.runForEach((snapshot) =>
                isCurrentInvoke(key, token).pipe(
                  Effect.flatMap((isCurrent) => {
                    if (!isCurrent) {
                      return Effect.void
                    }
                    const mappedEvent = mapSnapshot({ id: config.id, snapshot })
                    return mappedEvent === undefined
                      ? Effect.void
                      : context.self.send(mappedEvent as Machine.EventOf<Events>).pipe(
                        Effect.catchTag("StoppedError", () => Effect.void)
                      )
                  })
                )
              ),
              Effect.forkChild
            )
            const installed = yield* Ref.modify(invokeSessions, (sessions) => {
              const current = HashMap.get(sessions, key)
              if (Option.isNone(current) || current.value.token !== token) {
                return [false, sessions] as const
              }
              return [
                true,
                HashMap.set(sessions, key, { ...current.value, watcher })
              ] as const
            })
            if (!installed) {
              yield* Fiber.interrupt(watcher)
            }
          })
          const startInvoke = Effect.fnUntraced(function*<StateId extends Machine.StateIdentifier<States>>(
            path: StateId,
            config: AnyInvokeConfig
          ) {
            const token = Symbol()
            const invokeId = String(config.id)
            const key = makeInvokeSessionKey(path, invokeId)
            const childId = config.address === undefined ? makeInvokeChildId(path, invokeId) : String(config.address)
            const reserved = yield* Ref.modify(invokeSessions, (sessions) =>
              HashMap.has(sessions, key)
                ? [false, sessions] as const
                : [true, HashMap.set(sessions, key, { token, watcher: undefined, childId, path })] as const)
            if (!reserved) {
              return yield* Effect.fail(new ChildAlreadyExistsError({ id: invokeId }))
            }
            const logic = config.src()
            const sendParent = (event: unknown): Effect.Effect<void, StoppedError> =>
              isCurrentInvoke(key, token).pipe(
                Effect.flatMap((isCurrent) =>
                  isCurrent ? context.self.send(event as Machine.EventOf<Events>) : Effect.void
                )
              )
            const child = yield* context.spawn(
              {
                initial: (childScope) => logic.initial({ ...childScope, sendParent }),
                run: (childContext) => logic.run({ ...childContext, sendParent })
              },
              {
                id: childId,
                ...(config.descriptor === undefined ? undefined : { descriptor: config.descriptor }),
                onOutcome: (outcome) => handleInvokeOutcome(config, key, token, outcome)
              }
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? removeInvoke(key, token)
                  : Effect.void
              )
            )
            yield* startInvokeSnapshotWatcher(config, child, key, token)
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
            yield* Effect.all(
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
                ),
              { discard: true }
            )
          })
          const stopInvokes = (paths: ReadonlyArray<string>): Effect.Effect<void> =>
            Ref.get(invokeSessions).pipe(
              Effect.flatMap((sessions) =>
                Effect.all(
                  internalPlanner.sortExitPaths(machine, paths).flatMap((path) =>
                    HashMap.toEntries(sessions)
                      .filter(([, session]) => session.path === path)
                      .map(([key]) => stopInvoke(key))
                  ),
                  { discard: true, concurrency: "unbounded" }
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

            yield* Effect.whileLoop({
              while: () => terminal === undefined,
              body: () =>
                Effect.gen(function*() {
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
                    yield* internalPlanner.runEmittedEvents(
                      planned.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>,
                      liveRuntime
                    )

                    if (planned.done) {
                      terminal = { output: planned.output as Output }
                      yield* stopAllInvokes
                    } else {
                      if (changed) {
                        for (const [path, entryEvent] of entryEvents) {
                          yield* startInvokes(planned.next, [path], entryEvent)
                        }
                      }
                    }
                  }

                  if (terminal === undefined) {
                    pendingEvent = yield* (pollEvent ??= Queue.poll(mailbox))
                    if (Option.isNone(pendingEvent)) {
                      configuration = undefined
                      pollEvent = undefined
                    }
                  }
                }),
              step: () => undefined
            })

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
> = (machine, ...args) => makeProcessLogic(machine, { _tag: "Initial", args })

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
