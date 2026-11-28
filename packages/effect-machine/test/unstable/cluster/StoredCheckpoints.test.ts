import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect } from "effect"
import { type MessageStorage, Snowflake } from "effect/cluster"
import { TestClock } from "effect/testing"
import { Machine } from "../../../src/index.js"
import type { ClusterMachine } from "../../../src/unstable/cluster/index.js"
import { makeMessages, makeTestStorage, startRunner, storageKey, type TestStorage } from "./support/harness.js"
import { makeStored } from "./support/stored.js"

/** Lets everything that does not wait for time happen. */
const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })

const parentKey = storageKey("Worker", "worker-1")
const childKey = storageKey("Worker/counter", "worker-1/counter/1")

const leafOf = (storage: TestStorage, key = parentKey) => storage.entries.get(key)?.snapshot.active.at(-1)

const progressOf = (storage: TestStorage) => {
  const status = storage.entries.get(parentKey)?.status
  return status?._tag === "Active" ? status.invocations : undefined
}

// Checkpoints exactly as the deployment before `Machine.toStep` hosted Cluster
// machines stored them for `makeStored`, at the times its runner ran.
const written = {
  waiting: {
    definitionId: "Stored",
    version: "1",
    revision: 1,
    origin: { _tag: "Request", requestId: Snowflake.Snowflake("-7280009827839901696") },
    snapshot: { _tag: "MachineSnapshot", version: 2, active: [{ path: "" }, { path: "Waiting" }] },
    status: { _tag: "Active", invocations: { Waiting: { wait: { _tag: "Waiting", dueAt: 11001 } } } }
  },
  settled: {
    definitionId: "Stored",
    version: "1",
    revision: 2,
    origin: { _tag: "Invocation", path: "Loading", id: "load" },
    snapshot: { _tag: "MachineSnapshot", version: 2, active: [{ path: "" }, { path: "Loading" }] },
    status: { _tag: "Active", invocations: { Loading: { load: { _tag: "Settled" } } } }
  },
  hosting: {
    definitionId: "Stored",
    version: "1",
    revision: 2,
    origin: { _tag: "Request", requestId: Snowflake.Snowflake("-7280009827839901692") },
    snapshot: { _tag: "MachineSnapshot", version: 2, active: [{ path: "" }, { path: "Hosting" }] },
    status: {
      _tag: "Active",
      invocations: { Hosting: { counter: { _tag: "Child", entityId: "worker-1/counter/1" } } }
    }
  },
  counting: {
    definitionId: "Counter",
    version: "1",
    revision: 2,
    origin: { _tag: "Request", requestId: Snowflake.Snowflake("-7280009827839901691") },
    snapshot: {
      _tag: "MachineSnapshot",
      version: 2,
      active: [{ path: "" }, { path: "Counting", value: { _tag: "Counting", count: 2 } }]
    },
    status: { _tag: "Active", invocations: {} }
  },
  failed: {
    definitionId: "Stored",
    version: "1",
    revision: 2,
    origin: { _tag: "Invocation", path: "Breaking", id: "break" },
    snapshot: { _tag: "MachineSnapshot", version: 2, active: [{ path: "" }, { path: "Breaking" }] },
    status: { _tag: "Failed", failure: "Error: broken" }
  }
} satisfies Record<string, ClusterMachine.Checkpoint>

const resume = Effect.fnUntraced(function*(checkpoints: ReadonlyArray<readonly [string, ClusterMachine.Checkpoint]>) {
  const storage = makeTestStorage()
  for (const [key, checkpoint] of checkpoints) storage.entries.set(key, checkpoint)
  const stored = makeStored()
  const runner = yield* startRunner(stored.machine, storage, yield* makeMessages)
  return { storage, runner, loads: stored.loads }
})

