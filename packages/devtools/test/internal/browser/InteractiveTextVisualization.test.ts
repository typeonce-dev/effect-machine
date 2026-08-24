import { assert, describe, it } from "@effect/vitest"
import { Machine } from "@typeonce/effect-machine"
import * as Schema from "effect/Schema"
import { makeTextRenderer } from "../../../../effect-machine/test/machine/visualization/text.js"
import { machine, snapshot } from "../../../src/internal/browser/example-machine.js"
import { projectInputSchema } from "../../../src/internal/browser/input-form.js"
import { plannerMachine } from "../../../src/internal/browser/planner-example.js"
import { textTreeToString } from "../../../src/internal/browser/text-tree.js"
import { makeVisualizerModel } from "../../../src/internal/browser/visualizer-model.js"
import * as MachineDocument from "../../../src/MachineDocument.js"

const renderText = makeTextRenderer<typeof machine, typeof snapshot>(Machine)
const buildDocument = () => MachineDocument.make(machine, { snapshot })

describe("Interactive text visualization", () => {
  it("captures ordered serializable machine information", () => {
    const document = buildDocument()
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
    assert.deepStrictEqual(Schema.decodeUnknownSync(MachineDocument.MachineDocument)(document), document)
    assert.strictEqual(MachineDocument.make(machine).snapshot, null)
  })

  it("preserves the static text renderer output", () => {
    assert.strictEqual(textTreeToString(buildDocument()), renderText(machine, snapshot))
  })

  it("projects a state-only topology and structured state inspection", () => {
    const model = makeVisualizerModel(buildDocument())
    const application = model.roots[0]
    const workflow = application?.children[0]
    const idle = workflow?.children[0]
    const inspection = idle === undefined ? undefined : model.inspectState(idle.path)

    assert.deepStrictEqual(
      model.roots.map((root) => root.path),
      ["application", "disabled"]
    )
    assert.strictEqual(application?.active, true)
    assert.strictEqual(application?.initial, true)
    assert.deepStrictEqual(
      workflow?.children.map((child) => child.path),
      ["application.workflow.idle", "application.workflow.running", "application.workflow.recent"]
    )
    assert.strictEqual(idle?.transitionCount, 2)
    assert.strictEqual(inspection?.outgoing.length, 2)
    assert.strictEqual(model.inspectState("application.workflow.running")?.incoming[0]?.transition.source, idle?.path)
    assert.deepStrictEqual(
      model.inspectEvent("Start").transitions.map((transition) => transition.source),
      ["application.workflow.idle"]
    )
    assert.strictEqual(model.inspectEvent("Start").candidate, true)
    assert.deepStrictEqual(
      inspection?.breadcrumbs.map((item) => item.path),
      ["application", "application.workflow", "application.workflow.idle"]
    )
  })

  it("accepts an empty partial topology", () => {
    const document = buildDocument()
    const model = makeVisualizerModel({
      ...document,
      roots: [],
      states: [],
      transitions: [],
      activities: [],
      snapshot: null
    })

    assert.deepStrictEqual(model.roots, [])
    assert.strictEqual(model.hasSnapshot, false)
    assert.strictEqual(model.inspectState("application"), undefined)
  })

  it("projects machine and event schemas into concrete form fields", () => {
    const document = MachineDocument.make(plannerMachine)
    const input = document.inputs.machine === null ? undefined : projectInputSchema(document.inputs.machine)
    const beginSchema = document.inputs.events.find(({ event }) => event === "Begin")?.schema
    const begin = beginSchema === undefined ? undefined : projectInputSchema(beginSchema)

    assert.deepStrictEqual(input, {
      _tag: "Object",
      title: undefined,
      description: undefined,
      fields: [{
        key: "owner",
        required: true,
        field: {
          _tag: "String",
          title: undefined,
          description: undefined,
          defaultValue: undefined,
          format: undefined,
          minLength: undefined,
          maxLength: undefined,
          pattern: undefined
        }
      }]
    })
    assert.strictEqual(begin?._tag, "Object")
    if (begin?._tag !== "Object") return
    assert.deepStrictEqual(begin.fields.map(({ key }) => key), ["_tag", "job", "priority"])
    assert.strictEqual(begin.fields[2]?.field._tag, "Enum")
  })
})
