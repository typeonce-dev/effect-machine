/**
 * Static model analysis and the one-call machine check composed from it,
 * bounded exploration, coverage, and the planner verification laws.
 *
 * @since 0.47.0
 */

import * as Arbitrary from "effect/Arbitrary"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Machine from "../../../Machine.js"
import type {
  AnalysisFinding,
  CheckExplorationLimit,
  CheckFinding,
  CheckOptions,
  CheckReplay,
  CheckReport,
  ExplorationEdge,
  ExplorationNode,
  ExplorationStateContext,
  InitialPlan,
  RunFailure,
  RunningWork,
  RunServices,
  Trace,
  TraceStep,
  WorkOutcome
} from "../../../testing/MachineTest.js"
import * as CapturedInvocation from "../../machine/capturedInvocation.js"
import * as Configuration from "../../machine/configuration.js"
import * as Protocol from "../../machine/protocol.js"
import type { EnsureExecutable } from "../../machine/readiness.js"
import { type ExploredMachineFailure, exploreWith } from "./exploration.js"
import { formatValue } from "./format.js"
import { InvariantError } from "./invariant.js"
import { planEntry } from "./trace.js"
import { VerificationError, verify } from "./verification.js"
import * as Work from "./work.js"

type AnyMachine = Machine.Machine.Any

type ReadyMachine<M extends AnyMachine> =
  & M
  & EnsureExecutable<
    Machine.Machine.States<M>,
    Machine.Machine.UnhandledStates<M>,
    Machine.Machine.OutputStates<M>
  >

const defaultLimits = { maxDepth: 16, maxStates: 256, maxTransitions: 2_048 }

const isDescendant = (path: string, ancestor: string): boolean =>
  ancestor === "" ? path !== "" : path.startsWith(`${ancestor}.`)

const reachableStatePaths = (machine: AnyMachine): ReadonlySet<string> => {
  const nodes = Machine.stateNodes(machine)
  const byPath = new Map<string, (typeof nodes)[number]>(nodes.map((node) => [node.path, node]))
  const definitions = Machine.transitionDefinitions(machine)
  const reached = new Set<string>()
  const entered = new Set<string>()
  const queue: Array<string> = []

  const mark = (path: string): void => {
    let current = byPath.get(path)
    while (current !== undefined) {
      if (!reached.has(current.path)) {
        reached.add(current.path)
        queue.push(current.path)
      }
      current = current.parent === undefined ? undefined : byPath.get(current.parent)
    }
  }
  // A resolver can construct any explicit descendant of a branch target, and a
  // history default any descendant of its owner. Treating those subtrees as
  // entered keeps the analysis conservative: it never reports a live state.
  const enterSubtree = (path: string): void => {
    for (const node of nodes) {
      if (node.path === path || isDescendant(node.path, path)) enter(node.path)
    }
  }
  const enter = (path: string): void => {
    const node = byPath.get(path)
    if (node === undefined) return
    mark(path)
    if (entered.has(path)) return
    entered.add(path)
    if (node.type === "parallel") {
      for (const child of nodes) {
        if (child.parent === path && child.type !== "history" && child.type !== "choice") enter(child.path)
      }
    } else if (node.type === "compound" && node.initial !== undefined) {
      enter(node.initial)
    } else if (node.type === "history" && node.parent !== undefined) {
      enterSubtree(node.parent)
    }
  }

  enter(Machine.initialDefinition(machine).target)
  for (let index = 0; index < queue.length; index++) {
    const source = queue[index]!
    for (const definition of definitions) {
      if (definition.source !== source) continue
      for (const branch of definition.branches) {
        if (branch.target === undefined) continue
        if (branch.type === "branch") enterSubtree(branch.target)
        else enter(branch.target)
      }
    }
  }
  return reached
}

