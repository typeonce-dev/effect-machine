import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Stream } from "effect"
import { EventEmitter } from "node:events"
import { vi } from "vitest"
import { acquireWatcher } from "../src/internal/devServer.js"
import type { MachineRegistry } from "../src/MachineRegistry.js"

vi.mock("chokidar", () => ({ watch: () => currentWatcher }))

class Watcher extends EventEmitter {
  closed = false
  async close() {
    this.closed = true
    this.removeAllListeners()
  }
}
let currentWatcher = new Watcher()
const options = { root: "/project", host: "127.0.0.1", port: 5173, debounce: 0 }
const snapshot = { protocolVersion: 2 as const, revision: 1, results: [] }

describe("file watcher scope", () => {
  it.effect("interrupts an in-flight inspection when the server scope closes", () =>
    Effect.gen(function*() {
      currentWatcher = new Watcher()
      const started = yield* Deferred.make<void>()
      let interrupted = false
      const registry: MachineRegistry["Service"] = {
        get: Effect.succeed(snapshot),
        changes: Stream.empty,
        refresh: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
            })
          )
        )
      }
      yield* Effect.gen(function*() {
        yield* acquireWatcher(options, registry)
        currentWatcher.emit("all", "change", "/project/workflow.ts")
        yield* Deferred.await(started)
      }).pipe(Effect.scoped)
      assert.isTrue(interrupted)
      assert.isTrue(currentWatcher.closed)
    }))

  it.effect("cancels a pending debounce timer on scope closure", () =>
    Effect.gen(function*() {
      currentWatcher = new Watcher()
      let refreshes = 0
      const registry: MachineRegistry["Service"] = {
        get: Effect.succeed(snapshot),
        changes: Stream.empty,
        refresh: Effect.sync(() => {
          refreshes++
          return snapshot
        })
      }
      yield* Effect.gen(function*() {
        yield* acquireWatcher(options, registry)
        currentWatcher.emit("all", "change", "/project/workflow.ts")
      }).pipe(Effect.scoped)
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)))
      assert.strictEqual(refreshes, 0)
      assert.isTrue(currentWatcher.closed)
    }))
})
