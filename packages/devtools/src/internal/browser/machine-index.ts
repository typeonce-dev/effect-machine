import type { MachineResult, RegistrySnapshot } from "../../DevToolsProtocol.js"
import { mountVisualizer } from "./visualizer.js"

let selectedKey: string | undefined

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

const resultLabel = (result: MachineResult): string => {
  if (result._tag === "Ready" || result._tag === "Partial") return result.document.machineId
  return result.machineId ?? result.source.exportName ?? result.source.file.split(/[\\/]/).at(-1) ?? result.key
}

const resultFile = (result: MachineResult): string =>
  result._tag === "Ready" || result._tag === "Partial"
    ? result.document.source?.file ?? "unknown source"
    : result.source.file

const statusLabel = (result: MachineResult): string => {
  switch (result._tag) {
    case "Ready":
      return "ready"
    case "Partial":
      return "partial"
    case "Failed":
      return "error"
  }
}

export const mountMachineIndex = (root: HTMLElement, snapshot: RegistrySnapshot): void => {
  const results = [...snapshot.results].sort((left, right) => resultLabel(left).localeCompare(resultLabel(right)))
  if (selectedKey === undefined || !results.some((result) => result.key === selectedKey)) {
    selectedKey = results[0]?.key
  }

  const shell = createElement("main", "devtools-shell")
  const index = createElement("nav", "machine-index")
  index.setAttribute("aria-label", "Machines")
  const view = createElement("div", "machine-view")

  if (results.length === 0) {
    index.append(createElement("div", "machine-index-empty", "No machines"))
    const empty = createElement("div", "registry-empty")
    empty.append(
      createElement("strong", undefined, "No .handle machines found"),
      createElement("span", undefined, "The list updates when a matching source file changes.")
    )
    view.append(empty)
  } else {
    for (const result of results) {
      const button = createElement("button", `machine-row${result.key === selectedKey ? " is-selected" : ""}`)
      button.type = "button"
      button.dataset.machineKey = result.key
      button.setAttribute("aria-current", result.key === selectedKey ? "true" : "false")
      const label = createElement("span", "machine-row-label", resultLabel(result))
      const file = createElement("span", "machine-row-file", resultFile(result))
      const status = createElement("span", `machine-row-status status-${statusLabel(result)}`)
      status.setAttribute("aria-label", statusLabel(result))
      button.append(status, label, file)
      button.addEventListener("click", () => {
        selectedKey = result.key
        mountMachineIndex(root, snapshot)
      })
      index.append(button)
    }

    const selected = results.find((result) => result.key === selectedKey) ?? results[0]
    if (selected !== undefined) mountVisualizer(view, selected)
  }

  shell.append(index, view)
  root.replaceChildren(shell)
}
