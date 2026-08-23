import type {
  VisualizationActivity,
  VisualizationBranch,
  VisualizationDocument,
  VisualizationState,
  VisualizationTransition
} from "./visualization-document.js"

export type TreeItemKind = "state" | "transition" | "branch" | "activity"

export interface TreeItemDetail {
  readonly label: string
  readonly value: string
}

export interface TreeItem {
  readonly id: string
  readonly kind: TreeItemKind
  readonly label: string
  readonly details: ReadonlyArray<TreeItemDetail>
  readonly children: ReadonlyArray<TreeItem>
}

export interface TextTree {
  readonly machineId: string
  readonly legend: string
  readonly roots: ReadonlyArray<TreeItem>
  readonly candidateEvents: ReadonlyArray<string> | undefined
}

const nodeLabel = (node: VisualizationState, active: ReadonlySet<string>): string => {
  const status = active.has(node.path) ? "●" : "○"
  const label = node.title === null ? node.key : `${node.title} (${node.key})`
  const details: Array<string> = node.type === "atomic" ? [] : [node.type]
  if (node.initial !== null) {
    details.push(`initial: ${node.initial.slice(node.path.length + 1)}`)
  }
  if (node.history !== null) {
    details.push(node.history)
  }
  return details.length === 0 ? `${status} ${label}` : `${status} ${label} [${details.join(", ")}]`
}

const triggerLabel = (definition: VisualizationTransition): string => {
  const reenter = definition.reenter ? " [reenter]" : ""
  const acceptance = definition.acceptance === "declinable" ? " [declinable]" : ""
  switch (definition.trigger.type) {
    case "event":
      return `◇ on: ${definition.trigger.event}${reenter}${acceptance}`
    case "always":
      return `◇ always${reenter}${acceptance}`
    case "done":
      return `◇ done${reenter}${acceptance}`
    case "choice":
      return "◇ choice"
    case "invoke":
      return `◇ invoke ${definition.trigger.id} ${definition.trigger.outcome}${reenter}${acceptance}`
  }
}

const branchLabel = (branch: VisualizationBranch): string | undefined => {
  if (branch.target === null && branch.updates.length > 0) {
    return branch.type === "direct"
      ? `update ${branch.updates.join(", ")}`
      : `[${branch.title}] update ${branch.updates.join(", ")}`
  }
  if (branch.target === null) return undefined

  const target = branch.target.slice(branch.target.lastIndexOf(".") + 1)
  const updates = branch.updates.length === 0 ? "" : ` / update ${branch.updates.join(", ")}`
  return branch.type === "direct"
    ? `→ ${target}${updates}`
    : `[${branch.title}] → ${target}${updates}`
}

const activityLabel = (definition: VisualizationActivity): string => {
  switch (definition.type) {
    case "process":
      return `◆ process: ${definition.lifecycleId}`
    case "effect":
      return `◆ effect: ${definition.lifecycleId} [success: ${definition.outcomes.success}, failure: ${definition.outcomes.failure}]`
    case "timer":
      return `◆ timer: ${definition.lifecycleId} [${definition.duration}]`
    case "stream":
      return `◆ stream: ${definition.lifecycleId}`
    case "machine": {
      const identity = definition.child.machineId ?? definition.child.id
      return `◆ machine: ${definition.lifecycleId} → ${identity}`
    }
  }
}

const activityDetails = (definition: VisualizationActivity): ReadonlyArray<TreeItemDetail> => {
  const common: Array<TreeItemDetail> = [
    { label: "Owner", value: definition.source },
    { label: "Lifecycle id", value: definition.lifecycleId },
    { label: "Kind", value: definition.type }
  ]
  if (definition.type === "timer") common.push({ label: "Duration", value: definition.duration })
  if (definition.type === "machine") {
    common.push({ label: "Child address", value: definition.child.id })
    common.push({ label: "Machine", value: definition.child.machineId ?? "dynamic" })
  }
  return common
}

