import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Workflow extends Schema.TaggedClass<Workflow>("Workflow")("Workflow", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}

const AnnotatedWorkflow = Workflow.annotate({
  title: "Document workflow",
  description: "Coordinates the document lifecycle",
  documentation: "https://example.test/docs/workflow",
  designOwner: "editor-platform"
})

const States = Machine.defineStates({
  Workflow: {
    schema: AnnotatedWorkflow,
    initial: "Idle",
    states: {
      Idle,
      Routing: {
        type: "choice",
        annotations: {
          title: "Select persistence route",
          description: "Routes according to the current document"
        }
      },
      Recent: {
        type: "history",
        annotations: {
          title: "Previous workflow state",
          documentation: "https://example.test/docs/history"
        }
      }
    }
  }
})

const machine = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: {
    target: (to) => to.Workflow.initial(),
    resolve: ({ target }) => (target(new Workflow({}), (workflow) => workflow.Idle(new Idle({}))))
  }
})

describe("Machine state annotations", () => {
  it("exposes typed resolved annotations on every state node", () => {
    const node = Machine.stateNodes(machine)[0]!
    expect(node.annotations).type.toBe<Readonly<Machine.Machine.StateNodeAnnotations> | undefined>()
    expect(node.annotations?.title).type.toBe<string | undefined>()
    expect(node.annotations?.description).type.toBe<string | undefined>()
    expect(node.annotations?.documentation).type.toBe<string | undefined>()
    expect(node.annotations?.designOwner).type.toBe<unknown>()
  })

  it("limits pseudo-state annotations to descriptive metadata", () => {
    expect(Machine.defineStates).type.not.toBeCallableWith({
      Workflow: {
        schema: Workflow,
        initial: "Idle",
        states: {
          Idle,
          Invalid: { type: "choice", annotations: { arbitrary: () => 1 } }
        }
      }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      Workflow: {
        schema: Workflow,
        initial: "Idle",
        states: {
          Idle,
          Invalid: { type: "history", annotations: { title: () => "Executable" } }
        }
      }
    })
  })

  it("keeps schema-backed APIs unavailable to annotated pseudo-states", () => {
    expect(Machine.defineStates).type.not.toBeCallableWith({
      Workflow: {
        schema: Workflow,
        initial: "Idle",
        states: {
          Idle,
          Invalid: {
            type: "choice",
            schema: Idle,
            annotations: { title: "Still a pseudo-state" }
          }
        }
      }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      Workflow: {
        schema: Workflow,
        initial: "Idle",
        states: {
          Idle,
          Invalid: {
            type: "history",
            states: { Idle },
            annotations: { title: "Still a pseudo-state" }
          }
        }
      }
    })
  })
})
