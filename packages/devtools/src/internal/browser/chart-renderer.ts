import * as Effect from "effect/Effect"
import type { MachineDocument as VisualizationDocument } from "../../MachineDocument.js"
import {
  type ChartLayoutError,
  type ChartPoint,
  type LaidOutChart,
  type LaidOutChartNode,
  layoutChart,
  maxVisibleActivities,
  maxVisibleFields
} from "./chart-layout.js"
import { makeChartModel } from "./chart-model.js"

export interface ChartHandlers {
  readonly selectState: (path: string) => void
  readonly selectTransition: (transitionId: string) => void
  readonly clearSelection: () => void
}

export interface ChartPresentation {
  readonly activePaths: ReadonlyArray<string>
  readonly selectedState: string | null
  readonly selectedTransition: string | null
  readonly fromPaths: ReadonlyArray<string>
  readonly toPaths: ReadonlyArray<string>
  readonly incomingTransitionIds: ReadonlyArray<string>
  readonly outgoingTransitionIds: ReadonlyArray<string>
}

export interface ChartView {
  readonly update: (presentation: ChartPresentation) => void
  readonly focusState: (path: string) => void
  readonly revealState: (path: string) => void
  readonly getZoom: () => number
  readonly setZoom: (zoom: number) => number
  readonly fit: () => number
}

export const minimumChartZoom = 0.2
export const maximumChartZoom = 1.6

const element = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string,
  text?: string
): HTMLElementTagNameMap[Tag] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const svgElement = <Tag extends keyof SVGElementTagNameMap>(
  tag: Tag,
  className?: string
): SVGElementTagNameMap[Tag] => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag)
  if (className !== undefined) node.setAttribute("class", className)
  return node
}

const position = (
  target: HTMLElement,
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
): void => {
  target.style.left = `${bounds.x}px`
  target.style.top = `${bounds.y}px`
  target.style.width = `${bounds.width}px`
  target.style.height = `${bounds.height}px`
}

const statusLabel = (active: boolean, initial: boolean): string => {
  if (active && initial) return "active, initial state"
  if (active) return "active"
  if (initial) return "initial state"
  return "inactive"
}

const status = (active: boolean, initial: boolean): HTMLSpanElement => {
  const dot = element(
    "span",
    `chart-state-status${active ? " is-active" : ""}${initial ? " is-initial" : ""}`
  )
  dot.dataset.initial = String(initial)
  dot.setAttribute("aria-label", statusLabel(active, initial))
  return dot
}

const more = (count: number): HTMLElement => element("div", "chart-more", `+${count} more`)

const stateContent = (layout: LaidOutChartNode, stateStatus: HTMLElement): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  const heading = element("div", "chart-state-heading")
  const identity = element("div", "chart-state-identity")
  identity.append(stateStatus, element("strong", "chart-state-name", layout.node.label))
  heading.append(identity)
  fragment.append(heading)

  if (layout.node.fields.length > 0) {
    const fields = element("div", "chart-state-section")
    fields.append(element("div", "chart-section-label", "value"))
    layout.node.fields.slice(0, maxVisibleFields).forEach((field) => {
      const row = element("div", "chart-field-row")
      row.append(
        element("span", "chart-field-name", `${field.label}${field.required ? "" : "?"}`),
        element("span", "chart-field-type", field.type)
      )
      fields.append(row)
    })
    if (layout.node.fields.length > maxVisibleFields) {
      fields.append(more(layout.node.fields.length - maxVisibleFields))
    }
    fragment.append(fields)
  }

  if (layout.node.activities.length > 0) {
    const activities = element("div", "chart-state-section")
    activities.append(element("div", "chart-section-label", "invokes"))
    layout.node.activities.slice(0, maxVisibleActivities).forEach((activity) => {
      const row = element("div", "chart-activity-row")
      row.append(
        element("span", "chart-activity-kind", activity.kind),
        element("span", "chart-activity-name", activity.label)
      )
      activities.append(row)
    })
    if (layout.node.activities.length > maxVisibleActivities) {
      activities.append(more(layout.node.activities.length - maxVisibleActivities))
    }
    fragment.append(activities)
  }

  return fragment
}

const pathData = (points: ReadonlyArray<ChartPoint>): string => {
  const first = points[0]
  if (first === undefined) return ""
  return points.slice(1).reduce((path, point) => `${path} L ${point.x} ${point.y}`, `M ${first.x} ${first.y}`)
}

const setStateClass = (
  elements: ReadonlyMap<string, ReadonlyArray<HTMLElement>>,
  paths: ReadonlyArray<string>,
  className: string
): void => {
  for (const path of paths) elements.get(path)?.forEach((node) => node.classList.add(className))
}

