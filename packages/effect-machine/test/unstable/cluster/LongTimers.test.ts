import { assert, describe, it } from "@effect/vitest"
import { Clock, Duration, Effect, Schema } from "effect"
import { ClusterError, type MessageStorage } from "effect/cluster"
import { TestClock } from "effect/testing"
import { Machine } from "../../../src/index.js"
import type { ClusterMachine } from "../../../src/unstable/cluster/index.js"
import { makeMessages, makeTestStorage, startRunner, storageKey, type TestStorage } from "./support/harness.js"

const Events = Machine.events({ Wait: { seconds: Schema.Number }, Note: {}, Cancel: {} })

const timer = Machine.make({
  id: "Timer",
  root: Machine.state({
    states: {
      Idle: {},
      Waiting: { fields: { seconds: Schema.Number, notes: Schema.Number } },
      Expired: {}
    }
  }),
  events: Events,
  timers: { wait: (seconds: number) => Duration.seconds(seconds) }
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Wait: { target: "Waiting", data: ({ event }) => ({ seconds: event.seconds, notes: 0 }) } } },
    Waiting: {
      invoke: { src: "wait", input: ({ state }) => state.seconds, onDone: { target: "Expired" } },
      on: {
        Note: { update: { Waiting: ({ state }) => ({ ...state, notes: state.notes + 1 }) } },
        Cancel: { target: "Idle" }
      }
    },
    Expired: {}
  }
})

/** Lets everything that does not wait for time happen. */
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })
const advance = (duration: Duration.Input) => Effect.andThen(TestClock.adjust(duration), settle)
// The harness reads messages every five seconds, so a message is delivered up
// to that long after it is due.
const pollInterval = "5 seconds"

const leafOf = (storage: TestStorage) =>
  storage.entries.get(storageKey("Worker", "worker-1"))?.snapshot.active.at(-1)?.path

type Driver = MessageStorage.MemoryDriver["Service"]

const requestsOf = (driver: Driver, tag: string) =>
  driver.journal.filter((envelope) => envelope._tag === "Request" && envelope.tag === tag)
const unprocessedOf = (driver: Driver, tag: string) =>
  Array.from(driver.unprocessed).filter((envelope) => envelope._tag === "Request" && envelope.tag === tag)
const wakes = (driver: Driver) => requestsOf(driver, "wake")
const keptAlive = (driver: Driver) => unprocessedOf(driver, "Cluster/Entity/keepAlive").length

const send = (runner: { readonly client: ClusterMachine.Client<Machine.Machine.Any> }, event: object) =>
  Effect.orDie(runner.client.send(event as never))

const start = Effect.gen(function*() {
  const storage = makeTestStorage()
  const messages = yield* makeMessages
  const runner = yield* startRunner(timer, storage, messages, { idle: "30 seconds" })
  return { storage, messages, runner }
})

// Each test steps a TestClock through hours of polls, which takes seconds of
// real time on a loaded runner.
const timeout = 20_000

