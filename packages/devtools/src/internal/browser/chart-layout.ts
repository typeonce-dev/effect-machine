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

export const maxVisibleActivities = 3
export const chartSelfLoopMinimumClearance = 24
export const chartEdgeLabelSpacing = 5

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
  | "detached-source"
  | "detached-terminal"
  | "missing-edge"
  | "label-detached"
  | "label-label-overlap"
  | "label-node-overlap"
  | "label-route-overlap"
  | "node-crossing"
  | "route-overlap"
  | "self-loop-clearance"
  | "self-loop-outside-parent"
  | "short-source"
  | "short-terminal"
  | "wrong-source-direction"
  | "wrong-terminal-direction"

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
    nodeSpacing: 48,
    layerSpacing: 72,
    edgeNodeSpacing: 28,
    edgeEdgeSpacing: 18,
    compoundNodeSpacing: 32,
    compoundLayerSpacing: 60,
    selfLoopSpacing: 40,
    padding: 36
  },
  {
    id: "spacious-fixed",
    portConstraints: "fixed",
    nodeSpacing: 68,
    layerSpacing: 96,
    edgeNodeSpacing: 42,
    edgeEdgeSpacing: 28,
    compoundNodeSpacing: 48,
    compoundLayerSpacing: 80,
    selfLoopSpacing: 48,
    padding: 48
  },
  {
    id: "roomy-fixed",
    portConstraints: "fixed",
    nodeSpacing: 88,
    layerSpacing: 124,
    edgeNodeSpacing: 58,
    edgeEdgeSpacing: 40,
    compoundNodeSpacing: 64,
    compoundLayerSpacing: 104,
    selfLoopSpacing: 56,
    padding: 60
  },
  {
    id: "spacious-relaxed",
    portConstraints: "relaxed",
    nodeSpacing: 68,
    layerSpacing: 96,
    edgeNodeSpacing: 42,
    edgeEdgeSpacing: 28,
    compoundNodeSpacing: 48,
    compoundLayerSpacing: 80,
    selfLoopSpacing: 48,
    padding: 48
  },
  {
    id: "roomy-relaxed",
    portConstraints: "relaxed",
    nodeSpacing: 88,
    layerSpacing: 124,
    edgeNodeSpacing: 58,
    edgeEdgeSpacing: 40,
    compoundNodeSpacing: 64,
    compoundLayerSpacing: 104,
    selfLoopSpacing: 56,
    padding: 60
  }
]

const activitySectionHeight = (length: number): number => {
  if (length === 0) return 0
  const visible = Math.min(length, maxVisibleActivities)
  return 16 + visible * 20 + (length > maxVisibleActivities ? 16 : 0)
}

const approximateTextWidth = (value: string, characterWidth: number): number => value.length * characterWidth

const nodeMetric = (node: ChartNode, selfLoops: number): NodeMetric => {
  const headerHeight = 52 + activitySectionHeight(node.activities.length)
  const nameWidth = approximateTextWidth(node.label, 7.2) + 55
  const activityWidth = node.activities.reduce(
    (width, activity) =>
      Math.max(
        width,
        approximateTextWidth(activity.kind.toUpperCase(), 5.5) +
          approximateTextWidth(activity.label, 6.1) + 48
      ),
    0
  )
  const minimumWidth = node.type === "choice" || node.type === "history"
    ? 132
    : node.children.length > 0
    ? 220
    : 144
  const selfLoopWidth = selfLoops <= 1 ? 0 : 144 + (selfLoops - 1) * 44
  const selfLoopHeight = selfLoops <= 1 ? 0 : 52 + (selfLoops - 1) * 16
  const width = Math.min(320, Math.max(minimumWidth, nameWidth, activityWidth, selfLoopWidth))
  return {
    width,
    height: node.children.length === 0
      ? Math.max(headerHeight, selfLoopHeight)
      : Math.max(180, headerHeight + 88),
    headerHeight
  }
}

const ELK = ELKBundle as unknown as new(args?: ELKConstructorArguments) => ElkApi
const elk = new ELK()