const render = (
  host: HTMLElement,
  layout: LaidOutChart,
  handlers: ChartHandlers
): ChartView => {
  const viewport = element("div", "chart-viewport")
  const stage = element("div", "chart-stage")
  const canvas = element("div", "chart-canvas")
  stage.style.width = `${layout.width}px`
  stage.style.height = `${layout.height}px`
  canvas.style.width = `${layout.width}px`
  canvas.style.height = `${layout.height}px`
  const regions = element("div", "chart-regions")
  const svg = svgElement("svg", "chart-edges")
  svg.setAttribute("width", String(layout.width))
  svg.setAttribute("height", String(layout.height))
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`)
  svg.setAttribute("aria-hidden", "true")
  const definitions = svgElement("defs")
  const marker = svgElement("marker")
  marker.id = "chart-arrow"
  marker.setAttribute("viewBox", "0 0 10 10")
  marker.setAttribute("refX", "9")
  marker.setAttribute("refY", "5")
  marker.setAttribute("markerWidth", "7")
  marker.setAttribute("markerHeight", "7")
  marker.setAttribute("orient", "auto-start-reverse")
  const arrow = svgElement("path")
  arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z")
  marker.append(arrow)
  definitions.append(marker)
  svg.append(definitions)
  const nodesLayer = element("div", "chart-nodes")
  const labelsLayer = element("div", "chart-labels")
  canvas.append(regions, svg, nodesLayer, labelsLayer)
  stage.append(canvas)
  viewport.append(stage)
  host.replaceChildren(viewport)

  let zoom = 1

  const stateElements = new Map<string, Array<HTMLElement>>()
  const stateControls = new Map<string, HTMLButtonElement>()
  const stateStatuses = new Map<string, HTMLElement>()
  const transitionElements = new Map<string, Array<Element>>()

  const registerStateElement = (path: string, node: HTMLElement): void => {
    const registered = stateElements.get(path) ?? []
    registered.push(node)
    stateElements.set(path, registered)
  }
  const registerTransitionElement = (id: string, node: Element): void => {
    const registered = transitionElements.get(id) ?? []
    registered.push(node)
    transitionElements.set(id, registered)
  }

  for (const laidOut of layout.nodes) {
    if (laidOut.node.children.length > 0) {
      const region = element("div", `chart-compound chart-compound-${laidOut.node.type}`)
      region.dataset.statePath = laidOut.node.path
      position(region, laidOut)
      regions.append(region)
      registerStateElement(laidOut.node.path, region)
    }

    const card = element("button", `chart-state chart-state-${laidOut.node.type}`)
    card.type = "button"
    card.dataset.statePath = laidOut.node.path
    card.setAttribute("aria-label", `${laidOut.node.label}, ${laidOut.node.type} state`)
    position(card, {
      x: laidOut.x,
      y: laidOut.y,
      width: laidOut.width,
      height: laidOut.node.children.length > 0 ? laidOut.headerHeight : laidOut.height
    })
    const stateStatus = status(laidOut.node.active, laidOut.node.initial)
    card.append(stateContent(laidOut, stateStatus))
    card.addEventListener("click", () => handlers.selectState(laidOut.node.path))
    nodesLayer.append(card)
    registerStateElement(laidOut.node.path, card)
    stateControls.set(laidOut.node.path, card)
    stateStatuses.set(laidOut.node.path, stateStatus)
  }

  for (const initial of layout.initials) {
    const dot = element("span", "chart-initial")
    dot.setAttribute("aria-hidden", "true")
    position(dot, initial)
    nodesLayer.append(dot)
  }

  const hoverTransition = (
    transitionId: string,
    source: string,
    target: string,
    hovered: boolean
  ): void => {
    transitionElements.get(transitionId)?.forEach((node) => node.classList.toggle("is-hovered", hovered))
    stateElements.get(source)?.forEach((node) => node.classList.toggle("is-hover-source", hovered))
    stateElements.get(target)?.forEach((node) => node.classList.toggle("is-hover-target", hovered))
  }

  for (const laidOut of layout.edges) {
    const group = svgElement("g", `chart-edge-group chart-edge-${laidOut.kind}`)
    const visible = svgElement("path", "chart-edge-line")
    const route = pathData(laidOut.points)
    visible.setAttribute("d", route)
    visible.setAttribute("marker-end", "url(#chart-arrow)")
    const hit = svgElement("path", "chart-edge-hit")
    hit.setAttribute("d", route)
    group.append(visible, hit)
    svg.append(group)
    if (laidOut.kind === "initial") continue

    registerTransitionElement(laidOut.edge.transitionId, group)
    const label = element(
      "button",
      `chart-edge-label chart-edge-label-${laidOut.edge.trigger.type}`,
      laidOut.edge.label
    )
    label.type = "button"
    label.dataset.transitionId = laidOut.edge.transitionId
    position(label, {
      x: laidOut.label.x - laidOut.labelWidth / 2,
      y: laidOut.label.y - laidOut.labelHeight / 2,
      width: laidOut.labelWidth,
      height: laidOut.labelHeight
    })
    label.addEventListener("click", () => handlers.selectTransition(laidOut.edge.transitionId))
    label.addEventListener(
      "mouseenter",
      () => hoverTransition(laidOut.edge.transitionId, laidOut.edge.source, laidOut.edge.target, true)
    )
    label.addEventListener(
      "mouseleave",
      () => hoverTransition(laidOut.edge.transitionId, laidOut.edge.source, laidOut.edge.target, false)
    )
    hit.addEventListener("click", () => handlers.selectTransition(laidOut.edge.transitionId))
    hit.addEventListener(
      "mouseenter",
      () => hoverTransition(laidOut.edge.transitionId, laidOut.edge.source, laidOut.edge.target, true)
    )
    hit.addEventListener(
      "mouseleave",
      () => hoverTransition(laidOut.edge.transitionId, laidOut.edge.source, laidOut.edge.target, false)
    )
    labelsLayer.append(label)
    registerTransitionElement(laidOut.edge.transitionId, label)
  }

  viewport.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    handlers.clearSelection()
  })

  const revealState = (path: string): void => {
    const control = stateControls.get(path)
    if (control === undefined) return
    const left = Number.parseFloat(control.style.left) * zoom
    const top = Number.parseFloat(control.style.top) * zoom
    const width = control.offsetWidth * zoom
    const height = control.offsetHeight * zoom
    viewport.scrollTo({
      left: Math.max(0, left - Math.max(28, (viewport.clientWidth - width) / 2)),
      top: Math.max(0, top - Math.max(28, (viewport.clientHeight - height) / 2))
    })
  }

  const setZoom = (requested: number): number => {
    const next = Math.min(maximumChartZoom, Math.max(minimumChartZoom, requested))
    if (next === zoom) return zoom
    const center = {
      x: (viewport.scrollLeft + viewport.clientWidth / 2) / zoom,
      y: (viewport.scrollTop + viewport.clientHeight / 2) / zoom
    }
    zoom = next
    canvas.style.transform = `scale(${zoom})`
    stage.style.width = `${layout.width * zoom}px`
    stage.style.height = `${layout.height * zoom}px`
    viewport.scrollTo({
      left: Math.max(0, center.x * zoom - viewport.clientWidth / 2),
      top: Math.max(0, center.y * zoom - viewport.clientHeight / 2)
    })
    return zoom
  }

  const fit = (): number => {
    const availableWidth = Math.max(1, viewport.clientWidth - 48)
    const availableHeight = Math.max(1, viewport.clientHeight - 48)
    const fitted = setZoom(Math.min(1, availableWidth / layout.width, availableHeight / layout.height))
    viewport.scrollTo({ left: 0, top: 0 })
    return fitted
  }

  return {
    update: (presentation) => {
      const active = new Set(presentation.activePaths)
      stateElements.forEach((elements) =>
        elements.forEach((node) => {
          node.classList.remove(
            "is-selected",
            "is-related-from",
            "is-related-to"
          )
        })
      )
      transitionElements.forEach((elements) =>
        elements.forEach((node) => {
          node.classList.remove("is-selected", "is-incoming", "is-outgoing")
        })
      )
      stateStatuses.forEach((node, path) => {
        const isActive = active.has(path)
        const isInitial = node.dataset.initial === "true"
        node.classList.toggle("is-active", isActive)
        node.setAttribute("aria-label", statusLabel(isActive, isInitial))
      })
      if (presentation.selectedState !== null) {
        stateElements.get(presentation.selectedState)?.forEach((node) => node.classList.add("is-selected"))
      }
      if (presentation.selectedTransition !== null) {
        transitionElements.get(presentation.selectedTransition)?.forEach((node) => node.classList.add("is-selected"))
      }
      setStateClass(stateElements, presentation.fromPaths, "is-related-from")
      setStateClass(stateElements, presentation.toPaths, "is-related-to")
      presentation.incomingTransitionIds.forEach((id) =>
        transitionElements.get(id)?.forEach((node) => node.classList.add("is-incoming"))
      )
      presentation.outgoingTransitionIds.forEach((id) =>
        transitionElements.get(id)?.forEach((node) => node.classList.add("is-outgoing"))
      )
    },
    focusState: (path) => {
      const control = stateControls.get(path)
      control?.focus({ preventScroll: true })
      revealState(path)
    },
    revealState,
    getZoom: () => zoom,
    setZoom,
    fit
  }
}

export const renderChart = (
  host: HTMLElement,
  document: VisualizationDocument,
  handlers: ChartHandlers
): Effect.Effect<ChartView, ChartLayoutError> => {
  const statesByPath = new Map(document.states.map((state) => [state.path, state]))
  const visited = new Set<string>()
  let initialFocus = document.initial.target
  while (!visited.has(initialFocus)) {
    visited.add(initialFocus)
    const state = statesByPath.get(initialFocus)
    if (state === undefined) break
    const next = state.type === "parallel" ? state.children[0] : state.initial
    if (next === null || next === undefined) break
    initialFocus = next
  }

  return layoutChart(makeChartModel(document)).pipe(Effect.map((layout) => {
    const view = render(host, layout, handlers)
    setTimeout(() => {
      if (host.isConnected) view.revealState(initialFocus)
    }, 0)
    return view
  }))
}
