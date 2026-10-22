import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Option, Queue, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"

class Squatting extends Schema.TaggedClass<Squatting>("InvocationIdsSquatting")("Squatting", {}) {}
class Running extends Schema.TaggedClass<Running>("InvocationIdsRunning")("Running", {
  rejected: Schema.String
}) {}
class Done extends Schema.TaggedClass<Done>("InvocationIdsDone")("Done", {}) {}
class Restart extends Schema.TaggedClass<Restart>("InvocationIdsRestart")("Restart", {}) {}
class Root extends Schema.TaggedClass<Root>("InvocationIdsRoot")("Root", {}) {}
class Left extends Schema.TaggedClass<Left>("InvocationIdsLeft")("Left", {}) {}
class Right extends Schema.TaggedClass<Right>("InvocationIdsRight")("Right", {}) {}
class Waiting extends Schema.TaggedClass<Waiting>("InvocationIdsWaiting")("Waiting", {}) {}
class Finished extends Schema.TaggedClass<Finished>("InvocationIdsFinished")("Finished", {}) {}
class ChildIdle extends Schema.TaggedClass<ChildIdle>("InvocationIdsChildIdle")("ChildIdle", {}) {}

const childMachine = Machine.make({
  root: Machine.state({ states: { ChildIdle } }),
  events: Machine.eventsFromSchemas()
}).handle({
  initial: { target: "ChildIdle" },
  states: { ChildIdle: {} }
})

const ParallelRegions = Machine.state({
  states: {
    Root: {
      schema: Root,
      type: "parallel",
      states: {
        left: { schema: Left, states: { waiting: Waiting, finished: { schema: Finished, type: "final" } } },
        right: { schema: Right, states: { waiting: Waiting, finished: { schema: Finished, type: "final" } } }
      }
    },
    Done: { schema: Done, type: "final", output: Schema.String }
  }
})

const parallelRegionsInitial = {
  target: "Root",
  decoded: true,
  data: new Root({})
} as const

const regionsInitial = {
  left: { decoded: true, data: new Left({}) },
  right: { decoded: true, data: new Right({}) }
} as const

