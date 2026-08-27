import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type {
  ELK as ElkApi,
  ELKConstructorArguments,
  ElkExtendedEdge,
  ElkNode,
  ElkPoint,
  ElkPort
} from "elkjs/lib/elk-api.js"
import ELKBundle from "elkjs/lib/elk.bundled.js"
import { type ChartPortSide, makeChartLayoutPolicy } from "./chart-layout-policy.js"
import type { ChartEdge, ChartInitial, ChartModel, ChartNode, ChartRuntimeTarget } from "./chart-model.js"

export const maxVisibleFields = 4
export const maxVisibleActivities = 3
export const chartSelfLoopMinimumClearance = 24

export interface ChartPoint {
  readonly x: number
  readonly y: number
}

export interface LaidOutChartNode {
  readonly node: ChartNode
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly headerHeight: number
}

export interface LaidOutChartInitial {
  readonly initial: ChartInitial
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LaidOutChartRuntimeTarget {
  readonly target: ChartRuntimeTarget
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LaidOutChartRegion {
  readonly kind: "unconnected"
  readonly parent: string | null
  readonly nodePaths: ReadonlyArray<string>
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LaidOutChartTransition {
  readonly kind: "transition"
  readonly edge: ChartEdge
  readonly points: ReadonlyArray<ChartPoint>
  readonly label: ChartPoint
  readonly labelWidth: number
  readonly labelHeight: number
}

export interface LaidOutChartInitialEdge {
  readonly kind: "initial"
  readonly initial: ChartInitial
  readonly points: ReadonlyArray<ChartPoint>
}

export interface LaidOutChart {
  readonly width: number
  readonly height: number
  readonly regions: ReadonlyArray<LaidOutChartRegion>
  readonly nodes: ReadonlyArray<LaidOutChartNode>
  readonly initials: ReadonlyArray<LaidOutChartInitial>
  readonly runtimeTargets: ReadonlyArray<LaidOutChartRuntimeTarget>
  readonly edges: ReadonlyArray<LaidOutChartTransition | LaidOutChartInitialEdge>
}

export type ChartLayoutIssueCode =
  | "missing-edge"
  | "label-detached"
  | "label-label-overlap"
  | "label-node-overlap"
  | "label-route-overlap"
  | "node-crossing"
  | "route-overlap"
  | "self-loop-clearance"
  | "self-loop-outside-parent"
  | "short-terminal"

export interface ChartLayoutIssue {
  readonly code: ChartLayoutIssueCode
  readonly edgeId: string
  readonly relatedId: string | null
}

export interface ChartLayoutValidation {
  readonly valid: boolean
  readonly issues: ReadonlyArray<ChartLayoutIssue>
  readonly crossings: number
  readonly routeLength: number
}

export class ChartLayoutError extends Data.TaggedError("ChartLayoutError")<{
  readonly cause: unknown
  readonly message: string
}> {}

interface NodeMetric {
  readonly width: number
  readonly height: number
  readonly headerHeight: number
}

interface ChartRect {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

interface UnconnectedRegion {
  readonly id: string
  readonly parent: string | null
  readonly nodePaths: ReadonlyArray<string>
}

type PortConstraints = "fixed" | "relaxed"

interface LayoutProfile {
  readonly id: string
  readonly portConstraints: PortConstraints
  readonly nodeSpacing: number
  readonly layerSpacing: number
  readonly edgeNodeSpacing: number
  readonly edgeEdgeSpacing: number
  readonly compoundNodeSpacing: number
  readonly compoundLayerSpacing: number
  readonly selfLoopSpacing: number
  readonly padding: number
}

const layoutProfiles: ReadonlyArray<LayoutProfile> = [
  {
    id: "compact-fixed",
    portConstraints: "fixed",
    nodeSpacing: 64,
    layerSpacing: 148,
    edgeNodeSpacing: 42,
    edgeEdgeSpacing: 26,
    compoundNodeSpacing: 44,
    compoundLayerSpacing: 108,
    selfLoopSpacing: 32,
    padding: 44
  },
  {
    id: "spacious-fixed",
    portConstraints: "fixed",
    nodeSpacing: 88,
    layerSpacing: 188,
    edgeNodeSpacing: 58,
    edgeEdgeSpacing: 38,
    compoundNodeSpacing: 64,
    compoundLayerSpacing: 144,
    selfLoopSpacing: 40,
    padding: 56
  },
  {
    id: "roomy-fixed",
    portConstraints: "fixed",
    nodeSpacing: 112,
    layerSpacing: 232,
    edgeNodeSpacing: 76,
    edgeEdgeSpacing: 52,
    compoundNodeSpacing: 82,
    compoundLayerSpacing: 180,
    selfLoopSpacing: 48,
    padding: 68
  },
  {
    id: "spacious-relaxed",
    portConstraints: "relaxed",
    nodeSpacing: 88,
    layerSpacing: 188,
    edgeNodeSpacing: 58,
    edgeEdgeSpacing: 38,
    compoundNodeSpacing: 64,
    compoundLayerSpacing: 144,
    selfLoopSpacing: 40,
    padding: 56
  },
  {
    id: "roomy-relaxed",
    portConstraints: "relaxed",
    nodeSpacing: 112,
    layerSpacing: 232,
    edgeNodeSpacing: 76,
    edgeEdgeSpacing: 52,
    compoundNodeSpacing: 82,
    compoundLayerSpacing: 180,
    selfLoopSpacing: 48,
    padding: 68
  }
]

const sectionHeight = (length: number, limit: number): number => {
  if (length === 0) return 0
  const visible = Math.min(length, limit)
  return 24 + visible * 22 + (length > limit ? 18 : 0)
}

const nodeMetric = (node: ChartNode): NodeMetric => {
  const headerHeight = Math.max(
    78,
    76 +
      sectionHeight(node.fields.length, maxVisibleFields) +
      sectionHeight(node.activities.length, maxVisibleActivities)
  )
  const width = node.type === "choice" || node.type === "history" ? 176 : node.children.length > 0 ? 340 : 276
  return {
    width,
    height: node.children.length === 0 ? headerHeight : Math.max(240, headerHeight + 104),
    headerHeight
  }
}

const ELK = ELKBundle as unknown as new(args?: ELKConstructorArguments) => ElkApi
const elk = new ELK()

const sourcePortId = (edge: ChartEdge): string => `port:${edge.id}:source`
const targetPortId = (edge: ChartEdge): string => `port:${edge.id}:target`
const initialNodeId = (initial: ChartInitial): string => `node:${initial.id}`
const initialTargetPortId = (initial: ChartInitial): string => `port:${initial.id}:target`
const runtimeNodeId = (target: ChartRuntimeTarget): string => `node:${target.id}`
const runtimeTargetPortId = (target: ChartRuntimeTarget): string => `port:${target.edgeId}:target`
const unconnectedRegionId = (parent: string | null): string => `region:unconnected:${parent ?? "root"}`
const isSelfTransition = (edge: ChartEdge): boolean => edge.kind === "targetless" || edge.target === edge.source
const isDescendantPath = (path: string, ancestor: string): boolean => path.startsWith(`${ancestor}.`)

const unconnectedRegions = (
  model: ChartModel,
  policy: ReturnType<typeof makeChartLayoutPolicy>
): ReadonlyArray<UnconnectedRegion> => {
  const parents = new Set<string | null>([null, ...model.nodes.map(({ parent }) => parent)])
  return [...parents].flatMap((parent): ReadonlyArray<UnconnectedRegion> => {
    if (parent !== null && !policy.node(parent).staticPath) return []
    const nodePaths = policy.children(parent)
      .filter(({ path }) => !policy.node(path).staticPath)
      .map(({ path }) => path)
    return nodePaths.length === 0
      ? []
      : [{ id: unconnectedRegionId(parent), parent, nodePaths }]
  })
}

const edgeTargetPath = (edge: ChartEdge): string | null => {
  if (edge.kind === "target") return edge.target
  if (edge.kind === "targetless") return edge.source
  return null
}

const portsByState = (
  edges: ReadonlyArray<ChartEdge>,
  edgePolicy: ReturnType<typeof makeChartLayoutPolicy>["edge"],
  portConstraints: PortConstraints
): Map<string, Array<ElkPort>> => {
  const ports = new Map<string, Array<ElkPort>>()
  const add = (path: string, id: string, side: ChartPortSide): void => {
    const statePorts = ports.get(path) ?? []
    statePorts.push({
      id,
      width: 6,
      height: 6,
      ...(portConstraints === "fixed"
        ? { layoutOptions: { "elk.port.side": side } }
        : {})
    })
    ports.set(path, statePorts)
  }

  for (const edge of edges) {
    const policy = edgePolicy(edge)
    add(edge.source, sourcePortId(edge), policy.sourceSide)
    const target = edgeTargetPath(edge)
    if (target !== null) add(target, targetPortId(edge), policy.targetSide)
  }
  return ports
}

const labelMetric = (label: string): { readonly width: number; readonly height: number } => ({
  width: Math.min(230, Math.max(72, label.length * 7 + 20)),
  height: 26
})

const makeGraph = (
  model: ChartModel,
  policy: ReturnType<typeof makeChartLayoutPolicy>,
  regions: ReadonlyArray<UnconnectedRegion>,
  profile: LayoutProfile
): ElkNode => {
  const regionsByParent = new Map(regions.map((region) => [region.parent, region]))
  const sourceByEdgeId = new Map(model.edges.map((edge) => [edge.id, edge.source]))
  const runtimeByEdgeId = new Map(model.runtimeTargets.map((target) => [target.edgeId, target]))
  const initialsByParent = new Map<string | null, Array<ChartInitial>>()
  for (const initial of model.initials) {
    const siblings = initialsByParent.get(initial.parent) ?? []
    siblings.push(initial)
    initialsByParent.set(initial.parent, siblings)
  }
  const runtimeTargetsByParent = new Map<string | null, Array<ChartRuntimeTarget>>()
  for (const target of model.runtimeTargets) {
    const siblings = runtimeTargetsByParent.get(target.parent) ?? []
    siblings.push(target)
    runtimeTargetsByParent.set(target.parent, siblings)
  }
  const ports = portsByState(model.edges, policy.edge, profile.portConstraints)
  for (const initial of model.initials) {
    const statePorts = ports.get(initial.target) ?? []
    statePorts.push({
      id: initialTargetPortId(initial),
      width: 6,
      height: 6,
      ...(profile.portConstraints === "fixed"
        ? { layoutOptions: { "elk.port.side": "WEST" } }
        : {})
    })
    ports.set(initial.target, statePorts)
  }

  const initialNode = (initial: ChartInitial): ElkNode => ({
    id: initialNodeId(initial),
    width: 14,
    height: 14,
    layoutOptions: { "elk.layered.layering.layerConstraint": "FIRST" }
  })
  const runtimeNode = (target: ChartRuntimeTarget): ElkNode => ({
    id: runtimeNodeId(target),
    width: 118,
    height: 34,
    ports: [{
      id: runtimeTargetPortId(target),
      width: 6,
      height: 6,
      ...(profile.portConstraints === "fixed"
        ? { layoutOptions: { "elk.port.side": "WEST" } }
        : {})
    }],
    ...(profile.portConstraints === "fixed"
      ? { layoutOptions: { "elk.portConstraints": "FIXED_SIDE" } }
      : {})
  })

  const stateNode = (node: ChartNode, suppressUnconnectedRegion: boolean): ElkNode => {
    const metric = nodeMetric(node)
    const nodePolicy = policy.node(node.path)
    const descendants = children(node.path, suppressUnconnectedRegion || !nodePolicy.staticPath)
    const common = {
      id: node.path,
      ports: [...ports.get(node.path) ?? []],
      layoutOptions: {
        ...(profile.portConstraints === "fixed" ? { "elk.portConstraints": "FIXED_SIDE" } : {}),
        "elk.spacing.portPort": "24",
        ...(nodePolicy.layerConstraint === null
          ? {}
          : { "elk.layered.layering.layerConstraint": nodePolicy.layerConstraint })
      }
    }
    if (descendants.length === 0) {
      return { ...common, width: metric.width, height: metric.height }
    }
    return {
      ...common,
      children: descendants,
      layoutOptions: {
        ...common.layoutOptions,
        "elk.algorithm": "layered",
        "elk.direction": node.type === "parallel" ? "DOWN" : "RIGHT",
        "elk.padding": `[top=${metric.headerHeight + 36},left=36,bottom=36,right=36]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${metric.width}, ${metric.height})`,
        "elk.spacing.nodeNode": String(profile.compoundNodeSpacing),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(
          node.type === "parallel" ? profile.compoundNodeSpacing + 24 : profile.compoundLayerSpacing
        ),
        "elk.spacing.edgeNode": String(profile.edgeNodeSpacing),
        "elk.spacing.edgeEdge": String(profile.edgeEdgeSpacing),
        "elk.spacing.nodeSelfLoop": String(profile.selfLoopSpacing),
        "elk.layered.spacing.edgeNodeBetweenLayers": String(profile.edgeNodeSpacing),
        "elk.layered.spacing.edgeEdgeBetweenLayers": String(profile.edgeEdgeSpacing)
      }
    }
  }

  function children(parent: string | null, suppressUnconnectedRegion = false): Array<ElkNode> {
    const region = suppressUnconnectedRegion ? undefined : regionsByParent.get(parent)
    const regionPaths = new Set(region?.nodePaths ?? [])
    const initials = initialsByParent.get(parent) ?? []
    const runtimeTargets = runtimeTargetsByParent.get(parent) ?? []
    const states = policy.children(parent)
    const regular: Array<ElkNode> = [
      ...initials.filter(({ target }) => !regionPaths.has(target)).map(initialNode),
      ...states.filter(({ path }) => !regionPaths.has(path)).map((node) => stateNode(node, suppressUnconnectedRegion)),
      ...runtimeTargets
        .filter(({ edgeId }) => !regionPaths.has(sourceByEdgeId.get(edgeId) ?? ""))
        .map(runtimeNode)
    ]
    if (region === undefined) return regular

    const regionChildren: Array<ElkNode> = [
      ...initials.filter(({ target }) => regionPaths.has(target)).map(initialNode),
      ...states.filter(({ path }) => regionPaths.has(path)).map((node) => stateNode(node, true)),
      ...runtimeTargets
        .filter(({ edgeId }) => regionPaths.has(sourceByEdgeId.get(edgeId) ?? ""))
        .map(runtimeNode)
    ]
    regular.push({
      id: region.id,
      children: regionChildren,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.padding": "[top=54,left=24,bottom=24,right=24]",
        "elk.layered.layering.layerConstraint": "LAST",
        "elk.spacing.nodeNode": String(profile.nodeSpacing),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(profile.layerSpacing),
        "elk.spacing.edgeNode": String(profile.edgeNodeSpacing),
        "elk.spacing.edgeEdge": String(profile.edgeEdgeSpacing),
        "elk.spacing.nodeSelfLoop": String(profile.selfLoopSpacing)
      }
    })
    return regular
  }

  return {
    id: "chart-root",
    children: children(null),
    edges: [
      ...model.edges.map((edge): ElkExtendedEdge => {
        const label = labelMetric(edge.label)
        const edgeLayout = policy.edge(edge)
        const runtimeTarget = edge.kind === "runtime" ? runtimeByEdgeId.get(edge.id) : undefined
        return {
          id: edge.id,
          sources: [sourcePortId(edge)],
          targets: [runtimeTarget === undefined ? targetPortId(edge) : runtimeTargetPortId(runtimeTarget)],
          labels: [{ text: edge.label, width: label.width, height: label.height }],
          layoutOptions: {
            "elk.layered.priority.direction": edgeLayout.direction === "forward" ? "10" : "1",
            "elk.layered.priority.shortness": "5",
            "elk.layered.priority.straightness": "5"
          }
        }
      }),
      ...model.initials.map((initial): ElkExtendedEdge => ({
        id: initial.id,
        sources: [initialNodeId(initial)],
        targets: [initialTargetPortId(initial)],
        layoutOptions: {
          "elk.layered.priority.direction": "100",
          "elk.layered.priority.shortness": "100",
          "elk.layered.priority.straightness": "100"
        }
      }))
    ],
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding":
        `[top=${profile.padding},left=${profile.padding},bottom=${profile.padding},right=${profile.padding}]`,
      "elk.spacing.nodeNode": String(profile.nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(profile.layerSpacing),
      "elk.layered.spacing.edgeNodeBetweenLayers": String(profile.edgeNodeSpacing),
      "elk.layered.spacing.edgeEdgeBetweenLayers": String(profile.edgeEdgeSpacing),
      "elk.spacing.edgeNode": String(profile.edgeNodeSpacing),
      "elk.spacing.edgeEdge": String(profile.edgeEdgeSpacing),
      "elk.spacing.nodeSelfLoop": String(profile.selfLoopSpacing),
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.considerModelOrder.portModelOrder": "false",
      "elk.layered.considerModelOrder.crossingCounterNodeInfluence": "0.001",
      "elk.layered.considerModelOrder.components": "FORCE_MODEL_ORDER",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.crossingMinimization.hierarchicalSweepiness": "1",
      "elk.layered.crossingMinimization.greedySwitchHierarchical.type": "TWO_SIDED",
      "elk.layered.nodePlacement.favorStraightEdges": "true",
      "elk.layered.mergeHierarchyEdges": "false",
      "elk.layered.thoroughness": "12",
      "elk.randomSeed": "1"
    }
  }
}

const add = (left: ChartPoint, right: ChartPoint): ChartPoint => ({
  x: left.x + right.x,
  y: left.y + right.y
})

const compactPoints = (points: ReadonlyArray<ChartPoint>): ReadonlyArray<ChartPoint> => {
  const result: Array<ChartPoint> = []
  for (const point of points) {
    const previous = result.at(-1)
    if (previous !== undefined && previous.x === point.x && previous.y === point.y) continue
    const beforePrevious = result.at(-2)
    if (
      beforePrevious !== undefined && previous !== undefined &&
      (beforePrevious.x === previous.x && previous.x === point.x ||
        beforePrevious.y === previous.y && previous.y === point.y)
    ) {
      result[result.length - 1] = point
    } else {
      result.push(point)
    }
  }
  return result
}

const edgePoints = (edge: ElkExtendedEdge, offset: ChartPoint): ReadonlyArray<ChartPoint> | undefined => {
  const sections = edge.sections
  if (sections === undefined || sections.length === 0) return undefined
  const byId = new Map(sections.map((section) => [section.id, section]))
  let section =
    sections.find((candidate) =>
      candidate.incomingShape !== undefined || candidate.incomingSections === undefined ||
      candidate.incomingSections.length === 0
    ) ?? sections[0]
  const points: Array<ElkPoint> = []
  const visited = new Set<string>()
  while (section !== undefined && !visited.has(section.id)) {
    visited.add(section.id)
    if (points.length === 0) points.push(section.startPoint)
    points.push(...(section.bendPoints ?? []), section.endPoint)
    const next = section.outgoingSections?.[0]
    section = next === undefined ? undefined : byId.get(next)
  }
  return points.length < 2 ? undefined : compactPoints(points.map((point) => add(point, offset)))
}

const midpoint = (points: ReadonlyArray<ChartPoint>): ChartPoint => {
  const lengths = points.slice(1).map((point, index) => {
    const previous = points[index]!
    return Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y)
  })
  const total = lengths.reduce((sum, length) => sum + length, 0)
  let remaining = total / 2
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index]!
    const start = points[index]!
    const end = points[index + 1]!
    if (remaining <= length) {
      const ratio = length === 0 ? 0 : remaining / length
      return {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio
      }
    }
    remaining -= length
  }
  return points.at(-1)!
}

