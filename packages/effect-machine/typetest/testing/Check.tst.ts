import { Machine } from "@typeonce/effect-machine"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"

const Events = Machine.events({ Add: { by: Schema.Number } })
const machine = Machine.make({
  root: Machine.state({ states: { Idle: { fields: { name: Schema.String } } } }),
  input: Schema.String,
  events: Events
}).handle({
  initial: { target: "Idle", data: ({ input }) => ({ name: input }) },
  states: { Idle: { on: { Add: { update: "Idle", data: ({ state }) => state } } } }
})

describe("MachineTest.check", () => {
  it("returns a report that cannot fail", () => {
    expect(MachineTest.check(machine)).type.toBe<Effect.Effect<MachineTest.CheckReport>>()
  })

  it("types input and events from the machine", () => {
    expect(MachineTest.check(machine, { input: "a", events: [Events.Add({ by: 1 })] })).type.not.toRaiseError()
    expect(MachineTest.check).type.not.toBeCallableWith(machine, { input: 1 })
  })

  it("narrows findings by law", () => {
    const finding = {} as MachineTest.CheckFinding
    if (finding.law === "topology.noPathFromInitial") expect(finding.path).type.toBe<string>()
    if (finding.law === "planning.deterministic") expect(finding.replay).type.toBe<MachineTest.CheckReplay>()
  })
})