describe("invocation ids", () => {
  it.effect("reserves runtime-owned invocation ids from caller-chosen child ids", () =>
    Effect.gen(function*() {
      const Squatter = Machine.childFamily(childMachine)
      const gate = yield* Deferred.make<void>()
      // The id the runtime assigns to the "work" Effect invocation of the "Running" state.
      const reservedId = "Machine.invocation:7:Runningwork"
      const root = Machine.state({
        states: { Squatting, Running, Done: { schema: Done, type: "final", output: Schema.String } }
      })
      const machine = Machine.make({
        effects: {
          squat: ({ children }: Machine.Machine.InvokeContext<
            { readonly "": typeof root.node },
            readonly [],
            readonly [],
            "Squatting",
            readonly [],
            readonly []
          >) => children.spawn(Squatter(reservedId)),
          work: Deferred.await(gate)
        },
        root,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: { target: "Squatting", decoded: true, data: new Squatting({}) },
        states: {
          Squatting: {
            invoke: {
              src: "squat",
              input: (context) => context,
              onDone: { target: "Running", decoded: true, data: () => new Running({ rejected: "none" }) },
              onFailure: {
                target: "Running",
                decoded: true,
                data: ({ error }) =>
                  new Running({
                    rejected: error._tag === "ChildAlreadyExistsError" ? `${error._tag}:${error.id}` : error._tag
                  })
              }
            }
          },
          Running: {
            invoke: {
              src: "work",
              onDone: { target: "Done" }
            }
          },
          Done: { output: () => "done" }
        }
      })
      const actor = yield* Machine.start(machine)
      const running = yield* actor.changes.pipe(
        Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.state.path === "Running"),
        Stream.runHead
      )
      assert.deepStrictEqual(
        Option.map(running, (snapshot) => snapshot.status === "active" ? snapshot.state.state.value : undefined),
        Option.some(new Running({ rejected: `ChildAlreadyExistsError:${reservedId}` }))
      )
      assert.isTrue(Option.isNone(yield* actor.child(Squatter(reservedId))))
      yield* Deferred.succeed(gate, undefined)
      assert.strictEqual(yield* actor.join, "done")
    }))

  it.effect("keeps runtime-owned ids distinct across parallel regions and reentry", () =>
    Effect.gen(function*() {
      const started = yield* Queue.unbounded<string>()
      const gate = yield* Deferred.make<void>()
      const machine = Machine.make({
        effects: {
          work: Queue.offer(started, "work").pipe(Effect.andThen(Deferred.await(gate)))
        },
        root: ParallelRegions,
        events: Machine.eventsFromSchemas(Restart)
      }).handle({
        initial: parallelRegionsInitial,
        states: {
          Root: {
            initial: regionsInitial,
            onDone: { target: "Done" },
            states: {
              left: {
                initial: { target: "Root.left.waiting", decoded: true, data: new Waiting({}) },
                states: {
                  waiting: {
                    invoke: { src: "work", onDone: { target: "Root.left.finished" } },
                    on: {
                      Restart: {
                        target: "Root.left.waiting",
                        reenter: true,
                        decoded: true,
                        data: () => new Waiting({})
                      }
                    }
                  },
                  finished: {}
                }
              },
              right: {
                initial: { target: "Root.right.waiting", decoded: true, data: new Waiting({}) },
                states: {
                  waiting: { invoke: { src: "work", onDone: { target: "Root.right.finished" } } },
                  finished: {}
                }
              }
            }
          },
          Done: { output: () => "done" }
        }
      })
      const actor = yield* Machine.start(machine)
      // Both regions run the same source under the same lifecycle id at once.
      assert.deepStrictEqual([yield* Queue.take(started), yield* Queue.take(started)], ["work", "work"])
      // Reentering restarts the invocation under the same runtime-owned id.
      for (let i = 0; i < 3; i++) {
        yield* actor.send(new Restart({}))
        assert.strictEqual(yield* Queue.take(started), "work")
      }
      yield* Deferred.succeed(gate, undefined)
      assert.strictEqual(yield* actor.join, "done")
    }))

  it.effect("rejects child machine invocations that collide across parallel regions", () =>
    Effect.gen(function*() {
      const Worker = Machine.child("worker", childMachine)
      const machine = Machine.make({
        children: { worker: Worker },
        root: ParallelRegions,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: parallelRegionsInitial,
        states: {
          Root: {
            initial: regionsInitial,
            onDone: { target: "Done" },
            states: {
              left: {
                initial: { target: "Root.left.waiting", decoded: true, data: new Waiting({}) },
                states: { waiting: { invoke: { src: "worker" } }, finished: {} }
              },
              right: {
                initial: { target: "Root.right.waiting", decoded: true, data: new Waiting({}) },
                states: { waiting: { invoke: { src: "worker" } }, finished: {} }
              }
            }
          },
          Done: { output: () => "done" }
        }
      })
      const actor = yield* Machine.start(machine)
      const error = yield* Effect.flip(actor.join)
      assert.instanceOf(error, Machine.ChildAlreadyExistsError)
      assert.strictEqual(error.id, "worker")
    }))

  it.effect("rejects addressed logic invocations that collide across parallel regions", () =>
    Effect.gen(function*() {
      const Shared = Machine.childAddress("shared")
      const machine = Machine.make({
        logic: { blocked: Machine.logic({ initial: undefined, run: () => Effect.never }) },
        root: ParallelRegions,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: parallelRegionsInitial,
        states: {
          Root: {
            initial: regionsInitial,
            onDone: { target: "Done" },
            states: {
              left: {
                initial: { target: "Root.left.waiting", decoded: true, data: new Waiting({}) },
                states: {
                  waiting: { invoke: { src: "blocked", id: "left", address: Shared } },
                  finished: {}
                }
              },
              right: {
                initial: { target: "Root.right.waiting", decoded: true, data: new Waiting({}) },
                states: {
                  waiting: { invoke: { src: "blocked", id: "right", address: Shared } },
                  finished: {}
                }
              }
            }
          },
          Done: { output: () => "done" }
        }
      })
      const actor = yield* Machine.start(machine)
      const error = yield* Effect.flip(actor.join)
      assert.instanceOf(error, Machine.ChildAlreadyExistsError)
      assert.strictEqual(error.id, "right")
    }))

  it("rejects one state's invocations that share a lifecycle id", () => {
    const Worker = Machine.child("worker", childMachine)
    const root = Machine.state({ states: { Running, Done } })
    const handle = (invoke: ReadonlyArray<object>) => () =>
      Machine.make({
        effects: { first: Effect.never, second: Effect.never },
        logic: { blocked: Machine.logic({ initial: undefined, run: () => Effect.never }) },
        children: { worker: Worker, alias: Worker },
        root,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: { target: "Running", decoded: true, data: new Running({ rejected: "none" }) },
        states: { Running: { invoke: invoke as any }, Done: {} }
      })
    assert.throws(handle([{ src: "first" }, { src: "first" }]), /distinct ids; "first" is declared twice/)
    assert.throws(
      handle([{ src: "first", id: "load" }, { src: "second", id: "load" }]),
      /distinct ids; "load" is declared twice/
    )
    assert.throws(
      handle([
        { src: "blocked", id: "load", address: Machine.childAddress("a") },
        { src: "first", id: "load" }
      ]),
      /distinct ids; "load" is declared twice/
    )
    assert.throws(handle([{ src: "worker" }, { src: "alias" }]), /distinct ids; "worker" is declared twice/)
    assert.doesNotThrow(handle([{ src: "first" }, { src: "second" }, { src: "worker" }]))
  })
})
