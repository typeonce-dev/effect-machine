/**
 * User-defined semantic invariants over planner traces.
 *
 * @since 0.4.0
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Machine from "../../../Machine.js"
import type {
  Invariant as MachineInvariant,
  InvariantBuilder,
  InvariantCheckResult,
  InvariantOptions,
  InvariantOutcome,
  InvariantReport,
  InvariantScope,
  InvariantViolation,
  StateInvariant,
  StateInvariantContext,
  StateInvariantOptions,
  StateObservation,
  StepInvariant,
  StepInvariantContext,
  Trace,
  TraceInvariant,
  TraceInvariantContext
} from "../../../testing/MachineTest.js"

type AnyMachine = Machine.Machine.Any

type StatePath<M extends AnyMachine> = Machine.Machine.StateIdentifier<Machine.Machine.States<M>>

interface Observation<M extends AnyMachine, Context> {
  readonly context: Context
  readonly observationIndex?: number
  readonly eventIndex: number | undefined
  readonly microstepIndex?: number
  readonly phase?: StateObservation
  readonly configuration?: ReadonlyArray<StatePath<M>>
  readonly event?: Machine.Machine.Event<M> | Machine.InitialEvent
}

const validateName = (name: string): void => {
  if (name.trim().length === 0) {
    throw new Error("MachineTest.Invariant expected name to be a non-empty string")
  }
}

const validateRequirement = <Context>(options: InvariantOptions<Context>): void => {
  const minimum = options.require?.minObservations
  if (minimum !== undefined && (!Number.isSafeInteger(minimum) || minimum < 0)) {
    throw new Error("MachineTest.Invariant expected minObservations to be a non-negative safe integer")
  }
}

export const stateInvariant = <M extends AnyMachine>(
  name: string,
  check: (context: StateInvariantContext<M>) => InvariantOutcome,
  options: StateInvariantOptions<M> = {}
): StateInvariant<M> => {
  validateName(name)
  validateRequirement(options)
  return Object.freeze({
    _tag: "StateInvariant" as const,
    name,
    observe: options.observe ?? "settled",
    check,
    ...(options.when === undefined ? {} : { when: options.when }),
    ...(options.require === undefined ? {} : { require: Object.freeze({ ...options.require }) })
  })
}

export const stepInvariant = <M extends AnyMachine>(
  name: string,
  check: (context: StepInvariantContext<M>) => InvariantOutcome,
  options: InvariantOptions<StepInvariantContext<M>> = {}
): StepInvariant<M> => {
  validateName(name)
  validateRequirement(options)
  return Object.freeze({
    _tag: "StepInvariant" as const,
    name,
    check,
    ...(options.when === undefined ? {} : { when: options.when }),
    ...(options.require === undefined ? {} : { require: Object.freeze({ ...options.require }) })
  })
}

export const traceInvariant = <M extends AnyMachine>(
  name: string,
  check: (context: TraceInvariantContext<M>) => InvariantOutcome,
  options: InvariantOptions<TraceInvariantContext<M>> = {}
): TraceInvariant<M> => {
  validateName(name)
  validateRequirement(options)
  return Object.freeze({
    _tag: "TraceInvariant" as const,
    name,
    check,
    ...(options.when === undefined ? {} : { when: options.when }),
    ...(options.require === undefined ? {} : { require: Object.freeze({ ...options.require }) })
  })
}

export const Invariant = Object.freeze({
  state: stateInvariant,
  step: stepInvariant,
  trace: traceInvariant
})

export const invariants = <M extends AnyMachine>(_machine: M): InvariantBuilder<M> =>
  Object.freeze({
    state: (
      name: string,
      check: (context: StateInvariantContext<M>) => InvariantOutcome,
      options?: StateInvariantOptions<M>
    ) => stateInvariant(name, check, options),
    step: (
      name: string,
      check: (context: StepInvariantContext<M>) => InvariantOutcome,
      options?: InvariantOptions<StepInvariantContext<M>>
    ) => stepInvariant(name, check, options),
    trace: (
      name: string,
      check: (context: TraceInvariantContext<M>) => InvariantOutcome,
      options?: InvariantOptions<TraceInvariantContext<M>>
    ) => traceInvariant(name, check, options)
  })

export class InvariantError<M extends AnyMachine = AnyMachine> extends Data.TaggedError(
  "MachineTestInvariantError"
)<{
  readonly trace: Trace<M>
  readonly violations: ReadonlyArray<InvariantViolation<M>>
  readonly report: InvariantReport
}> {}

const configuration = <M extends AnyMachine>(
  machine: M,
  snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>
): ReadonlyArray<StatePath<M>> => Machine.configuration(machine, snapshot).map(({ path }) => path)

const stateObservations = <M extends AnyMachine>(
  machine: M,
  trace: Trace<M>,
  observe: StateInvariant<M>["observe"]
): ReadonlyArray<Observation<M, StateInvariantContext<M>>> => {
  const observations: Array<Observation<M, StateInvariantContext<M>>> = []
  let observationIndex = 0
  const add = (
    snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>,
    paths: ReadonlyArray<StatePath<M>>,
    phase: StateObservation,
    eventIndex: number | undefined,
    microstepIndex: number | undefined,
    event: Machine.Machine.Event<M> | Machine.InitialEvent | undefined
  ): void => {
    const context: StateInvariantContext<M> = {
      machine,
      trace,
      snapshot,
      configuration: paths,
      observationIndex,
      phase,
      eventIndex,
      microstepIndex,
      event
    }
    observations.push({
      context,
      observationIndex,
      eventIndex,
      ...(microstepIndex === undefined ? {} : { microstepIndex }),
      phase,
      configuration: paths,
      ...(event === undefined ? {} : { event })
    })
    observationIndex += 1
  }

  if (observe === "final") {
    add(trace.final, trace.finalConfiguration, "final", undefined, undefined, undefined)
    return observations
  }

  if (observe === "settled" || observe === "all") {
    add(
      trace.initial.plan.state,
      trace.initial.configuration,
      "initial",
      undefined,
      undefined,
      undefined
    )
  }

  if (observe === "microsteps" || observe === "all") {
    trace.initial.plan.microsteps.forEach((microstep, microstepIndex) => {
      add(
        microstep.next,
        configuration(machine, microstep.next),
        "microstep",
        undefined,
        microstepIndex,
        microstep.event
      )
    })
  }

  for (const step of trace.steps) {
    if (observe === "microsteps" || observe === "all") {
      step.plan.microsteps.forEach((microstep, microstepIndex) => {
        add(
          microstep.next,
          configuration(machine, microstep.next),
          "microstep",
          step.index,
          microstepIndex,
          microstep.event
        )
      })
    }
    if (observe === "settled" || observe === "all") {
      add(
        step.after,
        step.afterConfiguration,
        "event",
        step.index,
        undefined,
        step.event
      )
    }
  }

  return observations
}

const stepObservations = <M extends AnyMachine>(
  machine: M,
  trace: Trace<M>
): ReadonlyArray<Observation<M, StepInvariantContext<M>>> =>
  trace.steps.map((step) => ({
    context: {
      machine,
      trace,
      step,
      index: step.index,
      before: step.before,
      beforeConfiguration: step.beforeConfiguration,
      event: step.event,
      plan: step.plan,
      after: step.after,
      afterConfiguration: step.afterConfiguration
    },
    eventIndex: step.index,
    event: step.event
  }))

const traceObservations = <M extends AnyMachine>(
  machine: M,
  trace: Trace<M>
): ReadonlyArray<Observation<M, TraceInvariantContext<M>>> => [{
  context: { machine, trace },
  eventIndex: undefined
}]

const scopeOf = <M extends AnyMachine>(invariant: MachineInvariant<M>): InvariantScope => {
  switch (invariant._tag) {
    case "StateInvariant":
      return "state"
    case "StepInvariant":
      return "step"
    case "TraceInvariant":
      return "trace"
  }
}

const messageOf = (outcome: InvariantOutcome): string | undefined =>
  outcome === true ? undefined : typeof outcome === "string" ? outcome : "Invariant predicate returned false"

type EvaluatedInvariant<Context> = InvariantOptions<Context> & {
  readonly name: string
  readonly check: (context: Context) => InvariantOutcome
}

const evaluateInvariant = <M extends AnyMachine, Context>(
  invariant: EvaluatedInvariant<Context>,
  scope: InvariantScope,
  observations: ReadonlyArray<Observation<M, Context>>
): {
  readonly check: InvariantCheckResult
  readonly violations: ReadonlyArray<InvariantViolation<M>>
} => {
  let observed = 0
  let failures = 0
  const violations: Array<InvariantViolation<M>> = []

  for (const observation of observations) {
    if (invariant.when !== undefined && !invariant.when(observation.context)) continue
    observed += 1
    const message = messageOf(invariant.check(observation.context))
    if (message === undefined) continue
    failures += 1
    violations.push({
      invariant: invariant.name,
      scope,
      kind: "predicate",
      ...(observation.observationIndex === undefined ? {} : { observationIndex: observation.observationIndex }),
      eventIndex: observation.eventIndex,
      ...(observation.microstepIndex === undefined ? {} : { microstepIndex: observation.microstepIndex }),
      ...(observation.phase === undefined ? {} : { phase: observation.phase }),
      ...(observation.configuration === undefined ? {} : { configuration: observation.configuration }),
      ...(observation.event === undefined ? {} : { event: observation.event }),
      message
    })
  }

  const minimum = invariant.require?.minObservations ?? 0
  const insufficient = observed < minimum
  if (insufficient) {
    violations.push({
      invariant: invariant.name,
      scope,
      kind: "observations",
      eventIndex: undefined,
      message: `Invariant required at least ${minimum} observation${minimum === 1 ? "" : "s"} but observed ${observed}`
    })
  }
  return {
    check: {
      invariant: invariant.name,
      scope,
      status: failures > 0 ? "failed" : insufficient ? "insufficient" : observed === 0 ? "untested" : "passed",
      observations: observed,
      failures
    },
    violations
  }
}

export const checkInvariants = <M extends AnyMachine>(
  machine: M,
  trace: Trace<M>,
  invariants: ReadonlyArray<MachineInvariant<M>>
): Effect.Effect<InvariantReport, InvariantError<M>> =>
  Effect.suspend(() => {
    const checks: Array<InvariantCheckResult> = []
    const violations: Array<InvariantViolation<M>> = []

    for (const invariant of invariants) {
      const scope = scopeOf(invariant)
      const result = invariant._tag === "StateInvariant"
        ? evaluateInvariant(invariant, scope, stateObservations(machine, trace, invariant.observe))
        : invariant._tag === "StepInvariant"
        ? evaluateInvariant(invariant, scope, stepObservations(machine, trace))
        : evaluateInvariant(invariant, scope, traceObservations(machine, trace))
      checks.push(result.check)
      violations.push(...result.violations)
    }

    const report: InvariantReport = { checks }
    return violations.length === 0
      ? Effect.succeed(report)
      : Effect.fail(new InvariantError({ trace, violations, report }))
  })

export const assertInvariants = <M extends AnyMachine>(
  machine: M,
  trace: Trace<M>,
  invariants: ReadonlyArray<MachineInvariant<M>>
): Effect.Effect<void, InvariantError<M>> => checkInvariants(machine, trace, invariants).pipe(Effect.asVoid)
