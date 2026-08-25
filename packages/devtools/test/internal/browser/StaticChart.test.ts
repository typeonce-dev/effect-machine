import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { layoutChart } from "../../../src/internal/browser/chart-layout.js"
import { makeChartModel } from "../../../src/internal/browser/chart-model.js"
import { machine, snapshot } from "../../../src/internal/browser/example-machine.js"
import { plannerMachine } from "../../../src/internal/browser/planner-example.js"
import * as MachineDocument from "../../../src/MachineDocument.js"

describe("Static chart", () => {
  it("projects state fields, invocation metadata, and transition branches", () => {
    const document = MachineDocument.make(plannerMachine)
    const model = makeChartModel(document)
    const idle = model.nodes.find((node) => node.path === "Idle")
    const working = model.nodes.find((node) => node.path === "Working")

    assert.deepStrictEqual(idle?.fields, [{
      key: "owner",
      label: "owner",
      type: "string",
      required: true
    }])
    assert.deepStrictEqual(working?.fields.map(({ key, type }) => ({ key, type })), [
      { key: "owner", type: "string" },
      { key: "job", type: "string" }
    ])
    assert.deepStrictEqual(working?.activities.map(({ kind, label }) => ({ kind, label })), [
      { kind: "effect", label: "monitor-job" }
    ])
    assert.deepStrictEqual(
      model.edges.filter((edge) => edge.transitionId === "Idle:transition:0").map((edge) => edge.label),
      ["Begin · 2 branches"]
    )
    assert.deepStrictEqual(model.initials.map(({ target }) => target), ["Idle"])
  })

  it("computes nested node coordinates and orthogonal transition routes", async () => {
    const model = makeChartModel(MachineDocument.make(machine, { snapshot }))
    const layout = await Effect.runPromise(layoutChart(model))
    const application = layout.nodes.find(({ node }) => node.path === "application")
    const idle = layout.nodes.find(({ node }) => node.path === "application.workflow.idle")
    const transitionEdges = layout.edges.filter((edge) => edge.kind === "transition")

    assert.strictEqual(layout.nodes.length, model.nodes.length)
    assert.isAbove(layout.width, 0)
    assert.isAbove(layout.height, 0)
    assert.isAbove(application?.width ?? 0, idle?.width ?? 0)
    assert.strictEqual(transitionEdges.length, model.edges.length)
    assert.isTrue(transitionEdges.every((edge) => edge.points.length >= 2))
  })
})
