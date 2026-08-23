import { Machine } from "../../src/index.js"

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

const textConnector = (kind: TreeItemKind, isLast: boolean): string => {
  if (kind === "branch") return isLast ? "└┄" : "├┄"
  return isLast ? "└─" : "├─"
}

export const textTreeToString = (tree: TextTree): string => {
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

interface MachineValue {
  readonly id: string | undefined
}

interface InspectionApi<M, Snapshot> {
  readonly stateNodes: (machine: M) => ReadonlyArray<Machine.Machine.StateNode>
  readonly transitionDefinitions: (machine: M) => ReadonlyArray<Machine.Machine.TransitionDefinition>
  readonly activityDefinitions?: (machine: M) => ReadonlyArray<Machine.Machine.ActivityDefinition>
  readonly configuration: (machine: M, snapshot: Snapshot) => ReadonlyArray<Machine.Machine.StateNode>
  readonly enabled: (machine: M, snapshot: Snapshot) => ReadonlyArray<PropertyKey>
}

const nodeLabel = (
  node: Machine.Machine.StateNode,
  active: ReadonlySet<string>
): string => {
  const status = active.has(node.path) ? "●" : "○"
  const label = node.annotations?.title === undefined ? node.key : `${node.annotations.title} (${node.key})`
  const details: Array<string> = node.type === "atomic" ? [] : [node.type]
  if (node.initial !== undefined) {
    details.push(`initial: ${node.initial.slice(node.path.length + 1)}`)
  }
  if (node.history !== undefined) {
    details.push(node.history)
  }
  return details.length === 0 ? `${status} ${label}` : `${status} ${label} [${details.join(", ")}]`
}

const triggerLabel = (definition: Machine.Machine.TransitionDefinition): string => {
  const reenter = definition.reenter ? " [reenter]" : ""
  const acceptance = definition.acceptance === "declinable" ? " [declinable]" : ""
  switch (definition.trigger.type) {
    case "event":
      return `◇ on: ${String(definition.trigger.event)}${reenter}${acceptance}`
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

const branchLabel = (branch: Machine.Machine.TransitionBranch): string | undefined => {
  if (branch.target === undefined && branch.updates.length > 0) {
    return branch.type === "direct"
      ? `update ${branch.updates.join(", ")}`
      : `[${branch.title}] update ${branch.updates.join(", ")}`
  }
  if (branch.target === undefined) return undefined

  const target = branch.target.slice(branch.target.lastIndexOf(".") + 1)
  const updates = branch.updates.length === 0 ? "" : ` / update ${branch.updates.join(", ")}`
  return branch.type === "direct"
    ? `→ ${target}${updates}`
    : `[${branch.title}] → ${target}${updates}`
}

const activityLabel = (definition: Machine.Machine.ActivityDefinition): string => {
  switch (definition.type) {
    case "process":
      return `◆ process: ${definition.id}`
    case "effect":
      return `◆ effect: ${definition.id} [success: ${definition.outcomes.success}, failure: ${definition.outcomes.failure}]`
    case "timer":
      return `◆ timer: ${definition.id} [${definition.duration}]`
    case "stream":
      return `◆ stream: ${definition.id}`
    case "machine": {
      const identity = definition.child.machineId === null ? definition.child.id : definition.child.machineId
      return `◆ machine: ${definition.id} → ${identity}`
    }
  }
}

const activityDetails = (
  definition: Machine.Machine.ActivityDefinition
): ReadonlyArray<TreeItemDetail> => {
  const common: Array<TreeItemDetail> = [
    { label: "Owner", value: definition.source },
    { label: "Lifecycle id", value: definition.id },
    { label: "Kind", value: definition.type }
  ]
  if (definition.type === "timer") common.push({ label: "Duration", value: definition.duration })
  if (definition.type === "machine") {
    common.push({ label: "Child address", value: definition.child.id })
    common.push({ label: "Machine", value: definition.child.machineId ?? "dynamic" })
  }
  return common
}

/**
 * Builds the same ordered text hierarchy as test/machine/visualization/text.ts,
 * but retains item identity and metadata so a browser can make each line interactive.
 */
export const makeTextTreeRenderer = <M extends MachineValue, Snapshot>(inspection: InspectionApi<M, Snapshot>) =>
(
  machine: M,
  snapshot?: Snapshot
): TextTree => {
  const nodes = inspection.stateNodes(machine)
  const active = new Set<string>(
    snapshot === undefined ? [] : inspection.configuration(machine, snapshot).map((node) => node.path)
  )
  const children = new Map<string | undefined, Array<(typeof nodes)[number]>>()
  const transitions = new Map<string, Array<Machine.Machine.TransitionDefinition>>()
  const activities = new Map<string, Array<Machine.Machine.ActivityDefinition>>()

  for (const node of nodes) {
    const siblings = children.get(node.parent) ?? []
    siblings.push(node)
    children.set(node.parent, siblings)
  }
  for (const definition of inspection.transitionDefinitions(machine)) {
    const registrations = transitions.get(definition.source) ?? []
    registrations.push(definition)
    transitions.set(definition.source, registrations)
  }
  for (const definition of inspection.activityDefinitions?.(machine) ?? []) {
    const registrations = activities.get(definition.source) ?? []
    registrations.push(definition)
    activities.set(definition.source, registrations)
  }

  const visit = (node: (typeof nodes)[number]): TreeItem => {
    const transitionItems = (transitions.get(node.path) ?? []).map((definition, definitionIndex): TreeItem => {
      const branchItems = definition.branches.flatMap((branch, branchIndex): ReadonlyArray<TreeItem> => {
        const label = branchLabel(branch)
        if (label === undefined) return []
        return [{
          id: `${node.path}:transition:${definitionIndex}:branch:${branchIndex}`,
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
      return {
        id: `${node.path}:transition:${definitionIndex}`,
        kind: "transition",
        label: triggerLabel(definition),
        details: [
          { label: "Source", value: definition.source },
          { label: "Acceptance", value: definition.acceptance },
          { label: "Reenter", value: definition.reenter ? "yes" : "no" },
          { label: "Branches", value: String(branchItems.length) }
        ],
        children: branchItems
      }
    })
    const activityItems = (activities.get(node.path) ?? []).map((definition, index): TreeItem => ({
      id: `${node.path}:activity:${index}`,
      kind: "activity",
      label: activityLabel(definition),
      details: activityDetails(definition),
      children: []
    }))
    const descendantItems = (children.get(node.path) ?? []).map(visit)

    return {
      id: node.path,
      kind: "state",
      label: nodeLabel(node, active),
      details: [
        { label: "Path", value: node.path },
        { label: "Type", value: node.type },
        { label: "Status", value: active.has(node.path) ? "active" : "inactive" },
        { label: "Parent", value: node.parent ?? "root" },
        { label: "Initial", value: node.initial ?? "none" },
        { label: "Children", value: String(node.children.length) }
      ],
      children: [...transitionItems, ...activityItems, ...descendantItems]
    }
  }

  const roots = (children.get(undefined) ?? []).map(visit)
  return {
    machineId: machine.id ?? "Machine",
    legend: activities.size === 0
      ? "● active  ○ inactive  ◇ transition  ┄ branch → target"
      : "● active  ○ inactive  ◇ transition  ┄ branch → target  ◆ activity",
    roots,
    candidateEvents: snapshot === undefined ? undefined : inspection.enabled(machine, snapshot).map(String)
  }
}
