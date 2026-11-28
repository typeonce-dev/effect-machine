/**
 * Planner trace construction shared by scenario runs and graph exploration.
 *
 * @since 0.4.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Machine from "../../../Machine.js"
import type {
  EventPlan,
  InitialPlan,
  InitialTrace,
  RunError,
  RunFailure,
  RunningWork,
  RunServices,
  Scenario,
  ScenarioEvent,
  Trace,
  TraceStep
} from "../../../testing/MachineTest.js"
import type { EnsureExecutable } from "../../machine/readiness.js"
import * as Work from "./work.js"

// A scenario entry for a result of work is part of the trace model.
export { isWorkOutcome, WorkOutcomeTypeId } from "./work.js"

type AnyMachine = Machine.Machine.Any

type InputValue<M extends AnyMachine> = Machine.Machine.Input<M>

type StatePath<M extends AnyMachine> = Machine.Machine.StateIdentifier<Machine.Machine.States<M>>

type ReadyMachine<M extends AnyMachine> =
  & M
  & EnsureExecutable<
    Machine.Machine.States<M>,
    Machine.Machine.UnhandledStates<M>,
    Machine.Machine.OutputStates<M>
  >

export const rawConfigurationPaths = <M extends AnyMachine>(
  machine: M,
  snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>
): ReadonlyArray<StatePath<M>> => {
  const active = new Set<string>()
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null) return
    const value = current as Record<string, unknown>
    if (typeof value.path === "string") active.add(value.path)
    if (value.state !== undefined) visit(value.state)
    if (typeof value.states === "object" && value.states !== null) {
      for (const child of Object.values(value.states)) visit(child)
    }
  }
  visit(snapshot)
  return Machine.stateNodes(machine)
    .filter((node) => node.type !== "history" && node.type !== "choice" && active.has(node.path))
    .map((node) => node.path) as ReadonlyArray<StatePath<M>>
}

/** A step whose result ends the machine with a failure instead of planning a state. */
export interface MachineFailure {
  readonly _tag: "MachineFailure"
  readonly cause: Cause.Cause<unknown>
}

const failRun = <M extends AnyMachine>(
  trace: Trace<M>,
  event: ScenarioEvent<M>,
  scenario: Scenario<M>,
  cause: RunError<M>
): RunFailure<RunError<M>, M> => ({
  _tag: "MachineTestRunFailure",
  scenario,
  phase: "event",
  eventIndex: trace.steps.length,
  event,
  initial: trace.initial,
  steps: trace.steps.slice(),
  cause
})

const planned = <M extends AnyMachine>(
  machine: ReadyMachine<M>,
  trace: Trace<M>,
  event: ScenarioEvent<M>,
  scenario: Scenario<M>,
  message: unknown,
  running: ReadonlyArray<RunningWork>
): Effect.Effect<Trace<M>, RunFailure<RunError<M>, M>, RunServices<M>> => {
  const index = trace.steps.length
  const before = trace.final
  const beforeConfiguration = rawConfigurationPaths(machine, before)
  return ((Machine.plan as any)(machine, before, message) as Effect.Effect<
    EventPlan<M>,
    RunError<M>,
    RunServices<M>
  >).pipe(
    Effect.mapError((cause) => failRun(trace, event, scenario, cause)),
    Effect.map((plan) => {
      const step: TraceStep<M> = {
        index,
        before,
        beforeConfiguration,
        // A result of work keeps the outcome that reported it, so the scenario
        // rebuilt from the steps reproduces the trace.
        event: Work.isWorkOutcome(event) ? event : plan.event,
        plan,
        after: plan.next,
        afterConfiguration: rawConfigurationPaths(machine, plan.next)
      }
      return {
        scenario: { ...scenario, events: [...trace.steps.map((step) => step.event), step.event] },
        initial: trace.initial,
        steps: [...trace.steps, step],
        final: plan.next,
        finalConfiguration: step.afterConfiguration,
        work: Work.next(machine, running, plan)
      }
    })
  )
}

/**
 * Plans one scenario entry after `trace`. A result of work that fails the
 * machine is returned as a `MachineFailure`, because a trace has no state for it.
 */
