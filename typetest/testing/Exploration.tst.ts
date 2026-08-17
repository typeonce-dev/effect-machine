import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

describe("MachineTest exploration", () => {
  class Input extends Schema.Class<Input>("Input")({ seed: Schema.Int }) {}
  class Counter extends Schema.TaggedClass<Counter>("Counter")("Counter", { count: Schema.Int }) {}
  class Increment extends Schema.TaggedClass<Increment>("Increment")("Increment", {}) {}
  class Internal extends Schema.TaggedClass<Internal>("Internal")("Internal", {}) {}

  const States = Machine.defineStates({ counter: Counter })
  const machine = Machine.make({
    states: States.states,
    events: Machine.events(Increment),
    internalEvents: Machine.internalEvents(Internal),
    input: Input,
    initial: {
      target: (to) => to.counter(),
      resolve: ({ input, target }) => target(new Counter({ count: input.seed }))
    }
  }).handle({
    counter: {
      on: {
        Increment: Machine.transition({
          target: (to) => to.none(),
          resolve: () => undefined
        }),
        Internal: Machine.transition({
          target: (to) => to.none(),
          resolve: () => undefined
        })
      }
    }
  })

  it("infers input, state, public events, and state keys", () => {
    const explored = MachineTest.explore(machine, {
      input: new Input({ seed: 0 }),
      events: (context) => {
        expect(context.snapshot.value).type.toBe<Counter>()
        expect(context.configuration[0]).type.toBe<"counter" | undefined>()
        return [new Increment({})]
      },
      stateKey: (context) => {
        expect(context.trace).type.toBe<MachineTest.Trace<typeof machine>>()
        return context.snapshot.value.count
      }
    })

    expect<Effect.Success<typeof explored>>().type.toBe<MachineTest.Exploration<typeof machine, number>>()
    expect<Effect.Error<typeof explored>>().type.toBe<
      | MachineTest.RunFailure<MachineTest.RunError<typeof machine>, typeof machine>
      | MachineTest.InvariantError<typeof machine>
    >()
    expect<Effect.Services<typeof explored>>().type.toBe<never>()

    type Exploration = Effect.Success<typeof explored>
    expect<Exploration["transitionCoverage"]["definitions"]["hits"][number]["source"]>().type.toBe<"counter">()
    expect<Exploration["transitionCoverage"]["branches"]["hits"][number]["trigger"]>().type.toBe<
      Machine.Machine.TransitionTrigger<"Increment" | "Internal">
    >()
    expect<Exploration["transitionCoverage"]["branches"]["hits"][number]["branch"]>().type.toBe<
      Machine.Machine.TransitionBranch<"counter">
    >()
  })

  it("keeps reachability witnesses and errors machine-specific", () => {
    const exploration = {} as MachineTest.Exploration<typeof machine, number>
    const reachable = MachineTest.assertReachable(exploration, "one", ({ key, snapshot }) => {
      expect(key).type.toBe<number>()
      expect(snapshot.value).type.toBe<Counter>()
      return key === 1
    })
    const unreachable = MachineTest.assertUnreachable(exploration, "two", ({ key }) => key === 2)

    expect<Effect.Success<typeof reachable>>().type.toBe<MachineTest.ExplorationNode<typeof machine, number>>()
    expect<Effect.Error<typeof reachable>>().type.toBe<MachineTest.ReachabilityError<typeof machine, number>>()
    expect<Effect.Success<typeof unreachable>>().type.toBe<void>()
    expect<Effect.Error<typeof unreachable>>().type.toBe<MachineTest.ReachabilityError<typeof machine, number>>()
  })

  it("forbids input for machines without an input schema", () => {
    const noInput = Machine.make({
      states: States.states,
      events: Machine.events(Increment),
      initial: {
        target: (to) => to.counter(),
        resolve: ({ target }) => (target(new Counter({ count: 0 })))
      }
    }).handle({ counter: {} })
    type Options = MachineTest.ExploreOptions<typeof noInput, string>
    expect<Options["input"]>().type.toBe<undefined>()
  })
})