const collectLayout = (
  model: ChartModel,
  graph: ElkNode,
  unconnected: ReadonlyArray<UnconnectedRegion>
): LaidOutChart => {
  const chartNodes = new Map(model.nodes.map((node) => [node.path, node]))
  const chartInitials = new Map(model.initials.map((initial) => [initialNodeId(initial), initial]))
  const chartRuntimeTargets = new Map(model.runtimeTargets.map((target) => [runtimeNodeId(target), target]))
  const chartRegions = new Map(unconnected.map((region) => [region.id, region]))
  const offsets = new Map<string, ChartPoint>([[graph.id, { x: 0, y: 0 }]])
  const regions: Array<LaidOutChartRegion> = []
  const nodes: Array<LaidOutChartNode> = []
  const initials: Array<LaidOutChartInitial> = []
  const runtimeTargets: Array<LaidOutChartRuntimeTarget> = []

  const visit = (node: ElkNode, parentOffset: ChartPoint): void => {
    const absolute = add(parentOffset, { x: node.x ?? 0, y: node.y ?? 0 })
    offsets.set(node.id, absolute)
    const chartRegion = chartRegions.get(node.id)
    if (chartRegion !== undefined) {
      regions.push({
        kind: "unconnected",
        parent: chartRegion.parent,
        nodePaths: chartRegion.nodePaths,
        x: absolute.x,
        y: absolute.y,
        width: node.width ?? 0,
        height: node.height ?? 0
      })
    }
    const chartNode = chartNodes.get(node.id)
    if (chartNode !== undefined) {
      const metric = nodeMetric(chartNode)
      nodes.push({
        node: chartNode,
        x: absolute.x,
        y: absolute.y,
        width: node.width ?? metric.width,
        height: node.height ?? metric.height,
        headerHeight: metric.headerHeight
      })
    }
    const initial = chartInitials.get(node.id)
    if (initial !== undefined) {
      initials.push({
        initial,
        x: absolute.x,
        y: absolute.y,
        width: node.width ?? 14,
        height: node.height ?? 14
      })
    }
    const runtimeTarget = chartRuntimeTargets.get(node.id)
    if (runtimeTarget !== undefined) {
      runtimeTargets.push({
        target: runtimeTarget,
        x: absolute.x,
        y: absolute.y,
        width: node.width ?? 118,
        height: node.height ?? 34
      })
    }
    for (const child of node.children ?? []) visit(child, absolute)
  }
  for (const child of graph.children ?? []) visit(child, { x: 0, y: 0 })

  const chartEdges = new Map(model.edges.map((edge) => [edge.id, edge]))
  const initialEdges = new Map(model.initials.map((initial) => [initial.id, initial]))
  const edges = (graph.edges ?? []).flatMap(
    (edge): ReadonlyArray<LaidOutChartTransition | LaidOutChartInitialEdge> => {
      const offset = offsets.get(edge.container ?? graph.id) ?? { x: 0, y: 0 }
      const points = edgePoints(edge, offset)
      if (points === undefined) return []
      const chartEdge = chartEdges.get(edge.id)
      if (chartEdge !== undefined) {
        const metric = labelMetric(chartEdge.label)
        const label = edge.labels?.[0]
        const labelWidth = label?.width ?? metric.width
        const labelHeight = label?.height ?? metric.height
        return [{
          kind: "transition",
          edge: chartEdge,
          points,
          label: label?.x === undefined || label.y === undefined
            ? midpoint(points)
            : add(offset, {
              x: label.x + labelWidth / 2,
              y: label.y + labelHeight / 2
            }),
          labelWidth,
          labelHeight
        }]
      }
      const initial = initialEdges.get(edge.id)
      return initial === undefined ? [] : [{ kind: "initial", initial, points }]
    }
  )

  const transitionEdges = edges.filter((edge) => edge.kind === "transition")
  const contentWidth = Math.max(
    0,
    ...nodes.map(({ width, x }) => x + width),
    ...initials.map(({ width, x }) => x + width),
    ...runtimeTargets.map(({ width, x }) => x + width),
    ...edges.flatMap(({ points }) => points.map(({ x }) => x)),
    ...transitionEdges.map(({ label, labelWidth }) => label.x + labelWidth / 2)
  )
  const contentHeight = Math.max(
    0,
    ...nodes.map(({ height, y }) => y + height),
    ...initials.map(({ height, y }) => y + height),
    ...runtimeTargets.map(({ height, y }) => y + height),
    ...edges.flatMap(({ points }) => points.map(({ y }) => y)),
    ...transitionEdges.map(({ label, labelHeight }) => label.y + labelHeight / 2)
  )

  return {
    width: Math.max(360, graph.width ?? 0, contentWidth + 20),
    height: Math.max(280, graph.height ?? 0, contentHeight + 20),
    regions,
    nodes,
    initials,
    runtimeTargets,
    edges
  }
}

