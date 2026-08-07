import { assert, describe, it } from "@effect/vitest"
import { Cause, Data, Effect, Fiber, Ref, Schema, Stream } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../src/index.js"
import { MachineTest } from "../src/testing.js"
import { traceBoundary, traceSteps, verifyManagedExecution } from "./support/machineRuntimeDifferential.js"

const event = (_tag: string): { readonly _tag: string } => ({ _tag })

const parallelPaths = (model: MachineTest.FiniteModel): ReadonlyArray<string> => {
  const paths: Array<string> = []
  const visit = (states: ReadonlyArray<MachineTest.FiniteState>, parent?: string): void => {
    for (const state of states) {
      const path = parent === undefined ? state.key : `${parent}.${state.key}`
      if (state._tag === "Parallel") paths.push(path)
      if (state._tag === "Compound" || state._tag === "Parallel") visit(state.states, path)
    }
  }
  visit(model.roots)
  return paths
}

const generated = MachineTest.finiteModels({
  maxRoots: 2,
  maxDepth: 3,
  maxChildren: 3,
  maxParallelRegions: 3,
  maxEvents: 3,
  maxTransitions: 12,
  maxHistoryStates: 1,
  maxChoiceStates: 1
})

describe("pure planning and managed runtime differential", () => {
  it.effect("matches deterministic generated start and resumed executions", () =>
    Effect.gen(function*() {
      const samples = FastCheck.sample(generated.arbitrary, { numRuns: 36, seed: 93_701 })
      let activeParallel = 0
      let eventful = 0
      let resumedContinuation = 0

      for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        const sampled = samples[sampleIndex]!
        // Keep generated runtime inputs on deterministic, state-changing
        // targets. Targetless and reentry publication semantics have focused
        // witnesses elsewhere and can make a current-state subscription an
        // ambiguous acknowledgement barrier.
        const model: MachineTest.FiniteModel = {
          ...sampled,
          transitions: (sampled.historyScenarios?.length ?? 0) > 0
            ? sampled.transitions
            : sampled.transitions.filter((transition) =>
              transition.trigger.type !== "event" ||
              (transition.target !== undefined && "reenter" in transition && !transition.reenter &&
                transition.target !== transition.source)
            )
        }
        const requestedEvents = Array.from({ length: 6 }, (_, index) =>
          model.events[(sampleIndex + index) % model.events.length]!)
        const reference = MachineTest.interpretModel(model, requestedEvents)
        // The independent reference interpreter chooses the useful prefix. A
        // missing planner transition therefore cannot erase its own witness.
        let lastTransitioning = -1
        for (let index = 0; index < reference.steps.length; index++) {
          const step = reference.steps[index]!
          if (step.microsteps.length > 0) {
            lastTransitioning = index
          }
          if (step.done) {
            break
          }
        }
        const events = lastTransitioning < 0 ? [] : requestedEvents.slice(0, lastTransitioning + 1)
        const expected = MachineTest.interpretModel(model, events)
        const machine = MachineTest.compileModel(model)
        const trace = yield* MachineTest.run(machine, { events: events.map(event) })
        yield* MachineTest.verifyModel(model, trace)

        if (
          expected.steps.some(({ microsteps }) =>
            microsteps.some(({ transitions }) =>
              transitions.some(({ trigger }) => trigger.type === "event")
            )
          )
        ) eventful += 1
        const parallel = new Set(parallelPaths(model))
        if (
          [expected.initial.state, ...expected.steps.map(({ after }) => after)].some(({ activePaths }) =>
            activePaths.some((path) => parallel.has(path))
          )
        ) activeParallel += 1

        yield* verifyManagedExecution({
          machine,
          open: Machine.start(machine as any),
          initial: traceBoundary(trace, 0),
          steps: traceSteps(trace),
          label: `generated start ${sampleIndex}`
        })

        const boundary = trace.steps.length < 2 ? 0 : Math.max(1, Math.floor(trace.steps.length / 2))
        const boundaryState = traceBoundary(trace, boundary)
        const encoded = yield* Machine.encodeSnapshot(machine as any, boundaryState.state as any)
        const decoded = yield* Machine.decodeSnapshot(machine as any, encoded)
        yield* verifyManagedExecution({
          machine,
          open: Machine.resume(machine as any, decoded),
          initial: boundaryState,
          steps: traceSteps(trace, boundary),
          label: `generated resume ${sampleIndex}:${boundary}`
        })
        if (boundary > 0 && boundary < trace.steps.length) resumedContinuation += 1
      }

      assert.ok(eventful > 0, "generated differential must execute public-event transitions")
      assert.ok(activeParallel > 0, "generated differential must execute an active parallel configuration")
      assert.ok(
        resumedContinuation > 0,
        "generated differential must resume after a noninitial boundary with a non-empty suffix"
      )
    }), 30_000)

  it.effect("resumes a nonterminal boundary reached through always and completion stabilization", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [
          {
            _tag: "Compound",
            key: "flow",
            value: 0,
            initial: "idle",
            states: [
              { _tag: "Atomic", key: "idle", value: 1 },
              {
                _tag: "Compound",
                key: "work",
                value: 2,
                initial: "done",
                states: [{ _tag: "Final", key: "done", value: 3, output: "work:done" }]
              },
              { _tag: "Atomic", key: "ready", value: 4 }
            ]
          },
          { _tag: "Final", key: "complete", value: 5, output: "machine:done" }
        ],
        initial: "flow",
        events: ["Finish"],
        transitions: [
          { source: "flow.idle", trigger: { type: "always" }, target: "flow.work" },
          { source: "flow.work", trigger: { type: "done" }, target: "flow.ready" },
          { source: "flow.ready", trigger: { type: "event", event: "Finish" }, target: "complete", reenter: false }
        ]
      }
      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Finish")] })
      yield* MachineTest.verifyModel(model, trace)
      assert.deepStrictEqual(
        trace.initial.plan.microsteps.flatMap((microstep) => microstep.transitions.map(({ trigger }) => trigger.type)),
        ["always", "done"]
      )
      assert.strictEqual(trace.initial.plan.done, false)
      assert.strictEqual(trace.initial.plan.state.path, "flow")
      assert.strictEqual((trace.initial.plan.state as any).state.path, "flow.ready")
      assert.strictEqual(trace.steps[0]?.plan.done, true)
      assert.strictEqual(trace.steps[0]?.plan.output, "machine:done")

      yield* verifyManagedExecution({
        machine,
        open: Machine.start(machine as any),
        initial: traceBoundary(trace, 0),
        steps: traceSteps(trace),
        label: "automatic start"
      })
      const encoded = yield* Machine.encodeSnapshot(machine as any, trace.initial.plan.state as any)
      const decoded = yield* Machine.decodeSnapshot(machine as any, encoded)
      yield* verifyManagedExecution({
        machine,
        open: Machine.resume(machine as any, decoded),
        initial: traceBoundary(trace, 0),
        steps: traceSteps(trace),
        label: "automatic resume"
      })
    }))

  it.effect("preserves raised-event, action, and planned emission order", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("DifferentialIdle")("Idle", {}) {}
      class Working extends Schema.TaggedClass<Working>("DifferentialWorking")("Working", {}) {}
      class Finished extends Schema.TaggedClass<Finished>("DifferentialFinished")("Finished", {}) {}
      class Begin extends Schema.TaggedClass<Begin>("DifferentialBegin")("Begin", {}) {}
      class RaisedOne extends Schema.TaggedClass<RaisedOne>("DifferentialRaisedOne")("RaisedOne", {}) {}
      class RaisedTwo extends Schema.TaggedClass<RaisedTwo>("DifferentialRaisedTwo")("RaisedTwo", {}) {}
      class Notice extends Schema.TaggedClass<Notice>("DifferentialNotice")("Notice", { label: Schema.String }) {}

      const actions = yield* Ref.make<ReadonlyArray<string>>([])
      const record = (label: string) => Machine.action(Ref.update(actions, (labels) => [...labels, label]))
      const states = Machine.defineStates({
        Idle,
        Working,
        Finished: { schema: Finished, type: "final", output: Schema.String }
      })
      const machine = Machine.make({
        states: states.states,
        events: [Begin],
        internalEvents: [RaisedOne, RaisedTwo],
        emits: [Notice],
        initial: () => states.initial.Idle(new Idle({}))
      }).handle({
        Idle: {
          entry: ({ emit }) => Effect.andThen(record("entry:idle"), emit(new Notice({ label: "initial" }))),
          on: {
            Begin: Effect.fn(function*({ emit, raise, target }) {
              yield* record("transition:begin")
              yield* emit(new Notice({ label: "transition" }))
              yield* raise(new RaisedOne({}))
              return target.full.Working(new Working({}))
            })
          }
        },
        Working: {
          entry: Effect.fn(function*({ emit, raise }) {
            yield* record("entry:working")
            yield* emit(new Notice({ label: "entry" }))
            yield* raise(new RaisedTwo({}))
          }),
          on: {
            RaisedOne: Effect.fn(function*({ emit }) {
              yield* record("raised:one")
              yield* emit(new Notice({ label: "raised-one" }))
            }),
            RaisedTwo: Effect.fn(function*({ emit, target }) {
              yield* record("raised:two")
              yield* emit(new Notice({ label: "raised-two" }))
              return target.full.Finished(new Finished({}))
            })
          }
        },
        Finished: {
          entry: ({ emit }) => Effect.andThen(record("entry:finished"), emit(new Notice({ label: "finished" }))),
          output: () => "complete"
        }
      })

      const initial = yield* Machine.planInitial(machine)
      assert.deepStrictEqual(initial.emittedEvents.map(({ label }) => label), ["initial"])
      assert.deepStrictEqual(yield* Ref.get(actions), [])
      const planned = yield* Machine.plan(machine, initial.state, new Begin({}))
      assert.deepStrictEqual(
        planned.microsteps.map(({ event }) => event._tag),
        ["Begin", "RaisedOne", "RaisedTwo"]
      )
      assert.deepStrictEqual(planned.emittedEvents.map(({ label }) => label), [
        "transition",
        "entry",
        "raised-one",
        "raised-two",
        "finished"
      ])

      const actor = yield* Machine.start(machine)
      assert.deepStrictEqual(yield* Ref.get(actions), ["entry:idle"])
      yield* actor.send(new Begin({}))
      assert.strictEqual(yield* actor.join, "complete")
      assert.deepStrictEqual(yield* Ref.get(actions), [
        "entry:idle",
        "transition:begin",
        "entry:working",
        "raised:one",
        "raised:two",
        "entry:finished"
      ])
      assert.deepStrictEqual(
        yield* Machine.encodeSnapshot(machine, (yield* actor.snapshot).state),
        yield* Machine.encodeSnapshot(machine, planned.next)
      )

      yield* Ref.set(actions, [])
      const resumed = yield* Machine.resume(machine, initial.state)
      assert.deepStrictEqual(yield* Ref.get(actions), [], "resume must not replay initial entry actions")
      yield* resumed.send(new Begin({}))
      assert.strictEqual(yield* resumed.join, "complete")
      assert.deepStrictEqual(yield* Ref.get(actions), [
        "transition:begin",
        "entry:working",
        "raised:one",
        "raised:two",
        "entry:finished"
      ])
    }))

  it.effect("retains the last published state when a planned action fails", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("DifferentialFailureIdle")("Idle", {}) {}
      class Finished extends Schema.TaggedClass<Finished>("DifferentialFailureFinished")("Finished", {}) {}
      class Go extends Schema.TaggedClass<Go>("DifferentialFailureGo")("Go", {}) {}
      class Notice extends Schema.TaggedClass<Notice>("DifferentialFailureNotice")("Notice", {}) {}
      class ActionFailure extends Data.TaggedError("ActionFailure")<{}> {}

      const actions = yield* Ref.make<ReadonlyArray<string>>([])
      const states = Machine.defineStates({ Idle, Finished })
      const machine = Machine.make({
        states: states.states,
        events: [Go],
        emits: [Notice],
        initial: () => states.initial.Idle(new Idle({}))
      }).handle({
        Idle: {
          on: {
            Go: Effect.fn(function*({ emit, target }) {
              yield* Machine.action(Ref.update(actions, (labels) => [...labels, "before"]))
              yield* Machine.action(Effect.fail(new ActionFailure()))
              yield* Machine.action(Ref.update(actions, (labels) => [...labels, "after"]))
              yield* emit(new Notice({}))
              return target.full.Finished(new Finished({}))
            })
          }
        },
        Finished: {}
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Go({}))
      assert.deepStrictEqual(planned.next, states.initial.Finished(new Finished({})))
      assert.strictEqual(planned.actions.length, 3)
      assert.strictEqual(planned.emittedEvents.length, 1)

      const actor = yield* Machine.start(machine)
      const failure = yield* actor.changes.pipe(
        Stream.filter((snapshot) => snapshot.status === "error"),
        Stream.take(1),
        Stream.runCollect,
        Effect.map((snapshots) => Array.from(snapshots)[0]!),
        Effect.forkChild({ startImmediately: true })
      )
      yield* actor.send(new Go({}))
      const snapshot = yield* Fiber.join(failure)
      assert.strictEqual(snapshot.status, "error")
      if (snapshot.status === "error") {
        assert.deepStrictEqual(snapshot.state, initial.state)
        assert.instanceOf(snapshot.cause.reasons.find(Cause.isFailReason)?.error, ActionFailure)
      }
      assert.deepStrictEqual(yield* Ref.get(actions), ["before"])
      assert.deepStrictEqual(yield* actor.snapshot, snapshot)
    }))

  it.effect("does not publish for an unhandled event before the next handled event", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("DifferentialNoopIdle")("Idle", {}) {}
      class Active extends Schema.TaggedClass<Active>("DifferentialNoopActive")("Active", {}) {}
      class Ignore extends Schema.TaggedClass<Ignore>("DifferentialIgnore")("Ignore", {}) {}
      class Go extends Schema.TaggedClass<Go>("DifferentialGo")("Go", {}) {}
      const states = Machine.defineStates({ Idle, Active })
      const machine = Machine.make({
        states: states.states,
        events: [Ignore, Go],
        initial: () => states.initial.Idle(new Idle({}))
      }).handle({
        Idle: { on: { Go: () => states.initial.Active(new Active({})) } },
        Active: {}
      })
      const initial = yield* Machine.planInitial(machine)
      const ignored = yield* Machine.plan(machine, initial.state, new Ignore({}))
      const handled = yield* Machine.plan(machine, ignored.next, new Go({}))
      assert.deepStrictEqual(ignored.microsteps, [])

      const actor = yield* Machine.start(machine)
      const publications = yield* actor.changes.pipe(
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      const active = yield* actor.changes.pipe(
        Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.path === "Active"),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild({ startImmediately: true })
      )
      yield* actor.send(new Ignore({}))
      yield* actor.send(new Go({}))
      yield* Fiber.join(active)
      yield* actor.stop

      const observed = Array.from(yield* Fiber.join(publications))
      assert.deepStrictEqual(observed.map(({ status }) => status), ["active", "active", "stopped"])
      assert.deepStrictEqual(observed[0]!.state, initial.state)
      assert.deepStrictEqual(observed[1]!.state, handled.next)
    }))
})
