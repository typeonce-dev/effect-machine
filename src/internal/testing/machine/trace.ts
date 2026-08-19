/**
 * Planner trace construction shared by scenario runs and graph exploration.
 *
 * @since 0.4.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Machine from "../../../Machine.js"
import type {
  EventPlan,
  InitialPlan,
  InitialTrace,
  RunError,
  RunFailure,
  RunServices,
  Scenario,
  Trace,
  TraceStep
} from "../../../testing/MachineTest.js"
import type { EnsureExecutable } from "../../machine/readiness.js"

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

export const appendTrace = <M extends AnyMachine>(
  machine: ReadyMachine<M>,
  trace: Trace<M>,
  event: Machine.Machine.InputEvent<M>,
  scenario: Scenario<M>
): Effect.Effect<Trace<M>, RunFailure<RunError<M>, M>, RunServices<M>> => {
  const index = trace.steps.length
  const before = trace.final
  const beforeConfiguration = rawConfigurationPaths(machine, before)
  return ((Machine.plan as any)(machine, before, event) as Effect.Effect<
    EventPlan<M>,
    RunError<M>,
    RunServices<M>
  >).pipe(
    Effect.mapError((cause): RunFailure<RunError<M>, M> => ({
      _tag: "MachineTestRunFailure",
      scenario,
      phase: "event",
      eventIndex: index,
      event,
      initial: trace.initial,
      steps: trace.steps.slice(),
      cause
    })),
    Effect.map((plan) => {
      const step: TraceStep<M> = {
        index,
        before,
        beforeConfiguration,
        event,
        plan,
        after: plan.next,
        afterConfiguration: rawConfigurationPaths(machine, plan.next)
      }
      return {
        scenario,
        initial: trace.initial,
        steps: [...trace.steps, step],
        final: plan.next,
        finalConfiguration: step.afterConfiguration
      }
    })
  )
}

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
    scenario,
    initial: initialTrace,
    steps: [],
    final: initial.state,
    finalConfiguration: initialTrace.configuration
  }

  for (const event of scenario.events) {
    trace = yield* appendTrace(machine, trace, event, scenario)
  }

  return trace
})
