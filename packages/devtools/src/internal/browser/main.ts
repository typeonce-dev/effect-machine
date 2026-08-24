import "./styles.css"
import * as DevToolsProtocol from "../../DevToolsProtocol.js"
import * as MachineDocument from "../../MachineDocument.js"
import { machine, snapshot } from "./example-machine.js"
import { mountVisualizer } from "./visualizer.js"

const root = document.querySelector<HTMLDivElement>("#app")
if (root === null) throw new Error("Visualizer root element was not found")

let source: DevToolsProtocol.MachineResult
try {
  source = {
    _tag: "Ready",
    protocolVersion: DevToolsProtocol.protocolVersion,
    key: "example-machine#machine",
    document: MachineDocument.make(machine, { snapshot }),
    diagnostics: []
  }
} catch (error) {
  source = {
    _tag: "Failed",
    protocolVersion: DevToolsProtocol.protocolVersion,
    key: "example-machine#machine",
    source: { file: "example-machine.ts", exportName: "machine" },
    machineId: null,
    diagnostics: [{
      severity: "error",
      code: "inspection-failed",
      message: error instanceof Error ? error.message : String(error),
      location: null,
      statePath: null
    }]
  }
}

mountVisualizer(root, source)
