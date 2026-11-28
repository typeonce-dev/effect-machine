import { Machine } from "@typeonce/effect-machine"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Data, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"

const Events = Machine.events({ Add: { by: Schema.Number } })
const machine = Machine.make({
  root: Machine.state({ states: { Idle: { fields: { name: Schema.String } } } }),
  input: Schema.String,
  events: Events
}).handle({
  initial: { target: "Idle", data: ({ input }) => ({ name: input }) },
  states: { Idle: { on: { Add: { update: { Idle: ({ state }) => state } } } } }
})

class LoadError extends Data.TaggedError("LoadError")<{}> {}

const Load = Machine.events({ Load: { id: Schema.String } })
const loader = Machine.make({
  root: Machine.state({ states: { Idle: {}, Loading: { fields: { id: Schema.String } }, Ready: {}, Failed: {} } }),
  events: Load,
  effects: {
    loadDocument: (id: string): Effect.Effect<string, LoadError> => Effect.succeed(`# ${id}`),
    count: Effect.succeed(1)
  },
  timers: { timeout: "1 second" }
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id }) } } },
    Loading: {
      invoke: [
        {
          src: "loadDocument",
          input: ({ state }) => state.id,
          onDone: { target: "Ready" },
          onFailure: { target: "Failed" }
        },
        { src: "count", onDone: { stay: true } },
        { src: "timeout", onDone: { target: "Failed" } }
      ]
    }
  }
})

describe("MachineTest.check", () => {
  it("returns a report that cannot fail", () => {
    expect(MachineTest.check(machine)).type.toBe<Effect.Effect<MachineTest.CheckReport>>()
  })

  it("types input and events from the machine", () => {
    expect(MachineTest.check(machine, { input: "a", events: [Events.Add({ by: 1 })] })).type.not.toRaiseError()
    expect(MachineTest.check).type.not.toBeCallableWith(machine, { input: 1 })
  })

  it("types outcomes from the Effect of each source, including one that takes input", () => {
    expect(MachineTest.check(loader, {
      outcomes: { loadDocument: { done: ["# Title"], failure: [new LoadError()] }, count: { done: [0, 2] } }
    })).type.not.toRaiseError()
    expect<Machine.Machine.EffectResults<typeof loader>>().type.toBe<{
      readonly loadDocument: Machine.Machine.EffectResult<string, LoadError>
      readonly count: Machine.Machine.EffectResult<number, never>
    }>()
  })

  it("rejects a value of the wrong type", () => {
    expect(MachineTest.check).type.not.toBeCallableWith(loader, { outcomes: { loadDocument: { done: [1] } } })
    expect(MachineTest.check).type.not.toBeCallableWith(loader, {
      outcomes: { loadDocument: { failure: [new Error("other")] } }
    })
  })

  it("rejects a failure for a source with no typed failure", () => {
    expect(MachineTest.check).type.not.toBeCallableWith(loader, { outcomes: { count: { failure: [] } } })
  })

  it("rejects a name that is not a registered Effect source", () => {
    expect(MachineTest.check).type.not.toBeCallableWith(loader, { outcomes: { missing: { done: [1] } } })
    // A timer elapses without outcomes, so it takes none.
    expect(MachineTest.check).type.not.toBeCallableWith(loader, { outcomes: { timeout: { done: [undefined] } } })
  })

  it("accepts no outcomes for a machine whose type was widened", () => {
    const widened: Machine.Machine.Any = loader
    expect<Machine.Machine.EffectResults<typeof widened>>().type.toBe<never>()
    expect<MachineTest.CheckOptions<typeof widened>["outcomes"]>().type.toBe<undefined>()
  })

  it("narrows findings by law", () => {
    const finding = {} as MachineTest.CheckFinding
    if (finding.law === "topology.noPathFromInitial") expect(finding.path).type.toBe<string>()
    if (finding.law === "planning.deterministic") expect(finding.replay).type.toBe<MachineTest.CheckReplay>()
    if (finding.law === "outcome.failsMachine") expect(finding.source).type.toBe<string | undefined>()
    if (finding.law === "outcomes.invalid") expect(finding.source).type.toBe<string>()
  })
})