export const stepTrace = <M extends AnyMachine>(
  machine: ReadyMachine<M>,
  trace: Trace<M>,
  event: ScenarioEvent<M>,
  scenario: Scenario<M>
): Effect.Effect<Trace<M> | MachineFailure, RunFailure<RunError<M>, M>, RunServices<M>> =>
  Effect.suspend((): Effect.Effect<Trace<M> | MachineFailure, RunFailure<RunError<M>, M>, RunServices<M>> => {
    if (!Work.isWorkOutcome(event)) return planned(machine, trace, event, scenario, event, trace.work)
    const work = Work.find(trace.work, event)
    // Work that no longer runs reports a late result, which every host ignores.
    if (work === undefined) return planned(machine, trace, event, scenario, Work.stale(event), trace.work)
    if (!Work.accepts(work, event)) {
      return Effect.die(
        new Error(
          `MachineTest expected a ${event.kind} outcome to name a running ${
            event.kind === "Elapsed" ? "timer" : "Effect"
          }, but "${event.path}" runs "${event.id}" as ${work.kind}`
        )
      )
    }
    const running = trace.work.filter((other) => other !== work)
    const decision = Work.decide(work, event)
    switch (decision._tag) {
      case "Deliver":
        return planned(machine, trace, event, scenario, decision.event, running)
      case "Ignore":
        return planned(machine, trace, event, scenario, Work.stale(event), running)
      case "Fail":
        return Effect.succeed<MachineFailure>({ _tag: "MachineFailure", cause: decision.cause })
    }
  })

export const appendTrace = <M extends AnyMachine>(
  machine: ReadyMachine<M>,
  trace: Trace<M>,
  event: ScenarioEvent<M>,
  scenario: Scenario<M>
): Effect.Effect<Trace<M>, RunFailure<RunError<M>, M>, RunServices<M>> =>
  Effect.flatMap(
    stepTrace(machine, trace, event, scenario),
    (next) => isMachineFailure(next) ? failMachine(trace, event, scenario, next) : Effect.succeed(next)
  )

/**
 * The failure of planning a scenario whose entry failed the machine. A typed
 * failure of the work is an error of the machine, and anything else a defect.
 */
export const failMachine = <M extends AnyMachine>(
  trace: Trace<M>,
  event: ScenarioEvent<M>,
  scenario: Scenario<M>,
  failed: MachineFailure
): Effect.Effect<never, RunFailure<RunError<M>, M>> => {
  const failure = failed.cause.reasons.find(Cause.isFailReason)
  return failure === undefined
    ? Effect.failCause(failed.cause as Cause.Cause<never>)
    : Effect.fail(failRun(trace, event, scenario, failure.error as RunError<M>))
}

export const isMachineFailure = (value: unknown): value is MachineFailure =>
  typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "MachineFailure"

export const run: <M extends AnyMachine>(
  machine: ReadyMachine<M>,
  scenario: Scenario<M>
) => Effect.Effect<Trace<M>, RunFailure<RunError<M>, M>, RunServices<M>> = Effect.fnUntraced(function*<
  M extends AnyMachine
>(
  machine: ReadyMachine<M>,
  scenario: Scenario<M>
) {
  const initialEffect = (machine.input === undefined || machine.input === Schema.Void
    ? (Machine.planInitial as any)(machine)
    : (Machine.planInitial as any)(machine, (scenario as { readonly input: InputValue<M> }).input)) as Effect.Effect<
      InitialPlan<M>,
      RunError<M>,
      RunServices<M>
    >
  const initial = yield* initialEffect.pipe(
    Effect.mapError((cause): RunFailure<RunError<M>, M> => ({
      _tag: "MachineTestRunFailure",
      scenario,
      phase: "initial",
      eventIndex: undefined,
      event: undefined,
      initial: undefined,
      steps: [],
      cause
    }))
  )
  const initialTrace: InitialTrace<M> = {
    plan: initial,
    startingState: initial.startingState,
    startingConfiguration: rawConfigurationPaths(machine, initial.startingState),
    initialEntryPaths: initial.initialEntryPaths,
    configuration: rawConfigurationPaths(machine, initial.state)
  }
  let trace: Trace<M> = {
    scenario: { ...scenario, events: [] },
    initial: initialTrace,
    steps: [],
    final: initial.state,
    finalConfiguration: initialTrace.configuration,
    work: Work.initial(machine, initial)
  }

  for (const event of scenario.events) {
    trace = yield* appendTrace(machine, trace, event, scenario)
  }

  return trace
})