const sourcePortId = (edge: ChartEdge): string => `port:${edge.id}:source`
const targetPortId = (edge: ChartEdge): string => `port:${edge.id}:target`
const runtimeNodeId = (target: ChartRuntimeTarget): string => `node:${target.id}`
const runtimeTargetPortId = (target: ChartRuntimeTarget): string => `port:${target.edgeId}:target`
const unconnectedRegionId = (parent: string | null): string => `region:unconnected:${parent ?? "root"}`
const isSelfTransition = (edge: ChartEdge): boolean => edge.kind === "targetless" || edge.target === edge.source
const isDescendantPath = (path: string, ancestor: string): boolean => path.startsWith(`${ancestor}.`)

const selfLoopsBySource = (edges: ReadonlyArray<ChartEdge>): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const edge of edges) {
    if (isSelfTransition(edge)) counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1)
  }
  return counts
}

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
  const selfLoops = selfLoopsBySource(model.edges)
  const runtimeTargetsByParent = new Map<string | null, Array<ChartRuntimeTarget>>()
  for (const target of model.runtimeTargets) {
    const siblings = runtimeTargetsByParent.get(target.parent) ?? []
    siblings.push(target)
    runtimeTargetsByParent.set(target.parent, siblings)
  }
  const ports = portsByState(model.edges, policy.edge, profile.portConstraints)
  const runtimeNode = (target: ChartRuntimeTarget): ElkNode => ({
    id: runtimeNodeId(target),
    width: 118,
    height: 34,
    ports: [{
      id: runtimeTargetPortId(target),
      width: 6,
      height: 6,
      ...(profile.portConstraints === "fixed"
        ? { layoutOptions: { "elk.port.side": "NORTH" } }
        : {})
    }],
    ...(profile.portConstraints === "fixed"
      ? { layoutOptions: { "elk.portConstraints": "FIXED_SIDE" } }
      : {})
  })

  const stateNode = (node: ChartNode, suppressUnconnectedRegion: boolean): ElkNode => {
    const metric = nodeMetric(node, selfLoops.get(node.path) ?? 0)
    const nodePolicy = policy.node(node.path)
    const descendants = children(node.path, suppressUnconnectedRegion || !nodePolicy.staticPath)
    const common = {
      id: node.path,
      ports: [...ports.get(node.path) ?? []],
      layoutOptions: {
        ...(profile.portConstraints === "fixed" && node.children.length === 0
          ? { "elk.portConstraints": "FIXED_SIDE" }
          : {}),
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
        "elk.direction": node.type === "parallel" ? "RIGHT" : "DOWN",
        "elk.padding": `[top=${metric.headerHeight + 36},left=36,bottom=36,right=36]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${metric.width}, ${metric.height})`,
        "elk.spacing.nodeNode": String(profile.compoundNodeSpacing),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(profile.compoundLayerSpacing),
        "elk.spacing.edgeNode": String(profile.edgeNodeSpacing),
        "elk.spacing.edgeEdge": String(profile.edgeEdgeSpacing),
        "elk.spacing.edgeLabel": String(chartEdgeLabelSpacing),
        "elk.spacing.nodeSelfLoop": String(profile.selfLoopSpacing),
        "elk.layered.spacing.edgeNodeBetweenLayers": String(profile.edgeNodeSpacing),
        "elk.layered.spacing.edgeEdgeBetweenLayers": String(profile.edgeEdgeSpacing)
      }
    }
  }

  function children(parent: string | null, suppressUnconnectedRegion = false): Array<ElkNode> {
    const region = suppressUnconnectedRegion ? undefined : regionsByParent.get(parent)
    const regionPaths = new Set(region?.nodePaths ?? [])
    const runtimeTargets = runtimeTargetsByParent.get(parent) ?? []
    const states = policy.children(parent)
    const regular: Array<ElkNode> = [
      ...states.filter(({ path }) => !regionPaths.has(path)).map((node) => stateNode(node, suppressUnconnectedRegion)),
      ...runtimeTargets
        .filter(({ edgeId }) => !regionPaths.has(sourceByEdgeId.get(edgeId) ?? ""))
        .map(runtimeNode)
    ]
    if (region === undefined) return regular

    const regionChildren: Array<ElkNode> = [
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
        "elk.direction": "DOWN",
        "elk.padding": "[top=54,left=24,bottom=24,right=24]",
        "elk.layered.layering.layerConstraint": "LAST",
        "elk.spacing.nodeNode": String(profile.nodeSpacing),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(profile.layerSpacing),
        "elk.spacing.edgeNode": String(profile.edgeNodeSpacing),
        "elk.spacing.edgeEdge": String(profile.edgeEdgeSpacing),
        "elk.spacing.edgeLabel": String(chartEdgeLabelSpacing),
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
      })
    ],
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
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
      "elk.spacing.edgeLabel": String(chartEdgeLabelSpacing),
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

