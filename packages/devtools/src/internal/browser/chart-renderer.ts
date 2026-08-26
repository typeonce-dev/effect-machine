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
  readonly selectState: (path: string, anchor: ChartInteractionAnchor) => void
  readonly openStateDetails: (path: string) => void
  readonly selectTransition: (
    transitionId: string,
    branchIds: ReadonlyArray<string>,
    anchor: ChartInteractionAnchor
  ) => void
  readonly openTransitionDetails: (transitionId: string) => void
  readonly clearSelection: () => void
  readonly zoomChanged: (zoom: number) => void
}

export interface ChartPresentation {
  readonly simulationMode: boolean
  readonly activePaths: ReadonlyArray<string>
  readonly selectedState: string | null
  readonly selectedTransition: string | null
  readonly fromPaths: ReadonlyArray<string>
  readonly toPaths: ReadonlyArray<string>
  readonly incomingTransitionIds: ReadonlyArray<string>
  readonly outgoingTransitionIds: ReadonlyArray<string>
  readonly availableBranchIds: ReadonlyArray<string>
  readonly unavailableBranchIds: ReadonlyArray<string>
}

export interface ChartView {
  readonly update: (presentation: ChartPresentation) => void
  readonly focusState: (path: string) => void
  readonly revealState: (path: string) => void
  readonly revealStates: (paths: ReadonlyArray<string>) => void
  readonly getZoom: () => number
  readonly setZoom: (zoom: number, anchor?: ChartZoomAnchor) => number
  readonly fit: () => number
}

export interface ChartZoomAnchor {
  readonly x: number
  readonly y: number
}

export interface ChartInteractionAnchor {
  readonly x: number
  readonly y: number
}

export const minimumChartZoom = 0.2
export const maximumChartZoom = 1.6
export const chartPanThreshold = 5

const clampZoom = (zoom: number): number => Math.min(maximumChartZoom, Math.max(minimumChartZoom, zoom))

export const chartZoomScrollPosition = (
  currentZoom: number,
  nextZoom: number,
  scrollLeft: number,
  scrollTop: number,
  anchor: ChartZoomAnchor
): ChartZoomAnchor => ({
  x: Math.max(0, (scrollLeft + anchor.x) / currentZoom * nextZoom - anchor.x),
  y: Math.max(0, (scrollTop + anchor.y) / currentZoom * nextZoom - anchor.y)
})

export const chartWheelZoom = (
  currentZoom: number,
  deltaY: number,
  deltaMode: number,
  viewportHeight: number
): number => {
  const normalizedDelta = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? viewportHeight : 1)
  return clampZoom(currentZoom * Math.exp(-normalizedDelta * 0.0025))
}

