import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import * as DevToolsProtocol from "../src/DevToolsProtocol.js"
import { machine, snapshot } from "../src/internal/browser/example-machine.js"
import * as MachineDocument from "../src/MachineDocument.js"

describe("MachineDocument", () => {
  it("captures and validates a versioned machine document", () => {
    const document = MachineDocument.make(machine, {
      revision: 3,
      source: { file: "/project/src/workflow.ts", exportName: "workflow" },
      snapshot
    })

    assert.strictEqual(document.schemaVersion, 1)
    assert.strictEqual(document.revision, 3)
    assert.deepStrictEqual(document.source, {
      file: "/project/src/workflow.ts",
      exportName: "workflow"
    })
    assert.deepStrictEqual(Schema.decodeUnknownSync(MachineDocument.MachineDocument)(document), document)
  })

  it("validates ready, partial, and failed evaluation results", () => {
    const document = MachineDocument.make(machine)
    const diagnostic: DevToolsProtocol.Diagnostic = {
      severity: "warning",
      code: "stale-document",
      message: "The last valid document is shown.",
      location: null,
      statePath: null
    }
    const results: ReadonlyArray<DevToolsProtocol.MachineResult> = [
      {
        _tag: "Ready",
        protocolVersion: 1,
        key: "workflow.ts#workflow",
        document,
        diagnostics: []
      },
      {
        _tag: "Partial",
        protocolVersion: 1,
        key: "workflow.ts#workflow",
        document,
        diagnostics: [diagnostic]
      },
      {
        _tag: "Failed",
        protocolVersion: 1,
        key: "broken.ts#machine",
        source: { file: "broken.ts", exportName: "machine" },
        machineId: null,
        diagnostics: [{ ...diagnostic, severity: "error" }]
      }
    ]

    results.forEach((result) => {
      assert.deepStrictEqual(Schema.decodeUnknownSync(DevToolsProtocol.MachineResult)(result), result)
    })
  })
})
