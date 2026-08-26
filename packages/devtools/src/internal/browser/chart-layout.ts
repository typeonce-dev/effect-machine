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

export class ChartLayoutError extends Data.TaggedError("ChartLayoutError")<{
  readonly cause: unknown
  readonly message: string
}> {}

interface NodeMetric {
  readonly width: number
  readonly height: number
  readonly headerHeight: number
}

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
type PortConstraints = "fixed" | "relaxed"

export const chartEdgeTerminalClearance = 24
export const chartSelfLoopLabelGap = 8
export const chartSelfLoopParentAllowance = 78
const chartSelfLoopRouteGap = 30
const chartSelfLoopLaneGap = 52
const chartTerminalLaneGap = 18
const chartLabelCollisionGap = 8

const selfLoopAllowance = (count: number): number =>
  count === 0 ? 0 : chartSelfLoopParentAllowance + (count - 1) * chartSelfLoopLaneGap

const isDescendantPath = (path: string, ancestor: string): boolean => path.startsWith(`${ancestor}.`)

const externalIncomingCount = (model: ChartModel, source: string): number =>
  model.edges.filter((edge) =>
    edge.target !== null && isDescendantPath(edge.target, source) &&
    edge.source !== source && !isDescendantPath(edge.source, source)
  ).length

interface UnconnectedRegion {
  readonly id: string
  readonly parent: string | null
  readonly nodePaths: ReadonlyArray<string>
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
    if (edge.kind === "target" && edge.target !== null) {
      add(edge.target, targetPortId(edge), policy.targetSide)
    }
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
  portConstraints: PortConstraints
): ElkNode => {
  const nodesByPath = new Map(model.nodes.map((node) => [node.path, node]))
  const regionsByParent = new Map(regions.map((region) => [region.parent, region]))
  const sourceByEdgeId = new Map(model.edges.map((edge) => [edge.id, edge.source]))
  const layoutEdges = model.edges.filter((edge) => !isSelfTransition(edge))
  const selfLoopCounts = new Map<string, number>()
  for (const edge of model.edges) {
    if (isSelfTransition(edge)) {
      selfLoopCounts.set(edge.source, (selfLoopCounts.get(edge.source) ?? 0) + 1)
    }
  }
  const selfLoopAllowanceByParent = new Map<string, number>()
  for (const [source, count] of selfLoopCounts) {
    const parent = nodesByPath.get(source)?.parent
    if (parent === null || parent === undefined) continue
    selfLoopAllowanceByParent.set(
      parent,
      Math.max(
        selfLoopAllowanceByParent.get(parent) ?? 0,
        selfLoopAllowance(count + externalIncomingCount(model, source))
      )
    )
  }
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
  const ports = portsByState(layoutEdges, policy.edge, portConstraints)
  for (const initial of model.initials) {
    const statePorts = ports.get(initial.target) ?? []
    statePorts.push({
      id: initialTargetPortId(initial),
      width: 6,
      height: 6,
      ...(portConstraints === "fixed"
        ? { layoutOptions: { "elk.port.side": "WEST" } }
        : {})
    })
    ports.set(initial.target, statePorts)
  }

  const initialNode = (initial: ChartInitial): ElkNode => ({
    id: initialNodeId(initial),
    width: 14,
    height: 14,
    layoutOptions: {
      "elk.layered.layering.layerConstraint": "FIRST"
    }
  })
  const runtimeNode = (target: ChartRuntimeTarget): ElkNode => ({
    id: runtimeNodeId(target),
    width: 118,
    height: 34,
    ports: [{
      id: runtimeTargetPortId(target),
      width: 6,
      height: 6,
      ...(portConstraints === "fixed"
        ? { layoutOptions: { "elk.port.side": "WEST" } }
        : {})
    }],
    ...(portConstraints === "fixed"
      ? { layoutOptions: { "elk.portConstraints": "FIXED_SIDE" } }
      : {})
  })

  const stateNode = (node: ChartNode, suppressUnconnectedRegion: boolean): ElkNode => {
    const metric = nodeMetric(node)
    const nodePolicy = policy.node(node.path)
    const descendants = children(node.path, suppressUnconnectedRegion || !nodePolicy.staticPath)
    const bottomPadding = 28 + (selfLoopAllowanceByParent.get(node.path) ?? 0)
    const common = {
      id: node.path,
      ports: [...ports.get(node.path) ?? []],
      layoutOptions: {
        ...(portConstraints === "fixed" ? { "elk.portConstraints": "FIXED_SIDE" } : {}),
        "elk.spacing.portPort": "22",
        ...(nodePolicy.layerConstraint === null
          ? {}
          : { "elk.layered.layering.layerConstraint": nodePolicy.layerConstraint })
      }
    }
    if (descendants.length === 0) {
      return {
        ...common,
        width: metric.width,
        height: metric.height
      }
    }
    return {
      ...common,
      children: descendants,
      layoutOptions: {
        ...common.layoutOptions,
        "elk.algorithm": "layered",
        "elk.direction": node.type === "parallel" ? "DOWN" : "RIGHT",
        "elk.padding": `[top=${metric.headerHeight + 28},left=28,bottom=${bottomPadding},right=28]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${metric.width}, ${metric.height})`,
        "elk.spacing.nodeNode": "44",
        "elk.layered.spacing.nodeNodeBetweenLayers": node.type === "parallel" ? "64" : "108"
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
        "elk.spacing.nodeNode": "52",
        "elk.layered.spacing.nodeNodeBetweenLayers": "128"
      }
    })
    return regular
  }

  return {
    id: "chart-root",
    children: children(null),
    edges: [
      ...layoutEdges.map((edge): ElkExtendedEdge => {
        const label = labelMetric(edge.label)
        const edgeLayout = policy.edge(edge)
        return {
          id: edge.id,
          sources: [sourcePortId(edge)],
          targets: [targetPortId(edge)],
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
      "elk.padding": "[top=44,left=44,bottom=44,right=44]",
      "elk.spacing.nodeNode": "64",
      "elk.layered.spacing.nodeNodeBetweenLayers": "148",
      "elk.layered.spacing.edgeNodeBetweenLayers": "42",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "26",
      "elk.spacing.edgeNode": "28",
      "elk.spacing.edgeEdge": "20",
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

const longestSegment = (
  points: ReadonlyArray<ChartPoint>,
  matches: (start: ChartPoint, end: ChartPoint) => boolean,
  length: (start: ChartPoint, end: ChartPoint) => number
): readonly [ChartPoint, ChartPoint] | undefined => {
  let result: readonly [ChartPoint, ChartPoint] | undefined
  let resultLength = -1
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1]!
    const end = points[index]!
    if (!matches(start, end)) continue
    const candidateLength = length(start, end)
    if (candidateLength > resultLength) {
      result = [start, end]
      resultLength = candidateLength
    }
  }
  return result
}

export const selfLoopLabelPosition = (
  points: ReadonlyArray<ChartPoint>,
  labelWidth: number,
  labelHeight: number
): ChartPoint => {
  const start = points[0]
  const end = points.at(-1)
  if (start === undefined || end === undefined) return midpoint(points)

  if (Math.abs(start.y - end.y) <= Math.abs(start.x - end.x)) {
    const outerY = Math.max(...points.map(({ y }) => y))
    const segment = longestSegment(
      points,
      (left, right) => left.y === outerY && right.y === outerY,
      (left, right) => Math.abs(right.x - left.x)
    )
    return {
      x: segment === undefined ? (start.x + end.x) / 2 : (segment[0].x + segment[1].x) / 2,
      y: outerY + chartSelfLoopLabelGap + labelHeight / 2
    }
  }

  const outerX = Math.max(...points.map(({ x }) => x))
  const segment = longestSegment(
    points,
    (top, bottom) => top.x === outerX && bottom.x === outerX,
    (top, bottom) => Math.abs(bottom.y - top.y)
  )
  return {
    x: outerX + chartSelfLoopLabelGap + labelWidth / 2,
    y: segment === undefined ? (start.y + end.y) / 2 : (segment[0].y + segment[1].y) / 2
  }
}

const laidOutSelfTransition = (
  edge: ChartEdge,
  node: LaidOutChartNode,
  lane: number
): LaidOutChartTransition => {
  const metric = labelMetric(edge.label)
  const centerX = node.x + node.width / 2
  const maximumHalfWidth = Math.max(24, node.width / 2 - 24)
  const halfWidth = Math.min(maximumHalfWidth, Math.max(52, metric.width / 2 + 12))
  const bottom = node.y + node.height
  const outerY = bottom + chartSelfLoopRouteGap + lane * chartSelfLoopLaneGap
  const points = ensureChartEdgeTerminalClearance([
    { x: centerX - halfWidth, y: bottom },
    { x: centerX - halfWidth, y: outerY },
    { x: centerX + halfWidth, y: outerY },
    { x: centerX + halfWidth, y: bottom }
  ])
  return {
    kind: "transition",
    edge,
    points,
    label: selfLoopLabelPosition(points, metric.width, metric.height),
    labelWidth: metric.width,
    labelHeight: metric.height
  }
}

export const ensureChartEdgeTerminalClearance = (
  points: ReadonlyArray<ChartPoint>
): ReadonlyArray<ChartPoint> => {
  const end = points.at(-1)
  const bend = points.at(-2)
  if (end === undefined || bend === undefined || points.length < 3) return points
  const horizontal = end.y === bend.y
  const length = horizontal ? Math.abs(end.x - bend.x) : Math.abs(end.y - bend.y)
  if (length >= chartEdgeTerminalClearance) return points

  const result = points.map((point) => ({ ...point }))
  if (horizontal) {
    const direction = Math.sign(end.x - bend.x)
    if (direction === 0) return points
    let first = points.length - 2
    while (first > 0 && points[first - 1]!.x === bend.x) first--
    if (first === 0) return points
    const x = end.x - direction * chartEdgeTerminalClearance
    for (let index = first; index < points.length - 1; index++) result[index]!.x = x
  } else {
    const direction = Math.sign(end.y - bend.y)
    if (direction === 0) return points
    let first = points.length - 2
    while (first > 0 && points[first - 1]!.y === bend.y) first--
    if (first === 0) return points
    const y = end.y - direction * chartEdgeTerminalClearance
    for (let index = first; index < points.length - 1; index++) result[index]!.y = y
  }
  return compactPoints(result)
}

interface TerminalApproach {
  readonly axis: "horizontal" | "vertical"
  readonly direction: number
  readonly end: ChartPoint
  readonly bend: ChartPoint
  readonly bendIndex: number
}

const terminalApproach = (points: ReadonlyArray<ChartPoint>): TerminalApproach | undefined => {
  const end = points.at(-1)
  const bend = points.at(-2)
  const beforeBend = points.at(-3)
  if (end === undefined || bend === undefined || beforeBend === undefined) return undefined
  if (end.y === bend.y && beforeBend.x === bend.x) {
    const direction = Math.sign(end.x - bend.x)
    return direction === 0
      ? undefined
      : { axis: "vertical", direction, end, bend, bendIndex: points.length - 2 }
  }
  if (end.x === bend.x && beforeBend.y === bend.y) {
    const direction = Math.sign(end.y - bend.y)
    return direction === 0
      ? undefined
      : { axis: "horizontal", direction, end, bend, bendIndex: points.length - 2 }
  }
  return undefined
}

const moveTerminalApproach = (
  points: ReadonlyArray<ChartPoint>,
  approach: TerminalApproach,
  distance: number
): ReadonlyArray<ChartPoint> => {
  const result = points.map((point) => ({ ...point }))
  if (approach.axis === "vertical") {
    const x = approach.end.x - approach.direction * distance
    let first = approach.bendIndex
    while (first > 0 && points[first - 1]!.x === approach.bend.x) first--
    if (first === 0) {
      const start = points[0]!
      return compactPoints([
        start,
        { x, y: start.y },
        { x, y: approach.end.y },
        approach.end
      ])
    }
    for (let index = first; index <= approach.bendIndex; index++) result[index]!.x = x
  } else {
    const y = approach.end.y - approach.direction * distance
    let first = approach.bendIndex
    while (first > 0 && points[first - 1]!.y === approach.bend.y) first--
    if (first === 0) {
      const start = points[0]!
      return compactPoints([
        start,
        { x: start.x, y },
        { x: approach.end.x, y },
        approach.end
      ])
    }
    for (let index = first; index <= approach.bendIndex; index++) result[index]!.y = y
  }
  return compactPoints(result)
}

const separateTerminalApproaches = (
  transitions: ReadonlyArray<LaidOutChartTransition>
): ReadonlyArray<LaidOutChartTransition> => {
  const groups = new Map<
    string,
    Array<{ readonly edge: LaidOutChartTransition; readonly approach: TerminalApproach }>
  >()
  for (const edge of transitions) {
    if (edge.edge.target === null || isSelfTransition(edge.edge)) continue
    const approach = terminalApproach(edge.points)
    if (approach === undefined) continue
    const key = `${edge.edge.target}:${approach.axis}:${approach.direction}`
    const group = groups.get(key) ?? []
    group.push({ edge, approach })
    groups.set(key, group)
  }

  const pointsByEdgeId = new Map<string, ReadonlyArray<ChartPoint>>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.sort((left, right) => {
      const leftPosition = left.approach.axis === "vertical" ? left.approach.end.y : left.approach.end.x
      const rightPosition = right.approach.axis === "vertical" ? right.approach.end.y : right.approach.end.x
      return leftPosition - rightPosition || left.edge.edge.id.localeCompare(right.edge.edge.id)
    })
    group.forEach(({ approach, edge }, lane) => {
      pointsByEdgeId.set(
        edge.edge.id,
        moveTerminalApproach(edge.points, approach, chartEdgeTerminalClearance + lane * chartTerminalLaneGap)
      )
    })
  }
  return transitions.map((edge) => {
    const points = pointsByEdgeId.get(edge.edge.id)
    return points === undefined ? edge : { ...edge, points }
  })
}

interface ChartRect {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

const labelRect = (
  point: ChartPoint,
  width: number,
  height: number
): ChartRect => ({
  left: point.x - width / 2,
  right: point.x + width / 2,
  top: point.y - height / 2,
  bottom: point.y + height / 2
})

const overlaps = (left: ChartRect, right: ChartRect, gap: number): boolean =>
  left.left < right.right + gap && left.right > right.left - gap &&
  left.top < right.bottom + gap && left.bottom > right.top - gap

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
  const elkEdges = (graph.edges ?? []).flatMap(
    (edge): ReadonlyArray<LaidOutChartTransition | LaidOutChartInitialEdge> => {
      const offset = offsets.get(edge.container ?? graph.id) ?? { x: 0, y: 0 }
      const points = edgePoints(edge, offset)
      if (points === undefined) return []
      const chartEdge = chartEdges.get(edge.id)
      if (chartEdge !== undefined) {
        const metric = labelMetric(chartEdge.label)
        const label = edge.labels?.[0]
        const transitionPoints = ensureChartEdgeTerminalClearance(points)
        const labelWidth = label?.width ?? metric.width
        const labelHeight = label?.height ?? metric.height
        return [{
          kind: "transition",
          edge: chartEdge,
          points: transitionPoints,
          label: label?.x === undefined || label.y === undefined
            ? midpoint(transitionPoints)
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
  const nodesByPath = new Map(nodes.map((node) => [node.node.path, node]))
  const elkTransitions = separateTerminalApproaches(
    elkEdges.filter((edge): edge is LaidOutChartTransition => edge.kind === "transition")
  )
  const occupiedLabels = elkTransitions.map((edge) => labelRect(edge.label, edge.labelWidth, edge.labelHeight))
  const selfLoopLanes = new Map<string, number>()
  const selfEdges = model.edges.flatMap((edge): ReadonlyArray<LaidOutChartTransition> => {
    if (!isSelfTransition(edge)) return []
    const node = nodesByPath.get(edge.source)
    if (node === undefined) return []
    let lane = selfLoopLanes.get(edge.source) ?? 0
    let selfTransition = laidOutSelfTransition(edge, node, lane)
    while (
      occupiedLabels.some((occupied) =>
        overlaps(
          labelRect(selfTransition.label, selfTransition.labelWidth, selfTransition.labelHeight),
          occupied,
          chartLabelCollisionGap
        )
      )
    ) {
      lane++
      selfTransition = laidOutSelfTransition(edge, node, lane)
    }
    selfLoopLanes.set(edge.source, lane + 1)
    occupiedLabels.push(labelRect(selfTransition.label, selfTransition.labelWidth, selfTransition.labelHeight))
    return [selfTransition]
  })
  const edges: ReadonlyArray<LaidOutChartTransition | LaidOutChartInitialEdge> = [
    ...elkTransitions,
    ...elkEdges.filter((edge): edge is LaidOutChartInitialEdge => edge.kind === "initial"),
    ...selfEdges
  ]

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

type ChartLayoutEngine = (graph: ElkNode, portConstraints: PortConstraints) => Promise<ElkNode>

const causeMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

export const layoutChartWith = (
  model: ChartModel,
  layout: ChartLayoutEngine
): Effect.Effect<LaidOutChart, ChartLayoutError> =>
  Effect.suspend(() => {
    const policy = makeChartLayoutPolicy(model)
    const regions = unconnectedRegions(model, policy)
    const attempt = (portConstraints: PortConstraints) =>
      Effect.tryPromise({
        try: () => layout(makeGraph(model, policy, regions, portConstraints), portConstraints),
        catch: (cause) => cause
      })

    return Effect.matchEffect(attempt("fixed"), {
      onFailure: (fixedCause) =>
        attempt("relaxed").pipe(
          Effect.mapError((relaxedCause) =>
            new ChartLayoutError({
              cause: { fixed: fixedCause, relaxed: relaxedCause },
              message: `ELK could not lay out the chart after retrying with relaxed port constraints: ${
                causeMessage(relaxedCause)
              }`
            })
          )
        ),
      onSuccess: Effect.succeed
    }).pipe(
      Effect.map((graph) => collectLayout(model, graph, regions))
    )
  })

export const layoutChart = (model: ChartModel): Effect.Effect<LaidOutChart, ChartLayoutError> =>
  layoutChartWith(model, (graph) => elk.layout(graph))
