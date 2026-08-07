import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { FastCheck } from "effect/testing"
import { isDeepStrictEqual } from "node:util"
import { Machine } from "../src/index.js"
import { MachineTest } from "../src/testing.js"

const generatedModels = MachineTest.finiteModels({
  maxRoots: 3,
  maxDepth: 4,
  maxChildren: 3,
  maxParallelRegions: 3,
  maxEvents: 5,
  maxTransitions: 24,
  maxHistoryStates: 2,
  maxChoiceStates: 2
})

const generatedCases = generatedModels.arbitrary.chain((model) =>
  FastCheck.tuple(
    FastCheck.array(FastCheck.constantFrom(...model.events), { minLength: 0, maxLength: 12 }),
    FastCheck.nat({ max: 12 })
  ).map(([events, boundary]) => ({
    model,
    events,
    boundary: Math.min(boundary, events.length)
  }))
)

const generatedResumeCases = generatedCases.map((generated) => {
  const reference = MachineTest.interpretModel(generated.model, generated.events)
  let lastObservable = -1
  for (let index = 0; index < reference.steps.length; index++) {
    if (reference.steps[index]!.microsteps.length > 0) lastObservable = index
  }
  const events = lastObservable < 0 ? [] : generated.events.slice(0, lastObservable + 1)
  return {
    ...generated,
    events,
    boundary: Math.min(generated.boundary, events.length)
  }
})

const assertNoUnexpectedDefect: <A, E>(
  operation: string,
  exit: Exit.Exit<A, E>
) => asserts exit is Exit.Success<A, E> = (operation, exit) => {
  if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
    assert.fail(`${operation} produced an unexpected defect:\n${Cause.pretty(exit.cause)}`)
  }
  if (Exit.isFailure(exit)) {
    assert.fail(`${operation} unexpectedly failed:\n${Cause.pretty(exit.cause)}`)
  }
}

const encodeWithoutDefect = Effect.fn(function*(machine: any, snapshot: unknown, label: string) {
  const exit = yield* Effect.exit(Machine.encodeSnapshot(machine, snapshot as any))
  assertNoUnexpectedDefect(label, exit)
  return exit.value
})

const decodeWithoutDefect = Effect.fn(function*(machine: any, encoded: unknown, label: string) {
  const exit = yield* Effect.exit(Machine.decodeSnapshot(machine, encoded))
  assertNoUnexpectedDefect(label, exit)
  return exit.value
})

const canonicalLogicalSnapshot = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalLogicalSnapshot)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "completed" && Array.isArray(child)
        ? child.slice().sort((left, right) => String(left.path).localeCompare(String(right.path))).map(
          canonicalLogicalSnapshot
        )
        : canonicalLogicalSnapshot(child)
    ])
  )
}

const assertLogicalSnapshotEquivalent = Effect.fn(function*(
  machine: any,
  expected: unknown,
  actual: unknown,
  label: string
) {
  const expectedEncoded = yield* encodeWithoutDefect(machine, expected, `${label} expected encoding`)
  const actualEncoded = yield* encodeWithoutDefect(machine, actual, `${label} actual encoding`)
  assert.deepStrictEqual(
    canonicalLogicalSnapshot(actual),
    canonicalLogicalSnapshot(expected),
    `${label} logical snapshot`
  )
  assert.deepStrictEqual(actualEncoded, expectedEncoded, label)
  assert.deepStrictEqual(
    Machine.configuration(machine, actual as any).map(({ path }) => path),
    Machine.configuration(machine, expected as any).map(({ path }) => path),
    `${label} configuration`
  )
})

const reachableSnapshots = (trace: MachineTest.Trace<Machine.Machine.Any>): ReadonlyArray<unknown> => [
  trace.initial.plan.state,
  ...trace.steps.map(({ after }) => after)
]

const waitForSnapshot = <State, Event, Error, Output>(
  ref: Machine.MachineRef<State, Event, Error, Output>,
  predicate: (snapshot: Machine.RuntimeSnapshot<State, Error, Output>) => boolean
) =>
  ref.changes.pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((snapshots) => Array.from(snapshots)[0]!)
  )