const labelRect = (point: ChartPoint, width: number, height: number): ChartRect => ({
  left: point.x - width / 2,
  right: point.x + width / 2,
  top: point.y - height / 2,
  bottom: point.y + height / 2
})

const nodeRect = (node: LaidOutChartNode): ChartRect => ({
  left: node.x,
  right: node.x + node.width,
  top: node.y,
  bottom: node.y + node.height
})

const nodeHeaderRect = (node: LaidOutChartNode): ChartRect => ({
  left: node.x,
  right: node.x + node.width,
  top: node.y,
  bottom: node.y + node.headerHeight
})

const pointRectDistance = (point: ChartPoint, rect: ChartRect): number =>
  Math.hypot(
    Math.max(rect.left - point.x, 0, point.x - rect.right),
    Math.max(rect.top - point.y, 0, point.y - rect.bottom)
  )

const overlaps = (left: ChartRect, right: ChartRect, gap = 0): boolean =>
  left.left < right.right + gap && left.right > right.left - gap &&
  left.top < right.bottom + gap && left.bottom > right.top - gap

const segmentCrossesInterior = (start: ChartPoint, end: ChartPoint, rect: ChartRect): boolean => {
  const epsilon = 0.001
  const left = rect.left + epsilon
  const right = rect.right - epsilon
  const top = rect.top + epsilon
  const bottom = rect.bottom - epsilon
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  let minimum = 0
  let maximum = 1
  const clip = (direction: number, origin: number, low: number, high: number): boolean => {
    if (direction === 0) return origin >= low && origin <= high
    const first = (low - origin) / direction
    const second = (high - origin) / direction
    minimum = Math.max(minimum, Math.min(first, second))
    maximum = Math.min(maximum, Math.max(first, second))
    return minimum <= maximum
  }
  return clip(deltaX, start.x, left, right) && clip(deltaY, start.y, top, bottom) &&
    maximum > 0 && minimum < 1
}

