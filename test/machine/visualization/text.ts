import type { ActivityDefinition, InspectionApi, MachineValue, StateNode, TransitionDefinition } from "./model.js"

const nodeLabel = (node: StateNode, active: ReadonlySet<string>): string => {
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

interface TransitionLabel {
  readonly trigger: string
  readonly branches: ReadonlyArray<string>
}

const triggerLabels = (definitions: ReadonlyArray<TransitionDefinition>): ReadonlyArray<TransitionLabel> =>
  definitions.flatMap((definition) => {
    const branches = definition.branches.flatMap((branch) => {
      if (branch.selection.kind === "update" && branch.selection.path !== undefined) {
        return [
          branch.type === "direct"
            ? `update ${branch.selection.path}`
            : `[${branch.title}] update ${branch.selection.path}`
        ]
      }
      if (branch.target === undefined) return []

      const target = branch.target.slice(branch.target.lastIndexOf(".") + 1)
      return [
        branch.type === "direct" ?
          `→ ${target}` :
          `[${branch.title}] → ${target}`
      ]
    })
    if (branches.length === 0) return []

    const reenter = definition.reenter ? " [reenter]" : ""
    const acceptance = definition.acceptance === "declinable" ? " [declinable]" : ""
    const trigger = definition.trigger.type === "event" ?
      `◇ on: ${String(definition.trigger.event)}${reenter}${acceptance}`
      : definition.trigger.type === "always" ?
      `◇ always${reenter}${acceptance}`
      : definition.trigger.type === "done" ?
      `◇ done${reenter}${acceptance}`
      : definition.trigger.type === "choice" ?
      "◇ choice"
      : `◇ invoke ${definition.trigger.id} ${definition.trigger.outcome}${reenter}${acceptance}`

    return [{ trigger, branches }]
  })

const activityLabel = (definition: ActivityDefinition): string => {
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

/**
 * Builds an experimental text renderer around a machine module's public
 * inspection functions. Keeping the module injectable lets examples use their
 * installed package without publishing visualization code as part of core.
 */
export const makeTextRenderer = <Machine extends MachineValue, Snapshot>(
  inspection: InspectionApi<Machine, Snapshot>
) =>
(
  machine: Machine,
  snapshot?: Snapshot
): string => {
  const nodes = inspection.stateNodes(machine)
  const active = new Set(
    snapshot === undefined ? [] : inspection.configuration(machine, snapshot).map((node) => node.path)
  )
  const children = new Map<string | undefined, Array<StateNode>>()
  const transitions = new Map<string, Array<TransitionDefinition>>()
  const activities = new Map<string, Array<ActivityDefinition>>()

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

  const lines = [
    machine.id ?? "Machine",
    activities.size === 0
      ? "● active  ○ inactive  ◇ transition  ┄ branch → target"
      : "● active  ○ inactive  ◇ transition  ┄ branch → target  ◆ activity",
    ""
  ]
  const visit = (node: StateNode, prefix: string, isLast: boolean): void => {
    lines.push(`${prefix}${isLast ? "└─" : "├─"} ${nodeLabel(node, active)}`)
    const descendants = children.get(node.path) ?? []
    const registrations = transitions.get(node.path) ?? []
    const ownedActivities = activities.get(node.path) ?? []
    const childPrefix = `${prefix}${isLast ? "   " : "│  "}`
    const transitionLabels = triggerLabels(registrations)
    const activityLabels = ownedActivities.map(activityLabel)
    const itemCount = transitionLabels.length + activityLabels.length + descendants.length
    transitionLabels.forEach((label, index) => {
      const isLastItem = index === itemCount - 1
      lines.push(`${childPrefix}${isLastItem ? "└─" : "├─"} ${label.trigger}`)
      const branchPrefix = `${childPrefix}${isLastItem ? "   " : "│  "}`
      label.branches.forEach((branch, branchIndex) => {
        lines.push(`${branchPrefix}${branchIndex === label.branches.length - 1 ? "└┄" : "├┄"} ${branch}`)
      })
    })
    activityLabels.forEach((label, index) => {
      const itemIndex = transitionLabels.length + index
      lines.push(`${childPrefix}${itemIndex === itemCount - 1 ? "└─" : "├─"} ${label}`)
    })
    descendants.forEach((child, index) => {
      visit(child, childPrefix, transitionLabels.length + activityLabels.length + index === itemCount - 1)
    })
  }

  const roots = children.get(undefined) ?? []
  roots.forEach((root, index) => visit(root, "", index === roots.length - 1))

  if (snapshot !== undefined) {
    const candidates = inspection.enabled(machine, snapshot)
    if (candidates.length === 0) {
      lines.push("", "Candidate events: none")
    } else {
      lines.push("", `Candidate events: ${candidates.map(String).join(", ")}`)
    }
  }
  return lines.join("\n")
}
