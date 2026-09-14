import { assert, describe, it } from "@effect/vitest"
import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"
import type { ElkNode } from "elkjs/lib/elk-api.js"
import {
  type ChartPoint,
  chartRouteLength,
  layoutChart,
  layoutChartWith,
  validateChartLayout
} from "../../../src/internal/browser/chart-layout.js"
import { type ChartModel, makeChartModel } from "../../../src/internal/browser/chart-model.js"
import * as MachineDocument from "../../../src/MachineDocument.js"

const copyButtonModel = (): ChartModel => {
  const root = Machine.state({
    states: {
      Idle: {},
      Working: { fields: { text: Schema.String }, states: { Clicked: {}, Copying: {} } },
      Copied: {},
      Failed: { fields: { message: Schema.String } }
    }
  })
  const targets = Machine.targets(root)
  const machine = Machine.make({
    id: "CopyButton",
    root,
    events: Machine.events({ Copy: { text: Schema.String } }),
    effects: { copy: (text: string) => text.length > 0 ? Effect.void : Effect.fail({ message: "failure" }) },
    timers: { clicked: "120 millis", confirmation: "2 seconds", errorFeedback: "1 second" }
  }).handle({
    initial: { target: targets.root.Idle },
    states: {
      Idle: {
        on: {
          Copy: {
            target: targets.root.Working,
            guard: ({ event }) => event.text.length > 0,
            data: ({ event }) => ({ text: event.text })
          }
        }
      },
      Working: {
        initial: { target: targets.root.Working.Clicked },
        invoke: {
          src: "copy",
          input: ({ state }) => state.text,
          onDone: { target: targets.root.Copied },
          onFailure: { target: targets.root.Failed, data: ({ error }) => ({ message: error.message }) }
        },
        states: {
          Clicked: { invoke: { src: "clicked", onDone: { target: targets.root.Working.Copying } } },
          Copying: {}
        }
      },
      Copied: { invoke: { src: "confirmation", onDone: { target: targets.root.Idle } } },
      Failed: {
        invoke: { src: "errorFeedback", onDone: { target: targets.root.Idle } },
        on: {
          Copy: {
            target: targets.root.Working,
            guard: ({ event }) => event.text.length > 0,
            data: ({ event }) => ({ text: event.text })
          }
        }
      }
    }
  })
  return makeChartModel(MachineDocument.make(machine))
}

const model = copyButtonModel()
const variants: ReadonlyArray<readonly [string, ChartModel]> = [
  ["original", model],
  ["reversed declarations", { ...model, nodes: [...model.nodes].reverse() }],
  ["reversed edges", { ...model, edges: [...model.edges].reverse() }],
  ["long labels", {
    ...model,
    edges: model.edges.map((edge) => ({ ...edge, label: edge.label + " with additional feedback details" }))
  }],
  ["without failure feedback", {
    ...model,
    edges: model.edges.filter((edge) => !(edge.source === "Failed" && edge.target === "Idle"))
  }],
  ["without success feedback", {
    ...model,
    edges: model.edges.filter((edge) => !(edge.source === "Copied" && edge.target === "Idle"))
  }]
]

describe("chart route endpoints", () => {
  it.each(variants)("routes CopyButton with %s", async (_name, model) => {
    const layout = await Effect.runPromise(layoutChart(model))
    const repeated = await Effect.runPromise(layoutChart(model))
    assert.deepStrictEqual(validateChartLayout(model, layout).issues, [])
    assert.deepStrictEqual(repeated, layout)
    const retry = layout.edges.find((edge) =>
      edge.kind === "transition" && edge.edge.source === "Failed" && edge.edge.target === "Working"
    )
    assert.isDefined(retry)
    assert.isAtLeast(chartRouteLength(retry!.points.slice(0, 2)), 9)
    assert.isAtLeast(chartRouteLength(retry!.points.slice(-2)), 9)
  })

  // Rotate the same geometry to exercise every side, then reverse the edge to
  // exercise source repair and terminal repair through the full layout pipeline.
  for (const turns of [0, 1, 2, 3]) {
    for (const reverse of [false, true]) {
      it(`preserves the opposite endpoint with ${turns} quarter turns and reverse=${reverse}`, async () => {
        const rotate = (point: ChartPoint): ChartPoint => {
          let result = point
          for (let turn = 0; turn < turns; turn++) result = { x: 600 - result.y, y: result.x }
          return result
        }
        const rect = (id: string, x: number, y: number, width: number, height: number): ElkNode => {
          const start = rotate({ x, y })
          const end = rotate({ x: x + width, y: y + height })
          return {
            id,
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            width: Math.abs(start.x - end.x),
            height: Math.abs(start.y - end.y)
          }
        }
        const points = [{ x: 250, y: 400 }, { x: 250, y: 300 }].map(rotate)
        if (reverse) points.reverse()
        const model: ChartModel = {
          machineId: "endpoint-repair",
          roots: ["A", "B"],
          nodes: ["A", "B"].map((path) => ({
            path,
            label: path,
            type: "atomic",
            parent: null,
            children: [],
            active: false,
            initial: false,
            activities: []
          })),
          edges: [{
            id: "edge",
            transitionId: "edge",
            branchIds: ["edge"],
            source: reverse ? "B" : "A",
            target: reverse ? "A" : "B",
            kind: "target",
            label: "go",
            accessibleLabel: "go",
            badges: [],
            trigger: { type: "event", event: "go" },
            activityKind: null,
            reenter: false,
            acceptance: "required"
          }],
          runtimeTargets: [],
          initials: []
        }
        const graph: ElkNode = {
          id: "graph",
          width: 600,
          height: 600,
          children: [rect("A", 200, 400, 180, 88), rect("B", 100, 100, 120, 200)],
          edges: [{
            id: "edge",
            sources: [model.edges[0]!.source],
            targets: [model.edges[0]!.target!],
            sections: [{ id: "section", startPoint: points[0]!, endPoint: points[1]! }]
          }]
        }
        const layout = await Effect.runPromise(layoutChartWith(model, async () => graph))
        assert.deepStrictEqual(validateChartLayout(model, layout).issues, [])
        const route = layout.edges[0]!.points
        assert.isAtLeast(chartRouteLength(route.slice(0, 2)), 9)
        assert.isAtLeast(chartRouteLength(route.slice(-2)), 9)
        for (let index = 1; index < route.length; index++) {
          assert.isTrue(route[index - 1]!.x === route[index]!.x || route[index - 1]!.y === route[index]!.y)
        }
      })
    }
  }
})
