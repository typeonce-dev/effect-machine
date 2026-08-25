import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { layoutChart } from "../../../src/internal/browser/chart-layout.js"
import { makeChartModel } from "../../../src/internal/browser/chart-model.js"
import {
  chartWheelZoom,
  chartZoomScrollPosition,
  isChartPan,
  maximumChartZoom,
  minimumChartZoom
} from "../../../src/internal/browser/chart-renderer.js"
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
    assert.deepStrictEqual(
      model.edges.find((edge) => edge.transitionId === "Idle:transition:0")?.branchIds,
      ["Idle:transition:0:branch:0", "Idle:transition:0:branch:1"]
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

  it("lays out targetless transitions as self-loops", async () => {
    const model = makeChartModel(MachineDocument.make(machine, { snapshot }))
    const refresh = model.edges.find((edge) => edge.label === "Refresh")

    assert.strictEqual(refresh?.kind, "targetless")
    assert.strictEqual(refresh?.target, null)
    assert.deepStrictEqual(refresh?.branchIds, ["application.workflow.idle:transition:1:branch:0"])

    const layout = await Effect.runPromise(layoutChart(model))
    const laidOut = layout.edges.find((edge) => edge.kind === "transition" && edge.edge.id === refresh?.id)
    assert.strictEqual(laidOut?.kind, "transition")
    if (laidOut?.kind === "transition") {
      assert.strictEqual(laidOut.edge.source, "application.workflow.idle")
      assert.strictEqual(laidOut.edge.target, null)
      assert.isAtLeast(laidOut.points.length, 3)
      assert.isAtLeast(
        Math.max(...laidOut.points.map(({ x }) => x)) - Math.min(...laidOut.points.map(({ x }) => x)),
        30
      )
    }
  })

  it("lays out runtime-resolved targets as explicit stubs", async () => {
    const document = MachineDocument.make(plannerMachine)
    const source = document.states.find(({ path }) => path === "Idle")!
    const runtimeTransition: MachineDocument.Transition = {
      id: "Idle:transition:runtime",
      source: source.path,
      trigger: { type: "event", event: "ResolveTarget" },
      reenter: false,
      acceptance: "required",
      branches: [{
        id: "Idle:transition:runtime:branch:0",
        type: "direct",
        target: null,
        selection: { path: null, kind: "state", scope: "full" },
        updates: []
      }]
    }
    const model = makeChartModel({
      ...document,
      transitions: [...document.transitions, runtimeTransition]
    })
    const runtime = model.edges.find(({ transitionId }) => transitionId === runtimeTransition.id)
    if (runtime === undefined) assert.fail("Expected a runtime transition edge")

    assert.strictEqual(runtime.kind, "runtime")
    assert.strictEqual(runtime.target, null)
    assert.deepStrictEqual(model.runtimeTargets, [{
      id: `runtime:${runtime.id}`,
      edgeId: runtime.id,
      parent: null,
      label: "runtime target"
    }])

    const layout = await Effect.runPromise(layoutChart(model))
    assert.strictEqual(layout.runtimeTargets.length, 1)
    assert.isTrue(layout.edges.some((edge) => edge.kind === "transition" && edge.edge.id === runtime.id))
  })

  it("keeps the point below the pointer fixed while zooming", () => {
    assert.deepStrictEqual(
      chartZoomScrollPosition(1, 2, 200, 100, { x: 100, y: 50 }),
      { x: 500, y: 250 }
    )
  })

  it("maps wheel gestures to bounded zoom levels", () => {
    assert.isAbove(chartWheelZoom(1, -100, 0, 800), 1)
    assert.isBelow(chartWheelZoom(1, 100, 0, 800), 1)
    assert.strictEqual(chartWheelZoom(1, -10_000, 0, 800), maximumChartZoom)
    assert.strictEqual(chartWheelZoom(1, 10_000, 0, 800), minimumChartZoom)
  })

  it("only treats pointer movement at or beyond the threshold as panning", () => {
    assert.isFalse(isChartPan({ x: 0, y: 0 }, { x: 2, y: 2 }))
    assert.isTrue(isChartPan({ x: 0, y: 0 }, { x: 3, y: 4 }))
  })
})
