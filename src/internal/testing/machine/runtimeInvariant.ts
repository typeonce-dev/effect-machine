/**
 * User-defined semantic invariants over retained causal runtime evidence.
 *
 * @since 4.0.0
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Machine from "../../../Machine.js"
import type {
  CausalRuntimeEvidence,
  InvariantOptions,
  InvariantOutcome,
  PlannerRuntimeAgreementViolation,
  RuntimeCommandInvariant,
  RuntimeCommandInvariantContext,
  RuntimeInvariant,
  RuntimeInvariantBuilder,
  RuntimeInvariantCheckResult,
  RuntimeInvariantRecord,
  RuntimeInvariantReport,
  RuntimeInvariantScope,
  RuntimeInvariantTranscript,
  RuntimeInvariantViolation,
  RuntimeSnapshotInvariant,
  RuntimeSnapshotInvariantContext,
  RuntimeSnapshotInvariantOptions,
  RuntimeSnapshotObservation,
  RuntimeTranscriptInvariant,
  RuntimeTranscriptInvariantContext
} from "../../../testing/MachineTest.js"

type AnyMachine = Machine.Machine.Any

const validateName = (name: string): void => {
  if (name.trim().length === 0) {
    throw new Error("MachineTest.runtimeInvariants expected name to be a non-empty string")
  }
}

const validateRequirement = <Context>(options: InvariantOptions<Context>): void => {
  const minimum = options.require?.minObservations
  if (minimum !== undefined && (!Number.isSafeInteger(minimum) || minimum < 0)) {
    throw new Error("MachineTest.runtimeInvariants expected minObservations to be a non-negative safe integer")
  }
}

const snapshotInvariant = <M extends AnyMachine>(
  name: string,
  check: (context: RuntimeSnapshotInvariantContext<M>) => InvariantOutcome,
  options: RuntimeSnapshotInvariantOptions<M> = {}
): RuntimeSnapshotInvariant<M> => {
  validateName(name)
  validateRequirement(options)
  return Object.freeze({
    _tag: "RuntimeSnapshotInvariant" as const,
    name,
    observe: options.observe ?? "settled",
    check,
    ...(options.when === undefined ? {} : { when: options.when }),
    ...(options.require === undefined ? {} : { require: Object.freeze({ ...options.require }) })
  })
}

const commandInvariant = <M extends AnyMachine>(
  name: string,
  check: (context: RuntimeCommandInvariantContext<M>) => InvariantOutcome,
  options: InvariantOptions<RuntimeCommandInvariantContext<M>> = {}
): RuntimeCommandInvariant<M> => {
  validateName(name)
  validateRequirement(options)
  return Object.freeze({
    _tag: "RuntimeCommandInvariant" as const,
    name,
    check,
    ...(options.when === undefined ? {} : { when: options.when }),
    ...(options.require === undefined ? {} : { require: Object.freeze({ ...options.require }) })
  })
}

const transcriptInvariant = <M extends AnyMachine>(
  name: string,
  check: (context: RuntimeTranscriptInvariantContext<M>) => InvariantOutcome,
  options: InvariantOptions<RuntimeTranscriptInvariantContext<M>> = {}
): RuntimeTranscriptInvariant<M> => {
  validateName(name)
  validateRequirement(options)
  return Object.freeze({
    _tag: "RuntimeTranscriptInvariant" as const,
    name,
    check,
    ...(options.when === undefined ? {} : { when: options.when }),
    ...(options.require === undefined ? {} : { require: Object.freeze({ ...options.require }) })
  })
}

export const runtimeInvariants = <M extends AnyMachine>(_machine: M): RuntimeInvariantBuilder<M> =>
  Object.freeze({
    snapshot: snapshotInvariant,
    command: commandInvariant,
    transcript: transcriptInvariant
  })

export class RuntimeInvariantError<M extends AnyMachine = AnyMachine> extends Data.TaggedError(
  "MachineTestRuntimeInvariantError"
)<{
  readonly transcript: RuntimeInvariantTranscript<M>
  readonly violations: ReadonlyArray<RuntimeInvariantViolation<M>>
  readonly report: RuntimeInvariantReport
}> {}

const normalizeTranscript = <M extends AnyMachine, Error, Output>(
  transcript: CausalRuntimeEvidence<M, Error, Output>
): RuntimeInvariantTranscript<M> => ({
  commands: transcript.commands,
  initial: transcript.initial as RuntimeInvariantTranscript<M>["initial"],
  records: transcript.records.map(({ actual, command, index }) => ({
    index,
    command,
    result: actual.result,
    snapshot: actual.snapshot as RuntimeInvariantRecord<M>["snapshot"],
    awaited: actual.awaited as RuntimeInvariantRecord<M>["awaited"]
  })),
  final: transcript.final as RuntimeInvariantTranscript<M>["final"]
})

interface Observation<M extends AnyMachine, Context> {
  readonly context: Context
  readonly observationIndex?: number
  readonly commandIndex: number | undefined
  readonly awaitedIndex?: number
  readonly phase?: RuntimeSnapshotObservation
  readonly command?: RuntimeInvariantRecord<M>["command"]
}

const snapshotObservations = <M extends AnyMachine>(
  machine: M,
  transcript: RuntimeInvariantTranscript<M>,
  invariant: RuntimeSnapshotInvariant<M>
): ReadonlyArray<Observation<M, RuntimeSnapshotInvariantContext<M>>> => {
  const observations: Array<Observation<M, RuntimeSnapshotInvariantContext<M>>> = []
  let observationIndex = 0
  const add = (
    snapshot: RuntimeInvariantTranscript<M>["initial"],
    phase: RuntimeSnapshotObservation,
    record?: RuntimeInvariantRecord<M>,
    awaitedIndex?: number
  ): void => {
    const context: RuntimeSnapshotInvariantContext<M> = {
      machine,
      transcript,
      snapshot,
      observationIndex,
      phase,
      commandIndex: record?.index,
      awaitedIndex,
      command: record?.command,
      result: record?.result
    }
    observations.push({
      context,
      observationIndex,
      commandIndex: record?.index,
      ...(awaitedIndex === undefined ? {} : { awaitedIndex }),
      phase,
      ...(record === undefined ? {} : { command: record.command })
    })
    observationIndex += 1
  }

  if (invariant.observe === "final") {
    add(transcript.final, "final")
    return observations
  }

  if (invariant.observe === "settled" || invariant.observe === "all") {
    add(transcript.initial, "initial")
    for (const record of transcript.records) add(record.snapshot, "command", record)
  }

  if (invariant.observe === "awaited" || invariant.observe === "all") {
    for (const record of transcript.records) {
      record.awaited.forEach((snapshot, awaitedIndex) => add(snapshot, "awaited", record, awaitedIndex))
    }
  }

  return observations
}

const commandObservations = <M extends AnyMachine>(
  machine: M,
  transcript: RuntimeInvariantTranscript<M>
): ReadonlyArray<Observation<M, RuntimeCommandInvariantContext<M>>> =>
  transcript.records.map((record, index) => ({
    context: {
      machine,
      transcript,
      record,
      previous: transcript.records[index - 1],
      index: record.index,
      command: record.command,
      result: record.result,
      snapshot: record.snapshot,
      awaited: record.awaited
    },
    commandIndex: record.index,
    command: record.command
  }))

const transcriptObservations = <M extends AnyMachine>(
  machine: M,
  transcript: RuntimeInvariantTranscript<M>
): ReadonlyArray<Observation<M, RuntimeTranscriptInvariantContext<M>>> => [{
  context: { machine, transcript },
  commandIndex: undefined
}]

const scopeOf = <M extends AnyMachine>(invariant: RuntimeInvariant<M>): RuntimeInvariantScope => {
  switch (invariant._tag) {
    case "RuntimeSnapshotInvariant":
      return "snapshot"
    case "RuntimeCommandInvariant":
      return "command"
    case "RuntimeTranscriptInvariant":
      return "transcript"
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
  scope: RuntimeInvariantScope,
  observations: ReadonlyArray<Observation<M, Context>>
): {
  readonly check: RuntimeInvariantCheckResult
  readonly violations: ReadonlyArray<RuntimeInvariantViolation<M>>
} => {
  let observed = 0
  let failures = 0
  const violations: Array<RuntimeInvariantViolation<M>> = []

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
      commandIndex: observation.commandIndex,
      ...(observation.awaitedIndex === undefined ? {} : { awaitedIndex: observation.awaitedIndex }),
      ...(observation.phase === undefined ? {} : { phase: observation.phase }),
      ...(observation.command === undefined ? {} : { command: observation.command }),
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
      commandIndex: undefined,
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

export const checkRuntimeInvariants = <M extends AnyMachine, Error, Output>(
  machine: M,
  evidence: CausalRuntimeEvidence<M, Error, Output>,
  invariants: ReadonlyArray<RuntimeInvariant<M>>
): Effect.Effect<RuntimeInvariantReport, RuntimeInvariantError<M>> =>
  Effect.suspend(() => {
    const transcript = normalizeTranscript(evidence)
    const checks: Array<RuntimeInvariantCheckResult> = []
    const violations: Array<RuntimeInvariantViolation<M>> = []

    for (const invariant of invariants) {
      const scope = scopeOf(invariant)
      const result = invariant._tag === "RuntimeSnapshotInvariant"
        ? evaluateInvariant(invariant, scope, snapshotObservations(machine, transcript, invariant))
        : invariant._tag === "RuntimeCommandInvariant"
        ? evaluateInvariant(invariant, scope, commandObservations(machine, transcript))
        : evaluateInvariant(invariant, scope, transcriptObservations(machine, transcript))
      checks.push(result.check)
      violations.push(...result.violations)
    }

    const report: RuntimeInvariantReport = { checks }
    return violations.length === 0
      ? Effect.succeed(report)
      : Effect.fail(new RuntimeInvariantError({ transcript, violations, report }))
  })

export const assertRuntimeInvariants = <M extends AnyMachine, Error, Output>(
  machine: M,
  transcript: CausalRuntimeEvidence<M, Error, Output>,
  invariants: ReadonlyArray<RuntimeInvariant<M>>
): Effect.Effect<void, RuntimeInvariantError<M>> =>
  checkRuntimeInvariants(machine, transcript, invariants).pipe(Effect.asVoid)

export class PlannerRuntimeAgreementError<M extends AnyMachine = AnyMachine> extends Data.TaggedError(
  "MachineTestPlannerRuntimeAgreementError"
)<{
  readonly evidence: CausalRuntimeEvidence<M, unknown, unknown>
  readonly violations: ReadonlyArray<PlannerRuntimeAgreementViolation<M>>
}> {}

const fingerprint = (value: unknown): string => {
  const active = new WeakSet<object>()
  const visit = (current: unknown): unknown => {
    if (current === undefined) return ["undefined"]
    if (current === null || typeof current === "boolean" || typeof current === "string") return current
    if (typeof current === "number") {
      if (Number.isNaN(current)) return ["number", "NaN"]
      if (Object.is(current, -0)) return ["number", "-0"]
      return current
    }
    if (typeof current === "bigint") return ["bigint", String(current)]
    if (typeof current === "symbol") return ["symbol", Symbol.keyFor(current) ?? String(current)]
    if (typeof current === "function") return ["function", current.name]
    if (active.has(current)) return ["circular"]
    active.add(current)
    let result: unknown
    if (current instanceof Date) {
      result = ["date", Number.isNaN(current.getTime()) ? "Invalid Date" : current.toISOString()]
    } else if (current instanceof Error) {
      result = [
        "error",
        current.name,
        current.message,
        Object.keys(current).sort().map((key) => [key, visit((current as unknown as Record<string, unknown>)[key])])
      ]
    } else if (ArrayBuffer.isView(current)) {
      result = [current.constructor.name, Array.from(current as unknown as ArrayLike<number>)]
    } else if (Array.isArray(current)) {
      result = current.map(visit)
    } else if (current instanceof Map) {
      result = [
        "map",
        Array.from(current, ([key, item]) => [visit(key), visit(item)]).sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        )
      ]
    } else if (current instanceof Set) {
      result = [
        "set",
        Array.from(current, visit).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      ]
    } else {
      result = Object.keys(current).sort().map((key) => [key, visit((current as Record<string, unknown>)[key])])
    }
    active.delete(current)
    return result
  }
  return JSON.stringify(visit(value))
}

const projection = (plan: {
  readonly next: unknown
  readonly commands: ReadonlyArray<unknown>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly microsteps: ReadonlyArray<{
    readonly next: unknown
    readonly event: unknown
    readonly commands: ReadonlyArray<unknown>
    readonly raisedEvents: ReadonlyArray<unknown>
    readonly emittedEvents: ReadonlyArray<unknown>
    readonly exitPaths: ReadonlyArray<string>
    readonly entryPaths: ReadonlyArray<string>
    readonly changed: boolean
  }>
  readonly done: boolean
  readonly output: unknown
}) => ({
  after: plan.next,
  completion: { done: plan.done, output: plan.output },
  commands: plan.commands.length,
  emittedEvents: plan.emittedEvents,
  microsteps: plan.microsteps.map((microstep) => ({
    next: microstep.next,
    event: microstep.event,
    commands: microstep.commands.length,
    raisedEvents: microstep.raisedEvents,
    emittedEvents: microstep.emittedEvents,
    exitPaths: microstep.exitPaths,
    entryPaths: microstep.entryPaths,
    changed: microstep.changed
  }))
})

export const assertPlannerRuntimeAgreement = <M extends AnyMachine, Error, Output>(
  machine: M,
  evidence: CausalRuntimeEvidence<M, Error, Output>
): Effect.Effect<void, PlannerRuntimeAgreementError<M>> =>
  Effect.gen(function*() {
    const violations: Array<PlannerRuntimeAgreementViolation<M>> = []
    const add = (
      record: CausalRuntimeEvidence<M, Error, Output>["records"][number],
      field: PlannerRuntimeAgreementViolation<M>["field"],
      message: string
    ): void => {
      violations.push({ commandIndex: record.index, command: record.command, field, message })
    }

    for (const record of evidence.records) {
      if (record.command._tag !== "Send" || record.actual.result._tag !== "SendProcessed") continue
      const step = record.actual.result.step
      const planned = yield* Effect.result(
        Machine.plan(machine as any, step.before as any, record.command.event as any) as Effect.Effect<any, unknown>
      )
      if (Result.isFailure(planned)) {
        add(record, "planning", `Fresh planning failed: ${String(planned.failure)}`)
        continue
      }

      const expected = projection(planned.success)
      const actual = projection(step.plan)
      const compare = (
        field: "planNext" | "after" | "completion" | "commands" | "emittedEvents" | "microsteps",
        left: unknown,
        right: unknown
      ): void => {
        const actualFingerprint = fingerprint(left)
        const expectedFingerprint = fingerprint(right)
        if (actualFingerprint !== expectedFingerprint) {
          add(
            record,
            field,
            `Runtime ${field} disagreed with fresh planning: expected ${expectedFingerprint}, actual ${actualFingerprint}`
          )
        }
      }
      compare("planNext", actual.after, expected.after)
      compare("after", step.after, expected.after)
      compare("completion", actual.completion, expected.completion)
      compare("commands", actual.commands, expected.commands)
      compare("emittedEvents", actual.emittedEvents, expected.emittedEvents)
      compare("microsteps", actual.microsteps, expected.microsteps)

      const handled = planned.success.microsteps.length > 0
      if (step.handled !== handled) add(record, "handled", `Expected handled=${handled} but observed ${step.handled}`)
      const configurationChanged = planned.success.microsteps.some(({ changed }: { readonly changed: boolean }) =>
        changed
      )
      if (step.configurationChanged !== configurationChanged) {
        add(
          record,
          "configurationChanged",
          `Expected configurationChanged=${configurationChanged} but observed ${step.configurationChanged}`
        )
      }
    }

    if (violations.length > 0) {
      return yield* new PlannerRuntimeAgreementError({
        evidence: evidence as CausalRuntimeEvidence<M, unknown, unknown>,
        violations
      })
    }
  })
