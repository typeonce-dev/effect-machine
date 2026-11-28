/**
 * The work that runs while a planner trace stays in a state, and the results
 * that a scenario reports for it.
 *
 * Which work runs follows the rules of every host: work starts when its state
 * is entered, stops when its state is exited, and ends once per entry. The
 * stop and start order is the one of `Machine.toStep`, through the same
 * host-neutral modules. Nothing here evaluates a source: a trace never runs
 * work, it only reports a result for work that runs.
 *
 * @since 0.48.0
 */

import * as Cause from "effect/Cause"
import type { Machine, MachineTarget } from "../../../Machine.js"
import type { RunningWork, WorkOutcome } from "../../../testing/MachineTest.js"
import * as CapturedInvocation from "../../machine/capturedInvocation.js"
import * as Configuration from "../../machine/configuration.js"
import * as InvocationChanges from "../../machine/invocationChanges.js"
import * as InvocationEvent from "../../machine/invocationEvent.js"
import * as InvocationOutcome from "../../machine/invocationOutcome.js"
import * as InvocationResolution from "../../machine/invocationResolution.js"

/** @internal */
export const WorkOutcomeTypeId: unique symbol = Symbol.for("effect/MachineTest/WorkOutcome")

/** @internal */
export const isWorkOutcome = (value: unknown): value is WorkOutcome =>
  typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === WorkOutcomeTypeId

// The resolved invocation stays out of the public value, so formatting, JSON,
// and structural comparison of a trace see only the public fields.
const invocations = new WeakMap<RunningWork, InvocationResolution.ResolvedInvocation>()

const kinds = {
  Effect: "Effect",
  Timer: "Timer",
  Stream: "Stream",
  Logic: "Logic",
  Child: "Child"
} as const

const unavailable = (): never => {
  throw new Error("MachineTest does not evaluate invoked sources")
}

// Resolution builds the context that input mappers receive, but a trace never
// calls a mapper, so these capabilities are never read.
const capabilities: InvocationResolution.InvocationCapabilities = {
  self: Object.freeze({}) as MachineTarget<any>,
  parent: undefined,
  children: { spawn: unavailable, sendTo: unavailable, stop: unavailable }
}

const noWork: ReadonlyArray<never> = []

const describe = (groups: ReadonlyArray<InvocationResolution.InvocationGroup>): ReadonlyArray<RunningWork> => {
  if (groups.length === 0) return noWork
  const started: Array<RunningWork> = []
  for (const group of groups) {
    for (const invocation of group.invocations) {
      const work: RunningWork = Object.freeze({
        path: invocation.path,
        id: invocation.id,
        source: invocation._tag === "Child" ? undefined : invocation.sourceName,
        kind: kinds[invocation._tag]
      })
      invocations.set(work, invocation)
      started.push(work)
    }
  }
  return started
}

/** The work a machine runs once it has started in `snapshot`. */
export const initial = (
  machine: Machine.Any,
  plan: { readonly state: Machine.Snapshot<any>; readonly done: boolean }
): ReadonlyArray<RunningWork> => {
  if (plan.done) return noWork
  const configuration = Configuration.normalizeConfigurationSync(machine, plan.state)
  return describe(
    InvocationResolution.resolveEntries(
      machine,
      configuration,
      InvocationResolution.initialEntries(machine, configuration),
      capabilities
    )
  )
}

/** The work that runs after a step planned on a state that ran `running`. */
export const next = (
  machine: Machine.Any,
  running: ReadonlyArray<RunningWork>,
  plan: {
    readonly next: Machine.Snapshot<any>
    readonly done: boolean
    readonly microsteps: ReadonlyArray<{
      readonly event: Machine.LifecycleEvent<any>
      readonly exitPaths: ReadonlyArray<string>
      readonly entryPaths: ReadonlyArray<string>
      readonly changed: boolean
    }>
  }
): ReadonlyArray<RunningWork> => {
  if (plan.done) return noWork
  const changes = InvocationChanges.fromMicrosteps(plan.microsteps)
  const { kept } = InvocationChanges.partition(running, changes)
  if (changes === undefined) return kept
  const started = describe(
    InvocationResolution.resolveEntries(
      machine,
      Configuration.normalizeConfigurationSync(machine, plan.next),
      InvocationChanges.entries(changes),
      capabilities
    )
  )
  return started.length === 0 ? kept : [...kept, ...started]
}

