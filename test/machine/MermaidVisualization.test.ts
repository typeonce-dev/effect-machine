import { assert, describe, it } from "@effect/vitest"
import { makeMermaidRenderer } from "./visualization/mermaid.js"
import type { InspectionApi, StateNode } from "./visualization/model.js"

interface TestMachine {
  readonly id: string | undefined
}

const states: ReadonlyArray<StateNode> = [
  {
    path: "Root",
    key: "Root",
    annotations: { title: "Quoted \"root\" %%" },
    type: "compound",
    history: undefined,
    parent: undefined,
    children: ["Root.Route", "Root.Done"],
    initial: "Root.Route"
  },
  {
    path: "Root.Route",
    key: "Route",
    annotations: { title: "Choose\nroute" },
    type: "choice",
    history: undefined,
    parent: "Root",
    children: [],
    initial: undefined
  },
  {
    path: "Root.Done",
    key: "Done",
    annotations: undefined,
    type: "final",
    history: undefined,
    parent: "Root",
    children: [],
    initial: undefined
  }
]

const inspection: InspectionApi<TestMachine, { readonly active: boolean }> = {
  stateNodes: () => states,
  initialDefinition: () => ({ target: "Root" }),
  transitionDefinitions: () => [
    {
      source: "Root.Route",
      trigger: { type: "choice" },
      reenter: false,
      acceptance: "required",
      branches: [
        { type: "branch", key: "approved", title: "approved %%\nnow", target: "Root.Done" },
        { type: "branch", key: "unchanged", title: "unchanged", target: undefined }
      ]
    },
    {
      source: "Root.Done",
      trigger: { type: "event", event: "Retry" },
      reenter: false,
      acceptance: "declinable",
      branches: [{ type: "direct", target: "Root.Route" }]
    }
  ],
  activityDefinitions: () => [{ source: "Root.Route", id: "worker %%\nend note", type: "process" }],
  configuration: () => states.slice(0, 2),
  enabled: () => ["Continue %%\nnow"]
}

const render = makeMermaidRenderer<TestMachine, { readonly active: boolean }>(inspection)

describe("Mermaid visualization", () => {
  it("uses safe ids and escapes user-controlled labels without losing topology", () => {
    const rendered = render({ id: "Unsafe %%\nMachine" }, { active: true })

    assert.notInclude(rendered, "%%")
    assert.include(rendered, "accTitle: Unsafe #37;#37; Machine")
    assert.include(rendered, "state \"● Quoted #quot;root#quot; #37;#37; (Root)\" as state_0")
    assert.include(rendered, "state \"● Choose route (Route)\" as state_1")
    assert.include(rendered, "state state_1 <<choice>>")
    assert.include(rendered, "state_1 --> state_2: choice [approved #37;#37; now]")
    assert.include(rendered, "state_2 --> state_1: Retry [declinable]")
    assert.notMatch(rendered, /state_1 --> .*otherwise/)
    assert.include(rendered, "state_1: process / worker #37;#37; end note")
    assert.notInclude(rendered, "Candidate events")
  })
})
