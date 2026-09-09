import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Machine } from "../../src/index.js"

const CounterRoot = Machine.state({ fields: { count: Schema.Number } })
const Events = Machine.events({ Increment: { by: Schema.Number } })
const targets1 = Machine.targets(CounterRoot)
const counter = Machine.make({
  root: CounterRoot,
  events: Events,
  initial: (root) => root.from(() => ({ count: 0 }))
}).handle({
  on: {
    Increment: { update: targets1.root, from: ({ root: current, event }) => ({ count: current.count + event.by }) }
  }
})

describe("root", () => {
  it("updates root data without a synthetic state", async () => {
    const initial = await Effect.runPromise(Machine.planInitial(counter))
    expect(initial.state.value).toEqual({ _tag: "", count: 0 })
    const next = await Effect.runPromise(Machine.plan(counter, initial.state, { _tag: "Increment", by: 2 }))
    expect(next.next.value).toEqual({ _tag: "", count: 2 })
    expect(next.microsteps.flatMap((step) => step.exitPaths)).toEqual([])
    expect(next.microsteps.flatMap((step) => step.entryPaths)).toEqual([])
  })
})

const EditorRoot = Machine.state({
  fields: { count: Schema.Number },
  initial: "Editing",
  states: { Editing: {}, Saving: {} }
})
const EditorEvents = Machine.events({ Save: {}, Edit: {}, Increment: { by: Schema.Number } })
const targets2 = Machine.targets(EditorRoot)
const editor = Machine.make({
  root: EditorRoot,
  events: EditorEvents,
  initial: (root) => root.from(() => ({ count: 0 }))
}).handle({
  on: {
    Increment: { update: targets2.root, from: ({ root: current, event }) => ({ count: current.count + event.by }) }
  },
  states: {
    Editing: { on: { Save: { target: targets2.root.Saving } } },
    Saving: { on: { Edit: { target: targets2.root.Editing } } }
  }
})

it("retains root data while moving among children", async () => {
  const initial = await Effect.runPromise(Machine.planInitial(editor))
  expect(initial.state.state.path).toBe("Editing")
  const counted = await Effect.runPromise(Machine.plan(editor, initial.state, EditorEvents.Increment({ by: 2 })))
  const saved = await Effect.runPromise(Machine.plan(editor, counted.next, EditorEvents.Save()))
  expect(saved.next.value.count).toBe(2)
  expect(saved.next.state.path).toBe("Saving")
  expect(EditorRoot.matches(saved.next, "Saving")).toBe(true)
  expect(saved.microsteps.flatMap((step) => step.exitPaths)).toEqual(["Editing"])
  expect(saved.microsteps.flatMap((step) => step.entryPaths)).toEqual(["Saving"])
})

it("starts a root and acknowledges deferred inputs", async () => {
  const { MachineTest } = await import("../../src/testing/index.js")
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const ref = yield* Machine.start(counter)
    const probe = yield* MachineTest.probe(counter, ref)
    const step = yield* probe.sendAndAwait(Events.Increment({ by: 4 }))
    expect(step.event).toEqual({ _tag: "Increment", by: 4 })
    expect(step.after.value.count).toBe(4)
    const trace = yield* MachineTest.run(counter, { events: [Events.Increment({ by: 3 })] })
    expect(trace.steps[0]!.event).toEqual({ _tag: "Increment", by: 3 })
    expect(trace.final.value.count).toBe(3)
  })))
})

it("defaults structural roots and allows an explicit starting configuration", async () => {
  const root = Machine.state({ initial: "Editing", states: { Editing: {}, Saving: {} } })
  const normal = Machine.make({ root, events: Machine.events({}) }).handle({})
  const explicit = Machine.make({
    root,
    events: Machine.events({}),
    initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Saving.from()))
  }).handle({})
  expect((await Effect.runPromise(Machine.planInitial(normal))).state.state.path).toBe("Editing")
  expect((await Effect.runPromise(Machine.planInitial(explicit))).state.state.path).toBe("Saving")
})

