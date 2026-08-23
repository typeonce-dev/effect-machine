import "./styles.css"
import { Machine } from "../../src/index.js"
import { machine, snapshot } from "./example-machine.js"
import { type TreeItem, type TreeItemKind, visualizationDocumentToTextTree } from "./text-tree.js"
import { makeVisualizationDocument } from "./visualization-document.js"

const buildDocument = makeVisualizationDocument<typeof machine, typeof snapshot>(Machine)
const visualization = buildDocument(machine, snapshot)
const tree = visualizationDocumentToTextTree(visualization)
const root = document.querySelector<HTMLDivElement>("#app")
if (root === null) throw new Error("Visualizer root element was not found")

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

const detailTitle = createElement("h2", "detail-title", "Select a line")
const detailKind = createElement("span", "detail-kind", "Details")
const detailList = createElement("dl", "detail-list")
const clearSelectionButton = createElement("button", "secondary-button", "Clear selection")
clearSelectionButton.type = "button"
clearSelectionButton.disabled = true

const clearSelection = (): void => {
  document.querySelectorAll(".is-selected").forEach((element) => element.classList.remove("is-selected"))
  detailTitle.textContent = "Select a line"
  detailKind.textContent = "Details"
  detailList.replaceChildren()
  clearSelectionButton.disabled = true
}

clearSelectionButton.addEventListener("click", clearSelection)

const selectItem = (item: TreeItem, selection: HTMLElement): void => {
  document.querySelectorAll(".is-selected").forEach((element) => element.classList.remove("is-selected"))
  selection.classList.add("is-selected")
  clearSelectionButton.disabled = false
  detailTitle.textContent = item.label
  detailKind.textContent = item.kind
  detailList.replaceChildren()
  for (const detail of item.details) {
    detailList.append(createElement("dt", undefined, detail.label), createElement("dd", undefined, detail.value))
  }
}

const connector = (kind: TreeItemKind, isLast: boolean): string => {
  if (kind === "branch") return isLast ? "└┄" : "├┄"
  return isLast ? "└─" : "├─"
}

const renderRow = (item: TreeItem, prefix: string, isLast: boolean): HTMLElement => {
  const line = `${prefix}${connector(item.kind, isLast)} ${item.label}`

  if (item.children.length > 0) {
    const disclosure = createElement("details", "tree-item")
    disclosure.open = true
    const summary = createElement("summary", "tree-row")
    summary.append(createElement("span", "tree-line", line))
    summary.addEventListener("click", () => selectItem(item, disclosure))
    disclosure.append(summary)
    const childPrefix = `${prefix}   `
    item.children.forEach((child, index) => {
      disclosure.append(renderRow(child, childPrefix, index === item.children.length - 1))
    })
    return disclosure
  }

  const row = createElement("button", "tree-row tree-leaf")
  row.type = "button"
  row.append(createElement("span", "tree-marker", ""), createElement("span", "tree-line", line))
  row.addEventListener("click", () => selectItem(item, row))
  return row
}

const setAllDisclosures = (open: boolean): void => {
  document.querySelectorAll<HTMLDetailsElement>(".tree-item").forEach((item) => {
    item.open = open
  })
}

const shell = createElement("main", "app-shell")
const toolbar = createElement("div", "toolbar")
const actions = createElement("div", "toolbar-actions")
const expandButton = createElement("button", "secondary-button", "Expand all")
expandButton.type = "button"
expandButton.addEventListener("click", () => setAllDisclosures(true))
const collapseButton = createElement("button", "secondary-button", "Collapse all")
collapseButton.type = "button"
collapseButton.addEventListener("click", () => setAllDisclosures(false))
actions.append(clearSelectionButton, expandButton, collapseButton)
toolbar.append(actions)

const workspace = createElement("section", "workspace")
const treePanel = createElement("section", "panel tree-panel")
treePanel.setAttribute("aria-label", `${tree.machineId} text tree`)
const treeBody = createElement("div", "tree", tree.machineId)
treeBody.setAttribute("role", "tree")
treeBody.append(createElement("div", "tree-legend", tree.legend), createElement("div", "tree-spacer", ""))
tree.roots.forEach((item, index) => treeBody.append(renderRow(item, "", index === tree.roots.length - 1)))
if (tree.candidateEvents !== undefined) {
  const candidates = tree.candidateEvents.length === 0 ? "none" : tree.candidateEvents.join(", ")
  treeBody.append(
    createElement("div", "candidate-events", `Candidate events: ${candidates}`)
  )
}
treePanel.append(toolbar, treeBody)

const detailPanel = createElement("aside", "panel detail-panel")
const detailHeader = createElement("div", "detail-header")
detailHeader.append(detailKind, detailTitle)
detailPanel.append(detailHeader, detailList)
workspace.append(treePanel, detailPanel)

shell.append(workspace)
root.append(shell)
