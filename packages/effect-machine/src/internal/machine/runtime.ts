/** Local process startup and execution strategy selection. */

import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as InspectionRuntime from "./inspectionRuntime.js"
import { startCompactCompiledInternal, startCompiledSync } from "./runtimeCompiled.js"
import { startGenericInternal } from "./runtimeGeneric.js"
import {
  type MachineRef,
  makeEmissionRuntime,
  makeProcessRuntime,
  type PreparedProcess,
  type ProcessLogic,
  type StartInternalOptions,
  type StartProcess
} from "./runtimeProtocol.js"

const startLogicInternal: StartProcess = ((
  logic: ProcessLogic<any, any, any, any, any, any>,
  options: StartInternalOptions
) =>
  logic.execution?._tag === "Compiled"
    ? startCompactCompiledInternal(logic, options)
    : startGenericInternal(logic, options)) as StartProcess

const makeRuntime = makeProcessRuntime(startLogicInternal, startCompiledSync)

export type ProcessRuntimeStrategy = "generic" | "compiled" | "auto"

// A root machine is owned by the Scope that starts it, like `Effect.forkScoped`.
// Each owning Scope carries one ownership record with a single finalizer that
// stops the machines still alive, in reverse start order. The record's shared
// hooks register a machine when it is ready and release it synchronously when
// it terminates, so machines cost one set entry and long-lived scopes do not
// accumulate finalizers. Owned children keep their process-local ownership.
type OwnershipHooks = Pick<StartInternalOptions, "onReadySync" | "onStopSync">

interface ScopeOwnership {
  readonly live: Set<MachineRef<any, any, any, any>>
  readonly hooks: OwnershipHooks
  closed: boolean
}

const ownerships = new WeakMap<Scope.Scope, ScopeOwnership>()

const stopLive = (ownership: ScopeOwnership): Effect.Effect<void> =>
  Effect.suspend(() => {
    ownership.closed = true
    const refs = Array.from(ownership.live).reverse()
    ownership.live.clear()
    return Effect.forEach(refs, (ref) => ref.stop, { discard: true })
  })

const ownershipOf = (parent: Scope.Scope): Effect.Effect<ScopeOwnership> =>
  Effect.suspend(() => {
    const existing = ownerships.get(parent)
    if (existing !== undefined) return Effect.succeed(existing)
    const live = new Set<MachineRef<any, any, any, any>>()
    const ownership: ScopeOwnership = {
      live,
      hooks: {
        onReadySync: (ref) => {
          live.add(ref)
          return true
        },
        onStopSync: (ref) => {
          live.delete(ref)
        }
      },
      closed: false
    }
    ownerships.set(parent, ownership)
    // A closed Scope runs the finalizer immediately, which marks the record
    // closed so machines started afterwards stop right away.
    return Effect.as(Scope.addFinalizer(parent, stopLive(ownership)), ownership)
  })

const ownedByScope = <State, Event, Error, Output, Emitted, StartError, Requirements>(
  start: (
    hooks: OwnershipHooks
  ) => Effect.Effect<MachineRef<State, Event, Error, Output, Emitted>, StartError, Requirements>
): Effect.Effect<MachineRef<State, Event, Error, Output, Emitted>, StartError, Requirements | Scope.Scope> =>
  Effect.flatMap(Effect.scope, (parent) =>
    Effect.flatMap(ownershipOf(parent), (ownership) =>
      Effect.flatMap(
        start(ownership.hooks),
        (ref) => ownership.closed ? Effect.as(ref.stop, ref) : Effect.succeed(ref)
      )))

const startProcessWithStrategy = Effect.fnUntraced(function*(
  logic: ProcessLogic<any, any, any, any, any, any>,
  strategy: ProcessRuntimeStrategy,
  options?: {
    readonly id?: string
  }
) {
  const runtime = yield* makeRuntime
  const internalOptions: StartInternalOptions = options === undefined
    ? {
      detached: true,
      runtime
    }
    : {
      ...options,
      detached: true,
      runtime
    }
  if (strategy === "generic") {
    return yield* ownedByScope((hooks) => startGenericInternal(logic, { ...internalOptions, ...hooks }))
  }
  if (strategy === "compiled") {
    if (logic.execution?._tag !== "Compiled") {
      return yield* Effect.die(new Error("Machine cannot force the compiled runtime for generic process logic"))
    }
    return yield* ownedByScope((hooks) => startCompactCompiledInternal(logic, { ...internalOptions, ...hooks }))
  }
  return yield* ownedByScope((hooks) => startLogicInternal(logic, { ...internalOptions, ...hooks }))
})

