import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"

class Loading extends Schema.TaggedClass<Loading>("InvokeLoading")("Loading", {}) {}
class Complete extends Schema.TaggedClass<Complete>("InvokeComplete")("Complete", {
  value: Schema.String
}) {}
class Failed extends Schema.TaggedClass<Failed>("InvokeFailed")("Failed", {
  message: Schema.String
}) {}
class Idle extends Schema.TaggedClass<Idle>("InvokeIdle")("Idle", {}) {}
class Start extends Schema.TaggedClass<Start>("InvokeStart")("Start", {}) {}

const States = Machine.defineStates({ Idle, Loading, Complete, Failed })

describe("inline invoke", () => {
  it.effect("plans a successful Effect outcome directly", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: States.states,
        events: Machine.events(),
        initial: {
          target: (to) => to.Loading(),
          resolve: ({ target }) => target.from()
        }
      }).handle({
        Loading: {
          invoke: Machine.invoke({
            id: "load",
            effect: () => Effect.succeed("ready"),
            onDone: Machine.transition({
              target: (to) => to.full.Complete(),
              resolve: ({ output, target }) => target(new Complete({ value: output }))
            })
          })
        },
        Complete: {},
        Failed: {}
      })

      assert.deepStrictEqual(Machine.transitionDefinitions(machine), [{
        source: "Loading",
        trigger: { type: "invoke", id: "load", outcome: "done" },
        reenter: false,
        branches: [{ type: "direct", target: "Complete" }]
      }])

      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow
      assert.deepStrictEqual(yield* ref.state, { path: "Complete" as const, value: new Complete({ value: "ready" }) })
    }))

  it.effect("plans a typed Effect failure directly", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: States.states,
        events: Machine.events(),
        initial: {
          target: (to) => to.Loading(),
          resolve: ({ target }) => target.from()
        }
      }).handle({
        Loading: {
          invoke: Machine.invoke({
            id: "load",
            effect: () => Effect.fail("offline"),
            onFailure: Machine.transition({
              target: (to) => to.full.Failed(),
              resolve: ({ error, target }) => target(new Failed({ message: error }))
            })
          })
        },
        Complete: {},
        Failed: {}
      })

      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow
      assert.deepStrictEqual(yield* ref.state, { path: "Failed" as const, value: new Failed({ message: "offline" }) })
    }))

  it.effect("fails the owning machine when an Effect source factory defects", () =>
    Effect.gen(function*() {
      const defect = new Error("source defect")
      const machine = Machine.make({
        states: States.states,
        events: Machine.events(Start),
        initial: {
          target: (to) => to.Idle(),
          resolve: ({ target }) => target.from()
        }
      }).handle({
        Idle: {
          on: {
            Start: Machine.transition({
              target: (to) => to.full.Loading(),
              resolve: ({ target }) => target.from()
            })
          }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "load",
            effect: (): Effect.Effect<string> => {
              throw defect
            },
            onDone: Machine.transition({
              target: (to) => to.none(),
              resolve: () => undefined
            })
          })
        },
        Complete: {},
        Failed: {}
      })

      const ref = yield* Machine.start(machine)
      yield* ref.send(new Start({}))
      for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow
      const snapshot = yield* ref.snapshot

      assert.strictEqual(snapshot.status, "error")
      if (snapshot.status !== "error") return assert.fail("expected an error snapshot")
      assert.strictEqual(Cause.squash(snapshot.cause), defect)
    }))

  it.effect("fails the owning machine when reusable logic cannot initialize", () =>
    Effect.gen(function*() {
      const failure = new Error("initialization failed")
      const logic = Machine.logic({
        initial: () => Effect.fail(failure),
        run: () => Effect.never
      })
      const machine = Machine.make({
        states: States.states,
        events: Machine.events(Start),
        initial: {
          target: (to) => to.Idle(),
          resolve: ({ target }) => target.from()
        }
      }).handle({
        Idle: {
          on: {
            Start: Machine.transition({
              target: (to) => to.full.Loading(),
              resolve: ({ target }) => target.from()
            })
          }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "worker",
            address: Machine.childAddress("worker"),
            logic
          })
        },
        Complete: {},
        Failed: {}
      })

      const ref = yield* Machine.start(machine)
      yield* ref.send(new Start({}))
      for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow
      const snapshot = yield* ref.snapshot

      assert.strictEqual(snapshot.status, "error")
      if (snapshot.status !== "error") return assert.fail("expected an error snapshot")
      assert.strictEqual(Cause.squash(snapshot.cause), failure)
    }))
})
