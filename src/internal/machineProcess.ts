/**
 * Internal machine process integration.
 *
 * @since 4.0.0
 */

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import type * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { ActionError, ExecutionServices, Machine, Runtime } from "../Machine.js"
import { ChildAlreadyExistsError } from "./machineErrors.js"
import type { InfiniteTransitionError, MachineSchemaDecodeError, StartupError, StoppedError } from "./machineErrors.js"
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
  readonly scope: Scope.Closeable
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
          yield* internalPlanner.runActions(
            planned.actions,
            runtime
          )
          yield* internalPlanner.runEmittedEvents(planned.emittedEvents, runtime)
          return planned.state
        }),
        scope
      ),
    run: (context) =>
      internalRuntime.provideMachineRuntime(
        Effect.gen(function*() {
          const { receive, state, setState } = context
          let terminal: { readonly output: Output } | undefined

          const initialState = yield* state
          if (internalPlanner.isFinalState(machine, initialState)) {
            return yield* internalPlanner.getFinalOutputEffect<States, Events, Output>(
              machine,
              initialState,
              internalPlanner.InitialEvent
            )
          }

          const liveRuntime = internalPlanner.makeLiveRuntime<Machine.EventOf<Events>, Machine.EmitOf<Emits>>(
            machine,
            context
          )

          if (!hasInvokes) {
            yield* Effect.whileLoop({
              while: () => terminal === undefined,
              body: () =>
                Effect.gen(function*() {
                  const event = yield* receive
                  const current = yield* state
                  const planned = yield* internalPlanner.plan(machine, current, event)
                  if (planned.microsteps.length === 0) {
                    return yield* Effect.yieldNow
                  }

                  yield* internalPlanner.runActions(planned.actions, liveRuntime)
                  yield* setState(planned.next)
                  yield* internalPlanner.runEmittedEvents(
                    planned.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>,
                    liveRuntime
                  )

                  if (planned.done) {
                    terminal = { output: planned.output }
                  } else {
                    yield* Effect.yieldNow
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
          const removeInvoke = (
            key: string,
            token: symbol | undefined,
            exit: Exit.Exit<unknown, unknown>
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
                  : Scope.close(session.scope, exit).pipe(
                    Effect.andThen(context.stopChild(session.childId))
                  )
              )
            )
          const stopInvoke = (key: string, exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
            removeInvoke(key, undefined, exit)
          const stopAllInvokes = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
            Ref.modify(invokeSessions, (sessions) => [HashMap.toEntries(sessions), HashMap.empty()] as const).pipe(
              Effect.flatMap((sessions) =>
                Effect.all(
                  sessions.map(([, session]) =>
                    Scope.close(session.scope, exit).pipe(
                      Effect.andThen(context.stopChild(session.childId))
                    )
                  ),
                  { discard: true, concurrency: "unbounded" }
                )
              )
            )
          const startInvokeWatchers = Effect.fnUntraced(function*(
            config: AnyInvokeConfig,
            child: internalRuntime.MachineRef<any, any, any, any>,
            key: string,
            token: symbol,
            scope: Scope.Closeable
          ) {
            if (config.snapshot !== undefined) {
              const mapSnapshot = config.snapshot
              yield* child.changes.pipe(
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
                Effect.forkIn(scope),
                Effect.asVoid
              )
            }
            yield* internalRuntime.watch(child).pipe(
              Stream.runForEach((outcome) =>
                isCurrentInvoke(key, token).pipe(
                  Effect.flatMap((isCurrent) => {
                    if (!isCurrent || outcome._tag === "Stopped") {
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
              ),
              Effect.forkIn(scope),
              Effect.asVoid
            )
          })
          const startInvoke = Effect.fnUntraced(function*<StateId extends Machine.StateIdentifier<States>>(
            path: StateId,
            config: AnyInvokeConfig
          ) {
            const token = Symbol()
            const invokeId = String(config.id)
            const key = makeInvokeSessionKey(path, invokeId)
            const childId = config.address === undefined ? makeInvokeChildId(path, invokeId) : String(config.address)
            const scope = yield* Scope.make("parallel")
            const reserved = yield* Ref.modify(invokeSessions, (sessions) =>
              HashMap.has(sessions, key)
                ? [false, sessions] as const
                : [true, HashMap.set(sessions, key, { token, scope, childId, path })] as const)
            if (!reserved) {
              yield* Scope.close(scope, Exit.void)
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
              config.descriptor === undefined
                ? { id: childId }
                : { id: childId, descriptor: config.descriptor }
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Ref.update(invokeSessions, (sessions) => {
                    const current = HashMap.get(sessions, key)
                    return Option.isSome(current) && current.value.token === token
                      ? HashMap.remove(sessions, key)
                      : sessions
                  }).pipe(
                    Effect.andThen(Scope.close(scope, Exit.failCause(exit.cause)))
                  )
                  : Effect.void
              )
            )
            yield* startInvokeWatchers(config, child, key, token, scope)
          })
          const startInvokes: (
            state: Machine.Snapshot<States>,
            paths: ReadonlyArray<string>,
            event: Machine.LifecycleEvent<Events>
          ) => Effect.Effect<void, E | MachineSchemaDecodeError, R> = Effect.fnUntraced(function*(
            state: Machine.Snapshot<States>,
            paths: ReadonlyArray<string>,
            event: Machine.LifecycleEvent<Events>
          ) {
            const configuration = yield* Model.normalizeConfigurationEffect(machine, state)
            yield* Effect.all(
              internalPlanner.sortEntryPaths(machine, paths)
                .filter((path) => configuration.active.has(path))
                .flatMap((path) =>
                  getInvokes(Model.getStateConfigByPath(machine, path), {
                    state: Model.getActiveValue(configuration, path),
                    parent: Model.getParentValue(machine, configuration, path),
                    parents: Model.getParentValues(machine, configuration, path),
                    event,
                    runtime: internalPlanner.runtimeFor<Machine.EventOf<Events>, Machine.EmitOf<Emits>>()
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
                      .map(([key]) => stopInvoke(key, Exit.void))
                  ),
                  { discard: true, concurrency: "unbounded" }
                )
              )
            )

          return yield* Effect.gen(function*() {
            yield* startInvokes(
              initialState,
              Model.getInitialEntryPaths(machine, yield* Model.normalizeConfigurationEffect(machine, initialState)),
              internalPlanner.InitialEvent
            )

            yield* Effect.whileLoop({
              while: () => terminal === undefined,
              body: () =>
                Effect.gen(function*() {
                  const event = yield* receive
                  const current = yield* state
                  const planned = yield* internalPlanner.plan(machine, current, event)
                  if (planned.microsteps.length === 0) {
                    return yield* Effect.yieldNow
                  }
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

                  yield* internalPlanner.runActions(planned.actions, liveRuntime)
                  if (changed) {
                    yield* stopInvokes(exitPaths)
                  }
                  yield* setState(planned.next)
                  yield* internalPlanner.runEmittedEvents(
                    planned.emittedEvents as ReadonlyArray<Machine.EmitOf<Emits>>,
                    liveRuntime
                  )

                  if (planned.done) {
                    terminal = { output: planned.output }
                    yield* stopAllInvokes(Exit.succeed(planned.output))
                  } else {
                    if (changed) {
                      for (const [path, entryEvent] of entryEvents) {
                        yield* startInvokes(planned.next, [path], entryEvent)
                      }
                    }
                    yield* Effect.yieldNow
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
            Effect.onExit((exit) => stopAllInvokes(exit))
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