const pointSegmentDistance = (point: ChartPoint, start: ChartPoint, end: ChartPoint): number => {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const squaredLength = deltaX * deltaX + deltaY * deltaY
  if (squaredLength === 0) return Math.hypot(point.x - start.x, point.y - start.y)
  const ratio = Math.min(
    1,
    Math.max(0, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / squaredLength)
  )
  return Math.hypot(point.x - (start.x + ratio * deltaX), point.y - (start.y + ratio * deltaY))
}

const labelDistance = (transition: LaidOutChartTransition): number => {
  let distance = Number.POSITIVE_INFINITY
  for (let index = 1; index < transition.points.length; index++) {
    distance = Math.min(
      distance,
      pointSegmentDistance(transition.label, transition.points[index - 1]!, transition.points[index]!)
    )
  }
  return distance
}

export const chartRouteLength = (points: ReadonlyArray<ChartPoint>): number =>
  points.slice(1).reduce((total, point, index) => {
    const previous = points[index]!
    return total + Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y)
  }, 0)

interface OrthogonalSegment {
  readonly edgeId: string
  readonly start: ChartPoint
  readonly end: ChartPoint
  readonly horizontal: boolean
}

const segments = (layout: LaidOutChart): ReadonlyArray<OrthogonalSegment> =>
  layout.edges.flatMap((edge): ReadonlyArray<OrthogonalSegment> => {
    const edgeId = edge.kind === "transition" ? edge.edge.id : edge.initial.id
    return edge.points.slice(1).map((end, index) => ({
      edgeId,
      start: edge.points[index]!,
      end,
      horizontal: edge.points[index]!.y === end.y
    }))
  })

