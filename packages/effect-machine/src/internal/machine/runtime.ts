/** Local process startup and execution strategy selection. */

import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
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
// Each machine gets an owner scope forked from the caller's Scope: closing the
// caller's Scope stops the machine, and termination closes the owner scope so
// it leaves its parent again. Owned children keep their process-local
// ownership.
const ownedByScope = <State, Event, Error, Output, Emitted, StartError, Requirements>(
  start: (
    ownership: Pick<StartInternalOptions, "onStop">
  ) => Effect.Effect<MachineRef<State, Event, Error, Output, Emitted>, StartError, Requirements>
): Effect.Effect<MachineRef<State, Event, Error, Output, Emitted>, StartError, Requirements | Scope.Scope> =>
  Effect.flatMap(Effect.scope, (parent) =>
    Effect.suspend(() => {
      const owner = Scope.forkUnsafe(parent)
      let terminated = false
      const onStop = Effect.suspend(() => {
        terminated = true
        return Scope.close(owner, Exit.void)
      })
      return Effect.uninterruptibleMask((restore) =>
        restore(start({ onStop })).pipe(
          Effect.tap((ref) =>
            Scope.addFinalizer(
              owner,
              Effect.suspend(() => terminated ? Effect.void : ref.stop)
            )
          ),
          Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(owner, exit) : Effect.void)
        )
      )
    }))

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
    return yield* ownedByScope((ownership) => startGenericInternal(logic, { ...internalOptions, ...ownership }))
  }
  if (strategy === "compiled") {
    if (logic.execution?._tag !== "Compiled") {
      return yield* Effect.die(new Error("Machine cannot force the compiled runtime for generic process logic"))
    }
    return yield* ownedByScope((ownership) =>
      startCompactCompiledInternal(logic, { ...internalOptions, ...ownership })
    )
  }
  return yield* ownedByScope((ownership) => startLogicInternal(logic, { ...internalOptions, ...ownership }))
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
  return yield* ownedByScope((ownership) =>
    startLogicInternal(
      logic,
      options === undefined
        ? {
          detached: true,
          runtime,
          ...ownership
        }
        : {
          ...options,
          detached: true,
          runtime,
          ...ownership
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
  const initialize = (ownership: Pick<StartInternalOptions, "onStop">) => {
    const startOptions = { ...internalOptions, ...ownership }
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
