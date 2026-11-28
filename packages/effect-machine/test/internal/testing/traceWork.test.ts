import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import { MachineTest } from "../../../src/testing/index.js"

// A trace follows which work runs with the same rules as `Machine.toStep`.
// This drives both through one scenario and compares the work after each step.

const Events = Machine.events({ Load: {}, Cancel: {}, Enter: {}, Leave: {} })

const machine = Machine.make({
  root: Machine.state({
    states: {
      Idle: {},
      Loading: {},
      Parent: { states: { A: {}, B: {} } },
      Ready: { fields: { text: Schema.String } }
    }
  }),
  events: Events,
  effects: { load: Effect.succeed("text"), watch: Effect.void },
  timers: { tick: "1 second", slow: "1 minute" }
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Load: { target: "Loading" }, Enter: { target: "Parent" } } },
    Loading: {
      invoke: [
        { src: "load", onDone: { target: "Ready", data: ({ output }) => ({ text: output }) } },
        { src: "slow", onDone: { target: "Idle" } }
      ],
      on: { Cancel: { target: "Idle" } }
    },
    Parent: {
      initial: { target: "Parent.A" },
      invoke: { src: "watch", onDone: { stay: true } },
      on: { Leave: { target: "Idle" } },
      states: {
        A: { invoke: { src: "tick", onDone: { target: "Parent.B" } } },
        B: { on: { Enter: { target: "Parent.A", reenter: true } } }
      }
    },
    Ready: { on: { Cancel: { target: "Idle" } } }
  }
})

const self: Machine.MachineTarget<any> = { id: "m", sessionId: "m:test", send: () => Effect.void }

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

// The running work of a step state is internal to `toStep`.
const running = (state: unknown) =>
  (state as { readonly running: ReadonlyArray<Machine.MachineStep.Work<any>> }).running

const keys = (work: ReadonlyArray<{ readonly path: string; readonly id: string }>) =>
  work.map(({ id, path }) => `${path}#${id}`)

const outcome = (kind: "Done" | "Elapsed", path: string, id: string, output?: unknown): MachineTest.WorkOutcome =>
  kind === "Done"
    ? { _tag: MachineTest.WorkOutcomeTypeId, kind, path, id, output }
    : { _tag: MachineTest.WorkOutcomeTypeId, kind, path, id }

describe("trace work", () => {
  it.effect("runs the same work as Machine.toStep after every step", () =>
    Effect.gen(function*() {
      const scenario: ReadonlyArray<MachineTest.ScenarioEvent<typeof machine>> = [
        Events.Load(),
        Events.Cancel(),
        Events.Load(),
        outcome("Done", "Loading", "load", "text"),
        Events.Cancel(),
        Events.Enter(),
        outcome("Elapsed", "Parent.A", "tick"),
        Events.Enter(),
        outcome("Elapsed", "Parent.A", "tick"),
        Events.Leave()
      ]
      const step = Machine.toStep(machine, { self })
      let state = success(step.start()).state
      const expected = [keys(running(state))]
      for (const entry of scenario) {
        if (MachineTest.isWorkOutcome(entry)) {
          const work = running(state).find((work) => work.path === entry.path && work.id === entry.id)!
          state = step.settle(state, work, Exit.succeed(entry.kind === "Done" ? entry.output : undefined)).state
        } else {
          state = success(step.send(state, entry)).state
        }
        expected.push(keys(running(state)))
      }

      const actual = [keys((yield* MachineTest.run(machine, { events: [] })).work)]
      for (let index = 1; index <= scenario.length; index++) {
        actual.push(keys((yield* MachineTest.run(machine, { events: scenario.slice(0, index) })).work))
      }

      assert.deepStrictEqual(actual, expected)
      assert.deepStrictEqual(expected[7], ["Parent#watch"])
      assert.deepStrictEqual(expected[8], ["Parent#watch", "Parent.A#tick"])
    }))
})
