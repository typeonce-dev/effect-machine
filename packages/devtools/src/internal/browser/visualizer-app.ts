import type { Diagnostic } from "../../DevToolsProtocol.js"
import type {
  Activity as VisualizationActivity,
  Branch as VisualizationBranch,
  MachineDocument as VisualizationDocument,
  Transition as VisualizationTransition
} from "../../MachineDocument.js"
import {
  type EventInspection,
  type IncomingTransition,
  makeVisualizerModel,
  type StateInspection,
  type TopologyNode,
  triggerLabel
} from "./visualizer-model.js"

const createElement = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string,
  text?: string
): HTMLElementTagNameMap[Tag] => {
  const element = document.createElement(tag)
  if (className !== undefined) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

const metadata = (items: ReadonlyArray<readonly [string, string]>): HTMLDListElement => {
  const list = createElement("dl", "metadata")
  for (const [label, value] of items) {
    list.append(createElement("dt", undefined, label), createElement("dd", undefined, value))
  }
  return list
}

const badge = (text: string, kind = "neutral"): HTMLSpanElement => createElement("span", `badge badge-${kind}`, text)

type StateNavigator = (path: string) => void

const stateLink = (path: string, label: string, navigate: StateNavigator): HTMLButtonElement => {
  const link = createElement("button", "state-link", label)
  link.type = "button"
  link.addEventListener("click", () => navigate(path))
  return link
}

const renderBranch = (branch: VisualizationBranch, navigate: StateNavigator): HTMLElement => {
  const row = createElement("div", "branch-row")
  const main = createElement("div", "branch-main")
  if (branch.type === "branch") main.append(badge(branch.title, "condition"))
  main.append(createElement("span", "branch-arrow", "→"))
  if (branch.target !== null) {
    main.append(stateLink(branch.target, branch.target, navigate))
  } else {
    main.append(createElement("span", "branch-target", branch.updates.length > 0 ? "Remain in state" : "No target"))
  }
  row.append(main)

  const details: Array<readonly [string, string]> = [
    ["Selection", branch.selection.kind],
    ["Scope", branch.selection.scope ?? "none"]
  ]
  row.append(metadata(details))
  if (branch.updates.length > 0) {
    const updates = createElement("div", "branch-updates")
    updates.append(createElement("span", "branch-updates-label", "Updates"))
    branch.updates.forEach((path) => updates.append(stateLink(path, path, navigate)))
    row.append(updates)
  }
  return row
}

const renderTransition = (
  transition: VisualizationTransition,
  navigate: StateNavigator,
  showSource = false
): HTMLElement => {
  const card = createElement("article", "inspection-card transition-card")
  const header = createElement("div", "card-header")
  const title = createElement("div", "card-title")
  title.append(badge(transition.trigger.type, "trigger"), createElement("strong", undefined, triggerLabel(transition)))
  const flags = createElement("div", "card-flags")
  if (transition.reenter) flags.append(badge("reenter"))
  if (transition.acceptance === "declinable") flags.append(badge("declinable"))
  header.append(title, flags)
  card.append(header)
  if (showSource) {
    const source = createElement("div", "transition-source")
    source.append(createElement("span", undefined, "From"), stateLink(transition.source, transition.source, navigate))
    card.append(source)
  }

  const branches = createElement("div", "branch-list")
  if (transition.branches.length === 0) {
    branches.append(createElement("div", "empty-inline", "No transition branches"))
  } else {
    transition.branches.forEach((branch) => branches.append(renderBranch(branch, navigate)))
  }
  card.append(branches)
  return card
}

const renderIncomingTransition = (incoming: IncomingTransition, navigate: StateNavigator): HTMLElement => {
  const card = createElement("article", "inspection-card incoming-card")
  const header = createElement("div", "card-header")
  const title = createElement("div", "card-title")
  title.append(
    badge(incoming.transition.trigger.type, "trigger"),
    createElement("strong", undefined, triggerLabel(incoming.transition))
  )
  header.append(title, stateLink(incoming.transition.source, incoming.transition.source, navigate))
  card.append(header)

  const details: Array<readonly [string, string]> = [
    ["Selection", incoming.branch.selection.kind],
    ["Scope", incoming.branch.selection.scope ?? "none"]
  ]
  if (incoming.branch.type === "branch") details.unshift(["Branch", incoming.branch.title])
  card.append(metadata(details))
  return card
}

const activityTitle = (activity: VisualizationActivity): string => {
  switch (activity.type) {
    case "process":
    case "effect":
    case "timer":
    case "stream":
      return activity.lifecycleId
    case "machine":
      return `${activity.lifecycleId} → ${activity.child.machineId ?? activity.child.id}`
  }
}

const renderActivity = (activity: VisualizationActivity): HTMLElement => {
  const card = createElement("article", "inspection-card activity-card")
  const header = createElement("div", "card-header")
  const title = createElement("div", "card-title")
  title.append(badge(activity.type, "activity"), createElement("strong", undefined, activityTitle(activity)))
  header.append(title)
  card.append(header)

  const details: Array<readonly [string, string]> = [["Owner", activity.source]]
  if (activity.type === "timer") details.push(["Duration", activity.duration])
  if (activity.type === "effect") {
    details.push(["Success", activity.outcomes.success], ["Failure", activity.outcomes.failure])
  }
  if (activity.type === "machine") {
    details.push(["Child address", activity.child.id], ["Machine", activity.child.machineId ?? "dynamic"])
  }
  card.append(metadata(details))
  return card
}

const inspectionSection = (title: string, count: number): HTMLElement => {
  const header = createElement("div", "section-heading")
  header.append(createElement("h3", undefined, title), createElement("span", "section-count", String(count)))
  return header
}

export const renderVisualizer = (
  root: HTMLElement,
  visualization: VisualizationDocument,
  diagnostics: ReadonlyArray<Diagnostic> = []
): void => {
  const model = makeVisualizerModel(visualization)
  const rows = new Map<string, HTMLElement>()
  const nodes = new Map<string, HTMLElement>()
  const eventButtons = new Map<string, HTMLElement>()
  const relatedPaths = new Set<string>()
  let selectedPath: string | undefined
  let selectedEvent: string | undefined

  const shell = createElement("main", "app-shell")
  const workspace = createElement("section", "workspace")
  const treePanel = createElement("section", "tree-panel")
  treePanel.setAttribute("aria-label", `${model.machineId} topology`)
  const inspector = createElement("aside", "inspector")
  inspector.setAttribute("aria-live", "polite")

  const clearButton = createElement("button", "toolbar-button", "Clear selection")
  clearButton.type = "button"
  clearButton.disabled = true
  const expandButton = createElement("button", "toolbar-button", "Expand all")
  expandButton.type = "button"
  const collapseButton = createElement("button", "toolbar-button", "Collapse all")
  collapseButton.type = "button"
  const revealActiveButton = createElement("button", "toolbar-button", "Reveal active")
  revealActiveButton.type = "button"
  revealActiveButton.disabled = model.activePaths.length === 0

  const renderEmptyInspector = (): void => {
    inspector.replaceChildren()
    const empty = createElement("div", "inspector-empty")
    empty.append(
      createElement("span", "inspector-empty-kind", "Inspector"),
      createElement("h2", undefined, "Select a state"),
      createElement("p", undefined, "Choose a state to inspect its topology, transitions, and activities.")
    )
    inspector.append(empty)
  }

  const renderInspection = (inspection: StateInspection): void => {
    inspector.replaceChildren()
    const header = createElement("header", "inspector-header")
    const breadcrumbs = createElement("nav", "breadcrumbs")
    breadcrumbs.setAttribute("aria-label", "State path")
    inspection.breadcrumbs.forEach((item, index) => {
      if (index > 0) breadcrumbs.append(createElement("span", "breadcrumb-separator", "/"))
      breadcrumbs.append(stateLink(item.path, item.label, navigateToState))
    })
    const eyebrow = createElement("div", "inspector-eyebrow")
    eyebrow.append(badge(inspection.state.type, "state"))
    if (inspection.active) eyebrow.append(badge("active", "active"))
    if (inspection.initial) eyebrow.append(badge("initial", "initial"))
    header.append(breadcrumbs, eyebrow, createElement("h2", undefined, inspection.label))
    header.append(metadata([
      ["Path", inspection.state.path],
      ["Parent", inspection.state.parent ?? "root"],
      ["Children", String(inspection.state.children.length)]
    ]))
    inspector.append(header)

    const transitions = createElement("section", "inspector-section")
    transitions.append(inspectionSection("Transitions", inspection.outgoing.length))
    if (inspection.outgoing.length === 0) {
      transitions.append(createElement("p", "section-empty", "No transitions leave this state."))
    } else {
      inspection.outgoing.forEach((transition) => transitions.append(renderTransition(transition, navigateToState)))
    }
    inspector.append(transitions)

    const incoming = createElement("section", "inspector-section")
    incoming.append(inspectionSection("Entered by", inspection.incoming.length))
    if (inspection.incoming.length === 0) {
      incoming.append(createElement("p", "section-empty", "No transitions target this state."))
    } else {
      inspection.incoming.forEach((transition) =>
        incoming.append(renderIncomingTransition(transition, navigateToState))
      )
    }
    inspector.append(incoming)

    if (inspection.activities.length > 0) {
      const activities = createElement("section", "inspector-section")
      activities.append(inspectionSection("Activities", inspection.activities.length))
      inspection.activities.forEach((activity) => activities.append(renderActivity(activity)))
      inspector.append(activities)
    }
  }

  const renderEventInspection = (inspection: EventInspection): void => {
    inspector.replaceChildren()
    const header = createElement("header", "inspector-header")
    const eyebrow = createElement("div", "inspector-eyebrow")
    eyebrow.append(badge("event", "trigger"))
    if (inspection.candidate) eyebrow.append(badge("enabled", "active"))
    header.append(eyebrow, createElement("h2", undefined, inspection.event))
    header.append(metadata([
      ["Status", inspection.candidate ? "enabled" : "not enabled"],
      ["Registrations", String(inspection.transitions.length)]
    ]))
    inspector.append(header)

    const transitions = createElement("section", "inspector-section")
    transitions.append(inspectionSection("Transitions", inspection.transitions.length))
    inspection.transitions.forEach((transition) =>
      transitions.append(renderTransition(transition, navigateToState, true))
    )
    inspector.append(transitions)
  }

  const clearRelations = (): void => {
    for (const path of relatedPaths) {
      nodes.get(path)?.classList.remove("is-related-source", "is-related-target", "is-related-update")
    }
    relatedPaths.clear()
  }

  const clearSelection = (): void => {
    if (selectedPath !== undefined) {
      nodes.get(selectedPath)?.classList.remove("is-selected")
      rows.get(selectedPath)?.setAttribute("aria-selected", "false")
    }
    if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
    clearRelations()
    selectedPath = undefined
    selectedEvent = undefined
    clearButton.disabled = true
    renderEmptyInspector()
  }

  const markTransitions = (transitions: ReadonlyArray<VisualizationTransition>): void => {
    for (const transition of transitions) {
      relatedPaths.add(transition.source)
      nodes.get(transition.source)?.classList.add("is-related-source")
      for (const branch of transition.branches) {
        if (branch.target !== null) {
          relatedPaths.add(branch.target)
          nodes.get(branch.target)?.classList.add("is-related-target")
        }
        for (const update of branch.updates) {
          relatedPaths.add(update)
          nodes.get(update)?.classList.add("is-related-update")
        }
      }
    }
  }

  const markRelatedStates = (inspection: StateInspection): void => {
    clearRelations()
    for (const incoming of inspection.incoming) {
      relatedPaths.add(incoming.transition.source)
      nodes.get(incoming.transition.source)?.classList.add("is-related-source")
    }
    markTransitions(inspection.outgoing)
  }

  const expandAncestors = (inspection: StateInspection): void => {
    for (const ancestor of inspection.breadcrumbs.slice(0, -1)) {
      const row = rows.get(ancestor.path)
      const children = nodes.get(ancestor.path)?.querySelector<HTMLElement>(":scope > .topology-children")
      if (row === undefined || children === null || children === undefined) continue
      row.setAttribute("aria-expanded", "true")
      children.hidden = false
      const disclosure = row.querySelector<HTMLElement>(".state-disclosure")
      if (disclosure !== null) disclosure.textContent = "▾"
    }
  }

  const selectState = (path: string, focus: boolean): void => {
    const inspection = model.inspectState(path)
    if (inspection === undefined) return
    expandAncestors(inspection)
    if (selectedPath !== undefined) {
      nodes.get(selectedPath)?.classList.remove("is-selected")
      rows.get(selectedPath)?.setAttribute("aria-selected", "false")
    }
    if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
    selectedPath = path
    selectedEvent = undefined
    nodes.get(path)?.classList.add("is-selected")
    rows.get(path)?.setAttribute("aria-selected", "true")
    markRelatedStates(inspection)
    clearButton.disabled = false
    renderInspection(inspection)
    if (focus) {
      rows.get(path)?.focus({ preventScroll: true })
      rows.get(path)?.scrollIntoView({ block: "nearest" })
    }
  }

  function navigateToState(path: string): void {
    selectState(path, true)
  }

  const selectEvent = (event: string): void => {
    const inspection = model.inspectEvent(event)
    if (selectedPath !== undefined) {
      nodes.get(selectedPath)?.classList.remove("is-selected")
      rows.get(selectedPath)?.setAttribute("aria-selected", "false")
    }
    if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
    selectedPath = undefined
    selectedEvent = event
    eventButtons.get(event)?.classList.add("is-selected")
    clearRelations()
    markTransitions(inspection.transitions)
    clearButton.disabled = false
    renderEventInspection(inspection)
  }

  const setExpanded = (row: HTMLElement, expanded: boolean): void => {
    const node = row.closest<HTMLElement>(".topology-node")
    const children = node?.querySelector<HTMLElement>(":scope > .topology-children")
    if (children === null || children === undefined) return
    row.setAttribute("aria-expanded", String(expanded))
    children.hidden = !expanded
    const disclosure = row.querySelector<HTMLElement>(".state-disclosure")
    if (disclosure !== null) disclosure.textContent = expanded ? "▾" : "▸"
  }

  const renderNode = (node: TopologyNode, depth: number): HTMLElement => {
    const container = createElement("div", "topology-node")
    container.dataset.statePath = node.path
    nodes.set(node.path, container)

    const row = createElement("button", "state-row")
    row.type = "button"
    row.tabIndex = -1
    row.setAttribute("role", "treeitem")
    row.setAttribute("aria-level", String(depth + 1))
    row.setAttribute("aria-selected", "false")
    row.style.setProperty("--depth", String(depth))
    row.dataset.statePath = node.path
    rows.set(node.path, row)

    const disclosure = createElement("span", "state-disclosure", node.children.length === 0 ? "" : "▾")
    const status = createElement("span", `state-status${node.active ? " is-active" : ""}`)
    status.setAttribute("aria-label", node.active ? "active" : "inactive")
    const label = createElement("span", "state-label", node.label)
    const markers = createElement("span", "state-markers")
    if (node.initial) markers.append(badge("initial", "initial"))
    if (node.type !== "atomic") markers.append(badge(node.type, "state"))
    if (node.transitionCount > 0) markers.append(badge(`${node.transitionCount}t`, "count"))
    if (node.activityCount > 0) markers.append(badge(`${node.activityCount}a`, "count"))
    row.append(disclosure, status, label, markers)
    container.append(row)
    row.addEventListener("focus", () => {
      rows.forEach((candidate) => candidate.tabIndex = candidate === row ? 0 : -1)
    })

    if (node.children.length > 0) {
      const children = createElement("div", "topology-children")
      children.setAttribute("role", "group")
      node.children.forEach((child) => children.append(renderNode(child, depth + 1)))
      container.append(children)
      row.setAttribute("aria-expanded", "true")
      row.addEventListener("click", () => {
        const expanded = row.getAttribute("aria-expanded") === "true"
        setExpanded(row, !expanded)
        selectState(node.path, false)
      })
    } else {
      row.addEventListener("click", () => selectState(node.path, false))
    }
    return container
  }

  const setAllExpanded = (expanded: boolean): void => {
    treePanel.querySelectorAll<HTMLElement>(".state-row[aria-expanded]").forEach((row) => {
      setExpanded(row, expanded)
    })
  }

  clearButton.addEventListener("click", clearSelection)
  expandButton.addEventListener("click", () => setAllExpanded(true))
  collapseButton.addEventListener("click", () => setAllExpanded(false))
  revealActiveButton.addEventListener("click", () => {
    const deepest = [...model.activePaths].sort((left, right) => right.split(".").length - left.split(".").length)[0]
    if (deepest !== undefined) navigateToState(deepest)
  })

  const toolbar = createElement("div", "toolbar")
  const runtime = createElement("div", "runtime-summary")
  const runtimeLabel = diagnostics.length > 0
    ? "Partial"
    : model.hasSnapshot
    ? `${model.activePaths.length} active`
    : "Structure only"
  runtime.append(
    createElement("span", `runtime-dot${model.hasSnapshot ? " has-snapshot" : ""}`),
    createElement("span", undefined, runtimeLabel)
  )
  const toolbarActions = createElement("div", "toolbar-actions")
  toolbarActions.append(clearButton, revealActiveButton, expandButton, collapseButton)
  toolbar.append(runtime, toolbarActions)
  const tree = createElement("div", "topology-tree")
  tree.setAttribute("role", "tree")
  tree.setAttribute("aria-label", `${model.machineId} states`)
  tree.append(createElement("div", "machine-id", model.machineId))
  if (model.hasSnapshot) {
    const events = createElement("div", "enabled-events")
    events.append(createElement("span", "enabled-events-label", "Enabled"))
    if (model.candidateEvents.length === 0) {
      events.append(createElement("span", "enabled-events-empty", "none"))
    } else {
      model.candidateEvents.forEach((event) => {
        const button = createElement("button", "event-button", event)
        button.type = "button"
        button.addEventListener("click", () => selectEvent(event))
        eventButtons.set(event, button)
        events.append(button)
      })
    }
    tree.append(events)
  }
  if (model.roots.length === 0) {
    const empty = createElement("div", "topology-empty")
    empty.append(
      createElement("strong", undefined, "No states yet"),
      createElement("span", undefined, "The topology will appear as the machine definition becomes available.")
    )
    tree.append(empty)
  } else {
    model.roots.forEach((node) => tree.append(renderNode(node, 0)))
  }
  rows.values().next().value?.setAttribute("tabindex", "0")
  tree.addEventListener("keydown", (event) => {
    const current = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".state-row") : null
    if (current === null) return
    const visible = [...rows.values()].filter((row) => row.getClientRects().length > 0)
    const index = visible.indexOf(current)
    const focus = (row: HTMLElement | undefined): void => {
      if (row === undefined) return
      event.preventDefault()
      row.focus()
    }
    switch (event.key) {
      case "ArrowDown":
        focus(visible[index + 1])
        break
      case "ArrowUp":
        focus(visible[index - 1])
        break
      case "Home":
        focus(visible[0])
        break
      case "End":
        focus(visible.at(-1))
        break
      case "ArrowRight": {
        if (current.getAttribute("aria-expanded") === "false") {
          event.preventDefault()
          setExpanded(current, true)
        } else {
          const child = current.closest<HTMLElement>(".topology-node")
            ?.querySelector<HTMLElement>(":scope > .topology-children > .topology-node > .state-row")
          focus(child ?? undefined)
        }
        break
      }
      case "ArrowLeft": {
        if (current.getAttribute("aria-expanded") === "true") {
          event.preventDefault()
          setExpanded(current, false)
        } else {
          const parent = current.closest<HTMLElement>(".topology-children")
            ?.closest<HTMLElement>(".topology-node")
            ?.querySelector<HTMLElement>(":scope > .state-row")
          focus(parent ?? undefined)
        }
        break
      }
      case "Enter":
      case " ":
        event.preventDefault()
        current.click()
        break
      case "Escape":
        event.preventDefault()
        clearSelection()
        break
    }
  })
  treePanel.append(toolbar)
  if (diagnostics.length > 0) {
    const diagnosticList = createElement("div", "diagnostics")
    diagnosticList.setAttribute("role", "status")
    diagnostics.forEach((diagnostic) => {
      const item = createElement("div", `diagnostic diagnostic-${diagnostic.severity}`)
      item.append(badge(diagnostic.severity, diagnostic.severity), createElement("span", undefined, diagnostic.message))
      if (diagnostic.statePath !== null && model.inspectState(diagnostic.statePath) !== undefined) {
        item.append(stateLink(diagnostic.statePath, diagnostic.statePath, navigateToState))
      }
      diagnosticList.append(item)
    })
    treePanel.append(diagnosticList)
  }
  treePanel.append(tree)

  renderEmptyInspector()
  workspace.append(treePanel, inspector)
  shell.append(workspace)
  root.replaceChildren(shell)
}
