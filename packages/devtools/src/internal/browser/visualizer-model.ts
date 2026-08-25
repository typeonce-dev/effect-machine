import type {
  Activity as VisualizationActivity,
  Branch as VisualizationBranch,
  MachineDocument as VisualizationDocument,
  State as VisualizationState,
  Transition as VisualizationTransition
} from "../../MachineDocument.js"

export interface TopologyNode {
  readonly path: string
  readonly label: string
  readonly type: VisualizationState["type"]
  readonly active: boolean
  readonly initial: boolean
  readonly transitionCount: number
  readonly activityCount: number
  readonly children: ReadonlyArray<TopologyNode>
}

export interface StateBreadcrumb {
  readonly path: string
  readonly label: string
}

export interface IncomingTransition {
  readonly transition: VisualizationTransition
  readonly branch: VisualizationBranch
}

export interface StateInspection {
  readonly state: VisualizationState
  readonly label: string
  readonly active: boolean
  readonly initial: boolean
  readonly breadcrumbs: ReadonlyArray<StateBreadcrumb>
  readonly outgoing: ReadonlyArray<VisualizationTransition>
  readonly incoming: ReadonlyArray<IncomingTransition>
  readonly activities: ReadonlyArray<VisualizationActivity>
}

export interface EventInspection {
  readonly event: string
  readonly candidate: boolean
  readonly transitions: ReadonlyArray<VisualizationTransition>
}

export interface VisualizerModel {
  readonly machineId: string
  readonly roots: ReadonlyArray<TopologyNode>
  readonly hasSnapshot: boolean
  readonly activePaths: ReadonlyArray<string>
  readonly candidateEvents: ReadonlyArray<string>
  readonly inspectState: (path: string) => StateInspection | undefined
  readonly inspectEvent: (event: string) => EventInspection
}

export const stateLabel = (state: VisualizationState): string =>
  state.title === null ? state.key : `${state.title} (${state.key})`

export const triggerLabel = (transition: VisualizationTransition): string => {
  switch (transition.trigger.type) {
    case "event":
      return transition.trigger.event
    case "always":
      return "Always"
    case "done":
      return "On completion"
    case "choice":
      return "Choice"
    case "invoke":
      return `${transition.trigger.id} · ${transition.trigger.outcome}`
  }
}

