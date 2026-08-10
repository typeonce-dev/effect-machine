import { FastCheck } from "effect/testing"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

describe("MachineTest finite models", () => {
  it("uses one discriminated trigger representation", () => {
    expect<MachineTest.FiniteTransition["trigger"]>().type.toBe<MachineTest.FiniteTransitionTrigger>()
    expect<MachineTest.FiniteTransitionTrigger>().type.toBe<
      | { readonly type: "event"; readonly event: string }
      | { readonly type: "always" }
      | { readonly type: "done" }
    >()
    expect<Extract<MachineTest.FiniteTransition, { readonly trigger: { readonly type: "event" } }>>()
      .type.toBe<MachineTest.FiniteEventTransition>()
    expect<Exclude<MachineTest.FiniteTransition, { readonly trigger: { readonly type: "event" } }>>()
      .type.toBe<MachineTest.FiniteAutomaticTransition>()
    expect<keyof MachineTest.FiniteEventTransition>().type.toBe<
      "source" | "trigger" | "target" | "targetValue" | "reenter"
    >()
    expect<keyof MachineTest.FiniteAutomaticTransition>().type.toBe<
      "source" | "trigger" | "target" | "targetValue"
    >()
  })

  const generated = MachineTest.finiteModels({
    maxRoots: 2,
    maxDepth: 3,
    maxChildren: 2,
    maxParallelRegions: 2,
    maxEvents: 2,
    maxTransitions: 8,
    maxHistoryStates: 2
  })

  it("exposes the model arbitrary and resolved diagnostics", () => {
    expect(generated.arbitrary).type.toBe<FastCheck.Arbitrary<MachineTest.FiniteModel>>()
    expect(generated.diagnostics.limits.maxRoots).type.toBe<1 | 2 | 3>()
    expect(generated.diagnostics.limits.maxParallelRegions).type.toBe<2 | 3>()
    expect(generated.diagnostics.limits.maxHistoryStates).type.toBe<number>()
    expect(generated.diagnostics.guarantees.parallelStates).type.toBe<true>()
    expect(generated.diagnostics.guarantees.historyStates).type.toBe<true>()
    expect(generated.diagnostics.guarantees.historyLeaveResumeSequences).type.toBe<true>()
    expect(generated.diagnostics.guarantees.historyValueScenarios).type.toBe<true>()
    expect(generated.diagnostics.guarantees.structurallyValid).type.toBe<true>()
    expect(generated.diagnostics.guarantees.eventlessTransitions).type.toBe<true>()
    expect(generated.diagnostics.guarantees.acyclicAutomaticTransitions).type.toBe<true>()
  })

  it("models atomic, final, compound, and parallel nodes", () => {
    const state = {} as MachineTest.FiniteState
    expect(state._tag).type.toBe<"Atomic" | "Final" | "Compound" | "Parallel" | "History" | "Choice">()
    if (state._tag === "Compound") {
      expect(state.initial).type.toBe<string>()
      expect(state.states).type.toBe<ReadonlyArray<MachineTest.FiniteState>>()
    }
    if (state._tag === "Final") {
      expect(state.output).type.toBe<string>()
    }
    if (state._tag === "Parallel") {
      expect(state).type.toBe<MachineTest.FiniteParallelState>()
      expect(state.output).type.toBe<string>()
      expect(state.states).type.toBe<ReadonlyArray<MachineTest.FiniteState>>()
    }
    if (state._tag === "History") {
      expect(state).type.toBe<MachineTest.FiniteHistoryState>()
      expect(state.history).type.toBe<"shallow" | "deep">()
      expect(state.fallback).type.toBe<string>()
    }
  })

  it("compiles to the public erased machine boundary", () => {
    const model: MachineTest.FiniteModel = {
      roots: [{ _tag: "Atomic", key: "idle", value: 0 }],
      initial: "idle",
      events: ["Tick"],
      transitions: [{ source: "idle", trigger: { type: "event", event: "Tick" }, target: "idle", reenter: false }]
    }
    const machine = MachineTest.compileModel(model)
    expect(machine).type.toBe<Machine.Machine.Any>()
    expect(MachineTest.scenarios(machine).arbitrary).type.toBe<
      FastCheck.Arbitrary<MachineTest.Scenario<Machine.Machine.Any>>
    >()
  })

  it("accepts a typed parallel model with deterministic output", () => {
    const model: MachineTest.FiniteModel = {
      roots: [{
        _tag: "Parallel",
        key: "root",
        value: 0,
        output: "complete",
        states: [
          { _tag: "Atomic", key: "left", value: 1 },
          { _tag: "Atomic", key: "right", value: 2 }
        ]
      }],
      initial: "root",
      events: ["Tick"],
      transitions: []
    }
    expect(model.roots[0]).type.toBe<MachineTest.FiniteState | undefined>()
    expect(MachineTest.compileModel(model)).type.toBe<Machine.Machine.Any>()
  })

  it("accepts typed history pseudo-states and history transition targets", () => {
    const history: MachineTest.FiniteHistoryState = {
      _tag: "History",
      key: "recent",
      history: "deep",
      fallback: "root.idle"
    }
    const model: MachineTest.FiniteModel = {
      roots: [{
        _tag: "Compound",
        key: "root",
        value: 0,
        initial: "idle",
        states: [{ _tag: "Atomic", key: "idle", value: 1 }, history]
      }],
      initial: "root",
      events: ["Restore"],
      transitions: [{
        source: "root.idle",
        trigger: { type: "event", event: "Restore" },
        target: "root.recent",
        reenter: true
      }]
    }
    expect(model.roots[0]).type.toBe<MachineTest.FiniteState | undefined>()
  })

  it("exposes exact generated history scenarios", () => {
    const model = {} as MachineTest.FiniteModel
    const scenario = {} as MachineTest.FiniteHistoryScenario
    expect(model.historyScenarios).type.toBe<ReadonlyArray<MachineTest.FiniteHistoryScenario> | undefined>()
    expect(scenario.historyType).type.toBe<"shallow" | "deep">()
    expect(scenario.mutation).type.toBe<MachineTest.FiniteHistoryMutation>()
    expect(scenario.leave).type.toBe<MachineTest.FiniteHistoryTransfer>()
    expect(scenario.resume).type.toBe<MachineTest.FiniteHistoryTransfer>()
    expect(scenario.events).type.toBe<readonly [mutation: string, leave: string, resume: string]>()
  })
})
