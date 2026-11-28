/**
 * Runs one script of inputs through every planner and ownership of the step
 * functions of a machine, and asserts that they return equal data at every
 * step.
 *
 * The step functions under comparison are:
 *
 * - the execution plan of the machine, and the reference planner;
 * - persistent states, and owned states that each step takes over.
 *
 * Each variant runs on a machine of its own, built by `make`, so that what its
 * model code records is compared too. Two more persistent runs, one for each
 * planner, keep every state they pass on and step from it again with the same
 * input, read each step only once the next one was taken, and assert that
 * neither changes what was read of a state or a step before.
 */
import { assert } from "@effect/vitest"
import { Cause, Duration, Effect, Exit } from "effect"
import { Machine } from "../../../../src/index.js"
import * as Step from "../../../../src/internal/machine/step.js"

/** Selects one running piece of work, by the same rule in every variant. */
export interface Selector {
  readonly matches: (work: Step.Work) => boolean
  /** The newest match when left out, or the match that started at this position among those that ever started. */
  readonly position?: number | undefined
}

/** One thing the script does to the machine. */
export type Input =
  | { readonly _tag: "Send"; readonly event: unknown }
  | { readonly _tag: "Settle"; readonly work: Selector; readonly exit: Exit.Exit<unknown, unknown> }
  | { readonly _tag: "Element"; readonly work: Selector; readonly value: unknown }
  | { readonly _tag: "Report"; readonly work: Selector; readonly snapshot: unknown }
  /** Lets time pass: every timer that falls due settles, in due order. */
  | { readonly _tag: "Advance"; readonly millis: number }
  /** Resumes from the snapshot of the latest step, as a restarted host does. */
  | { readonly _tag: "Resume" }
  | { readonly _tag: "Stop" }

export interface Subject {
  readonly machine: Machine.Machine.Any
  /** What the model code of this machine recorded, which every variant must record alike. */
  readonly log?: (() => ReadonlyArray<string>) | undefined
}

export interface Options {
  readonly label: string
  /** Builds the machine of one variant. */
  readonly make: () => Subject
  readonly input?: ReadonlyArray<unknown> | undefined
  readonly inputs: ReadonlyArray<Input>
}

const self: Machine.MachineTarget<any> = { id: "differential", sessionId: "differential:test", send: () => Effect.void }

const isWork = (value: unknown): value is Step.Work =>
  typeof value === "object" && value !== null && Step.WorkTypeId in value

const workKey = (work: Step.Work): string => `${work._tag} ${work.path}#${work.id}@${work.run}`

const errorShape = (error: unknown): unknown =>
  error instanceof Error ? { error: error.name, message: error.message } : canonical(error)

const renderCause = (cause: Cause.Cause<unknown>): unknown =>
  cause.reasons.map((reason) =>
    Cause.isFailReason(reason)
      ? { fail: errorShape(reason.error) }
      : Cause.isDieReason(reason)
      ? { die: errorShape(reason.defect) }
      : { interrupt: true }
  )

const renderExit = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isSuccess(exit) ? { success: canonical(exit.value) } : { failure: renderCause(exit.cause) }

/**
 * Plain data, comparable across machines built separately: classes become
 * their fields, work becomes its key, and functions and errors a description.
 */
export const canonical = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return typeof value === "function" ? "<function>" : value
  if (Exit.isExit(value)) return renderExit(value)
  if (value instanceof Error) return errorShape(value)
  if (isWork(value)) return workKey(value)
  if (Array.isArray(value)) return value.map(canonical)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) out[key] = canonical((value as Record<string, unknown>)[key])
  return out
}

/** Every observable part of a step, as data. */
const stepData = (step: Step.Step<any>): unknown => ({
  event: canonical(step.event),
  snapshot: canonical(step.snapshot),
  microsteps: canonical(step.microsteps),
  emitted: canonical(step.emitted),
  commands: step.commands.map((command) =>
    command._tag === "Send"
      ? { _tag: command._tag, target: command.target.id, event: canonical(command.event) }
      : {
        _tag: command._tag,
        child: typeof command.child === "string" ? command.child : command.child.id,
        work: command.work === undefined ? undefined : workKey(command.work),
        ...(command._tag === "SendToChild" ? { event: canonical(command.event) } : {})
      }
  ),
  stop: step.stop.map(workKey),
  start: step.start.map(workKey),
  running: step.running.map(workKey),
  exit: step.exit === undefined ? undefined : renderExit(step.exit)
})

