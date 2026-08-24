import "./styles.css"
import { Machine } from "@typeonce/effect-machine"
import { machine, snapshot } from "./example-machine.js"
import { makeVisualizationDocument } from "./visualization-document.js"
import { mountVisualizer, type VisualizerSource } from "./visualizer.js"

const buildDocument = makeVisualizationDocument<typeof machine, typeof snapshot>(Machine)
const root = document.querySelector<HTMLDivElement>("#app")
if (root === null) throw new Error("Visualizer root element was not found")

let source: VisualizerSource
try {
  source = { status: "ready", document: buildDocument(machine, snapshot) }
} catch (error) {
  source = { status: "error", error }
}

mountVisualizer(root, source)
