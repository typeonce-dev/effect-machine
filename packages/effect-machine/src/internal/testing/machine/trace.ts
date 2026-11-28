/**
 * Planner trace construction shared by scenario runs and graph exploration.
 *
 * A trace advances through the step of `Machine.toStep`, which alone decides
 * which work runs, which result is still current, and what a result means to
 * the machine. The trace keeps the state of that step for each trace it
 * builds, and never evaluates the work it lists.
 *
 * @since 0.4.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
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
  ScenarioEvent,
  Trace,
  TraceStep
} from "../../../testing/MachineTest.js"
import type { ActiveConfiguration } from "../../machine/configuration.js"
import * as Planner from "../../machine/planner.js"
import type { EnsureExecutable } from "../../machine/readiness.js"
import * as Step from "../../machine/step.js"
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

/** One scenario entry planned after a trace, with the step state it reached. */
export interface Planned<M extends AnyMachine> {
  readonly _tag: "Planned"
  readonly plan: EventPlan<M>
  readonly state: Step.State
}

const noConfiguration: ActiveConfiguration = {
  active: new Set(),
  values: new Map(),
  outputs: new Map(),
  history: new Map()
}

const steps = new WeakMap<AnyMachine, Step.MachineStep>()

const stepOf = (machine: AnyMachine): Step.MachineStep => {
  let step = steps.get(machine)
  if (step === undefined) {
    // The machine refers to itself as it does in `Machine.plan`, so a command
    // that targets it is the one that `Machine.plan` returns.
    step = Step.make(machine, { self: Planner.resolveMachineReferences(machine, noConfiguration).self })
    steps.set(machine, step)
  }
  return step
}

// The step state of every trace built here. A trace is a public value, so the
// state stays out of it, as the step's work stays out of `RunningWork`.
const states = new WeakMap<Trace<any>, Step.State>()

const stateOf = (trace: Trace<any>): Step.State => {
  const state = states.get(trace)
  if (state === undefined) throw new Error("MachineTest plans only after a trace that it built")
  return state
}

const record = <M extends AnyMachine>(trace: Trace<M>, state: Step.State): Trace<M> => {
  states.set(trace, state)
  return trace
}

const noCommands: ReadonlyArray<never> = []

/** The public plan of a step, as `Machine.plan` returns it. */
const planOf = <M extends AnyMachine>(step: Step.Step, event: unknown): EventPlan<M> => {
  const microsteps = step.microsteps
  const plan = {
    event: step.event ?? event,
    next: step.snapshot,
    // A transition plans its commands in its microstep, so the plan lists them in order.
    commands: microsteps.length === 0
      ? noCommands
      : microsteps.length === 1
      ? microsteps[0]!.commands
      : microsteps.flatMap((microstep) => microstep.commands),
    emittedEvents: step.emitted,
    microsteps
  }
  const exit = step.exit
  return (exit !== undefined && Exit.isSuccess(exit)
    ? { ...plan, done: true, output: exit.value }
    : { ...plan, done: false, output: undefined }) as EventPlan<M>
}

/**
 * The step as a planned entry. A step that ends the machine with a failure
 * failed to plan its event: a typed planning error, or a defect.
 */
const fromStep = <M extends AnyMachine>(
  step: Step.Step,
  event: unknown
): Exit.Exit<Planned<M>, unknown> => {
  const exit = step.exit
  return exit !== undefined && Exit.isFailure(exit)
    ? Exit.failCause(exit.cause)
    : Exit.succeed({ _tag: "Planned", plan: planOf<M>(step, event), state: step.state })
}

/**
 * Plans one scenario entry after `trace` through its step. A result of work
 * that fails the machine is a `MachineFailure`, because the machine plans no
 * event for it.
 */
