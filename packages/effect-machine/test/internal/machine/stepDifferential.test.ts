import { assert, describe, it } from "@effect/vitest"
import { Cause, Duration, Effect, Exit, Schema, Stream } from "effect"
import { Machine } from "../../../src/index.js"
import * as ExecutionPlan from "../../../src/internal/machine/executionPlan.js"
import * as Protocol from "../../../src/internal/machine/protocol.js"
import * as Step from "../../../src/internal/machine/step.js"
import { children } from "../../conformance/scenarios/children.js"
import { invocations } from "../../conformance/scenarios/invocations.js"
import { restarts } from "../../conformance/scenarios/restarts.js"
import { timers } from "../../conformance/scenarios/timers.js"
import { transitions } from "../../conformance/scenarios/transitions.js"
import { Fixture } from "../../conformance/support/fixture.js"
import type { Action, Scenario } from "../../conformance/support/scenario.js"
import { type Input, verifyStepStrategies } from "./support/stepDifferential.js"

const self: Machine.MachineTarget<any> = { id: "step", sessionId: "step:test", send: () => Effect.void }

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

/** The script of a conformance scenario, as inputs of the step functions. */
const inputsOf = (actions: ReadonlyArray<Action>): ReadonlyArray<Input> =>
  actions.map((action): Input => {
    switch (action._tag) {
      case "Send":
        return { _tag: "Send", event: action.event }
      case "End":
        return {
          _tag: "Settle",
          work: { matches: (work) => work.source === action.source, position: action.run },
          exit: action.exit
        }
      case "Element":
        return {
          _tag: "Element",
          work: { matches: (work) => work.source === action.source, position: action.run },
          value: action.value
        }
      case "Advance":
        return { _tag: "Advance", millis: Duration.toMillis(action.duration) }
      case "Restart":
        return { _tag: "Resume" }
      case "Stop":
        return { _tag: "Stop" }
    }
  })

const strategyOf = (machine: Machine.Machine.Any) =>
  ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy

