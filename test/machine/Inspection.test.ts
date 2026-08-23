import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"

class Root extends Schema.TaggedClass<Root>("InspectionRoot")("InspectionRoot", {}) {}
class Flow extends Schema.TaggedClass<Flow>("InspectionFlow")("InspectionFlow", {}) {}
class Idle extends Schema.TaggedClass<Idle>("InspectionIdle")("InspectionIdle", {}) {}
class Done extends Schema.TaggedClass<Done>("InspectionDone")("InspectionDone", {}) {}
class Side extends Schema.TaggedClass<Side>("InspectionSide")("InspectionSide", {}) {}
class ChoiceFlow extends Schema.TaggedClass<ChoiceFlow>("InspectionChoiceFlow")("InspectionChoiceFlow", {}) {}
class Ready extends Schema.TaggedClass<Ready>("InspectionReady")("InspectionReady", {}) {}

const RootOutput = Schema.String
const DoneOutput = Schema.Number

const States = Machine.states({
  root: {
    schema: Root,
    type: "parallel",
    output: RootOutput,
    states: {
      flow: {
        schema: Flow,
        initial: "idle",
        states: {
          idle: Idle,
          done: { schema: Done, type: "final", output: DoneOutput },
          recent: { type: "history", history: "deep" },
          route: { type: "choice" }
        }
      },
      side: Side
    }
  }
})

const machine = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: (to) =>
    to.root.initial.resolve(({ target }) =>
      target.decoded(new Root({}), (root) =>
        root
          .flow.decoded(new Flow({}), (flow) => flow.idle.decoded(new Idle({})))
          .side.decoded(new Side({})))
    )
})

const ChoiceStates = Machine.states({
  Flow: {
    schema: ChoiceFlow,
    initial: "Routing",
    states: {
      Routing: { type: "choice" },
      Ready
    }
  }
})

const choiceMachine = Machine.make({
  states: ChoiceStates.states,
  events: Machine.events(),
  initial: (to) => to.Flow.initial.resolve(({ target }) => target.decoded(new ChoiceFlow({}), (flow) => flow.Routing()))
}).handle({
  Flow: {
    states: {
      Routing: {
        choice: (to) => to.local.Ready().resolve(({ target }) => target.decoded(new Ready({})))
      }
    }
  }
})

describe("Machine compiled state-node inspection", () => {
  it("exposes exact metadata for all six state-node kinds", () => {
    const nodes = new Map(Machine.stateNodes(machine).map((node) => [node.path, node]))

    const parallel = nodes.get("root")!
    assert.strictEqual(parallel.type, "parallel")
    assert.strictEqual(parallel.schema, Root)
    assert.strictEqual(parallel.output, RootOutput)
    assert.strictEqual(parallel.history, undefined)
    assert.strictEqual(parallel.initial, undefined)
    assert.deepStrictEqual(parallel.children, ["root.flow", "root.side"])

    const compound = nodes.get("root.flow")!
    assert.strictEqual(compound.type, "compound")
    assert.strictEqual(compound.schema, Flow)
    assert.strictEqual(compound.output, undefined)
    assert.strictEqual(compound.history, undefined)
    assert.strictEqual(compound.initial, "root.flow.idle")
    assert.deepStrictEqual(compound.children, ["root.flow.idle", "root.flow.done"])

    const atomic = nodes.get("root.flow.idle")!
    assert.strictEqual(atomic.type, "atomic")
    assert.strictEqual(atomic.schema, Idle)
    assert.strictEqual(atomic.output, undefined)
    assert.strictEqual(atomic.history, undefined)
    assert.strictEqual(atomic.initial, undefined)
    assert.deepStrictEqual(atomic.children, [])

    const final = nodes.get("root.flow.done")!
    assert.strictEqual(final.type, "final")
    assert.strictEqual(final.schema, Done)
    assert.strictEqual(final.output, DoneOutput)
    assert.strictEqual(final.history, undefined)
    assert.strictEqual(final.initial, undefined)
    assert.deepStrictEqual(final.children, [])

    const history = nodes.get("root.flow.recent")!
    assert.strictEqual(history.type, "history")
    assert.strictEqual(history.schema, undefined)
    assert.strictEqual(history.output, undefined)
    assert.strictEqual(history.history, "deep")
    assert.strictEqual(history.parent, "root.flow")
    assert.strictEqual(history.initial, undefined)
    assert.deepStrictEqual(history.children, [])

    const choice = nodes.get("root.flow.route")!
    assert.strictEqual(choice.type, "choice")
    assert.strictEqual(choice.schema, undefined)
    assert.strictEqual(choice.output, undefined)
    assert.strictEqual(choice.history, undefined)
    assert.strictEqual(choice.parent, "root.flow")
    assert.strictEqual(choice.initial, undefined)
    assert.deepStrictEqual(choice.children, [])
  })

  it.effect("retains a choice initial path while configurations expose only active nodes", () =>
    Effect.gen(function*() {
      const flow = Machine.stateNodes(choiceMachine).find((node) => node.path === "Flow")
      assert(flow !== undefined)
      assert.strictEqual(flow.type, "compound")
      assert.strictEqual(flow.initial, "Flow.Routing")

      const plan = yield* Machine.planInitial(choiceMachine)
      assert.strictEqual(plan.state.path, "Flow")
      assert.strictEqual(plan.state.state.path, "Flow.Ready")
      assert.deepStrictEqual(
        Machine.configuration(choiceMachine, plan.state).map(({ path, type }) => ({ path, type })),
        [
          { path: "Flow" as const, type: "compound" },
          { path: "Flow.Ready" as const, type: "atomic" }
        ]
      )
    }))
})