describe("ClusterMachine timers that wait longer than DurableClock keeps in memory", () => {
  it.effect("save one delayed message with the step, and keep nothing alive", () =>
    Effect.gen(function*() {
      const { messages, runner, storage } = yield* start
      const dueAt = (yield* Clock.currentTimeMillis) + 3_600_000
      yield* send(runner, { _tag: "Wait", seconds: 3600 })
      yield* settle
      const [wake, ...others] = wakes(messages.driver)
      assert.lengthOf(others, 0)
      assert.deepStrictEqual(
        wake?._tag === "Request" && wake.payload,
        { path: "Waiting", id: "wait", dueAt }
      )
      assert.strictEqual(
        messages.driver.requests.get(String(wake?._tag === "Request" && wake.requestId))?.deliverAt,
        dueAt
      )
      assert.strictEqual(storage.commits, 1)
      assert.strictEqual(keptAlive(messages.driver), 0)
      // A request that does not touch the timer saves no other message.
      yield* send(runner, { _tag: "Note" })
      yield* settle
      assert.lengthOf(wakes(messages.driver), 1)
    }).pipe(Effect.scoped), timeout)

  it.effect("let the entity leave memory, and bring it back when the timer is due", () =>
    Effect.gen(function*() {
      const { messages, runner, storage } = yield* start
      yield* send(runner, { _tag: "Wait", seconds: 3600 })
      yield* advance("1 minute")
      assert.strictEqual(yield* runner.sharding.activeEntityCount, 0)
      yield* advance("58 minutes")
      assert.strictEqual(leafOf(storage), "Waiting")
      assert.strictEqual(yield* runner.sharding.activeEntityCount, 0)
      yield* advance("1 minute")
      yield* advance(pollInterval)
      assert.strictEqual(leafOf(storage), "Expired")
      assert.lengthOf(unprocessedOf(messages.driver, "wake"), 0)
      assert.strictEqual(keptAlive(messages.driver), 0)
    }).pipe(Effect.scoped), timeout)

  it.effect("fire on another runner after the first one stops", () =>
    Effect.gen(function*() {
      const { messages, runner, storage } = yield* start
      yield* send(runner, { _tag: "Wait", seconds: 7200 })
      yield* settle
      yield* runner.stop
      yield* advance("1 hour")
      const second = yield* startRunner(timer, storage, messages, { idle: "30 seconds" })
      yield* advance("30 minutes")
      assert.strictEqual(leafOf(storage), "Waiting")
      assert.strictEqual(yield* second.sharding.activeEntityCount, 0)
      yield* advance("30 minutes")
      yield* advance(pollInterval)
      assert.strictEqual(leafOf(storage), "Expired")
    }).pipe(Effect.scoped), timeout)

  it.effect("ignore the message of an activation that ended", () =>
    Effect.gen(function*() {
      const { messages, runner, storage } = yield* start
      yield* send(runner, { _tag: "Wait", seconds: 600 })
      yield* advance("1 minute")
      yield* send(runner, { _tag: "Cancel" })
      yield* send(runner, { _tag: "Wait", seconds: 1200 })
      yield* advance("2 minutes")
      assert.lengthOf(wakes(messages.driver), 2)
      const commits = storage.commits
      // The first message is delivered, finds a timer that waits for another time,
      // and changes nothing.
      yield* advance("8 minutes")
      yield* advance(pollInterval)
      assert.lengthOf(unprocessedOf(messages.driver, "wake"), 1)
      assert.strictEqual(leafOf(storage), "Waiting")
      assert.strictEqual(storage.commits, commits)
      yield* advance("11 minutes")
      yield* advance(pollInterval)
      assert.strictEqual(leafOf(storage), "Expired")
      assert.lengthOf(unprocessedOf(messages.driver, "wake"), 0)
    }).pipe(Effect.scoped), timeout)

  it.effect("keep a short timer in memory, without a message", () =>
    Effect.gen(function*() {
      const { messages, runner, storage } = yield* start
      yield* send(runner, { _tag: "Wait", seconds: 45 })
      yield* settle
      assert.lengthOf(wakes(messages.driver), 0)
      assert.strictEqual(keptAlive(messages.driver), 1)
      yield* advance("45 seconds")
      assert.strictEqual(leafOf(storage), "Expired")
      assert.strictEqual(keptAlive(messages.driver), 0)
    }).pipe(Effect.scoped), timeout)

  it.effect("give a long wait stored without a message one at the next wake", () =>
    Effect.gen(function*() {
      const storage = makeTestStorage()
      const messages = yield* makeMessages
      // A runner that keeps every timer in memory stores the wait, as a
      // deployment before delayed messages did.
      const first = yield* startRunner(timer, storage, messages, { inMemoryThreshold: "1 day" })
      yield* send(first, { _tag: "Wait", seconds: 3600 })
      yield* settle
      assert.lengthOf(wakes(messages.driver), 0)
      assert.strictEqual(keptAlive(messages.driver), 1)
      yield* first.stop

      const second = yield* startRunner(timer, storage, messages, { idle: "30 seconds" })
      yield* advance("1 minute")
      assert.lengthOf(wakes(messages.driver), 1)
      assert.strictEqual(keptAlive(messages.driver), 0)
      assert.strictEqual(yield* second.sharding.activeEntityCount, 0)
      yield* advance("59 minutes")
      yield* advance(pollInterval)
      assert.strictEqual(leafOf(storage), "Expired")
    }).pipe(Effect.scoped), timeout)

  it.effect("reject the step when its message cannot be saved", () =>
    Effect.gen(function*() {
      const storage = makeTestStorage()
      const messages = yield* makeMessages
      let failing = true
      const runner = yield* startRunner(timer, storage, messages, {
        overrides: {
          saveRequest: (message) =>
            failing && message.envelope.tag === "wake"
              ? Effect.fail(new ClusterError.PersistenceError({ cause: new Error("message storage unavailable") }))
              : messages.storage.saveRequest(message)
        }
      })
      const rejected = yield* Effect.flip(runner.client.send({ _tag: "Wait", seconds: 3600 }))
      assert.strictEqual(rejected._tag === "Rejected" && rejected.reason, "PersistenceFailure")
      failing = false
      yield* send(runner, { _tag: "Wait", seconds: 3600 })
      yield* settle
      assert.lengthOf(wakes(messages.driver), 1)
    }).pipe(Effect.scoped), timeout)
})