/** @internal Test-only startup strategy selection. */
export const startProcessWithStrategyForTesting = <
  State,
  Event,
  Error = never,
  Requirements = never,
  Output = never,
  InitialError = never
>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  strategy: ProcessRuntimeStrategy,
  options?: {
    readonly id?: string
  }
): Effect.Effect<
  MachineRef<State, Event, Error, Output>,
  InitialError,
  Requirements | Scope.Scope
> => startProcessWithStrategy(logic, strategy, options) as any

export const startProcess: <
  State,
  Event,
  Error = never,
  Requirements = never,
  Output = never,
  InitialError = never
>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  options?: {
    readonly id?: string
  }
) => Effect.Effect<
  MachineRef<State, Event, Error, Output>,
  InitialError,
  Requirements | Scope.Scope
> = Effect.fnUntraced(function*<State, Event, Error, Requirements, Output, InitialError>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  options?: {
    readonly id?: string
  }
) {
  const runtime = yield* makeRuntime
  return yield* ownedByScope((hooks) =>
    startLogicInternal(
      logic,
      options === undefined
        ? {
          detached: true,
          runtime,
          ...hooks
        }
        : {
          ...options,
          detached: true,
          runtime,
          ...hooks
        }
    )
  )
})

const prepareProcessWithStrategy = Effect.fnUntraced(function*<
  State,
  Event,
  Error,
  Requirements,
  Output,
  InitialError,
  Emitted
>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  strategy: ProcessRuntimeStrategy,
  options?: {
    readonly id?: string
  }
) {
  const runtime = yield* makeRuntime
  const sessionId = yield* runtime.nextSessionId
  const inspection = yield* InspectionRuntime.make(sessionId)
  runtime.inspection = inspection
  const emissions = makeEmissionRuntime()
  const started = yield* Deferred.make<MachineRef<State, Event, Error, Output, Emitted>, InitialError>()
  const internalOptions: StartInternalOptions = options === undefined
    ? {
      detached: true,
      emissions,
      runtime,
      sessionId,
      inspectionRoot: true,
      origin: { _tag: "Root" }
    }
    : {
      ...options,
      detached: true,
      emissions,
      runtime,
      sessionId,
      inspectionRoot: true,
      origin: { _tag: "Root" }
    }
  const initialize = (hooks: OwnershipHooks) => {
    const startOptions = { ...internalOptions, ...hooks }
    return strategy === "generic"
      ? startGenericInternal(logic, startOptions)
      : strategy === "compiled"
      ? logic.execution?._tag === "Compiled"
        ? startCompactCompiledInternal(logic, startOptions)
        : Effect.die(new Error("Machine cannot force the compiled runtime for generic process logic"))
      : startLogicInternal(logic, startOptions)
  }
  // `start` is one-shot: the Scope that first evaluates it owns the machine.
  const start = yield* Effect.cached(
    ownedByScope(initialize).pipe(
      Effect.onExit((exit) => Deferred.done(started, exit))
    ) as Effect.Effect<
      MachineRef<State, Event, Error, Output, Emitted>,
      InitialError,
      Requirements | Scope.Scope
    >
  )
  return {
    id: options?.id ?? sessionId,
    sessionId,
    changes: Stream.unwrap(
      Deferred.await(started).pipe(Effect.map((ref) => ref.changes))
    ),
    emissions: emissions.stream as Stream.Stream<Emitted>,
    inspection: inspection.stream,
    start
  }
})

export const prepareProcess: <
  State,
  Event,
  Error = never,
  Requirements = never,
  Output = never,
  InitialError = never,
  Emitted = never
>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  options?: {
    readonly id?: string
  }
) => Effect.Effect<
  PreparedProcess<State, Event, Error, Output, Emitted, InitialError, Requirements | Scope.Scope>
> =
  ((logic: ProcessLogic<any, any, any, any, any, any>, options?: { readonly id?: string }) =>
    prepareProcessWithStrategy(logic, "auto", options)) as any

/** @internal Test-only prepared startup strategy selection. */
export const prepareProcessWithStrategyForTesting = <
  State,
  Event,
  Error = never,
  Requirements = never,
  Output = never,
  InitialError = never,
  Emitted = never
>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  strategy: ProcessRuntimeStrategy,
  options?: {
    readonly id?: string
  }
): Effect.Effect<
  PreparedProcess<State, Event, Error, Output, Emitted, InitialError, Requirements | Scope.Scope>
> => prepareProcessWithStrategy(logic, strategy, options) as any