describe("ClusterMachine checkpoints stored by an earlier deployment", () => {
  it.effect("continue a timer that waits for its stored due time", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* resume([[parentKey, written.waiting]])
      // An event that no state handles brings the entity up, and is stored.
      assert.strictEqual((yield* runner.send({ _tag: "Note" }))._tag, "Accepted")
      assert.deepStrictEqual(progressOf(storage), { Waiting: { wait: { _tag: "Waiting", dueAt: 11001 } } })
      yield* TestClock.adjust(11000 - (yield* Clock.currentTimeMillis))
      yield* settle
      assert.deepStrictEqual(leafOf(storage), { path: "Waiting" })
      yield* TestClock.adjust(1)
      yield* settle
      assert.deepStrictEqual(leafOf(storage), { path: "Expired" })
      assert.deepStrictEqual(progressOf(storage), {})
    }).pipe(Effect.scoped))

  it.effect("do not run work that settled again", () =>
    Effect.gen(function*() {
      const { loads, runner, storage } = yield* resume([[parentKey, written.settled]])
      assert.strictEqual((yield* runner.send({ _tag: "Add", by: 1 }))._tag, "Accepted")
      yield* TestClock.adjust("1 minute")
      yield* settle
      assert.deepStrictEqual(loads, [])
      assert.deepStrictEqual(progressOf(storage), { Loading: { load: { _tag: "Settled" } } })
      assert.strictEqual((yield* runner.send({ _tag: "Note" }))._tag, "Accepted")
      assert.deepStrictEqual(leafOf(storage), { path: "Loaded" })
    }).pipe(Effect.scoped))

  it.effect("continue a child that runs, and apply its output", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* resume([[parentKey, written.hosting], [childKey, written.counting]])
      assert.strictEqual((yield* runner.send({ _tag: "Add", by: 3 }))._tag, "Accepted")
      yield* settle
      assert.deepStrictEqual(leafOf(storage, childKey), {
        path: "Counting",
        value: { _tag: "Counting", count: 5 }
      })
      assert.strictEqual((yield* runner.send({ _tag: "Finish" }))._tag, "Accepted")
      yield* settle
      assert.deepStrictEqual(leafOf(storage), { path: "Ready", value: { _tag: "Ready", result: "counted" } })
      // No other child was started.
      assert.deepStrictEqual(
        Array.from(storage.entries.keys()).filter((key) => key.startsWith("Worker/counter")),
        [childKey]
      )
    }).pipe(Effect.scoped))

  it.effect("keep a failed machine failed", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* resume([[parentKey, written.failed]])
      const rejected = yield* runner.send({ _tag: "Note" })
      assert(rejected._tag === "Rejected")
      assert.strictEqual(rejected.reason, "MachineFailed")
      assert.strictEqual(rejected.message, "Error: broken")
      assert.strictEqual(storage.entries.get(parentKey)?.revision, 2)
    }).pipe(Effect.scoped))
})

/**
 * Starts a runner whose transactions can hang once they have committed, then
 * crashes it there, before the work of the stored step starts, and starts
 * another runner over the same storages.
 */
const crashAfterCommit = Effect.fnUntraced(function*(event: object) {
  const storage = makeTestStorage()
  const messages = yield* makeMessages
  const stored = makeStored()
  // Only the transaction that commits the step hangs, not those of the runner.
  let crashAfter: number | undefined
  const withTransaction: MessageStorage.MessageStorage["Service"]["withTransaction"] = (effect) =>
    Effect.tap(
      messages.storage.withTransaction(effect),
      () => crashAfter !== undefined && storage.commits > crashAfter ? Effect.never : Effect.void
    )
  const first = yield* startRunner(stored.machine, storage, messages, { overrides: { withTransaction } })
  crashAfter = storage.commits
  yield* Effect.forkChild(first.send(event), { startImmediately: true })
  yield* settle
  yield* first.stop
  const committed = storage.entries.get(parentKey)
  // Nothing of the step ran.
  assert.deepStrictEqual(stored.loads, [])
  crashAfter = undefined
  const second = yield* startRunner(stored.machine, storage, messages)
  return { committed, loads: stored.loads, runner: second, storage }
})

describe("ClusterMachine recovery between the commit of a step and the start of its work", () => {
  it.effect("starts an effect once, with the initial lifecycle event", () =>
    Effect.gen(function*() {
      const { committed, loads, storage } = yield* crashAfterCommit({ _tag: "Load" })
      assert.deepStrictEqual(committed?.snapshot.active.at(-1), { path: "Loading" })
      yield* TestClock.adjust("10 seconds")
      yield* settle
      assert.strictEqual(loads.length, 1)
      assert.isTrue(Machine.isInitialEvent(loads[0]))
      assert.deepStrictEqual(progressOf(storage), { Loading: { load: { _tag: "Settled" } } })
    }).pipe(Effect.scoped))

  it.effect("starts a timer that waits for the due time stored with its step", () =>
    Effect.gen(function*() {
      const { committed, storage } = yield* crashAfterCommit({ _tag: "Wait" })
      const status = committed?.status
      const progress = status?._tag === "Active" ? status.invocations.Waiting?.wait : undefined
      assert(progress?._tag === "Waiting")
      const now = yield* Clock.currentTimeMillis
      assert.isAbove(now, progress.dueAt - 10_000)
      yield* TestClock.adjust(progress.dueAt - 1 - now)
      yield* settle
      assert.deepStrictEqual(leafOf(storage), { path: "Waiting" })
      yield* TestClock.adjust(1)
      yield* settle
      assert.deepStrictEqual(leafOf(storage), { path: "Expired" })
    }).pipe(Effect.scoped))
})