export const analyze = (machine: AnyMachine): ReadonlyArray<AnalysisFinding> => {
  const findings: Array<AnalysisFinding> = []

  const handled = new Set<PropertyKey>()
  for (const { trigger } of Machine.transitionDefinitions(machine)) {
    if (trigger.type === "event") handled.add(trigger.event)
  }
  for (const event of Reflect.ownKeys(machine.events)) {
    if (handled.has(event)) continue
    findings.push({
      law: "events.noHandler",
      severity: "error",
      event: String(event),
      message: `Public event "${String(event)}" has no handler in any state. Handle it, or remove it from the protocol.`
    })
  }

  const nodes = Machine.stateNodes(machine)
  const reached = reachableStatePaths(machine)
  const unreachable = nodes.filter((node) => !reached.has(node.path))
  for (const node of unreachable) {
    // A descendant of an unreachable state adds no new information.
    if (unreachable.some((other) => isDescendant(node.path, other.path))) continue
    findings.push({
      law: "topology.noPathFromInitial",
      severity: "error",
      path: node.path,
      descendants: unreachable.filter((other) => isDescendant(other.path, node.path)).length,
      message: `State "${node.path}" has no declared path from the initial state. ` +
        `Add a transition that targets it, or remove it.`
    })
  }
  return findings
}

interface DerivedEvents {
  readonly events: ReadonlyArray<unknown>
  readonly enumerated: boolean
}

const deriveEvents = (machine: AnyMachine, seed: number, perTag: number) =>
  Effect.gen(function*() {
    const selected = new Map<PropertyKey, Map<string, unknown>>()
    let enumerated = true
    for (const [index, schema] of Protocol.inputEventSchemas(machine).entries()) {
      const samples = yield* Arbitrary.sampleEffect(Arbitrary.schema(schema), {
        count: Math.max(64, perTag * 16),
        seed: seed + index
      })
      for (const sample of samples) {
        const event = sample
        if (Reflect.ownKeys(event).some((key) => key !== "_tag")) enumerated = false
        const values = selected.get(event._tag) ?? new Map<string, unknown>()
        const key = formatValue(event)
        if (!values.has(key) && values.size < perTag) values.set(key, event)
        selected.set(event._tag, values)
      }
    }
    // A union may not sample every member. Report that as incomplete rather than guessing.
    if (Reflect.ownKeys(machine.events).some((tag) => !selected.has(tag))) enumerated = false
    return {
      events: [...selected.values()].flatMap((values) => [...values.values()]),
      enumerated
    } satisfies DerivedEvents
  })

const causeMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  return formatValue(cause)
}

const replayOf = (input: unknown, hasInput: boolean, events: ReadonlyArray<unknown>): CheckReplay =>
  hasInput ? { input, events } : { events }

const planEvidence = (plan: {
  readonly commands: ReadonlyArray<unknown>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly done: boolean
  readonly output: unknown
}, state: unknown): string =>
  formatValue({
    state,
    commands: plan.commands,
    emitted: plan.emittedEvents,
    done: plan.done,
    output: plan.output
  })

const statePaths = (step: { readonly afterConfiguration: ReadonlyArray<string> }): string =>
  step.afterConfiguration.filter((path) => path !== "").join(", ")

const label = (event: unknown): string =>
  Work.isWorkOutcome(event) ? `${event.kind} ${event.id}` : String((event as { readonly _tag: PropertyKey })._tag)

const channelKey = (path: string, id: string, outcome: string): string => JSON.stringify([path, id, outcome])

// Limits for work whose results exploration cannot take, and so for states
// that only those results may lead to.
const hidingLimits: ReadonlyArray<CheckExplorationLimit> = ["effectsWithoutOutcomes", "streams", "logic", "children"]

interface SuppliedOutcomes {
  readonly done: ReadonlyArray<unknown>
  readonly failure: ReadonlyArray<unknown>
}

/** The names of the Effect sources that some state of `machine` invokes. */
const effectSources = (machine: AnyMachine): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const path of machine.stateNodes.byPath.keys()) {
    for (const definition of CapturedInvocation.list(Configuration.getStateConfigByPath(machine, path)?.invoke)) {
      if ("effect" in definition && definition.sourceName !== undefined) names.add(definition.sourceName)
    }
  }
  return names
}

/**
 * Validates the caller's outcomes against the Effect sources the machine
 * invokes. A name that matches none is a finding: its values would never be
 * tried. `undefined` means no outcomes were supplied.
 */
