import { assert } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Machine } from "../../../src/index.js"
import { MachineTest } from "../../../src/testing/index.js"

export type DifferentialStep = {
  readonly event: { readonly _tag: string }
  readonly plan: {
    readonly next: unknown
    readonly microsteps: ReadonlyArray<unknown>
    readonly done: boolean
    readonly output: unknown
  }
}

export type DifferentialBoundary = {
  readonly state: unknown
  readonly done: boolean
  readonly output: unknown
}

const encoded = (machine: Machine.Machine.Any, state: unknown) => Machine.encodeSnapshot(machine as any, state as any)

const assertRuntimeSnapshot = Effect.fn(function*(
  machine: Machine.Machine.Any,
  actual: Machine.RuntimeSnapshot<unknown, unknown, unknown>,
  expected: DifferentialBoundary,
  label: string
) {
  assert.notStrictEqual(actual.status, "error", `${label} unexpectedly failed`)
  assert.notStrictEqual(actual.status, "stopped", `${label} unexpectedly stopped`)
  if (actual.status === "error" || actual.status === "stopped") return
  assert.strictEqual(actual.status, expected.done ? "done" : "active", `${label} status`)
  assert.deepStrictEqual(yield* encoded(machine, actual.state), yield* encoded(machine, expected.state), label)
  if (actual.status === "done") assert.deepStrictEqual(actual.output, expected.output, `${label} output`)
})

const waitForBoundary = (
  ref: Machine.MachineRef<any, any, any, any>,
  expected: DifferentialBoundary
) =>
  ref.changes.pipe(
    // SubscriptionRef streams expose the current value first. Drop it so this
    // fiber acknowledges the publication caused by the event being sent.
    Stream.drop(1),
    Stream.filter((snapshot) =>
      snapshot.status === "error" ||
      (isDeepStrictEqual(snapshot.state, expected.state) && snapshot.status === (expected.done ? "done" : "active"))
    ),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((snapshots) => Array.from(snapshots)[0]!)
  )

/**
 * Drives a managed machine from a supplied start or resume operation and
 * compares every runtime publication with an already-computed pure plan.
 */
export const verifyManagedExecution = Effect.fn(function*(options: {
  readonly machine: Machine.Machine.Any
  readonly open: Effect.Effect<Machine.MachineRef<any, any, any, any>, unknown, never>
  readonly initial: DifferentialBoundary
  readonly steps: ReadonlyArray<DifferentialStep>
  readonly label: string
}) {
  const ref = yield* options.open
  const publications = yield* ref.changes.pipe(
    Stream.runCollect,
    Effect.forkChild({ startImmediately: true })
  )
  const initial = yield* ref.snapshot
  yield* assertRuntimeSnapshot(options.machine, initial, options.initial, `${options.label} initial`)

  const expectedPublications: Array<DifferentialBoundary> = [options.initial]
  for (let index = 0; index < options.steps.length; index++) {
    const step = options.steps[index]!
    const publishes = step.plan.microsteps.length > 0
    const expected = {
      state: step.plan.next,
      done: step.plan.done,
      output: step.plan.output
    }
    const observed = publishes
      ? yield* waitForBoundary(ref, expected).pipe(Effect.forkChild({ startImmediately: true }))
      : undefined

    yield* ref.send(step.event)
    if (observed !== undefined) {
      const snapshot = yield* Fiber.join(observed)
      yield* assertRuntimeSnapshot(options.machine, snapshot, expected, `${options.label} event ${index}`)
    }
    if (publishes) {
      // A terminal event first publishes the newly active state, then the
      // managed process publishes its terminal status for that same state.
      if (step.plan.done) {
        expectedPublications.push({ state: step.plan.next, done: false, output: undefined })
      }
      expectedPublications.push(expected)
    }
    if (step.plan.done) break
  }

  const final = yield* ref.snapshot
  const expectedFinal = expectedPublications[expectedPublications.length - 1]!
  yield* assertRuntimeSnapshot(options.machine, final, expectedFinal, `${options.label} final`)
  yield* ref.stop

  const actualPublications = Array.from(yield* Fiber.join(publications)).filter(({ status }) => status !== "stopped")
  assert.strictEqual(
    actualPublications.length,
    expectedPublications.length,
    `${options.label} publication count; events without microsteps must not publish`
  )
  for (let index = 0; index < expectedPublications.length; index++) {
    yield* assertRuntimeSnapshot(
      options.machine,
      actualPublications[index]!,
      expectedPublications[index]!,
      `${options.label} publication ${index}`
    )
  }
})

export const traceBoundary = (
  trace: MachineTest.Trace<Machine.Machine.Any>,
  boundary: number
): DifferentialBoundary =>
  boundary === 0
    ? {
      state: trace.initial.plan.state,
      done: trace.initial.plan.done,
      output: trace.initial.plan.output
    }
    : {
      state: trace.steps[boundary - 1]!.plan.next,
      done: trace.steps[boundary - 1]!.plan.done,
      output: trace.steps[boundary - 1]!.plan.output
    }

export const traceSteps = (
  trace: MachineTest.Trace<Machine.Machine.Any>,
  from = 0
): ReadonlyArray<DifferentialStep> =>
  trace.steps.slice(from).map(({ event, plan }) => ({ event: event as { readonly _tag: string }, plan }))
