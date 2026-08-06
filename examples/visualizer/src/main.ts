import "./styles.css"
import { Machine } from "@typeonce/effect-machine"
import { Effect } from "effect"
import { defineEventFixtures, type EventSample, generateEventSamples, mergeEventSamples } from "./eventSamples.ts"
import { buildDiagramGraph, type DiagramNode, type DiagramTransition } from "./graph.ts"
import { Event, type VisualizerEvent, VisualizerMachine } from "./machine.ts"
import { createPlannerSession, type PlannerView } from "./plannerSession.ts"

const requiredElement = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`Missing element: ${selector}`)
  return element
}

const explicitFixtures = defineEventFixtures(VisualizerMachine, [
  {
    id: "start-visualizer",
    label: "Start visualizer task",
    event: Event.cases.Start.make({ task: "Visualize machine" })
  }
])
const generated = generateEventSamples(VisualizerMachine, { seed: 20_260_805 })
const samples = mergeEventSamples(generated.samples, explicitFixtures)
const samplesByTag = new Map<PropertyKey, EventSample<VisualizerEvent>>()
for (const sample of samples) {
  if (!samplesByTag.has(sample.event._tag)) samplesByTag.set(sample.event._tag, sample)
}

const session = await createPlannerSession(
  {
    machine: VisualizerMachine,
    initial: () => Effect.runPromise(Machine.planInitial(VisualizerMachine)).then(({ state }) => state),
    enabled: (snapshot) => Machine.enabled(VisualizerMachine, snapshot),
    plan: (snapshot, event) => Effect.runPromise(Machine.plan(VisualizerMachine, snapshot, event))
  },
  samples
)
const graph = buildDiagramGraph(VisualizerMachine)
const nodesByPath = new Map(graph.nodes.map((node) => [node.path, node]))

document.title = `${graph.id} · Effect Machine`
requiredElement<HTMLElement>("#app").innerHTML = `
  <header class="page-header">
    <div>
      <p class="eyebrow">@typeonce/effect-machine · planner experiment</p>
      <h1>${graph.id}</h1>
      <p class="lede">Click a currently enabled event to plan the next settled snapshot.</p>
    </div>
    <button class="reset-button" id="reset-session" type="button">Restart session</button>
  </header>
  <section class="workspace">
    <div class="diagram-panel">
      <div class="diagram-heading">
        <div>
          <strong>Statechart</strong>
          <span id="active-summary"></span>
        </div>
        <div class="legend" aria-label="Diagram legend">
          <span><i class="legend-dot active"></i>active</span>
          <span><i class="legend-dot"></i>inactive</span>
          <span><i class="legend-line"></i>declared transition</span>
        </div>
      </div>
      <div class="diagram-viewport">
        <div class="diagram-canvas" id="diagram-canvas"></div>
      </div>
      <p class="step-summary" id="step-summary">Machine initialized. No event has been planned yet.</p>
      <p class="error-summary" id="error-summary" role="alert"></p>
    </div>
    <aside class="events-panel">
      <div class="events-heading">
        <strong>Enabled event values</strong>
        <span>seed 20,260,805</span>
      </div>
      <div id="event-list" class="event-list"></div>
      <div id="generation-issues" class="generation-issues"></div>
    </aside>
  </section>
  <p class="planner-note">
    This sandbox calls <code>Machine.plan</code>. It settles raised, eventless, and completion transitions, but it does
    not execute deferred actions, timers, or invoked services.
  </p>
`

const svgElement = <Name extends keyof SVGElementTagNameMap>(
  name: Name,
  attributes: Readonly<Record<string, string | number>> = {}
): SVGElementTagNameMap[Name] => {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  return element
}

const center = (node: DiagramNode) => ({
  x: node.x + node.width / 2,
  y: node.y + node.height / 2
})

const edgePath = (source: DiagramNode, target: DiagramNode): string => {
  const from = center(source)
  const to = center(target)
  if (source.path === target.path) {
    const right = source.x + source.width
    const top = source.y
    return `M ${right - 16} ${top + 16} C ${right + 54} ${top - 46}, ${source.x + 32} ${top - 46}, ${source.x + 16} ${
      top + 12
    }`
  }

  const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
  if (horizontal) {
    const forwards = to.x >= from.x
    const startX = forwards ? source.x + source.width : source.x
    const endX = forwards ? target.x : target.x + target.width
    const middleX = (startX + endX) / 2
    const laneOffset = forwards ? -12 : 12
    return `M ${startX} ${from.y} C ${middleX} ${from.y + laneOffset}, ${middleX} ${to.y + laneOffset}, ${endX} ${to.y}`
  }
  const downwards = to.y >= from.y
  const startY = downwards ? source.y + source.height : source.y
  const endY = downwards ? target.y : target.y + target.height
  const middleY = (startY + endY) / 2
  return `M ${from.x} ${startY} C ${from.x} ${middleY}, ${to.x} ${middleY}, ${to.x} ${endY}`
}

