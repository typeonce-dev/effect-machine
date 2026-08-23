import "./styles.css"
import { Machine } from "../../src/index.js"
import { machine, snapshot } from "./example-machine.js"
import { makeVisualizationDocument } from "./visualization-document.js"
import { renderVisualizer } from "./visualizer-app.js"

const buildDocument = makeVisualizationDocument<typeof machine, typeof snapshot>(Machine)
const visualization = buildDocument(machine, snapshot)
const root = document.querySelector<HTMLDivElement>("#app")
if (root === null) throw new Error("Visualizer root element was not found")

renderVisualizer(root, visualization)
