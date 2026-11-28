import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Machine } from "../../../src/index.js"
import { makeMessages, makeTestStorage, startRunner, storageKey, type TestStorage } from "./support/harness.js"
import { Counter } from "./support/stored.js"

/** Lets everything that does not wait for time happen. */
const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })

const driver = Machine.make({
  id: "Driver",
  root: Machine.state({ states: { Idle: {}, Sending: {}, Stopping: {}, Entering: {} } }),
  events: Machine.events({ Send: {}, Stop: {}, Enter: {} }),
  effects: { run: (effect: Effect.Effect<void>) => effect },
  children: { counter: Counter }
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: {
      on: {
        Send: { target: "Sending" },
        Stop: { target: "Stopping" },
        // The child of `Entering` starts once this step is carried out.
        Enter: { target: "Entering", commands: (_, enqueue) => enqueue.sendTo(Counter, { _tag: "Add", by: 1 }) }
      }
    },
    Sending: {
      invoke: [
        { src: "counter", onDone: { target: "Idle" } },
        {
          src: "run",
          input: ({ children }) => Effect.orDie(children.sendTo(Counter, { _tag: "Add", by: 5 })),
          onDone: { stay: true }
        }
      ]
    },
    Stopping: {
      invoke: [
        { src: "counter", onDone: { target: "Idle" } },
        { src: "run", input: ({ children }) => children.stop(Counter), onDone: { stay: true } }
      ]
    },
    Entering: { invoke: { src: "counter", onDone: { target: "Idle" } } }
  }
})

const childKey = storageKey("Worker/counter", "worker-1/counter/1")

const childOf = (storage: TestStorage) => storage.entries.get(childKey)

const start = Effect.gen(function*() {
  const storage = makeTestStorage()
  const runner = yield* startRunner(driver, storage, yield* makeMessages)
  return { runner, storage }
})

describe("ClusterMachine children that work acts on", () => {
  it.effect("let the children of an input mapper send to the child of its state", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      assert.strictEqual((yield* runner.send({ _tag: "Send" }))._tag, "Accepted")
      yield* settle
      assert.deepStrictEqual(childOf(storage)?.snapshot.active.at(-1), {
        path: "Counting",
        value: { _tag: "Counting", count: 5 }
      })
    }).pipe(Effect.scoped))

  it.effect("let the children of an input mapper stop the child of its state", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      assert.strictEqual((yield* runner.send({ _tag: "Stop" }))._tag, "Accepted")
      yield* settle
      assert.deepStrictEqual(childOf(storage)?.status, { _tag: "Stopped" })
      // The parent stays, as a local one does when its work stops its child.
      assert.deepStrictEqual(runner.stored()?.snapshot.active.at(-1), { path: "Stopping" })
      assert.strictEqual(runner.stored()?.status._tag, "Active")
    }).pipe(Effect.scoped))

  it.effect("drop a send to a child that the same step enters", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      assert.strictEqual((yield* runner.send({ _tag: "Enter" }))._tag, "Accepted")
      yield* settle
      // Commands are carried out before the entered work starts, as locally.
      assert.deepStrictEqual(childOf(storage)?.snapshot.active.at(-1), {
        path: "Counting",
        value: { _tag: "Counting", count: 0 }
      })
      assert.strictEqual(childOf(storage)?.revision, 1)
    }).pipe(Effect.scoped))
})
