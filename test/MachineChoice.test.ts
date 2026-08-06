import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import { Machine } from "../src/index.js"

class Editing extends Schema.TaggedClass<Editing>("Editing")("Editing", {
  valid: Schema.Boolean
}) {}
class Accepted extends Schema.TaggedClass<Accepted>("Accepted")("Accepted", {}) {}
class Rejected extends Schema.TaggedClass<Rejected>("Rejected")("Rejected", {}) {}
class Submit extends Schema.TaggedClass<Submit>("Submit")("Submit", {}) {}

const States = Machine.defineStates({
  editing: Editing,
  validate: { type: "choice" },
  accepted: Accepted,
  rejected: Rejected
})

const makeMachine = (valid: boolean) =>
  Machine.make({
    states: States.states,
    events: [Submit],
    initial: () => States.initial.editing(new Editing({ valid }))
  }).handle({
    editing: {
      on: {
        Submit: {
          choice: "validate",
          targets: ["accepted", "rejected"],
          transition: ({ state, target }) =>
            state.valid
              ? target.full.accepted(new Accepted({}))
              : target.full.rejected(new Rejected({}))
        }
      }
    }
  })

describe("Machine choice states", () => {
  it.effect("immediately redirects through a choice without activating it", () =>
    Effect.gen(function*() {
      const acceptedMachine = makeMachine(true)
      const rejectedMachine = makeMachine(false)
      const acceptedInitial = (yield* Machine.planInitial(acceptedMachine)).state
      const rejectedInitial = (yield* Machine.planInitial(rejectedMachine)).state

      const accepted = yield* Machine.plan(acceptedMachine, acceptedInitial, new Submit({}))
      const rejected = yield* Machine.plan(rejectedMachine, rejectedInitial, new Submit({}))

      assert.strictEqual(accepted.next.path, "accepted")
      assert.strictEqual(rejected.next.path, "rejected")
      assert.lengthOf(accepted.microsteps, 1)
      assert.deepStrictEqual(accepted.microsteps[0]?.exitPaths, ["editing"])
      assert.deepStrictEqual(accepted.microsteps[0]?.entryPaths, ["accepted"])
      assert.deepStrictEqual(Machine.configuration(acceptedMachine, accepted.next).map(({ path }) => path), [
        "accepted"
      ])
    }))

  it("exposes choices structurally and annotates the incoming transition", () => {
    const machine = makeMachine(true)

    assert.deepStrictEqual(Machine.stateNodes(machine).map(({ path, type }) => ({ path, type })), [
      { path: "editing", type: "atomic" },
      { path: "validate", type: "choice" },
      { path: "accepted", type: "atomic" },
      { path: "rejected", type: "atomic" }
    ])
    assert.deepStrictEqual(Machine.transitionDefinitions(machine), [
      {
        source: "editing",
        trigger: { type: "event", event: "Submit" },
        reenter: false,
        targets: { type: "declared", paths: ["accepted", "rejected"] },
        choice: "validate"
      }
    ])
  })

  it("rejects invalid choice metadata at construction", () => {
    const base = Machine.make({
      states: States.states,
      events: [Submit],
      initial: () => States.initial.editing(new Editing({ valid: true }))
    })

    assert.throws(
      () =>
        (base.handle as any)({
          editing: {
            on: {
              Submit: {
                choice: "missing",
                targets: ["accepted"],
                transition: () => undefined
              }
            }
          }
        }),
      /declares unknown choice "missing"/
    )
    assert.throws(
      () =>
        (base.handle as any)({
          editing: {
            on: {
              Submit: {
                choice: "validate",
                targets: [],
                transition: () => undefined
              }
            }
          }
        }),
      /must declare at least one target/
    )
  })

  it.effect("fails unsafe choice transitions that return no target", () =>
    Effect.gen(function*() {
      const machine = (Machine.make({
        states: States.states,
        events: [Submit],
        initial: () => States.initial.editing(new Editing({ valid: true }))
      }).handle as any)({
        editing: {
          on: {
            Submit: {
              choice: "validate",
              targets: ["accepted"],
              transition: () => undefined
            }
          }
        }
      })
      const initial = (yield* Machine.planInitial(machine)).state
      const exit = yield* Effect.exit(Machine.plan(machine, initial, new Submit({})))

      assert.strictEqual(exit._tag, "Failure")
      if (exit._tag === "Failure") {
        assert.include(Cause.pretty(exit.cause), "must return a target")
      }
    }))
})
