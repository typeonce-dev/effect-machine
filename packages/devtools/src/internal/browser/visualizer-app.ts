import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import type { Diagnostic } from "../../DevToolsProtocol.js"
import type {
  Activity as VisualizationActivity,
  Branch as VisualizationBranch,
  InputSchema,
  MachineDocument as VisualizationDocument,
  Transition as VisualizationTransition,
  Trigger
} from "../../MachineDocument.js"
import * as MachineWalkthrough from "../../MachineWalkthrough.js"
import {
  type ChartInteractionAnchor,
  type ChartPresentation,
  type ChartView,
  maximumChartZoom,
  minimumChartZoom,
  renderChart
} from "./chart-renderer.js"
import { type InputField, projectInputSchema } from "./input-form.js"
import {
  branchTargetApi,
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

const renderBranch = (
  document: VisualizationDocument,
  source: string,
  branch: VisualizationBranch,
  navigate: StateNavigator
): HTMLElement => {
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

  const api = branchTargetApi(document, source, branch)
  const details: Array<readonly [string, MetadataValue]> = api === undefined
    ? [["Selection", branch.selection.kind], ["Scope", branch.selection.scope]]
    : [["API", api]]
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
  document: VisualizationDocument,
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
    transition.branches.forEach((branch) =>
      branches.append(renderBranch(document, transition.source, branch, navigate))
    )
    card.append(branches)
  }
  return card
}