/** The running work that `outcome` reports for, if it still runs. */
export const find = (running: ReadonlyArray<RunningWork>, outcome: WorkOutcome): RunningWork | undefined =>
  running.find((work) => work.path === outcome.path && work.id === outcome.id)

/** The outcome channels that `work` declares a transition for. */
export const channels = (work: RunningWork): InvocationResolution.OutcomeChannels => invocations.get(work)!.channels

/** Whether a result of this kind can come from `work`. */
export const accepts = (work: RunningWork, outcome: WorkOutcome): boolean =>
  outcome.kind === "Elapsed" ? work.kind === "Timer" : work.kind === "Effect"

const outcomeOf = (outcome: WorkOutcome): InvocationOutcome.Outcome => {
  switch (outcome.kind) {
    case "Done":
      return { _tag: "Done", output: outcome.output }
    case "Elapsed":
      // A timer completes with `undefined` once its duration has elapsed.
      return { _tag: "Done", output: undefined }
    case "Failure":
      return { _tag: "Failure", error: outcome.error, cause: Cause.fail(outcome.error) }
  }
}

/**
 * What `outcome` means to the machine that runs `work`, decided as every host
 * decides it. The work is current, because it runs.
 */
export const decide = (work: RunningWork, outcome: WorkOutcome): InvocationOutcome.Decision =>
  InvocationOutcome.decide(invocations.get(work)!, { current: true }, outcomeOf(outcome))

/**
 * The message a host would plan for `outcome` once its work is no longer
 * current. The planner selects no transition for it.
 */
export const stale = (outcome: WorkOutcome): InvocationEvent.InvocationEvent => {
  const generation: InvocationEvent.Generation = { current: false }
  return outcome.kind === "Failure"
    ? InvocationEvent.failure(outcome.path, outcome.id, generation, outcome.error)
    : InvocationEvent.done(outcome.path, outcome.id, generation, outcome.kind === "Done" ? outcome.output : undefined)
}

/**
 * The message a host plans for `outcome` reported after `running`: the
 * delivered event while the work runs and handles it, or a stale one.
 * `undefined` when the outcome fails the machine.
 */
export const message = (running: ReadonlyArray<RunningWork>, outcome: WorkOutcome): unknown => {
  const work = find(running, outcome)
  if (work === undefined || !accepts(work, outcome)) return stale(outcome)
  const decision = decide(work, outcome)
  return decision._tag === "Deliver" ? decision.event : decision._tag === "Ignore" ? stale(outcome) : undefined
}

/** The names of the Effect sources that some state of `machine` invokes. */
export const effectSources = (machine: Machine.Any): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const path of machine.stateNodes.byPath.keys()) {
    for (const definition of CapturedInvocation.list(Configuration.getStateConfigByPath(machine, path)?.invoke)) {
      if ("effect" in definition && definition.sourceName !== undefined) names.add(definition.sourceName)
    }
  }
  return names
}

/** @internal */
export const done = (work: RunningWork, output: unknown): WorkOutcome =>
  Object.freeze({ _tag: WorkOutcomeTypeId, kind: "Done", path: work.path, id: work.id, output })

/** @internal */
export const failure = (work: RunningWork, error: unknown): WorkOutcome =>
  Object.freeze({ _tag: WorkOutcomeTypeId, kind: "Failure", path: work.path, id: work.id, error })

/** @internal */
export const elapsed = (work: RunningWork): WorkOutcome =>
  Object.freeze({ _tag: WorkOutcomeTypeId, kind: "Elapsed", path: work.path, id: work.id })
