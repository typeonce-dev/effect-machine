import { Effect } from "effect"
import { describe, expect, it } from "tstyche"
import { MachineTest } from "../../src/testing/index.js"

describe("MachineTest finite-model reference interpreter", () => {
  const model: MachineTest.FiniteModel = {
    roots: [{ _tag: "Atomic", key: "idle", value: 0 }],
    initial: "idle",
    events: ["Tick"],
    transitions: [{ source: "idle", trigger: { type: "event", event: "Tick" }, reenter: false }]
  }
  const reference = MachineTest.interpretModel(model, ["Tick"])

  it("exposes stable reference state, step, and trace types", () => {
    expect(reference).type.toBe<MachineTest.ReferenceTrace>()
    expect(reference.initial).type.toBe<MachineTest.ReferenceInitialStep>()
    expect(reference.initial.state).type.toBe<MachineTest.ReferenceState>()
    expect(reference.steps[0]!).type.toBe<MachineTest.ReferenceStep>()
    expect(reference.steps[0]!.microsteps[0]!).type.toBe<MachineTest.ReferenceMicrostep>()
    expect(reference.steps[0]!.microsteps[0]!.transitions).type.toBe<
      ReadonlyArray<MachineTest.ReferenceTransition>
    >()
    expect(reference.initial.state.values.idle).type.toBe<MachineTest.ReferenceStateValue | undefined>()
    expect(reference.initial.state.completions[0]).type.toBe<MachineTest.ReferenceCompletion | undefined>()
    expect(reference.initial.state.history.idle).type.toBe<MachineTest.ReferenceHistoryRecord | undefined>()
    expect(reference.initial.state.status).type.toBe<"active" | "done">()
    expect(reference.initial.state.output).type.toBe<string | undefined>()
  })

  it("returns an Effect with only the structured model-verification error", () => {
    const machine = MachineTest.compileModel(model)
    const trace = {} as MachineTest.Trace<typeof machine>
    const verified = MachineTest.verifyModel(model, trace)

    expect<Effect.Success<typeof verified>>().type.toBe<void>()
    expect<Effect.Error<typeof verified>>().type.toBe<MachineTest.ModelVerificationError>()
    expect<Effect.Services<typeof verified>>().type.toBe<never>()

    const mismatch = {} as MachineTest.ModelVerificationMismatch
    expect(mismatch.location).type.toBe<MachineTest.ModelVerificationLocation>()
    expect(mismatch.location.phase).type.toBe<"initial" | "event" | "final">()
    expect(mismatch.field).type.toBe<MachineTest.ModelVerificationField>()
    expect(mismatch.expected).type.toBe<unknown>()
    expect(mismatch.actual).type.toBe<unknown>()
  })
})