const propertyAccess = (key: string): string => /^[$A-Z_a-z][$\w]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`

const pathAccess = (path: string): string => path.split(".").map(propertyAccess).join("")

const nearestCompoundScope = (
  document: VisualizationDocument,
  source: string
): string | undefined => {
  const states = new Map(document.states.map((state) => [state.path, state]))
  let current = states.get(source)
  while (current !== undefined) {
    if (current.type === "compound") return current.path
    current = current.parent === null ? undefined : states.get(current.parent)
  }
  return undefined
}

const localPathAccess = (
  document: VisualizationDocument,
  source: string,
  path: string
): string | undefined => {
  const scope = nearestCompoundScope(document, source)
  if (scope === undefined) return undefined
  if (path === scope) return ""
  const prefix = `${scope}.`
  return path.startsWith(prefix) ? pathAccess(path.slice(prefix.length)) : undefined
}

/** Canonical Effect Machine selector represented by one retained transition branch. */
export const branchTargetApi = (
  document: VisualizationDocument,
  source: string,
  branch: VisualizationBranch
): string | undefined => {
  const { selection } = branch
  if (selection.kind === "none") return "to.none"
  const path = selection.path
  if (path === null || selection.scope === null) return undefined

  let api: string | undefined
  if (selection.kind === "history" && selection.scope === "full") {
    api = `to.history${pathAccess(path)}`
  } else if (selection.scope === "local") {
    const local = localPathAccess(document, source, path)
    if (local === undefined) return undefined
    switch (selection.kind) {
      case "state":
        api = local === "" ? "to.local.with" : `to.local${local}()`
        break
      case "choice":
        api = local === "" ? undefined : `to.local${local}()`
        break
      case "initial":
        api = local === "" ? undefined : `to.local${local}.initial`
        break
      case "update":
        api = local === "" ? "to.local.update" : undefined
        break
      case "history":
        break
    }
  } else if (selection.scope === "branch") {
    switch (selection.kind) {
      case "state":
      case "choice":
        api = `to.branch${pathAccess(path)}()`
        break
      case "initial":
        api = `to.branch${pathAccess(path)}.initial`
        break
      case "update":
        api = `to.branch${pathAccess(path)}.update`
        break
      case "history":
        break
    }
  } else if (selection.scope === "full") {
    switch (selection.kind) {
      case "state":
      case "choice":
        api = `to.full${pathAccess(path)}()`
        break
      case "initial":
        api = `to.full${pathAccess(path)}.initial`
        break
      case "history":
        api = `to.history${pathAccess(path)}`
        break
      case "update":
        break
    }
  } else if (selection.scope === "initial") {
    if (selection.kind === "state") api = `to${pathAccess(path)}()`
    if (selection.kind === "initial") api = `to${pathAccess(path)}.initial`
  }

  if (api === undefined || selection.kind === "update") return api
  return branch.updates.reduce(
    (expression, owner) => `${expression}.updating(to.branch${pathAccess(owner)})`,
    api
  )
}

const buildInitialPaths = (document: VisualizationDocument): ReadonlySet<string> => {
  const initial = new Set<string>([document.initial.target])
  for (const state of document.states) {
    if (state.initial !== null) initial.add(state.initial)
  }
  return initial
}

export const makeVisualizerModel = (document: VisualizationDocument): VisualizerModel => {
  const states = new Map(document.states.map((state) => [state.path, state]))
  const transitions = new Map(document.transitions.map((transition) => [transition.id, transition]))
  const activities = new Map(document.activities.map((activity) => [activity.id, activity]))
  const active = new Set(document.snapshot?.activePaths ?? [])
  const initial = buildInitialPaths(document)
  const candidateEvents = document.snapshot?.candidateEvents ?? []

  const outgoing = (state: VisualizationState): ReadonlyArray<VisualizationTransition> =>
    state.transitionIds.flatMap((id): ReadonlyArray<VisualizationTransition> => {
      const transition = transitions.get(id)
      return transition === undefined ? [] : [transition]
    })

  const ownedActivities = (state: VisualizationState): ReadonlyArray<VisualizationActivity> =>
    state.activityIds.flatMap((id): ReadonlyArray<VisualizationActivity> => {
      const definition = activities.get(id)
      return definition === undefined ? [] : [definition]
    })

  const incoming = new Map<string, Array<IncomingTransition>>()
  for (const transition of document.transitions) {
    for (const branch of transition.branches) {
      if (branch.target === null) continue
      const registrations = incoming.get(branch.target) ?? []
      registrations.push({ transition, branch })
      incoming.set(branch.target, registrations)
    }
  }

  const visit = (path: string): TopologyNode | undefined => {
    const state = states.get(path)
    if (state === undefined) return undefined
    return {
      path: state.path,
      label: stateLabel(state),
      type: state.type,
      active: active.has(state.path),
      initial: initial.has(state.path),
      transitionCount: state.transitionIds.length,
      activityCount: state.activityIds.length,
      children: state.children.flatMap((childPath): ReadonlyArray<TopologyNode> => {
        const child = visit(childPath)
        return child === undefined ? [] : [child]
      })
    }
  }

  const breadcrumbs = (state: VisualizationState): ReadonlyArray<StateBreadcrumb> => {
    const result: Array<StateBreadcrumb> = []
    let current: VisualizationState | undefined = state
    while (current !== undefined) {
      result.unshift({ path: current.path, label: stateLabel(current) })
      current = current.parent === null ? undefined : states.get(current.parent)
    }
    return result
  }

  return {
    machineId: document.machineId,
    roots: document.roots.flatMap((path): ReadonlyArray<TopologyNode> => {
      const root = visit(path)
      return root === undefined ? [] : [root]
    }),
    hasSnapshot: document.snapshot !== null,
    activePaths: [...active],
    candidateEvents: [...candidateEvents],
    inspectState: (path) => {
      const state = states.get(path)
      return state === undefined
        ? undefined
        : {
          state,
          label: stateLabel(state),
          active: active.has(path),
          initial: initial.has(path),
          breadcrumbs: breadcrumbs(state),
          outgoing: outgoing(state),
          incoming: [...incoming.get(path) ?? []],
          activities: ownedActivities(state)
        }
    },
    inspectEvent: (event) => ({
      event,
      candidate: candidateEvents.includes(event),
      transitions: document.transitions.filter((transition) =>
        transition.trigger.type === "event" && transition.trigger.event === event
      )
    })
  }
}