const suppliedOutcomes = (
  machine: AnyMachine,
  outcomes: unknown,
  findings: Array<CheckFinding>
): ReadonlyMap<string, SuppliedOutcomes> | undefined => {
  if (outcomes === undefined) return undefined
  const supplied = new Map<string, SuppliedOutcomes>()
  if (typeof outcomes !== "object" || outcomes === null) {
    findings.push({
      law: "outcomes.invalid",
      severity: "error",
      source: "",
      message: "Outcomes must be a record keyed by Effect source name."
    })
    return supplied
  }
  const invoked = effectSources(machine)
  for (const [source, entry] of Object.entries(outcomes)) {
    if (entry === undefined) continue
    if (!invoked.has(source)) {
      findings.push({
        law: "outcomes.invalid",
        severity: "error",
        source,
        message: `Outcomes are supplied for "${source}", but no state invokes an Effect source with that name. ` +
          `Fix the name, or remove the entry.`
      })
      continue
    }
    const done: unknown = (entry as { readonly done?: unknown }).done ?? []
    const failure: unknown = (entry as { readonly failure?: unknown }).failure ?? []
    if (!Array.isArray(done) || !Array.isArray(failure)) {
      findings.push({
        law: "outcomes.invalid",
        severity: "error",
        source,
        message: `Outcomes for "${source}" must list values in "done" and "failure" arrays.`
      })
      continue
    }
    supplied.set(source, { done, failure })
  }
  return supplied
}

/**
 * Reports each supplied result that failed the machine once, at the first
 * place breadth-first exploration reached it, so its replay is the shortest.
 */
const reportMachineFailures = <M extends AnyMachine>(
  failures: ReadonlyArray<ExploredMachineFailure<M>>,
  findings: Array<CheckFinding>,
  replay: (events: ReadonlyArray<unknown>) => CheckReplay
): void => {
  const seen = new Set<string>()
  for (const failure of failures) {
    const outcome = failure.event as WorkOutcome
    const work = Work.find(failure.trace.work, outcome)
    const key = channelKey(outcome.path, outcome.id, outcome.kind)
    if (seen.has(key)) continue
    seen.add(key)
    const state = outcome.path === "" ? "root" : outcome.path
    const typed = failure.cause.reasons.find(Cause.isFailReason)
    findings.push({
      law: "outcome.failsMachine",
      severity: "error",
      source: work?.source,
      replay: replay([...failure.trace.scenario.events, outcome]),
      message: outcome.kind === "Failure"
        ? `A failure of "${outcome.id}" in "${state}" has no onFailure, so the machine fails with ${
          causeMessage(typed === undefined ? Cause.pretty(failure.cause) : typed.error)
        }. Handle it with onFailure.`
        : `A result of "${outcome.id}" in "${state}" has no onDone, so the machine fails: ${
          causeMessage(Cause.squash(failure.cause))
        }.`
    })
  }
}

