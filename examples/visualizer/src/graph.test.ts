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
})
