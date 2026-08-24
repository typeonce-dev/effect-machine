import { assert, describe, it } from "@effect/vitest"
import * as DevToolsProtocol from "../src/DevToolsProtocol.js"
import { machine } from "../src/internal/browser/example-machine.js"
import { reconcile } from "../src/internal/machineRegistry.js"
import * as MachineDocument from "../src/MachineDocument.js"

describe("MachineRegistry", () => {
  it("keeps the last valid document when a reload fails", () => {
    const document = MachineDocument.make(machine, {
      source: { file: "src/workflow.ts", exportName: "workflow" }
    })
    const ready: DevToolsProtocol.Ready = {
      _tag: "Ready",
      protocolVersion: 1,
      key: "src/workflow.ts#workflow",
      document,
      diagnostics: []
    }
    const failed: DevToolsProtocol.Failed = {
      _tag: "Failed",
      protocolVersion: 1,
      key: ready.key,
      source: { file: "src/workflow.ts", exportName: "workflow" },
      machineId: null,
      diagnostics: [{
        severity: "error",
        code: "module-load-failed",
        message: "Unexpected end of input",
        location: { file: "src/workflow.ts", line: null, column: null },
        statePath: null
      }]
    }

    const result = reconcile([ready], [failed])[0]
    assert.strictEqual(result?._tag, "Partial")
    if (result?._tag === "Partial") {
      assert.strictEqual(result.document, document)
      assert.deepStrictEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
        "stale-document",
        "module-load-failed"
      ])
    }
  })
})
