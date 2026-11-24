import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Snowflake } from "effect/cluster"
import { TestClock } from "effect/testing"
import { Machine } from "../../../src/index.js"
import { makeMessages, makeTestStorage, startRunner, storageKey, type TestStorage } from "./support/harness.js"

const Reports = Machine.events({ Counted: { count: Schema.Number } })

const breaks: boolean = true

const counter = Machine.make({
  id: "Counter",
  root: Machine.state({
    fields: { name: Schema.String },
    states: { Counting: { fields: { count: Schema.Number } }, Done: { type: "final", output: Schema.String } }
  }),
  input: Schema.String,
  events: Machine.events({ Add: { by: Schema.Number }, Finish: {}, Break: {} }),
  parent: Machine.parent(Reports)
}).handle({
  root: ({ input }) => ({ name: input }),
  initial: { target: "Counting", data: { count: 0 } },
  states: {
    Counting: {
      on: {
        Add: {
          update: { Counting: ({ event, state }) => ({ count: state.count + event.by }) },
          commands: ({ event, parent, state }, enqueue) =>
            enqueue.sendTo(parent, { _tag: "Counted", count: state.count + event.by })
        },
        Finish: { target: "Done" },
        Break: {
          branches: [{ target: "Done" }],
          resolve: ({ select }) => {
            if (breaks) throw new Error("broken counter")
            return select.target("Done")
          }
        }
      }
    },
    Done: { output: ({ ancestors }) => `counted by ${ancestors[""].name}` }
  }
})

const Counter = Machine.child("counter", counter)

const host = Machine.make({
  id: "Host",
  root: Machine.state({
    states: {
      Idle: {},
      Hosting: { fields: { counted: Schema.Number } },
      Ready: { fields: { result: Schema.String } },
      Doomed: {}
    }
  }),
  events: Machine.events({
    Host: { name: Schema.String },
    Add: { by: Schema.Number },
    Finish: {},
    Break: {},
    Cancel: {},
    Doom: {},
    Counted: { count: Schema.Number }
  }),
  effects: { fail: Effect.andThen(Effect.sleep("10 seconds"), Effect.die("broken host")) },
  children: { counter: Counter }
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Host: { target: "Hosting", data: { counted: 0 } }, Doom: { target: "Doomed" } } },
    Hosting: {
      invoke: {
        src: "counter",
        input: ({ event }) => event._tag === "Host" ? event.name : "nobody",
        onDone: { target: "Ready", data: ({ output }) => ({ result: output }) }
      },
      on: {
        Add: { stay: true, commands: ({ event }, enqueue) => enqueue.sendTo(Counter, { _tag: "Add", by: event.by }) },
        Finish: { stay: true, commands: (_, enqueue) => enqueue.sendTo(Counter, { _tag: "Finish" }) },
        Break: { stay: true, commands: (_, enqueue) => enqueue.sendTo(Counter, { _tag: "Break" }) },
        Counted: { update: { Hosting: ({ event }) => ({ counted: event.count }) } },
        Cancel: { target: "Idle" }
      }
    },
    Ready: { on: { Add: { stay: true, commands: ({ event }, enqueue) => enqueue.sendTo(Counter, event) } } },
    // Fails while its child runs.
    Doomed: { invoke: [{ src: "counter", input: () => "doomed", onDone: { target: "Idle" } }, { src: "fail" }] }
  }
})

/** Lets everything that does not wait for time happen. */
const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })

const start = Effect.gen(function*() {
  const storage = makeTestStorage()
  const messages = yield* makeMessages
  const runner = yield* startRunner(host, storage, messages)
  return { storage, messages, runner }
})

// A child is an entity of type `Type/childId`.
const childType = "Worker/counter"
const checkpointOf = (storage: TestStorage, entityType: string, entityId: string) =>
  storage.entries.get(storageKey(entityType, entityId))
const leafOf = (storage: TestStorage, entityType = "Worker", entityId = "worker-1") =>
  checkpointOf(storage, entityType, entityId)?.snapshot.active.at(-1)
const childrenOf = (storage: TestStorage) =>
  Array.from(storage.entries.keys()).filter((key) => key.startsWith(`${childType}\u0000`))
    .map((key) => key.slice(childType.length + 1))
const progressOf = (storage: TestStorage) => {
  const status = checkpointOf(storage, "Worker", "worker-1")?.status
  return status?._tag === "Active" ? status.invocations : undefined
}