const eventPoint = (transition: DiagramTransition): { readonly x: number; readonly y: number } => {
  const source = nodesByPath.get(transition.source)
  if (source === undefined) return { x: 0, y: 0 }
  if (transition.targets.type === "declared" && transition.targets.paths.length > 0) {
    const target = nodesByPath.get(transition.choice ?? transition.targets.paths[0]!)
    if (target !== undefined) {
      const from = center(source)
      const to = center(target)
      if (source.path === target.path) return { x: from.x, y: source.y - 20 }
      const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
      return {
        x: (from.x + to.x) / 2 + (horizontal ? 0 : to.y >= from.y ? 16 : -16),
        y: (from.y + to.y) / 2 + (horizontal ? to.x >= from.x ? -14 : 14 : 0)
      }
    }
  }
  return { x: source.x + source.width / 2, y: source.y - 18 }
}

const canvas = requiredElement<HTMLElement>("#diagram-canvas")
canvas.style.width = `${graph.width}px`
canvas.style.height = `${graph.height}px`
const svg = svgElement("svg", {
  viewBox: `0 0 ${graph.width} ${graph.height}`,
  width: graph.width,
  height: graph.height,
  role: "img",
  "aria-label": `${graph.id} statechart`
})
canvas.append(svg)

const definitions = svgElement("defs")
const marker = svgElement("marker", {
  id: "arrow",
  viewBox: "0 0 10 10",
  refX: 9,
  refY: 5,
  markerWidth: 7,
  markerHeight: 7,
  orient: "auto-start-reverse"
})
marker.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "arrow-head" }))
definitions.append(marker)
svg.append(definitions)

const nodeElements = new Map<string, SVGGElement>()
const drawNode = (node: DiagramNode, group: boolean): void => {
  const element = svgElement("g", { class: `state-node ${group ? "state-group" : "state-leaf"}` })
  element.dataset.nodePath = node.path
  const box = svgElement("rect", {
    x: node.type === "choice" ? node.x + 10 : node.x,
    y: node.type === "choice" ? node.y + 10 : node.y,
    width: node.type === "choice" ? node.width - 20 : node.width,
    height: node.type === "choice" ? node.height - 20 : node.height,
    rx: group ? 16 : node.type === "history" ? 24 : node.type === "choice" ? 0 : 10,
    class: "state-box",
    ...(node.type === "choice"
      ? { transform: `rotate(45 ${node.x + node.width / 2} ${node.y + node.height / 2})` }
      : {})
  })
  const label = svgElement("text", {
    x: node.x + (group ? 15 : node.width / 2),
    y: node.y + (group ? 24 : node.height / 2 + 5),
    class: "state-label",
    "text-anchor": group ? "start" : "middle"
  })
  label.textContent = node.type === "choice" ? "?" : node.key
  element.append(box, label)
  if (group) {
    const kind = svgElement("text", {
      x: node.x + node.width - 14,
      y: node.y + 23,
      class: "state-kind",
      "text-anchor": "end"
    })
    kind.textContent = node.type
    element.append(kind)
  }
  if (node.type === "history") element.classList.add("is-history")
  if (node.type === "choice") element.classList.add("is-choice")
  svg.append(element)
  nodeElements.set(node.path, element)
}

const grouped = graph.nodes.filter(({ type }) => type === "compound" || type === "parallel")
for (const node of grouped.sort((left, right) => left.depth - right.depth)) drawNode(node, true)

for (const transition of graph.transitions) {
  const source = nodesByPath.get(transition.source)
  if (source === undefined || transition.targets.type !== "declared") continue
  const choice = transition.choice === undefined ? undefined : nodesByPath.get(transition.choice)
  if (choice !== undefined) {
    const path = svgElement("path", {
      d: edgePath(source, choice),
      class: `transition-edge${transition.reenter ? " is-reenter" : ""}`,
      "marker-end": "url(#arrow)"
    })
    svg.append(path)
  }
  for (const targetPath of transition.targets.paths) {
    const target = nodesByPath.get(targetPath)
    if (target === undefined) continue
    const path = svgElement("path", {
      d: edgePath(choice ?? source, target),
      class: `transition-edge${transition.reenter ? " is-reenter" : ""}`,
      "marker-end": "url(#arrow)"
    })
    svg.append(path)
  }
}

