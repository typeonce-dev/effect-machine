import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

class Counter extends Schema.TaggedClass<Counter>("Counter")("Counter", {
  count: Schema.Int
}) {}

class Increment extends Schema.TaggedClass<Increment>("Increment")("Increment", {}) {}
class Reset extends Schema.TaggedClass<Reset>("Reset")("Reset", {}) {}
class Corrupt extends Schema.TaggedClass<Corrupt>("Corrupt")("Corrupt", {}) {}
class Seed extends Schema.Class<Seed>("Seed")({ count: Schema.Int }) {}

const States = Machine.defineStates({ counter: Counter })

const machine = Machine.make({
  states: States.states,
  events: Machine.events(Increment, Reset, Corrupt),
  initial: {
    target: (to) => to.counter(),
    resolve: ({ target }) => target(new Counter({ count: 0 }))
  }
}).handle({
  counter: {
    on: {
      Increment: Machine.transition({
        target: (to) => to.full.counter(),
        resolve: ({ state, target }) => target(new Counter({ count: state.count + 1 }))
      }),
      Reset: Machine.transition({
        target: (to) => to.full.counter(),
        resolve: ({ target }) => target(new Counter({ count: 0 }))
      }),
      Corrupt: Machine.transition({
        target: (to) => to.full.counter(),
        resolve: ({ target }) => target(new Counter({ count: -1 }))
      })
    }
  }
})

const finiteEvents = ({ snapshot }: MachineTest.ExplorationStateContext<typeof machine>) =>
  snapshot.value.count < 2 ? [new Increment({})] : [new Reset({})]

