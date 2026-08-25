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
import type { ChartEdge, ChartInitial, ChartModel, ChartNode } from "./chart-model.js"

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
  readonly nodes: ReadonlyArray<LaidOutChartNode>
  readonly initials: ReadonlyArray<LaidOutChartInitial>
  readonly edges: ReadonlyArray<LaidOutChartTransition | LaidOutChartInitialEdge>
}

export class ChartLayoutError extends Data.TaggedError("ChartLayoutError")<{
  readonly cause: unknown
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

const portsByState = (model: ChartModel): ReadonlyMap<string, ReadonlyArray<ElkPort>> => {
  const ports = new Map<string, Array<ElkPort>>()
  const add = (path: string, id: string, side: "EAST" | "WEST"): void => {
    const statePorts = ports.get(path) ?? []
    statePorts.push({
      id,
      width: 6,
      height: 6,
      layoutOptions: {
        "elk.port.side": side,
        "elk.port.index": String(statePorts.length)
      }
    })
    ports.set(path, statePorts)
  }

  for (const edge of model.edges) {
    add(edge.source, sourcePortId(edge), "EAST")
    add(edge.target, targetPortId(edge), "WEST")
  }
  for (const initial of model.initials) add(initial.target, initialTargetPortId(initial), "WEST")
  return ports
}

const labelMetric = (label: string): { readonly width: number; readonly height: number } => ({
  width: Math.min(230, Math.max(72, label.length * 7 + 20)),
  height: 26
})

const makeGraph = (model: ChartModel): ElkNode => {
  const nodesByParent = new Map<string | null, Array<ChartNode>>()
  for (const node of model.nodes) {
    const siblings = nodesByParent.get(node.parent) ?? []
    siblings.push(node)
    nodesByParent.set(node.parent, siblings)
  }
  const initialsByParent = new Map<string | null, Array<ChartInitial>>()
  for (const initial of model.initials) {
    const siblings = initialsByParent.get(initial.parent) ?? []
    siblings.push(initial)
    initialsByParent.set(initial.parent, siblings)
  }
  const ports = portsByState(model)

  const children = (parent: string | null): Array<ElkNode> => [
    ...(initialsByParent.get(parent) ?? []).map((initial): ElkNode => ({
      id: initialNodeId(initial),
      width: 14,
      height: 14
    })),
    ...(nodesByParent.get(parent) ?? []).map((node): ElkNode => {
      const metric = nodeMetric(node)
      const descendants = children(node.path)
      const common = {
        id: node.path,
        ports: [...ports.get(node.path) ?? []]
      }
      if (descendants.length === 0) {
        return {
          ...common,
          width: metric.width,
          height: metric.height,
          layoutOptions: {
            "elk.portConstraints": "FIXED_ORDER",
            "elk.spacing.portPort": "22"
          }
        }
      }
      return {
        ...common,
        children: descendants,
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          "elk.padding": `[top=${metric.headerHeight + 28},left=28,bottom=28,right=28]`,
          "elk.nodeSize.constraints": "MINIMUM_SIZE",
          "elk.nodeSize.minimum": `(${metric.width}, ${metric.height})`,
          "elk.portConstraints": "FIXED_ORDER",
          "elk.spacing.portPort": "22",
          "elk.spacing.nodeNode": "44",
          "elk.layered.spacing.nodeNodeBetweenLayers": "108"
        }
      }
    })
  ]

  return {
    id: "chart-root",
    children: children(null),
    edges: [
      ...model.edges.map((edge): ElkExtendedEdge => {
        const label = labelMetric(edge.label)
        return {
          id: edge.id,
          sources: [sourcePortId(edge)],
          targets: [targetPortId(edge)],
          labels: [{ text: edge.label, width: label.width, height: label.height }]
        }
      }),
      ...model.initials.map((initial): ElkExtendedEdge => ({
        id: initial.id,
        sources: [initialNodeId(initial)],
        targets: [initialTargetPortId(initial)]
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
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
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

const collectLayout = (model: ChartModel, graph: ElkNode): LaidOutChart => {
  const chartNodes = new Map(model.nodes.map((node) => [node.path, node]))
  const chartInitials = new Map(model.initials.map((initial) => [initialNodeId(initial), initial]))
  const offsets = new Map<string, ChartPoint>([[graph.id, { x: 0, y: 0 }]])
  const nodes: Array<LaidOutChartNode> = []
  const initials: Array<LaidOutChartInitial> = []

  const visit = (node: ElkNode, parentOffset: ChartPoint): void => {
    const absolute = add(parentOffset, { x: node.x ?? 0, y: node.y ?? 0 })
    offsets.set(node.id, absolute)
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
    for (const child of node.children ?? []) visit(child, absolute)
  }
  for (const child of graph.children ?? []) visit(child, { x: 0, y: 0 })

  const chartEdges = new Map(model.edges.map((edge) => [edge.id, edge]))
  const initialEdges = new Map(model.initials.map((initial) => [initial.id, initial]))
  const edges = (graph.edges ?? []).flatMap((edge): ReadonlyArray<LaidOutChartTransition | LaidOutChartInitialEdge> => {
    const offset = offsets.get(edge.container ?? graph.id) ?? { x: 0, y: 0 }
    const points = edgePoints(edge, offset)
    if (points === undefined) return []
    const chartEdge = chartEdges.get(edge.id)
    if (chartEdge !== undefined) {
      const metric = labelMetric(chartEdge.label)
      const label = edge.labels?.[0]
      return [{
        kind: "transition",
        edge: chartEdge,
        points,
        label: label?.x === undefined || label.y === undefined
          ? midpoint(points)
          : add(offset, {
            x: label.x + (label.width ?? metric.width) / 2,
            y: label.y + (label.height ?? metric.height) / 2
          }),
        labelWidth: label?.width ?? metric.width,
        labelHeight: label?.height ?? metric.height
      }]
    }
    const initial = initialEdges.get(edge.id)
    return initial === undefined ? [] : [{ kind: "initial", initial, points }]
  })

  return {
    width: Math.max(360, graph.width ?? 0),
    height: Math.max(280, graph.height ?? 0),
    nodes,
    initials,
    edges
  }
}

export const layoutChart = (model: ChartModel): Effect.Effect<LaidOutChart, ChartLayoutError> =>
  Effect.tryPromise({
    try: () => elk.layout(makeGraph(model)),
    catch: (cause) => new ChartLayoutError({ cause })
  }).pipe(Effect.map((graph) => collectLayout(model, graph)))
