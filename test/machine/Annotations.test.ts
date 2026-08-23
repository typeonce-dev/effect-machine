import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { Machine } from "../../src/index.js"

class Workflow extends Schema.TaggedClass<Workflow>("Workflow")("Workflow", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {}

const AnnotatedWorkflow = Workflow.annotate({
  title: "Document workflow",
  description: "Coordinates the document lifecycle",
  documentation: "https://example.test/docs/workflow",
  designOwner: "editor-platform"
})

const AnnotatedIdle = Idle.annotate({
  title: "Waiting for edits",
  description: "No persistence work is active"
})

const States = Machine.states({
  Workflow: {
    schema: AnnotatedWorkflow,
    initial: "Idle",
    states: {
      Idle: AnnotatedIdle,
      Routing: {
        type: "choice",
        annotations: {
          title: "Select persistence route",
          description: "Routes according to the current document"
        }
      },
      Recent: {
        type: "history",
        history: "deep",
        annotations: {
          title: "Previous workflow state",
          documentation: "https://example.test/docs/history"
        }
      },
      Done
    }
  }
})

const machine = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: (to) =>
    to.Workflow.initial.resolve(({ target }) =>
      target.decoded(new Workflow({}), (workflow) => workflow.Idle.decoded(new Idle({})))
    )
})

describe("Machine state annotations", () => {
  it("resolves complete Effect Schema annotations for active state nodes", () => {
    const nodes = new Map(Machine.stateNodes(machine).map((node) => [node.path, node]))

    const workflow = nodes.get("Workflow")
    assert.strictEqual(workflow?.annotations?.title, "Document workflow")
    assert.strictEqual(workflow?.annotations?.description, "Coordinates the document lifecycle")
    assert.strictEqual(workflow?.annotations?.documentation, "https://example.test/docs/workflow")
    assert.strictEqual(workflow?.annotations?.designOwner, "editor-platform")

    const idle = nodes.get("Workflow.Idle")
    assert.strictEqual(idle?.annotations?.title, "Waiting for edits")
    assert.strictEqual(idle?.annotations?.description, "No persistence work is active")

    assert.strictEqual(nodes.get("Workflow.Done")?.annotations?.title, undefined)
  })

  it("carries descriptive choice and history annotations without changing topology", () => {
    const nodes = new Map(Machine.stateNodes(machine).map((node) => [node.path, node]))
    const choice = nodes.get("Workflow.Routing")
    const history = nodes.get("Workflow.Recent")

    assert.deepStrictEqual(choice?.annotations, {
      title: "Select persistence route",
      description: "Routes according to the current document"
    })
    assert.strictEqual(choice?.type, "choice")
    assert.strictEqual(choice?.schema, undefined)

    assert.deepStrictEqual(history?.annotations, {
      title: "Previous workflow state",
      documentation: "https://example.test/docs/history"
    })
    assert.strictEqual(history?.type, "history")
    assert.strictEqual(history?.history, "deep")
    assert.strictEqual(history?.schema, undefined)
    assert.deepStrictEqual(nodes.get("Workflow")?.children, ["Workflow.Idle", "Workflow.Done"])
  })
})
