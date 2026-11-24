import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../../src/index.js"
import { ClusterMachine } from "../../../src/unstable/cluster/index.js"
import { makeMessages, makeTestStorage, startRunner, storageKey, type TestStorage } from "./support/harness.js"

const Events = Machine.events({ Add: { amount: Schema.Number }, Finish: {} })

const machine = Machine.make({
  root: Machine.state({
    states: {
      Counting: { fields: { count: Schema.Number } },
      Done: { type: "final", fields: { count: Schema.Number }, output: Schema.Number }
    }
  }),
  events: Events
}).handle({
  initial: { target: "Counting", data: { count: 0 } },
  states: {
    Counting: {
      on: {
        Add: { target: "Counting", data: ({ event, state }) => ({ count: state.count + event.amount }) },
        Finish: { target: "Done", data: ({ state }) => ({ count: state.count }) }
      }
    },
    Done: { output: ({ state }) => state.count }
  }
})

const start = Effect.gen(function*() {
  const storage = makeTestStorage()
  const messages = yield* makeMessages
  const runner = yield* startRunner(machine, storage, messages)
  return { storage, messages, runner }
})

const provideStorage = (storage: TestStorage) => Effect.provideService(ClusterMachine.Storage, storage.service)

const statusOf = (snapshot: ClusterMachine.Snapshot<Machine.Machine.Any>) => `${snapshot.status}@${snapshot.revision}`

/** Replaces the stored checkpoint, as another writer of the store would. */
const overwrite = (storage: TestStorage, change: Partial<ClusterMachine.Checkpoint>) => {
  const key = storageKey("Worker", "worker-1")
  const stored = storage.entries.get(key)!
  storage.entries.set(key, { ...stored, ...change })
}

describe("ClusterMachine.Client reads", () => {
  it.effect("reads nothing before the first commit, then each committed checkpoint", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      const { client } = runner
      const read = client.snapshot.pipe(provideStorage(storage))
      assert.isTrue(Option.isNone(yield* read))

      yield* client.send(Events.Add({ amount: 2 }))
      const active = Option.getOrThrow(yield* read)
      assert.strictEqual(statusOf(active), "active@1")
      assert.deepStrictEqual(active.state.state, { path: "Counting", value: { _tag: "Counting", count: 2 } })

      yield* client.send(Events.Finish())
      const done = Option.getOrThrow(yield* read)
      assert.strictEqual(statusOf(done), "done@2")
      assert.strictEqual(done.status === "done" && done.output, 2)
    }).pipe(Effect.scoped))

  it.effect("streams each revision it reads once, and ends after a terminal one", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      const { client } = runner
      const seen = yield* client.changes.pipe(
        Stream.map(statusOf),
        Stream.runCollect,
        provideStorage(storage),
        Effect.forkChild
      )

      yield* TestClock.adjust("1 second")
      yield* client.send(Events.Add({ amount: 1 }))
      yield* TestClock.adjust("1 second")
      // Two commits between reads: the reader sees the latest of them only.
      yield* client.send(Events.Add({ amount: 1 }))
      yield* client.send(Events.Add({ amount: 1 }))
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("1 second")
      yield* client.send(Events.Finish())
      yield* TestClock.adjust("1 second")

      assert.deepStrictEqual(yield* Fiber.join(seen), ["active@1", "active@3", "done@4"])
    }).pipe(Effect.scoped))

  it.effect("joins the output, and fails with the stored failure", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      const { client } = runner
      const joined = yield* client.join.pipe(provideStorage(storage), Effect.forkChild)
      yield* client.send(Events.Add({ amount: 5 }))
      yield* TestClock.adjust("1 second")
      assert.isUndefined(joined.pollUnsafe())
      yield* client.send(Events.Finish())
      yield* TestClock.adjust("1 second")
      assert.strictEqual(yield* Fiber.join(joined), 5)

      overwrite(storage, { status: { _tag: "Failed", failure: "The machine failed" } })
      const failed = yield* Effect.flip(client.join.pipe(provideStorage(storage)))
      assert.strictEqual(failed._tag, "MachineFailedError")
      assert.strictEqual(failed._tag === "MachineFailedError" && failed.failure, "The machine failed")
      const snapshot = Option.getOrThrow(yield* client.snapshot.pipe(provideStorage(storage)))
      assert.strictEqual(snapshot.status, "failed")
    }).pipe(Effect.scoped))

  it.effect("refuses a checkpoint of another version, or one it cannot hold", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      const { client } = runner
      yield* client.send(Events.Add({ amount: 1 }))

      overwrite(storage, { version: "2" })
      const version = yield* Effect.flip(client.snapshot.pipe(provideStorage(storage)))
      assert.strictEqual(version._tag === "ReadError" && version.reason, "VersionMismatch")

      overwrite(storage, { version: "1", snapshot: { _tag: "Counting", count: "many" } })
      const invalid = yield* Effect.flip(client.changes.pipe(Stream.runHead, provideStorage(storage)))
      assert.strictEqual(invalid._tag === "ReadError" && invalid.reason, "InvalidCheckpoint")
    }).pipe(Effect.scoped))

  it.effect("reads from the store without the entity, and follows it across runners", () =>
    Effect.gen(function*() {
      const storage = makeTestStorage()
      const messages = yield* makeMessages
      const first = yield* startRunner(machine, storage, messages)
      const { client } = first
      yield* first.client.send(Events.Add({ amount: 3 }))
      const joined = yield* client.join.pipe(provideStorage(storage), Effect.forkChild)

      // No runner hosts the entity, and the reader goes on reading the store.
      yield* first.stop
      yield* TestClock.adjust("5 seconds")
      const stored = Option.getOrThrow(yield* client.snapshot.pipe(provideStorage(storage)))
      assert.strictEqual(statusOf(stored), "active@1")
      assert.isUndefined(joined.pollUnsafe())

      const second = yield* startRunner(machine, storage, messages)
      yield* second.client.send(Events.Finish())
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(yield* Fiber.await(joined), Exit.succeed(3))
    }).pipe(Effect.scoped))
})