const horizontalBoundaryIntersection = (
  start: ChartPoint,
  end: ChartPoint,
  y: number,
  left: number,
  right: number
): ChartPoint | null => {
  if (start.x === end.x) {
    if (start.x < left || start.x > right || (start.y - y) * (end.y - y) > 0) return null
    return { x: start.x, y }
  }
  if (start.y !== y || end.y !== y) return null
  const minimum = Math.max(left, Math.min(start.x, end.x))
  const maximum = Math.min(right, Math.max(start.x, end.x))
  if (minimum > maximum) return null
  return { x: start.x <= end.x ? minimum : maximum, y }
}

const trimRouteFromCompoundHeader = (
  points: ReadonlyArray<ChartPoint>,
  node: LaidOutChartNode
): ReadonlyArray<ChartPoint> => {
  const boundary = node.y + node.headerHeight
  for (let index = 1; index < points.length; index++) {
    const intersection = horizontalBoundaryIntersection(
      points[index - 1]!,
      points[index]!,
      boundary,
      node.x,
      node.x + node.width
    )
    if (intersection !== null) return compactPoints([intersection, ...points.slice(index)])
  }
  return points
}

const normalizeHierarchyRoute = (
  edge: ChartEdge,
  points: ReadonlyArray<ChartPoint>,
  nodes: ReadonlyMap<string, LaidOutChartNode>
): ReadonlyArray<ChartPoint> => {
  if (edge.target !== null && isDescendantPath(edge.target, edge.source)) {
    const source = nodes.get(edge.source)
    return source === undefined ? points : trimRouteFromCompoundHeader(points, source)
  }
  if (edge.target !== null && isDescendantPath(edge.source, edge.target)) {
    const target = nodes.get(edge.target)
    return target === undefined
      ? points
      : [...trimRouteFromCompoundHeader([...points].reverse(), target)].reverse()
  }
  return points
}

type RouteSide = "NORTH" | "EAST" | "SOUTH" | "WEST"

const routeNodeRect = (node: LaidOutChartNode): ChartRect =>
  node.node.children.length > 0 ? nodeHeaderRect(node) : nodeRect(node)

const expandRect = (rect: ChartRect, amount: number): ChartRect => ({
  left: rect.left - amount,
  right: rect.right + amount,
  top: rect.top - amount,
  bottom: rect.bottom + amount
})

const endpointSide = (point: ChartPoint, node: LaidOutChartNode): RouteSide => {
  const rect = routeNodeRect(node)
  const distances: Array<readonly [RouteSide, number]> = [
    ["NORTH", Math.abs(point.y - rect.top)],
    ["SOUTH", Math.abs(point.y - rect.bottom)],
    ["WEST", Math.abs(point.x - rect.left)],
    ["EAST", Math.abs(point.x - rect.right)]
  ]
  return distances.sort((left, right) => left[1] - right[1])[0]![0]
}

const outwardPoint = (point: ChartPoint, side: RouteSide, distance: number): ChartPoint => {
  switch (side) {
    case "NORTH":
      return { x: point.x, y: point.y - distance }
    case "SOUTH":
      return { x: point.x, y: point.y + distance }
    case "WEST":
      return { x: point.x - distance, y: point.y }
    case "EAST":
      return { x: point.x + distance, y: point.y }
  }
}

const isOutwardStep = (boundary: ChartPoint, adjacent: ChartPoint, side: RouteSide): boolean =>
  side === "NORTH"
    ? adjacent.x === boundary.x && adjacent.y < boundary.y
    : side === "SOUTH"
    ? adjacent.x === boundary.x && adjacent.y > boundary.y
    : side === "WEST"
    ? adjacent.y === boundary.y && adjacent.x < boundary.x
    : adjacent.y === boundary.y && adjacent.x > boundary.x