const resultData = (result: Exit.Exit<Step.Step<any>, unknown>): unknown =>
  Exit.isSuccess(result) ? { step: stepData(result.value) } : { refused: renderCause(result.cause) }

interface Variant {
  readonly name: string
  readonly subject: Subject
  readonly step: Step.MachineStep<Step.Ownership>
  /** Whether this run keeps its states, steps from each twice, and reads each step late. */
  readonly replays: boolean
  latest: Step.Step<any> | undefined
  /** The step a replaying variant goes on from, which it has not read yet, and what it must read. */
  pending: { readonly label: string; readonly step: Step.Step<any>; readonly data: unknown } | undefined
  /** Every piece of work that ever started, in start order. */
  readonly started: Array<Step.Work>
  /** When each running timer falls due, on the clock of the script. */
  readonly due: Map<Step.Work, number>
}

const makeVariant = (
  options: Options,
  name: string,
  ownership: Step.Ownership,
  planner: "Compiled" | "Reference",
  replays: boolean
): Variant => {
  const subject = options.make()
  return {
    name,
    subject,
    step: Step.makeForTesting(subject.machine, { self }, ownership, planner),
    replays,
    latest: undefined,
    pending: undefined,
    started: [],
    due: new Map()
  }
}

const select = (variant: Variant, selector: Selector): Step.Work | undefined => {
  if (selector.position !== undefined) {
    return variant.started.filter(selector.matches)[selector.position]
  }
  return variant.latest?.running.filter(selector.matches).at(-1)
}

/** Records the work a step started, and when its timers fall due. */
const track = (variant: Variant, step: Step.Step<any>, now: number): void => {
  for (const work of step.start) {
    variant.started.push(work)
    if (work._tag === "Timer") {
      const duration = work.duration()
      variant.due.set(
        work,
        Exit.isSuccess(duration) && Exit.isSuccess(duration.value)
          ? now + Duration.toMillis(duration.value.value)
          : now
      )
    }
  }
  for (const work of variant.due.keys()) {
    if (!step.running.includes(work)) variant.due.delete(work)
  }
}

/** The timers of a variant that fall due by `until`, in due order, then start order. */
const dueTimers = (variant: Variant, until: number): ReadonlyArray<Step.Work> =>
  Array.from(variant.due).filter(([, due]) => due <= until).sort(([, left], [, right]) => left - right).map((
    [work]
  ) => work)

/**
 * Performs `apply` on every variant from its latest state and asserts that the
 * results are equal. Returns whether a variant took a step.
 *
 * A replaying variant applies it twice to the same state. It reads the second
 * result at once, and the first, which it goes on from, only once it has
 * stepped twice from that one too.
 */
const compare = (
  variants: ReadonlyArray<Variant>,
  label: string,
  now: number,
  apply: (variant: Variant, state: Step.State<any> | undefined) => Exit.Exit<Step.Step<any>, unknown> | undefined
): boolean => {
  let expected: { readonly variant: Variant; readonly data: unknown; readonly log: unknown } | undefined
  let applied = false
  for (const variant of variants) {
    const state = variant.latest?.state
    const result = apply(variant, state)
    if (variant.replays) {
      const again = result === undefined ? undefined : apply(variant, state)
      const data = again === undefined ? "nothing" : resultData(again)
      assert.deepStrictEqual(data, expected!.data, `${label}: ${variant.name} steps again from a kept state`)
      const pending = variant.pending
      if (pending !== undefined) {
        // Stepping from a state twice leaves its storage as it was, and what
        // was not read of it and of its step before reads as it would have.
        assert.deepStrictEqual(
          canonical(state!.planning.plan.snapshot(state!.execution)),
          (pending.data as { readonly snapshot: unknown }).snapshot,
          `${label}: ${variant.name} keeps its state`
        )
        assert.deepStrictEqual(stepData(pending.step), pending.data, `${pending.label}: ${variant.name} reads it late`)
        variant.pending = undefined
      }
      if (result !== undefined && Exit.isSuccess(result)) {
        variant.pending = { label, step: result.value, data: (expected!.data as { readonly step: unknown }).step }
      }
    } else {
      const data = result === undefined ? "nothing" : resultData(result)
      const log = variant.subject.log?.()
      if (expected === undefined) {
        expected = { variant, data, log }
      } else {
        assert.deepStrictEqual(data, expected.data, `${label}: ${variant.name} equals ${expected.variant.name}`)
        assert.deepStrictEqual(log, expected.log, `${label}: ${variant.name} runs model code alike`)
      }
    }
    if (result === undefined) continue
    applied = true
    if (Exit.isSuccess(result)) {
      variant.latest = result.value
      track(variant, result.value, now)
    }
  }
  return applied
}

