import type { ChartEdge, ChartModel, ChartNode } from "./chart-model.js"

export type ChartPortSide = "NORTH" | "EAST" | "SOUTH" | "WEST"

export interface ChartNodeLayoutPolicy {
  readonly reachable: boolean
  readonly staticPath: boolean
  readonly rank: number | null
  readonly order: number
  readonly layerConstraint: "FIRST" | "LAST" | null
}

export interface ChartEdgeLayoutPolicy {
  readonly direction: "forward" | "backward" | "self"
  readonly sourceSide: ChartPortSide
  readonly targetSide: ChartPortSide
}

export interface ChartLayoutPolicy {
  readonly children: (parent: string | null) => ReadonlyArray<ChartNode>
  readonly node: (path: string) => ChartNodeLayoutPolicy
  readonly edge: (edge: ChartEdge) => ChartEdgeLayoutPolicy
}

const unreachableNode: ChartNodeLayoutPolicy = {
  reachable: false,
  staticPath: false,
  rank: null,
  order: Number.MAX_SAFE_INTEGER,
  layerConstraint: null
}

const directChild = (
  path: string,
  parent: string | null,
  nodes: ReadonlyMap<string, ChartNode>
): string | null => {
  let current = nodes.get(path)
  while (current !== undefined && current.parent !== parent) {
    current = current.parent === null ? undefined : nodes.get(current.parent)
  }
  return current?.path ?? null
}

const lineage = (path: string, nodes: ReadonlyMap<string, ChartNode>): ReadonlyArray<string> => {
  const result: Array<string> = []
  let current = nodes.get(path)
  while (current !== undefined) {
    result.push(current.path)
    current = current.parent === null ? undefined : nodes.get(current.parent)
  }
  return result.reverse()
}

