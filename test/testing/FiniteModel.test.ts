import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

type FlatState = {
  readonly node: MachineTest.FiniteState
  readonly path: string
  readonly parent: string | undefined
  readonly root: string
  readonly depth: number
}

const flatten = (model: MachineTest.FiniteModel): ReadonlyArray<FlatState> => {
  const result: Array<FlatState> = []
  const visit = (
    states: ReadonlyArray<MachineTest.FiniteState>,
    parent: string | undefined,
    root: string | undefined,
    depth: number
  ): void => {
    for (const node of states) {
      const path = parent === undefined ? node.key : `${parent}.${node.key}`
      const nodeRoot = root ?? path
      result.push({ node, path, parent, root: nodeRoot, depth })
      if (node._tag === "Compound" || node._tag === "Parallel") {
        visit(node.states, path, nodeRoot, depth + 1)
      }
    }
  }
  visit(model.roots, undefined, undefined, 1)
  return result
}

const snapshotAtPath = (snapshot: unknown, path: string): unknown => {
  if (typeof snapshot !== "object" || snapshot === null) return undefined
  const current = snapshot as Record<string, unknown>
  if (current.path === path) return snapshot
  if (current.state !== undefined) {
    const found = snapshotAtPath(current.state, path)
    if (found !== undefined) return found
  }
  if (typeof current.states === "object" && current.states !== null) {
    for (const child of Object.values(current.states)) {
      const found = snapshotAtPath(child, path)
      if (found !== undefined) return found
    }
  }
  return undefined
}

const assertValid = (
  model: MachineTest.FiniteModel,
  limits: MachineTest.FiniteModelDiagnostics["limits"]
): void => {
  assert.ok(Object.isFrozen(model))
  assert.ok(Object.isFrozen(model.roots))
  assert.ok(Object.isFrozen(model.events))
  assert.ok(Object.isFrozen(model.transitions))
  assert.ok(Object.isFrozen(model.historyScenarios))
  assert.ok(model.roots.length >= 1 && model.roots.length <= limits.maxRoots)
  assert.ok(model.roots.some(({ key }) => key === model.initial))
  assert.ok(model.events.length >= 1 && model.events.length <= limits.maxEvents)
  assert.strictEqual(new Set(model.events).size, model.events.length)

  const states = flatten(model)
  const byPath = new Map(states.map((state) => [state.path, state]))
  const stateOrder = new Map(states.map((state, index) => [state.path, index]))
  assert.strictEqual(byPath.size, states.length)
  for (const state of states) {
    assert.ok(Object.isFrozen(state.node))
    assert.ok(state.depth <= limits.maxDepth)
    if (state.node._tag !== "History" && state.node._tag !== "Choice") {
      assert.ok(Number.isSafeInteger(state.node.value))
    }
    if (state.node._tag === "History") {
      assert.ok(state.parent !== undefined)
      const fallback = byPath.get(state.node.fallback)
      assert.ok(fallback !== undefined && fallback.node._tag !== "History")
      assert.ok(fallback.path.startsWith(`${state.parent}.`))
    } else if (state.node._tag === "Compound") {
      const compound = state.node
      assert.ok(Object.isFrozen(compound.states))
      const children = compound.states.filter((child) => child._tag !== "History" && child._tag !== "Choice")
      assert.ok(children.length >= 1 && children.length <= limits.maxChildren)
      assert.ok(compound.states.some(({ key }) => key === compound.initial))
    } else if (state.node._tag === "Parallel") {
      assert.ok(Object.isFrozen(state.node.states))
      const regions = state.node.states.filter((child) => child._tag !== "History" && child._tag !== "Choice")
      assert.ok(regions.length >= 2 && regions.length <= limits.maxParallelRegions)
      assert.strictEqual(state.node.output, `output:${state.path}`)
    } else if (state.node._tag === "Final") {
      assert.strictEqual(state.node.output, `output:${state.path}`)
    }
  }

  const registrations = new Set<string>()
  assert.ok(model.transitions.length <= limits.maxTransitions)
  for (const transition of model.transitions) {
    assert.ok(Object.isFrozen(transition))
    const source = byPath.get(transition.source)
    assert.ok(
      source !== undefined && source.node._tag !== "Final" && source.node._tag !== "History" &&
        source.node._tag !== "Choice"
    )
    if (transition.trigger.type === "event") assert.ok(model.events.includes(transition.trigger.event))
    else {
      assert.ok(transition.target !== undefined)
      assert.strictEqual("reenter" in transition, false)
      assert.ok(stateOrder.get(transition.target!)! > stateOrder.get(transition.source)!)
      if (transition.trigger.type === "always") assert.strictEqual(source.node._tag, "Atomic")
      else assert.ok(source.node._tag === "Compound" || source.node._tag === "Parallel")
    }
    const registration = `${transition.source}\u0000${JSON.stringify(transition.trigger)}`
    assert.ok(!registrations.has(registration))
    registrations.add(registration)
    if (transition.target !== undefined) {
      const target = byPath.get(transition.target)
      assert.ok(target !== undefined)
      assert.ok(target.node._tag === "History" || target.root === source.root || target.parent === undefined)
      if (transition.targetValue !== undefined) {
        assert.ok(target.node._tag !== "History")
        assert.ok(Number.isSafeInteger(transition.targetValue))
      }
    } else {
      assert.strictEqual(transition.targetValue, undefined)
    }
  }
  for (const scenario of model.historyScenarios ?? []) {
    assert.ok(Object.isFrozen(scenario))
    assert.ok(Object.isFrozen(scenario.events))
    assert.deepStrictEqual(scenario.events, [
      scenario.mutation.event,
      scenario.leave.event,
      scenario.resume.event
    ])
    assert.strictEqual(scenario.leave.event, scenario.resume.event)
    assert.strictEqual(scenario.resume.target, scenario.history)
    assert.notStrictEqual(byPath.get(scenario.mutation.source)?.node._tag, "History")
    assert.ok(scenario.mutation.source.startsWith(`${scenario.owner}.`))
  }
}

