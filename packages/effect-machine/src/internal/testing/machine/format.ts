import type { Machine } from "../../../Machine.js"
import type { InitialTrace, Microstep, RunFailure, Trace, TraceStep } from "../../../testing/MachineTest.js"
type AnyMachine = Machine.Any

const canonicalize = (value: unknown, active: WeakSet<object>): unknown => {
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return { $number: Object.is(value, -0) ? "-0" : String(value) }
  }
  if (value === undefined) return { $undefined: true }
  if (typeof value === "bigint") return { $bigint: String(value) }
  if (typeof value === "symbol") return { $symbol: String(value) }
  if (typeof value === "function") return { $function: value.name || "anonymous" }
  if (typeof value !== "object" || value === null) return value
  if (active.has(value)) return { $circular: true }
  active.add(value)
  let result: unknown
  if (value instanceof Error) {
    result = {
      $error: value.name,
      message: value.message,
      ...Object.fromEntries(
        Object.keys(value).sort().map((
          key
        ) => [key, canonicalize((value as unknown as Record<string, unknown>)[key], active)])
      )
    }
  } else if (Array.isArray(value)) {
    result = value.map((item) => canonicalize(item, active))
  } else if (value instanceof RegExp) {
    result = { $regexp: value.source, flags: value.flags, lastIndex: value.lastIndex }
  } else if (value instanceof Date) {
    result = { $date: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() }
  } else if (value instanceof Map) {
    result = {
      $map: Array.from(value, ([key, item]) => [canonicalize(key, active), canonicalize(item, active)]).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      )
    }
  } else if (value instanceof Set) {
    result = {
      $set: Array.from(value, (item) => canonicalize(item, active)).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      )
    }
  } else {
    result = Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key], active)])
    )
  }
  active.delete(value)
  return result
}

export const formatValue = (value: unknown): string => JSON.stringify(canonicalize(value, new WeakSet()))

const formatConfiguration = (paths: ReadonlyArray<string>): string =>
  `[${paths.map((path) => path === "" ? "(root)" : path).join(", ")}]`

const formatMicrosteps = <M extends AnyMachine>(microsteps: ReadonlyArray<Microstep<M, any>>): Array<string> =>
  microsteps.map((microstep, index) => {
    const transitions = microstep.transitions.map((transition) => ({
      source: transition.source,
      trigger: transition.trigger,
      reenter: transition.reenter,
      branchIndex: transition.branchIndex,
      target: transition.target,
      resolvedTarget: transition.resolvedTarget
    }))
    return `  microstep ${index}: event=${formatValue(microstep.event)} changed=${String(microstep.changed)} ` +
      `transitions=${formatValue(transitions)} exit=${formatConfiguration(microstep.exitPaths)} ` +
      `entry=${formatConfiguration(microstep.entryPaths)} commands=${microstep.commands.length} ` +
      `raised=${formatValue(microstep.raisedEvents)} emitted=${formatValue(microstep.emittedEvents)} ` +
      `next=${formatValue(microstep.next)}`
  })

const formatInitial = <M extends AnyMachine>(initial: InitialTrace<M>): Array<string> => [
  `initial: startingConfiguration=${formatConfiguration(initial.startingConfiguration)} ` +
  `startingState=${formatValue(initial.startingState)} initialEntry=${
    formatConfiguration(initial.initialEntryPaths)
  } ` +
  `configuration=${formatConfiguration(initial.configuration)} state=${formatValue(initial.plan.state)} ` +
  `done=${String(initial.plan.done)} output=${formatValue(initial.plan.output)} ` +
  `commands=${initial.plan.commands.length} emitted=${formatValue(initial.plan.emittedEvents)}`,
  ...formatMicrosteps(initial.plan.microsteps)
]

const formatStep = <M extends AnyMachine>(step: TraceStep<M>): Array<string> => [
  `step ${step.index}: event=${formatValue(step.event)} before=${formatConfiguration(step.beforeConfiguration)} ` +
  `after=${formatConfiguration(step.afterConfiguration)} state=${formatValue(step.after)} ` +
  `done=${String(step.plan.done)} output=${formatValue(step.plan.output)} ` +
  `commands=${step.plan.commands.length} emitted=${formatValue(step.plan.emittedEvents)}`,
  ...formatMicrosteps(step.plan.microsteps)
]

const isRunFailure = <M extends AnyMachine, Cause>(
  trace: Trace<M> | RunFailure<Cause, M>
): trace is RunFailure<Cause, M> => "_tag" in trace && trace._tag === "MachineTestRunFailure"

export const formatTrace = <M extends AnyMachine, Cause>(trace: Trace<M> | RunFailure<Cause, M>): string => {
  const lines = [`scenario: ${formatValue(trace.scenario)}`]
  if (isRunFailure(trace)) {
    if (trace.initial !== undefined) {
      lines.push(...formatInitial(trace.initial))
      for (const step of trace.steps) {
        lines.push(...formatStep(step))
      }
    }
    lines.push(
      `failure: phase=${trace.phase} eventIndex=${formatValue(trace.eventIndex)} ` +
        `event=${formatValue(trace.event)} cause=${formatValue(trace.cause)}`
    )
    return lines.join("\n")
  }
  lines.push(...formatInitial(trace.initial))
  for (const step of trace.steps) {
    lines.push(...formatStep(step))
  }
  lines.push(`final: configuration=${formatConfiguration(trace.finalConfiguration)} state=${formatValue(trace.final)}`)
  return lines.join("\n")
}