export const makeChartLayoutPolicy = (model: ChartModel): ChartLayoutPolicy => {
  const nodes = new Map(model.nodes.map((node) => [node.path, node]))
  const declarationOrder = new Map(model.nodes.map((node, index) => [node.path, index]))
  const childrenByParent = new Map<string | null, Array<ChartNode>>()
  for (const node of model.nodes) {
    const children = childrenByParent.get(node.parent) ?? []
    children.push(node)
    childrenByParent.set(node.parent, children)
  }

  const nodePolicies = new Map<string, ChartNodeLayoutPolicy>()
  const orderedChildren = new Map<string | null, ReadonlyArray<ChartNode>>()

  const initialsByParent = new Map<string | null, Array<string>>()
  for (const initial of model.initials) {
    const initials = initialsByParent.get(initial.parent) ?? []
    initials.push(initial.target)
    initialsByParent.set(initial.parent, initials)
  }
  const outgoing = new Map<string, Array<string>>()
  for (const edge of model.edges) {
    if (edge.kind !== "target" || edge.target === null) continue
    const targets = outgoing.get(edge.source) ?? []
    targets.push(edge.target)
    outgoing.set(edge.source, targets)
  }

  const staticPaths = new Set<string>()
  const entered = new Set<string>()
  const queue: Array<string> = []
  const markReachable = (path: string): void => {
    let current = nodes.get(path)
    while (current !== undefined) {
      if (!staticPaths.has(current.path)) {
        staticPaths.add(current.path)
        queue.push(current.path)
      }
      current = current.parent === null ? undefined : nodes.get(current.parent)
    }
  }
  const enter = (path: string): void => {
    const node = nodes.get(path)
    if (node === undefined) return
    markReachable(path)
    if (entered.has(path)) return
    entered.add(path)
    if (node.type === "parallel") {
      for (const child of node.children) enter(child)
    } else if (node.type === "compound") {
      for (const initial of initialsByParent.get(node.path) ?? []) enter(initial)
    }
  }
  for (const initial of initialsByParent.get(null) ?? []) enter(initial)
  for (let index = 0; index < queue.length; index++) {
    for (const target of outgoing.get(queue[index]!) ?? []) enter(target)
  }

  for (const [parent, children] of childrenByParent) {
    const childPaths = new Set(children.map(({ path }) => path))
    const adjacency = new Map(children.map(({ path }) => [path, new Set<string>()]))
    for (const edge of model.edges) {
      if (edge.kind !== "target" || edge.target === null) continue
      const source = directChild(edge.source, parent, nodes)
      const target = directChild(edge.target, parent, nodes)
      if (source !== null && target !== null && source !== target && childPaths.has(source) && childPaths.has(target)) {
        adjacency.get(source)?.add(target)
      }
    }

    const ranks = new Map<string, number>()
    const queue: Array<string> = []
    for (const initial of model.initials) {
      if (initial.parent !== parent) continue
      const target = directChild(initial.target, parent, nodes)
      if (target !== null && childPaths.has(target) && !ranks.has(target)) {
        ranks.set(target, 0)
        queue.push(target)
      }
    }
    for (let index = 0; index < queue.length; index++) {
      const source = queue[index]!
      const nextRank = ranks.get(source)! + 1
      for (const target of adjacency.get(source) ?? []) {
        const current = ranks.get(target)
        if (current === undefined || nextRank < current) {
          ranks.set(target, nextRank)
          queue.push(target)
        }
      }
    }

    const ordered = [...children].sort((left, right) => {
      const leftRank = ranks.get(left.path)
      const rightRank = ranks.get(right.path)
      if (leftRank !== undefined && rightRank === undefined) return -1
      if (leftRank === undefined && rightRank !== undefined) return 1
      if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) return leftRank - rightRank
      return declarationOrder.get(left.path)! - declarationOrder.get(right.path)!
    })
    orderedChildren.set(parent, ordered)
    ordered.forEach((node, order) => {
      const rank = ranks.get(node.path) ?? null
      nodePolicies.set(node.path, {
        reachable: rank !== null,
        staticPath: staticPaths.has(node.path),
        rank,
        order,
        layerConstraint: rank === 0 ? "FIRST" : node.type === "final" ? "LAST" : null
      })
    })
  }

  const edgePolicy = (edge: ChartEdge): ChartEdgeLayoutPolicy => {
    if (edge.kind === "targetless" || edge.target === edge.source) {
      return { direction: "self", sourceSide: "EAST", targetSide: "EAST" }
    }
    if (edge.target === null) {
      return { direction: "forward", sourceSide: "SOUTH", targetSide: "NORTH" }
    }

    const sourceLineage = lineage(edge.source, nodes)
    const targetLineage = lineage(edge.target, nodes)
    let differentAt = 0
    while (
      differentAt < sourceLineage.length && differentAt < targetLineage.length &&
      sourceLineage[differentAt] === targetLineage[differentAt]
    ) {
      differentAt++
    }
    if (differentAt === sourceLineage.length) {
      return { direction: "forward", sourceSide: "SOUTH", targetSide: "NORTH" }
    }
    if (differentAt === targetLineage.length) {
      return { direction: "backward", sourceSide: "NORTH", targetSide: "SOUTH" }
    }

    const source = nodePolicies.get(sourceLineage[differentAt]!) ?? unreachableNode
    const target = nodePolicies.get(targetLineage[differentAt]!) ?? unreachableNode
    const backward = source.rank !== null && target.rank !== null
      ? target.rank < source.rank || target.rank === source.rank && target.order < source.order
      : target.order < source.order
    if (nodes.get(edge.source)?.parent !== nodes.get(edge.target)?.parent) {
      return backward
        ? { direction: "backward", sourceSide: "WEST", targetSide: "WEST" }
        : { direction: "forward", sourceSide: "EAST", targetSide: "EAST" }
    }
    return backward
      ? { direction: "backward", sourceSide: "NORTH", targetSide: "SOUTH" }
      : { direction: "forward", sourceSide: "SOUTH", targetSide: "NORTH" }
  }

  return {
    children: (parent) => orderedChildren.get(parent) ?? [],
    node: (path) => nodePolicies.get(path) ?? unreachableNode,
    edge: edgePolicy
  }
}
