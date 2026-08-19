import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Schema, Stream } from "effect"
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
class Collecting extends Schema.TaggedClass<Collecting>("InvokeCollecting")("Collecting", {
  values: Schema.Array(Schema.Number)
}) {}
class Add extends Schema.TaggedClass<Add>("InvokeAdd")("Add", {
  value: Schema.Number
}) {}
class FinishStream extends Schema.TaggedClass<FinishStream>("InvokeFinishStream")("FinishStream", {
  value: Schema.Number
}) {}

const States = Machine.states({ Idle, Loading, Complete, Failed })

describe("inline invoke", () => {
  it.effect("ignores an invocation outcome when its transition declines", () =>
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
            effect: () => Effect.succeed("ignored"),
            onDone: (to) => to.full.Complete().resolve(({ decline }) => decline(), { declinable: true })
          })
        },
        Complete: {},
        Failed: {},
        Idle: {}
      })

      assert.strictEqual(Machine.transitionDefinitions(machine)[0]?.acceptance, "declinable")
      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow
      assert.deepStrictEqual(yield* ref.state, { path: "Loading" as const, value: new Loading({}) })
    }))

  it.effect("handles Stream elements sequentially before completion", () =>
    Effect.gen(function*() {
      const states = Machine.states({ Collecting, Complete })
      const definition = Machine.make({
        states: states.states,
        events: Machine.events(Add),
        initial: {
          target: (to) => to.Collecting(),
          resolve: ({ target }) => target(new Collecting({ values: [] }))
        }
      })
      const machine = definition.handle({
        Collecting: {
          invoke: Machine.invoke({
            id: "numbers",
            stream: () => Stream.fromIterable([1, 2, 3]),
            onElement: {
              target: Machine.targetless,
              resolve: ({ element }, enqueue) => {
                enqueue.raise(new Add({ value: element }))
              }
            },
            onDone: (to) =>
              to.full.Complete().resolve(({ state, target }) => target(new Complete({ value: state.values.join(",") })))
          }),
          on: {
            Add: (to) =>
              to.full.Collecting().resolve(({ event, state, target }) =>
                target(new Collecting({ values: [...state.values, event.value] }))
              )
          }
        },
        Complete: {}
      })

      assert.deepStrictEqual(Machine.transitionDefinitions(machine), [
        {
          source: "Collecting",
          trigger: { type: "event", event: "Add" },
          reenter: false,
          acceptance: "required",
          branches: [{
            type: "direct",
            target: "Collecting",
            selection: { path: "Collecting", kind: "state", scope: "full" }
          }]
        },
        {
          source: "Collecting",
          trigger: { type: "invoke", id: "numbers", outcome: "element" },
          reenter: false,
          acceptance: "required",
          branches: [{
            type: "direct",
            target: undefined,
            selection: { path: undefined, kind: "none", scope: "local" }
          }]
        },
        {
          source: "Collecting",
          trigger: { type: "invoke", id: "numbers", outcome: "done" },
          reenter: false,
          acceptance: "required",
          branches: [{
            type: "direct",
            target: "Complete",
            selection: { path: "Complete", kind: "state", scope: "full" }
          }]
        }
      ])

      const ref = yield* Machine.start(machine)
      yield* ref.changes.pipe(
        Stream.filter((snapshot) => snapshot.state.path === "Complete"),
        Stream.take(1),
        Stream.runDrain
      )
      assert.deepStrictEqual(yield* ref.state, {
        path: "Complete" as const,
        value: new Complete({ value: "1,2,3" })
      })
    }))

  it.effect("routes a Stream typed failure through onFailure", () =>
    Effect.gen(function*() {
      const definition = Machine.make({
        states: States.states,
        events: Machine.events(),
        initial: {
          target: (to) => to.Loading(),
          resolve: ({ target }) => target.from()
        }
      })
      const machine = definition.handle({
        Loading: {
          invoke: Machine.invoke({
            id: "updates",
            stream: () => Stream.fail("offline"),
            onDone: { target: Machine.targetless },
            onFailure: (to) => to.full.Failed().resolve(({ error, target }) => target(new Failed({ message: error })))
          })
        },
        Complete: {},
        Failed: {}
      })

      const ref = yield* Machine.start(machine)
      yield* ref.changes.pipe(
        Stream.filter((snapshot) => snapshot.state.path === "Failed"),
        Stream.take(1),
        Stream.runDrain
      )
      assert.deepStrictEqual(yield* ref.state, {
        path: "Failed" as const,
        value: new Failed({ message: "offline" })
      })
    }))

  it.effect("fails the owning machine when a Stream defects", () =>
    Effect.gen(function*() {
      const defect = new Error("stream defect")
      const definition = Machine.make({
        states: States.states,
        events: Machine.events(),
        initial: {
          target: (to) => to.Loading(),
          resolve: ({ target }) => target.from()
        }
      })
      const machine = definition.handle({
        Loading: {
          invoke: Machine.invoke({
            id: "updates",
            stream: () => Stream.die(defect),
            onDone: { target: Machine.targetless }
          })
        },
        Complete: {},
        Failed: {}
      })

      const ref = yield* Machine.start(machine)
      yield* ref.changes.pipe(Stream.runDrain)
      const snapshot = yield* ref.snapshot
      assert.strictEqual(snapshot.status, "error")
      if (snapshot.status !== "error") return assert.fail("expected an error snapshot")
      assert.strictEqual(Cause.squash(snapshot.cause), defect)
    }))

  it.effect("interrupts a Stream before pulling another element after its owner exits", () =>
    Effect.gen(function*() {
      let pulls = 0
      let finalized = false
      const source = Stream.fromEffect(Effect.sync(() => ++pulls)).pipe(
        Stream.forever,
        Stream.ensuring(Effect.sync(() => {
          finalized = true
        }))
      )
      const definition = Machine.make({
        states: States.states,
        events: Machine.events(FinishStream),
        initial: {
          target: (to) => to.Loading(),
          resolve: ({ target }) => target.from()
        }
      })
      const machine = definition.handle({
        Loading: {
          invoke: Machine.invoke({
            id: "updates",
            stream: () => source,
            onElement: {
              target: Machine.targetless,
              resolve: ({ element }, enqueue) => {
                enqueue.raise(new FinishStream({ value: element }))
              }
            },
            onDone: { target: Machine.targetless }
          }),
          on: {
            FinishStream: (to) =>
              to.full.Complete().resolve(({ event, target }) => target(new Complete({ value: String(event.value) })))
          }
        },
        Complete: {},
        Failed: {}
      })

      const ref = yield* Machine.start(machine)
      yield* ref.changes.pipe(
        Stream.filter((snapshot) => snapshot.state.path === "Complete"),
        Stream.take(1),
        Stream.runDrain
      )
      yield* Effect.yieldNow
      assert.strictEqual(pulls, 1)
      assert.isTrue(finalized)
      yield* ref.stop
    }))

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
            onDone: (to) => to.full.Complete().resolve(({ output, target }) => target(new Complete({ value: output })))
          })
        },
        Complete: {},
        Failed: {}
      })

      assert.deepStrictEqual(Machine.transitionDefinitions(machine), [{
        source: "Loading",
        trigger: { type: "invoke", id: "load", outcome: "done" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: "Complete",
          selection: { path: "Complete", kind: "state", scope: "full" }
        }]
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
            onFailure: (to) => to.full.Failed().resolve(({ error, target }) => target(new Failed({ message: error })))
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
            Start: (to) => to.full.Loading().resolve(({ target }) => target.from())
          }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "load",
            effect: (): Effect.Effect<string> => {
              throw defect
            },
            onDone: { target: Machine.targetless }
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
            Start: (to) => to.full.Loading().resolve(({ target }) => target.from())
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