const canonicalTransition = (transition: Machine.Machine.TransitionDefinition) => ({
  source: transition.source,
  trigger: transition.trigger,
  reenter: transition.reenter,
  branches: transition.branches
})

describe("MachineTest finite models", () => {
  const generated = MachineTest.finiteModels({
    maxRoots: 3,
    maxDepth: 4,
    maxChildren: 3,
    maxEvents: 4,
    maxTransitions: 20,
    maxHistoryStates: 2
  })

  it("generates immutable bounded models whose references remain valid", () => {
    assert.deepStrictEqual(generated.diagnostics.guarantees, {
      compoundOnly: false,
      parallelStates: true,
      historyStates: true,
      historyLeaveResumeSequences: true,
      historyValueScenarios: true,
      choiceStates: true,
      choiceInitialWitnesses: true,
      structurallyValid: true,
      shrinkPreservesValidity: true,
      eventlessTransitions: true,
      acyclicAutomaticTransitions: true
    })
    const samples = FastCheck.sample(generated.arbitrary, { numRuns: 250, seed: 10_241 })
    for (const model of samples) {
      assertValid(model, generated.diagnostics.limits)
      assert.ok(
        flatten(model).filter(({ node }) => node._tag === "History").length <=
          generated.diagnostics.limits.maxHistoryStates
      )
      assert.strictEqual(
        model.historyScenarios?.length,
        flatten(model).filter(({ node }) => node._tag === "History").length
      )
    }
    assert.ok(samples.some((model) => flatten(model).some(({ node }) => node._tag === "Parallel")))
    assert.ok(samples.some((model) => flatten(model).some(({ node }) => node._tag === "History")))
    assert.ok(samples.some((model) => model.transitions.some(({ trigger }) => trigger.type === "always")))
    assert.ok(samples.some((model) => model.transitions.some(({ trigger }) => trigger.type === "done")))
    assert.ok(samples.some((model) =>
      model.transitions.some(({ trigger }) => trigger.type === "event") &&
      model.transitions.some(({ trigger }) => trigger.type !== "event")
    ))
    assert.ok(samples.some((model) => flatten(model).filter(({ node }) => node._tag === "History").length > 1))
    assert.ok(
      samples.some((model) =>
        flatten(model).some(({ node, parent }) => node._tag === "History" && parent?.includes(".") === true)
      )
    )
  })

  it.effect("generates firing event-to-always and event-to-completion chains", () =>
    Effect.gen(function*() {
      const samples = FastCheck.sample(generated.arbitrary, { numRuns: 2_000, seed: 12_773 })
      const witnesses = new Map<"always" | "done", {
        readonly event: string
        readonly model: MachineTest.FiniteModel
      }>()

      for (const model of samples) {
        for (const eventTag of model.events) {
          const reference = MachineTest.interpretModel(model, [eventTag])
          const triggers = reference.steps[0]?.microsteps.flatMap((microstep) =>
            microstep.transitions.map(({ trigger }) => trigger.type)
          ) ?? []
          if (triggers[0] !== "event") {
            continue
          }
          if (triggers.includes("always") && !witnesses.has("always")) {
            witnesses.set("always", { event: eventTag, model })
          }
          if (triggers.includes("done") && !witnesses.has("done")) {
            witnesses.set("done", { event: eventTag, model })
          }
        }
        if (witnesses.size === 2) {
          break
        }
      }

      assert.ok(witnesses.has("always"), "generated models must exercise an event -> always chain")
      assert.ok(witnesses.has("done"), "generated models must exercise an event -> completion chain")
      for (const witness of witnesses.values()) {
        const machine = MachineTest.compileModel(witness.model)
        const trace = yield* MachineTest.run(machine, { events: [{ _tag: witness.event }] })
        yield* MachineTest.verifyModel(witness.model, trace)
      }
    }))

  it.effect("replays exact generated root and nested value-mutation/capture/restore scenarios", () =>
    Effect.gen(function*() {
      const samples = FastCheck.sample(generated.arbitrary, { numRuns: 1_000, seed: 15_361 })
      const candidates = samples.flatMap((model) =>
        (model.historyScenarios ?? []).map((scenario) => ({ model, scenario }))
      )
      const root = candidates.find(({ scenario }) => !scenario.owner.includes("."))
      const nested = candidates.find(({ scenario }) => scenario.owner.includes("."))
      assert.ok(root !== undefined)
      assert.ok(nested !== undefined)

      for (const { model, scenario } of [root, nested]) {
        const machine = MachineTest.compileModel(model)
        const trace = yield* MachineTest.run(machine, {
          events: scenario.events.map((_tag) => ({ _tag }))
        })
        const mutated = snapshotAtPath(trace.steps[0]!.after, scenario.mutation.source) as any
        const restored = snapshotAtPath(trace.final, scenario.mutation.source) as any
        assert.strictEqual(mutated.value.value, scenario.mutation.value)
        assert.strictEqual(restored.value.value, scenario.mutation.value)
        assert.strictEqual(
          (trace.final as any).history[scenario.history].values[scenario.mutation.source].value,
          scenario.mutation.value
        )
        yield* MachineTest.verifyModel(model, trace)
      }
    }))

  it("compiles state nodes and transition definitions through the public Machine API", () => {
    for (const model of FastCheck.sample(generated.arbitrary, { numRuns: 100, seed: 20_482 })) {
      const machine = MachineTest.compileModel(model)
      const expectedStates = flatten(model)
      const actualStates = Machine.stateNodes(machine)
      const expected = expectedStates.map(({ node, parent, path }): {
        readonly path: string
        readonly parent: string | undefined
        readonly type: "atomic" | "compound" | "parallel" | "final" | "history" | "choice"
        readonly children: ReadonlyArray<string>
        readonly initial: string | undefined
      } => ({
        path,
        parent,
        type: node._tag === "Atomic"
          ? "atomic"
          : node._tag === "Final"
          ? "final"
          : node._tag === "Parallel"
          ? "parallel"
          : node._tag === "History"
          ? "history"
          : node._tag === "Choice"
          ? "choice"
          : "compound",
        children: node._tag === "Compound" || node._tag === "Parallel"
          ? node.states.filter((child) => child._tag !== "History" && child._tag !== "Choice").map(({ key }) =>
            `${path}.${key}`
          )
          : [],
        initial: node._tag === "Compound" ? `${path}.${node.initial}` : undefined
      }))
      assert.deepStrictEqual(
        actualStates.map(({ children, initial, parent, path, type }) => ({ children, initial, parent, path, type })),
        expected
      )

      const actualTransitions = Machine.transitionDefinitions(machine)
        .filter(({ trigger }) => trigger.type !== "choice")
        .map(canonicalTransition)
      assert.strictEqual(actualTransitions.length, model.transitions.length)
      for (let index = 0; index < model.transitions.length; index++) {
        const expected = model.transitions[index]!
        const actual = actualTransitions[index]!
        assert.strictEqual(actual.source, expected.source)
        assert.deepStrictEqual(actual.trigger, expected.trigger)
        assert.strictEqual(actual.reenter, "reenter" in expected ? expected.reenter : false)
        assert.strictEqual(actual.branches.length, 1)
        const target = actual.branches[0]!.target
        if (expected.target === undefined) {
          assert.strictEqual(target, undefined)
        } else {
          assert.notStrictEqual(target, undefined)
          const bound = target!
          assert.ok(
            expected.target === bound || expected.target.startsWith(`${bound}.`) ||
              bound.startsWith(`${expected.target}.`)
          )
        }
      }
    }
  })

  const executable = generated.arbitrary.chain((model) => {
    const machine = MachineTest.compileModel(model)
    return MachineTest.scenarios(machine, { minEvents: 0, maxEvents: 20 }).arbitrary.map((scenario) => ({
      model,
      machine,
      scenario
    }))
  })

  it.effect.prop(
    "runs and independently verifies schema-valid scenarios for generated machines",
    { generated: executable },
    ({ generated }) =>
      MachineTest.run(generated.machine, generated.scenario).pipe(
        Effect.flatMap((trace) => MachineTest.verify(generated.machine, trace))
      ),
    { fastCheck: { numRuns: 250, seed: 30_723 } }
  )

  it.effect("keeps the natural cross-root lifecycle boundary for reentering transitions", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [
          {
            _tag: "Compound",
            key: "left",
            value: 0,
            initial: "idle",
            states: [{ _tag: "Atomic", key: "idle", value: 1 }]
          },
          {
            _tag: "Compound",
            key: "right",
            value: 2,
            initial: "idle",
            states: [{ _tag: "Atomic", key: "idle", value: 3 }]
          }
        ],
        initial: "right",
        events: ["Switch"],
        transitions: [{
          source: "right.idle",
          trigger: { type: "event", event: "Switch" },
          target: "left",
          reenter: true
        }]
      }
      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [{ _tag: "Switch" }] })
      const step = trace.steps[0]!.plan.microsteps[0]!

      assert.deepStrictEqual(step.exitPaths, ["right.idle", "right"])
      assert.deepStrictEqual(step.entryPaths, ["left", "left.idle"])
      yield* MachineTest.verify(machine, trace)
    }))

  it.effect("uses deterministic schema-valid state values and final outputs", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{ _tag: "Final", key: "done", value: 42, output: "completed" }],
        initial: "done",
        events: ["Unused"],
        transitions: []
      }
      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [] })

      assert.deepStrictEqual(trace.initial.startingState.value, { _tag: "State_done", value: 42 })
      assert.strictEqual(trace.initial.plan.done, true)
      assert.strictEqual(trace.initial.plan.output, "completed")
      yield* MachineTest.verify(machine, trace)
    }))

  it("keeps every visited shrink valid and replays the minimal counterexample", () => {
    const visited: Array<MachineTest.FiniteModel> = []
    const property = FastCheck.property(generated.arbitrary, (model) => {
      assertValid(model, generated.diagnostics.limits)
      MachineTest.compileModel(model)
      visited.push(model)
      return false
    })
    const result = FastCheck.check(property, { numRuns: 20, seed: 40_964 })

    assert.strictEqual(result.failed, true)
    assert.ok(visited.length > 1, "the failing input should have been shrunk")
    assert.ok(result.counterexample !== null)
    const smallest = result.counterexample![0]
    assertValid(smallest, generated.diagnostics.limits)

    const replay = FastCheck.check(property, {
      numRuns: 1,
      seed: result.seed,
      path: result.counterexamplePath
    })
    assert.strictEqual(replay.failed, true)
    assert.deepStrictEqual(replay.counterexample?.[0], smallest)
  })

  it("rejects hand-authored dangling and duplicate transition registrations", () => {
    const base: MachineTest.FiniteModel = {
      roots: [{ _tag: "Atomic", key: "idle", value: 0 }],
      initial: "idle",
      events: ["Go"],
      transitions: []
    }
    assert.throws(
      () =>
        MachineTest.compileModel({
          ...base,
          transitions: [{ source: "missing", trigger: { type: "event", event: "Go" }, reenter: false }]
        }),
      /invalid transition source/
    )
    assert.throws(
      () =>
        MachineTest.compileModel({
          ...base,
          transitions: [
            { source: "idle", trigger: { type: "event", event: "Go" }, reenter: false },
            { source: "idle", trigger: { type: "event", event: "Go" }, target: "idle", reenter: true }
          ]
        }),
      /duplicate transition/
    )
    assert.throws(
      () =>
        MachineTest.compileModel({
          ...base,
          roots: [{ _tag: "History", key: "recent", history: "shallow", fallback: "idle" }],
          initial: "recent"
        }),
      /root history state/
    )
    assert.throws(
      () =>
        MachineTest.compileModel({
          roots: [{
            _tag: "Compound",
            key: "root",
            value: 0,
            initial: "recent",
            states: [
              { _tag: "Atomic", key: "idle", value: 1 },
              { _tag: "History", key: "recent", history: "deep", fallback: "root.idle" }
            ]
          }],
          initial: "root",
          events: ["Go"],
          transitions: []
        }),
      /unknown initial child/
    )

    assert.throws(
      () =>
        MachineTest.compileModel({
          ...base,
          transitions: [{
            source: "idle",
            trigger: { type: "always" },
            reenter: false
          }]
        } as unknown as MachineTest.FiniteModel),
      /event-only reenter option/
    )

    assert.throws(
      () =>
        MachineTest.compileModel({
          roots: [{
            _tag: "Compound",
            key: "root",
            value: 0,
            initial: "idle",
            states: [{ _tag: "Atomic", key: "idle", value: 1 }]
          }],
          initial: "root",
          events: ["Unused"],
          transitions: [{
            source: "root",
            trigger: { type: "done" },
            reenter: false
          }]
        } as unknown as MachineTest.FiniteModel),
      /event-only reenter option/
    )
  })

  it("rejects forged history scenarios that cannot replay their promised witness", () => {
    const witnessModel = (
      historyType: "shallow" | "deep",
      mutationSource: "root.work.phase.idle" | "root.work.other"
    ): MachineTest.FiniteModel => {
      const history = "root.work.recent"
      const scenario: MachineTest.FiniteHistoryScenario = {
        history,
        owner: "root.work",
        historyType,
        mutation: { source: mutationSource, event: "Mutate", target: mutationSource, value: 100 },
        leave: { source: "root.work.phase.idle", event: "Leave", target: "outside" },
        resume: { source: "outside", event: "Leave", target: history },
        events: ["Mutate", "Leave", "Leave"]
      }
      return {
        roots: [
          {
            _tag: "Compound",
            key: "root",
            value: 0,
            initial: "work",
            states: [{
              _tag: "Compound",
              key: "work",
              value: 1,
              initial: "phase",
              states: [
                {
                  _tag: "Compound",
                  key: "phase",
                  value: 2,
                  initial: "idle",
                  states: [{ _tag: "Atomic", key: "idle", value: 3 }]
                },
                { _tag: "Atomic", key: "other", value: 4 },
                { _tag: "History", key: "recent", history: historyType, fallback: "root.work.phase" }
              ]
            }]
          },
          { _tag: "Atomic", key: "outside", value: 5 }
        ],
        initial: "root",
        events: ["Mutate", "Leave"],
        transitions: [
          {
            source: mutationSource,
            trigger: { type: "event", event: "Mutate" },
            target: mutationSource,
            targetValue: 100,
            reenter: false
          },
          {
            source: "root.work.phase.idle",
            trigger: { type: "event", event: "Leave" },
            target: "outside",
            reenter: false
          },
          { source: "outside", trigger: { type: "event", event: "Leave" }, target: history, reenter: false }
        ],
        historyScenarios: [scenario]
      }
    }

    const valid = witnessModel("deep", "root.work.phase.idle")
    assert.doesNotThrow(() => MachineTest.compileModel(valid))
    assert.throws(
      () => MachineTest.compileModel(witnessModel("shallow", "root.work.phase.idle")),
      /invalid history mutation/
    )
    assert.throws(
      () => MachineTest.compileModel(witnessModel("deep", "root.work.other")),
      /invalid history mutation/
    )
    assert.throws(
      () =>
        MachineTest.compileModel({
          ...valid,
          historyScenarios: [{
            ...valid.historyScenarios![0]!,
            events: ["Mutate", "Leave"] as any
          }]
        }),
      /inconsistent history events/
    )
    assert.throws(
      () =>
        MachineTest.compileModel({
          ...valid,
          historyScenarios: [valid.historyScenarios![0]!, valid.historyScenarios![0]!]
        }),
      /duplicate history scenario/
    )
  })
})
