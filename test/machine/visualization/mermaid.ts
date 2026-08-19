import type { ActivityDefinition, InspectionApi, MachineValue, StateNode, TransitionDefinition } from "./model.js"

const indent = (depth: number): string => "  ".repeat(depth)

const escapeText = (value: string): string =>
  value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/["#%&<>]/g, (character) => {
      switch (character) {
        case "\"":
          return "#quot;"
        case "#":
          return "#35;"
        case "%":
          return "#37;"
        case "&":
          return "#38;"
        case "<":
          return "#60;"
        case ">":
          return "#62;"
        default:
          return character
      }
    })

const stateLabel = (node: StateNode, active: ReadonlySet<string>): string => {
  const status = active.has(node.path) ? "●" : "○"
  const title = node.annotations?.title === undefined ? node.key : `${node.annotations.title} (${node.key})`
  const details = node.type === "final" ?
    " [final]" :
    node.type === "history" ?
    ` [history: ${node.history ?? "shallow"}]` :
    node.type === "parallel" ?
    " [parallel]" :
    ""
  return escapeText(`${status} ${title}${details}`)
}

const triggerLabel = (definition: TransitionDefinition): string => {
  const trigger = definition.trigger.type === "event" ?
    String(definition.trigger.event) :
    definition.trigger.type === "invoke" ?
    `invoke ${definition.trigger.id} ${definition.trigger.outcome}` :
    definition.trigger.type
  return `${trigger}${definition.reenter ? " [reenter]" : ""}${
    definition.acceptance === "declinable" ? " [declinable]" : ""
  }`
}

const branchLabel = (
  definition: TransitionDefinition,
  branch: TransitionDefinition["branches"][number]
): string => {
  const suffix = branch.type === "branch" ? ` [${branch.title}]` : ""
  return escapeText(`${triggerLabel(definition)}${suffix}`)
}

const activityLabel = (definition: ActivityDefinition): string => {
  switch (definition.type) {
    case "process":
      return `process / ${definition.id}`
    case "effect":
      return `effect / ${definition.id}`
    case "timer":
      return `timer / ${definition.id} (${definition.duration})`
    case "stream":
      return `stream / ${definition.id}`
    case "machine": {
      const identity = definition.child.machineId === null ? definition.child.id : definition.child.machineId
      return `machine / ${definition.id} → ${identity}`
    }
  }
}

/**
 * Builds a Mermaid state diagram from a machine module's public inspection
 * functions. Generated state ids are independent from user-defined paths so
 * the result remains valid Mermaid for arbitrary state keys and titles.
 */
export const makeMermaidRenderer = <Machine extends MachineValue, Snapshot>(
  inspection: InspectionApi<Machine, Snapshot>
) =>
(
  machine: Machine,
  snapshot?: Snapshot
): string => {
  const nodes = inspection.stateNodes(machine)
  const initial = inspection.initialDefinition(machine)
  const active = new Set(
    snapshot === undefined ? [] : inspection.configuration(machine, snapshot).map((node) => node.path)
  )
  const ids = new Map(nodes.map((node, index) => [node.path, `state_${index}`] as const))
  const children = new Map<string | undefined, Array<StateNode>>()
  const activities = new Map<string, Array<ActivityDefinition>>()

  for (const node of nodes) {
    const siblings = children.get(node.parent) ?? []
    siblings.push(node)
    children.set(node.parent, siblings)
  }
  for (const definition of inspection.activityDefinitions?.(machine) ?? []) {
    const registrations = activities.get(definition.source) ?? []
    registrations.push(definition)
    activities.set(definition.source, registrations)
  }

  const lines = [
    "stateDiagram-v2",
    "  direction LR",
    `  accTitle: ${escapeText(machine.id ?? "Machine")}`,
    `  accDescr: ${escapeText(`State machine configuration and transitions for ${machine.id ?? "Machine"}`)}`
  ]

  const renderState = (node: StateNode, depth: number): void => {
    const id = ids.get(node.path)
    if (id === undefined) return

    lines.push(`${indent(depth)}state "${stateLabel(node, active)}" as ${id}`)
    const ownedActivities = activities.get(node.path) ?? []
    if (ownedActivities.length > 0) {
      lines.push(
        `${indent(depth)}${id}: ${ownedActivities.map((activity) => escapeText(activityLabel(activity))).join(" · ")}`
      )
    }
    if (node.type === "choice") {
      lines.push(`${indent(depth)}state ${id} <<choice>>`)
      return
    }

    const descendants = children.get(node.path) ?? []
    if (descendants.length > 0) {
      lines.push(`${indent(depth)}state ${id} {`)
      if (node.type === "parallel") {
        descendants.forEach((child, index) => {
          const childId = ids.get(child.path)
          if (childId !== undefined) lines.push(`${indent(depth + 1)}[*] --> ${childId}`)
          renderState(child, depth + 1)
          if (index < descendants.length - 1) lines.push(`${indent(depth + 1)}--`)
        })
      } else {
        const initialId = node.initial === undefined ? undefined : ids.get(node.initial)
        if (initialId !== undefined) lines.push(`${indent(depth + 1)}[*] --> ${initialId}`)
        for (const child of descendants) renderState(child, depth + 1)
      }
      lines.push(`${indent(depth)}}`)
    }

    if (node.type === "final") lines.push(`${indent(depth)}${id} --> [*]`)
  }

  const roots = children.get(undefined) ?? []
  for (const root of roots) renderState(root, 1)

  const initialId = ids.get(initial.target)
  if (initialId !== undefined) lines.push(`  [*] --> ${initialId}`)

  for (const definition of inspection.transitionDefinitions(machine)) {
    const source = ids.get(definition.source)
    if (source === undefined) continue
    for (const branch of definition.branches) {
      const target = branch.target === undefined ? undefined : ids.get(branch.target)
      if (target !== undefined) lines.push(`  ${source} --> ${target}: ${branchLabel(definition, branch)}`)
    }
  }

  return lines.join("\n")
}