export const planEntry = <M extends AnyMachine>(
  machine: ReadyMachine<M>,
  trace: Trace<M>,
  entry: ScenarioEvent<M>
): Effect.Effect<Planned<M> | MachineFailure, RunError<M>, RunServices<M>> => {
  const step = stepOf(machine)
  const state = stateOf(trace)
  if (state.exit !== undefined) {
    // A completed machine takes no further step. Planning an entry after it
    // reports the completion again, as `Machine.plan` does for a final state.
    return Effect.map(
      (Machine.plan as any)(
        machine,
        trace.final,
        Work.isWorkOutcome(entry) ? Work.stale(entry) : entry
      ) as Effect.Effect<EventPlan<M>, RunError<M>, RunServices<M>>,
      (plan): Planned<M> => ({ _tag: "Planned", plan, state })
    )
  }
  if (!Work.isWorkOutcome(entry)) {
    const sent = step.send(state, entry)
    return (Exit.isFailure(sent) ? sent : fromStep<M>(sent.value, undefined)) as Exit.Exit<Planned<M>, RunError<M>>
  }
  const work = Work.find(trace.work, entry)
  if (work === undefined) {
    // Work that no longer runs reports a late result, which changes nothing.
    return Exit.succeed({
      _tag: "Planned",
      plan: {
        event: Work.staleEvent(entry),
        next: trace.final,
        commands: noCommands,
        emittedEvents: noCommands,
        microsteps: noCommands,
        done: false,
        output: undefined
      },
      state
    })
  }
  if (!Work.accepts(work, entry)) {
    return Exit.die(
      new Error(
        `MachineTest expected a ${entry.kind} outcome to name a running ${
          entry.kind === "Elapsed" ? "timer" : "Effect"
        }, but "${entry.path}" runs "${entry.id}" as ${work.kind}`
      )
    )
  }
  const settled = step.settle(state, Work.workOf(work), Work.exitOf(entry))
  if (settled.event === undefined && settled.exit !== undefined && Exit.isFailure(settled.exit)) {
    return Exit.succeed({ _tag: "MachineFailure", cause: settled.exit.cause })
  }
  return fromStep<M>(settled, Work.staleEvent(entry))
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

const extend = <M extends AnyMachine>(
  machine: ReadyMachine<M>,
  trace: Trace<M>,
  event: ScenarioEvent<M>,
  scenario: Scenario<M>,
  planned: Planned<M>
): Trace<M> => {
  const { plan, state } = planned
  const afterConfiguration = rawConfigurationPaths(machine, plan.next)
  const step: TraceStep<M> = {
    index: trace.steps.length,
    before: trace.final,
    beforeConfiguration: trace.finalConfiguration,
    // A result of work keeps the outcome that reported it, so the scenario
    // rebuilt from the steps reproduces the trace.
    event: Work.isWorkOutcome(event) ? event : plan.event,
    plan,
    after: plan.next,
    afterConfiguration
  }
  return record({
    scenario: { ...scenario, events: [...trace.steps.map((step) => step.event), step.event] },
    initial: trace.initial,
    steps: [...trace.steps, step],
    final: plan.next,
    finalConfiguration: afterConfiguration,
    work: state === stateOf(trace) ? trace.work : Work.running(state)
  }, state)
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
  Effect.suspend(() => planEntry(machine, trace, event)).pipe(
    Effect.mapError((cause) => failRun(trace, event, scenario, cause)),
    Effect.map((planned) => planned._tag === "Planned" ? extend(machine, trace, event, scenario, planned) : planned)
  )

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
  // The step resumes from the planned startup state: it lists the work of the
  // active states as `start` does, without planning startup again.
  const resumed = yield* Effect.orDie(stepOf(machine).resume(initial.state))
  let trace: Trace<M> = record({
    scenario: { ...scenario, events: [] },
    initial: initialTrace,
    steps: [],
    final: initial.state,
    finalConfiguration: initialTrace.configuration,
    work: Work.running(resumed.state)
  }, resumed.state)

  for (const event of scenario.events) {
    trace = yield* appendTrace(machine, trace, event, scenario)
  }

  return trace
})