export const visualizationDocumentToTextTree = (document: VisualizationDocument): TextTree => {
  const active = new Set(document.snapshot?.activePaths ?? [])
  const states = new Map(document.states.map((state) => [state.path, state]))
  const transitions = new Map(document.transitions.map((transition) => [transition.id, transition]))
  const activities = new Map(document.activities.map((activity) => [activity.id, activity]))
  const children = new Map<string | null, Array<VisualizationState>>()

  for (const state of document.states) {
    const siblings = children.get(state.parent) ?? []
    siblings.push(state)
    children.set(state.parent, siblings)
  }

  const visit = (state: VisualizationState): TreeItem => {
    const transitionItems = state.transitionIds.flatMap((transitionId): ReadonlyArray<TreeItem> => {
      const definition = transitions.get(transitionId)
      if (definition === undefined) return []
      const branchItems = definition.branches.flatMap((branch): ReadonlyArray<TreeItem> => {
        const label = branchLabel(branch)
        if (label === undefined) return []
        return [{
          id: branch.id,
          kind: "branch",
          label,
          details: [
            { label: "Source", value: definition.source },
            { label: "Target", value: branch.target ?? "none" },
            { label: "Selection", value: branch.selection.kind },
            { label: "Scope", value: branch.selection.scope ?? "none" },
            { label: "Updates", value: branch.updates.length === 0 ? "none" : branch.updates.join(", ") }
          ],
          children: []
        }]
      })
      return [{
        id: definition.id,
        kind: "transition",
        label: triggerLabel(definition),
        details: [
          { label: "Source", value: definition.source },
          { label: "Acceptance", value: definition.acceptance },
          { label: "Reenter", value: definition.reenter ? "yes" : "no" },
          { label: "Branches", value: String(branchItems.length) }
        ],
        children: branchItems
      }]
    })
    const activityItems = state.activityIds.flatMap((activityId): ReadonlyArray<TreeItem> => {
      const definition = activities.get(activityId)
      return definition === undefined ? [] : [{
        id: definition.id,
        kind: "activity",
        label: activityLabel(definition),
        details: activityDetails(definition),
        children: []
      }]
    })
    const descendantItems = (children.get(state.path) ?? []).map(visit)

    return {
      id: state.path,
      kind: "state",
      label: nodeLabel(state, active),
      details: [
        { label: "Path", value: state.path },
        { label: "Type", value: state.type },
        { label: "Status", value: active.has(state.path) ? "active" : "inactive" },
        { label: "Parent", value: state.parent ?? "root" },
        { label: "Initial", value: state.initial ?? "none" },
        { label: "Children", value: String(state.children.length) }
      ],
      children: [...transitionItems, ...activityItems, ...descendantItems]
    }
  }

  return {
    machineId: document.machineId,
    legend: document.activities.length === 0
      ? "● active  ○ inactive  ◇ transition  ┄ branch → target"
      : "● active  ○ inactive  ◇ transition  ┄ branch → target  ◆ activity",
    roots: document.roots.flatMap((path): ReadonlyArray<TreeItem> => {
      const state = states.get(path)
      return state === undefined ? [] : [visit(state)]
    }),
    candidateEvents: document.snapshot?.candidateEvents
  }
}

const textConnector = (kind: TreeItemKind, isLast: boolean): string => {
  if (kind === "branch") return isLast ? "└┄" : "├┄"
  return isLast ? "└─" : "├─"
}

export const textTreeToString = (document: VisualizationDocument): string => {
  const tree = visualizationDocumentToTextTree(document)
  const lines = [tree.machineId, tree.legend, ""]
  const visit = (item: TreeItem, prefix: string, isLast: boolean): void => {
    lines.push(`${prefix}${textConnector(item.kind, isLast)} ${item.label}`)
    const childPrefix = `${prefix}${isLast ? "   " : "│  "}`
    item.children.forEach((child, index) => visit(child, childPrefix, index === item.children.length - 1))
  }
  tree.roots.forEach((item, index) => visit(item, "", index === tree.roots.length - 1))
  if (tree.candidateEvents !== undefined) {
    const candidates = tree.candidateEvents.length === 0 ? "none" : tree.candidateEvents.join(", ")
    lines.push("", `Candidate events: ${candidates}`)
  }
  return lines.join("\n")
}
