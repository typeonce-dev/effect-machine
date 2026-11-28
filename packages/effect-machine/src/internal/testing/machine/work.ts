/**
 * The public view of the work that a planner trace runs, and of the results
 * that a scenario reports for it.
 *
 * Which work runs is decided by `Machine.toStep` alone: a trace reads it from
 * the state of its step. This module only maps the step's work to
 * `RunningWork`, and a `WorkOutcome` to the `Exit` that the step settles. It
 * never evaluates a source or an input mapper.
 *
 * @since 0.48.0
 */

import * as Exit from "effect/Exit"
import type { InvocationEvent as LifecycleEvent } from "../../../Machine.js"
import type { RunningWork, WorkOutcome } from "../../../testing/MachineTest.js"
import * as InvocationEvent from "../../machine/invocationEvent.js"
import type * as InvocationResolution from "../../machine/invocationResolution.js"
import * as Step from "../../machine/step.js"

/** @internal */
export const WorkOutcomeTypeId: unique symbol = Symbol.for("effect/MachineTest/WorkOutcome")

/** @internal */
export const isWorkOutcome = (value: unknown): value is WorkOutcome =>
  typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === WorkOutcomeTypeId

// The step's work stays out of the public value, so formatting, JSON, and
// structural comparison of a trace see only the public fields. Each piece of
// work keeps one public value for as long as it runs.
const views = new WeakMap<Step.Work, RunningWork>()
const works = new WeakMap<RunningWork, Step.Work>()

const viewOf = (work: Step.Work): RunningWork => {
  let view = views.get(work)
  if (view === undefined) {
    view = Object.freeze({ path: work.path, id: work.id, source: work.source, kind: work._tag })
    views.set(work, view)
    works.set(view, work)
  }
  return view
}

const noWork: ReadonlyArray<never> = []

/** The public view of the work that a step state runs, in start order. */
export const running = (state: Step.State): ReadonlyArray<RunningWork> =>
  state.running.length === 0 ? noWork : state.running.map(viewOf)

/** The step's work behind a public view. */
export const workOf = (work: RunningWork): Step.Work => works.get(work)!

/** The running work that `outcome` reports for, if it still runs. */
export const find = (running: ReadonlyArray<RunningWork>, outcome: WorkOutcome): RunningWork | undefined =>
  running.find((work) => work.path === outcome.path && work.id === outcome.id)

/** The outcome channels that `work` declares a transition for. */
export const channels = (work: RunningWork): InvocationResolution.OutcomeChannels =>
  workOf(work)[Step.WorkTypeId].channels

/** Whether a result of this kind can come from `work`. */
export const accepts = (work: RunningWork, outcome: WorkOutcome): boolean =>
  outcome.kind === "Elapsed" ? work.kind === "Timer" : work.kind === "Effect"

/** How the work ended, as its host reports it to the step. */
export const exitOf = (outcome: WorkOutcome): Exit.Exit<unknown, unknown> => {
  switch (outcome.kind) {
    case "Done":
      return Exit.succeed(outcome.output)
    case "Elapsed":
      // A timer completes with `undefined` once its duration has elapsed.
      return Exit.void
    case "Failure":
      return Exit.fail(outcome.error)
  }
}

/**
 * The message of a result whose work no longer runs. The planner selects no
 * transition for it, as every host ignores a late result.
 */
export const stale = (outcome: WorkOutcome): InvocationEvent.InvocationEvent => {
  const generation: InvocationEvent.Generation = { current: false }
  return outcome.kind === "Failure"
    ? InvocationEvent.failure(outcome.path, outcome.id, generation, outcome.error)
    : InvocationEvent.done(outcome.path, outcome.id, generation, outcome.kind === "Done" ? outcome.output : undefined)
}

/** The event that transitions would receive for a late result. */
export const staleEvent = (outcome: WorkOutcome): LifecycleEvent => InvocationEvent.toLifecycleEvent(stale(outcome))

/** @internal */
export const done = (work: RunningWork, output: unknown): WorkOutcome =>
  Object.freeze({ _tag: WorkOutcomeTypeId, kind: "Done", path: work.path, id: work.id, output })

/** @internal */
export const failure = (work: RunningWork, error: unknown): WorkOutcome =>
  Object.freeze({ _tag: WorkOutcomeTypeId, kind: "Failure", path: work.path, id: work.id, error })

/** @internal */
export const elapsed = (work: RunningWork): WorkOutcome =>
  Object.freeze({ _tag: WorkOutcomeTypeId, kind: "Elapsed", path: work.path, id: work.id })