const pointOnNodeBoundary = (
  point: ChartPoint,
  node: LaidOutChartNode,
  side: RouteSide
): ChartPoint => {
  const rect = routeNodeRect(node)
  switch (side) {
    case "NORTH":
      return { x: Math.min(rect.right, Math.max(rect.left, point.x)), y: rect.top }
    case "SOUTH":
      return { x: Math.min(rect.right, Math.max(rect.left, point.x)), y: rect.bottom }
    case "WEST":
      return { x: rect.left, y: Math.min(rect.bottom, Math.max(rect.top, point.y)) }
    case "EAST":
      return { x: rect.right, y: Math.min(rect.bottom, Math.max(rect.top, point.y)) }
  }
}

const nodeBoundaryDistance = (point: ChartPoint, node: LaidOutChartNode): number => {
  const boundary = pointOnNodeBoundary(point, node, endpointSide(point, node))
  return Math.abs(point.x - boundary.x) + Math.abs(point.y - boundary.y)
}

const orthogonalConnections = (
  start: ChartPoint,
  end: ChartPoint
): ReadonlyArray<ReadonlyArray<ChartPoint>> => {
  if (start.x === end.x || start.y === end.y) return [[start, end]]
  return [
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end]
  ]
}

const endpointConnections = (
  start: ChartPoint,
  end: ChartPoint,
  target: ChartRect,
  side: RouteSide
): ReadonlyArray<ReadonlyArray<ChartPoint>> => {
  const clearance = 12
  const detours = side === "EAST" || side === "WEST"
    ? [target.top - clearance, target.bottom + clearance].map((y) =>
      compactPoints([start, { x: start.x, y }, { x: end.x, y }, end])
    )
    : [target.left - clearance, target.right + clearance].map((x) =>
      compactPoints([start, { x, y: start.y }, { x, y: end.y }, end])
    )
  return [...orthogonalConnections(start, end), ...detours]
}

const routeObstacles = (
  edge: ChartEdge,
  nodes: ReadonlyArray<LaidOutChartNode>
): ReadonlyArray<ChartRect> =>
  nodes.flatMap((node) =>
    node.node.path === edge.source || node.node.path === edge.target
      ? []
      : [expandRect(routeNodeRect(node), 6)]
  )

const routeIsClear = (
  points: ReadonlyArray<ChartPoint>,
  obstacles: ReadonlyArray<ChartRect>
): boolean =>
  points.slice(1).every((point, index) => {
    const previous = points[index]!
    return (previous.x === point.x || previous.y === point.y) &&
      obstacles.every((obstacle) => !segmentCrossesInterior(previous, point, obstacle))
  })

const sameSideRoute = (
  points: ReadonlyArray<ChartPoint>,
  side: RouteSide,
  lane: number
): ReadonlyArray<ChartPoint> => {
  const start = points[0]!
  const end = points.at(-1)!
  const offset = 24 + lane * 8
  const coordinate = side === "NORTH"
    ? { axis: "y" as const, value: Math.min(start.y, end.y) - offset }
    : side === "SOUTH"
    ? { axis: "y" as const, value: Math.max(start.y, end.y) + offset }
    : side === "WEST"
    ? { axis: "x" as const, value: Math.min(start.x, end.x) - offset }
    : { axis: "x" as const, value: Math.max(start.x, end.x) + offset }
  return coordinate.axis === "x"
    ? compactPoints([start, { x: coordinate.value, y: start.y }, { x: coordinate.value, y: end.y }, end])
    : compactPoints([start, { x: start.x, y: coordinate.value }, { x: end.x, y: coordinate.value }, end])
}