const deliverAndObserve = Effect.fn(function*(
  machine: any,
  ref: Machine.MachineRef<any, any, any, any>,
  event: { readonly _tag: string },
  planned: { readonly next: unknown; readonly microsteps: ReadonlyArray<unknown> },
  index: number
) {
  if (planned.microsteps.length === 0) {
    const sendExit = yield* Effect.exit(ref.send(event))
    assertNoUnexpectedDefect(`post-resume send ${index}`, sendExit)
    return planned.next
  }

  const expected = yield* encodeWithoutDefect(machine, planned.next, `post-resume expected ${index}`)
  const observed = yield* waitForSnapshot(
    ref,
    (snapshot) => snapshot.status === "error" || isDeepStrictEqual(snapshot.state, planned.next)
  ).pipe(Effect.forkChild)
  const sendExit = yield* Effect.exit(ref.send(event))
  assertNoUnexpectedDefect(`post-resume send ${index}`, sendExit)
  const published = yield* Fiber.join(observed)
  if (published.status === "error") {
    assert.fail(`post-resume event ${index} failed:\n${Cause.pretty(published.cause)}`)
  }
  const actual = yield* encodeWithoutDefect(machine, published.state, `post-resume observed ${index}`)
  assert.deepStrictEqual(actual, expected, `post-resume event ${index}`)
  return planned.next
})

