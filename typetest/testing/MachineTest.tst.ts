import { Cause, Context, Data, Effect, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

describe("MachineTest", () => {
  class Input extends Schema.Class<Input>("Input")({ id: Schema.String }) {}
  class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
  class PublicEvent extends Schema.TaggedClass<PublicEvent>("PublicEvent")("PublicEvent", {
    value: Schema.Number
  }) {}
  class InternalEvent extends Schema.TaggedClass<InternalEvent>("InternalEvent")("InternalEvent", {}) {}

  const States = Machine.states({ idle: Idle })
  const machine = Machine.make({
    states: States.states,
    events: Machine.events(PublicEvent),
    internalEvents: Machine.internalEvents(InternalEvent),
    input: Input,
    initial: {
      target: (to) => to.idle(),
      resolve: ({ target }) => (target(new Idle({})))
    }
  }).handle({
    idle: {
      on: {
        PublicEvent: Machine.transition({
          target: (to) => to.none(),
          resolve: () => undefined
        }),
        InternalEvent: Machine.transition({
          target: (to) => to.none(),
          resolve: () => undefined
        })
      }
    }
  })

  it("preserves input and public event types in generated scenarios", () => {
    const generated = MachineTest.scenarios(machine)
    expect(generated.arbitrary).type.toBe<FastCheck.Arbitrary<MachineTest.Scenario<typeof machine>>>()

    type Scenario = MachineTest.Scenario<typeof machine>
    expect<Scenario["input"]>().type.toBe<Input>()
    expect<Scenario["events"][number]>().type.toBe<PublicEvent>()
    expect<InternalEvent>().type.not.toBeAssignableTo<Scenario["events"][number]>()
  })

  it("types whole-value arbitrary overrides", () => {
    const options: MachineTest.ScenarioOptions<typeof machine> = {
      inputArbitrary: FastCheck.constant(new Input({ id: "test" })),
      eventsArbitrary: FastCheck.constant([new PublicEvent({ value: 1 })])
    }
    expect(options.inputArbitrary).type.toBe<FastCheck.Arbitrary<Input> | undefined>()
    expect(options.eventsArbitrary).type.toBe<FastCheck.Arbitrary<ReadonlyArray<PublicEvent>> | undefined>()
  })

  it("omits input for machines without an input schema", () => {
    const noInput = Machine.make({
      states: States.states,
      events: Machine.events(PublicEvent),
      initial: {
        target: (to) => to.idle(),
        resolve: ({ target }) => (target(new Idle({})))
      }
    }).handle({ idle: {} })
    type Scenario = MachineTest.Scenario<typeof noInput>
    type Options = MachineTest.ScenarioOptions<typeof noInput>

    expect<keyof Scenario>().type.toBe<"events">()
    expect<Options["inputArbitrary"]>().type.toBe<undefined>()
  })

  it("retains typed trace plans and transition metadata", () => {
    const scenario: MachineTest.Scenario<typeof machine> = {
      input: new Input({ id: "test" }),
      events: [new PublicEvent({ value: 1 })]
    }
    const executed = MachineTest.run(machine, scenario)

    expect<Effect.Success<typeof executed>>().type.toBe<MachineTest.Trace<typeof machine>>()
    expect<Effect.Error<typeof executed>>().type.toBe<
      MachineTest.RunFailure<MachineTest.RunError<typeof machine>, typeof machine>
    >()

    expect<Effect.Success<typeof executed>["initial"]["startingConfiguration"][number]>().type.toBe<"idle">()
    expect<Effect.Success<typeof executed>["initial"]["initialEntryPaths"][number]>().type.toBe<"idle">()

    type InitialMicrostep = MachineTest.Trace<typeof machine>["initial"]["plan"]["microsteps"][number]
    type EventMicrostep = MachineTest.Trace<typeof machine>["steps"][number]["plan"]["microsteps"][number]
    expect<InitialMicrostep["transitions"][number]["source"]>().type.toBe<"idle">()
    expect<EventMicrostep["transitions"][number]["trigger"]>().type.toBe<
      Machine.Machine.TransitionTrigger<"PublicEvent" | "InternalEvent">
    >()
    expect<EventMicrostep["transitions"][number]["target"]>().type.toBe<"idle" | undefined>()
    expect<EventMicrostep["transitions"][number]["resolvedTarget"]>().type.toBe<"idle" | undefined>()

    const startup = Machine.planInitial(machine, new Input({ id: "test" }))
    type StartupMicrostep = Effect.Success<typeof startup>["microsteps"][number]
    expect<StartupMicrostep["transitions"][number]["source"]>().type.toBe<"idle">()
    expect<StartupMicrostep["transitions"][number]["trigger"]>().type.toBe<
      Machine.Machine.TransitionTrigger<"PublicEvent" | "InternalEvent">
    >()
  })

  it("does not require invoke services while planning scenarios", () => {
    class InvokeRequirement extends Context.Service<InvokeRequirement, string>()("InvokeRequirement") {}
    const invokedMachine = Machine.make({
      states: States.states,
      events: Machine.events(PublicEvent),
      initial: {
        target: (to) => to.idle(),
        resolve: ({ target }) => (target(new Idle({})))
      }
    }).handle({
      idle: {
        invoke: Machine.invoke({
          id: "service-backed-invoke",
          effect: () =>
            Effect.gen(function*() {
              yield* InvokeRequirement
            }),
          onDone: Machine.transition({
            target: (to) => to.none(),
            resolve: () => undefined
          })
        })
      }
    })

    const executed = MachineTest.run(invokedMachine, { events: [] })

    expect<Effect.Services<typeof executed>>().type.toBe<never>()
    expect<MachineTest.RunServices<typeof invokedMachine>>().type.toBe<never>()
  })

  it("keeps runtime commands on the public event protocol", () => {
    const generated = MachineTest.runtimeCommands(machine)
    expect(generated.arbitrary).type.toBe<
      FastCheck.Arbitrary<ReadonlyArray<MachineTest.RuntimeCommand<PublicEvent>>>
    >()
    expect(MachineTest.sendCommand(new PublicEvent({ value: 1 }))).type.toBe<
      MachineTest.RuntimeCommand<PublicEvent>
    >()
    expect(MachineTest.sendCommand(new InternalEvent({}))).type.not.toBeAssignableTo<
      MachineTest.RuntimeCommand<PublicEvent>
    >()
    expect(MachineTest.advanceCommand<PublicEvent>(100)).type.toBe<MachineTest.RuntimeCommand<PublicEvent>>()
    expect(MachineTest.stopCommand<PublicEvent>()).type.toBe<MachineTest.RuntimeCommand<PublicEvent>>()
    expect(MachineTest.checkpointCommand<PublicEvent>("after sends")).type.toBe<
      MachineTest.RuntimeCommand<PublicEvent>
    >()
  })

  it("preserves model and assertion errors and services in runtime command checks", () => {
    class ModelFailure extends Data.TaggedError("ModelFailure")<{}> {}
    class InspectionFailure extends Data.TaggedError("InspectionFailure")<{}> {}
    class AssertionFailure extends Data.TaggedError("AssertionFailure")<{}> {}
    class ModelRequirement extends Context.Service<ModelRequirement, string>()("ModelRequirement") {}
    class InspectionRequirement extends Context.Service<InspectionRequirement, string>()("InspectionRequirement") {}
    class AssertionRequirement extends Context.Service<AssertionRequirement, string>()("AssertionRequirement") {}
    const started = Machine.start(machine, new Input({ id: "test" }))
    type Ref = Effect.Success<typeof started>
    const ref = null as unknown as Ref
    const executed = MachineTest.runEnqueuedCommands(ref, [
      MachineTest.sendCommand(new PublicEvent({ value: 1 }))
    ], {
      initialModel: 0,
      transition: (model) =>
        Effect.gen(function*() {
          yield* ModelRequirement
          if (model < 0) return yield* Effect.fail(new ModelFailure())
          return {
            model: model + 1,
            expected: model + 1,
            synchronize: MachineTest.RuntimeSynchronization.next
          }
        }),
      inspect: () =>
        Effect.gen(function*() {
          const inspected = yield* InspectionRequirement
          if (inspected.length === 0) return yield* Effect.fail(new InspectionFailure())
          return inspected
        }),
      assert: () =>
        Effect.gen(function*() {
          yield* AssertionRequirement
          return yield* Effect.fail(new AssertionFailure())
        })
    })

    expect<Effect.Success<typeof executed>["finalModel"]>().type.toBe<number>()
    expect<Effect.Success<typeof executed>["records"][number]["actual"]["inspected"]>().type.toBe<
      string | undefined
    >()
    expect<Effect.Services<typeof executed>>().type.toBe<
      ModelRequirement | InspectionRequirement | AssertionRequirement
    >()
    expect<Effect.Error<typeof executed>["cause"]>().type.toBe<
      Cause.Cause<ModelFailure | InspectionFailure | AssertionFailure | MachineTest.RuntimeObservationError>
    >()
    expect<Effect.Error<typeof executed>["command"]>().type.toBe<MachineTest.RuntimeCommand<PublicEvent>>()
  })
})