export const isChartPan = (
  start: ChartZoomAnchor,
  current: ChartZoomAnchor,
  threshold = chartPanThreshold
): boolean => Math.hypot(current.x - start.x, current.y - start.y) >= threshold

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
      const row = element("div", `chart-activity-row chart-activity-${activity.kind}`)
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
  marker.setAttribute("viewBox", "0 0 12 12")
  marker.setAttribute("refX", "11")
  marker.setAttribute("refY", "6")
  marker.setAttribute("markerWidth", "12")
  marker.setAttribute("markerHeight", "12")
  marker.setAttribute("markerUnits", "userSpaceOnUse")
  marker.setAttribute("orient", "auto-start-reverse")
  const arrow = svgElement("path")
  arrow.setAttribute("d", "M 1 1 L 11 6 L 1 11 z")
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
  let pan: {
    readonly pointerId: number
    readonly start: ChartZoomAnchor
    readonly scrollLeft: number
    readonly scrollTop: number
    dragging: boolean
  } | undefined
  let suppressClick = false
  let suppressDoubleClickUntil = 0

  const stateElements = new Map<string, Array<HTMLElement>>()
  const stateControls = new Map<string, HTMLButtonElement>()
  const stateStatuses = new Map<string, HTMLElement>()
  const transitionElements = new Map<string, Array<Element>>()
  const edgeElements = new Map<string, Array<Element>>()
  const transitionControls = new Map<string, Array<HTMLButtonElement>>()
  const chartEdges = new Map(
    layout.edges.flatMap((laidOut) => laidOut.kind === "transition" ? [[laidOut.edge.id, laidOut.edge] as const] : [])
  )

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
  const registerEdgeElement = (id: string, node: Element): void => {
    const registered = edgeElements.get(id) ?? []
    registered.push(node)
    edgeElements.set(id, registered)
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
    card.addEventListener(
      "click",
      (event) => handlers.selectState(laidOut.node.path, { x: event.clientX, y: event.clientY })
    )
    card.addEventListener("dblclick", () => handlers.openStateDetails(laidOut.node.path))
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

  for (const runtime of layout.runtimeTargets) {
    const target = element("span", "chart-runtime-target", runtime.target.label)
    target.setAttribute("aria-hidden", "true")
    position(target, runtime)
    nodesLayer.append(target)
  }

  const hoverTransition = (
    transitionId: string,
    source: string,
    target: string | null,
    hovered: boolean
  ): void => {
    transitionElements.get(transitionId)?.forEach((node) => node.classList.toggle("is-hovered", hovered))
    stateElements.get(source)?.forEach((node) => node.classList.toggle("is-hover-source", hovered))
    if (target !== null) {
      stateElements.get(target)?.forEach((node) => node.classList.toggle("is-hover-target", hovered))
    }
  }

  for (const laidOut of layout.edges) {
    const group = svgElement(
      "g",
      `chart-edge-group chart-edge-${laidOut.kind}${
        laidOut.kind === "transition"
          ? ` chart-transition-${laidOut.edge.kind} chart-edge-trigger-${laidOut.edge.trigger.type}${
            laidOut.edge.activityKind === null ? "" : ` chart-edge-activity-${laidOut.edge.activityKind}`
          }`
          : ""
      }`
    )
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
    registerEdgeElement(laidOut.edge.id, group)
    const label = element(
      "button",
      `chart-edge-label chart-edge-label-${laidOut.edge.trigger.type}${
        laidOut.edge.activityKind === null ? "" : ` chart-edge-activity-${laidOut.edge.activityKind}`
      }`,
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
    label.addEventListener(
      "click",
      (event) =>
        handlers.selectTransition(
          laidOut.edge.transitionId,
          laidOut.edge.branchIds,
          { x: event.clientX, y: event.clientY }
        )
    )
    label.addEventListener("dblclick", () => handlers.openTransitionDetails(laidOut.edge.transitionId))
    label.addEventListener(
      "mouseenter",
      () => hoverTransition(laidOut.edge.transitionId, laidOut.edge.source, laidOut.edge.target, true)
    )
    label.addEventListener(
      "mouseleave",
      () => hoverTransition(laidOut.edge.transitionId, laidOut.edge.source, laidOut.edge.target, false)
    )
    hit.addEventListener(
      "click",
      (event) =>
        handlers.selectTransition(
          laidOut.edge.transitionId,
          laidOut.edge.branchIds,
          { x: event.clientX, y: event.clientY }
        )
    )
    hit.addEventListener("dblclick", () => handlers.openTransitionDetails(laidOut.edge.transitionId))
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
    registerEdgeElement(laidOut.edge.id, label)
    const controls = transitionControls.get(laidOut.edge.id) ?? []
    controls.push(label)
    transitionControls.set(laidOut.edge.id, controls)
  }

  viewport.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    handlers.clearSelection()
  })

  viewport.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || pan !== undefined) return
    pan = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      dragging: false
    }
  })

  viewport.addEventListener("pointermove", (event) => {
    if (pan === undefined || event.pointerId !== pan.pointerId) return
    const current = { x: event.clientX, y: event.clientY }
    if (!pan.dragging) {
      if (!isChartPan(pan.start, current)) return
      pan.dragging = true
      viewport.setPointerCapture(event.pointerId)
      viewport.classList.add("is-panning")
      const focused = document.activeElement
      if (focused instanceof HTMLElement && viewport.contains(focused)) focused.blur()
    }
    event.preventDefault()
    viewport.scrollTo({
      left: pan.scrollLeft - (current.x - pan.start.x),
      top: pan.scrollTop - (current.y - pan.start.y)
    })
  })

  const finishPan = (event: PointerEvent, cancelled: boolean): void => {
    if (pan === undefined || event.pointerId !== pan.pointerId) return
    const dragged = pan.dragging
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
    viewport.classList.remove("is-panning")
    pan = undefined
    if (!dragged || cancelled) return
    event.preventDefault()
    suppressClick = true
    suppressDoubleClickUntil = performance.now() + 400
    setTimeout(() => {
      suppressClick = false
    }, 0)
  }

  viewport.addEventListener("pointerup", (event) => finishPan(event, false))
  viewport.addEventListener("pointercancel", (event) => finishPan(event, true))
  viewport.addEventListener("click", (event) => {
    if (!suppressClick) return
    suppressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)
  viewport.addEventListener("dblclick", (event) => {
    if (performance.now() > suppressDoubleClickUntil) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)

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

  const revealStates = (paths: ReadonlyArray<string>): void => {
    const leaves = paths.filter((path) => !paths.some((candidate) => candidate.startsWith(`${path}.`)))
    const bounds = leaves
      .map((path) => layout.nodes.find(({ node }) => node.path === path))
      .filter((node): node is LaidOutChartNode => node !== undefined)
    if (bounds.length === 0) return
    const left = Math.min(...bounds.map(({ x }) => x)) * zoom
    const top = Math.min(...bounds.map(({ y }) => y)) * zoom
    const right = Math.max(...bounds.map(({ x, width }) => x + width)) * zoom
    const bottom = Math.max(...bounds.map(({ y, height }) => y + height)) * zoom
    const margin = 32
    const visible = left >= viewport.scrollLeft + margin &&
      top >= viewport.scrollTop + margin &&
      right <= viewport.scrollLeft + viewport.clientWidth - margin &&
      bottom <= viewport.scrollTop + viewport.clientHeight - margin
    if (visible) return
    viewport.scrollTo({
      left: Math.max(0, (left + right - viewport.clientWidth) / 2),
      top: Math.max(0, (top + bottom - viewport.clientHeight) / 2)
    })
  }

  const setZoom = (requested: number, anchor?: ChartZoomAnchor): number => {
    const next = clampZoom(requested)
    if (next === zoom) return zoom
    const zoomAnchor = anchor ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
    const scroll = chartZoomScrollPosition(
      zoom,
      next,
      viewport.scrollLeft,
      viewport.scrollTop,
      zoomAnchor
    )
    zoom = next
    canvas.style.transform = `scale(${zoom})`
    stage.style.width = `${layout.width * zoom}px`
    stage.style.height = `${layout.height * zoom}px`
    viewport.scrollTo({
      left: scroll.x,
      top: scroll.y
    })
    handlers.zoomChanged(zoom)
    return zoom
  }

  viewport.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    const bounds = viewport.getBoundingClientRect()
    setZoom(
      chartWheelZoom(zoom, event.deltaY, event.deltaMode, viewport.clientHeight),
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    )
  }, { passive: false })

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
      const availableBranches = new Set(presentation.availableBranchIds)
      const unavailableBranches = new Set(presentation.unavailableBranchIds)
      stateControls.forEach((control) => {
        control.disabled = presentation.simulationMode
      })
      transitionControls.forEach((controls, edgeId) => {
        const edge = chartEdges.get(edgeId)
        const interactive = edge?.branchIds.some((branchId) =>
          availableBranches.has(branchId) || unavailableBranches.has(branchId)
        )
        controls.forEach((control) => {
          control.disabled = presentation.simulationMode && !interactive
        })
      })
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
          node.classList.remove(
            "is-selected",
            "is-incoming",
            "is-outgoing",
            "is-walkthrough-available",
            "is-walkthrough-unavailable"
          )
        })
      )
      stateStatuses.forEach((node, path) => {
        const isActive = active.has(path)
        const isInitial = node.dataset.initial === "true"
        node.classList.toggle("is-active", isActive)
        node.setAttribute("aria-label", statusLabel(isActive, isInitial))
      })
      viewport.classList.toggle("is-simulating", presentation.simulationMode)
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
      layout.edges.forEach((laidOut) => {
        if (laidOut.kind !== "transition") return
        const available = laidOut.edge.branchIds.some((branchId) => availableBranches.has(branchId))
        const unavailable = laidOut.edge.branchIds.some((branchId) => unavailableBranches.has(branchId))
        const className = available
          ? "is-walkthrough-available"
          : unavailable
          ? "is-walkthrough-unavailable"
          : undefined
        if (className !== undefined) {
          edgeElements.get(laidOut.edge.id)?.forEach((node) => node.classList.add(className))
        }
      })
    },
    focusState: (path) => {
      const control = stateControls.get(path)
      control?.focus({ preventScroll: true })
      revealState(path)
    },
    revealState,
    revealStates,
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
