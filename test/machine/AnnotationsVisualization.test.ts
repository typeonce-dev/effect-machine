import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { Machine } from "../../src/index.js"
import { makeTextRenderer } from "./visualization/text.js"

class Workflow extends Schema.TaggedClass<Workflow>("Workflow")("Workflow", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {}

const AnnotatedWorkflow = Workflow.annotate({ title: "Document workflow" })
const AnnotatedIdle = Idle.annotate({ title: "Waiting for edits" })

const States = Machine.defineStates({
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
})

const machine = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: {
    target: (to) => to.Workflow.initial(),
    resolve: ({ target }) => target(new Workflow({}), (workflow) => workflow.Idle(new Idle({})))
  }
})

const renderMachine = makeTextRenderer<
  typeof machine,
  Machine.Machine.Snapshot<typeof States.states>
>(Machine)

describe("Machine annotation visualization", () => {
  it("uses titles for active, choice, and history display while preserving structural keys", () => {
    assert.strictEqual(
      renderMachine(machine),
      [
        "Machine",
        "● active  ○ inactive  ◇ transition (→ target, ∅ none)",
        "",
        "└─ ○ Document workflow (Workflow) [compound, initial: Idle]",
        "   ├─ ○ Waiting for edits (Idle)",
        "   ├─ ○ Select persistence route (Routing) [choice]",
        "   ├─ ○ Previous workflow state (Recent) [history, deep]",
        "   └─ ○ Done"
      ].join("\n")
    )
  })
})
