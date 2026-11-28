import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

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

const keys = (work: ReadonlyArray<MachineTest.RunningWork>) => work.map(({ id, path }) => `${path}#${id}`)

const outcome = (kind: "Done" | "Elapsed", path: string, id: string, output?: unknown): MachineTest.WorkOutcome =>
  kind === "Done"
    ? { _tag: MachineTest.WorkOutcomeTypeId, kind, path, id, output }
    : { _tag: MachineTest.WorkOutcomeTypeId, kind, path, id }

describe("trace work", () => {
  it.effect("starts work on entry, stops it on exit, and ends it once per entry", () =>
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
      const work: Array<ReadonlyArray<string>> = []
      for (let index = 0; index <= scenario.length; index++) {
        work.push(keys((yield* MachineTest.run(machine, { events: scenario.slice(0, index) })).work))
      }

      assert.deepStrictEqual(work, [
        [],
        ["Loading#load", "Loading#slow"],
        [],
        ["Loading#load", "Loading#slow"],
        [],
        [],
        ["Parent#watch", "Parent.A#tick"],
        ["Parent#watch"],
        ["Parent#watch", "Parent.A#tick"],
        ["Parent#watch"],
        []
      ])
    }))

  it.effect("describes each piece of work by its state, invocation, source, and kind", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(machine, { events: [Events.Enter()] })
      assert.deepStrictEqual(trace.work, [
        { path: "Parent", id: "watch", source: "watch", kind: "Effect" },
        { path: "Parent.A", id: "tick", source: "tick", kind: "Timer" }
      ])
    }))

  it.effect("ignores a result reported after its state was entered again", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(machine, {
        events: [Events.Enter(), outcome("Elapsed", "Parent.A", "tick"), outcome("Elapsed", "Parent.A", "tick")]
      })
      const late = trace.steps[2]!
      assert.strictEqual(late.plan.microsteps.length, 0)
      assert.deepStrictEqual(late.afterConfiguration, late.beforeConfiguration)
      assert.deepStrictEqual(keys(trace.work), ["Parent#watch"])
    }))

  it.effect("stops logic and a child machine that a transition stops", () =>
    Effect.gen(function*() {
      const Counter = Machine.childAddress<number>("counter")
      const worker = Machine.make({ root: Machine.state({ states: { Working: {} } }), events: Machine.events({}) })
        .handle({ initial: { target: "Working" } })
      const Worker = Machine.child("worker", worker)
      const owner = Machine.make({
        root: Machine.state({ states: { Hosting: {} } }),
        events: Machine.events({ StopCounter: {}, StopWorker: {} }),
        logic: { counter: Machine.logic({ initial: () => Effect.succeed(0), run: () => Effect.never }) },
        children: { worker: Worker }
      }).handle({
        initial: { target: "Hosting" },
        states: {
          Hosting: {
            invoke: [{ src: "counter", id: "counter", address: Counter }, { src: "worker" }],
            on: {
              StopCounter: { stay: true, commands: (_, enqueue) => enqueue.stop(Counter) },
              StopWorker: { stay: true, commands: (_, enqueue) => enqueue.stop(Worker) }
            }
          }
        }
      })

      const started = yield* MachineTest.run(owner, { events: [] })
      assert.deepStrictEqual(started.work.map(({ kind }) => kind), ["Logic", "Child"])
      const stopped = yield* MachineTest.run(owner, { events: [{ _tag: "StopCounter" }] })
      assert.deepStrictEqual(keys(stopped.work), ["Hosting#worker"])
      const both = yield* MachineTest.run(owner, { events: [{ _tag: "StopCounter" }, { _tag: "StopWorker" }] })
      assert.deepStrictEqual(both.work, [])
    }))
})