const shortenTransitionRoute = (
  edge: ChartEdge,
  points: ReadonlyArray<ChartPoint>,
  nodes: ReadonlyMap<string, LaidOutChartNode>,
  allNodes: ReadonlyArray<LaidOutChartNode>,
  lanes: Map<string, number>
): ReadonlyArray<ChartPoint> => {
  if (edge.target === null || isSelfTransition(edge)) return points
  const source = nodes.get(edge.source)
  const target = nodes.get(edge.target)
  if (source === undefined || target === undefined) return points
  const sourceSide = endpointSide(points[0]!, source)
  const targetSide = endpointSide(points.at(-1)!, target)
  if (sourceSide !== targetSide) return points
  const obstacles = routeObstacles(edge, allNodes)
  const currentLength = chartRouteLength(points)
  const key = `${edge.target}:${targetSide}`
  const lane = lanes.get(key) ?? 0
  const candidate = sameSideRoute(points, sourceSide, lane)
  if (!routeIsClear(candidate, obstacles) || chartRouteLength(candidate) + 16 >= currentLength) return points
  lanes.set(key, lane + 1)
  return candidate
}

const normalizeTerminalDirection = (
  edge: ChartEdge,
  points: ReadonlyArray<ChartPoint>,
  nodes: ReadonlyMap<string, LaidOutChartNode>,
  allNodes: ReadonlyArray<LaidOutChartNode>
): ReadonlyArray<ChartPoint> => {
  if (edge.target === null || isSelfTransition(edge) || points.length < 2) return points
  const target = nodes.get(edge.target)
  if (target === undefined) return points
  const rawEnd = points.at(-1)!
  const side = endpointSide(rawEnd, target)
  const end = pointOnNodeBoundary(rawEnd, target, side)
  const prefix = points.slice(0, -1)
  const previous = prefix.at(-1)!
  const attached = compactPoints([...prefix, end])
  if (isOutwardStep(end, previous, side)) return attached

  const targetStub = outwardPoint(end, side, 18)
  const obstacles = [...routeObstacles(edge, allNodes), routeNodeRect(target)]
  return endpointConnections(previous, targetStub, routeNodeRect(target), side)
    .filter((connection) =>
      !connection.slice(0, -1).some((point) => point.x === end.x && point.y === end.y) &&
      routeIsClear([...connection, end], obstacles)
    )
    .map((connection) => compactPoints([...prefix, ...connection.slice(1), end]))
    .sort((left, right) => chartRouteLength(left) - chartRouteLength(right))[0] ?? attached
}

const normalizeSourceDirection = (
  edge: ChartEdge,
  points: ReadonlyArray<ChartPoint>,
  nodes: ReadonlyMap<string, LaidOutChartNode>,
  allNodes: ReadonlyArray<LaidOutChartNode>
): ReadonlyArray<ChartPoint> => {
  if (isSelfTransition(edge) || points.length < 2) return points
  const source = nodes.get(edge.source)
  if (source === undefined || source.node.children.length > 0) return points
  const rawStart = points[0]!
  const side = endpointSide(rawStart, source)
  const start = pointOnNodeBoundary(rawStart, source, side)
  const tail = points.slice(1)
  const next = tail[0]!
  const attached = compactPoints([start, ...tail])
  if (isOutwardStep(start, next, side)) return attached

  const sourceStub = outwardPoint(start, side, 18)
  const obstacles = [...routeObstacles(edge, allNodes), routeNodeRect(source)]
  return endpointConnections(sourceStub, next, routeNodeRect(source), side)
    .filter((connection) => routeIsClear([start, ...connection, ...tail.slice(1)], obstacles))
    .map((connection) => compactPoints([start, ...connection, ...tail.slice(1)]))
    .sort((left, right) => chartRouteLength(left) - chartRouteLength(right))[0] ?? attached
}