export const check = <M extends AnyMachine>(
  machine: ReadyMachine<M>,
  options: CheckOptions<M> = {}
): Effect.Effect<CheckReport, never, RunServices<M>> =>
  Effect.gen(function*() {
    const findings: Array<CheckFinding> = [...analyze(machine)]
    const limits = new Set<CheckExplorationLimit>()
    const seed = options.seed ?? 0
    const hasInput = machine.input !== undefined && machine.input !== Schema.Void

    let input: unknown = (options as { readonly input?: unknown }).input
    if (hasInput && input === undefined) {
      limits.add("sampledInput")
      const sampled = yield* Effect.exit(Arbitrary.sampleEffect(Arbitrary.schema(machine.input), { count: 1, seed }))
      if (Exit.isFailure(sampled)) {
        findings.push({
          law: "schema.underivable",
          severity: "error",
          message: `Could not derive machine input from its schema: ${
            Cause.pretty(sampled.cause)
          }. Pass input explicitly.`
        })
        return finish(machine, findings, limits, undefined)
      }
      input = sampled.value[0]
    }

    let events: ReadonlyArray<unknown>
    if (options.events !== undefined) {
      limits.add("customEvents")
      events = options.events
    } else {
      const derived = yield* Effect.exit(deriveEvents(machine, seed, options.eventSamples ?? 3))
      if (Exit.isFailure(derived)) {
        findings.push({
          law: "schema.underivable",
          severity: "error",
          message: `Could not derive events from their schemas: ${Cause.pretty(derived.cause)}. Pass events explicitly.`
        })
        return finish(machine, findings, limits, undefined)
      }
      if (!derived.value.enumerated) limits.add("sampledEvents")
      events = derived.value.events
    }
    if (options.stateKey !== undefined) limits.add("customStateKey")

    const supplied = suppliedOutcomes(machine, (options as { readonly outcomes?: unknown }).outcomes, findings)
    if (supplied !== undefined) limits.add("customOutcomes")

    // Which results exploration offered, as `path`, `id`, and outcome channel.
    const offered = new Set<string>()
    let unofferedResults = false
    const offers = (running: ReadonlyArray<RunningWork>): ReadonlyArray<WorkOutcome> => {
      const results: Array<WorkOutcome> = []
      for (const work of running) {
        switch (work.kind) {
          case "Timer":
            results.push(Work.elapsed(work))
            offered.add(channelKey(work.path, work.id, "done"))
            break
          case "Effect": {
            const values = work.source === undefined ? undefined : supplied?.get(work.source)
            if (values === undefined) {
              limits.add("effectsWithoutOutcomes")
              break
            }
            for (const output of values.done) results.push(Work.done(work, output))
            for (const error of values.failure) results.push(Work.failure(work, error))
            if (values.done.length > 0) offered.add(channelKey(work.path, work.id, "done"))
            if (values.failure.length > 0) offered.add(channelKey(work.path, work.id, "failure"))
            // A handled channel with no value supplied may hide the states it leads to.
            const handled = Work.channels(work)
            if ((handled.done && values.done.length === 0) || (handled.failure && values.failure.length === 0)) {
              unofferedResults = true
            }
            break
          }
          case "Stream":
            limits.add("streams")
            break
          case "Logic":
            limits.add("logic")
            break
          case "Child":
            limits.add("children")
            break
        }
      }
      return results
    }

    // A node is its logical state and the work still running in it: a state
    // whose work has ended no longer offers that work's results.
    const logicalKey = options.stateKey ?? (({ snapshot }: { readonly snapshot: unknown }) => formatValue(snapshot))
    const keys = new Map<unknown, Map<string, number>>()
    let nextKey = 0
    const stateKey = (context: ExplorationStateContext<M>): number => {
      const logical = logicalKey(context)
      const running = formatValue(context.trace.work.map((work) => [work.path, work.id]))
      let byWork = keys.get(logical)
      if (byWork === undefined) keys.set(logical, byWork = new Map())
      let key = byWork.get(running)
      if (key === undefined) byWork.set(running, key = nextKey++)
      return key
    }

    const machineFailures: Array<ExploredMachineFailure<M>> = []
    // The scenario being planned, which a defect in a callback reproduces.
    let planning: ReadonlyArray<unknown> = []
    const replay = (replayEvents: ReadonlyArray<unknown>) => replayOf(input, hasInput, replayEvents)
    const explored = yield* Effect.exit(
      (exploreWith as any)(machine, {
        ...(hasInput ? { input } : {}),
        limits: { ...defaultLimits, ...options.limits },
        invariants: options.invariants,
        stateKey,
        // A completed machine accepts no further events and runs no work.
        events: ({ trace }: { readonly trace: Trace<M> }) =>
          (trace.steps.at(-1)?.plan ?? trace.initial.plan).done ? [] : [...events, ...offers(trace.work)]
      }, {
        onMachineFailure: (failure: ExploredMachineFailure<M>) => machineFailures.push(failure),
        onPlan: (scenario: { readonly events: ReadonlyArray<unknown> }) => {
          planning = scenario.events
        }
      }) as Effect.Effect<any, RunFailure<unknown, M> | InvariantError<M>, RunServices<M>>
    )
    reportMachineFailures(machineFailures, findings, replay)

    if (Exit.isFailure(explored)) {
      const failure = Cause.findErrorOption(explored.cause)
      if (failure._tag === "Some" && failure.value instanceof InvariantError) {
        for (const violation of failure.value.violations) {
          findings.push({
            law: "invariant.violated",
            severity: "error",
            invariant: violation.invariant,
            replay: replay(failure.value.trace.scenario.events),
            message: `Invariant "${violation.invariant}" failed: ${violation.message}`
          })
        }
      } else if (failure._tag === "Some") {
        const runFailure = failure.value as RunFailure<unknown, M>
        findings.push({
          law: "planning.failed",
          severity: "error",
          replay: replay(runFailure.scenario.events),
          message: `Planning failed: ${causeMessage(runFailure.cause)}`
        })
      } else {
        if (Cause.hasInterruptsOnly(explored.cause)) return yield* Effect.interrupt
        findings.push({
          law: "planning.failed",
          severity: "error",
          replay: replay(planning),
          message: `A planning callback threw: ${Cause.pretty(explored.cause)}`
        })
      }
      return finish(machine, findings, limits, undefined)
    }

    const exploration = explored.value
    if (exploration.completeness._tag === "Truncated") {
      for (const reason of exploration.completeness.reasons) limits.add(reason)
    }

    // Planning must be a function of the snapshot and the event. Plan each
    // transition again and compare, because a syntax rule cannot see through a
    // helper that reads the clock or randomness.
    const initialTrace = (exploration.nodes[0] as ExplorationNode<M>).trace
    const plannedAgain = yield* Effect.exit(
      (hasInput
        ? (Machine.planInitial as any)(machine, input)
        : (Machine.planInitial as any)(machine)) as Effect.Effect<
          InitialPlan<M>,
          unknown,
          RunServices<M>
        >
    )
    if (
      Exit.isSuccess(plannedAgain) &&
      planEvidence(plannedAgain.value, plannedAgain.value.state) !==
        planEvidence(initialTrace.initial.plan, initialTrace.initial.plan.state)
    ) {
      findings.push({
        law: "planning.deterministic",
        severity: "error",
        source: "initial",
        replay: replay([]),
        message: "Startup planned differently from the same input. " +
          "Do not read the clock, randomness, or external state in planning callbacks."
      })
    }

    const seen = new Set<string>()
    const graph = exploration.graph
    for (
      const edge of graph.edges.values() as Iterable<{ readonly source: number; readonly data: ExplorationEdge<M> }>
    ) {
      const source = graph.nodes.get(edge.source) as ExplorationNode<M>
      const step: TraceStep<M> = edge.data.step
      const location = `${statePaths({ afterConfiguration: step.beforeConfiguration })}:${label(step.event)}`
      const events = [...source.trace.scenario.events, step.event]

      const verified = yield* Effect.exit(
        verify(machine, {
          ...source.trace,
          scenario: { ...source.trace.scenario, events },
          steps: [...source.trace.steps, step],
          final: step.after,
          finalConfiguration: step.afterConfiguration
        })
      )
      if (Exit.isFailure(verified)) {
        const failure = Cause.findErrorOption(verified.cause)
        if (failure._tag === "Some" && failure.value instanceof VerificationError) {
          for (const violation of failure.value.violations) {
            findings.push({
              law: "planning.verification",
              severity: "error",
              verificationLaw: violation.law,
              replay: replay(events),
              message: violation.message
            })
          }
        }
      }

      // The same entry after the same trace, through the same step.
      const again = yield* Effect.exit(planEntry(machine, source.trace, step.event))
      if (
        Exit.isSuccess(again) && again.value._tag === "Planned" &&
        planEvidence(again.value.plan, again.value.plan.next) !== planEvidence(step.plan, step.after) &&
        !seen.has(location)
      ) {
        seen.add(location)
        findings.push({
          law: "planning.deterministic",
          severity: "error",
          source: location,
          replay: replay(events),
          message:
            `Planning "${location}" produced a different result from the same snapshot and ${
              Work.isWorkOutcome(step.event) ? "result" : "event"
            }. ` +
            `Do not read the clock, randomness, or external state in planning callbacks.`
        })
      }
    }

    // Exploration takes a result of work only when it has one: a timer always,
    // an Effect when its results were supplied. A transition for a result it
    // never offered is not reported, and neither is one from a state that only
    // such a result leads to: `limits` already reports that gap, and a warning
    // for each such transition would only tell the reader to remove live code.
    const visited = new Set<string>()
    for (const node of exploration.nodes as ReadonlyArray<ExplorationNode<M>>) {
      for (const path of node.configuration as ReadonlyArray<string>) visited.add(path)
    }
    const workHidesStates = unofferedResults || hidingLimits.some((limit) => limits.has(limit))
    for (const miss of exploration.transitionCoverage.branches.misses) {
      const trigger = miss.trigger
      if (trigger.type === "invoke") {
        if (!offered.has(channelKey(miss.source, trigger.id, trigger.outcome))) continue
      } else if (workHidesStates && !visited.has(miss.source)) continue
      const target = miss.branch.target === undefined ? "" : ` to "${miss.branch.target}"`
      findings.push({
        law: "transition.notCovered",
        severity: "warning",
        source: miss.source,
        trigger,
        target: miss.branch.target,
        ...(miss.branchKey === undefined ? {} : { branchKey: miss.branchKey }),
        message: trigger.type === "invoke"
          ? `Exploration never took the ${trigger.outcome === "done" ? "onDone" : "onFailure"} transition of ` +
            `"${trigger.id}" from "${miss.source}"${target}. ` +
            `Supply a result that takes it, or remove it if it cannot happen.`
          : `Exploration never took the ${trigger.type === "event" ? `"${String(trigger.event)}"` : trigger.type} ` +
            `transition from "${miss.source}"${target}. ` +
            `Cover it with a scenario, or remove it if it cannot happen.`
      })
    }

    return finish(machine, findings, limits, exploration)
  })

