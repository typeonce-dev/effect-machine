/** Local process startup and execution strategy selection. */

import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
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
    return yield* startGenericInternal(logic, internalOptions)
  }
  if (strategy === "compiled") {
    if (logic.execution?._tag !== "Compiled") {
      return yield* Effect.die(new Error("Machine cannot force the compiled runtime for generic process logic"))
    }
    return yield* startCompactCompiledInternal(logic, internalOptions)
  }
  return yield* startLogicInternal(logic, internalOptions)
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
  Requirements
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
  Requirements
> = Effect.fnUntraced(function*<State, Event, Error, Requirements, Output, InitialError>(
  logic: ProcessLogic<State, Event, Error, Requirements, Output, InitialError>,
  options?: {
    readonly id?: string
  }
) {
  const runtime = yield* makeRuntime
  return yield* startLogicInternal(
    logic,
    options === undefined
      ? {
        detached: true,
        runtime
      }
      : {
        ...options,
        detached: true,
        runtime
      }
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
  const initialize = strategy === "generic"
    ? startGenericInternal(logic, internalOptions)
    : strategy === "compiled"
    ? logic.execution?._tag === "Compiled"
      ? startCompactCompiledInternal(logic, internalOptions)
      : Effect.die(new Error("Machine cannot force the compiled runtime for generic process logic"))
    : startLogicInternal(logic, internalOptions)
  const start = yield* Effect.cached(
    initialize.pipe(
      Effect.onExit((exit) => Deferred.done(started, exit))
    ) as Effect.Effect<MachineRef<State, Event, Error, Output, Emitted>, InitialError, Requirements>
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
  PreparedProcess<State, Event, Error, Output, Emitted, InitialError, Requirements>
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
  PreparedProcess<State, Event, Error, Output, Emitted, InitialError, Requirements>
> => prepareProcessWithStrategy(logic, strategy, options) as any