const headerDetour = (
  points: ReadonlyArray<ChartPoint>,
  node: LaidOutChartNode,
  nodes: ReadonlyArray<LaidOutChartNode>,
  lanes: Map<string, number>
): ReadonlyArray<ChartPoint> => {
  const header = nodeHeaderRect(node)
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1]!
    const end = points[index]!
    if (start.x !== end.x || !segmentCrossesInterior(start, end, header)) continue
    const candidates = (["left", "right"] as const).map((side) => {
      const key = `${node.node.path}:${side}`
      const used = lanes.get(key) ?? 0
      const laneX = side === "left"
        ? header.left - 12 - used * 8
        : header.right + 12 + used * 8
      const route = compactPoints([
        ...points.slice(0, index),
        { x: laneX, y: start.y },
        { x: laneX, y: end.y },
        end,
        ...points.slice(index + 1)
      ])
      const crossings = nodes.reduce((count, obstacleNode) => {
        if (obstacleNode.node.path === node.node.path) return count
        const obstacle = obstacleNode.node.children.length > 0
          ? nodeHeaderRect(obstacleNode)
          : nodeRect(obstacleNode)
        return count +
          route.slice(1).filter((point, segmentIndex) => segmentCrossesInterior(route[segmentIndex]!, point, obstacle))
            .length
      }, 0)
      return {
        key,
        route,
        score: crossings * 1_000_000 + used * 10_000 + chartRouteLength(route)
      }
    })
    const selected = candidates.sort((left, right) => left.score - right.score)[0]!
    lanes.set(selected.key, (lanes.get(selected.key) ?? 0) + 1)
    return selected.route
  }
  return points
}

const avoidCompoundHeaders = (
  edge: ChartEdge,
  points: ReadonlyArray<ChartPoint>,
  nodes: ReadonlyArray<LaidOutChartNode>,
  lanes: Map<string, number>
): ReadonlyArray<ChartPoint> => {
  let routed = points
  for (const node of nodes) {
    if (node.node.children.length === 0 || !transitionTouchesNode(edge, node.node.path)) continue
    if (!routed.slice(1).some((point, index) => segmentCrossesInterior(routed[index]!, point, nodeHeaderRect(node)))) {
      continue
    }
    routed = headerDetour(routed, node, nodes, lanes)
  }
  return routed
}

const routeLabelCandidates = (
  edge: ChartEdge,
  points: ReadonlyArray<ChartPoint>,
  fallback: ChartPoint,
  width: number,
  height: number
): ReadonlyArray<ChartPoint> => {
  if (isSelfTransition(edge)) return [fallback]
  const candidates = points.slice(1).flatMap((end, index) => {
    const start = points[index]!
    const horizontal = start.y === end.y
    const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y)
    const required = (horizontal ? width : height) + 24
    return length < required ? [] : [{ start, end, horizontal, length }]
  })
  const ordered = [
    ...candidates.filter(({ horizontal }) => !horizontal).sort((left, right) => right.length - left.length),
    ...candidates.filter(({ horizontal }) => horizontal).sort((left, right) => right.length - left.length)
  ].flatMap(({ start, end, horizontal, length }) => {
    const clearance = (horizontal ? width : height) / 2 + 12
    return [0.5, 2 / 3, 1 / 3].flatMap((ratio) => {
      const distance = length * ratio
      if (distance < clearance || length - distance < clearance) return []
      return [{
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio
      }]
    })
  })
  return [...ordered, fallback].filter((candidate, index, all) =>
    all.findIndex((other) => other.x === candidate.x && other.y === candidate.y) === index
  )
}

const placeTransitionLabels = (
  transitions: ReadonlyArray<LaidOutChartTransition>,
  nodes: ReadonlyArray<LaidOutChartNode>
): ReadonlyArray<LaidOutChartTransition> => {
  const placed: Array<LaidOutChartTransition> = []
  for (const transition of transitions) {
    const candidates = routeLabelCandidates(
      transition.edge,
      transition.points,
      transition.label,
      transition.labelWidth,
      transition.labelHeight
    )
    const position = candidates.find((candidate) => {
      const candidateRect = labelRect(candidate, transition.labelWidth, transition.labelHeight)
      if (
        nodes.some((node) => {
          const touchesCompound = node.node.children.length > 0 && transitionTouchesNode(
            transition.edge,
            node.node.path
          )
          return overlaps(candidateRect, touchesCompound ? nodeHeaderRect(node) : nodeRect(node), 2)
        })
      ) return false
      if (
        placed.some((other) =>
          overlaps(
            candidateRect,
            labelRect(other.label, other.labelWidth, other.labelHeight),
            2
          )
        )
      ) return false
      if (
        transitions.some((other) =>
          other.edge.id !== transition.edge.id && overlaps(
            candidateRect,
            labelRect(other.label, other.labelWidth, other.labelHeight),
            2
          )
        )
      ) return false
      return transitions.every((other) =>
        other.edge.id === transition.edge.id ||
        !other.points.slice(1).some((point, index) =>
          segmentCrossesInterior(other.points[index]!, point, candidateRect)
        )
      )
    }) ?? transition.label
    placed.push({ ...transition, label: position })
  }
  return placed
}

