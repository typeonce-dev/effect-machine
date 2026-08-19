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

  const States = Machine.states({ idle: Idle, done: Done })
  const machine = Machine.make({
    states: States.states,
    events: Machine.events(Start),
    initial: {
      target: (to) => to.idle(),
      resolve: ({ target }) => (target(new Idle({})))
    }
  }).handle({
    idle: {
      on: {
        Start: Machine.transition({
          target: (to) => to.full.done(),
          resolve: ({ target }) => target(new Done({}))
        })
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
    expect(result.transitions.definitions.hits[0]!.source).type.toBe<"idle" | "done">()
    expect(result.transitions.definitions.hits[0]!.trigger).type.toBe<Machine.Machine.TransitionTrigger<"Start">>()
    expect(result.transitions.definitions.hits[0]!.acceptance).type.toBe<Machine.Machine.TransitionAcceptance>()
    expect(result.transitions.branches.hits[0]!.source).type.toBe<"idle" | "done">()
    expect(result.transitions.branches.hits[0]!.trigger).type.toBe<Machine.Machine.TransitionTrigger<"Start">>()
    expect(result.transitions.branches.hits[0]!.acceptance).type.toBe<Machine.Machine.TransitionAcceptance>()
    expect(result.transitions.branches.hits[0]!.branch).type.toBe<
      Machine.Machine.TransitionBranch<"idle" | "done">
    >()
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
