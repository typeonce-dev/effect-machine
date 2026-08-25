import * as Effect from "effect/Effect"
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
import {
  type ChartPresentation,
  type ChartView,
  maximumChartZoom,
  minimumChartZoom,
  renderChart
} from "./chart-renderer.js"
import { type InputForm, renderInputForm } from "./input-form.js"
import { requestSimulation } from "./simulation-client.js"
import {
  type EventInspection,
  type IncomingTransition,
  makeVisualizerModel,
  type StateInspection,
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

type MetadataValue = string | Node | null | undefined

const metadata = (items: ReadonlyArray<readonly [string, MetadataValue]>): HTMLDListElement => {
  const list = createElement("dl", "metadata")
  for (const [label, value] of items) {
    if (value === null || value === undefined || value === "" || value === "none") continue
    const description = createElement("dd")
    description.append(value)
    list.append(createElement("dt", undefined, label), description)
  }
  return list
}

const badge = (text: string, kind = "neutral"): HTMLSpanElement => createElement("span", `badge badge-${kind}`, text)

const stateStatus = (active: boolean, initial: boolean): HTMLSpanElement => {
  const status = createElement(
    "span",
    `chart-state-status${active ? " is-active" : ""}${initial ? " is-initial" : ""}`
  )
  status.setAttribute(
    "aria-label",
    active && initial ? "active, initial state" : active ? "active" : initial ? "initial state" : "inactive"
  )
  return status
}

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
  if (branch.target !== null) {
    main.append(createElement("span", "branch-arrow", "→"), stateLink(branch.target, branch.target, navigate))
  } else if (branch.selection.kind === "update") {
    main.append(
      badge(branch.selection.scope === "local" ? "to.local.update" : "value update", "update"),
      createElement("span", "branch-target", "Updates the owner value")
    )
  } else {
    main.append(createElement("span", "branch-target", "No target state"))
  }
  row.append(main)

  const details: Array<readonly [string, MetadataValue]> = [
    [
      "Selection",
      branch.selection.kind === "update" && branch.selection.scope === "local"
        ? "to.local.update"
        : branch.selection.kind
    ],
    ["Scope", branch.selection.scope]
  ]
  row.append(metadata(details))
  if (branch.updates.length > 0) {
    const updates = createElement("div", "branch-updates")
    updates.append(createElement("span", "branch-updates-label", "Value owner"))
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
  title.append(createElement("strong", undefined, triggerLabel(transition)))
  const flags = createElement("div", "card-flags")
  flags.append(badge(transition.trigger.type, "trigger"))
  if (transition.reenter) flags.append(badge("reenter"))
  if (transition.acceptance === "declinable") flags.append(badge("declinable"))
  header.append(title, flags)
  card.append(header)
  if (showSource) {
    const source = metadata([["Source", stateLink(transition.source, transition.source, navigate)]])
    source.classList.add("card-metadata")
    card.append(source)
  }

  if (transition.branches.length > 0) {
    const branches = createElement("div", "branch-list")
    transition.branches.forEach((branch) => branches.append(renderBranch(branch, navigate)))
    card.append(branches)
  }
  return card
}

const renderIncomingTransition = (incoming: IncomingTransition, navigate: StateNavigator): HTMLElement => {
  const card = createElement("article", "inspection-card incoming-card")
  const header = createElement("div", "card-header")
  const title = createElement("div", "card-title")
  title.append(createElement("strong", undefined, triggerLabel(incoming.transition)))
  const flags = createElement("div", "card-flags")
  flags.append(badge(incoming.transition.trigger.type, "trigger"))
  header.append(title, flags)
  card.append(header)

  const details: Array<readonly [string, MetadataValue]> = [
    ["Source", stateLink(incoming.transition.source, incoming.transition.source, navigate)],
    ["Selection", incoming.branch.selection.kind],
    ["Scope", incoming.branch.selection.scope]
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

const renderActivity = (activity: VisualizationActivity, navigate: StateNavigator): HTMLElement => {
  const card = createElement("article", "inspection-card activity-card")
  const header = createElement("div", "card-header")
  const title = createElement("div", "card-title")
  title.append(createElement("strong", undefined, activityTitle(activity)))
  const flags = createElement("div", "card-flags")
  flags.append(badge(activity.type, "activity"))
  header.append(title, flags)
  card.append(header)

  const details: Array<readonly [string, MetadataValue]> = [
    ["Owner", stateLink(activity.source, activity.source, navigate)]
  ]
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

const formSection = (title: string): HTMLElement => {
  const header = createElement("div", "section-heading")
  header.append(createElement("h3", undefined, title))
  return header
}

const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2)

const jsonBlock = (value: unknown): HTMLElement => createElement("pre", "json-value", prettyJson(value))

const eventName = (value: unknown): string =>
  typeof value === "object" && value !== null && "_tag" in value ? String(value._tag) : "event"

const activeTopology = (paths: ReadonlyArray<string>): string => {
  const leaves = paths.filter((path) => !paths.some((candidate) => candidate.startsWith(`${path}.`)))
  return leaves.map((path) => path.split(".").at(-1) ?? path).join(" + ") || "none"
}

export const renderVisualizer = (
  root: HTMLElement,
  machineKey: string,
  visualization: VisualizationDocument,
  diagnostics: ReadonlyArray<Diagnostic> = []
): void => {
  const model = makeVisualizerModel(visualization)
  const transitionsById = new Map(visualization.transitions.map((transition) => [transition.id, transition]))
  const eventButtons = new Map<string, HTMLElement>()
  const eventSchemas = new Map(visualization.inputs.events.map(({ event, schema }) => [event, schema]))
  const relatedFrom = new Set<string>()
  const relatedTo = new Set<string>()
  const incomingTransitions = new Set<string>()
  const outgoingTransitions = new Set<string>()
  let selectedPath: string | undefined
  let selectedEvent: string | undefined
  let selectedTransition: string | undefined
  let selectedFrame: SimulationFrame | undefined
  let simulation: SimulationReady | undefined
  let simulationPending = false
  let activeInputForm: InputForm | undefined
  let chartView: ChartView | undefined

  const activePaths = (): ReadonlyArray<string> => simulation?.current.activePaths ?? model.activePaths
  const candidateEvents = (): ReadonlyArray<string> => simulation?.current.candidateEvents ?? model.candidateEvents

  const shell = createElement("main", "app-shell")
  const workspace = createElement("section", "workspace")
  const chartPanel = createElement("section", "chart-panel")
  chartPanel.setAttribute("aria-label", `${model.machineId} topology`)
  const inspector = createElement("aside", "inspector")
  inspector.setAttribute("aria-live", "polite")
  inspector.setAttribute("aria-label", "Selection details")
  inspector.hidden = true
  const inspectorClose = createElement("button", "inspector-close", "Close")
  inspectorClose.type = "button"
  inspectorClose.setAttribute("aria-label", "Close details")
  const inspectorContent = createElement("div", "inspector-content")
  inspector.append(inspectorClose, inspectorContent)

  const clearButton = createElement("button", "toolbar-button", "Clear selection")
  clearButton.type = "button"
  clearButton.disabled = true
  const detailsButton = createElement("button", "toolbar-button", "View details")
  detailsButton.type = "button"
  detailsButton.disabled = true
  const revealActiveButton = createElement("button", "toolbar-button", "Reveal active")
  revealActiveButton.type = "button"
  revealActiveButton.disabled = model.activePaths.length === 0
  const simulationButton = createElement("button", "toolbar-button", "Start simulation")
  simulationButton.type = "button"
  simulationButton.disabled = model.roots.length === 0

  const hideInspector = (): void => {
    activeInputForm = undefined
    inspectorContent.replaceChildren()
    inspector.hidden = true
    detailsButton.textContent = "View details"
  }

  const showInspector = (): void => {
    inspector.hidden = false
    detailsButton.textContent = "Hide details"
  }

  const renderInspection = (inspection: StateInspection): void => {
    activeInputForm = undefined
    inspectorContent.replaceChildren()
    showInspector()
    const header = createElement("header", "inspector-header")
    const breadcrumbs = createElement("nav", "breadcrumbs")
    breadcrumbs.setAttribute("aria-label", "State path")
    inspection.breadcrumbs.forEach((item, index) => {
      if (index > 0) breadcrumbs.append(createElement("span", "breadcrumb-separator", "/"))
      breadcrumbs.append(stateLink(item.path, item.label, navigateToState))
    })
    const titleRow = createElement("div", "inspector-title-row")
    const title = createElement("div", "inspector-state-title")
    title.append(
      stateStatus(activePaths().includes(inspection.state.path), inspection.initial),
      createElement("h2", undefined, inspection.label)
    )
    titleRow.append(title, badge(inspection.state.type, "state"))
    header.append(breadcrumbs, titleRow)
    header.append(metadata([
      ["Path", inspection.state.path],
      ["Parent", inspection.state.parent],
      ["Children", inspection.state.children.length > 0 ? String(inspection.state.children.length) : null],
      ["Initial child", inspection.state.initial],
      ["History", inspection.state.history]
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
    inspectorContent.append(header)

    if (inspection.outgoing.length > 0) {
      const transitions = createElement("section", "inspector-section")
      transitions.append(inspectionSection("Transitions", inspection.outgoing.length))
      inspection.outgoing.forEach((transition) => transitions.append(renderTransition(transition, navigateToState)))
      inspectorContent.append(transitions)
    }

    if (inspection.incoming.length > 0) {
      const incoming = createElement("section", "inspector-section")
      incoming.append(inspectionSection("Entered by", inspection.incoming.length))
      inspection.incoming.forEach((transition) =>
        incoming.append(renderIncomingTransition(transition, navigateToState))
      )
      inspectorContent.append(incoming)
    }

    if (inspection.activities.length > 0) {
      const activities = createElement("section", "inspector-section")
      activities.append(inspectionSection("Invoked", inspection.activities.length))
      inspection.activities.forEach((activity) => activities.append(renderActivity(activity, navigateToState)))
      inspectorContent.append(activities)
    }
  }

  const renderEventInspection = (inspection: EventInspection): void => {
    activeInputForm = undefined
    inspectorContent.replaceChildren()
    showInspector()
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
    inspectorContent.append(header)

    if (simulation !== undefined && candidate) {
      const schema = eventSchemas.get(inspection.event)
      const composer = createElement("section", "inspector-section simulation-composer")
      composer.append(formSection("Event input"))
      if (schema === undefined) {
        composer.append(createElement(
          "p",
          "input-unsupported",
          "No public input schema is available for this event."
        ))
      } else {
        const input = renderInputForm(schema, {
          name: inspection.event,
          fixed: { _tag: inspection.event },
          omit: ["_tag"]
        })
        activeInputForm = input
        const send = createElement("button", "simulation-action", `Send ${inspection.event}`)
        send.type = "submit"
        send.disabled = simulationPending || !input.supported
        input.element.addEventListener("submit", (event) => {
          event.preventDefault()
          const result = input.read()
          const source = visualization.source
          if (!result.ok || source === null || simulation === undefined) return
          void runSimulation({
            _tag: "SendSimulationEvent",
            protocolVersion,
            key: machineKey,
            revision: visualization.revision,
            source,
            step: simulation.step,
            snapshot: simulation.snapshot,
            event: result.value as never
          })
        })
        input.element.append(send)
        composer.append(
          input.element,
          createElement(
            "p",
            "simulation-note",
            "The real planner validates this event and shows every synchronous transition it selects."
          )
        )
      }
      inspectorContent.append(composer)
    }

    if (inspection.transitions.length > 0) {
      const transitions = createElement("section", "inspector-section")
      transitions.append(inspectionSection("Transitions", inspection.transitions.length))
      inspection.transitions.forEach((transition) =>
        transitions.append(renderTransition(transition, navigateToState, true))
      )
      inspectorContent.append(transitions)
    }
  }

  const renderTransitionInspection = (transition: VisualizationTransition): void => {
    activeInputForm = undefined
    inspectorContent.replaceChildren()
    showInspector()
    const header = createElement("header", "inspector-header")
    const titleRow = createElement("div", "inspector-title-row")
    const flags = createElement("div", "card-flags")
    flags.append(badge(transition.trigger.type, "trigger"))
    if (transition.reenter) flags.append(badge("reenter"))
    if (transition.acceptance === "declinable") flags.append(badge("declinable"))
    titleRow.append(createElement("h2", undefined, triggerLabel(transition)), flags)
    header.append(titleRow)
    header.append(metadata([
      ["Source", transition.source],
      ["Branches", transition.branches.length > 1 ? String(transition.branches.length) : null],
      ["Acceptance", transition.acceptance === "declinable" ? transition.acceptance : null],
      ["Reenter", transition.reenter ? "yes" : null]
    ]))
    inspectorContent.append(header)
    if (transition.branches.length > 0) {
      const details = createElement("section", "inspector-section")
      details.append(inspectionSection("Branches", transition.branches.length))
      const branches = createElement("div", "inspection-card branch-list")
      transition.branches.forEach((branch) => branches.append(renderBranch(branch, navigateToState)))
      details.append(branches)
      inspectorContent.append(details)
    }
  }

  const renderSimulationFailure = (failureDiagnostics: ReadonlyArray<Diagnostic>): void => {
    activeInputForm = undefined
    inspectorContent.replaceChildren()
    showInspector()
    const header = createElement("header", "inspector-header")
    const eyebrow = createElement("div", "inspector-eyebrow")
    eyebrow.append(badge("planner error", "error"))
    header.append(eyebrow, createElement("h2", undefined, "Simulation could not continue"))
    inspectorContent.append(header)
    const list = createElement("section", "inspector-section trace-list")
    failureDiagnostics.forEach((item) => {
      const card = createElement("article", "inspection-card trace-card")
      card.append(createElement("strong", undefined, item.code), createElement("pre", "trace-error", item.message))
      list.append(card)
    })
    inspectorContent.append(list)
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
    activeInputForm = undefined
    inspectorContent.replaceChildren()
    showInspector()
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
    inspectorContent.append(header)

    const topology = createElement("section", "inspector-section trace-topology")
    topology.append(inspectionSection("Topology change", frame.microsteps.length))
    topology.append(
      renderPathGroup("Before", frame.before.activePaths),
      renderPathGroup("After", frame.after.activePaths)
    )
    inspectorContent.append(topology)

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
    inspectorContent.append(steps)

    if (frame.commands.length > 0 || frame.emittedEvents.length > 0 || frame.output !== undefined) {
      const results = createElement("section", "inspector-section trace-results")
      results.append(inspectionSection("Plan result", frame.commands.length + frame.emittedEvents.length))
      if (frame.commands.length > 0) results.append(renderTraceValues("Planned commands", frame.commands))
      if (frame.emittedEvents.length > 0) results.append(renderTraceValues("Emitted events", frame.emittedEvents))
      if (frame.output !== undefined) results.append(renderTraceValues("Output", [frame.output]))
      inspectorContent.append(results)
    }
  }

  const renderStartSimulation = (): void => {
    activeInputForm = undefined
    inspectorContent.replaceChildren()
    showInspector()
    const header = createElement("header", "inspector-header")
    const eyebrow = createElement("div", "inspector-eyebrow")
    eyebrow.append(badge("planner", "active"))
    header.append(eyebrow, createElement("h2", undefined, "Start simulation"))
    inspectorContent.append(header)
    const composer = createElement("section", "inspector-section simulation-composer")
    composer.append(formSection("Machine input"))
    const input = visualization.inputs.machine
    if (input === null) {
      composer.append(createElement("p", "section-empty", "This machine does not declare startup input."))
      inspectorContent.append(composer)
      return
    }
    const form = renderInputForm(input, { name: "Machine input" })
    activeInputForm = form
    const start = createElement("button", "simulation-action", "Start simulation")
    start.type = "submit"
    start.disabled = simulationPending || visualization.source === null || !form.supported
    form.element.addEventListener("submit", (event) => {
      event.preventDefault()
      const source = visualization.source
      if (source === null) return
      const result = form.read()
      if (!result.ok) return
      const request: SimulationRequest = {
        _tag: "StartSimulation",
        protocolVersion,
        key: machineKey,
        revision: visualization.revision,
        source,
        input: result.value as never
      }
      void runSimulation(request)
    })
    form.element.append(start)
    composer.append(
      form.element,
      createElement(
        "p",
        "simulation-note",
        "Initialization and synchronous callbacks run in isolation. Runtime activities and planned commands are not started."
      )
    )
    inspectorContent.append(composer)
  }

  async function runSimulation(request: SimulationRequest): Promise<void> {
    if (simulationPending) return
    simulationPending = true
    activeInputForm?.clearIssues()
    activeInputForm?.setPending(true)
    simulationFeedback.textContent = "Planning in an isolated worker…"
    simulationFeedback.dataset.status = "pending"
    updateSimulationUi()
    try {
      const result = await requestSimulation(request)
      if (result._tag === "SimulationFailed") {
        if (result.inputIssues.length > 0 && activeInputForm !== undefined) {
          simulationFeedback.textContent = "Some input fields are invalid"
          simulationFeedback.dataset.status = "error"
          activeInputForm.setIssues(result.inputIssues)
          return
        }
        selectedFrame = undefined
        if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
        selectedEvent = undefined
        simulationFeedback.textContent = result.diagnostics[0]?.message ?? "Simulation failed"
        simulationFeedback.dataset.status = "error"
        renderSimulationFailure(result.diagnostics)
        return
      }
      simulation = result
      activeInputForm = undefined
      if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
      selectedPath = undefined
      selectedEvent = undefined
      selectedTransition = undefined
      selectedFrame = result.frame
      clearRelations()
      result.frame.microsteps.forEach((step) => {
        step.transitions.forEach((transition) => {
          relatedFrom.add(transition.source)
          const target = transition.resolvedTarget ?? transition.target
          if (target !== null) relatedTo.add(target)
          const definition = visualization.transitions.find((candidate) =>
            candidate.source === transition.source &&
            JSON.stringify(candidate.trigger) === JSON.stringify(transition.trigger)
          )
          if (definition !== undefined) outgoingTransitions.add(definition.id)
        })
      })
      clearButton.disabled = false
      detailsButton.disabled = false
      const before = activeTopology(result.frame.before.activePaths)
      const after = activeTopology(result.frame.after.activePaths)
      simulationFeedback.textContent = result.frame.trigger._tag === "Initial"
        ? `Started in ${after}`
        : result.frame.microsteps.length === 0
        ? `${eventName(result.frame.trigger.event)} was not accepted · remained in ${after}`
        : before === after
        ? `${eventName(result.frame.trigger.event)} handled · remained in ${after}`
        : `${before} → ${after} · ${result.frame.microsteps.length} microstep${
          result.frame.microsteps.length === 1 ? "" : "s"
        }`
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
      activeInputForm?.setPending(false)
      updateSimulationUi()
    }
  }

  const chartPresentation = (): ChartPresentation => ({
    activePaths: activePaths(),
    selectedState: selectedPath ?? null,
    selectedTransition: selectedTransition ?? null,
    fromPaths: [...relatedFrom],
    toPaths: [...relatedTo],
    incomingTransitionIds: [...incomingTransitions],
    outgoingTransitionIds: [...outgoingTransitions]
  })

  const updateChartPresentation = (): void => chartView?.update(chartPresentation())

  const clearRelations = (): void => {
    relatedFrom.clear()
    relatedTo.clear()
    incomingTransitions.clear()
    outgoingTransitions.clear()
  }

  const clearSelection = (): void => {
    if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
    clearRelations()
    selectedPath = undefined
    selectedEvent = undefined
    selectedTransition = undefined
    selectedFrame = undefined
    clearButton.disabled = true
    detailsButton.disabled = true
    hideInspector()
    updateChartPresentation()
  }

  const markTransitions = (
    transitions: ReadonlyArray<VisualizationTransition>,
    includeSource = true
  ): void => {
    for (const transition of transitions) {
      if (includeSource) relatedFrom.add(transition.source)
      outgoingTransitions.add(transition.id)
      for (const branch of transition.branches) {
        if (branch.target !== null) relatedTo.add(branch.target)
      }
    }
  }

  const markRelatedStates = (inspection: StateInspection): void => {
    clearRelations()
    for (const incoming of inspection.incoming) {
      relatedFrom.add(incoming.transition.source)
      incomingTransitions.add(incoming.transition.id)
    }
    markTransitions(inspection.outgoing, false)
  }

  const selectState = (path: string, focus: boolean): void => {
    const inspection = model.inspectState(path)
    if (inspection === undefined) return
    if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
    selectedPath = path
    selectedEvent = undefined
    selectedTransition = undefined
    selectedFrame = undefined
    markRelatedStates(inspection)
    clearButton.disabled = false
    detailsButton.disabled = false
    if (!inspector.hidden) renderInspection(inspection)
    updateChartPresentation()
    if (focus) chartView?.focusState(path)
  }

  function navigateToState(path: string): void {
    selectState(path, true)
  }

  const selectEvent = (event: string): void => {
    const inspection = model.inspectEvent(event)
    if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
    selectedPath = undefined
    selectedEvent = event
    selectedTransition = undefined
    selectedFrame = undefined
    eventButtons.get(event)?.classList.add("is-selected")
    clearRelations()
    markTransitions(inspection.transitions)
    clearButton.disabled = false
    detailsButton.disabled = false
    updateChartPresentation()
    const schema = eventSchemas.get(event)
    if (simulation !== undefined && candidateEvents().includes(event) && schema !== undefined) {
      const input = renderInputForm(schema, { name: event, fixed: { _tag: event }, omit: ["_tag"] })
      if (!input.hasFields && input.supported) {
        const result = input.read()
        const source = visualization.source
        if (result.ok && source !== null) {
          void runSimulation({
            _tag: "SendSimulationEvent",
            protocolVersion,
            key: machineKey,
            revision: visualization.revision,
            source,
            step: simulation.step,
            snapshot: simulation.snapshot,
            event: result.value as never
          })
          return
        }
      }
    }
    renderEventInspection(inspection)
  }

  const selectTransition = (transitionId: string): void => {
    const transition = transitionsById.get(transitionId)
    if (transition === undefined) return
    if (selectedEvent !== undefined) eventButtons.get(selectedEvent)?.classList.remove("is-selected")
    selectedPath = undefined
    selectedEvent = undefined
    selectedTransition = transitionId
    selectedFrame = undefined
    clearRelations()
    markTransitions([transition])
    clearButton.disabled = false
    detailsButton.disabled = false
    if (!inspector.hidden) renderTransitionInspection(transition)
    updateChartPresentation()
  }

  const openStateDetails = (path: string): void => {
    selectState(path, false)
    const inspection = model.inspectState(path)
    if (inspection !== undefined) renderInspection(inspection)
  }

  const openTransitionDetails = (transitionId: string): void => {
    selectTransition(transitionId)
    const transition = transitionsById.get(transitionId)
    if (transition !== undefined) renderTransitionInspection(transition)
  }

  clearButton.addEventListener("click", clearSelection)
  inspectorClose.addEventListener("click", hideInspector)
  detailsButton.addEventListener("click", () => {
    if (!inspector.hidden) {
      hideInspector()
    } else if (selectedFrame !== undefined) {
      renderSimulationTrace(selectedFrame)
    } else if (selectedPath !== undefined) {
      const inspection = model.inspectState(selectedPath)
      if (inspection !== undefined) renderInspection(inspection)
    } else if (selectedEvent !== undefined) {
      renderEventInspection(model.inspectEvent(selectedEvent))
    } else if (selectedTransition !== undefined) {
      const transition = transitionsById.get(selectedTransition)
      if (transition !== undefined) renderTransitionInspection(transition)
    }
  })
  revealActiveButton.addEventListener("click", () => {
    const deepest = [...activePaths()].sort((left, right) => right.split(".").length - left.split(".").length)[0]
    if (deepest !== undefined) navigateToState(deepest)
  })

  const zoomOutButton = createElement("button", "toolbar-button zoom-button", "−")
  zoomOutButton.type = "button"
  zoomOutButton.setAttribute("aria-label", "Zoom out")
  const zoomResetButton = createElement("button", "toolbar-button zoom-value", "100%")
  zoomResetButton.type = "button"
  zoomResetButton.setAttribute("aria-label", "Reset zoom")
  const zoomInButton = createElement("button", "toolbar-button zoom-button", "+")
  zoomInButton.type = "button"
  zoomInButton.setAttribute("aria-label", "Zoom in")
  const zoomFitButton = createElement("button", "toolbar-button zoom-button", "Fit")
  zoomFitButton.type = "button"
  zoomFitButton.setAttribute("aria-label", "Fit chart")
  const zoomButtons = [zoomOutButton, zoomResetButton, zoomInButton, zoomFitButton]
  zoomButtons.forEach((button) => button.disabled = true)

  const updateZoomControls = (): void => {
    const zoom = chartView?.getZoom()
    zoomResetButton.textContent = `${Math.round((zoom ?? 1) * 100)}%`
    zoomOutButton.disabled = zoom === undefined || zoom <= minimumChartZoom
    zoomResetButton.disabled = zoom === undefined || zoom === 1
    zoomInButton.disabled = zoom === undefined || zoom >= maximumChartZoom
    zoomFitButton.disabled = zoom === undefined
  }

  const changeZoom = (next: (view: ChartView) => number): void => {
    if (chartView === undefined) return
    next(chartView)
    updateZoomControls()
  }

  zoomOutButton.addEventListener("click", () => changeZoom((view) => view.setZoom(view.getZoom() - 0.1)))
  zoomResetButton.addEventListener("click", () => changeZoom((view) => view.setZoom(1)))
  zoomInButton.addEventListener("click", () => changeZoom((view) => view.setZoom(view.getZoom() + 0.1)))
  zoomFitButton.addEventListener("click", () => changeZoom((view) => view.fit()))

  const toolbar = createElement("div", "toolbar")
  const runtime = createElement("div", "runtime-summary")
  const runtimeDot = createElement("span", "runtime-dot")
  const runtimeText = createElement("span")
  runtime.append(runtimeDot, runtimeText)
  const toolbarActions = createElement("div", "toolbar-actions")
  toolbarActions.append(clearButton, detailsButton, simulationButton, revealActiveButton)
  const zoomControls = createElement("div", "zoom-controls")
  zoomControls.setAttribute("role", "group")
  zoomControls.setAttribute("aria-label", "Chart zoom")
  zoomControls.append(zoomOutButton, zoomResetButton, zoomInButton, zoomFitButton)
  toolbar.append(runtime, toolbarActions)
  const chart = createElement("div", "topology-chart")
  chart.setAttribute("role", "region")
  chart.setAttribute("aria-label", `${model.machineId} states`)
  const events = createElement("div", "enabled-events")
  const simulationFeedback = createElement("div", "simulation-feedback")
  simulationFeedback.setAttribute("role", "status")
  const chartHost = createElement("div", "chart-host")
  chartHost.append(createElement("div", "chart-loading", "Computing layout…"))
  chart.append(events, simulationFeedback, chartHost)

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
    updateChartPresentation()
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
    if (!inspector.hidden) {
      if (selectedFrame !== undefined) {
        renderSimulationTrace(selectedFrame)
      } else if (selectedPath !== undefined) {
        const inspection = model.inspectState(selectedPath)
        if (inspection !== undefined) renderInspection(inspection)
      } else if (selectedEvent !== undefined && activeInputForm === undefined) {
        renderEventInspection(model.inspectEvent(selectedEvent))
      } else if (selectedTransition !== undefined) {
        const transition = transitionsById.get(selectedTransition)
        if (transition !== undefined) renderTransitionInspection(transition)
      }
    }
  }

  simulationButton.addEventListener("click", () => {
    if (simulation === undefined) {
      selectedPath = undefined
      selectedEvent = undefined
      selectedTransition = undefined
      selectedFrame = undefined
      clearRelations()
      clearButton.disabled = false
      if (visualization.inputs.machine === null && visualization.source !== null) {
        void runSimulation({
          _tag: "StartSimulation",
          protocolVersion,
          key: machineKey,
          revision: visualization.revision,
          source: visualization.source
        })
      } else {
        renderStartSimulation()
      }
    } else {
      simulation = undefined
      selectedFrame = undefined
      simulationFeedback.textContent = ""
      delete simulationFeedback.dataset.status
      clearSelection()
    }
    updateSimulationUi()
  })
  chartPanel.append(toolbar)
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
    chartPanel.append(diagnosticList)
  }
  chartPanel.append(chart)
  chartPanel.append(zoomControls)
  hideInspector()
  workspace.append(chartPanel, inspector)
  shell.append(workspace)
  root.replaceChildren(shell)

  if (model.roots.length === 0) {
    const empty = createElement("div", "topology-empty")
    empty.append(
      createElement("strong", undefined, "No states yet"),
      createElement("span", undefined, "The topology will appear as the machine definition becomes available.")
    )
    chartHost.replaceChildren(empty)
  } else {
    void Effect.runPromise(renderChart(chartHost, visualization, {
      selectState: (path) => selectState(path, false),
      openStateDetails,
      selectTransition,
      openTransitionDetails,
      clearSelection
    })).then(
      (view) => {
        chartView = view
        updateChartPresentation()
        updateZoomControls()
      },
      (cause) => {
        const failure = createElement("div", "chart-layout-error")
        failure.append(
          createElement("strong", undefined, "The chart could not be laid out"),
          createElement("span", undefined, cause instanceof Error ? cause.message : String(cause))
        )
        chartHost.replaceChildren(failure)
      }
    )
  }
  updateSimulationUi()
}
