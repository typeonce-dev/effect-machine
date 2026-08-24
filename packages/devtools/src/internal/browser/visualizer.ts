import type { MachineResult } from "../../DevToolsProtocol.js"
import { renderVisualizer } from "./visualizer-app.js"

const renderError = (root: HTMLElement, source: Extract<MachineResult, { readonly _tag: "Failed" }>): void => {
  const shell = document.createElement("main")
  shell.className = "failure-shell"
  shell.setAttribute("role", "alert")
  const kind = document.createElement("span")
  kind.className = "failure-kind"
  kind.textContent = "Visualizer error"
  const title = document.createElement("h1")
  title.textContent = "Machine could not be inspected"
  const message = document.createElement("pre")
  message.textContent = source.diagnostics.map((diagnostic) => diagnostic.message).join("\n")
  const hint = document.createElement("p")
  hint.textContent = "Fix the machine definition and the page will reload."
  shell.append(kind, title, message, hint)
  root.replaceChildren(shell)
}

export const mountVisualizer = (root: HTMLElement, source: MachineResult): void => {
  switch (source._tag) {
    case "Ready":
    case "Partial":
      renderVisualizer(root, source.key, source.document, source.diagnostics)
      break
    case "Failed":
      renderError(root, source)
      break
  }
}
