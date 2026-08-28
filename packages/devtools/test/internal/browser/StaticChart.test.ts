import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { ELK as ElkApi, ELKConstructorArguments, ElkNode } from "elkjs/lib/elk-api.js"
import ELKBundle from "elkjs/lib/elk.bundled.js"
import { makeChartLayoutPolicy } from "../../../src/internal/browser/chart-layout-policy.js"
import {
  chartEdgeLabelSpacing,
  chartRouteLength,
  chartSelfLoopMinimumClearance,
  layoutChart,
  layoutChartWith,
  validateChartLayout
} from "../../../src/internal/browser/chart-layout.js"
import { type ChartModel, type ChartNode, makeChartModel } from "../../../src/internal/browser/chart-model.js"
import {
  chartDirectionCue,
  chartEdgePathData,
  chartWheelZoom,
  chartZoomScrollPosition,
  isChartPan,
  maximumChartZoom,
  minimumChartZoom
} from "../../../src/internal/browser/chart-renderer.js"
import { machine, snapshot } from "../../../src/internal/browser/example-machine.js"
import { hierarchyRoutingMachine } from "../../../src/internal/browser/hierarchy-routing-example.js"
import { invokeOutcomesMachine } from "../../../src/internal/browser/invoke-outcomes-example.js"
import { layoutResilienceMachine } from "../../../src/internal/browser/layout-resilience-example.js"
import { parallelCompletionMachine } from "../../../src/internal/browser/parallel-completion-example.js"
import { plannerMachine } from "../../../src/internal/browser/planner-example.js"
import {
  optionalParentMachine,
  parentProtocolMachine,
  requiredParentChildMachine
} from "../../../src/internal/browser/protocol-events-example.js"
import { sharedTerminalRoutingMachine } from "../../../src/internal/browser/shared-terminal-routing-example.js"
import { transitionSemanticsMachine } from "../../../src/internal/browser/transition-semantics-example.js"
import * as MachineDocument from "../../../src/MachineDocument.js"

