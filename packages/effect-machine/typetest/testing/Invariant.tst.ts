import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

describe("MachineTest invariants", () => {
  class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", { count: Schema.Int }) {}
  class Tick extends Schema.TaggedClass<Tick>("Tick")("Tick", { amount: Schema.Int }) {}
  class Internal extends Schema.TaggedClass<Internal>("Internal")("Internal", {}) {}

  const States = Machine.state({ initial: "idle", states: { idle: Idle } })

  const machine = Machine.make({
    root: States,
    events: Machine.eventsFromSchemas(Tick),
    internalEvents: Machine.internalEventsFromSchemas(Internal),
    initialConfiguration: (root) =>
      root.resolve(({ target }) => (target.from((to) => to.idle.decoded(new Idle({ count: 0 })))))
  }).handle({
    states: {
      idle: {
        on: {
          Tick: { none: true },
          Internal: { none: true }
        }
      }
    }
  })

  const define = MachineTest.invariants(machine)

  it("infers exact state, event, and trace evidence from a machine-bound builder", () => {
    const state = define.state("state", (context) => {
      expect(context.machine).type.toBe<typeof machine>()
      expect(context.snapshot.state.value).type.toBe<Idle>()
      expect(context.configuration[0]).type.toBe<"" | "idle" | undefined>()
      expect(context.event).type.toBe<Tick | Internal | Machine.InitialEvent | undefined>()
      return true
    })
    const step = define.step("step", (context) => {
      expect(context.event).type.toBe<Tick>()
      expect(context.before.state.value).type.toBe<Idle>()
      expect(context.after.state.value).type.toBe<Idle>()
      return true
    })
    const trace = define.trace("trace", (context) => {
      expect(context.trace).type.toBe<MachineTest.Trace<typeof machine>>()
      return true
    })

    expect(state).type.toBe<MachineTest.StateInvariant<typeof machine>>()
    expect(step).type.toBe<MachineTest.StepInvariant<typeof machine>>()
    expect(trace).type.toBe<MachineTest.TraceInvariant<typeof machine>>()
  })

  it("preserves the machine type through reports and structured errors", () => {
    const trace = {} as MachineTest.Trace<typeof machine>
    const checked = MachineTest.checkInvariants(machine, trace, [
      define.state("state", () => true),
      define.step("step", () => true),
      define.trace("trace", () => true)
    ])

    expect<Effect.Success<typeof checked>>().type.toBe<MachineTest.InvariantReport>()
    expect<Effect.Error<typeof checked>>().type.toBe<MachineTest.InvariantError<typeof machine>>()
    expect<Effect.Services<typeof checked>>().type.toBe<never>()
    expect<Effect.Error<typeof checked>["trace"]>().type.toBe<MachineTest.Trace<typeof machine>>()
    expect<Effect.Error<typeof checked>["violations"][number]["configuration"]>().type.toBe<
      ReadonlyArray<"" | "idle"> | undefined
    >()

    const asserted = MachineTest.assertInvariants(machine, trace, [define.state("state", () => true)])
    expect<Effect.Success<typeof asserted>>().type.toBe<void>()
    expect<Effect.Error<typeof asserted>>().type.toBe<MachineTest.InvariantError<typeof machine>>()
  })

  it("supports direct constructors with an explicit machine type", () => {
    const direct = MachineTest.Invariant.step<typeof machine>("direct", ({ event }) => event.amount >= 0)
    expect(direct).type.toBe<MachineTest.StepInvariant<typeof machine>>()
  })
})
