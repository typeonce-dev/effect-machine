import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

describe("MachineTest probe", () => {
  class State extends Schema.TaggedClass<State>("ProbeTypeState")("State", {
    count: Schema.Number
  }) {}
  class PublicEvent extends Schema.TaggedClass<PublicEvent>("ProbeTypePublicEvent")("PublicEvent", {}) {}
  class InternalEvent extends Schema.TaggedClass<InternalEvent>("ProbeTypeInternalEvent")("InternalEvent", {}) {}

  const states = Machine.defineStates({ State })
  const machine = Machine.make({
    states: states.states,
    events: [PublicEvent],
    internalEvents: [InternalEvent],
    initial: () => states.initial.State(new State({ count: 0 }))
  }).handle({
    State: {
      on: {
        PublicEvent: () => undefined,
        InternalEvent: () => undefined
      }
    }
  })

  it("retains the machine state and public event protocol", () => {
    const started = Machine.start(machine)
    const attached = Effect.flatMap(started, (ref) => MachineTest.probe(machine, ref))
    const sent = Effect.flatMap(attached, (probe) => probe.sendAndAwait(new PublicEvent({})))

    expect<Effect.Success<typeof attached>["machine"]>().type.toBe<typeof machine>()
    expect<Effect.Success<typeof sent>>().type.toBe<MachineTest.ProbeStep<typeof machine>>()
    expect<Effect.Success<typeof sent>["before"]["value"]>().type.toBe<State>()
    expect<Effect.Success<typeof sent>["event"]>().type.toBe<PublicEvent>()
    expect<Effect.Success<typeof sent>["plan"]["microsteps"][number]["event"]>().type.toBe<
      PublicEvent | InternalEvent | Machine.InitialEvent
    >()
    expect<InternalEvent>().type.not.toBeAssignableTo<Parameters<Effect.Success<typeof attached>["sendAndAwait"]>[0]>()
    expect<Machine.StoppedError>().type.toBeAssignableTo<Effect.Error<typeof sent>>()
    expect<MachineTest.ProbeUnavailableError>().type.toBeAssignableTo<Effect.Error<typeof attached>>()
  })
})
