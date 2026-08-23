import type { VisualizationDocument } from "./visualization-document.js"
import { renderVisualizer, type VisualizerDiagnostic } from "./visualizer-app.js"

export type { VisualizerDiagnostic } from "./visualizer-app.js"

export type VisualizerSource =
  | {
    readonly status: "ready"
    readonly document: VisualizationDocument
  }
  | {
    readonly status: "partial"
    readonly document: VisualizationDocument
    readonly diagnostics: ReadonlyArray<VisualizerDiagnostic>
  }
  | {
    readonly status: "error"
    readonly error: unknown
  }

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

const renderError = (root: HTMLElement, error: unknown): void => {
  const shell = document.createElement("main")
  shell.className = "failure-shell"
  shell.setAttribute("role", "alert")
  const kind = document.createElement("span")
  kind.className = "failure-kind"
  kind.textContent = "Visualizer error"
  const title = document.createElement("h1")
  title.textContent = "Machine could not be inspected"
  const message = document.createElement("pre")
  message.textContent = errorMessage(error)
  const hint = document.createElement("p")
  hint.textContent = "Fix the machine definition and the page will reload."
  shell.append(kind, title, message, hint)
  root.replaceChildren(shell)
}

export const mountVisualizer = (root: HTMLElement, source: VisualizerSource): void => {
  switch (source.status) {
    case "ready":
      renderVisualizer(root, source.document)
      break
    case "partial":
      renderVisualizer(root, source.document, source.diagnostics)
      break
    case "error":
      renderError(root, source.error)
      break
  }
}