describe("Static chart", () => {
  const ELK = ELKBundle as unknown as new(args?: ELKConstructorArguments) => ElkApi

  it("rounds orthogonal bends and places direction cues on long routes", () => {
    assert.strictEqual(
      chartEdgePathData([
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 30 },
        { x: 100, y: 30 }
      ], 10),
      "M 0 0 L 30 0 Q 40 0 40 10 L 40 20 Q 40 30 50 30 L 100 30"
    )
    assert.deepStrictEqual(
      chartDirectionCue([{ x: 0, y: 0 }, { x: 320, y: 0 }]),
      { start: { x: 97.4, y: 0 }, end: { x: 107.4, y: 0 } }
    )
    const nearlyHorizontal = chartDirectionCue([
      { x: 0, y: 100 },
      { x: 320, y: 100 + 1e-9 }
    ])
    assert.strictEqual(nearlyHorizontal?.start.y, nearlyHorizontal?.end.y)
    assert.closeTo((nearlyHorizontal?.end.x ?? 0) - (nearlyHorizontal?.start.x ?? 0), 10, 1e-9)
    assert.strictEqual(chartDirectionCue([{ x: 0, y: 0 }, { x: 200, y: 0 }]), null)
  })

  it("derives a top-to-bottom policy from initial reachability", () => {
    const node = (path: string, type: ChartNode["type"] = "atomic"): ChartNode => ({
      path,
      label: path,
      type,
      parent: null,
      children: [],
      active: false,
      initial: path === "Idle",
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
      staticPath: true,
      rank: 0,
      order: 0,
      layerConstraint: "FIRST"
    })
    assert.strictEqual(policy.node("Done").layerConstraint, "LAST")
    assert.strictEqual(policy.node("Detached").reachable, false)
    assert.strictEqual(policy.node("Detached").staticPath, false)
    assert.deepStrictEqual(policy.edge(model.edges[0]!), {
      direction: "forward",
      sourceSide: "SOUTH",
      targetSide: "NORTH"
    })
    assert.deepStrictEqual(policy.edge(model.edges[1]!), {
      direction: "backward",
      sourceSide: "NORTH",
      targetSide: "SOUTH"
    })
    assert.deepStrictEqual(policy.edge(model.edges[2]!), {
      direction: "self",
      sourceSide: "EAST",
      targetSide: "EAST"
    })
  })

  it("uses side lanes for transitions crossing a parent boundary", () => {
    const node = (path: string, parent: string | null, children: ReadonlyArray<string>): ChartNode => ({
      path,
      label: path,
      type: children.length === 0 ? "atomic" : "compound",
      parent,
      children,
      active: false,
      initial: path === "Workflow" || path === "Workflow.Idle",
      activities: []
    })
    const edges: ChartModel["edges"] = [
      {
        id: "enter",
        transitionId: "enter",
        branchIds: ["enter"],
        kind: "target",
        source: "Workflow",
        target: "Workflow.Idle",
        label: "Enter",
        trigger: { type: "event", event: "Enter" },
        activityKind: null,
        reenter: false,
        acceptance: "required"
      },
      {
        id: "leave",
        transitionId: "leave",
        branchIds: ["leave"],
        kind: "target",
        source: "Workflow.Idle",
        target: "Workflow",
        label: "Leave",
        trigger: { type: "event", event: "Leave" },
        activityKind: null,
        reenter: false,
        acceptance: "required"
      }
    ]
    const policy = makeChartLayoutPolicy({
      machineId: "hierarchy-policy",
      roots: ["Workflow"],
      nodes: [
        node("Workflow", null, ["Workflow.Idle"]),
        node("Workflow.Idle", "Workflow", [])
      ],
      edges,
      runtimeTargets: [],
      initials: [
        { id: "initial:Workflow", target: "Workflow", parent: null },
        { id: "initial:Workflow.Idle", target: "Workflow.Idle", parent: "Workflow" }
      ]
    })

    assert.deepStrictEqual(policy.edge(edges[0]!), {
      direction: "forward",
      sourceSide: "EAST",
      targetSide: "EAST"
    })
    assert.deepStrictEqual(policy.edge(edges[1]!), {
      direction: "backward",
      sourceSide: "WEST",
      targetSide: "WEST"
    })
  })

  it("projects invocation metadata and transition branches without state value fields", () => {
    const document = MachineDocument.make(plannerMachine)
    const model = makeChartModel(document)
    const working = model.nodes.find((node) => node.path === "Working")

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

  it("keeps value-bearing states compact while reserving room for invocations", async () => {
    const layout = await Effect.runPromise(layoutChart(makeChartModel(MachineDocument.make(plannerMachine))))
    const idle = layout.nodes.find((node) => node.node.path === "Idle")
    const working = layout.nodes.find((node) => node.node.path === "Working")

    assert.strictEqual(idle?.height, 52)
    assert.isAtMost(idle?.width ?? Number.POSITIVE_INFINITY, 160)
    assert.isAbove(working?.height ?? 0, idle?.height ?? Number.POSITIVE_INFINITY)
    assert.isAtMost(
      (idle?.y ?? Number.POSITIVE_INFINITY) + (idle?.height ?? 0),
      working?.y ?? Number.NEGATIVE_INFINITY
    )
  })

  it("places a compact initial marker entering the target from above", async () => {
    const model = makeChartModel(MachineDocument.make(invokeOutcomesMachine))
    const layout = await Effect.runPromise(layoutChart(model))
    const initial = layout.edges.find((edge) => edge.kind === "initial" && edge.initial.target === "Gallery.Choose")
    const marker = layout.initials.find((entry) => entry.initial.target === "Gallery.Choose")
    const target = layout.nodes.find((node) => node.node.path === "Gallery.Choose")
    if (initial?.kind !== "initial" || marker === undefined || target === undefined) {
      assert.fail("Expected the Choose initial marker")
    }

    assert.isAtLeast(marker.x, target.x)
    assert.isBelow(marker.x + marker.width, target.x + target.width)
    assert.isBelow(marker.y + marker.height, target.y)
    assert.deepStrictEqual(initial.points.at(-1), { x: marker.x + marker.width / 2, y: target.y })
    assert.isBelow(
      initial.points.slice(1).reduce((length, point, index) => {
        const previous = initial.points[index]!
        return length + Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y)
      }, 0),
      30
    )
  })

  it("attaches invoke failures to the Failed state instead of a nearby route", async () => {
    const model = makeChartModel(MachineDocument.make(invokeOutcomesMachine))
    const layout = await Effect.runPromise(layoutChart(model))
    const failed = layout.nodes.find(({ node }) => node.path === "Failed")
    const failures = layout.edges.filter((edge) =>
      edge.kind === "transition" && edge.edge.trigger.type === "invoke" && edge.edge.target === "Failed"
    )
    if (failed === undefined) assert.fail("Expected the Failed state")

    assert.lengthOf(failures, 3)
    for (const failure of failures) {
      const end = failure.points.at(-1)!
      assert.strictEqual(end.y, failed.y)
      assert.isAtLeast(end.x, failed.x)
      assert.isAtMost(end.x, failed.x + failed.width)
    }
  })

  it("leaves an atomic source through its boundary before turning", async () => {
    const model = makeChartModel(MachineDocument.make(invokeOutcomesMachine))
    const layout = await Effect.runPromise(layoutChart(model))
    const failed = layout.nodes.find(({ node }) => node.path === "Failed")
    const reset = layout.edges.find((edge) =>
      edge.kind === "transition" && edge.edge.source === "Failed" && edge.edge.label === "Reset"
    )
    if (failed === undefined || reset?.kind !== "transition") {
      assert.fail("Expected the Failed reset transition")
    }

    const start = reset.points[0]!
    const next = reset.points[1]!
    assert.strictEqual(start.y, failed.y)
    assert.isAtLeast(start.x, failed.x)
    assert.isAtMost(start.x, failed.x + failed.width)
    assert.strictEqual(next.x, start.x)
    assert.isBelow(next.y, start.y)
  })

  it("keeps transition labels attached to their ELK routes", async () => {
    const model = makeChartModel(MachineDocument.make(invokeOutcomesMachine))
    const layout = await Effect.runPromise(layoutChart(model))
    const resets = layout.edges.filter((edge) =>
      edge.kind === "transition" && edge.edge.label === "Reset" && edge.edge.source !== "Gallery"
    )

    assert.lengthOf(resets, 2)
    assert.isFalse(
      validateChartLayout(model, layout).issues.some(({ code, edgeId }) =>
        code === "label-detached" && resets.some((reset) => reset.kind === "transition" && reset.edge.id === edgeId)
      )
    )
  })

  it("validates self-transition loops against sibling states and their parent", async () => {
    const model = makeChartModel(MachineDocument.make(invokeOutcomesMachine))
    const layout = await Effect.runPromise(layoutChart(model))

    assert.deepStrictEqual(validateChartLayout(model, layout).issues, [])
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
      return Math.abs(end.x - bend.x) + Math.abs(end.y - bend.y) >= 9
    }))
    for (const initial of layout.initials) {
      const target = layout.nodes.find(({ node }) => node.path === initial.initial.target)
      assert.isBelow(initial.y + initial.height, target?.y ?? Number.POSITIVE_INFINITY)
      assert.isAtLeast(initial.x, target?.x ?? Number.NEGATIVE_INFINITY)
      assert.isBelow(initial.x + initial.width, (target?.x ?? 0) + (target?.width ?? 0))
    }

    const online = layout.nodes.find(({ node }) => node.path === "application.connection.online")
    const offline = layout.nodes.find(({ node }) => node.path === "application.connection.offline")
    const disconnect = layout.edges.find((edge) => edge.kind === "transition" && edge.edge.label === "Disconnect")
    if (online === undefined || offline === undefined || disconnect?.kind !== "transition") {
      assert.fail("Expected the connection flow")
    }
    assert.isAtMost(offline.y - online.y - online.height, 180)
    assert.isTrue(
      disconnect.points.slice(1).some((point, index) => {
        const previous = disconnect.points[index]!
        return previous.x === point.x && disconnect.label.x === point.x &&
          disconnect.label.y >= Math.min(previous.y, point.y) &&
          disconnect.label.y <= Math.max(previous.y, point.y)
      })
    )
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
      const sourceLayout = layout.nodes.find(({ node }) => node.path === laidOut.edge.source)
      if (sourceLayout === undefined) assert.fail("Expected the self-transition source layout")
      assert.isAtLeast(
        Math.max(...laidOut.points.map((point) =>
          Math.hypot(
            Math.max(sourceLayout.x - point.x, 0, point.x - sourceLayout.x - sourceLayout.width),
            Math.max(sourceLayout.y - point.y, 0, point.y - sourceLayout.y - sourceLayout.height)
          )
        )),
        chartSelfLoopMinimumClearance
      )
      assert.isAbove(
        laidOut.label.x - laidOut.labelWidth / 2,
        Math.max(...laidOut.points.map(({ x }) => x))
      )
      assert.isAtMost(laidOut.label.x + laidOut.labelWidth / 2, layout.width)
      const source = model.nodes.find(({ path }) => path === laidOut.edge.source)
      const parent = source?.parent === null
        ? undefined
        : layout.nodes.find(({ node }) => node.path === source?.parent)
      if (parent !== undefined) {
        assert.isAtMost(laidOut.label.x + laidOut.labelWidth / 2, parent.x + parent.width)
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

  it("lays out nested updates alongside cross-hierarchy invoke outcomes", async () => {
    const model = makeChartModel(MachineDocument.make(layoutResilienceMachine))
    const layout = await Effect.runPromise(layoutChart(model))
    const transitionEdges = layout.edges.filter((edge) => edge.kind === "transition")
    const updates = transitionEdges.filter(({ edge }) => edge.kind === "targetless")

    assert.strictEqual(transitionEdges.length, model.edges.length)
    assert.strictEqual(updates.length, 3)
    assert.deepStrictEqual(
      new Set(updates.map(({ points }) => Math.max(...points.map(({ x }) => x)))).size,
      3
    )
    assert.isTrue(
      transitionEdges.some(({ edge }) => edge.source === "Editing.SubmittingLogin" && edge.target === "Navigating")
    )
    assert.isTrue(
      transitionEdges.some(({ edge }) =>
        edge.source === "Editing.RequestingVerification" && edge.target === "Verification"
      )
    )
    assert.isTrue(
      transitionEdges.some(({ edge }) =>
        edge.source === "Editing.RequestingVerification" && edge.target === "Editing.Form.Failed"
      )
    )

    const incomingFailures = transitionEdges.filter(({ edge }) =>
      edge.trigger.type === "invoke" && edge.target === "Editing.Form.Failed"
    )
    assert.strictEqual(incomingFailures.length, 2)
    assert.deepStrictEqual(validateChartLayout(model, layout).issues, [])
  })

  it("lays out parent and cross-hierarchy transitions in the same validated graph", async () => {
    const model = makeChartModel(MachineDocument.make(hierarchyRoutingMachine))
    const layout = await Effect.runPromise(layoutChart(model))
    const repeated = await Effect.runPromise(layoutChart(model))
    const source = layout.nodes.find(({ node }) => node.path === "Workflow.Review")
    const target = layout.nodes.find(({ node }) => node.path === "Workflow.Review.Failed")
    const parentTransition = layout.edges.find((edge) =>
      edge.kind === "transition" && edge.edge.label === "Submit · Show validation failure"
    )
    const externalFailure = layout.edges.find((edge) =>
      edge.kind === "transition" && edge.edge.label === "save-review · failure"
    )
    if (
      source === undefined || target === undefined ||
      parentTransition?.kind !== "transition" || externalFailure?.kind !== "transition"
    ) assert.fail("Expected the hierarchy routing example transitions")

    assert.isAtLeast(parentTransition.points.length, 2)
    assert.isAtLeast(externalFailure.points.length, 2)
    assert.strictEqual(parentTransition.points[0]?.y, source.y + source.headerHeight)
    assert.isAtLeast(Math.min(...externalFailure.points.map(({ y }) => y)), target.y)
    assert.isBelow(chartRouteLength(externalFailure.points), 500)
    assert.deepStrictEqual(validateChartLayout(model, layout).issues, [])
    assert.deepStrictEqual(
      repeated.edges.map((edge) => ({
        id: edge.kind === "transition" ? edge.edge.id : edge.initial.id,
        points: edge.points
      })),
      layout.edges.map((edge) => ({
        id: edge.kind === "transition" ? edge.edge.id : edge.initial.id,
        points: edge.points
      }))
    )
  })

  it("tries deterministic spacing profiles before reporting an unsafe layout", async () => {
    const model = makeChartModel(MachineDocument.make(layoutResilienceMachine))
    const attempts: Array<string> = []
    const labelSpacings: Array<unknown> = []
    const failure = await Effect.runPromise(Effect.flip(layoutChartWith(model, async (graph, constraints) => {
      attempts.push(constraints)
      labelSpacings.push(graph.layoutOptions?.["elk.spacing.edgeLabel"])
      throw new Error(`${constraints} layout failed`)
    })))

    assert.deepStrictEqual(attempts, ["fixed", "fixed", "fixed", "relaxed", "relaxed"])
    assert.deepStrictEqual(labelSpacings, Array.from({ length: 5 }, () => String(chartEdgeLabelSpacing)))
    assert.include(failure.message, "roomy-relaxed: relaxed layout failed")
  })

  it("falls back to a chart with only label-to-route warnings after exhausting clean layouts", async () => {
    const model = makeChartModel(MachineDocument.make(sharedTerminalRoutingMachine))
    const elk = new ELK()
    let cachedLayout: Promise<ElkNode> | undefined
    const engine = (graph: ElkNode): Promise<ElkNode> => cachedLayout ??= elk.layout(graph)
    let attempts = 0
    const layout = await Effect.runPromise(layoutChartWith(
      model,
      async (graph) => {
        attempts++
        return engine(graph)
      },
      (_model, candidate) => ({
        valid: false,
        issues: [{ code: "label-route-overlap", edgeId: model.edges[0]!.id, relatedId: model.edges[1]!.id }],
        crossings: 0,
        routeLength: candidate.edges.reduce((total, edge) => total + chartRouteLength(edge.points), 0)
      })
    ))

    assert.strictEqual(attempts, 5)
    assert.strictEqual(layout.edges.length, model.edges.length + model.initials.length)

    const failure = await Effect.runPromise(Effect.flip(layoutChartWith(
      model,
      engine,
      () => ({
        valid: false,
        issues: [
          { code: "label-route-overlap", edgeId: model.edges[0]!.id, relatedId: model.edges[1]!.id },
          { code: "route-overlap", edgeId: model.edges[0]!.id, relatedId: model.edges[1]!.id }
        ],
        crossings: 0,
        routeLength: 0
      })
    )))
    assert.include(failure.message, "route-overlap")
  })

  it("keeps the example topology corpus deterministic and free of hard geometry violations", async () => {
    const corpus = [
      ["nested workflow", makeChartModel(MachineDocument.make(machine, { snapshot }))],
      ["planner", makeChartModel(MachineDocument.make(plannerMachine))],
      ["transition semantics", makeChartModel(MachineDocument.make(transitionSemanticsMachine))],
      ["parallel completion", makeChartModel(MachineDocument.make(parallelCompletionMachine))],
      ["invoke outcomes", makeChartModel(MachineDocument.make(invokeOutcomesMachine))],
      ["layout resilience", makeChartModel(MachineDocument.make(layoutResilienceMachine))],
      ["hierarchy routing", makeChartModel(MachineDocument.make(hierarchyRoutingMachine))],
      ["shared terminal routing", makeChartModel(MachineDocument.make(sharedTerminalRoutingMachine))],
      ["required parent protocol", makeChartModel(MachineDocument.make(requiredParentChildMachine))],
      ["parent protocol", makeChartModel(MachineDocument.make(parentProtocolMachine))],
      ["optional parent", makeChartModel(MachineDocument.make(optionalParentMachine))]
    ] as const

    for (const [name, model] of corpus) {
      const first = await Effect.runPromise(layoutChart(model))
      const second = await Effect.runPromise(layoutChart(model))
      assert.strictEqual(first.edges.length, model.edges.length + model.initials.length, name)
      assert.deepStrictEqual(validateChartLayout(model, first).issues, [], name)
      assert.deepStrictEqual(
        second.edges.map((edge) => ({
          id: edge.kind === "transition" ? edge.edge.id : edge.initial.id,
          points: edge.points
        })),
        first.edges.map((edge) => ({
          id: edge.kind === "transition" ? edge.edge.id : edge.initial.id,
          points: edge.points
        })),
        name
      )
    }
  })

  it("places parallel regions side by side while each region flows downward", async () => {
    const model = makeChartModel(MachineDocument.make(parallelCompletionMachine))
    const policy = makeChartLayoutPolicy(model)
    const layout = await Effect.runPromise(layoutChart(model))
    const regions = layout.nodes
      .filter(({ node }) => node.parent === "Order")
      .sort((left, right) => left.x - right.x)

    assert.deepStrictEqual(
      regions.map(({ node }) => node.path).sort(),
      ["Order.payment", "Order.fulfillment"].sort()
    )
    assert.isTrue(regions.every(({ node }) => policy.node(node.path).staticPath))
    assert.isAtMost(regions[0]!.x + regions[0]!.width, regions[1]!.x)
  })

  it("groups states without a static path from the initial state", async () => {
    const node = (path: string, initial = false): ChartNode => ({
      path,
      label: path,
      type: "atomic",
      parent: null,
      children: [],
      active: false,
      initial,
      activities: []
    })
    const model: ChartModel = {
      machineId: "unconnected-region",
      roots: ["Idle", "Detached"],
      nodes: [node("Idle", true), node("Detached")],
      edges: [],
      runtimeTargets: [],
      initials: [{ id: "initial:Idle", target: "Idle", parent: null }]
    }
    const layout = await Effect.runPromise(layoutChart(model))
    const region = layout.regions[0]
    const detached = layout.nodes.find(({ node }) => node.path === "Detached")

    assert.deepStrictEqual(region?.nodePaths, ["Detached"])
    assert.isAtLeast(detached?.x ?? 0, region?.x ?? Number.POSITIVE_INFINITY)
    assert.isAtMost(
      (detached?.x ?? Number.POSITIVE_INFINITY) + (detached?.width ?? 0),
      (region?.x ?? 0) + (region?.width ?? 0)
    )
  })

  it("separates the disconnected example state from the live topology", async () => {
    const model = makeChartModel(MachineDocument.make(transitionSemanticsMachine))
    const policy = makeChartLayoutPolicy(model)
    const layout = await Effect.runPromise(layoutChart(model))

    assert.strictEqual(policy.node("Disabled").staticPath, false)
    assert.isTrue(layout.regions.some(({ nodePaths }) => nodePaths.includes("Disabled")))

    const recent = layout.nodes.find(({ node }) => node.path === "Workspace.recent")
    const resume = layout.edges.find((edge) => edge.kind === "transition" && edge.edge.label === "ResumeShallow")
    if (recent === undefined || resume?.kind !== "transition") assert.fail("Expected the shallow history transition")
    const approach = resume.points.at(-2)!
    const end = resume.points.at(-1)!
    assert.isTrue(approach.x === end.x || approach.y === end.y)
    assert.isTrue(
      (end.x === recent.x || end.x === recent.x + recent.width) &&
          end.y >= recent.y && end.y <= recent.y + recent.height ||
        (end.y === recent.y || end.y === recent.y + recent.height) &&
          end.x >= recent.x && end.x <= recent.x + recent.width
    )
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