const finish = (
  machine: AnyMachine,
  findings: ReadonlyArray<CheckFinding>,
  limits: ReadonlySet<CheckExplorationLimit>,
  exploration: {
    readonly stats: { readonly states: number; readonly plannedTransitions: number }
    readonly transitionCoverage: {
      readonly definitions: { readonly total: number; readonly hit: number }
      readonly branches: { readonly total: number; readonly hit: number }
    }
  } | undefined
): CheckReport => ({
  machine: machine.id ?? "Machine",
  ok: findings.every((finding) => finding.severity !== "error"),
  exploration: exploration !== undefined && limits.size === 0 ? "exhaustive" : "bounded",
  limits: [...limits],
  stats: exploration === undefined
    ? { states: 0, plannedTransitions: 0, transitions: { total: 0, hit: 0 }, branches: { total: 0, hit: 0 } }
    : {
      states: exploration.stats.states,
      plannedTransitions: exploration.stats.plannedTransitions,
      transitions: {
        total: exploration.transitionCoverage.definitions.total,
        hit: exploration.transitionCoverage.definitions.hit
      },
      branches: {
        total: exploration.transitionCoverage.branches.total,
        hit: exploration.transitionCoverage.branches.hit
      }
    },
  findings
})

const formatReplayEvent = (event: unknown): string => {
  if (!Work.isWorkOutcome(event)) return formatValue(event)
  const work = `${event.path === "" ? "root" : event.path}#${event.id}`
  switch (event.kind) {
    case "Done":
      return `done ${work} ${formatValue(event.output)}`
    case "Failure":
      return `failure ${work} ${formatValue(event.error)}`
    case "Elapsed":
      return `elapsed ${work}`
  }
}

// One step per item, in order, so a result of work reads apart from the events.
const formatReplay = (replay: CheckReplay): string =>
  [
    ...("input" in replay ? [`input ${formatValue(replay.input)}`] : []),
    ...replay.events.map(formatReplayEvent)
  ].join(" -> ") || "startup"

const formatFinding = (finding: CheckFinding): string =>
  `  ${finding.severity === "error" ? "error" : "warn "} ${finding.law}: ${finding.message}` +
  ("replay" in finding ? `\n        replay: ${formatReplay(finding.replay)}` : "")

export const formatReport = (report: CheckReport): string =>
  [
    `${report.ok ? "PASS" : "FAIL"} ${report.machine}: ${report.stats.states} states, ` +
    `${report.stats.branches.hit}/${report.stats.branches.total} branches, ${report.exploration}` +
    (report.limits.length === 0 ? "" : ` (${report.limits.join(", ")})`),
    ...report.findings.map(formatFinding)
  ].join("\n")
