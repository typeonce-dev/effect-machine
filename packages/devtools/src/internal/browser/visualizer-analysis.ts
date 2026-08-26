import type { MachineDocument as VisualizationDocument } from "../../MachineDocument.js"
import { makeChartLayoutPolicy } from "./chart-layout-policy.js"
import { makeChartModel } from "./chart-model.js"

export interface UnhandledPublicEventWarning {
  readonly _tag: "UnhandledPublicEvent"
  readonly event: string
}

export interface NoStaticPathNote {
  readonly _tag: "NoStaticPathFromInitial"
  readonly path: string
  readonly label: string
  readonly type: "atomic" | "compound" | "parallel" | "final" | "history" | "choice"
  readonly descendantCount: number
}

export interface VisualizerAnalysis {
  readonly warnings: ReadonlyArray<UnhandledPublicEventWarning>
  readonly topologyNotes: ReadonlyArray<NoStaticPathNote>
}

/** Static findings derived without executing machine callbacks. */
export const analyzeVisualization = (document: VisualizationDocument): VisualizerAnalysis => {
  const handledEvents = new Set(
    document.transitions.flatMap((transition): ReadonlyArray<string> =>
      transition.trigger.type === "event" ? [transition.trigger.event] : []
    )
  )
  const declaredEvents = new Set(document.inputs.events.map(({ event }) => event))
  const warnings = [...declaredEvents].flatMap((event): ReadonlyArray<UnhandledPublicEventWarning> =>
    handledEvents.has(event) ? [] : [{ _tag: "UnhandledPublicEvent", event }]
  )

  const chart = makeChartModel(document)
  const policy = makeChartLayoutPolicy(chart)
  const topologyNotes = chart.nodes.flatMap((node): ReadonlyArray<NoStaticPathNote> => {
    const hasStaticPath = policy.node(node.path).staticPath
    const parentHasStaticPath = node.parent === null || policy.node(node.parent).staticPath
    if (hasStaticPath || !parentHasStaticPath) return []
    const descendantCount = chart.nodes.filter(({ path }) => path.startsWith(`${node.path}.`)).length
    return [{
      _tag: "NoStaticPathFromInitial",
      path: node.path,
      label: node.label,
      type: node.type,
      descendantCount
    }]
  })

  return { warnings, topologyNotes }
}
