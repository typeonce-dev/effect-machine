import type {
  Activity as VisualizationActivity,
  Branch as VisualizationBranch,
  MachineDocument as VisualizationDocument,
  State as VisualizationState,
  Transition as VisualizationTransition
} from "../../MachineDocument.js"
import { type InputField, projectInputSchema } from "./input-form.js"
import { stateLabel, triggerLabel } from "./visualizer-model.js"

export interface ChartField {
  readonly key: string
  readonly label: string
  readonly type: string
  readonly required: boolean
}

export interface ChartActivity {
  readonly id: string
  readonly kind: VisualizationActivity["type"]
  readonly label: string
}

export interface ChartNode {
  readonly path: string
  readonly label: string
  readonly type: VisualizationState["type"]
  readonly parent: string | null
  readonly children: ReadonlyArray<string>
  readonly active: boolean
  readonly initial: boolean
  readonly fields: ReadonlyArray<ChartField>
  readonly activities: ReadonlyArray<ChartActivity>
}

export interface ChartEdge {
  readonly id: string
  readonly transitionId: string
  readonly branchIds: ReadonlyArray<string>
  readonly kind: "target" | "targetless" | "runtime"
  readonly source: string
  readonly target: string | null
  readonly label: string
  readonly trigger: VisualizationTransition["trigger"]
  readonly activityKind: ChartActivity["kind"] | null
  readonly reenter: boolean
  readonly acceptance: VisualizationTransition["acceptance"]
}

export interface ChartRuntimeTarget {
  readonly id: string
  readonly edgeId: string
  readonly parent: string | null
  readonly label: string
}

export interface ChartInitial {
  readonly id: string
  readonly target: string
  readonly parent: string | null
}

export interface ChartModel {
  readonly machineId: string
  readonly roots: ReadonlyArray<string>
  readonly nodes: ReadonlyArray<ChartNode>
  readonly edges: ReadonlyArray<ChartEdge>
  readonly runtimeTargets: ReadonlyArray<ChartRuntimeTarget>
  readonly initials: ReadonlyArray<ChartInitial>
}

const literalType = (value: string | number | boolean | null): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value)

const fieldType = (field: InputField): string => {
  switch (field._tag) {
    case "String":
      return field.format ?? "string"
    case "Number":
      return field.integer ? "integer" : "number"
    case "Boolean":
      return "boolean"
    case "Enum":
      return field.values.map(literalType).join(" | ")
    case "Literal":
      return literalType(field.value)
    case "Object":
      return "object"
    case "Array":
      return `${fieldType(field.item)}[]`
    case "Union":
      return field.alternatives.map(fieldType).join(" | ")
    case "Unsupported":
      return "unknown"
  }
}

const stateFields = (state: VisualizationState): ReadonlyArray<ChartField> => {
  if (state.valueSchema === null) return []
  const projected = projectInputSchema(state.valueSchema)
  if (projected._tag !== "Object") {
    return [{
      key: "value",
      label: projected.title ?? "value",
      type: fieldType(projected),
      required: true
    }]
  }
  return projected.fields
    .filter(({ key }) => key !== "_tag")
    .map(({ field, key, required }) => ({
      key,
      label: field.title ?? key,
      type: fieldType(field),
      required
    }))
}

const activityLabel = (activity: VisualizationActivity): string => {
  switch (activity.type) {
    case "machine":
      return `${activity.lifecycleId} → ${activity.child.machineId ?? activity.child.id}`
    case "timer":
      return `${activity.lifecycleId} · ${activity.duration}`
    case "process":
    case "effect":
    case "stream":
      return activity.lifecycleId
  }
}

const transitionLabel = (transition: VisualizationTransition, branch: VisualizationBranch): string => {
  const trigger = triggerLabel(transition)
  return branch.type === "branch" ? `${trigger} · ${branch.title}` : trigger
}