describe("machine operation totality", () => {
  it.effect.prop(
    "never defects while planning or round-tripping reachable snapshots from valid finite models",
    { generated: generatedCases },
    ({ generated }) =>
      Effect.gen(function*() {
        const machine: any = MachineTest.compileModel(generated.model)
        const scenario = { events: generated.events.map((_tag) => ({ _tag })) }

        const initialExit = yield* Effect.exit(Machine.planInitial(machine))
        assertNoUnexpectedDefect("planInitial", initialExit)
        let current = initialExit.value.state
        for (let index = 0; index < scenario.events.length; index++) {
          const stepExit = yield* Effect.exit(Machine.plan(machine, current, scenario.events[index]!))
          assertNoUnexpectedDefect(`plan ${index}`, stepExit)
          current = stepExit.value.next
        }

        const trace = yield* MachineTest.run(machine, scenario)
        yield* MachineTest.verify(machine, trace)
        yield* MachineTest.verifyModel(generated.model, trace)

        for (const [index, snapshot] of reachableSnapshots(trace).entries()) {
          const encoded = yield* encodeWithoutDefect(machine, snapshot, `encodeSnapshot ${index}`)
          const transported = JSON.parse(JSON.stringify(encoded))
          const decoded = yield* decodeWithoutDefect(machine, transported, `decodeSnapshot ${index}`)
          yield* assertLogicalSnapshotEquivalent(machine, snapshot, decoded, `snapshot ${index}`)
        }
      }),
    { fastCheck: { numRuns: 150, seed: 61_607 } }
  )

  it.effect.prop(
    "resumes a round-tripped stable boundary and preserves continuation semantics",
    { generated: generatedResumeCases },
    ({ generated }) =>
      Effect.gen(function*() {
        const machine: any = MachineTest.compileModel(generated.model)
        const events = generated.events.map((_tag) => ({ _tag }))
        const fullTrace = yield* MachineTest.run(machine, { events })
        yield* MachineTest.verify(machine, fullTrace)
        yield* MachineTest.verifyModel(generated.model, fullTrace)
        const boundary = generated.boundary === 0
          ? fullTrace.initial.plan.state
          : fullTrace.steps[generated.boundary - 1]!.after
        const suffix = fullTrace.steps.slice(generated.boundary)

        const encoded = yield* encodeWithoutDefect(machine, boundary, "resume boundary encode")
        const decoded = yield* decodeWithoutDefect(machine, encoded, "resume boundary decode")
        const resumeExit = yield* Effect.exit(Machine.resume(machine, decoded))
        assertNoUnexpectedDefect("resume", resumeExit)
        const ref = resumeExit.value

        const initialRuntime = yield* ref.snapshot
        if (initialRuntime.status === "error") {
          assert.fail(`resume published a failed snapshot:\n${Cause.pretty(initialRuntime.cause)}`)
        }
        yield* assertLogicalSnapshotEquivalent(machine, decoded, initialRuntime.state, "resumed boundary")

        if (initialRuntime.status === "active") {
          for (let index = 0; index < suffix.length; index++) {
            const runtime = yield* ref.snapshot
            if (runtime.status !== "active") break
            const step = suffix[index]!
            yield* deliverAndObserve(machine, ref, step.event, step.plan, index)
          }
        }

        const finalRuntime = yield* ref.snapshot
        if (finalRuntime.status === "error") {
          assert.fail(`resumed continuation failed:\n${Cause.pretty(finalRuntime.cause)}`)
        }
        yield* assertLogicalSnapshotEquivalent(machine, fullTrace.final, finalRuntime.state, "resumed continuation")
        yield* ref.stop
      }),
    { fastCheck: { numRuns: 75, seed: 72_719 } }
  )

  it.effect("round-trips transformed state values and completion output", () =>
    Effect.gen(function*() {
      const Value = Schema.TaggedStruct("Value", { amount: Schema.NumberFromString })
      const Done = Schema.TaggedStruct("Done", {})
      const Finish = Schema.TaggedStruct("Finish", {})
      const states = Machine.defineStates({
        Value,
        Done: { schema: Done, type: "final", output: Schema.NumberFromString }
      })
      const machine = Machine.make({
        states: states.states,
        events: [Finish],
        initial: () => states.initial.Value({ _tag: "Value", amount: 42 })
      }).handle({
        Value: { on: { Finish: ({ target }) => target.full.Done({ _tag: "Done" }) } },
        Done: { output: () => 42 }
      })
      const plan = yield* Machine.planInitial(machine)
      const done = yield* Machine.plan(machine, plan.state, { _tag: "Finish" })

      for (const snapshot of [plan.state, done.next]) {
        const encoded = yield* Machine.encodeSnapshot(machine, snapshot)
        const transported = JSON.parse(JSON.stringify(encoded))
        const decoded = yield* Machine.decodeSnapshot(machine, transported)
        assert.deepStrictEqual(canonicalLogicalSnapshot(decoded), canonicalLogicalSnapshot(snapshot))
        assert.deepStrictEqual(yield* Machine.encodeSnapshot(machine, decoded), encoded)
      }
    }))

  it.effect("distinguishes modeled failures from user-origin defects", () =>
    Effect.gen(function*() {
      const Stable = Schema.TaggedStruct("FailurePartitionStable", {})
      const Trigger = Schema.TaggedStruct("FailurePartitionTrigger", {})
      const states = Machine.defineStates({ Stable })
      const typedFailure = { _tag: "ExpectedHandlerFailure" } as const
      const failing = Machine.make({
        states: states.states,
        events: [Trigger],
        initial: () => states.initial.Stable({ _tag: "FailurePartitionStable" })
      }).handle({ Stable: { on: { FailurePartitionTrigger: () => Effect.fail(typedFailure) } } })
      const initial = yield* Machine.planInitial(failing)
      assert.strictEqual(
        yield* Effect.flip(Machine.plan(failing, initial.state, { _tag: "FailurePartitionTrigger" })),
        typedFailure
      )

      const invalid = yield* Machine.decodeSnapshot(failing, { _tag: "not-a-snapshot" }).pipe(Effect.flip)
      assert.instanceOf(invalid, Machine.MachineSchemaDecodeError)

      const userSentinel = { source: "user" }
      const defecting = Machine.make({
        states: states.states,
        events: [Trigger],
        initial: () => states.initial.Stable({ _tag: "FailurePartitionStable" })
      }).handle({ Stable: { on: { FailurePartitionTrigger: () => Effect.die(userSentinel) } } })
      const defectExit = yield* Effect.exit(
        Machine.plan(defecting, initial.state, { _tag: "FailurePartitionTrigger" })
      )
      assert.strictEqual(Exit.isFailure(defectExit), true)
      if (Exit.isFailure(defectExit)) {
        const reason = defectExit.cause.reasons.find(Cause.isDieReason)
        assert.strictEqual(reason?.defect, userSentinel)
      }

      const looping = Machine.make({
        states: states.states,
        events: [],
        initial: () => states.initial.Stable({ _tag: "FailurePartitionStable" })
      }).handle({
        Stable: {
          always: {
            reenter: true,
            targets: ["Stable"],
            transition: ({ target }) => target.full.Stable({ _tag: "FailurePartitionStable" })
          }
        }
      })
      const cycle = yield* Machine.planInitial(looping).pipe(Effect.flip)
      assert.instanceOf(cycle, Machine.InfiniteTransitionError)
    }))
})
