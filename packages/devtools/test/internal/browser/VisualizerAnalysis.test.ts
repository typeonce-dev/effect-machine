import { assert, describe, it } from "@effect/vitest"
import { transitionSemanticsMachine } from "../../../src/internal/browser/transition-semantics-example.js"
import { analyzeVisualization } from "../../../src/internal/browser/visualizer-analysis.js"
import * as MachineDocument from "../../../src/MachineDocument.js"

describe("Visualizer analysis", () => {
  it("reports declared public events without a registered handler", () => {
    const analysis = analyzeVisualization(MachineDocument.make(transitionSemanticsMachine))

    assert.deepStrictEqual(analysis.warnings, [{
      _tag: "UnhandledPublicEvent",
      event: "Archive"
    }])
  })

  it("reports the roots of isolated topology without repeating their descendants", () => {
    const document = MachineDocument.make(transitionSemanticsMachine)
    const disabled = document.states.find(({ path }) => path === "Disabled")!
    const analysis = analyzeVisualization({
      ...document,
      states: [
        ...document.states.map((state) =>
          state.path === "Disabled"
            ? { ...state, type: "compound" as const, children: ["Disabled.Offline"] }
            : state
        ),
        {
          ...disabled,
          path: "Disabled.Offline",
          key: "Offline",
          order: 0,
          parent: "Disabled",
          children: [],
          transitionIds: [],
          activityIds: []
        }
      ]
    })

    assert.deepStrictEqual(analysis.topologyNotes, [{
      _tag: "NoStaticPathFromInitial",
      path: "Disabled",
      label: "Disabled",
      type: "compound",
      descendantCount: 1
    }])
  })

  it("does not confuse an event handled by an isolated state with an unregistered event", () => {
    const document = MachineDocument.make(transitionSemanticsMachine)
    const archive = document.inputs.events.find(({ event }) => event === "Archive")!
    const analysis = analyzeVisualization({
      ...document,
      inputs: { ...document.inputs, events: [archive] },
      transitions: [{
        id: "Disabled:transition:0",
        source: "Disabled",
        trigger: { type: "event", event: "Archive" },
        reenter: false,
        acceptance: "required",
        branches: []
      }]
    })

    assert.deepStrictEqual(analysis.warnings, [])
  })
})
