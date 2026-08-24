import { Machine } from "@typeonce/effect-machine"

export type VisualizationStateType = "atomic" | "compound" | "parallel" | "final" | "history" | "choice"

export interface VisualizationSelection {
  readonly path: string | null
  readonly kind: "state" | "initial" | "history" | "choice" | "update" | "none"
  readonly scope: "local" | "branch" | "full" | "initial" | null
}

export interface VisualizationInitial {
  readonly target: string
  readonly selection: VisualizationSelection
}

export interface VisualizationState {
  readonly path: string
  readonly key: string
  readonly title: string | null
  readonly type: VisualizationStateType
  readonly history: "shallow" | "deep" | null
  readonly parent: string | null
  readonly children: ReadonlyArray<string>
  readonly initial: string | null
  readonly transitionIds: ReadonlyArray<string>
  readonly activityIds: ReadonlyArray<string>
}

export type VisualizationTrigger =
  | {
    readonly type: "event"
    readonly event: string
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
    readonly outcome: "element" | "done" | "failure" | "snapshot"
  }

export type VisualizationBranch =
  | {
    readonly id: string
    readonly type: "direct"
    readonly target: string | null
    readonly selection: VisualizationSelection
    readonly updates: ReadonlyArray<string>
  }
  | {
    readonly id: string
    readonly type: "branch"
    readonly key: string
    readonly title: string
    readonly target: string | null
    readonly selection: VisualizationSelection
    readonly updates: ReadonlyArray<string>
  }

export interface VisualizationTransition {
  readonly id: string
  readonly source: string
  readonly trigger: VisualizationTrigger
  readonly reenter: boolean
  readonly acceptance: "required" | "declinable"
  readonly branches: ReadonlyArray<VisualizationBranch>
}

export type VisualizationActivity =
  | {
    readonly id: string
    readonly source: string
    readonly lifecycleId: string
    readonly type: "process"
  }
  | {
    readonly id: string
    readonly source: string
    readonly lifecycleId: string
    readonly type: "effect"
    readonly outcomes: {
      readonly success: "dynamic"
      readonly failure: "dynamic" | "none"
    }
  }
  | {
    readonly id: string
    readonly source: string
    readonly lifecycleId: string
    readonly type: "timer"
    readonly duration: string | "dynamic"
  }
  | {
    readonly id: string
    readonly source: string
    readonly lifecycleId: string
    readonly type: "stream"
  }
  | {
    readonly id: string
    readonly source: string
    readonly lifecycleId: string
    readonly type: "machine"
    readonly child: {
      readonly id: string
      readonly machineId: string | null
    }
  }

export interface VisualizationSnapshot {
  readonly activePaths: ReadonlyArray<string>
  readonly candidateEvents: ReadonlyArray<string>
}

export interface VisualizationDocument {
  readonly machineId: string
  readonly initial: VisualizationInitial
  readonly roots: ReadonlyArray<string>
  readonly states: ReadonlyArray<VisualizationState>
  readonly transitions: ReadonlyArray<VisualizationTransition>
  readonly activities: ReadonlyArray<VisualizationActivity>
  readonly snapshot: VisualizationSnapshot | null
}

interface MachineValue {
  readonly id: string | undefined
}

interface InspectionApi<M, Snapshot> {
  readonly stateNodes: (machine: M) => ReadonlyArray<Machine.Machine.StateNode>
  readonly initialDefinition: (machine: M) => Machine.Machine.InitialDefinition
  readonly transitionDefinitions: (machine: M) => ReadonlyArray<Machine.Machine.TransitionDefinition>
  readonly activityDefinitions?: (machine: M) => ReadonlyArray<Machine.Machine.ActivityDefinition>
  readonly configuration: (machine: M, snapshot: Snapshot) => ReadonlyArray<Machine.Machine.StateNode>
  readonly enabled: (machine: M, snapshot: Snapshot) => ReadonlyArray<PropertyKey>
}

const selection = (
  value: Machine.Machine.TransitionTargetSelection
): VisualizationSelection => ({
  path: value.path ?? null,
  kind: value.kind,
  scope: value.scope ?? null
})

