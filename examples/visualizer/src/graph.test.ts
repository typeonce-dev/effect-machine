import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { buildDiagramGraph } from "./graph.ts"
import { VisualizerMachine } from "./machine.ts"

describe("diagram graph", () => {
  it("lays out nested and parallel state nodes using public inspection data", () => {
    const graph = buildDiagramGraph(VisualizerMachine)
    const application = graph.nodes.find(({ path }) => path === "application")
    const editing = graph.nodes.find(({ path }) => path === "application.workflow.running.editing")
    const online = graph.nodes.find(({ path }) => path === "application.connection.online")

    expect(application?.type).toBe("parallel")
    expect(editing?.depth).toBe(3)
    expect(online?.depth).toBe(2)
    expect(graph.nodes.every((node) => node.x >= 0 && node.y >= 0)).toBe(true)
    expect(graph.nodes.every((node) => node.x + node.width <= graph.width)).toBe(true)
    expect(graph.nodes.every((node) => node.y + node.height <= graph.height)).toBe(true)
  })

  it("keeps declared transition targets available to the renderer", () => {
    const graph = buildDiagramGraph(VisualizerMachine)
    const start = graph.transitions.find((transition) =>
      transition.trigger.type === "event" && transition.trigger.event === "Start"
    )

    expect(start).toMatchObject({
      source: "application.workflow.idle",
      targets: {
        type: "declared",
        paths: ["application.workflow.running"]
      }
    })
    expect(graph.transitions.every(({ targets }) => targets.type === "declared")).toBe(true)
  })

  it("routes annotated transitions through choice nodes", () => {
    class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
    class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {}
    class Go extends Schema.TaggedClass<Go>("Go")("Go", {}) {}
    const states = Machine.defineStates({ idle: Idle, decide: { type: "choice" }, done: Done })
    const machine = Machine.make({
      states: states.states,
      events: [Go],
      initial: () => states.initial.idle(new Idle({}))
    }).handle({
      idle: {
        on: {
          Go: {
            choice: "decide",
            targets: ["done"],
            transition: ({ target }) => target.full.done(new Done({}))
          }
        }
      }
    })

    const graph = buildDiagramGraph(machine)
    expect(graph.nodes.find(({ path }) => path === "decide")?.type).toBe("choice")
    expect(graph.transitions[0]).toMatchObject({ choice: "decide" })
  })
})
