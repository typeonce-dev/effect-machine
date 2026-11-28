/**
 * Internal machine process integration.
 *
 * @since 0.4.0
 */

import * as Effect from "effect/Effect"
import type { Machine } from "../../Machine.js"
import { type CapturedStateConfig, toImpl } from "./implementation.js"
import { decodeEventSync } from "./protocol.js"
import * as ProcessRuntime from "./runtime.js"
import * as internalRuntimeProtocol from "./runtimeProtocol.js"
import * as StepHost from "./stepHost.js"

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

const eventDecoders = new WeakMap<Machine.Any, internalRuntimeProtocol.EventDecoder>()

// One decoder per machine, so a started process holds no closure of its own
// for it. What work reports is the runtime's own message and is not decoded.
const eventDecoderOf = (machine: Machine.Any): internalRuntimeProtocol.EventDecoder => {
  let decoder = eventDecoders.get(machine)
  if (decoder === undefined) {
    decoder = (event) => event instanceof internalRuntimeProtocol.WorkMessage ? event : decodeEventSync(machine, event)
    eventDecoders.set(machine, decoder)
  }
  return decoder
}

type Planner = "Compiled" | "Reference"

// Process logic executes erased machine definitions. The public `LocalMachine`
// module owns the typed contract that specializes this boundary.
const makeProcessLogic = (
  machine: Machine.Any,
  entry: StepHost.Entry,
  planner: Planner
): internalRuntimeProtocol.ProcessLogic<any, any, any, any, any, any> => {
  const execution = StepHost.makeExecution(
    machine,
    entry,
    planner,
    !hasInvokeCapability(machine),
    eventDecoderOf(machine)
  )
  return {
    inspection: { kind: "Machine", definition: machine },
    execution,
    initial: (scope) => execution.initial!(scope).pipe(Effect.map((initialized) => initialized.state)),
    // A machine runs only on its compiled execution.
    run: () => Effect.die(new Error("A machine runs on its compiled execution"))
  }
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
    return makeProcessLogic(machine, { _tag: "Initial", args }, "Compiled")
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
  const logic = makeProcessLogic(machine, { _tag: "Initial", args }, "Compiled")
  initialProcessLogicCache.set(machine, logic as any)
  return logic
}

const toResumedProcessLogic = (
  machine: Machine.Any,
  snapshot: Machine.Snapshot<any>
): internalRuntimeProtocol.ProcessLogic<any, any, any, any, any, any> =>
  makeProcessLogic(machine, { _tag: "Resume", snapshot }, "Compiled")

const toChildProcessLogic: internalRuntimeProtocol.MakeChildLogic = (machine, input) =>
  machine.input === undefined ? toProcessLogic(machine) : toProcessLogic(machine, input)

const runtime = ProcessRuntime.make(toChildProcessLogic)

// The reference strategy runs a machine on the same driver as every other,
// with a step that always plans with the reference planner.
const strategyLogic = (
  machine: Machine.Any,
  strategy: ProcessRuntime.ProcessRuntimeStrategy,
  entry: StepHost.Entry
): internalRuntimeProtocol.ProcessLogic<any, any, any, any, any, any> =>
  strategy === "generic"
    ? makeProcessLogic(machine, entry, "Reference")
    : entry._tag === "Initial"
    ? toProcessLogic(machine, ...entry.args)
    : toResumedProcessLogic(machine, entry.snapshot)

const runtimeStrategy = (strategy: ProcessRuntime.ProcessRuntimeStrategy): ProcessRuntime.ProcessRuntimeStrategy =>
  strategy === "generic" ? "compiled" : strategy

/** @internal Test-only runtime strategy selection for a fresh machine. */
export const startWithRuntimeStrategyForTesting = (
  machine: Machine.Any,
  strategy: ProcessRuntime.ProcessRuntimeStrategy,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<internalRuntimeProtocol.MachineRef<any, any, any, any>, any, any> =>
  runtime.startProcessWithStrategyForTesting(
    strategyLogic(machine, strategy, { _tag: "Initial", args }),
    runtimeStrategy(strategy),
    machine.id === undefined ? undefined : { id: machine.id }
  )

/** @internal Test-only prepared startup strategy selection for a fresh machine. */
export const prepareWithRuntimeStrategyForTesting = (
  machine: Machine.Any,
  strategy: ProcessRuntime.ProcessRuntimeStrategy,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<internalRuntimeProtocol.PreparedProcess<any, any, any, any, any, any, any>, any, any> =>
  runtime.prepareProcessWithStrategyForTesting(
    strategyLogic(machine, strategy, { _tag: "Initial", args }),
    runtimeStrategy(strategy),
    machine.id === undefined ? undefined : { id: machine.id }
  )

/** @internal Test-only runtime strategy selection for a resumed machine. */
export const resumeWithRuntimeStrategyForTesting = (
  machine: Machine.Any,
  snapshot: Machine.Snapshot<any>,
  strategy: ProcessRuntime.ProcessRuntimeStrategy
): Effect.Effect<internalRuntimeProtocol.MachineRef<any, any, any, any>, any, any> =>
  runtime.startProcessWithStrategyForTesting(
    strategyLogic(machine, strategy, { _tag: "Resume", snapshot }),
    runtimeStrategy(strategy),
    machine.id === undefined ? undefined : { id: machine.id }
  )

/** @internal Test-only runtime strategy selection for a prepared resumed machine. */
export const prepareResumedWithRuntimeStrategyForTesting = (
  machine: Machine.Any,
  snapshot: Machine.Snapshot<any>,
  strategy: ProcessRuntime.ProcessRuntimeStrategy
): Effect.Effect<internalRuntimeProtocol.PreparedProcess<any, any, any, any, any, any, any>, any, any> =>
  runtime.prepareProcessWithStrategyForTesting(
    strategyLogic(machine, strategy, { _tag: "Resume", snapshot }),
    runtimeStrategy(strategy),
    machine.id === undefined ? undefined : { id: machine.id }
  )

// The public `LocalMachine` module owns the typed start, prepare, and resume
// signatures. These implementations are the erased boundary they specialize.
export const start = (
  machine: Machine.Any,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<internalRuntimeProtocol.MachineRef<any, any, any, any, any>, any, any> =>
  runtime.startProcess(
    toProcessLogic(machine, ...args),
    machine.id === undefined ? undefined : { id: machine.id }
  )

export const prepare = (
  machine: Machine.Any,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<internalRuntimeProtocol.PreparedProcess<any, any, any, any, any, any, any>> =>
  runtime.prepareProcess(
    toProcessLogic(machine, ...args),
    machine.id === undefined ? undefined : { id: machine.id }
  )

export const resume = (
  machine: Machine.Any,
  snapshot: Machine.Snapshot<any>
): Effect.Effect<internalRuntimeProtocol.MachineRef<any, any, any, any, any>, any, any> =>
  runtime.startProcess(
    toResumedProcessLogic(machine, snapshot),
    machine.id === undefined ? undefined : { id: machine.id }
  )
