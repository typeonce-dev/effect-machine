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
const States = Machine.state({ states: { Idle, Loading, Complete, Failed } })
describe("inline invoke", () => {
  it("captures a timer with its completion channel", () => {
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(),
      timers: { timeout: "1 second" }
    }).handle({
      initial: {
        target: Machine.targets(States).root.Loading
      },
      states: {
        Idle: {},
        Loading: { invoke: { src: "timeout", onDone: { none: true } } },
        Complete: {},
        Failed: {}
      }
    })
    const definitions = Machine.transitionDefinitions(machine)
    assert.lengthOf(definitions, 1)
    assert.deepStrictEqual(definitions[0]?.trigger, { type: "invoke", id: "timeout", outcome: "done" })
  })
  it.effect("ignores an invocation outcome when its transition declines", () =>
    Effect.gen(function*() {
      const targets2 = Machine.targets(States)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets2.root.Complete } } },
        effects: { source1: Effect.suspend(() => Effect.succeed("ignored")) },
        root: States,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(States).root.Loading
        },
        states: {
          Idle: {},
          Loading: {
            invoke: {
              src: "source1",
              id: "load",
              onDone: { branches: "transition1", resolve: ({ decline }) => decline(), declinable: true }
            }
          },
          Complete: {},
          Failed: {}
        }
      })
      assert.strictEqual(Machine.transitionDefinitions(machine)[0]?.acceptance, "declinable")
      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) {
        yield* Effect.yieldNow
      }
      assert.deepStrictEqual((yield* ref.state).state, { path: "Loading" as const, value: new Loading({}) })
    }))
  it.effect("handles Stream elements sequentially before completion", () =>
    Effect.gen(function*() {
      const states = Machine.state({ states: { Collecting, Complete } })
      const targets3 = Machine.targets(states)
      const definition = Machine.make({
        streams: { source1: Stream.suspend(() => Stream.fromIterable([1, 2, 3])) },
        root: states,
        events: Machine.eventsFromSchemas(Add)
      })
      const machine = definition.handle({
        initial: {
          target: Machine.targets(states).root.Collecting,
          decoded: true,
          data: new Collecting({ values: [] })
        },
        states: {
          Collecting: {
            invoke: {
              src: "source1",
              id: "numbers",
              onElement: {
                none: true,
                resolve: ({ element }, enqueue) => {
                  enqueue.raise(new Add({ value: element }))
                }
              },
              onDone: {
                target: targets3.root.Complete,
                decoded: true,
                data: ({ state }) => (new Complete({ value: state.values.join(",") }))
              }
            },
            on: {
              Add: {
                target: targets3.root.Collecting,
                decoded: true,
                data: ({ event, state }) => (new Collecting({ values: [...state.values, event.value] }))
              }
            }
          },
          Complete: {}
        }
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
            selection: { path: "Collecting", kind: "state", scope: "branch" },
            updates: []
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
            selection: { path: undefined, kind: "none", scope: "local" },
            updates: []
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
            selection: { path: "Complete", kind: "state", scope: "branch" },
            updates: []
          }]
        }
      ])
      const ref = yield* Machine.start(machine)
      yield* ref.changes.pipe(
        Stream.filter((snapshot) => snapshot.state.state.path === "Complete"),
        Stream.take(1),
        Stream.runDrain
      )
      assert.deepStrictEqual((yield* ref.state).state, {
        path: "Complete" as const,
        value: new Complete({ value: "1,2,3" })
      })
    }))
  it.effect("routes a Stream typed failure through onFailure", () =>
    Effect.gen(function*() {
      const targets4 = Machine.targets(States)
      const definition = Machine.make({
        streams: { source1: Stream.suspend(() => Stream.fail("offline")) },
        root: States,
        events: Machine.eventsFromSchemas()
      })
      const machine = definition.handle({
        initial: {
          target: Machine.targets(States).root.Loading
        },
        states: {
          Idle: {},
          Loading: {
            invoke: {
              src: "source1",
              id: "updates",
              onDone: { none: true },
              onFailure: {
                target: targets4.root.Failed,
                decoded: true,
                data: ({ error }) => (new Failed({ message: error }))
              }
            }
          },
          Complete: {},
          Failed: {}
        }
      })
      const ref = yield* Machine.start(machine)
      yield* ref.changes.pipe(
        Stream.filter((snapshot) => snapshot.state.state.path === "Failed"),
        Stream.take(1),
        Stream.runDrain
      )
      assert.deepStrictEqual((yield* ref.state).state, {
        path: "Failed" as const,
        value: new Failed({ message: "offline" })
      })
    }))
  it.effect("fails the owning machine when a Stream defects", () =>
    Effect.gen(function*() {
      const defect = new Error("stream defect")
      const definition = Machine.make({
        streams: { source1: Stream.suspend(() => Stream.die(defect)) },
        root: States,
        events: Machine.eventsFromSchemas()
      })
      const machine = definition.handle({
        initial: {
          target: Machine.targets(States).root.Loading
        },
        states: {
          Idle: {},
          Loading: {
            invoke: { src: "source1", id: "updates", onDone: { none: true } }
          },
          Complete: {},
          Failed: {}
        }
      })
      const ref = yield* Machine.start(machine)
      yield* ref.changes.pipe(Stream.runDrain)
      const snapshot = yield* ref.snapshot
      assert.strictEqual(snapshot.status, "error")
      if (snapshot.status !== "error") {
        return assert.fail("expected an error snapshot")
      }
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
      const targets6 = Machine.targets(States)
      const definition = Machine.make({
        streams: { source1: Stream.suspend(() => source) },
        root: States,
        events: Machine.eventsFromSchemas(FinishStream)
      })
      const machine = definition.handle({
        initial: {
          target: Machine.targets(States).root.Loading
        },
        states: {
          Idle: {},
          Loading: {
            invoke: {
              src: "source1",
              id: "updates",
              onElement: {
                none: true,
                resolve: ({ element }, enqueue) => {
                  enqueue.raise(new FinishStream({ value: element }))
                }
              },
              onDone: { none: true }
            },
            on: {
              FinishStream: {
                target: targets6.root.Complete,
                decoded: true,
                data: ({ event }) => (new Complete({ value: String(event.value) }))
              }
            }
          },
          Complete: {},
          Failed: {}
        }
      })
      const ref = yield* Machine.start(machine)
      yield* ref.changes.pipe(
        Stream.filter((snapshot) => snapshot.state.state.path === "Complete"),
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
      const targets7 = Machine.targets(States)
      const machine = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.succeed("ready")) },
        root: States,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(States).root.Loading
        },
        states: {
          Idle: {},
          Loading: {
            invoke: {
              src: "source1",
              id: "load",
              onDone: {
                target: targets7.root.Complete,
                decoded: true,
                data: ({ output }) => (new Complete({ value: output }))
              }
            }
          },
          Complete: {},
          Failed: {}
        }
      })
      assert.deepStrictEqual(Machine.transitionDefinitions(machine), [{
        source: "Loading",
        trigger: { type: "invoke", id: "load", outcome: "done" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: "Complete",
          selection: { path: "Complete", kind: "state", scope: "branch" },
          updates: []
        }]
      }])
      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) {
        yield* Effect.yieldNow
      }
      assert.deepStrictEqual((yield* ref.state).state, {
        path: "Complete" as const,
        value: new Complete({ value: "ready" })
      })
    }))
  it.effect("plans a typed Effect failure directly", () =>
    Effect.gen(function*() {
      const targets8 = Machine.targets(States)
      const machine = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.fail("offline")) },
        root: States,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(States).root.Loading
        },
        states: {
          Idle: {},
          Loading: {
            invoke: {
              src: "source1",
              id: "load",
              onFailure: {
                target: targets8.root.Failed,
                decoded: true,
                data: ({ error }) => (new Failed({ message: error }))
              }
            }
          },
          Complete: {},
          Failed: {}
        }
      })
      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) {
        yield* Effect.yieldNow
      }
      assert.deepStrictEqual((yield* ref.state).state, {
        path: "Failed" as const,
        value: new Failed({ message: "offline" })
      })
    }))
  it.effect("fails the owning machine when an Effect source factory defects", () =>
    Effect.gen(function*() {
      const defect = new Error("source defect")
      const targets9 = Machine.targets(States)
      const machine = Machine.make({
        effects: {
          source1: Effect.suspend((): Effect.Effect<string> => {
            throw defect
          })
        },
        root: States,
        events: Machine.eventsFromSchemas(Start)
      }).handle({
        initial: {
          target: Machine.targets(States).root.Idle
        },
        states: {
          Idle: {
            on: {
              Start: { target: targets9.root.Loading }
            }
          },
          Loading: {
            invoke: { src: "source1", id: "load", onDone: { none: true } }
          },
          Complete: {},
          Failed: {}
        }
      })
      const ref = yield* Machine.start(machine)
      yield* ref.send(new Start({}))
      for (let index = 0; index < 5; index += 1) {
        yield* Effect.yieldNow
      }
      const snapshot = yield* ref.snapshot
      assert.strictEqual(snapshot.status, "error")
      if (snapshot.status !== "error") {
        return assert.fail("expected an error snapshot")
      }
      assert.strictEqual(Cause.squash(snapshot.cause), defect)
    }))
  it.effect("fails the owning machine when reusable logic cannot initialize", () =>
    Effect.gen(function*() {
      const failure = new Error("initialization failed")
      const logic = Machine.logic({
        initial: () => Effect.fail(failure),
        run: () => Effect.never
      })
      const targets10 = Machine.targets(States)
      const machine = Machine.make({
        logic: { source1: logic },
        root: States,
        events: Machine.eventsFromSchemas(Start)
      }).handle({
        initial: {
          target: Machine.targets(States).root.Idle
        },
        states: {
          Idle: {
            on: {
              Start: { target: targets10.root.Loading }
            }
          },
          Loading: {
            invoke: { src: "source1", id: "worker", address: Machine.childAddress("worker") }
          },
          Complete: {},
          Failed: {}
        }
      })
      const ref = yield* Machine.start(machine)
      yield* ref.send(new Start({}))
      for (let index = 0; index < 5; index += 1) {
        yield* Effect.yieldNow
      }
      const snapshot = yield* ref.snapshot
      assert.strictEqual(snapshot.status, "error")
      if (snapshot.status !== "error") {
        return assert.fail("expected an error snapshot")
      }
      assert.strictEqual(Cause.squash(snapshot.cause), failure)
    }))
})