const crossingCount = (allSegments: ReadonlyArray<OrthogonalSegment>): number => {
  let crossings = 0
  for (let leftIndex = 0; leftIndex < allSegments.length; leftIndex++) {
    const left = allSegments[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < allSegments.length; rightIndex++) {
      const right = allSegments[rightIndex]!
      if (left.edgeId === right.edgeId || left.horizontal === right.horizontal) continue
      const horizontal = left.horizontal ? left : right
      const vertical = left.horizontal ? right : left
      const horizontalLeft = Math.min(horizontal.start.x, horizontal.end.x)
      const horizontalRight = Math.max(horizontal.start.x, horizontal.end.x)
      const verticalTop = Math.min(vertical.start.y, vertical.end.y)
      const verticalBottom = Math.max(vertical.start.y, vertical.end.y)
      if (
        vertical.start.x > horizontalLeft && vertical.start.x < horizontalRight &&
        horizontal.start.y > verticalTop && horizontal.start.y < verticalBottom
      ) crossings++
    }
  }
  return crossings
}

const collinearOverlap = (left: OrthogonalSegment, right: OrthogonalSegment): number => {
  if (left.horizontal !== right.horizontal) return 0
  if (left.horizontal) {
    if (left.start.y !== right.start.y) return 0
    return Math.max(
      0,
      Math.min(Math.max(left.start.x, left.end.x), Math.max(right.start.x, right.end.x)) -
        Math.max(Math.min(left.start.x, left.end.x), Math.min(right.start.x, right.end.x))
    )
  }
  if (left.start.x !== right.start.x) return 0
  return Math.max(
    0,
    Math.min(Math.max(left.start.y, left.end.y), Math.max(right.start.y, right.end.y)) -
      Math.max(Math.min(left.start.y, left.end.y), Math.min(right.start.y, right.end.y))
  )
}