const trigger = (
  value: Machine.Machine.TransitionTrigger
): VisualizationTrigger => {
  switch (value.type) {
    case "event":
      return { type: "event", event: String(value.event) }
    case "always":
      return { type: "always" }
    case "done":
      return { type: "done" }
    case "choice":
      return { type: "choice" }
    case "invoke":
      return { type: "invoke", id: value.id, outcome: value.outcome }
  }
}

const activity = (
  value: Machine.Machine.ActivityDefinition,
  id: string
): VisualizationActivity => {
  const common = { id, source: value.source, lifecycleId: value.id }
  switch (value.type) {
    case "process":
      return { ...common, type: "process" }
    case "effect":
      return {
        ...common,
        type: "effect",
        outcomes: { ...value.outcomes }
      }
    case "timer":
      return { ...common, type: "timer", duration: value.duration }
    case "stream":
      return { ...common, type: "stream" }
    case "machine":
      return { ...common, type: "machine", child: { ...value.child } }
  }
}

const appendReference = (index: Map<string, Array<string>>, owner: string, id: string): void => {
  const references = index.get(owner) ?? []
  references.push(id)
  index.set(owner, references)
}

/**
 * Captures the serializable machine information used by visualization adapters.
 * Public inspection functions remain injectable so applications can visualize
 * the package version they already use.
 */
export const makeVisualizationDocument = <M extends MachineValue, Snapshot>(
  inspection: InspectionApi<M, Snapshot>
) =>
(
  machine: M,
  snapshot?: Snapshot
): VisualizationDocument => {
  const nodes = inspection.stateNodes(machine)
  const transitionIds = new Map<string, Array<string>>()
  const activityIds = new Map<string, Array<string>>()
  const transitionOffsets = new Map<string, number>()
  const activityOffsets = new Map<string, number>()
  const childPaths = new Map<string | null, Array<string>>()

  for (const node of nodes) {
    const parent = node.parent ?? null
    const siblings = childPaths.get(parent) ?? []
    siblings.push(node.path)
    childPaths.set(parent, siblings)
  }

  const transitions = inspection.transitionDefinitions(machine).map((definition): VisualizationTransition => {
    const offset = transitionOffsets.get(definition.source) ?? 0
    transitionOffsets.set(definition.source, offset + 1)
    const id = `${definition.source}:transition:${offset}`
    appendReference(transitionIds, definition.source, id)
    return {
      id,
      source: definition.source,
      trigger: trigger(definition.trigger),
      reenter: definition.reenter,
      acceptance: definition.acceptance,
      branches: definition.branches.map((branch, branchIndex): VisualizationBranch => {
        const common = {
          id: `${id}:branch:${branchIndex}`,
          target: branch.target ?? null,
          selection: selection(branch.selection),
          updates: [...branch.updates]
        }
        return branch.type === "direct"
          ? { ...common, type: "direct" }
          : { ...common, type: "branch", key: branch.key, title: branch.title }
      })
    }
  })

  const activities = (inspection.activityDefinitions?.(machine) ?? []).map((definition): VisualizationActivity => {
    const offset = activityOffsets.get(definition.source) ?? 0
    activityOffsets.set(definition.source, offset + 1)
    const id = `${definition.source}:activity:${offset}`
    appendReference(activityIds, definition.source, id)
    return activity(definition, id)
  })

  const initial = inspection.initialDefinition(machine)
  return {
    machineId: machine.id ?? "Machine",
    initial: {
      target: initial.target,
      selection: selection(initial.selection)
    },
    roots: [...childPaths.get(null) ?? []],
    states: nodes.map((node): VisualizationState => ({
      path: node.path,
      key: node.key,
      title: node.annotations?.title ?? null,
      type: node.type,
      history: node.history ?? null,
      parent: node.parent ?? null,
      children: [...childPaths.get(node.path) ?? []],
      initial: node.initial ?? null,
      transitionIds: [...transitionIds.get(node.path) ?? []],
      activityIds: [...activityIds.get(node.path) ?? []]
    })),
    transitions,
    activities,
    snapshot: snapshot === undefined
      ? null
      : {
        activePaths: inspection.configuration(machine, snapshot).map((node) => node.path),
        candidateEvents: inspection.enabled(machine, snapshot).map(String)
      }
  }
}