for (const node of graph.nodes.filter(({ type }) => type !== "compound" && type !== "parallel")) drawNode(node, false)

const eventButtons = new Map<string, HTMLButtonElement>()
for (const transition of graph.transitions) {
  if (transition.trigger.type !== "event") continue
  const point = eventPoint(transition)
  const sample = samplesByTag.get(transition.trigger.event)
  const button = document.createElement("button")
  button.type = "button"
  button.className = "edge-event"
  button.style.left = `${point.x}px`
  button.style.top = `${point.y}px`
  button.textContent = `${String(transition.trigger.event)}${transition.reenter ? " ↻" : ""}`
  button.dataset.transitionId = transition.id
  button.dataset.sourcePath = transition.source
  if (sample !== undefined) button.dataset.sampleId = sample.id
  button.addEventListener("click", () => {
    if (sample !== undefined) void planSample(sample.id)
  })
  canvas.append(button)
  eventButtons.set(transition.id, button)
}

const payload = (event: VisualizerEvent): string => {
  const { _tag: _, ...fields } = event
  return Object.keys(fields).length === 0 ? "{}" : JSON.stringify(fields)
}

const render = (view: PlannerView<typeof VisualizerMachine>): void => {
  const activePaths = new Set(view.activePaths)
  const entered = new Set(view.lastStep?.microsteps.flatMap(({ entryPaths }) => entryPaths) ?? [])
  const exited = new Set(view.lastStep?.microsteps.flatMap(({ exitPaths }) => exitPaths) ?? [])
  for (const [path, element] of nodeElements) {
    element.classList.toggle("is-active", activePaths.has(path))
    element.classList.toggle("was-entered", entered.has(path))
    element.classList.toggle("was-exited", exited.has(path))
  }

  for (const transition of graph.transitions) {
    if (transition.trigger.type !== "event") continue
    const button = eventButtons.get(transition.id)
    const sample = samplesByTag.get(transition.trigger.event)
    if (button === undefined) continue
    const enabled = sample !== undefined && activePaths.has(transition.source) &&
      view.enabledTags.has(transition.trigger.event)
    button.disabled = !enabled
    button.classList.toggle("is-enabled", enabled)
  }

  requiredElement<HTMLElement>("#active-summary").textContent = view.activePaths
    .filter((path) => !view.activePaths.some((candidate) => candidate !== path && candidate.startsWith(`${path}.`)))
    .map((path) => path.slice(path.lastIndexOf(".") + 1))
    .join(" · ")

  const eventList = requiredElement<HTMLElement>("#event-list")
  eventList.replaceChildren()
  for (const sample of view.availableSamples) {
    const row = document.createElement("div")
    row.className = "event-row"
    const button = document.createElement("button")
    button.type = "button"
    button.className = "event-send"
    button.textContent = sample.label
    button.addEventListener("click", () => void planSample(sample.id))
    const detail = document.createElement("div")
    const origin = document.createElement("span")
    origin.className = `event-origin is-${sample.origin}`
    origin.textContent = sample.origin
    const code = document.createElement("code")
    code.textContent = payload(sample.event)
    detail.append(origin, code)
    row.append(button, detail)
    eventList.append(row)
  }

  const stepSummary = requiredElement<HTMLElement>("#step-summary")
  if (view.lastStep === undefined) {
    stepSummary.textContent = "Machine initialized. No event has been planned yet."
  } else {
    const entries = [...new Set(view.lastStep.microsteps.flatMap(({ entryPaths }) => entryPaths))]
    const detail = entries.length === 0 ? "no active path changed" : `entered ${entries.join(", ")}`
    stepSummary.textContent = `${String(view.lastStep.event._tag)} · ${view.lastStep.classification} · ${detail}`
  }
}

const planSample = async (sampleId: string): Promise<void> => {
  const error = requiredElement<HTMLElement>("#error-summary")
  error.textContent = ""
  try {
    render(await session.send(sampleId))
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : String(cause)
  }
}

requiredElement<HTMLButtonElement>("#reset-session").addEventListener("click", () => {
  void session.reset().then(render)
})

const issues = requiredElement<HTMLElement>("#generation-issues")
if (generated.issues.length > 0) {
  const summary = document.createElement("details")
  const label = document.createElement("summary")
  label.textContent = `${generated.issues.length} generation diagnostic${generated.issues.length === 1 ? "" : "s"}`
  const list = document.createElement("ul")
  for (const issue of generated.issues) {
    const item = document.createElement("li")
    item.textContent = `${issue.schema}: ${issue.message}`
    list.append(item)
  }
  summary.append(label, list)
  issues.append(summary)
}

render(session.inspect())
