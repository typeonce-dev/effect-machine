import { assert, describe, it } from "@effect/vitest"
import { Machine } from "../../src/index.js"
import { machine, snapshot } from "../../visualizer/src/example-machine.js"
import { textTreeToString } from "../../visualizer/src/text-tree.js"
import { makeVisualizationDocument } from "../../visualizer/src/visualization-document.js"
import { makeTextRenderer } from "./visualization/text.js"

const renderText = makeTextRenderer<typeof machine, typeof snapshot>(Machine)
const buildDocument = makeVisualizationDocument<typeof machine, typeof snapshot>(Machine)

describe("Interactive text visualization", () => {
  it("captures ordered serializable machine information", () => {
    const document = buildDocument(machine, snapshot)
    const idle = document.states.find((state) => state.path === "application.workflow.idle")

    assert.deepStrictEqual(document.initial, {
      target: "application",
      selection: { path: "application", kind: "initial", scope: "initial" }
    })
    assert.deepStrictEqual(document.roots, ["application", "disabled"])
    assert.deepStrictEqual(idle?.transitionIds, [
      "application.workflow.idle:transition:0",
      "application.workflow.idle:transition:1"
    ])
    assert.deepStrictEqual(document.transitions[0], {
      id: "application.workflow.idle:transition:0",
      source: "application.workflow.idle",
      trigger: { type: "event", event: "Start" },
      reenter: false,
      acceptance: "required",
      branches: [{
        id: "application.workflow.idle:transition:0:branch:0",
        type: "direct",
        target: "application.workflow.running",
        selection: { path: "application.workflow.running", kind: "state", scope: "local" },
        updates: ["application.workflow"]
      }]
    })
    assert.deepStrictEqual(
      document.states.find((state) => state.path === "application.workflow")?.children,
      [
        "application.workflow.idle",
        "application.workflow.running",
        "application.workflow.recent"
      ]
    )
    assert.deepStrictEqual(document.snapshot, {
      activePaths: [
        "application",
        "application.workflow",
        "application.workflow.idle",
        "application.connection",
        "application.connection.online"
      ],
      candidateEvents: ["Start", "Refresh", "Disconnect"]
    })
    assert.deepStrictEqual(JSON.parse(JSON.stringify(document)), document)
    assert.strictEqual(buildDocument(machine).snapshot, null)
  })

  it("preserves the static text renderer output", () => {
    assert.strictEqual(textTreeToString(buildDocument(machine, snapshot)), renderText(machine, snapshot))
  })
})
