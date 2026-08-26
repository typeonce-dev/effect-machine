import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeChartLayoutPolicy } from "../../../src/internal/browser/chart-layout-policy.js"
import {
  chartEdgeTerminalClearance,
  chartSelfLoopLabelGap,
  ensureChartEdgeTerminalClearance,
  layoutChart,
  selfLoopLabelPosition
} from "../../../src/internal/browser/chart-layout.js"
import { type ChartModel, type ChartNode, makeChartModel } from "../../../src/internal/browser/chart-model.js"
import {
  chartWheelZoom,
  chartZoomScrollPosition,
  isChartPan,
  maximumChartZoom,
  minimumChartZoom
} from "../../../src/internal/browser/chart-renderer.js"
import { machine, snapshot } from "../../../src/internal/browser/example-machine.js"
import { invokeOutcomesMachine } from "../../../src/internal/browser/invoke-outcomes-example.js"
import { parallelCompletionMachine } from "../../../src/internal/browser/parallel-completion-example.js"
import { plannerMachine } from "../../../src/internal/browser/planner-example.js"
import * as MachineDocument from "../../../src/MachineDocument.js"

describe("Static chart", () => {
  it("keeps an orthogonal terminal segment clear for the arrowhead", () => {
    assert.deepStrictEqual(
      ensureChartEdgeTerminalClearance([
        { x: 100, y: 20 },
        { x: 60, y: 20 },
        { x: 60, y: 40 },
        { x: 50, y: 40 }
      ]),
      [
        { x: 100, y: 20 },
        { x: 74, y: 20 },
        { x: 74, y: 40 },
        { x: 50, y: 40 }
      ]
    )
  })

  it("places self-transition labels outside the loop", () => {
    const points = [
      { x: 20, y: 0 },
      { x: 20, y: 50 },
      { x: 80, y: 50 },
      { x: 80, y: 0 }
    ]

    assert.deepStrictEqual(selfLoopLabelPosition(points, 72, 26), {
      x: 50,
      y: 50 + chartSelfLoopLabelGap + 13
    })
  })

  it("derives a left-to-right policy from initial reachability", () => {
    const node = (path: string, type: ChartNode["type"] = "atomic"): ChartNode => ({
      path,
      label: path,
      type,
      parent: null,
      children: [],
      active: false,
      initial: path === "Idle",
      fields: [],
      activities: []
    })
    const model: ChartModel = {
      machineId: "layout-policy",
      roots: ["Idle", "Detached", "Done"],
      nodes: [node("Idle"), node("Detached"), node("Done", "final")],
      edges: [
        {
          id: "advance",
          transitionId: "advance",
          branchIds: ["advance"],
          kind: "target",
          source: "Idle",
          target: "Done",
          label: "Advance",
          trigger: { type: "event", event: "Advance" },
          activityKind: null,
          reenter: false,
          acceptance: "required"
        },
        {
          id: "return",
          transitionId: "return",
          branchIds: ["return"],
          kind: "target",
          source: "Done",
          target: "Idle",
          label: "Return",
          trigger: { type: "event", event: "Return" },
          activityKind: null,
          reenter: false,
          acceptance: "required"
        },
        {
          id: "refresh",
          transitionId: "refresh",
          branchIds: ["refresh"],
          kind: "targetless",
          source: "Idle",
          target: null,
          label: "Refresh",
          trigger: { type: "event", event: "Refresh" },
          activityKind: null,
          reenter: false,
          acceptance: "required"
        }
      ],
      runtimeTargets: [],
      initials: [{ id: "initial:Idle", target: "Idle", parent: null }]
    }
    const policy = makeChartLayoutPolicy(model)

    assert.deepStrictEqual(policy.children(null).map(({ path }) => path), ["Idle", "Done", "Detached"])
    assert.deepStrictEqual(policy.node("Idle"), {
      reachable: true,
      rank: 0,
      order: 0,
      layerConstraint: null
    })
    assert.strictEqual(policy.node("Done").layerConstraint, "LAST")
    assert.strictEqual(policy.node("Detached").reachable, false)
    assert.deepStrictEqual(policy.edge(model.edges[0]!), {
      direction: "forward",
      sourceSide: "EAST",
      targetSide: "WEST"
    })
    assert.deepStrictEqual(policy.edge(model.edges[1]!), {
      direction: "backward",
      sourceSide: "WEST",
      targetSide: "EAST"
    })
    assert.deepStrictEqual(policy.edge(model.edges[2]!), {
      direction: "self",
      sourceSide: "SOUTH",
      targetSide: "SOUTH"
    })
  })

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

  it("links invoke outcome edges to their declared activity type", () => {
    const model = makeChartModel(MachineDocument.make(invokeOutcomesMachine))
    const activities = new Map(
      model.edges.flatMap((edge) =>
        edge.trigger.type === "invoke" && edge.activityKind !== null
          ? [[edge.trigger.id, edge.activityKind] as const]
          : []
      )
    )

    assert.deepStrictEqual(
      activities,
      new Map([
        ["load-document", "effect"],
        ["document-updates", "stream"],
        ["request-timeout", "timer"],
        ["status-worker", "process"],
        ["preview-worker", "machine"]
      ])
    )
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
    assert.isTrue(transitionEdges.every((edge) => {
      const bend = edge.points.at(-2)!
      const end = edge.points.at(-1)!
      return Math.abs(end.x - bend.x) + Math.abs(end.y - bend.y) >= chartEdgeTerminalClearance
    }))
    for (const initial of layout.initials) {
      const target = layout.nodes.find(({ node }) => node.path === initial.initial.target)
      assert.isBelow(initial.x + initial.width, target?.x ?? Number.POSITIVE_INFINITY)
    }
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
      const horizontalSpan = Math.max(...laidOut.points.map(({ x }) => x)) -
        Math.min(...laidOut.points.map(({ x }) => x))
      const verticalSpan = Math.max(...laidOut.points.map(({ y }) => y)) -
        Math.min(...laidOut.points.map(({ y }) => y))
      assert.isAtLeast(
        Math.max(horizontalSpan, verticalSpan),
        30
      )
      assert.isAbove(
        laidOut.label.y - laidOut.labelHeight / 2,
        Math.max(...laidOut.points.map(({ y }) => y))
      )
      assert.isAtMost(laidOut.label.y + laidOut.labelHeight / 2, layout.height)
      const source = model.nodes.find(({ path }) => path === laidOut.edge.source)
      const parent = source?.parent === null
        ? undefined
        : layout.nodes.find(({ node }) => node.path === source?.parent)
      if (parent !== undefined) {
        assert.isAtMost(laidOut.label.y + laidOut.labelHeight / 2, parent.y + parent.height)
      }
    }
  })

  it("keeps a nested invoke self-loop label inside its compound parent", async () => {
    const model = makeChartModel(MachineDocument.make(parallelCompletionMachine))
    const layout = await Effect.runPromise(layoutChart(model))
    const edge = layout.edges.find((candidate) =>
      candidate.kind === "transition" &&
      candidate.edge.trigger.type === "invoke" &&
      candidate.edge.trigger.id === "packing-sla"
    )
    if (edge?.kind !== "transition") assert.fail("Expected the packing timer transition")
    const source = model.nodes.find(({ path }) => path === edge.edge.source)
    const parent = layout.nodes.find(({ node }) => node.path === source?.parent)
    if (parent === undefined) assert.fail("Expected the packing parent state")

    assert.strictEqual(edge.edge.activityKind, "timer")
    assert.isAtMost(edge.label.y + edge.labelHeight / 2, parent.y + parent.height)
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