const collectLayout = (
  model: ChartModel,
  graph: ElkNode,
  unconnected: ReadonlyArray<UnconnectedRegion>
): LaidOutChart => {
  const chartNodes = new Map(model.nodes.map((node) => [node.path, node]))
  const chartRuntimeTargets = new Map(model.runtimeTargets.map((target) => [runtimeNodeId(target), target]))
  const chartRegions = new Map(unconnected.map((region) => [region.id, region]))
  const offsets = new Map<string, ChartPoint>([[graph.id, { x: 0, y: 0 }]])
  const regions: Array<LaidOutChartRegion> = []
  const nodes: Array<LaidOutChartNode> = []
  const initials: Array<LaidOutChartInitial> = []
  const runtimeTargets: Array<LaidOutChartRuntimeTarget> = []
  const selfLoops = selfLoopsBySource(model.edges)

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
      const metric = nodeMetric(chartNode, selfLoops.get(chartNode.path) ?? 0)
      nodes.push({
        node: chartNode,
        x: absolute.x,
        y: absolute.y,
        width: node.width ?? metric.width,
        height: node.height ?? metric.height,
        headerHeight: metric.headerHeight
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

  const nodesByPath = new Map(nodes.map((node) => [node.node.path, node]))
  for (const initial of model.initials) {
    const target = nodesByPath.get(initial.target)
    if (target === undefined) continue
    initials.push({
      initial,
      x: target.x + 9,
      y: target.y - 17,
      width: 7,
      height: 7
    })
  }

  const chartEdges = new Map(model.edges.map((edge) => [edge.id, edge]))
  const hierarchyLanes = new Map<string, number>()
  const directLanes = new Map<string, number>()
  const rawTransitionEdges = (graph.edges ?? []).flatMap(
    (edge): ReadonlyArray<LaidOutChartTransition> => {
      const offset = offsets.get(edge.container ?? graph.id) ?? { x: 0, y: 0 }
      const elkPoints = edgePoints(edge, offset)
      if (elkPoints === undefined) return []
      const chartEdge = chartEdges.get(edge.id)
      if (chartEdge === undefined) return []
      const points = normalizeTerminalDirection(
        chartEdge,
        normalizeSourceDirection(
          chartEdge,
          avoidCompoundHeaders(
            chartEdge,
            shortenTransitionRoute(
              chartEdge,
              normalizeHierarchyRoute(chartEdge, elkPoints, nodesByPath),
              nodesByPath,
              nodes,
              directLanes
            ),
            nodes,
            hierarchyLanes
          ),
          nodesByPath,
          nodes
        ),
        nodesByPath,
        nodes
      )
      const metric = labelMetric(chartEdge.label)
      const label = edge.labels?.[0]
      const labelWidth = label?.width ?? metric.width
      const labelHeight = label?.height ?? metric.height
      const elkLabel = label?.x === undefined || label.y === undefined
        ? midpoint(points)
        : add(offset, {
          x: label.x + labelWidth / 2,
          y: label.y + labelHeight / 2
        })
      const routeChanged = points.length !== elkPoints.length ||
        points.slice(1, -1).some((point, index) =>
          point.x !== elkPoints[index + 1]?.x || point.y !== elkPoints[index + 1]?.y
        )
      return [{
        kind: "transition",
        edge: chartEdge,
        points,
        label: !isSelfTransition(chartEdge) && routeChanged ? midpoint(points) : elkLabel,
        labelWidth,
        labelHeight
      }]
    }
  )
  const initialEdges = initials.flatMap(({ initial, x, y, width, height }): ReadonlyArray<LaidOutChartInitialEdge> => {
    const target = nodesByPath.get(initial.target)
    if (target === undefined) return []
    const start = { x: x + width / 2, y: y + height / 2 }
    return [{
      kind: "initial",
      initial,
      points: compactPoints([start, { x: start.x, y: target.y }])
    }]
  })
  const transitionEdges = placeTransitionLabels(rawTransitionEdges, nodes)
  const edges: ReadonlyArray<LaidOutChartTransition | LaidOutChartInitialEdge> = [
    ...transitionEdges,
    ...initialEdges
  ]
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
    const start = transition.points[0]
    const next = transition.points[1]
    if (start !== undefined && next !== undefined && !isSelfTransition(transition.edge)) {
      const source = layout.nodes.find(({ node }) => node.path === transition.edge.source)
      if (source !== undefined && source.node.children.length === 0) {
        if (Math.abs(start.x - next.x) + Math.abs(start.y - next.y) < 9) {
          report("short-source", transition.edge.id)
        }
        if (nodeBoundaryDistance(start, source) > 0.5) {
          report("detached-source", transition.edge.id, transition.edge.source)
        } else if (!isOutwardStep(start, next, endpointSide(start, source))) {
          report("wrong-source-direction", transition.edge.id, transition.edge.source)
        }
      }
    }

    const end = transition.points.at(-1)
    const bend = transition.points.at(-2)
    if (
      end === undefined || bend === undefined ||
      Math.abs(end.x - bend.x) + Math.abs(end.y - bend.y) < 9
    ) report("short-terminal", transition.edge.id)
    if (end !== undefined && transition.edge.target !== null && !isSelfTransition(transition.edge)) {
      const target = layout.nodes.find(({ node }) => node.path === transition.edge.target)
      if (target !== undefined && nodeBoundaryDistance(end, target) > 0.5) {
        report("detached-terminal", transition.edge.id, transition.edge.target)
      } else if (target !== undefined && bend !== undefined && !isOutwardStep(end, bend, endpointSide(end, target))) {
        report("wrong-terminal-direction", transition.edge.id, transition.edge.target)
      }
    }

    const label = labelRect(transition.label, transition.labelWidth, transition.labelHeight)
    for (const node of layout.nodes) {
      const touchesCompound = node.node.children.length > 0 && transitionTouchesNode(
        transition.edge,
        node.node.path
      )
      const obstacle = touchesCompound
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
type ChartLayoutValidator = (model: ChartModel, layout: LaidOutChart) => ChartLayoutValidation

interface LayoutAttemptFailure {
  readonly profile: string
  readonly cause: unknown
}

interface InvalidLayoutCandidate {
  readonly profile: string
  readonly layout: LaidOutChart
  readonly validation: ChartLayoutValidation
}

const isWarningOnlyLayout = ({ issues }: ChartLayoutValidation): boolean =>
  issues.length > 0 && issues.every(({ code }) => code === "label-route-overlap")

const bestLayoutCandidate = (
  candidates: ReadonlyArray<InvalidLayoutCandidate>
): InvalidLayoutCandidate | undefined =>
  [...candidates].sort((left, right) => validationScore(left.validation) - validationScore(right.validation))[0]

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
  layout: ChartLayoutEngine,
  validate: ChartLayoutValidator = validateChartLayout
): Effect.Effect<LaidOutChart, ChartLayoutError> =>
  Effect.suspend(() => {
    const policy = makeChartLayoutPolicy(model)
    const regions = unconnectedRegions(model, policy)
    const failures: Array<LayoutAttemptFailure> = []
    const invalid: Array<InvalidLayoutCandidate> = []

    const attempt = (index: number): Effect.Effect<LaidOutChart, ChartLayoutError> => {
      const profile = layoutProfiles[index]
      if (profile === undefined) {
        const fallback = bestLayoutCandidate(invalid.filter(({ validation }) => isWarningOnlyLayout(validation)))
        if (fallback !== undefined) return Effect.succeed(fallback.layout)
        const best = bestLayoutCandidate(invalid)
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
            const validation = validate(model, candidate)
            if (validation.valid) return Effect.succeed(candidate)
            invalid.push({ profile: profile.id, layout: candidate, validation })
            return attempt(index + 1)
          }
        }
      )
    }

    return attempt(0)
  })

export const layoutChart = (model: ChartModel): Effect.Effect<LaidOutChart, ChartLayoutError> =>
  layoutChartWith(model, (graph) => elk.layout(graph))
