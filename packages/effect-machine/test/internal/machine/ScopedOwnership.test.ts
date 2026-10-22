import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Scope, Stream } from "effect"
import { Machine } from "../../../src/index.js"

const Events = Machine.events({ Finish: {} })
const machine = Machine.make({
  root: Machine.state({ states: { Idle: {}, Done: { type: "final" } } }),
  events: Events
}).handle({
  initial: { target: "Idle" },
  states: { Idle: { on: { Finish: { target: "Done" } } }, Done: {} }
})

type ScopeState = { readonly _tag: string; readonly finalizers?: Map<unknown, unknown> }

const finalizerCount = (scope: Scope.Closeable): number => {
  const state = (scope as unknown as { readonly state: ScopeState }).state
  return state._tag === "Empty" || state._tag === "Closed" ? 0 : state.finalizers?.size ?? 1
}

describe("Machine scoped ownership", () => {
  it.effect("an owning scope holds one finalizer and releases terminated machines", () =>
    Effect.gen(function*() {
      const owner = yield* Scope.make()
      const stopped = yield* Machine.start(machine).pipe(Scope.provide(owner))
      const completed = yield* Machine.start(machine).pipe(Scope.provide(owner))
      const running = yield* Machine.start(machine).pipe(Scope.provide(owner))
      assert.strictEqual(finalizerCount(owner), 1)
      yield* stopped.stop
      yield* completed.send(Events.Finish())
      yield* completed.join
      assert.strictEqual(finalizerCount(owner), 1)
      yield* Scope.close(owner, Exit.void)
      assert.strictEqual((yield* running.snapshot).status, "stopped")
      assert.strictEqual(finalizerCount(owner), 0)
    }))

  it.effect("closing the owning scope stops live machines in reverse start order", () =>
    Effect.gen(function*() {
      const owner = yield* Scope.make()
      const order: Array<string> = []
      const refs = yield* Effect.forEach(["first", "second", "third"], (name) =>
        Effect.gen(function*() {
          const ref = yield* Machine.start(machine).pipe(Scope.provide(owner))
          yield* Machine.watch(ref).pipe(
            Stream.runForEach(() => Effect.sync(() => order.push(name))),
            Effect.forkChild({ startImmediately: true })
          )
          return ref
        }))
      yield* Scope.close(owner, Exit.void)
      for (const ref of refs) assert.strictEqual((yield* ref.snapshot).status, "stopped")
      assert.deepStrictEqual(order, ["third", "second", "first"])
    }))

  it.effect("starting inside a closed scope stops the machine immediately", () =>
    Effect.gen(function*() {
      const owner = yield* Scope.make()
      yield* Scope.close(owner, Exit.void)
      const ref = yield* Machine.start(machine).pipe(Scope.provide(owner))
      assert.strictEqual((yield* ref.snapshot).status, "stopped")
      const again = yield* Machine.start(machine).pipe(Scope.provide(owner))
      assert.strictEqual((yield* again.snapshot).status, "stopped")
    }))
})
