import {
  type Diagnostic,
  protocolVersion,
  type SimulationFrame,
  type SimulationReady,
  type SimulationRequest
} from "../../DevToolsProtocol.js"
import type {
  Activity as VisualizationActivity,
  Branch as VisualizationBranch,
  MachineDocument as VisualizationDocument,
  Transition as VisualizationTransition
} from "../../MachineDocument.js"
import { requestSimulation } from "./simulation-client.js"
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

const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2)

const jsonBlock = (value: unknown): HTMLElement => createElement("pre", "json-value", prettyJson(value))

const eventName = (value: unknown): string =>
  typeof value === "object" && value !== null && "_tag" in value ? String(value._tag) : "event"

const parseJson = (value: string): { readonly ok: true; readonly value: unknown } | {
  readonly ok: false
  readonly message: string
} => {
  try {
    return { ok: true, value: JSON.parse(value) }
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
  }
}

export const renderVisualizer = (
  root: HTMLElement,
  machineKey: string,
  visualization: VisualizationDocument,
  diagnostics: ReadonlyArray<Diagnostic> = []
): void => {
  const model = makeVisualizerModel(visualization)
  const rows = new Map<string, HTMLElement>()
  const nodes = new Map<string, HTMLElement>()
  const statuses = new Map<string, HTMLElement>()
  const eventButtons = new Map<string, HTMLElement>()
  const relatedPaths = new Set<string>()
  let selectedPath: string | undefined
  let selectedEvent: string | undefined
  let selectedFrame: SimulationFrame | undefined
  let simulation: SimulationReady | undefined
  let simulationPending = false

  const activePaths = (): ReadonlyArray<string> => simulation?.current.activePaths ?? model.activePaths
  const candidateEvents = (): ReadonlyArray<string> => simulation?.current.candidateEvents ?? model.candidateEvents

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
  const simulationButton = createElement("button", "toolbar-button", "Start simulation")
  simulationButton.type = "button"
  simulationButton.disabled = model.roots.length === 0

  const renderEmptyInspector = (): void => {
    inspector.replaceChildren()
    const summary = createElement("div", "inspector-empty")
    summary.append(createElement("span", "inspector-empty-kind", "Machine"))
    summary.append(createElement("h2", undefined, visualization.machineId))
    summary.append(metadata([
      ["Source", visualization.source?.file ?? "in memory"],
      ["Export", visualization.source?.exportName ?? "none"],
      ["Initial", visualization.initial.target],
      ["Selection", visualization.initial.selection.kind],
      ["Revision", String(visualization.revision)]
    ]))
    summary.append(createElement("p", undefined, "Select a state to inspect its transitions and activities."))
    inspector.append(summary)
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
    if (activePaths().includes(inspection.state.path)) eyebrow.append(badge("active", "active"))
    if (inspection.initial) eyebrow.append(badge("initial", "initial"))
    header.append(breadcrumbs, eyebrow, createElement("h2", undefined, inspection.label))
    header.append(metadata([
      ["Path", inspection.state.path],
      ["Parent", inspection.state.parent ?? "root"],
      ["Children", String(inspection.state.children.length)],
      ["Initial child", inspection.state.initial ?? "none"],
      ["History", inspection.state.history ?? "none"]
    ]))
    if (inspection.state.description !== null || inspection.state.documentation !== null) {
      const annotations = createElement("div", "state-annotations")
      if (inspection.state.description !== null) {
        annotations.append(createElement("p", "state-description", inspection.state.description))
      }
      if (inspection.state.documentation !== null) {
        annotations.append(createElement("p", "state-documentation", inspection.state.documentation))
      }
      header.append(annotations)
    }
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
    const candidate = candidateEvents().includes(inspection.event)
    if (candidate) eyebrow.append(badge("enabled", "active"))
    header.append(eyebrow, createElement("h2", undefined, inspection.event))
    header.append(metadata([
      ["Status", candidate ? "enabled" : "not enabled"],
      ["Registrations", String(inspection.transitions.length)]
    ]))
    inspector.append(header)

    const transitions = createElement("section", "inspector-section")
    transitions.append(inspectionSection("Transitions", inspection.transitions.length))
    inspection.transitions.forEach((transition) =>
      transitions.append(renderTransition(transition, navigateToState, true))
    )
    inspector.append(transitions)

    if (simulation !== undefined) {
      const composer = createElement("section", "inspector-section simulation-composer")
      composer.append(inspectionSection("Event payload", 1))
      const editor = createElement("textarea", "json-editor")
      editor.value = prettyJson({ _tag: inspection.event })
      editor.spellcheck = false
      editor.setAttribute("aria-label", `${inspection.event} JSON payload`)
      const error = createElement("div", "editor-error")
      error.hidden = true
      const send = createElement("button", "simulation-action", "Plan event")
      send.type = "button"
      send.disabled = simulationPending
      send.addEventListener("click", () => {
        const parsed = parseJson(editor.value)
        if (!parsed.ok) {
          error.textContent = parsed.message
          error.hidden = false
          return
        }
        error.hidden = true
        const source = visualization.source
        if (source === null || simulation === undefined) return
        void runSimulation({
          _tag: "SendSimulationEvent",
          protocolVersion,
          key: machineKey,
          revision: visualization.revision,
          source,
          step: simulation.step,
          snapshot: simulation.snapshot,
          event: parsed.value as never
        })
      })
      const note = createElement(
        "p",
        "simulation-note",
        "Schema decoding and synchronous transition resolvers run in an isolated worker. Planned commands are not committed."
      )
      composer.append(editor, error, send, note)
      inspector.append(composer)
    }
  }

  const renderSimulationFailure = (failureDiagnostics: ReadonlyArray<Diagnostic>): void => {
    inspector.replaceChildren()
    const header = createElement("header", "inspector-header")
    const eyebrow = createElement("div", "inspector-eyebrow")
    eyebrow.append(badge("planner error", "error"))
    header.append(eyebrow, createElement("h2", undefined, "Simulation could not continue"))
    inspector.append(header)
    const list = createElement("section", "inspector-section trace-list")
    failureDiagnostics.forEach((item) => {
      const card = createElement("article", "inspection-card trace-card")
      card.append(createElement("strong", undefined, item.code), createElement("pre", "trace-error", item.message))
      list.append(card)
    })
    inspector.append(list)
  }

  const renderPathGroup = (label: string, paths: ReadonlyArray<string>): HTMLElement => {
    const group = createElement("div", "trace-path-group")
    group.append(createElement("span", "trace-label", label))
    const values = createElement("div", "trace-paths")
    if (paths.length === 0) values.append(createElement("span", "section-empty", "none"))
    paths.forEach((path) => values.append(stateLink(path, path, navigateToState)))
    group.append(values)
    return group
  }

  const renderTraceValues = (label: string, values: ReadonlyArray<unknown>): HTMLElement => {
    const section = createElement("div", "trace-values")
    section.append(createElement("span", "trace-label", label))
    if (values.length === 0) {
      section.append(createElement("span", "section-empty", "none"))
    } else {
      values.forEach((value) => section.append(jsonBlock(value)))
    }
    return section
  }

  const renderSimulationTrace = (frame: SimulationFrame): void => {
    inspector.replaceChildren()
    const header = createElement("header", "inspector-header trace-header")
    const eyebrow = createElement("div", "inspector-eyebrow")
    eyebrow.append(badge("planned", "active"))
    if (frame.done) eyebrow.append(badge("done", "state"))
    const title = frame.trigger._tag === "Initial"
      ? "Initial plan"
      : `Event · ${eventName(frame.trigger.event)}`
    header.append(eyebrow, createElement("h2", undefined, title))
    header.append(metadata([
      ["Step", String(frame.step)],
      ["Microsteps", String(frame.microsteps.length)],
      ["Active before", String(frame.before.activePaths.length)],
      ["Active after", String(frame.after.activePaths.length)]
    ]))
    const received = frame.trigger._tag === "Initial" ? frame.trigger.input : frame.trigger.event
    if (received !== undefined) header.append(jsonBlock(received))
    inspector.append(header)

    const topology = createElement("section", "inspector-section trace-topology")
    topology.append(inspectionSection("Topology change", frame.microsteps.length))
    topology.append(
      renderPathGroup("Before", frame.before.activePaths),
      renderPathGroup("After", frame.after.activePaths)
    )
    inspector.append(topology)

    const steps = createElement("section", "inspector-section trace-list")
    steps.append(inspectionSection("Microsteps", frame.microsteps.length))
    if (frame.microsteps.length === 0) {
      steps.append(createElement(
        "p",
        "section-empty",
        frame.trigger._tag === "Initial"
          ? "No automatic microsteps were needed."
          : "No transition accepted this event."
      ))
    }
    frame.microsteps.forEach((step) => {
      const card = createElement("article", "inspection-card trace-card")
      const cardHeader = createElement("div", "card-header")
      const cardTitle = createElement("div", "card-title")
      cardTitle.append(
        badge(`#${step.index + 1}`, "count"),
        createElement("strong", undefined, eventName(step.event))
      )
      cardHeader.append(cardTitle, badge(step.changed ? "changed" : "unchanged", step.changed ? "active" : "neutral"))
      card.append(cardHeader)
      if (step.transitions.length > 0) {
        const selected = createElement("div", "trace-transitions")
        selected.append(createElement("span", "trace-label", "Selected transitions"))
        step.transitions.forEach((transition) => {
          const row = createElement("div", "trace-transition")
          row.append(stateLink(transition.source, transition.source, navigateToState))
          row.append(createElement("span", "branch-arrow", "→"))
          const target = transition.resolvedTarget ?? transition.target
          if (target === null) row.append(createElement("span", "branch-target", "No target"))
          else row.append(stateLink(target, target, navigateToState))
          if (transition.branchKey !== null) row.append(badge(transition.branchKey, "condition"))
          if (transition.reenter) row.append(badge("reenter"))
          selected.append(row)
          if (transition.updates.length > 0) selected.append(renderPathGroup("Updates", transition.updates))
        })
        card.append(selected)
      }
      card.append(renderPathGroup("Exit", step.exitPaths), renderPathGroup("Entry", step.entryPaths))
      if (step.raisedEvents.length > 0) card.append(renderTraceValues("Raised", step.raisedEvents))
      if (step.emittedEvents.length > 0) card.append(renderTraceValues("Emitted", step.emittedEvents))
      if (step.commands.length > 0) card.append(renderTraceValues("Commands", step.commands))
      card.append(renderPathGroup("Active after", step.activePaths))
      steps.append(card)
    })
    inspector.append(steps)

    if (frame.commands.length > 0 || frame.emittedEvents.length > 0 || frame.output !== undefined) {
      const results = createElement("section", "inspector-section trace-results")
      results.append(inspectionSection("Plan result", frame.commands.length + frame.emittedEvents.length))
      if (frame.commands.length > 0) results.append(renderTraceValues("Planned commands", frame.commands))
      if (frame.emittedEvents.length > 0) results.append(renderTraceValues("Emitted events", frame.emittedEvents))
      if (frame.output !== undefined) results.append(renderTraceValues("Output", [frame.output]))
      inspector.append(results)
    }
  }

  const renderStartSimulation = (): void => {
    inspector.replaceChildren()
    const header = createElement("header", "inspector-header")
    const eyebrow = createElement("div", "inspector-eyebrow")
    eyebrow.append(badge("planner", "active"))
    header.append(eyebrow, createElement("h2", undefined, "Start simulation"))
    inspector.append(header)
    const composer = createElement("section", "inspector-section simulation-composer")
    composer.append(inspectionSection("Machine input", 1))
    const editor = createElement("textarea", "json-editor")
    editor.placeholder = "Optional JSON input"
    editor.spellcheck = false
    editor.setAttribute("aria-label", "Machine input JSON")
    const error = createElement("div", "editor-error")
    error.hidden = true
    const start = createElement("button", "simulation-action", "Plan initial state")
    start.type = "button"
    start.disabled = simulationPending || visualization.source === null
    start.addEventListener("click", () => {
      const source = visualization.source
      if (source === null) return
      const input = editor.value.trim()
      let value: unknown
      if (input.length > 0) {
        const parsed = parseJson(input)
        if (!parsed.ok) {
          error.textContent = parsed.message
          error.hidden = false
          return
        }
        value = parsed.value
      }
      error.hidden = true
      const request: SimulationRequest = {
        _tag: "StartSimulation",
        protocolVersion,
        key: machineKey,
        revision: visualization.revision,
        source,
        ...(input.length > 0 ? { input: value as never } : {})
      }
      void runSimulation(request)
    })
    composer.append(
      editor,
      error,
      start,
      createElement(
        "p",
        "simulation-note",
        "Leave input empty for machines without input. Initialization and synchronous callbacks run; runtime activities and commands do not."
      )
    )
    inspector.append(composer)
  }

  async function runSimulation(request: SimulationRequest): Promise<void> {
    if (simulationPending) return
    simulationPending = true
    simulationFeedback.textContent = "Planning in an isolated worker…"
    simulationFeedback.dataset.status = "pending"
    updateSimulationUi()
    try {
      const result = await requestSimulation(request)
      if (result._tag === "SimulationFailed") {
        selectedFrame = undefined
        if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
        selectedEvent = undefined
        simulationFeedback.textContent = result.diagnostics[0]?.message ?? "Simulation failed"
        simulationFeedback.dataset.status = "error"
        renderSimulationFailure(result.diagnostics)
        return
      }
      simulation = result
      if (selectedPath !== undefined) {
        nodes.get(selectedPath)?.classList.remove("is-selected")
        rows.get(selectedPath)?.setAttribute("aria-selected", "false")
      }
      if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
      selectedPath = undefined
      selectedEvent = undefined
      selectedFrame = result.frame
      clearRelations()
      result.frame.microsteps.forEach((step) => {
        step.transitions.forEach((transition) => {
          relatedPaths.add(transition.source)
          nodes.get(transition.source)?.classList.add("is-related-source")
        })
        step.entryPaths.forEach((path) => {
          relatedPaths.add(path)
          nodes.get(path)?.classList.add("is-related-target")
        })
        step.transitions.flatMap((transition) => transition.updates).forEach((path) => {
          relatedPaths.add(path)
          nodes.get(path)?.classList.add("is-related-update")
        })
      })
      clearButton.disabled = false
      simulationFeedback.textContent = result.frame.trigger._tag === "Initial"
        ? "Initial state planned"
        : result.frame.microsteps.length === 0
        ? "No transition accepted the value"
        : `${result.frame.microsteps.length} microstep${result.frame.microsteps.length === 1 ? "" : "s"} planned`
      simulationFeedback.dataset.status = "applied"
    } catch (cause) {
      selectedFrame = undefined
      if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
      selectedEvent = undefined
      const failure: Diagnostic = {
        severity: "error",
        code: "simulation-request-failed",
        message: cause instanceof Error ? cause.message : String(cause),
        location: visualization.source === null
          ? null
          : { file: visualization.source.file, line: null, column: null },
        statePath: null
      }
      simulationFeedback.textContent = failure.message
      simulationFeedback.dataset.status = "error"
      renderSimulationFailure([failure])
    } finally {
      simulationPending = false
      updateSimulationUi()
    }
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
    selectedFrame = undefined
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
    selectedFrame = undefined
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
    selectedFrame = undefined
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
    statuses.set(node.path, status)
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
    const deepest = [...activePaths()].sort((left, right) => right.split(".").length - left.split(".").length)[0]
    if (deepest !== undefined) navigateToState(deepest)
  })

  const toolbar = createElement("div", "toolbar")
  const runtime = createElement("div", "runtime-summary")
  const runtimeDot = createElement("span", "runtime-dot")
  const runtimeText = createElement("span")
  runtime.append(runtimeDot, runtimeText)
  const toolbarActions = createElement("div", "toolbar-actions")
  toolbarActions.append(clearButton, simulationButton, revealActiveButton, expandButton, collapseButton)
  toolbar.append(runtime, toolbarActions)
  const tree = createElement("div", "topology-tree")
  tree.setAttribute("role", "tree")
  tree.setAttribute("aria-label", `${model.machineId} states`)
  tree.append(createElement("div", "machine-id", model.machineId))
  const events = createElement("div", "enabled-events")
  const simulationFeedback = createElement("div", "simulation-feedback")
  simulationFeedback.setAttribute("role", "status")
  tree.append(events, simulationFeedback)

  const renderEventButtons = (): void => {
    events.replaceChildren(createElement("span", "enabled-events-label", "Enabled"))
    eventButtons.clear()
    const candidates = candidateEvents()
    if (candidates.length === 0) {
      events.append(createElement("span", "enabled-events-empty", "none"))
      return
    }
    candidates.forEach((event) => {
      const button = createElement("button", `event-button${event === selectedEvent ? " is-selected" : ""}`, event)
      button.type = "button"
      button.disabled = simulationPending
      button.addEventListener("click", () => selectEvent(event))
      eventButtons.set(event, button)
      events.append(button)
    })
  }

  const updateSimulationUi = (): void => {
    const active = new Set(activePaths())
    statuses.forEach((status, path) => {
      const isActive = active.has(path)
      status.classList.toggle("is-active", isActive)
      status.setAttribute("aria-label", isActive ? "active" : "inactive")
    })
    const hasRuntimeState = simulation !== undefined || model.hasSnapshot
    runtimeDot.classList.toggle("has-snapshot", hasRuntimeState)
    runtimeText.textContent = simulation !== undefined
      ? `${active.size} active · step ${simulation.step}`
      : diagnostics.length > 0
      ? "Partial"
      : model.hasSnapshot
      ? `${active.size} active`
      : "Structure only"
    simulationButton.textContent = simulation === undefined ? "Start simulation" : "Reset simulation"
    simulationButton.disabled = simulationPending || model.roots.length === 0 || visualization.source === null
    revealActiveButton.disabled = active.size === 0
    events.hidden = !hasRuntimeState
    simulationFeedback.hidden = simulation === undefined && !simulationPending && simulationFeedback.textContent === ""
    renderEventButtons()
    if (selectedFrame !== undefined) {
      renderSimulationTrace(selectedFrame)
    } else if (selectedPath !== undefined) {
      const inspection = model.inspectState(selectedPath)
      if (inspection !== undefined) renderInspection(inspection)
    } else if (selectedEvent !== undefined) {
      renderEventInspection(model.inspectEvent(selectedEvent))
    }
  }

  simulationButton.addEventListener("click", () => {
    if (simulation === undefined) {
      selectedPath = undefined
      selectedEvent = undefined
      selectedFrame = undefined
      clearRelations()
      clearButton.disabled = false
      renderStartSimulation()
    } else {
      simulation = undefined
      selectedFrame = undefined
      simulationFeedback.textContent = ""
      delete simulationFeedback.dataset.status
      clearSelection()
    }
    updateSimulationUi()
  })
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
  updateSimulationUi()
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