const renderIncomingTransition = (
  document: VisualizationDocument,
  incoming: IncomingTransition,
  navigate: StateNavigator
): HTMLElement => {
  const card = createElement("article", "inspection-card incoming-card")
  const header = createElement("div", "card-header")
  const title = createElement("div", "card-title")
  title.append(createElement("strong", undefined, triggerLabel(incoming.transition)))
  const flags = createElement("div", "card-flags")
  flags.append(badge(incoming.transition.trigger.type, "trigger"))
  header.append(title, flags)
  card.append(header)

  const api = branchTargetApi(document, incoming.transition.source, incoming.branch)
  const details: Array<readonly [string, MetadataValue]> = [
    ["Source", stateLink(incoming.transition.source, incoming.transition.source, navigate)],
    ["API", api]
  ]
  if (api === undefined) {
    details.push(["Selection", incoming.branch.selection.kind], ["Scope", incoming.branch.selection.scope])
  }
  if (incoming.branch.type === "branch") details.unshift(["Title", incoming.branch.title])
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

const inspectionSection = (title: string, count?: number): HTMLElement => {
  const header = createElement("div", "section-heading")
  header.append(createElement("h3", undefined, title))
  if (count !== undefined) header.append(createElement("span", "section-count", String(count)))
  return header
}

const inputType = (field: InputField): string => {
  switch (field._tag) {
    case "String":
      return field.format ?? "string"
    case "Number":
      return field.integer ? "integer" : "number"
    case "Boolean":
      return "boolean"
    case "Enum":
      return "enum"
    case "Literal":
      return "literal"
    case "Object":
      return "object"
    case "Array":
      return `${inputType(field.item)}[]`
    case "Union":
      return "union"
    case "Unsupported":
      return "unknown"
  }
}

const inputConstraints = (field: InputField): ReadonlyArray<string> => {
  switch (field._tag) {
    case "String":
      return [
        field.minLength === undefined ? undefined : `min ${field.minLength}`,
        field.maxLength === undefined ? undefined : `max ${field.maxLength}`,
        field.pattern === undefined ? undefined : `pattern ${field.pattern}`
      ].filter((value): value is string => value !== undefined)
    case "Number":
      return [
        field.minimum === undefined ? undefined : `≥ ${field.minimum}`,
        field.maximum === undefined ? undefined : `≤ ${field.maximum}`
      ].filter((value): value is string => value !== undefined)
    case "Enum":
      return field.values.map((value) => JSON.stringify(value))
    case "Literal":
      return [JSON.stringify(field.value)]
    case "Array":
      return [
        field.minItems > 0 ? `min ${field.minItems}` : undefined,
        field.maxItems === undefined ? undefined : `max ${field.maxItems}`
      ].filter((value): value is string => value !== undefined)
    default:
      return []
  }
}

const renderContractField = (
  label: string,
  required: boolean,
  field: InputField,
  omit: ReadonlySet<string>
): HTMLElement | null => {
  if (omit.has(label)) return null
  const row = createElement("div", "input-contract-field")
  const heading = createElement("div", "input-field-heading")
  const identity = createElement("div", "input-field-identity")
  identity.append(
    createElement("span", "input-label", label),
    createElement("span", "input-field-type", inputType(field)),
    createElement("span", required ? "input-required" : "input-optional", required ? "required" : "optional")
  )
  heading.append(identity)
  row.append(heading)
  const constraints = inputConstraints(field)
  if (constraints.length > 0) {
    const values = createElement("div", "input-constraints")
    constraints.forEach((value) => values.append(createElement("span", undefined, value)))
    row.append(values)
  }
  if (field.description !== undefined) row.append(createElement("p", "input-description", field.description))
  if (field._tag === "Object") {
    const children = createElement("div", "input-contract-children")
    field.fields.forEach(({ key, required, field }) => {
      const child = renderContractField(key, required, field, omit)
      if (child !== null) children.append(child)
    })
    if (children.childElementCount > 0) row.append(children)
  } else if (field._tag === "Array" && field.item._tag === "Object") {
    const children = createElement("div", "input-contract-children")
    field.item.fields.forEach(({ key, required, field }) => {
      const child = renderContractField(key, required, field, omit)
      if (child !== null) children.append(child)
    })
    if (children.childElementCount > 0) row.append(children)
  } else if (field._tag === "Union") {
    const alternatives = createElement("div", "input-contract-alternatives")
    field.alternatives.forEach((alternative, index) => {
      const item = renderContractField(`Option ${index + 1}`, true, alternative, omit)
      if (item !== null) alternatives.append(item)
    })
    row.append(alternatives)
  } else if (field._tag === "Unsupported") {
    row.append(createElement("p", "input-unsupported", field.reason))
  }
  return row
}

const renderInputContract = (
  title: string,
  schema: InputSchema,
  omit: ReadonlyArray<string> = []
): HTMLElement => {
  const section = createElement("section", "inspector-section input-contract")
  section.append(inspectionSection(title))
  const projected = projectInputSchema(schema)
  const fields = createElement("div", "input-contract-fields")
  const omitted = new Set(omit)
  if (projected._tag === "Object") {
    projected.fields.forEach(({ key, required, field }) => {
      const child = renderContractField(key, required, field, omitted)
      if (child !== null) fields.append(child)
    })
  } else {
    const child = renderContractField("value", true, projected, omitted)
    if (child !== null) fields.append(child)
  }
  if (fields.childElementCount === 0) {
    fields.append(createElement("p", "section-empty", "No additional data fields."))
  }
  section.append(fields)
  return section
}

const contractSummary = (schema: InputSchema | null): string | null => {
  if (schema === null) return null
  const field = projectInputSchema(schema)
  if (field._tag !== "Object") return inputType(field)
  const fields = field.fields.filter(({ key }) => key !== "_tag")
  if (fields.length === 0) return null
  return fields.slice(0, 3).map(({ key, required, field }) => `${key}${required ? "" : "?"}: ${inputType(field)}`).join(
    " · "
  ) + (fields.length > 3 ? ` · +${fields.length - 3}` : "")
}

const triggerName = (trigger: Trigger): string => {
  switch (trigger.type) {
    case "event":
      return trigger.event
    case "always":
      return "Always"
    case "done":
      return "Completion"
    case "choice":
      return "Choice"
    case "invoke":
      return `${trigger.id} · ${trigger.outcome}`
  }
}

const decisionLabel = (decision: MachineWalkthrough.Decision): string => {
  switch (decision) {
    case "conditional-branch":
      return "Choose branch"
    case "declinable-transition":
      return "Assume accepted"
    case "automatic-trigger":
      return "Advance automatic trigger"
    case "invoke-outcome":
      return "Choose invoke outcome"
  }
}

const unavailableLabel = (reason: MachineWalkthrough.UnavailableReason): string =>
  reason === "history-unavailable"
    ? "No history has been recorded for this target yet"
    : "The target is resolved only at runtime"

const activeTopology = (paths: ReadonlyArray<string>): string => {
  const leaves = paths.filter((path) => !paths.some((candidate) => candidate.startsWith(`${path}.`)))
  return leaves.map((path) => path.split(".").at(-1) ?? path).join(" + ") || "none"
}

export const renderVisualizer = (
  root: HTMLElement,
  _machineKey: string,
  visualization: VisualizationDocument,
  diagnostics: ReadonlyArray<Diagnostic> = []
): void => {
  const model = makeVisualizerModel(visualization)
  const transitionsById = new Map(visualization.transitions.map((transition) => [transition.id, transition]))
  const eventSchemas = new Map(visualization.inputs.events.map(({ event, schema }) => [event, schema]))
  const relatedFrom = new Set<string>()
  const relatedTo = new Set<string>()
  const incomingTransitions = new Set<string>()
  const outgoingTransitions = new Set<string>()
  let selectedPath: string | undefined
  let selectedTransition: string | undefined
  let selectedFrame: MachineWalkthrough.Frame | undefined
  let walkthrough: MachineWalkthrough.Session | undefined
  let chartView: ChartView | undefined

  const activePaths = (): ReadonlyArray<string> =>
    walkthrough === undefined ? model.activePaths : MachineWalkthrough.current(walkthrough).after.activePaths
  const availableChoices = (): ReadonlyArray<MachineWalkthrough.Choice> =>
    walkthrough === undefined ? [] : MachineWalkthrough.choices(walkthrough)

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
  const choicePicker = createElement("section", "transition-picker")
  choicePicker.setAttribute("role", "dialog")
  choicePicker.setAttribute("aria-label", "Available transitions")
  choicePicker.hidden = true
  const choicePickerHeader = createElement("div", "transition-picker-header")
  const choicePickerTitle = createElement("strong")
  const choicePickerClose = createElement("button", "transition-picker-close", "Close")
  choicePickerClose.type = "button"
  const choicePickerContent = createElement("div", "transition-picker-content")
  choicePickerHeader.append(choicePickerTitle, choicePickerClose)
  choicePicker.append(choicePickerHeader, choicePickerContent)

  const clearButton = createElement("button", "toolbar-button", "Clear selection")
  clearButton.type = "button"
  clearButton.disabled = true
  const detailsButton = createElement("button", "toolbar-button", "View details")
  detailsButton.type = "button"
  detailsButton.disabled = true
  const revealActiveButton = createElement("button", "toolbar-button", "Reveal active")
  revealActiveButton.type = "button"
  revealActiveButton.disabled = model.activePaths.length === 0
  const walkthroughButton = createElement("button", "toolbar-button", "Start simulation")
  walkthroughButton.type = "button"
  walkthroughButton.disabled = model.roots.length === 0

  const hideInspector = (): void => {
    inspectorContent.replaceChildren()
    inspector.hidden = true
    detailsButton.textContent = "View details"
  }

  const showInspector = (): void => {
    inspector.hidden = false
    detailsButton.textContent = "Hide details"
  }

  const closeChoicePicker = (): void => {
    choicePicker.hidden = true
    choicePickerContent.replaceChildren()
  }

  const renderInspection = (inspection: StateInspection): void => {
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
      inspection.outgoing.forEach((transition) =>
        transitions.append(renderTransition(visualization, transition, navigateToState))
      )
      inspectorContent.append(transitions)
    }
    if (inspection.incoming.length > 0) {
      const incoming = createElement("section", "inspector-section")
      incoming.append(inspectionSection("Entered by", inspection.incoming.length))
      inspection.incoming.forEach((transition) =>
        incoming.append(renderIncomingTransition(visualization, transition, navigateToState))
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

  const renderTransitionInspection = (transition: VisualizationTransition): void => {
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
    if (transition.trigger.type === "event") {
      const schema = eventSchemas.get(transition.trigger.event)
      if (schema !== undefined) inspectorContent.append(renderInputContract("Data contract", schema, ["_tag"]))
    }
    if (transition.branches.length > 0) {
      const details = createElement("section", "inspector-section")
      details.append(inspectionSection("Branches", transition.branches.length))
      const branches = createElement("div", "inspection-card branch-list")
      transition.branches.forEach((branch) =>
        branches.append(renderBranch(visualization, transition.source, branch, navigateToState))
      )
      details.append(branches)
      inspectorContent.append(details)
    }
  }

  const renderPathGroup = (label: string, paths: ReadonlyArray<string>): HTMLElement => {
    const group = createElement("div", "trace-path-group")
    group.append(createElement("span", "trace-label", label))
    const values = createElement("div", "trace-paths")
    paths.forEach((path) => values.append(stateLink(path, path, navigateToState)))
    if (paths.length === 0) values.append(createElement("span", "section-empty", "none"))
    group.append(values)
    return group
  }

  const renderWalkthroughTrace = (frame: MachineWalkthrough.Frame): void => {
    inspectorContent.replaceChildren()
    showInspector()
    const header = createElement("header", "inspector-header trace-header")
    const eyebrow = createElement("div", "inspector-eyebrow")
    eyebrow.append(badge("walkthrough", "active"))
    const title = frame.choice === null
      ? "Initial configuration"
      : frame.choice.title ?? triggerName(frame.choice.trigger)
    header.append(eyebrow, createElement("h2", undefined, title))
    header.append(metadata([
      ["Step", String(frame.step)],
      [
        "Result",
        frame.changed
          ? `${activeTopology(frame.before.activePaths)} → ${activeTopology(frame.after.activePaths)}`
          : "Topology unchanged"
      ]
    ]))
    inspectorContent.append(header)

    const topology = createElement("section", "inspector-section trace-topology")
    topology.append(
      inspectionSection("Topology"),
      renderPathGroup("Before", frame.before.activePaths),
      renderPathGroup("Exit", frame.exitPaths),
      renderPathGroup("Entry", frame.entryPaths),
      renderPathGroup("After", frame.after.activePaths)
    )
    inspectorContent.append(topology)

    if (frame.choice === null) {
      if (visualization.inputs.machine !== null) {
        inspectorContent.append(renderInputContract("Machine input contract", visualization.inputs.machine))
      }
      return
    }

    const choice = frame.choice
    const transition = transitionsById.get(choice.transitionId)
    const branch = transition?.branches.find(({ id }) => id === choice.branchId)
    const api = branch === undefined ? undefined : branchTargetApi(visualization, choice.source, branch)
    const selection = createElement("section", "inspector-section")
    selection.append(inspectionSection("Selected branch"))
    const card = createElement("article", "inspection-card trace-card")
    const cardHeader = createElement("div", "card-header")
    const cardTitle = createElement("div", "card-title")
    cardTitle.append(createElement("strong", undefined, triggerName(choice.trigger)))
    const flags = createElement("div", "card-flags")
    choice.decisions.forEach((decision) => flags.append(badge(decisionLabel(decision), "condition")))
    cardHeader.append(cardTitle, flags)
    card.append(cardHeader)
    card.append(metadata([
      ["Title", choice.title],
      ["Source", stateLink(choice.source, choice.source, navigateToState)],
      ["Target", choice.target === null ? "No target" : stateLink(choice.target, choice.target, navigateToState)],
      ["API", api]
    ]))
    if (choice.updates.length > 0) card.append(renderPathGroup("Updates", choice.updates))
    selection.append(card)
    inspectorContent.append(selection)
    if (choice.input !== null) inspectorContent.append(renderInputContract("Data contract", choice.input, ["_tag"]))
  }

  const clearRelations = (): void => {
    relatedFrom.clear()
    relatedTo.clear()
    incomingTransitions.clear()
    outgoingTransitions.clear()
  }

  const markFrame = (frame: MachineWalkthrough.Frame): void => {
    clearRelations()
    if (frame.choice === null) return
    relatedFrom.add(frame.choice.source)
    outgoingTransitions.add(frame.choice.transitionId)
    if (frame.choice.target !== null) relatedTo.add(frame.choice.target)
  }

  const chartPresentation = (): ChartPresentation => {
    const choices = availableChoices()
    const usable = choices.filter(({ unavailableReason }) => unavailableReason === null)
    return {
      simulationMode: walkthrough !== undefined,
      activePaths: activePaths(),
      selectedState: selectedPath ?? null,
      selectedTransition: selectedTransition ?? null,
      fromPaths: [...relatedFrom],
      toPaths: [...relatedTo],
      incomingTransitionIds: [...incomingTransitions],
      outgoingTransitionIds: [...outgoingTransitions],
      availableBranchIds: usable.map(({ branchId }) => branchId),
      unavailableBranchIds: choices.filter(({ unavailableReason }) => unavailableReason !== null).map((
        { branchId }
      ) => branchId)
    }
  }

  const updateChartPresentation = (): void => chartView?.update(chartPresentation())

  const clearSelection = (): void => {
    if (walkthrough !== undefined) {
      closeChoicePicker()
      return
    }
    clearRelations()
    selectedPath = undefined
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
    if (walkthrough !== undefined) return
    const inspection = model.inspectState(path)
    if (inspection === undefined) return
    selectedPath = path
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

  const selectTransition = (transitionId: string): void => {
    if (walkthrough !== undefined) return
    const transition = transitionsById.get(transitionId)
    if (transition === undefined) return
    selectedPath = undefined
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
    if (walkthrough !== undefined) return
    selectState(path, false)
    const inspection = model.inspectState(path)
    if (inspection !== undefined) renderInspection(inspection)
  }

  const openTransitionDetails = (transitionId: string): void => {
    if (walkthrough !== undefined) return
    selectTransition(transitionId)
    const transition = transitionsById.get(transitionId)
    if (transition !== undefined) renderTransitionInspection(transition)
  }

  const walkthroughDock = createElement("section", "walkthrough-dock")
  walkthroughDock.hidden = true
  const walkthroughHeading = createElement("div", "walkthrough-heading")
  const walkthroughIdentity = createElement("div", "walkthrough-identity")
  const walkthroughHint = createElement("span", "walkthrough-hint")
  const walkthroughStatus = createElement("span", "walkthrough-status")
  const walkthroughTimeline = createElement("div", "walkthrough-timeline")
  walkthroughTimeline.setAttribute("aria-label", "Simulation timeline")
  walkthroughIdentity.append(createElement("strong", undefined, "Simulation"), walkthroughHint)
  walkthroughHeading.append(walkthroughIdentity, walkthroughStatus)
  walkthroughDock.append(walkthroughHeading, walkthroughTimeline)

  const selectFrame = (frame: MachineWalkthrough.Frame): void => {
    selectedPath = undefined
    selectedTransition = undefined
    selectedFrame = frame
    markFrame(frame)
    clearButton.disabled = false
    detailsButton.disabled = false
  }

  const choiceRoute = (choice: MachineWalkthrough.Choice): string =>
    `${choice.source} → ${choice.target ?? "no target"}`

  const takeChoice = (choice: MachineWalkthrough.Choice): void => {
    if (walkthrough === undefined || choice.unavailableReason !== null) return
    const result = MachineWalkthrough.take(walkthrough, choice.id)
    if (Result.isFailure(result)) return
    walkthrough = result.success
    selectFrame(MachineWalkthrough.current(walkthrough))
    closeChoicePicker()
    updateWalkthroughUi()
    chartView?.revealStates(activePaths())
  }

  const renderPickerChoice = (choice: MachineWalkthrough.Choice): HTMLButtonElement => {
    const button = createElement(
      "button",
      `transition-picker-choice${choice.unavailableReason === null ? "" : " is-unavailable"}`
    )
    button.type = "button"
    button.disabled = choice.unavailableReason !== null
    const main = createElement("span", "transition-picker-choice-main")
    main.append(createElement("strong", undefined, triggerName(choice.trigger)))
    if (choice.title !== null) main.append(createElement("span", "transition-picker-choice-title", choice.title))
    button.append(main, createElement("span", "transition-picker-choice-route", choiceRoute(choice)))
    const contract = contractSummary(choice.input)
    if (contract !== null) button.append(createElement("span", "transition-picker-choice-contract", contract))
    if (choice.decisions.length > 0) {
      button.append(createElement(
        "span",
        "transition-picker-choice-decision",
        choice.decisions.map(decisionLabel).join(" · ")
      ))
    }
    if (choice.unavailableReason !== null) {
      button.title = unavailableLabel(choice.unavailableReason)
      button.append(createElement(
        "span",
        "transition-picker-choice-unavailable",
        unavailableLabel(choice.unavailableReason)
      ))
    } else {
      button.title = choiceRoute(choice)
      button.addEventListener("click", () => takeChoice(choice))
    }
    return button
  }

  const showChoicePicker = (
    title: string,
    choices: ReadonlyArray<MachineWalkthrough.Choice>,
    anchor: ChartInteractionAnchor
  ): void => {
    if (choices.length === 1 && choices[0]?.unavailableReason === null) {
      takeChoice(choices[0])
      return
    }
    if (choices.length === 0) {
      closeChoicePicker()
      return
    }
    choicePickerTitle.textContent = title
    choicePickerContent.replaceChildren(...choices.map(renderPickerChoice))
    choicePicker.style.left = `${anchor.x + 12}px`
    choicePicker.style.top = `${anchor.y + 12}px`
    choicePicker.hidden = false
    requestAnimationFrame(() => {
      const bounds = choicePicker.getBoundingClientRect()
      choicePicker.style.left = `${Math.max(10, Math.min(anchor.x + 12, window.innerWidth - bounds.width - 10))}px`
      choicePicker.style.top = `${Math.max(58, Math.min(anchor.y + 12, window.innerHeight - bounds.height - 10))}px`
    })
  }

  const handleStateClick = (path: string, _anchor: ChartInteractionAnchor): void => {
    if (walkthrough === undefined) {
      selectState(path, false)
      return
    }
    closeChoicePicker()
  }

  const handleTransitionClick = (
    transitionId: string,
    branchIds: ReadonlyArray<string>,
    anchor: ChartInteractionAnchor
  ): void => {
    if (walkthrough === undefined) {
      selectTransition(transitionId)
      return
    }
    const transition = transitionsById.get(transitionId)
    if (transition === undefined) return
    showChoicePicker(
      triggerLabel(transition),
      MachineWalkthrough.choices(walkthrough).filter((choice) => branchIds.includes(choice.branchId)),
      anchor
    )
  }

  const renderWalkthroughDock = (): void => {
    walkthroughDock.hidden = walkthrough === undefined
    chartPanel.classList.toggle("has-walkthrough", walkthrough !== undefined)
    if (walkthrough === undefined) {
      walkthroughTimeline.replaceChildren()
      return
    }
    const cursor = MachineWalkthrough.cursor(walkthrough)
    const timeline = MachineWalkthrough.timeline(walkthrough)
    const choices = MachineWalkthrough.choices(walkthrough)
    walkthroughStatus.textContent = `Step ${cursor} · ${activeTopology(activePaths())}`
    walkthroughHint.textContent = choices.length === 0
      ? "No outgoing transitions"
      : "Click a highlighted transition to advance"
    walkthroughTimeline.replaceChildren()
    timeline.forEach((frame) => {
      const label = frame.choice === null ? "Initial" : frame.choice.title ?? triggerName(frame.choice.trigger)
      const button = createElement(
        "button",
        `walkthrough-step${frame.step === cursor ? " is-current" : ""}`,
        `${frame.step} · ${label}`
      )
      button.type = "button"
      button.addEventListener("click", () => {
        if (walkthrough === undefined) return
        const result = MachineWalkthrough.seek(walkthrough, frame.step)
        if (Result.isFailure(result)) return
        walkthrough = result.success
        selectFrame(MachineWalkthrough.current(walkthrough))
        closeChoicePicker()
        updateWalkthroughUi()
        chartView?.revealStates(activePaths())
      })
      walkthroughTimeline.append(button)
    })
  }

  clearButton.addEventListener("click", clearSelection)
  inspectorClose.addEventListener("click", hideInspector)
  choicePickerClose.addEventListener("click", closeChoicePicker)
  detailsButton.addEventListener("click", () => {
    if (!inspector.hidden) {
      hideInspector()
    } else if (selectedFrame !== undefined) {
      renderWalkthroughTrace(selectedFrame)
    } else if (selectedPath !== undefined) {
      const inspection = model.inspectState(selectedPath)
      if (inspection !== undefined) renderInspection(inspection)
    } else if (selectedTransition !== undefined) {
      const transition = transitionsById.get(selectedTransition)
      if (transition !== undefined) renderTransitionInspection(transition)
    }
  })
  revealActiveButton.addEventListener("click", () => chartView?.revealStates(activePaths()))

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
  toolbarActions.append(clearButton, detailsButton, walkthroughButton, revealActiveButton)
  const zoomControls = createElement("div", "zoom-controls")
  zoomControls.setAttribute("role", "group")
  zoomControls.setAttribute("aria-label", "Chart zoom")
  zoomControls.append(zoomOutButton, zoomResetButton, zoomInButton, zoomFitButton)
  toolbar.append(runtime, toolbarActions)
  const chart = createElement("div", "topology-chart")
  chart.setAttribute("role", "region")
  chart.setAttribute("aria-label", `${model.machineId} states`)
  const chartHost = createElement("div", "chart-host")
  chartHost.append(createElement("div", "chart-loading", "Computing layout…"))
  chart.append(chartHost)

  const updateWalkthroughUi = (): void => {
    const active = new Set(activePaths())
    const simulating = walkthrough !== undefined
    updateChartPresentation()
    const hasRuntimeState = simulating || model.hasSnapshot
    runtimeDot.classList.toggle("has-snapshot", hasRuntimeState)
    runtimeText.textContent = walkthrough !== undefined
      ? `Simulation · ${active.size} active · step ${MachineWalkthrough.cursor(walkthrough)}`
      : diagnostics.length > 0
      ? "Partial"
      : model.hasSnapshot
      ? `${active.size} active`
      : "Structure only"
    walkthroughButton.textContent = simulating ? "Exit simulation" : "Start simulation"
    walkthroughButton.disabled = model.roots.length === 0
    revealActiveButton.disabled = active.size === 0
    clearButton.hidden = simulating
    detailsButton.hidden = simulating
    chartPanel.classList.toggle("is-simulating", simulating)
    if (simulating) hideInspector()
    renderWalkthroughDock()
    if (!simulating && !inspector.hidden) {
      if (selectedFrame !== undefined) {
        renderWalkthroughTrace(selectedFrame)
      } else if (selectedPath !== undefined) {
        const inspection = model.inspectState(selectedPath)
        if (inspection !== undefined) renderInspection(inspection)
      } else if (selectedTransition !== undefined) {
        const transition = transitionsById.get(selectedTransition)
        if (transition !== undefined) renderTransitionInspection(transition)
      }
    }
  }

  walkthroughButton.addEventListener("click", () => {
    if (walkthrough === undefined) {
      walkthrough = MachineWalkthrough.start(visualization)
      selectFrame(MachineWalkthrough.current(walkthrough))
      hideInspector()
      closeChoicePicker()
      requestAnimationFrame(() => chartView?.revealStates(activePaths()))
    } else {
      walkthrough = undefined
      closeChoicePicker()
      clearSelection()
    }
    updateWalkthroughUi()
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
  chartPanel.append(chart, walkthroughDock, zoomControls)
  hideInspector()
  workspace.append(chartPanel, inspector, choicePicker)
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
      selectState: handleStateClick,
      openStateDetails,
      selectTransition: handleTransitionClick,
      openTransitionDetails,
      clearSelection,
      zoomChanged: updateZoomControls
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
  updateWalkthroughUi()
}
