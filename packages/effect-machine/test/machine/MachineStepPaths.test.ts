import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { Machine } from "../../src/index.js"

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`Expected a success, received ${Cause.pretty(exit.cause)}`)
  return exit.value
}

const self: Machine.MachineTarget<any> = { id: "paths", sessionId: "paths:test", send: () => Effect.void }

const machine = Machine.make({
  id: "paths",
  root: Machine.state({
    states: {
      Idle: {},
      Busy: { states: { One: {}, Two: {} } },
      Done: { type: "final" }
    }
  }),
  events: Machine.events({ Go: {}, Next: {}, Note: {}, Finish: {} }),
  effects: { work: Effect.void }
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Go: { target: "Busy.One" } } },
    Busy: {
      initial: { target: "Busy.One" },
      invoke: { src: "work", onDone: { stay: true } },
      on: { Note: { stay: true }, Finish: { target: "Done" } },
      states: {
        One: { on: { Next: { target: "Busy.Two" } } },
        Two: {}
      }
    },
    Done: {}
  }
})

const pathsOf = (step: Machine.MachineStep.Step<typeof machine>) => ({ exited: step.exited, entered: step.entered })

describe("Machine.toStep exited and entered paths", () => {
  it("lists the states that each step exited and entered, in order", () => {
    const step = Machine.toStep(machine, { self })
    const started = success(step.start())
    assert.deepStrictEqual(pathsOf(started), { exited: [], entered: ["", "Idle"] })
    const busy = success(step.send(started.state, { _tag: "Go" }))
    assert.deepStrictEqual(pathsOf(busy), { exited: ["Idle"], entered: ["Busy", "Busy.One"] })
    const next = success(step.send(busy.state, { _tag: "Next" }))
    assert.deepStrictEqual(pathsOf(next), { exited: ["Busy.One"], entered: ["Busy.Two"] })
    // A transition that stays exits and enters nothing, and neither does an
    // event that no state handles.
    assert.deepStrictEqual(pathsOf(success(step.send(next.state, { _tag: "Note" }))), { exited: [], entered: [] })
    assert.deepStrictEqual(pathsOf(success(step.send(next.state, { _tag: "Go" }))), { exited: [], entered: [] })
    const done = success(step.send(next.state, { _tag: "Finish" }))
    assert.deepStrictEqual(pathsOf(done), { exited: ["Busy.Two", "Busy"], entered: ["Done"] })
    assert.isTrue(done.exit !== undefined && Exit.isSuccess(done.exit))
  })

  it("lists none for a resume, a stop, and a result that is ignored", () => {
    const step = Machine.toStep(machine, { self })
    const busy = success(step.send(success(step.start()).state, { _tag: "Go" }))
    const resumed = success(step.resume(busy.snapshot))
    assert.deepStrictEqual(pathsOf(resumed), { exited: [], entered: [] })
    assert.deepStrictEqual(pathsOf(step.stop(busy.state)), { exited: [], entered: [] })
    // The work of `Busy` that `busy` started is not the work `resumed` runs.
    const work = busy.start[0]!
    assert.deepStrictEqual(pathsOf(step.settle(resumed.state, work, Exit.void)), { exited: [], entered: [] })
  })
})
