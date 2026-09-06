import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { Machine } from "../../src/index.js"
import { makeMermaidRenderer } from "./visualization/mermaid.js"
import { makeTextRenderer } from "./visualization/text.js"

class Workflow extends Schema.TaggedClass<Workflow>("Workflow")("Workflow", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {}

const AnnotatedWorkflow = Workflow.annotate({ title: "Document workflow" })
const AnnotatedIdle = Idle.annotate({ title: "Waiting for edits" })

const States = Machine.state({
  initial: "Workflow",
  states: {
    Workflow: {
      schema: AnnotatedWorkflow,
      initial: "Idle",
      states: {
        Idle: AnnotatedIdle,
        Routing: {
          type: "choice",
          annotations: { title: "Select persistence route" }
        },
        Recent: {
          type: "history",
          history: "deep",
          annotations: { title: "Previous workflow state" }
        },
        Done
      }
    }
  }
})

const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) => to.Workflow.decoded(new Workflow({}), (workflow) => workflow.Idle.decoded(new Idle({}))))
    )
})

const renderMachine = makeTextRenderer<
  typeof machine,
  Machine.Snapshot<typeof States>
>(Machine)
const renderMermaid = makeMermaidRenderer<
  typeof machine,
  Machine.Snapshot<typeof States>
>(Machine)

describe("Machine annotation visualization", () => {
  it("uses titles for active, choice, and history display while preserving structural keys", () => {
    assert.strictEqual(
      renderMachine(machine),
      [
        "Machine",
        "● active  ○ inactive  ◇ transition  ┄ branch → target",
        "",
        "└─ ○ (root) [compound, initial: Workflow]",
        "   └─ ○ Document workflow (Workflow) [compound, initial: Idle]",
        "      ├─ ○ Waiting for edits (Idle)",
        "      ├─ ○ Select persistence route (Routing) [choice]",
        "      ├─ ○ Previous workflow state (Recent) [history, deep]",
        "      └─ ○ Done"
      ].join("\n")
    )
  })

  it("renders titled choice, history, and final states as Mermaid", () => {
    const rendered = renderMermaid(machine)

    assert.include(rendered, "state \"○ Document workflow (Workflow)\" as state_1")
    assert.include(rendered, "state \"○ Select persistence route (Routing)\" as state_3")
    assert.include(rendered, "state state_3 <<choice>>")
    assert.include(rendered, "state \"○ Previous workflow state (Recent) [history: deep]\" as state_4")
    assert.include(rendered, "state \"○ Done\" as state_5")
  })
})