it("rejects snapshots from the previous root model", async () => {
  const initial = await Effect.runPromise(Machine.planInitial(counter))
  const encoded = await Effect.runPromise(Machine.encodeSnapshot(counter, initial.state))
  expect(encoded.version).toBe(2)
  const { version: _, ...previous } = encoded
  const failure = await Effect.runPromise(Machine.decodeSnapshot(counter, previous).pipe(Effect.flip))
  expect(failure._tag).toBe("MachineSchemaDecodeError")
})

it("declines guarded child transitions and tries the root handler", async () => {
  const root = Machine.state({ fields: { count: Schema.Number }, initial: "Idle", states: { Idle: {}, Busy: {} } })
  let constructed = 0
  const events = Machine.events({ Go: { allowed: Schema.Boolean } })
  const targets3 = Machine.targets(root)
  const machine = Machine.make({
    branches: { transition1: { destination: { target: targets3.root.Busy } } },
    root,
    events,
    initial: (root) => root.from(() => ({ count: 0 }))
  }).handle({
    on: { Go: { update: targets3.root, from: ({ root: current }) => ({ count: current.count + 1 }) } },
    states: {
      Idle: {
        on: {
          Go: {
            branches: "transition1",
            guard: ({ event }) => event.allowed,
            resolve: ({ select: { destination: target } }) => {
              constructed++
              return target.from()
            }
          }
        }
      }
    }
  })
  const initial = await Effect.runPromise(Machine.planInitial(machine))
  const declined = await Effect.runPromise(Machine.plan(machine, initial.state, events.Go({ allowed: false })))
  expect(declined.next.value.count).toBe(1)
  expect(declined.next.state.path).toBe("Idle")
  expect(constructed).toBe(0)
  const accepted = await Effect.runPromise(Machine.plan(machine, declined.next, events.Go({ allowed: true })))
  expect(accepted.next.value.count).toBe(1)
  expect(accepted.next.state.path).toBe("Busy")
  expect(constructed).toBe(1)
})

it("initializes required child values from root-owned data", async () => {
  const root = Machine.state({
    fields: { title: Schema.String },
    initial: "Editing",
    states: {
      Editing: { fields: { draft: Schema.String } }
    }
  })
  const machine = Machine.make({
    root,
    events: Machine.events({}),
    initial: (root) => root.from(() => ({ title: "Example" }))
  }).handle({
    initialize: ({ builder, state }) => builder.from({ draft: state.title })
  })
  const initial = await Effect.runPromise(Machine.planInitial(machine))
  expect(initial.state.state.value).toEqual({ _tag: "Editing", draft: "Example" })
})

it("returns the completed workflow output through the root boundary", async () => {
  const root = Machine.state({
    fields: { title: Schema.String },
    initial: "Workflow",
    states: {
      Workflow: { initial: "Working", states: { Working: {}, Finished: { type: "final", output: Schema.Number } } }
    }
  })
  const targets4 = Machine.targets(root)
  const machine = Machine.make({
    root,
    events: Machine.events({ Finish: {} }),
    initial: (root) => root.from(() => ({ title: "Work" }))
  }).handle({
    states: {
      Workflow: {
        states: {
          Working: { on: { Finish: { target: targets4.root.Workflow.Finished } } },
          Finished: { output: () => 42 }
        }
      }
    }
  })
  const initial = await Effect.runPromise(Machine.planInitial(machine))
  const done = await Effect.runPromise(Machine.plan(machine, initial.state, { _tag: "Finish" }))
  expect(done.done).toBe(true)
  expect(done.output).toBe(42)
  expect(done.next.value.title).toBe("Work")
  const encoded = await Effect.runPromise(Machine.encodeSnapshot(machine, done.next))
  const decoded = await Effect.runPromise(Machine.decodeSnapshot(machine, encoded))
  expect(Machine.isFinal(machine, decoded)).toBe(true)
})

