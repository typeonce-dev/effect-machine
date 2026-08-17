import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

describe("MachineTest.verify", () => {
  class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
  class Tick extends Schema.TaggedClass<Tick>("Tick")("Tick", {}) {}

  const States = Machine.states({ idle: Idle })
  const machine = Machine.make({
    states: States.states,
    events: Machine.events(Tick),
    initial: {
      target: (to) => to.idle(),
      resolve: ({ target }) => (target(new Idle({})))
    }
  }).handle({ idle: {} })

  const trace = {} as MachineTest.Trace<typeof machine>
  const verified = MachineTest.verify(machine, trace)

  it("has a void success and structured verification error", () => {
    expect<Effect.Success<typeof verified>>().type.toBe<void>()
    expect<Effect.Error<typeof verified>>().type.toBe<MachineTest.VerificationError>()
    expect<Effect.Services<typeof verified>>().type.toBe<never>()

    const error = {} as Effect.Error<typeof verified>
    expect(error.violations[0]!.law).type.toBe<MachineTest.VerificationLaw>()
    expect(error.violations[0]!.eventIndex).type.toBe<number | undefined>()
    expect(error.violations[0]!.microstepIndex).type.toBe<number | undefined>()
    expect(error.violations[0]!.path).type.toBe<string | undefined>()
  })

  it("accepts only canonical law groups", () => {
    const options: MachineTest.VerifyOptions = {
      laws: ["configuration", "microsteps", "completion", "history", "definitions"]
    }
    expect(options.laws).type.toBe<ReadonlyArray<MachineTest.VerificationLawGroup> | undefined>()
  })

  it("exposes exact transition resolution violations", () => {
    expect<"definitions.resolution">().type.toBeAssignableTo<MachineTest.VerificationLaw>()
  })
})
