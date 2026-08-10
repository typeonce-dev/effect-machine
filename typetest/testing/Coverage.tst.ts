import * as Effect from "effect/Effect"
import * as Graph from "effect/Graph"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

describe("MachineTest coverage and observed graph", () => {
  class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
  class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {}
  class Start extends Schema.TaggedClass<Start>("Start")("Start", {}) {}

  const States = Machine.defineStates({ idle: Idle, done: Done })
  const machine = Machine.make({
    states: States.states,
    events: [Start],
    initial: () => States.initial.idle(new Idle({}))
  }).handle({
    idle: {
      on: {
        Start: {
          targets: ["done"],
          transition: ({ target }) => target.full.done(new Done({}))
        }
      }
    },
    done: {}
  })
  const trace = {} as MachineTest.Trace<typeof machine>

  it("preserves machine-specific paths and public event tags in coverage", () => {
    const result = MachineTest.coverage(machine, trace)

    expect(result).type.toBe<MachineTest.Coverage<typeof machine>>()
    if (result.events.available) expect(result.events.hits[0]!.tag).type.toBe<"Start">()
    expect(result.states.activation.hits[0]!.path).type.toBe<"idle" | "done">()
    expect(result.transitions.hits[0]!.source).type.toBe<"idle" | "done">()
    expect(result.transitions.hits[0]!.trigger).type.toBe<Machine.Machine.TransitionTrigger<"Start">>()
  })

  it("returns an Effect graph with typed nodes and concrete edge evidence", () => {
    const result = MachineTest.observedGraph(machine, trace)

    expect<Effect.Success<typeof result>>().type.toBe<MachineTest.ObservedGraph<typeof machine>>()
    expect<Effect.Success<typeof result>["graph"]>().type.toBe<
      Graph.DirectedGraph<
        MachineTest.ObservedGraphNode<typeof machine>,
        MachineTest.ObservedGraphEdge<typeof machine>
      >
    >()
    expect<Effect.Error<typeof result>>().type.toBe<Machine.MachineSchemaEncodeError>()
    expect<Effect.Services<typeof result>>().type.toBe<never>()

    type Node = MachineTest.ObservedGraphNode<typeof machine>
    type Edge = MachineTest.ObservedGraphEdge<typeof machine>
    expect<Node["configuration"][number]>().type.toBe<"idle" | "done">()
    expect<Extract<Edge, { readonly _tag: "Event" }>["event"]>().type.toBe<Start>()
  })
})
