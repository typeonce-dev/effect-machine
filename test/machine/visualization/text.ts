interface StateNode {
  readonly path: string
  readonly key: string
  readonly annotations: {
    readonly title?: string | undefined
  } | undefined
  readonly type: "atomic" | "compound" | "parallel" | "final" | "history" | "choice"
  readonly history: "shallow" | "deep" | undefined
  readonly parent: string | undefined
  readonly children: ReadonlyArray<string>
  readonly initial: string | undefined
}

interface MachineValue {
  readonly id: string | undefined
}

interface TransitionDefinition {
  readonly source: string
  readonly trigger:
    | {
      readonly type: "event"
      readonly event: PropertyKey
    }
    | {
      readonly type: "always"
    }
    | {
      readonly type: "done"
    }
    | {
      readonly type: "choice"
    }
    | {
      readonly type: "invoke"
      readonly id: string
      readonly outcome: "done" | "failure" | "snapshot"
    }
  readonly reenter: boolean
  readonly targets:
    | {
      readonly type: "dynamic"
    }
    | {
      readonly type: "declared"
      readonly paths: ReadonlyArray<string>
    }
}

type ActivityDefinition =
  | {
    readonly source: string
    readonly id: string
    readonly type: "process"
  }
  | {
    readonly source: string
    readonly id: string
    readonly type: "effect"
    readonly outcomes: {
      readonly success: "dynamic"
      readonly failure: "dynamic" | "none"
    }
  }
  | {
    readonly source: string
    readonly id: string
    readonly type: "timer"
    readonly duration: string | "dynamic"
  }
  | {
    readonly source: string
    readonly id: string
    readonly type: "machine"
    readonly child: {
      readonly id: string
      readonly machineId: string | null
    }
  }

interface InspectionApi<Machine, Snapshot> {
  readonly stateNodes: (machine: Machine) => ReadonlyArray<StateNode>
  readonly transitionDefinitions: (machine: Machine) => ReadonlyArray<TransitionDefinition>
  readonly activityDefinitions?: (machine: Machine) => ReadonlyArray<ActivityDefinition>
  readonly configuration: (machine: Machine, snapshot: Snapshot) => ReadonlyArray<StateNode>
  readonly enabled: (machine: Machine, snapshot: Snapshot) => ReadonlyArray<PropertyKey>
}

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

const triggerLabels = (definitions: ReadonlyArray<TransitionDefinition>): ReadonlyArray<string> => {
  const labels: Array<string> = []
  const targets = (definition: TransitionDefinition): string =>
    definition.targets.type === "dynamic" ?
      ""
      : definition.targets.paths.length === 0 ?
      " → ∅"
      : ` → ${definition.targets.paths.map((path) => path.slice(path.lastIndexOf(".") + 1)).join(" | ")}`
  const events = definitions.flatMap((definition) =>
    definition.trigger.type === "event" ?
      [
        `${String(definition.trigger.event)}${definition.reenter ? " [reenter]" : ""}${targets(definition)}`
      ]
      : []
  )

  if (events.length > 0) {
    labels.push(`◇ on: ${events.join(", ")}`)
  }
  for (const definition of definitions) {
    if (definition.trigger.type === "always") {
      labels.push(`◇ always${definition.reenter ? " [reenter]" : ""}${targets(definition)}`)
    } else if (definition.trigger.type === "done") {
      labels.push(`◇ done${definition.reenter ? " [reenter]" : ""}${targets(definition)}`)
    } else if (definition.trigger.type === "choice") {
      labels.push(`◇ choice${targets(definition)}`)
    } else if (definition.trigger.type === "invoke") {
      labels.push(`◇ invoke ${definition.trigger.id} ${definition.trigger.outcome}${targets(definition)}`)
    }
  }
  return labels
}

const activityLabel = (definition: ActivityDefinition): string => {
  switch (definition.type) {
    case "process":
      return `◆ process: ${definition.id}`
    case "effect":
      return `◆ effect: ${definition.id} [success: ${definition.outcomes.success}, failure: ${definition.outcomes.failure}]`
    case "timer":
      return `◆ timer: ${definition.id} [${definition.duration}]`
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
      ? "● active  ○ inactive  ◇ transition (→ declared, ∅ none, omitted dynamic)"
      : "● active  ○ inactive  ◇ transition (→ declared, ∅ none, omitted dynamic)  ◆ activity",
    ""
  ]
  const visit = (node: StateNode, prefix: string, isLast: boolean): void => {
    lines.push(`${prefix}${isLast ? "└─" : "├─"} ${nodeLabel(node, active)}`)
    const descendants = children.get(node.path) ?? []
    const registrations = transitions.get(node.path) ?? []
    const ownedActivities = activities.get(node.path) ?? []
    const childPrefix = `${prefix}${isLast ? "   " : "│  "}`
    const labels = [...triggerLabels(registrations), ...ownedActivities.map(activityLabel)]
    const itemCount = labels.length + descendants.length
    labels.forEach((label, index) => {
      lines.push(`${childPrefix}${index === itemCount - 1 ? "└─" : "├─"} ${label}`)
    })
    descendants.forEach((child, index) => {
      visit(child, childPrefix, labels.length + index === itemCount - 1)
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
