import { Machine } from "@typeonce/effect-machine"

const leafWidth = 112
const leafHeight = 58
const historyWidth = 100
const historyHeight = 46
const groupMinWidth = 164
const groupHeader = 36
const groupPadding = 14
const childGap = 24
const rootGap = 40
const canvasPadding = 24

export interface DiagramNode {
  readonly path: string
  readonly key: string
  readonly type: Machine.Machine.StateNode["type"]
  readonly parent: string | undefined
  readonly initial: string | undefined
  readonly depth: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface DiagramTransition {
  readonly id: string
  readonly source: string
  readonly trigger:
    | { readonly type: "event"; readonly event: PropertyKey }
    | { readonly type: "always" }
    | { readonly type: "done" }
  readonly reenter: boolean
  readonly targets:
    | { readonly type: "dynamic" }
    | { readonly type: "declared"; readonly paths: ReadonlyArray<string> }
}

export interface DiagramGraph {
  readonly id: string
  readonly width: number
  readonly height: number
  readonly nodes: ReadonlyArray<DiagramNode>
  readonly transitions: ReadonlyArray<DiagramTransition>
}

interface Dimensions {
  readonly width: number
  readonly height: number
}

export const buildDiagramGraph = <M extends Machine.Machine.Any>(machine: M): DiagramGraph => {
  const definitions = Machine.stateNodes(machine)
  const byPath = new Map(definitions.map((node) => [node.path as string, node]))
  const children = new Map<string | undefined, Array<string>>()

  for (const node of definitions) {
    const siblings = children.get(node.parent) ?? []
    siblings.push(node.path)
    children.set(node.parent, siblings)
  }

  const dimensions = new Map<string, Dimensions>()
  const measure = (path: string): Dimensions => {
    const cached = dimensions.get(path)
    if (cached !== undefined) return cached
    const node = byPath.get(path)
    if (node === undefined) throw new Error(`Missing diagram node: ${path}`)
    const childPaths = children.get(path) ?? []
    const result = childPaths.length === 0
      ? node.type === "history"
        ? { width: historyWidth, height: historyHeight }
        : { width: leafWidth, height: leafHeight }
      : (() => {
        const childDimensions = childPaths.map(measure)
        return {
          width: Math.max(
            groupMinWidth,
            groupPadding * 2 + childDimensions.reduce((total, child) => total + child.width, 0) +
              childGap * Math.max(0, childDimensions.length - 1)
          ),
          height: groupHeader + groupPadding * 2 + Math.max(...childDimensions.map(({ height }) => height))
        }
      })()
    dimensions.set(path, result)
    return result
  }

  const roots = children.get(undefined) ?? []
  roots.forEach(measure)
  const positioned: Array<DiagramNode> = []

  const place = (path: string, x: number, y: number, depth: number): void => {
    const node = byPath.get(path)
    const size = dimensions.get(path)
    if (node === undefined || size === undefined) throw new Error(`Missing measured diagram node: ${path}`)
    positioned.push({
      path,
      key: node.key,
      type: node.type,
      parent: node.parent,
      initial: node.initial,
      depth,
      x,
      y,
      ...size
    })

    let childX = x + groupPadding
    const childY = y + groupHeader + groupPadding
    for (const childPath of children.get(path) ?? []) {
      place(childPath, childX, childY, depth + 1)
      childX += measure(childPath).width + childGap
    }
  }

  let rootX = canvasPadding
  for (const root of roots) {
    place(root, rootX, canvasPadding, 0)
    rootX += measure(root).width + rootGap
  }

  const width = Math.max(
    360,
    positioned.reduce((maximum, node) => Math.max(maximum, node.x + node.width + canvasPadding), 0)
  )
  const height = Math.max(
    220,
    positioned.reduce((maximum, node) => Math.max(maximum, node.y + node.height + canvasPadding), 0)
  )

  return {
    id: machine.id ?? "Machine",
    width,
    height,
    nodes: positioned,
    transitions: Machine.transitionDefinitions(machine).map((definition, index) => ({
      id: `${definition.source}:${definition.trigger.type}:${index}`,
      source: definition.source,
      trigger: definition.trigger,
      reenter: definition.reenter,
      targets: definition.targets
    }))
  }
}
