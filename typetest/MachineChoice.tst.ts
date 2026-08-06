import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../src/index.js"

class Editing extends Schema.TaggedClass<Editing>("Editing")("Editing", { valid: Schema.Boolean }) {}
class Accepted extends Schema.TaggedClass<Accepted>("Accepted")("Accepted", {}) {}
class Rejected extends Schema.TaggedClass<Rejected>("Rejected")("Rejected", {}) {}
class Submit extends Schema.TaggedClass<Submit>("Submit")("Submit", {}) {}

const States = Machine.defineStates({
  editing: Editing,
  validate: { type: "choice" },
  accepted: Accepted,
  rejected: Rejected
})

describe("Machine choice states", () => {
  it("separates active and choice identifiers", () => {
    expect<Machine.Machine.StateIdentifier<typeof States.states>>().type.toBe<
      "editing" | "accepted" | "rejected"
    >()
    expect<Machine.Machine.ChoiceIdentifier<typeof States.states>>().type.toBe<"validate">()
    expect<Machine.Machine.StateNodeIdentifier<typeof States.states>>().type.toBe<
      "editing" | "validate" | "accepted" | "rejected"
    >()
    expect(States.initial).type.not.toHaveProperty("validate")
  })

  it("preserves source context and validates choice transitions", () => {
    const machine = Machine.make({
      states: States.states,
      events: [Submit],
      initial: () => States.initial.editing(new Editing({ valid: true }))
    })
    const target = machine.makeTargetBuilder("editing")
    const valid = {
      editing: {
        on: {
          Submit: {
            choice: "validate",
            targets: ["accepted", "rejected"],
            transition: ({ state, event, target }: Machine.Machine.HandlerContext<
              typeof States.states,
              readonly [typeof Submit],
              readonly [],
              "editing",
              "Submit",
              never,
              never
            >) => {
              expect(state).type.toBe<Editing>()
              expect(event).type.toBe<Submit>()
              return state.valid
                ? target.full.accepted(new Accepted({}))
                : target.full.rejected(new Rejected({}))
            }
          }
        }
      }
    } as const
    const effectful = {
      editing: {
        on: {
          Submit: {
            choice: "validate",
            targets: ["accepted"],
            transition: () => Effect.succeed(target.full.accepted(new Accepted({})))
          }
        }
      }
    } as const
    const missingTarget = {
      editing: {
        on: {
          Submit: {
            choice: "validate",
            transition: () => target.full.accepted(new Accepted({}))
          }
        }
      }
    } as const
    const emptyTargets = {
      editing: {
        on: {
          Submit: {
            choice: "validate",
            targets: [],
            transition: () => target.full.accepted(new Accepted({}))
          }
        }
      }
    } as const
    const noResult = {
      editing: {
        on: {
          Submit: {
            choice: "validate",
            targets: ["accepted"],
            transition: () => undefined
          }
        }
      }
    } as const
    const unknownChoice = {
      editing: {
        on: {
          Submit: {
            choice: "accepted",
            targets: ["accepted"],
            transition: () => target.full.accepted(new Accepted({}))
          }
        }
      }
    } as const

    expect(machine.handle).type.toBeCallableWith(valid)
    expect(machine.handle).type.toBeCallableWith(effectful)
    expect(machine.handle).type.not.toBeCallableWith(missingTarget)
    expect(machine.handle).type.not.toBeCallableWith(emptyTargets)
    expect(machine.handle).type.not.toBeCallableWith(noResult)
    expect(machine.handle).type.not.toBeCallableWith(unknownChoice)

    const definition = Machine.transitionDefinitions(machine.handle(valid))[0]!
    expect(definition.choice).type.toBe<"validate" | undefined>()
  })

  it("rejects active-state properties and initial selection", () => {
    expect(Machine.defineStates).type.not.toBeCallableWith({
      editing: Editing,
      validate: { type: "choice", schema: Accepted }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      root: {
        schema: Editing,
        initial: "validate",
        states: {
          editing: Editing,
          validate: { type: "choice" }
        }
      }
    })
  })
})
