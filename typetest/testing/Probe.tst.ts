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
    events: Machine.events(PublicEvent),
    internalEvents: Machine.internalEvents(InternalEvent),
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

  it("infers causal command evidence and probe-bound asynchronous observations", () => {
    const started = Machine.start(machine)
    const executed = Effect.flatMap(
      started,
      (ref) =>
        Effect.flatMap(MachineTest.probe(machine, ref), (probe) =>
          MachineTest.runCausalCommands(probe, [
            MachineTest.sendCommand(new PublicEvent({}))
          ], {
            initialModel: 0,
            transition: (model) =>
              Effect.succeed({
                model: model + 1,
                expected: model + 1,
                await: probe.await.until((snapshot) => {
                  expect(snapshot.state.value).type.toBe<State>()
                  return snapshot.state.value.count >= 0
                })
              }),
            assert: ({ actual }) => {
              expect(actual.result).type.toBe<MachineTest.CausalRuntimeCommandResult<typeof machine>>()
              if (actual.result._tag === "SendProcessed") {
                expect(actual.result.step).type.toBe<MachineTest.ProbeStep<typeof machine>>()
                expect(actual.result.step.event).type.toBe<PublicEvent>()
              }
              return Effect.void
            }
          }))
    )

    expect<Effect.Success<typeof executed>["finalModel"]>().type.toBe<number>()
    expect<Effect.Success<typeof executed>["records"][number]["actual"]["result"]>().type.toBe<
      MachineTest.CausalRuntimeCommandResult<typeof machine>
    >()
    type CausalFailure = Extract<
      Effect.Error<typeof executed>,
      { readonly _tag: "MachineTestCausalRuntimeCommandFailure" }
    >
    expect<CausalFailure>().type.not.toBe<never>()
  })

  it("infers reusable runtime laws and law-oriented causal verification", () => {
    const invariant = MachineTest.runtimeInvariants(machine)
    const laws = [
      invariant.snapshot("state is typed", ({ snapshot, command }) => {
        expect(snapshot.state.value).type.toBe<State>()
        expect(command).type.toBe<MachineTest.RuntimeCommand<PublicEvent> | undefined>()
        return snapshot.state.value.count >= 0
      }),
      invariant.command("public commands are typed", ({ command, result }) => {
        expect(command).type.toBe<MachineTest.RuntimeCommand<PublicEvent>>()
        expect(result).type.toBe<MachineTest.CausalRuntimeCommandResult<typeof machine>>()
        return true
      }),
      invariant.transcript("transcript is typed", ({ transcript }) => {
        expect(transcript.records[0]!.command).type.toBe<MachineTest.RuntimeCommand<PublicEvent>>()
        return true
      })
    ]
    const verified = Effect.flatMap(
      Machine.start(machine),
      (ref) =>
        Effect.flatMap(MachineTest.probe(machine, ref), (probe) =>
          MachineTest.verifyCausalCommands(probe, [
            MachineTest.sendCommand(new PublicEvent({}))
          ], { invariants: laws }))
    )

    expect<Effect.Success<typeof verified>>().type.toBe<
      MachineTest.CausalVerificationTranscript<
        typeof machine,
        MachineTest.RuntimeInvariantErrorChannel<typeof machine>,
        never
      >
    >()
    expect<Effect.Success<typeof verified>["records"][number]["actual"]["result"]>().type.toBe<
      MachineTest.CausalRuntimeCommandResult<typeof machine>
    >()
    type InvariantFailure = Extract<Effect.Error<typeof verified>, MachineTest.RuntimeInvariantError<typeof machine>>
    expect<InvariantFailure>().type.not.toBe<never>()

    const agreement = Effect.flatMap(
      verified,
      (transcript) => MachineTest.assertPlannerRuntimeAgreement(machine, transcript)
    )
    type AgreementFailure = Extract<
      Effect.Error<typeof agreement>,
      MachineTest.PlannerRuntimeAgreementError<typeof machine>
    >
    expect<AgreementFailure>().type.not.toBe<never>()
  })
})