interface EdgeGroup {
  readonly kind: ChartEdge["kind"]
  readonly target: string | null
  readonly branches: Array<VisualizationBranch>
}

const edgeGroup = (
  branch: VisualizationBranch,
  states: ReadonlyMap<string, VisualizationState>
): { readonly key: string; readonly kind: ChartEdge["kind"]; readonly target: string | null } => {
  if (branch.target !== null && states.has(branch.target)) {
    return { key: `target:${branch.target}`, kind: "target", target: branch.target }
  }
  if (branch.selection.kind === "none" || branch.selection.kind === "update") {
    return { key: "targetless", kind: "targetless", target: null }
  }
  return { key: "runtime", kind: "runtime", target: null }
}

export const makeChartModel = (document: VisualizationDocument): ChartModel => {
  const active = new Set(document.snapshot?.activePaths ?? [])
  const initialPaths = new Set([document.initial.target])
  const activities = new Map(document.activities.map((activity) => [activity.id, activity]))
  const activitiesBySource = new Map<string, Map<string, ChartActivity["kind"]>>()
  for (const activity of document.activities) {
    const sourceActivities = activitiesBySource.get(activity.source) ?? new Map()
    sourceActivities.set(activity.lifecycleId, activity.type)
    activitiesBySource.set(activity.source, sourceActivities)
  }
  const states = new Map(document.states.map((state) => [state.path, state]))

  for (const state of document.states) {
    if (state.initial !== null) initialPaths.add(state.initial)
  }

  const nodes = document.states.map((state): ChartNode => ({
    path: state.path,
    label: stateLabel(state),
    type: state.type,
    parent: state.parent,
    children: [...state.children],
    active: active.has(state.path),
    initial: initialPaths.has(state.path),
    fields: stateFields(state),
    activities: state.activityIds.flatMap((id): ReadonlyArray<ChartActivity> => {
      const activity = activities.get(id)
      return activity === undefined ? [] : [{ id, kind: activity.type, label: activityLabel(activity) }]
    })
  }))

  const edges = document.transitions.flatMap((transition): ReadonlyArray<ChartEdge> => {
    if (!states.has(transition.source)) return []
    const groups = new Map<string, EdgeGroup>()
    for (const branch of transition.branches) {
      const group = edgeGroup(branch, states)
      const current = groups.get(group.key)
      if (current === undefined) {
        groups.set(group.key, { kind: group.kind, target: group.target, branches: [branch] })
      } else {
        current.branches.push(branch)
      }
    }
    return [...groups].map(([key, { branches, kind, target }]): ChartEdge => ({
      id: branches.length === 1 ? branches[0]!.id : `${transition.id}:${key}`,
      transitionId: transition.id,
      branchIds: branches.map(({ id }) => id),
      kind,
      source: transition.source,
      target,
      label: branches.length === 1
        ? transitionLabel(transition, branches[0]!)
        : `${triggerLabel(transition)} · ${branches.length} branches`,
      trigger: transition.trigger,
      activityKind: transition.trigger.type === "invoke"
        ? activitiesBySource.get(transition.source)?.get(transition.trigger.id) ?? null
        : null,
      reenter: transition.reenter,
      acceptance: transition.acceptance
    }))
  })

  const runtimeTargets = edges.flatMap((edge): ReadonlyArray<ChartRuntimeTarget> => {
    if (edge.kind !== "runtime") return []
    const source = states.get(edge.source)
    return source === undefined
      ? []
      : [{
        id: `runtime:${edge.id}`,
        edgeId: edge.id,
        parent: source.parent,
        label: "runtime target"
      }]
  })

  const initials = [...initialPaths].flatMap((target): ReadonlyArray<ChartInitial> => {
    const state = states.get(target)
    return state === undefined ? [] : [{ id: `initial:${target}`, target, parent: state.parent }]
  })

  return {
    machineId: document.machineId,
    roots: [...document.roots],
    nodes,
    edges,
    runtimeTargets,
    initials
  }
}
