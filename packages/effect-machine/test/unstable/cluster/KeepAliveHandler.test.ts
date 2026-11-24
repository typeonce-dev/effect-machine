import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Schema } from "effect"
import { Entity, MessageStorage } from "effect/cluster"
import { Machine } from "../../../src/index.js"
import { ClusterMachine } from "../../../src/unstable/cluster/index.js"
import { config } from "./support/harness.js"

const Events = Machine.events({ Load: {}, Cancel: {} })

const makeLoader = (result: Deferred.Deferred<string>) =>
  Machine.make({
    id: "Loader",
    root: Machine.state({
      states: { Idle: {}, Loading: {}, Loaded: { fields: { result: Schema.String } } }
    }),
    events: Events,
    effects: { load: Deferred.await(result) }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Load: { target: "Loading" } } },
      Loading: {
        invoke: { src: "load", onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) } },
        on: { Cancel: { target: "Idle" } }
      },
      Loaded: {}
    }
  })

/** Lets everything that does not wait for time happen. */
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })

const start = Effect.fnUntraced(function*() {
  const result = yield* Deferred.make<string>()
  const calls: Array<boolean> = []
  const adapter = ClusterMachine.make("Loader", makeLoader(result), { version: "1" })
  const layer = adapter.toLayer().pipe(
    Layer.provide(ClusterMachine.layerMemory),
    Layer.provide(MessageStorage.layerMemory),
    Layer.provide(Layer.succeed(Entity.KeepAliveHandler, (enabled) => Effect.sync(() => calls.push(enabled))))
  )
  const client = yield* (yield* Entity.makeTestClient(adapter.entity, layer))("loader-1")
  return { calls, client, result }
})

describe("ClusterMachine with an Entity.KeepAliveHandler", () => {
  it.effect("keeps the entity while its work runs, and lets it go once the work ends", () =>
    Effect.gen(function*() {
      const { calls, client, result } = yield* start()
      // An entity that comes up lets go of what a crashed one may have kept.
      yield* client.send({ _tag: "Load" })
      yield* settle
      assert.deepStrictEqual(calls, [false, true])
      yield* Deferred.succeed(result, "document")
      yield* settle
      assert.deepStrictEqual(calls, [false, true, false])
    }).pipe(Effect.scoped, Effect.provide(config())))

  it.effect("lets the entity go when its work is stopped", () =>
    Effect.gen(function*() {
      const { calls, client } = yield* start()
      yield* client.send({ _tag: "Load" })
      yield* settle
      yield* client.send({ _tag: "Cancel" })
      yield* settle
      assert.deepStrictEqual(calls, [false, true, false])
    }).pipe(Effect.scoped, Effect.provide(config())))

  it.effect("does not keep an entity that never has work", () =>
    Effect.gen(function*() {
      const { calls, client } = yield* start()
      yield* client.send({ _tag: "Cancel" })
      yield* settle
      assert.deepStrictEqual(calls, [false])
    }).pipe(Effect.scoped, Effect.provide(config())))
})