describe("ClusterMachine child machines", () => {
  it.effect("start a child as an entity of its own with its input, and take what it sends", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      yield* runner.send({ _tag: "Host", name: "ada" })
      yield* settle
      assert.deepStrictEqual(childrenOf(storage), ["worker-1/counter/1"])
      assert.deepStrictEqual(progressOf(storage), {
        Hosting: { counter: { _tag: "Child", entityId: "worker-1/counter/1" } }
      })
      const child = checkpointOf(storage, childType, "worker-1/counter/1")
      assert.strictEqual(child?.definitionId, "Counter")
      assert.strictEqual(child?.version, "1")
      assert.deepStrictEqual(child?.snapshot.active[0]?.value, { _tag: "", name: "ada" })

      yield* runner.send({ _tag: "Add", by: 2 })
      yield* settle
      assert.deepStrictEqual(leafOf(storage, childType, "worker-1/counter/1")?.value, { _tag: "Counting", count: 2 })
      assert.deepStrictEqual(leafOf(storage)?.value, { _tag: "Hosting", counted: 2 })
    }).pipe(Effect.scoped))

  it.effect("stop a child when its state exits, and start a new one when it is entered again", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      yield* runner.send({ _tag: "Host", name: "ada" })
      yield* runner.send({ _tag: "Add", by: 2 })
      yield* settle
      yield* runner.send({ _tag: "Cancel" })
      yield* settle
      assert.deepStrictEqual(checkpointOf(storage, childType, "worker-1/counter/1")?.status, { _tag: "Stopped" })
      assert.deepStrictEqual(progressOf(storage), {})

      yield* runner.send({ _tag: "Host", name: "bob" })
      yield* settle
      const [, second] = childrenOf(storage).sort()
      assert.isDefined(second)
      assert.deepStrictEqual(leafOf(storage, childType, second)?.value, { _tag: "Counting", count: 0 })
      // An event for the child goes to the one that runs.
      yield* runner.send({ _tag: "Add", by: 1 })
      yield* settle
      assert.deepStrictEqual(leafOf(storage, childType, second)?.value, { _tag: "Counting", count: 1 })
      assert.deepStrictEqual(leafOf(storage, childType, "worker-1/counter/1")?.value, { _tag: "Counting", count: 2 })
    }).pipe(Effect.scoped))

  it.effect("apply the output of a child once, and drop an event for a child that does not run", () =>
    Effect.gen(function*() {
      const { messages, runner, storage } = yield* start
      yield* runner.send({ _tag: "Host", name: "ada" })
      yield* runner.send({ _tag: "Finish" })
      yield* settle
      assert.deepStrictEqual(leafOf(storage)?.value, { _tag: "Ready", result: "counted by ada" })
      const commits = storage.commits

      // Cluster delivers the end of the child again.
      const ended = messages.driver.journal.find((envelope) => envelope._tag === "Request" && envelope.tag === "ended")
      assert.isTrue(ended?._tag === "Request")
      if (ended?._tag !== "Request") return
      yield* messages.storage.clearReplies(Snowflake.Snowflake(ended.requestId))
      yield* runner.sharding.pollStorage
      yield* settle
      assert.strictEqual(storage.commits, commits)

      // No child runs in `Ready`.
      yield* runner.send({ _tag: "Add", by: 1 })
      yield* settle
      assert.strictEqual(storage.commits, commits + 1)
      assert.deepStrictEqual(leafOf(storage)?.value, { _tag: "Ready", result: "counted by ada" })
    }).pipe(Effect.scoped))

  it.effect("fail a child whose event cannot be applied, and its parent with it", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      yield* runner.send({ _tag: "Host", name: "ada" })
      yield* runner.send({ _tag: "Break" })
      yield* settle
      const child = checkpointOf(storage, childType, "worker-1/counter/1")
      assert.strictEqual(child?.status._tag, "Failed")
      assert.match(child?.status._tag === "Failed" ? child.status.failure : "", /broken counter/)
      const parent = checkpointOf(storage, "Worker", "worker-1")
      assert.strictEqual(parent?.status._tag, "Failed")
    }).pipe(Effect.scoped))

  it.effect("stop the children of a machine that fails", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      yield* runner.send({ _tag: "Doom" })
      yield* settle
      assert.strictEqual(checkpointOf(storage, childType, "worker-1/counter/1")?.status._tag, "Active")
      yield* TestClock.adjust("10 seconds")
      yield* settle
      assert.strictEqual(checkpointOf(storage, "Worker", "worker-1")?.status._tag, "Failed")
      assert.deepStrictEqual(checkpointOf(storage, childType, "worker-1/counter/1")?.status, { _tag: "Stopped" })
    }).pipe(Effect.scoped))
})