const transitionTouchesNode = (edge: ChartEdge, path: string): boolean => {
  const target = edgeTargetPath(edge)
  return edge.source === path || isDescendantPath(edge.source, path) ||
    target === path || target !== null && isDescendantPath(target, path)
}

const laidOutEdgeId = (edge: LaidOutChartTransition | LaidOutChartInitialEdge): string =>
  edge.kind === "transition" ? edge.edge.id : edge.initial.id

const validationScore = (validation: ChartLayoutValidation): number =>
  validation.issues.length * 1_000_000 + validation.crossings * 10_000 + validation.routeLength

export const validateChartLayout = (
  model: ChartModel,
  layout: LaidOutChart
): ChartLayoutValidation => {
  const issues: Array<ChartLayoutIssue> = []
  const report = (code: ChartLayoutIssueCode, edgeId: string, relatedId: string | null = null): void => {
    if (issues.some((issue) => issue.code === code && issue.edgeId === edgeId && issue.relatedId === relatedId)) return
    issues.push({ code, edgeId, relatedId })
  }
  const transitions = layout.edges.filter(
    (edge): edge is LaidOutChartTransition => edge.kind === "transition"
  )
  const transitionById = new Map(transitions.map((edge) => [edge.edge.id, edge]))
  for (const edge of model.edges) {
    if (!transitionById.has(edge.id)) report("missing-edge", edge.id)
  }
  const initialEdges = layout.edges.filter(
    (edge): edge is LaidOutChartInitialEdge => edge.kind === "initial"
  )
  const initialById = new Map(initialEdges.map((edge) => [edge.initial.id, edge]))
  for (const initial of model.initials) {
    if (!initialById.has(initial.id)) report("missing-edge", initial.id)
  }

  for (const transition of transitions) {
    const transitionLabelDistance = labelDistance(transition)
    if (transitionLabelDistance > Math.max(transition.labelWidth, transition.labelHeight) / 2 + 12) {
      report("label-detached", transition.edge.id, `${Math.round(transitionLabelDistance)}px`)
    }
    const end = transition.points.at(-1)
    const bend = transition.points.at(-2)
    if (
      end === undefined || bend === undefined ||
      Math.abs(end.x - bend.x) + Math.abs(end.y - bend.y) < 9
    ) report("short-terminal", transition.edge.id)

    const label = labelRect(transition.label, transition.labelWidth, transition.labelHeight)
    for (const node of layout.nodes) {
      const obstacle = node.node.children.length > 0 && transitionTouchesNode(transition.edge, node.node.path)
        ? nodeHeaderRect(node)
        : nodeRect(node)
      if (overlaps(label, obstacle, 2)) report("label-node-overlap", transition.edge.id, node.node.path)
      if (
        transition.points.slice(1).some((point, index) =>
          segmentCrossesInterior(transition.points[index]!, point, obstacle)
        )
      ) report("node-crossing", transition.edge.id, node.node.path)
    }

    if (isSelfTransition(transition.edge)) {
      const source = model.nodes.find((node) => node.path === transition.edge.source)
      const sourceLayout = layout.nodes.find((node) => node.node.path === transition.edge.source)
      if (
        sourceLayout !== undefined &&
        Math.max(...transition.points.map((point) => pointRectDistance(point, nodeRect(sourceLayout)))) <
          chartSelfLoopMinimumClearance
      ) report("self-loop-clearance", transition.edge.id, sourceLayout.node.path)
      const parent = source?.parent === null
        ? undefined
        : layout.nodes.find((node) => node.node.path === source?.parent)
      if (parent !== undefined) {
        const content = {
          left: parent.x,
          right: parent.x + parent.width,
          top: parent.y + parent.headerHeight,
          bottom: parent.y + parent.height
        }
        const outside = transition.points.some((point) =>
          point.x < content.left || point.x > content.right ||
          point.y < content.top || point.y > content.bottom
        ) || label.left < content.left || label.right > content.right ||
          label.top < content.top || label.bottom > content.bottom
        if (outside) report("self-loop-outside-parent", transition.edge.id, parent.node.path)
      }
    }
  }

  for (const initial of initialEdges) {
    for (const node of layout.nodes) {
      const containsTarget = node.node.path === initial.initial.target ||
        isDescendantPath(initial.initial.target, node.node.path)
      const obstacle = node.node.children.length > 0 && containsTarget
        ? nodeHeaderRect(node)
        : nodeRect(node)
      if (
        initial.points.slice(1).some((point, index) => segmentCrossesInterior(initial.points[index]!, point, obstacle))
      ) report("node-crossing", initial.initial.id, node.node.path)
    }
  }

  for (let left = 0; left < transitions.length; left++) {
    const leftEdge = transitions[left]!
    const leftRect = labelRect(leftEdge.label, leftEdge.labelWidth, leftEdge.labelHeight)
    for (let right = left + 1; right < transitions.length; right++) {
      const rightEdge = transitions[right]!
      const rightRect = labelRect(rightEdge.label, rightEdge.labelWidth, rightEdge.labelHeight)
      if (overlaps(leftRect, rightRect, 2)) {
        report("label-label-overlap", leftEdge.edge.id, rightEdge.edge.id)
      }
    }
    for (const other of layout.edges) {
      if (laidOutEdgeId(other) === leftEdge.edge.id) continue
      if (
        other.points.slice(1).some((point, index) => segmentCrossesInterior(other.points[index]!, point, leftRect))
      ) report("label-route-overlap", leftEdge.edge.id, laidOutEdgeId(other))
    }
  }

  const allSegments = segments(layout)
  for (let left = 0; left < allSegments.length; left++) {
    for (let right = left + 1; right < allSegments.length; right++) {
      const first = allSegments[left]!
      const second = allSegments[right]!
      if (first.edgeId === second.edgeId) continue
      if (collinearOverlap(first, second) > 4) report("route-overlap", first.edgeId, second.edgeId)
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    crossings: crossingCount(allSegments),
    routeLength: layout.edges.reduce((sum, edge) => sum + chartRouteLength(edge.points), 0)
  }
}

type ChartLayoutEngine = (graph: ElkNode, portConstraints: PortConstraints) => Promise<ElkNode>

interface LayoutAttemptFailure {
  readonly profile: string
  readonly cause: unknown
}

interface InvalidLayoutCandidate {
  readonly profile: string
  readonly validation: ChartLayoutValidation
}

const causeMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

const issueSummary = (validation: ChartLayoutValidation): string => {
  const counts = new Map<ChartLayoutIssueCode, number>()
  for (const issue of validation.issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1)
  const summary = [...counts].map(([code, count]) => `${code} (${count})`).join(", ")
  const examples = validation.issues.slice(0, 3).map(({ code, edgeId, relatedId }) =>
    `${code}:${edgeId}${relatedId === null ? "" : `:${relatedId}`}`
  ).join(", ")
  return examples.length === 0 ? summary : `${summary}; ${examples}`
}

export const layoutChartWith = (
  model: ChartModel,
  layout: ChartLayoutEngine
): Effect.Effect<LaidOutChart, ChartLayoutError> =>
  Effect.suspend(() => {
    const policy = makeChartLayoutPolicy(model)
    const regions = unconnectedRegions(model, policy)
    const failures: Array<LayoutAttemptFailure> = []
    const invalid: Array<InvalidLayoutCandidate> = []

    const attempt = (index: number): Effect.Effect<LaidOutChart, ChartLayoutError> => {
      const profile = layoutProfiles[index]
      if (profile === undefined) {
        const best = [...invalid].sort((left, right) =>
          validationScore(left.validation) - validationScore(right.validation)
        )[0]
        const detail = best === undefined
          ? failures.map(({ cause, profile }) => `${profile}: ${causeMessage(cause)}`).join("; ")
          : `${best.profile}: ${issueSummary(best.validation)}`
        return Effect.fail(
          new ChartLayoutError({
            cause: { failures, invalid },
            message:
              `ELK did not produce a safe layout for ${model.machineId} after ${layoutProfiles.length} deterministic attempts: ${detail}`
          })
        )
      }
      return Effect.matchEffect(
        Effect.tryPromise({
          try: () => layout(makeGraph(model, policy, regions, profile), profile.portConstraints),
          catch: (cause) => cause
        }),
        {
          onFailure: (cause) => {
            failures.push({ profile: profile.id, cause })
            return attempt(index + 1)
          },
          onSuccess: (graph) => {
            const candidate = collectLayout(model, graph, regions)
            const validation = validateChartLayout(model, candidate)
            if (validation.valid) return Effect.succeed(candidate)
            invalid.push({ profile: profile.id, validation })
            return attempt(index + 1)
          }
        }
      )
    }

    return attempt(0)
  })

export const layoutChart = (model: ChartModel): Effect.Effect<LaidOutChart, ChartLayoutError> =>
  layoutChartWith(model, (graph) => elk.layout(graph))