describe("MachineTest bounded exploration", () => {
  it.effect("builds a complete breadth-first graph with shortest traces", () =>
    Effect.gen(function*() {
      const explored = yield* MachineTest.explore(machine, {
        events: finiteEvents,
        stateKey: ({ snapshot }) => snapshot.value.count
      })

      assert.deepStrictEqual(explored.nodes.map(({ key, depth }) => ({ key, depth })), [
        { key: 0, depth: 0 },
        { key: 1, depth: 1 },
        { key: 2, depth: 2 }
      ])
      assert.deepStrictEqual(explored.completeness, { _tag: "Complete" })
      assert.deepStrictEqual(explored.limits, {
        maxDepth: 20,
        maxStates: 1_000,
        maxTransitions: 10_000
      })
      assert.deepStrictEqual(explored.stats, {
        states: 3,
        plannedTransitions: 3,
        retainedEdges: 3,
        maxDepth: 2
      })
      assert.strictEqual(explored.nodesByKey.size, 3)

      const reached = yield* MachineTest.assertReachable(
        explored,
        "counter two",
        ({ snapshot }) => snapshot.value.count === 2
      )
      assert.deepStrictEqual(reached.trace.scenario.events, [new Increment({}), new Increment({})])
      assert.strictEqual(reached.depth, 2)
      assert.strictEqual(
        MachineTest.findShortest(explored, ({ key }) => key === 1)?.trace.scenario.events.length,
        1
      )

      yield* MachineTest.assertUnreachable(
        explored,
        "counter three",
        ({ snapshot }) => snapshot.value.count === 3
      )
    }))

  it.effect("checks invariants against the shortest discovered counterexample", () =>
    Effect.gen(function*() {
      const nonNegative = MachineTest.invariants(machine).state(
        "counter remains non-negative",
        ({ snapshot }) => snapshot.value.count >= 0 || `negative counter: ${snapshot.value.count}`
      )
      const failure = yield* MachineTest.explore(machine, {
        events: ({ snapshot }) => snapshot.value.count < 2 ? [new Increment({})] : [new Corrupt({})],
        stateKey: ({ snapshot }) => snapshot.value.count,
        invariants: [nonNegative]
      }).pipe(Effect.flip)

      assert.strictEqual(failure._tag, "MachineTestInvariantError")
      if (failure._tag !== "MachineTestInvariantError") return
      assert.deepStrictEqual(failure.trace.scenario.events, [
        new Increment({}),
        new Increment({}),
        new Corrupt({})
      ])
      assert.deepStrictEqual(failure.violations.map(({ eventIndex, message }) => ({ eventIndex, message })), [{
        eventIndex: 2,
        message: "negative counter: -1"
      }])
    }))

  it.effect("reports depth truncation and refuses an unreachability proof", () =>
    Effect.gen(function*() {
      const explored = yield* MachineTest.explore(machine, {
        events: finiteEvents,
        stateKey: ({ snapshot }) => snapshot.value.count,
        limits: { maxDepth: 1 }
      })

      assert.strictEqual(explored.completeness._tag, "Truncated")
      if (explored.completeness._tag === "Truncated") {
        assert.deepStrictEqual(explored.completeness.reasons, ["depth"])
        assert.deepStrictEqual(explored.completeness.frontier.map(({ _tag, source }) => ({ _tag, source })), [{
          _tag: "DepthLimit",
          source: 1
        }])
      }

      const error = yield* MachineTest.assertUnreachable(
        explored,
        "counter two",
        ({ snapshot }) => snapshot.value.count === 2
      ).pipe(Effect.flip)
      assert.strictEqual(error.reason, "Inconclusive")
      assert.strictEqual(error.expectation, "unreachable")
    }))

  it.effect("retains state and transition limit frontiers", () =>
    Effect.gen(function*() {
      const stateLimited = yield* MachineTest.explore(machine, {
        events: finiteEvents,
        stateKey: ({ snapshot }) => snapshot.value.count,
        limits: { maxStates: 2 }
      })
      assert.strictEqual(stateLimited.completeness._tag, "Truncated")
      if (stateLimited.completeness._tag === "Truncated") {
        assert.deepStrictEqual(stateLimited.completeness.reasons, ["states"])
        const boundary = stateLimited.completeness.frontier[0]
        assert.strictEqual(boundary?._tag, "StateLimit")
        if (boundary?._tag === "StateLimit") {
          assert.strictEqual(boundary.source, 1)
          assert.strictEqual(boundary.target, 2)
          assert.strictEqual(boundary.targetTrace.steps.length, 2)
        }
      }

      const transitionLimited = yield* MachineTest.explore(machine, {
        events: finiteEvents,
        stateKey: ({ snapshot }) => snapshot.value.count,
        limits: { maxTransitions: 1 }
      })
      assert.strictEqual(transitionLimited.completeness._tag, "Truncated")
      if (transitionLimited.completeness._tag === "Truncated") {
        assert.deepStrictEqual(transitionLimited.completeness.reasons, ["transitions"])
        assert.strictEqual(transitionLimited.completeness.frontier[0]?._tag, "TransitionLimit")
      }
    }))

  it.effect("treats state-key collisions as an explicit exploration abstraction", () =>
    Effect.gen(function*() {
      const explored = yield* MachineTest.explore(machine, {
        events: () => [new Increment({})],
        stateKey: ({ snapshot }) => Math.min(snapshot.value.count, 1)
      })

      assert.deepStrictEqual(
        explored.nodes.map(({ key, snapshot }) => ({
          key,
          count: snapshot.value.count
        })),
        [
          { key: 0, count: 0 },
          { key: 1, count: 1 }
        ]
      )
      assert.deepStrictEqual(explored.completeness, { _tag: "Complete" })
      assert.deepStrictEqual(explored.stats, {
        states: 2,
        plannedTransitions: 2,
        retainedEdges: 2,
        maxDepth: 1
      })
    }))

  it.effect("returns the shortest unexpected reachability witness", () =>
    Effect.gen(function*() {
      const explored = yield* MachineTest.explore(machine, {
        events: finiteEvents,
        stateKey: ({ snapshot }) => snapshot.value.count
      })
      const error = yield* MachineTest.assertUnreachable(
        explored,
        "counter one",
        ({ snapshot }) => snapshot.value.count === 1
      ).pipe(Effect.flip)

      assert.strictEqual(error.reason, "UnexpectedMatch")
      assert.strictEqual(error.witness?.depth, 1)
      assert.deepStrictEqual(error.witness?.trace.scenario.events, [new Increment({})])
    }))

  it.effect("uses typed machine input for the explored startup state", () =>
    Effect.gen(function*() {
      const inputMachine = Machine.make({
        states: States.states,
        events: Machine.events(Increment),
        input: Seed,
        initial: {
          target: (to) => to.counter(),
          resolve: ({ input, target }) => target(new Counter({ count: input.count }))
        }
      }).handle({ counter: {} })
      const explored = yield* MachineTest.explore(inputMachine, {
        input: new Seed({ count: 7 }),
        events: () => [],
        stateKey: ({ snapshot }) => snapshot.value.count
      })

      assert.strictEqual(explored.nodes[0]?.snapshot.value.count, 7)
      assert.deepStrictEqual(explored.nodes[0]?.trace.scenario, {
        input: new Seed({ count: 7 }),
        events: []
      })
      assert.deepStrictEqual(explored.completeness, { _tag: "Complete" })
    }))

  it("validates limits and assertion names eagerly", () => {
    assert.throws(
      () =>
        MachineTest.explore(machine, {
          events: finiteEvents,
          stateKey: ({ snapshot }) => snapshot.value.count,
          limits: { maxStates: 0 }
        }),
      /maxStates to be a safe integer greater than or equal to 1/
    )
    assert.throws(
      () => MachineTest.assertReachable({} as MachineTest.Exploration<typeof machine, number>, "", () => true),
      /name to be a non-empty string/
    )
  })
})
