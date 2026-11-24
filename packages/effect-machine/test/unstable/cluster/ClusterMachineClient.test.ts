import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import { makeMessages, makeTestStorage, startRunner } from "./support/harness.js"

const Events = Machine.events({ Rename: { name: Schema.NonEmptyString }, Archive: {} })
const Internal = Machine.internalEvents({ Touched: {} })

const machine = Machine.make({
  root: Machine.state({
    states: {
      Draft: { fields: { name: Schema.String } },
      Archived: { type: "final" }
    }
  }),
  events: Events,
  internalEvents: Internal
}).handle({
  initial: { target: "Draft", data: { name: "untitled" } },
  states: {
    Draft: {
      on: {
        Rename: { target: "Draft", data: ({ event }) => ({ name: event.name }) },
        Archive: { target: "Archived" },
        Touched: { stay: true }
      }
    }
  }
})

/** The rejection that a send fails with. */
const rejection = <A, E extends { readonly _tag: string }>(send: Effect.Effect<A, E>) =>
  Effect.flatMap(Effect.flip(send), (error) =>
    error._tag === "Rejected"
      ? Effect.succeed(error as Extract<E, { readonly _tag: "Rejected" }>)
      : Effect.die(error))

const start = Effect.gen(function*() {
  const storage = makeTestStorage()
  const runner = yield* startRunner(machine, storage, yield* makeMessages)
  return { storage, runner }
})

describe("ClusterMachine.Client", () => {
  it.effect("takes an event built by a constructor of the protocol, and a plain one", () =>
    Effect.gen(function*() {
      const { runner } = yield* start
      assert.strictEqual(runner.client.entityId, "worker-1")
      yield* runner.client.send(Events.Rename({ name: "report" }))
      assert.include(JSON.stringify(runner.stored()?.snapshot), "\"report\"")
      yield* runner.client.send({ _tag: "Rename", name: "summary" })
      yield* runner.client.send(Events.Archive())
      assert.strictEqual(runner.stored()?.revision, 3)
    }).pipe(Effect.scoped))

  it.effect("rejects an event that its schema refuses before it sends it", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      const rejected = yield* rejection(runner.client.send({ _tag: "Rename", name: "" }))
      assert.strictEqual(rejected._tag, "Rejected")
      assert.strictEqual(rejected.reason, "InvalidEvent")
      assert.strictEqual(rejected.message, "The event Rename does not match its schema")
      assert.strictEqual(storage.commitAttempts, 0)
      yield* runner.client.send(Events.Rename({ name: "report" }))
      assert.strictEqual(storage.commits, 1)
    }).pipe(Effect.scoped))

  it.effect("rejects an event that is not an input event", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      const unknownTag = yield* rejection(runner.client.send({ _tag: "Unknown" }))
      assert.strictEqual(unknownTag.reason, "InvalidEvent")
      const internal = yield* rejection(runner.client.send(Internal.Touched() as never))
      assert.strictEqual(internal.reason, "InvalidEvent")
      assert.strictEqual(internal.message, "The event Touched is not an input event")
      assert.strictEqual(storage.commitAttempts, 0)
    }).pipe(Effect.scoped))

  it.effect("fails with the rejection of the machine", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      storage.failNextCommit()
      const rejected = yield* rejection(runner.client.send(Events.Archive()))
      assert.strictEqual(rejected.reason, "PersistenceFailure")
      yield* runner.client.send(Events.Archive())
    }).pipe(Effect.scoped))
})