it("keeps completion inside an unfinished nested workflow", async () => {
  const root = Machine.state({
    initial: "Outer",
    states: {
      Outer: { initial: "Inner", states: { Inner: { initial: "Finished", states: { Finished: { type: "final" } } } } }
    }
  })
  const machine = Machine.make({ root, events: Machine.events({}) }).handle({})
  const initial = await Effect.runPromise(Machine.planInitial(machine))
  expect(initial.done).toBe(false)
  expect(initial.state.completed?.map(({ path }) => path)).toEqual(["Outer.Inner.Finished", "Outer.Inner"])
})

it("retains current root fields when restoring descendant history", async () => {
  const root = Machine.state({
    fields: { count: Schema.Number },
    initial: "Editing",
    states: {
      Editing: { initial: "A", states: { A: {}, B: {}, recent: { type: "history", history: "deep" } } },
      Away: {}
    }
  })
  const events = Machine.events({ Next: {}, Leave: {}, Return: {}, Increment: {} })
  const targets5 = Machine.targets(root)
  const machine = Machine.make({
    branches: { transition1: { destination: { history: targets5.root.Editing.recent } } },
    root,
    events,
    initial: (root) => root.from(() => ({ count: 0 }))
  }).handle({
    on: { Increment: { update: targets5.root, from: ({ root: current }) => ({ count: current.count + 1 }) } },
    states: {
      Editing: {
        on: { Leave: { target: targets5.root.Away } },
        history: {
          recent: {
            default: ({ target }) => target.from({ count: 999 }, (to) => to.Editing.from((editing) => editing.A.from()))
          }
        },
        states: { A: { on: { Next: { target: targets5.root.Editing.B } } } }
      },
      Away: { on: { Return: { branches: "transition1", resolve: ({ select: { destination: target } }) => target() } } }
    }
  })
  let snapshot = (await Effect.runPromise(Machine.planInitial(machine))).state
  for (const event of [events.Next(), events.Leave(), events.Increment(), events.Return()]) {
    snapshot = (await Effect.runPromise(Machine.plan(machine, snapshot, event))).next
  }
  expect(root.matches(snapshot, "Editing.B")).toBe(true)
  expect(snapshot.value.count).toBe(1)
})

it("checks a bare guard before selecting a default destination", async () => {
  const root = Machine.state({ initial: "Idle", states: { Idle: {}, Busy: {} } })
  const targets6 = Machine.targets(root)
  const machine = Machine.make({ root, events: Machine.events({ Start: { allowed: Schema.Boolean } }) }).handle({
    states: { Idle: { on: { Start: { target: targets6.root.Busy, guard: ({ event }) => event.allowed } } } }
  })
  const initial = await Effect.runPromise(Machine.planInitial(machine))
  const blocked = await Effect.runPromise(Machine.plan(machine, initial.state, { _tag: "Start", allowed: false }))
  expect(blocked.next.state.path).toBe("Idle")
  const accepted = await Effect.runPromise(Machine.plan(machine, initial.state, { _tag: "Start", allowed: true }))
  expect(accepted.next.state.path).toBe("Busy")
})

it("records decoded ignored events as verifiable receipts", async () => {
  const { MachineTest } = await import("../../src/testing/index.js")
  const events = Machine.events({ Ignored: { value: Schema.String } })
  const machine = Machine.make({ root: Machine.state({}), events }).handle({})
  await Effect.runPromise(Effect.gen(function*() {
    const trace = yield* MachineTest.run(machine, { events: [events.Ignored({ value: "receipt" })] })
    expect(trace.steps[0]!.event).toEqual({ _tag: "Ignored", value: "receipt" })
    expect(trace.scenario.events).toEqual([{ _tag: "Ignored", value: "receipt" }])
    expect(trace.steps[0]!.before).toEqual(trace.steps[0]!.after)
    yield* MachineTest.verify(machine, trace)
  }))
})