/** Reads the last step of every replaying variant. */
const flush = (variants: ReadonlyArray<Variant>): void => {
  for (const variant of variants) {
    const pending = variant.pending
    if (pending !== undefined) {
      assert.deepStrictEqual(stepData(pending.step), pending.data, `${pending.label}: ${variant.name} reads it late`)
      variant.pending = undefined
    }
  }
}

/**
 * Runs `options.inputs` through every variant and asserts equal results at
 * each step. Returns how many inputs a step took.
 */
export const verifyStepStrategies = (options: Options): number => {
  const variants = [
    makeVariant(options, "compiled persistent", "Persistent", "Compiled", false),
    makeVariant(options, "reference persistent", "Persistent", "Reference", false),
    makeVariant(options, "compiled owned", "Owned", "Compiled", false),
    makeVariant(options, "reference owned", "Owned", "Reference", false),
    makeVariant(options, "compiled persistent, kept", "Persistent", "Compiled", true),
    makeVariant(options, "reference persistent, kept", "Persistent", "Reference", true)
  ]
  let now = 0
  let taken = 0
  const input = options.input ?? []
  compare(variants, `${options.label} start`, now, (variant) => variant.step.start(...input))
  options.inputs.forEach((action, index) => {
    const label = `${options.label} input ${index} ${action._tag}`
    const running = (variant: Variant, state: Step.State<any> | undefined) =>
      state !== undefined && variant.latest !== undefined && variant.latest.exit === undefined ? state : undefined
    switch (action._tag) {
      case "Send": {
        if (compare(variants, label, now, (variant, state) => state && variant.step.send(state, action.event))) {
          taken++
        }
        return
      }
      case "Settle":
      case "Element":
      case "Report": {
        const found = variants.map((variant) => select(variant, action.work))
        if (found.some((work) => work === undefined)) {
          assert.ok(found.every((work) => work === undefined), `${label}: every variant selects the work`)
          return
        }
        const applied = compare(variants, label, now, (variant, state) => {
          const work = found[variants.indexOf(variant)]!
          if (state === undefined) return undefined
          return Exit.succeed(
            action._tag === "Settle"
              ? variant.step.settle(state, work, action.exit)
              : action._tag === "Element"
              ? variant.step.element(state, work, action.value)
              : variant.step.report(state, work, action.snapshot)
          )
        })
        if (applied) taken++
        return
      }
      case "Advance": {
        const until = now + action.millis
        while (true) {
          const due = variants.map((variant) => dueTimers(variant, until))
          assert.deepStrictEqual(due.map((timers) => timers.map(workKey)), due.map(() => due[0]!.map(workKey)))
          const first = due[0]![0]
          if (first === undefined) break
          now = Math.max(now, variants[0]!.due.get(first)!)
          compare(variants, `${label} timer ${workKey(first)}`, now, (variant, state) => {
            const timer = due[variants.indexOf(variant)]![0]!
            variant.due.delete(timer)
            return running(variant, state) && Exit.succeed(variant.step.settle(state!, timer, Exit.void))
          })
          taken++
        }
        now = until
        return
      }
      case "Resume": {
        compare(variants, label, now, (variant) => {
          if (variant.latest === undefined) return undefined
          const snapshot = variant.latest.snapshot
          variant.due.clear()
          return variant.step.resume(snapshot)
        })
        taken++
        return
      }
      case "Stop": {
        compare(variants, label, now, (variant, state) => state && Exit.succeed(variant.step.stop(state)))
        taken++
        return
      }
    }
  })
  flush(variants)
  return taken
}
