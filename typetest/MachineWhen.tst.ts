import { Context, Data, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../src/index.js"

class Workspace extends Schema.TaggedClass<Workspace>("WhenTypeWorkspace")("Workspace", {}) {}
class Editing extends Schema.TaggedClass<Editing>("WhenTypeEditing")("Editing", {
  dirty: Schema.Boolean
}) {}
class ConfirmClose extends Schema.TaggedClass<ConfirmClose>("WhenTypeConfirmClose")("ConfirmClose", {}) {}
class Closed extends Schema.TaggedClass<Closed>("WhenTypeClosed")("Closed", {}) {}
class Close extends Schema.TaggedClass<Close>("WhenTypeClose")("Close", {}) {}

const States = Machine.defineStates({
  Workspace: {
    schema: Workspace,
    initial: "Editing",
    states: {
      Editing,
      ConfirmClose
    }
  },
  Closed
})

const base = Machine.make({
  states: States.states,
  events: [Close],
  initial: () =>
    States.initial.Workspace(
      new Workspace({}),
      (workspace) => workspace.Editing(new Editing({ dirty: false }))
    )
})

describe("Machine transition conditions", () => {
  it("exposes a read-only eligibility context and typed transition context", () => {
    const complete = base.handle({
      Workspace: {
        states: {
          Editing: {
            on: {
              Close: {
                when: (context) => {
                  expect(context.state).type.toBe<Editing>()
                  expect(context.parent).type.toBe<Workspace>()
                  expect(context.parents.Workspace).type.toBe<Workspace>()
                  expect(context.event).type.toBe<Close>()
                  expect(context.snapshot).type.toBe<Machine.Machine.Snapshot<typeof States.states>>()
                  expect(context).type.not.toHaveProperty("target")
                  expect(context).type.not.toHaveProperty("runtime")
                  expect(context).type.not.toHaveProperty("raise")
                  expect(context).type.not.toHaveProperty("emit")
                  return context.state.dirty
                },
                transition: ({ target }) => target.local.ConfirmClose(new ConfirmClose({}))
              }
            }
          }
        }
      }
    })

    expect(Machine.plan).type.toBeCallableWith(
      complete,
      States.initial.Workspace(
        new Workspace({}),
        (workspace) => workspace.Editing(new Editing({ dirty: false }))
      ),
      new Close({})
    )
  })

  it("preserves Effect errors and services contributed by when", () => {
    class Eligibility extends Context.Service<Eligibility, boolean>()("types/when/Eligibility") {}
    class EligibilityError extends Data.TaggedError("EligibilityError")<{}> {}
    const complete = base.handle({
      Workspace: {
        states: {
          Editing: {
            on: {
              Close: {
                when: Effect.fn(function*() {
                  const eligible = yield* Eligibility
                  if (Math.random() > 2) return yield* new EligibilityError()
                  return eligible
                }),
                transition: ({ target }) => target.local.ConfirmClose(new ConfirmClose({}))
              }
            }
          }
        }
      }
    })

    expect<Machine.Machine.Error<typeof complete>>().type.toBe<EligibilityError>()
    expect<Machine.Machine.Services<typeof complete>>().type.toBe<Eligibility>()
  })

  it("rejects non-boolean predicates and keeps when event-only", () => {
    expect(base.handle).type.not.toBeCallableWith({
      Workspace: {
        states: {
          Editing: {
            on: {
              Close: {
                when: () => "yes",
                transition: () => undefined
              }
            }
          }
        }
      }
    })

    expect(base.handle).type.not.toBeCallableWith({
      Workspace: {
        always: {
          when: () => true,
          transition: () => undefined
        }
      }
    })

    expect(base.handle).type.not.toBeCallableWith({
      Workspace: {
        onDone: {
          when: () => true,
          transition: () => undefined
        }
      }
    })
  })

  it("keeps declared-target validation for conditional transitions", () => {
    const target = base.makeTargetBuilder("Workspace.Editing")
    expect(base.handle).type.not.toBeCallableWith({
      Workspace: {
        states: {
          Editing: {
            on: {
              Close: {
                when: () => true,
                targets: ["Closed"],
                transition: () => target.local.ConfirmClose(new ConfirmClose({}))
              }
            }
          }
        }
      }
    })
  })
})