describe("Machine.toStep planner and ownership", () => {
  describe("on the machines and scripts of the conformance scenarios", () => {
    const scenarios: ReadonlyArray<Scenario> = [...transitions, ...invocations, ...timers, ...restarts, ...children]
    for (const scenario of scenarios) {
      it(scenario.name, () => {
        verifyStepStrategies({
          label: scenario.name,
          make: () => {
            const fixture = new Fixture()
            return { machine: scenario.machine(fixture), log: () => fixture.log.slice() }
          },
          input: "input" in scenario ? [scenario.input] : [],
          inputs: inputsOf(scenario.steps.flatMap(({ actions }) => actions))
        })
      })
    }

    it("plans most of them with an indexed kernel", () => {
      const strategies = scenarios.map(({ machine }) => strategyOf(machine(new Fixture())))
      const indexed = strategies.filter((strategy) => strategy !== "generic").length
      assert.ok(indexed >= scenarios.length / 2, `${indexed} of ${scenarios.length} scenarios are indexed`)
      assert.ok(strategies.includes("indexed-flat"))
      assert.ok(strategies.includes("indexed-hierarchical"))
    })
  })

  // A flat counter whose events update in place, raise more updates, and fail
  // after some of them, so a failed owned step must leave its state as it was.
  const Counter = Machine.make({
    root: Machine.state({
      states: {
        Count: { fields: { value: Schema.Number } },
        Done: { type: "final", fields: { value: Schema.Number }, output: Schema.Number }
      }
    }),
    events: Machine.events({
      Increment: {},
      Twice: {},
      Overflow: {},
      Burst: {},
      Same: {},
      Again: {},
      Finish: {}
    })
  }).handle({
    initial: { target: "Count", data: { value: 0 } },
    states: {
      Count: {
        on: {
          Increment: { target: "Count", data: ({ state }) => ({ value: state.value + 1 }) },
          // Two in-place updates of one state, the second from a raised event.
          Twice: {
            target: "Count",
            data: ({ state }) => ({ value: state.value + 1 }),
            commands: (_, enqueue) => enqueue.raise({ _tag: "Increment" })
          },
          // Updates, then raises an event whose transition throws.
          Overflow: {
            target: "Count",
            data: ({ state }) => ({ value: state.value + 10 }),
            commands: (_, enqueue) => enqueue.raise({ _tag: "Burst" })
          },
          Burst: {
            target: "Count",
            data: ({ state }) => {
              if (state.value >= 10) throw new Error("overflow")
              return { value: state.value }
            }
          },
          Same: { stay: true },
          Again: { target: "Count", reenter: true, data: ({ state }) => ({ value: state.value * 2 }) },
          Finish: { target: "Done", data: ({ state }) => ({ value: state.value }) }
        }
      },
      Done: { output: ({ state }) => state.value }
    }
  })

  const send = (event: unknown): Input => ({ _tag: "Send", event })

  it("plans in-place updates, raised updates, reentry and completion alike", () => {
    assert.strictEqual(strategyOf(Counter), "indexed-flat")
    verifyStepStrategies({
      label: "counter",
      make: () => ({ machine: Counter }),
      inputs: [
        send({ _tag: "Increment" }),
        send({ _tag: "Twice" }),
        send({ _tag: "Same" }),
        send({ _tag: "Again" }),
        send({ _tag: "Unknown" }),
        send({ _tag: "Increment" }),
        send({ _tag: "Finish" }),
        send({ _tag: "Increment" })
      ]
    })
  })

  it("fails a step that throws after it updated in place, from the state before it", () => {
    verifyStepStrategies({
      label: "overflow",
      make: () => ({ machine: Counter }),
      inputs: [send({ _tag: "Increment" }), send({ _tag: "Overflow" }), send({ _tag: "Increment" })]
    })
    // The owned step wrote the value of `Count` in place before the raised
    // transition threw: the failed step reports the state it started from.
    // Nothing of the state before is read first, so the failed step builds
    // its snapshot from the storage that the plan wrote.
    const owned = Step.makeOwned(Counter, { self })
    const incremented = success(owned.send(success(owned.start()).state, { _tag: "Increment" }))
    const failed = success(owned.send(incremented.state, { _tag: "Overflow" }))
    const persistent = Step.make(Counter, { self })
    assert.deepStrictEqual(
      failed.snapshot,
      success(persistent.send(success(persistent.start()).state, { _tag: "Increment" })).snapshot
    )
    assert.ok(failed.exit !== undefined && Exit.isFailure(failed.exit))
    assert.match(Cause.pretty(failed.exit.cause), /overflow/)
  })

  // Parallel regions with simultaneous transitions, a raised event, and a
  // region that completes, planned by the hierarchical kernel.
  const Regions = Machine.make({
    root: Machine.state({
      states: {
        Active: {
          type: "parallel",
          states: {
            Left: { states: { Low: {}, High: {} } },
            Right: { states: { Waiting: {}, Finished: { type: "final" } } }
          }
        },
        Complete: { type: "final" }
      }
    }),
    events: Machine.events({ Tick: {}, Both: {}, Close: {}, Finish: {} })
  }).handle({
    initial: { target: "Active" },
    states: {
      Active: {
        on: { Finish: { target: "Complete" } },
        states: {
          Left: {
            initial: { target: "Active.Left.Low" },
            states: {
              Low: {
                on: {
                  Tick: { target: "Active.Left.High" },
                  Both: { target: "Active.Left.High", commands: (_, enqueue) => enqueue.raise({ _tag: "Tick" }) }
                }
              },
              High: { on: { Tick: { target: "Active.Left.Low" } } }
            }
          },
          Right: {
            initial: { target: "Active.Right.Waiting" },
            states: {
              Waiting: {
                on: { Both: { target: "Active.Right.Finished" }, Close: { target: "Active.Right.Finished" } }
              },
              Finished: {}
            }
          }
        }
      },
      Complete: {}
    }
  })

  it("plans simultaneous transitions in parallel regions alike", () => {
    assert.strictEqual(strategyOf(Regions), "indexed-hierarchical")
    verifyStepStrategies({
      label: "regions",
      make: () => ({ machine: Regions }),
      inputs: [send({ _tag: "Tick" }), send({ _tag: "Both" }), send({ _tag: "Tick" }), send({ _tag: "Finish" })]
    })
  })

  // Work of every kind, whose results the script reports.
  const Worker = Machine.make({
    root: Machine.state({
      states: {
        Idle: {},
        Busy: { fields: { count: Schema.Number } },
        Done: { fields: { result: Schema.String } },
        Failed: {}
      }
    }),
    events: Machine.events({ Start: {}, Cancel: {}, Bump: {} }),
    effects: { load: (id: string) => id === "fail" ? Effect.fail("nope") : Effect.succeed(id) },
    streams: { ticks: Stream.make(1, 2, 3) },
    timers: { wait: "1 second" }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Start: { target: "Busy", data: { count: 0 } } } },
      Busy: {
        invoke: [
          {
            src: "load",
            input: ({ state }) => String(state.count),
            onDone: { target: "Done", data: ({ output }) => ({ result: output }) },
            onFailure: { target: "Failed" }
          },
          {
            src: "ticks",
            onElement: { target: "Busy", data: ({ state }) => ({ count: state.count + 1 }) },
            onDone: { stay: true }
          },
          { src: "wait", onDone: { target: "Busy", data: ({ state }) => ({ count: state.count + 100 }) } }
        ],
        on: {
          Cancel: { target: "Idle" },
          Bump: { target: "Busy", reenter: true, data: ({ state }) => ({ count: state.count }) }
        }
      },
      Done: { on: { Start: { target: "Busy", data: { count: 0 } } } },
      Failed: {}
    }
  })

  const of = (source: string, position?: number) => ({
    matches: (work: Step.Work) => work.source === source,
    position
  })

  it("plans the results of invoked work alike, including results of work that no longer runs", () => {
    verifyStepStrategies({
      label: "worker",
      make: () => ({ machine: Worker }),
      inputs: [
        send({ _tag: "Start" }),
        { _tag: "Element", work: of("ticks"), value: 1 },
        { _tag: "Advance", millis: 1000 },
        { _tag: "Element", work: of("ticks"), value: 2 },
        send({ _tag: "Bump" }),
        // A result of the run that the reentry stopped changes nothing.
        { _tag: "Element", work: of("ticks", 0), value: 3 },
        { _tag: "Settle", work: of("load", 0), exit: Exit.succeed("stale") },
        { _tag: "Settle", work: of("ticks"), exit: Exit.void },
        { _tag: "Resume" },
        { _tag: "Settle", work: of("load"), exit: Exit.succeed("fresh") },
        send({ _tag: "Start" }),
        { _tag: "Settle", work: of("load"), exit: Exit.fail("nope") },
        { _tag: "Stop" }
      ]
    })
  })

  describe("owned states", () => {
    const counter = () => Step.makeOwned(Counter, { self })

    it("refuses a state reused after it was handed over to a step", () => {
      const step = counter()
      const started = success(step.start())
      const next = success(step.send(started.state, { _tag: "Increment" }))
      assert.throws(() => step.send(started.state, { _tag: "Increment" }), /never reuse an owned state/)
      assert.throws(() => step.stop(started.state), /never reuse an owned state/)
      assert.strictEqual((next.snapshot as any).state.value.value, 1)
    })

    it("gives back a state that a step returns unchanged, or whose event it refuses", () => {
      const step = counter()
      const started = success(step.start())
      assert.ok(Exit.isFailure(step.send(started.state, { _tag: "Unknown" })))
      const next = success(step.send(started.state, { _tag: "Increment" }))
      const done = success(step.send(next.state, { _tag: "Finish" }))
      const stopped = step.stop(done.state)
      assert.strictEqual(stopped.state, done.state)
      assert.strictEqual(step.stop(stopped.state).state, done.state)
    })

    it("moves a state as its step would, and lists a step only for what a host must apply", () => {
      const decoded = (event: unknown) => Protocol.decodeEventSync(Counter, event)
      for (const planner of ["Compiled", "Reference"] as const) {
        const kernel = Step.kernel(Counter, "Owned", planner)
        const planning = () => new Step.Planning(Counter, kernel.plan, self, undefined, undefined)
        let moved = success(kernel.start(planning(), [], false)).state
        let stepped = success(kernel.start(planning(), [], false)).state
        for (const event of [{ _tag: "Increment" }, { _tag: "Twice" }, { _tag: "Same" }, { _tag: "Again" }]) {
          const result = kernel.move(moved, decoded(event))
          const step = kernel.sendDecoded(stepped, decoded(event), false)
          assert.notInstanceOf(result, Step.Step)
          const state = result as Step.State<"Owned">
          // An event that changes nothing returns the state passed in.
          assert.strictEqual(state === moved, !step.planned)
          assert.deepStrictEqual(state.snapshot, step.snapshot)
          moved = state
          stepped = step.state
        }
        // A state that a move replaced is not reused.
        const before = moved
        moved = kernel.move(moved, decoded({ _tag: "Increment" })) as Step.State<"Owned">
        assert.throws(() => kernel.move(before, decoded({ _tag: "Increment" })), /never reuse an owned state/)
        // A step that ends the machine or fails is listed as a step.
        const finished = kernel.move(moved, decoded({ _tag: "Finish" }))
        assert.instanceOf(finished, Step.Step)
        const exit = (finished as Step.Step<"Owned">).exit!
        assert.ok(Exit.isSuccess(exit))
        // Increment, Twice, Again and the last Increment: (1 + 2) * 2 + 1.
        assert.strictEqual(exit.value, 7)
        const failed = kernel.move(success(kernel.start(planning(), [], false)).state, decoded({ _tag: "Overflow" }))
        assert.instanceOf(failed, Step.Step)
        assert.ok(Exit.isFailure((failed as Step.Step<"Owned">).exit!))
      }
    })

    it("are not the states of the persistent step functions", () => {
      const owned: Step.OwnedMachineStep = counter()
      const persistent: Step.MachineStep = Step.make(Counter, { self })
      const state = success(persistent.start()).state
      // @ts-expect-error A persistent state is not an owned one.
      owned.send(state, { _tag: "Increment" })
      // @ts-expect-error An owned state is not a persistent one.
      persistent.send(success(owned.start()).state, { _tag: "Increment" })
    })
  })
})
