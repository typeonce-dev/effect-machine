import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Option, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../src/index.js"

const waitFor = <State, Event, Error, Output>(
  ref: Machine.MachineRef<State, Event, Error, Output>,
  predicate: (snapshot: Machine.RuntimeSnapshot<State, Error, Output>) => boolean
) =>
  ref.changes.pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((values) => Array.from(values)[0]!)
  )

const sendAndWait = <State, Event, Error, Output>(
  ref: Machine.MachineRef<State, Event, Error, Output>,
  event: Event,
  predicate: (snapshot: Machine.RuntimeSnapshot<State, Error, Output>) => boolean
) =>
  Effect.gen(function*() {
    const fiber = yield* waitFor(ref, predicate).pipe(Effect.forkChild)
    yield* ref.send(event)
    return yield* Fiber.join(fiber)
  })

class Count extends Schema.TaggedClass<Count>("Count")("Count", { value: Schema.Number }) {}
class Done extends Schema.TaggedClass<Done>("Done")("Done", { value: Schema.Number }) {}
class Add extends Schema.TaggedClass<Add>("Add")("Add", { value: Schema.Number }) {}
class Finish extends Schema.TaggedClass<Finish>("Finish")("Finish", {}) {}
class Ping extends Schema.TaggedClass<Ping>("Ping")("Ping", {}) {}
class Cancel extends Schema.TaggedClass<Cancel>("Cancel")("Cancel", {}) {}
class Timeout extends Schema.TaggedClass<Timeout>("Timeout")("Timeout", {}) {}

describe("Machine.resume", () => {
  it.effect("starts only active compound and parallel invokes in deterministic order", () =>
    Effect.gen(function*() {
      class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
      class Left extends Schema.TaggedClass<Left>("Left")("Left", {}) {}
      class LeftOn extends Schema.TaggedClass<LeftOn>("LeftOn")("LeftOn", {}) {}
      class Right extends Schema.TaggedClass<Right>("Right")("Right", {}) {}
      class RightOn extends Schema.TaggedClass<RightOn>("RightOn")("RightOn", {}) {}
      class Inactive extends Schema.TaggedClass<Inactive>("Inactive")("Inactive", {}) {}
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const restoredLogic = (label: string) =>
        Machine.logic({
          initial: () => Ref.update(starts, (labels) => [...labels, label]).pipe(Effect.as(label)),
          run: () => Effect.never
        })
      const states = Machine.states({
        Root: {
          schema: Root,
          type: "parallel",
          states: {
            left: {
              schema: Left,
              initial: "On",
              states: { On: LeftOn, Off: Inactive }
            },
            right: {
              schema: Right,
              initial: "On",
              states: { On: RightOn, Off: Inactive }
            }
          }
        },
        Inactive
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) => to.Inactive().resolve(({ target }) => target.decoded(new Inactive({})))
      }).handle({
        Root: {
          invoke: (from) => from.logic("root", { address: Machine.childAddress("root"), logic: restoredLogic("root") }),
          states: {
            left: {
              invoke: (from) =>
                from.logic("left", { address: Machine.childAddress("left"), logic: restoredLogic("left") }),
              states: {
                On: {
                  invoke: (from) =>
                    from.logic("left-leaf", {
                      address: Machine.childAddress("left-leaf"),
                      logic: restoredLogic("left-leaf")
                    })
                }
              }
            },
            right: {
              invoke: (from) =>
                from.logic("right", { address: Machine.childAddress("right"), logic: restoredLogic("right") }),
              states: {
                On: {
                  invoke: (from) =>
                    from.logic("right-leaf", {
                      address: Machine.childAddress("right-leaf"),
                      logic: restoredLogic("right-leaf")
                    })
                }
              }
            }
          }
        },
        Inactive: {
          invoke: (from) =>
            from.logic("inactive", { address: Machine.childAddress("inactive"), logic: restoredLogic("inactive") })
        }
      })
      const snapshot = {
        path: "Root" as const,
        value: new Root({}),
        states: {
          left: {
            path: "Root.left" as const,
            value: new Left({}),
            state: { path: "Root.left.On" as const, value: new LeftOn({}) }
          },
          right: {
            path: "Root.right" as const,
            value: new Right({}),
            state: { path: "Root.right.On" as const, value: new RightOn({}) }
          }
        }
      }

      const ref = yield* Machine.resume(machine, snapshot)
      yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })
      assert.deepStrictEqual(yield* ref.state, snapshot)
      assert.deepStrictEqual(yield* Ref.get(starts), ["root", "left", "right", "left-leaf", "right-leaf"])
      yield* ref.stop
    }))

  it.effect("preserves simultaneous parallel transition selection after resume", () =>
    Effect.gen(function*() {
      class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
      class Left extends Schema.TaggedClass<Left>("Left")("Left", {}) {}
      class LeftA extends Schema.TaggedClass<LeftA>("LeftA")("LeftA", {}) {}
      class LeftB extends Schema.TaggedClass<LeftB>("LeftB")("LeftB", {}) {}
      class Right extends Schema.TaggedClass<Right>("Right")("Right", {}) {}
      class RightA extends Schema.TaggedClass<RightA>("RightA")("RightA", {}) {}
      class RightB extends Schema.TaggedClass<RightB>("RightB")("RightB", {}) {}
      class Advance extends Schema.TaggedClass<Advance>("Advance")("Advance", {}) {}
      const states = Machine.states({
        Root: {
          schema: Root,
          type: "parallel",
          states: {
            left: { schema: Left, initial: "A", states: { A: LeftA, B: LeftB } },
            right: { schema: Right, initial: "A", states: { A: RightA, B: RightB } }
          }
        }
      })
      const initial = {
        path: "Root" as const,
        value: new Root({}),
        states: {
          left: {
            path: "Root.left" as const,
            value: new Left({}),
            state: { path: "Root.left.A" as const, value: new LeftA({}) }
          },
          right: {
            path: "Root.right" as const,
            value: new Right({}),
            state: { path: "Root.right.A" as const, value: new RightA({}) }
          }
        }
      }
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Advance),
        initial: (to) => to.Root.initial.resolve(() => initial)
      })
        .handle({
          Root: {
            states: {
              left: {
                states: {
                  A: {
                    on: {
                      Advance: (to) => to.local.B().resolve(({ target }) => target.decoded(new LeftB({})))
                    }
                  }
                }
              },
              right: {
                states: {
                  A: {
                    on: {
                      Advance: (to) => to.local.B().resolve(({ target }) => target.decoded(new RightB({})))
                    }
                  }
                }
              }
            }
          }
        })
      const ref = yield* Machine.resume(machine, initial)
      yield* sendAndWait(
        ref,
        new Advance({}),
        (snapshot) =>
          snapshot.state.path === "Root" &&
          snapshot.state.states.left.state.path === "Root.left.B" &&
          snapshot.state.states.right.state.path === "Root.right.B"
      )
      assert.deepStrictEqual(yield* ref.state, {
        path: "Root" as const,
        value: new Root({}),
        states: {
          left: {
            path: "Root.left" as const,
            value: new Left({}),
            state: { path: "Root.left.B" as const, value: new LeftB({}) }
          },
          right: {
            path: "Root.right" as const,
            value: new Right({}),
            state: { path: "Root.right.B" as const, value: new RightB({}) }
          }
        }
      })
      yield* ref.stop
    }))

  it.effect("resumes terminal snapshots as completed refs with current output", () =>
    Effect.gen(function*() {
      const states = Machine.states({
        Count,
        Done: { schema: Done, type: "final", output: Schema.Number }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Finish),
        initial: (to) => to.Count().resolve(({ target }) => target.decoded(new Count({ value: 0 })))
      }).handle({
        Count: {
          on: {
            Finish: (to) => to.full.Done().resolve(({ target }) => target.decoded(new Done({ value: 9 })))
          }
        },
        Done: { output: ({ state }) => state.value }
      })
      const logical = { path: "Done" as const, value: new Done({ value: 9 }) }
      const decoded = yield* Machine.decodeSnapshot(machine, yield* Machine.encodeSnapshot(machine, logical))
      const ref = yield* Machine.resume(machine, decoded)

      assert.strictEqual(yield* ref.join, 9)
      assert.deepStrictEqual(yield* ref.snapshot, { status: "done", state: decoded, output: 9 })
      assert.instanceOf(yield* Effect.flip(ref.send(new Finish({}))), Machine.StoppedError)
    }))

  it.effect("preserves completion metadata without retriggering historical onDone", () =>
    Effect.gen(function*() {
      class Flow extends Schema.TaggedClass<Flow>("Flow")("Flow", {}) {}
      class Finished extends Schema.TaggedClass<Finished>("Finished")("Finished", {}) {}
      class Next extends Schema.TaggedClass<Next>("Next")("Next", {}) {}
      const states = Machine.states({
        Flow: {
          schema: Flow,
          initial: "Finished",
          states: { Finished: { schema: Finished, type: "final" } }
        },
        Next
      })
      const logical: Machine.Machine.Snapshot<typeof states.states> = {
        path: "Flow" as const,
        value: new Flow({}),
        state: { path: "Flow.Finished" as const, value: new Finished({}) },
        completed: [
          { path: "Flow.Finished" as const, output: undefined },
          { path: "Flow" as const, output: undefined }
        ]
      }
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Ping),
        initial: (to) => to.Flow.initial.resolve(() => logical)
      })
        .handle({
          Flow: {
            onDone: (to) => to.full.Next().resolve(({ target }) => target.decoded(new Next({})))
          },
          Next: {}
        })
      const decoded = yield* Machine.decodeSnapshot(machine, yield* Machine.encodeSnapshot(machine, logical))
      const ref = yield* Machine.resume(machine, decoded)

      assert.deepStrictEqual(yield* ref.state, decoded)
      yield* ref.send(new Ping({}))
      yield* Effect.yieldNow
      assert.deepStrictEqual(yield* ref.state, decoded)
      yield* ref.stop
    }))

  it.effect("does not replay always transitions, including under a changed definition", () =>
    Effect.gen(function*() {
      class A extends Schema.TaggedClass<A>("A")("A", {}) {}
      class B extends Schema.TaggedClass<B>("B")("B", {}) {}
      const states = Machine.states({ A, B })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Ping),
        initial: (to) => to.A().resolve(({ target }) => target.decoded(new A({})))
      }).handle({
        A: {
          always: (to) => to.full.B().resolve(({ target }) => target.decoded(new B({})))
        },
        B: {}
      })

      const ref = yield* Machine.resume(machine, { path: "A" as const, value: new A({}) })
      assert.strictEqual((yield* ref.state).path, "A")
      yield* ref.send(new Ping({}))
      yield* Effect.yieldNow
      assert.strictEqual((yield* ref.state).path, "A")
      yield* ref.stop
    }))

  it.effect("restarts after timers at their full duration and cancels them on exit", () =>
    Effect.gen(function*() {
      class Waiting extends Schema.TaggedClass<Waiting>("Waiting")("Waiting", {}) {}
      class Cancelled extends Schema.TaggedClass<Cancelled>("Cancelled")("Cancelled", {}) {}
      class TimedOut extends Schema.TaggedClass<TimedOut>("TimedOut")("TimedOut", {}) {}
      const states = Machine.states({ Waiting, Cancelled, TimedOut })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Cancel),
        internalEvents: Machine.internalEvents(Timeout),
        initial: (to) => to.Cancelled().resolve(({ target }) => target.decoded(new Cancelled({})))
      }).handle({
        Waiting: {
          invoke: (from) =>
            from.timer("timeout", "1 second").onDone((to) =>
              to.full.TimedOut().resolve(({ target }) => target.decoded(new TimedOut({})))
            ),
          on: {
            Cancel: (to) => to.full.Cancelled().resolve(({ target }) => target.decoded(new Cancelled({})))
          }
        },
        Cancelled: {},
        TimedOut: {}
      })

      const first = yield* Machine.resume(machine, { path: "Waiting" as const, value: new Waiting({}) })
      yield* TestClock.adjust("999 millis")
      assert.strictEqual((yield* first.state).path, "Waiting")
      yield* TestClock.adjust("1 millis")
      yield* waitFor(first, (snapshot) => snapshot.state.path === "TimedOut")
      yield* first.stop

      const second = yield* Machine.resume(machine, { path: "Waiting" as const, value: new Waiting({}) })
      yield* sendAndWait(second, new Cancel({}), (snapshot) => snapshot.state.path === "Cancelled")
      yield* TestClock.adjust("1 second")
      assert.strictEqual((yield* second.state).path, "Cancelled")
      yield* second.stop
    }))

  it.effect("restarts an inline Effect once and handles its result through the normal runtime", () =>
    Effect.gen(function*() {
      class Loading extends Schema.TaggedClass<Loading>("Loading")("Loading", {}) {}
      class Loaded extends Schema.TaggedClass<Loaded>("Loaded")("Loaded", { value: Schema.String }) {}
      class LoadedEvent extends Schema.TaggedClass<LoadedEvent>("LoadedEvent")("LoadedEvent", {
        value: Schema.String
      }) {}
      const runs = yield* Ref.make(0)
      const states = Machine.states({ Loading, Loaded })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        internalEvents: Machine.internalEvents(LoadedEvent),
        initial: (to) => to.Loaded().resolve(({ target }) => target.decoded(new Loaded({ value: "initial" })))
      }).handle({
        Loading: {
          invoke: (from) =>
            from.effect("load", () => Ref.updateAndGet(runs, (n) => n + 1).pipe(Effect.as("fresh"))).onDone((to) =>
              to.full.Loaded().resolve(({ output, target }) => target.decoded(new Loaded({ value: output })))
            )
        },
        Loaded: {}
      })

      const ref = yield* Machine.resume(machine, { path: "Loading" as const, value: new Loading({}) })
      yield* waitFor(ref, (snapshot) => snapshot.state.path === "Loaded")
      assert.strictEqual(yield* Ref.get(runs), 1)
      assert.deepStrictEqual(yield* ref.state, { path: "Loaded" as const, value: new Loaded({ value: "fresh" }) })
      yield* ref.stop
    }))

  it.effect("handles a restarted inline Effect typed failure once", () =>
    Effect.gen(function*() {
      class Loading extends Schema.TaggedClass<Loading>("Loading")("Loading", {}) {}
      class Failed extends Schema.TaggedClass<Failed>("Failed")("Failed", { message: Schema.String }) {}
      class FailedEvent extends Schema.TaggedClass<FailedEvent>("FailedEvent")("FailedEvent", {
        message: Schema.String
      }) {}
      class LoadFailure extends Schema.TaggedError<LoadFailure>()("LoadFailure", {
        message: Schema.String
      }) {}
      const runs = yield* Ref.make(0)
      const states = Machine.states({ Loading, Failed })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        internalEvents: Machine.internalEvents(FailedEvent),
        initial: (to) => to.Failed().resolve(({ target }) => target.decoded(new Failed({ message: "initial" })))
      }).handle({
        Loading: {
          invoke: (from) =>
            from.effect("load", () =>
              Ref.update(runs, (n) => n + 1).pipe(
                Effect.andThen(Effect.fail(new LoadFailure({ message: "offline" })))
              )).onFailure((to) =>
                to.full.Failed().resolve(({ error, target }) => target.decoded(new Failed({ message: error.message })))
              )
        },
        Failed: {}
      })

      const ref = yield* Machine.resume(machine, { path: "Loading" as const, value: new Loading({}) })
      yield* waitFor(ref, (snapshot) => snapshot.state.path === "Failed")
      assert.strictEqual(yield* Ref.get(runs), 1)
      assert.deepStrictEqual(yield* ref.state, { path: "Failed" as const, value: new Failed({ message: "offline" }) })
      yield* ref.stop
    }))

  it.effect("starts an active invoked machine fresh and preserves child APIs", () =>
    Effect.gen(function*() {
      class Parent extends Schema.TaggedClass<Parent>("Parent")("Parent", {}) {}
      class ChildIdle extends Schema.TaggedClass<ChildIdle>("ChildIdle")("ChildIdle", { value: Schema.Number }) {}
      class ChildDone extends Schema.TaggedClass<ChildDone>("ChildDone")("ChildDone", { value: Schema.Number }) {}
      class ChildFinish extends Schema.TaggedClass<ChildFinish>("ChildFinish")("ChildFinish", {}) {}
      class ChildOutput extends Schema.TaggedClass<ChildOutput>("ChildOutput")("ChildOutput", {
        value: Schema.Number
      }) {}
      const childStates = Machine.states({
        ChildIdle,
        ChildDone: { schema: ChildDone, type: "final", output: Schema.Number }
      })
      const child = Machine.make({
        states: childStates.states,
        events: Machine.events(ChildFinish),
        initial: (to) => to.ChildIdle().resolve(({ target }) => target.decoded(new ChildIdle({ value: 1 })))
      }).handle({
        ChildIdle: {
          on: {
            ChildFinish: (to) =>
              to.full.ChildDone().resolve(({ state, target }) =>
                target.decoded(new ChildDone({ value: state.value + 1 }))
              )
          }
        },
        ChildDone: { output: ({ state }) => state.value }
      })
      const Child = Machine.child("child", child)
      const states = Machine.states({ Parent, ChildOutput })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(ChildOutput),
        initial: (to) => to.ChildOutput().resolve(({ target }) => target.decoded(new ChildOutput({ value: 0 })))
      }).handle({
        Parent: {
          invoke: (from) =>
            from.child(Child).onDone((to) =>
              to.full.ChildOutput().resolve(({ output, target }) => target.decoded(new ChildOutput({ value: output })))
            )
        },
        ChildOutput: {}
      })

      const ref = yield* Machine.resume(machine, { path: "Parent" as const, value: new Parent({}) })
      const active = yield* ref.childChanges(Child).pipe(
        Stream.filter(Option.isSome),
        Stream.take(1),
        Stream.runCollect,
        Effect.map((values) => values[0]!.value)
      )
      assert.deepStrictEqual(yield* active.state, { path: "ChildIdle" as const, value: new ChildIdle({ value: 1 }) })
      yield* active.send(new ChildFinish({}))
      yield* waitFor(ref, (snapshot) => snapshot.state.path === "ChildOutput")
      assert.deepStrictEqual(yield* ref.state, { path: "ChildOutput" as const, value: new ChildOutput({ value: 2 }) })
      assert(Option.isNone(yield* ref.child(Child)))
      yield* ref.stop
    }))

  it.effect("rejects forged logical snapshots through typed boundary errors", () =>
    Effect.gen(function*() {
      class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
      class Region extends Schema.TaggedClass<Region>("Region")("Region", {}) {}
      class Leaf extends Schema.TaggedClass<Leaf>("Leaf")("Leaf", { value: Schema.Number }) {}
      const states = Machine.states({
        Root: {
          schema: Root,
          type: "parallel",
          states: {
            left: { schema: Region, initial: "Leaf", states: { Leaf } },
            right: { schema: Region, initial: "Leaf", states: { Leaf } }
          }
        }
      })
      const valid = {
        path: "Root" as const,
        value: new Root({}),
        states: {
          left: {
            path: "Root.left" as const,
            value: new Region({}),
            state: { path: "Root.left.Leaf" as const, value: new Leaf({ value: 1 }) }
          },
          right: {
            path: "Root.right" as const,
            value: new Region({}),
            state: { path: "Root.right.Leaf" as const, value: new Leaf({ value: 2 }) }
          }
        }
      }
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) => to.Root.initial.resolve(() => valid)
      })
      const forged: ReadonlyArray<unknown> = [
        { path: "Missing" as const, value: {} },
        { path: "Root" as const, value: new Root({}), states: { left: valid.states.left } },
        {
          ...valid,
          states: {
            ...valid.states,
            left: { path: "Root.left" as const, value: new Region({}) }
          }
        },
        {
          ...valid,
          states: {
            ...valid.states,
            left: { ...valid.states.left, state: { ...valid.states.left.state, value: { _tag: "Leaf", value: "x" } } }
          }
        },
        { ...valid, completed: [{ path: "Root.left.Leaf" as const, output: undefined }] },
        { ...valid, completed: {} },
        { ...valid, history: { missing: { mode: "deep", active: [], values: {} } } }
      ]

      for (const snapshot of forged) {
        const exit = yield* Effect.exit(Machine.resume(machine, snapshot as typeof valid))
        assert(exit._tag === "Failure")
        const error = Cause.findErrorOption(exit.cause)
        assert(Option.isSome(error))
        assert.instanceOf(error.value, Machine.MachineSchemaDecodeError)
      }
    }))

  it.effect("obeys bounded encode/decode continuation equivalence", () =>
    Effect.gen(function*() {
      const states = Machine.states({ Count })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Add),
        initial: (to) => to.Count().resolve(({ target }) => target.decoded(new Count({ value: 0 })))
      }).handle({
        Count: {
          on: {
            Add: (to) =>
              to.full.Count().resolve(({ event, state, target }) =>
                target.decoded(new Count({ value: state.value + event.value }))
              )
          }
        }
      })
      const suffixes = [
        [],
        [1],
        [-1, 2],
        [3, 0, -2]
      ] as const

      for (const suffix of suffixes) {
        const uninterrupted = yield* Machine.start(machine)
        yield* sendAndWait(uninterrupted, new Add({ value: 5 }), (snapshot) => snapshot.state.value.value === 5)
        const boundary = yield* uninterrupted.state

        for (let index = 0; index < suffix.length; index++) {
          const expected = 5 + suffix.slice(0, index + 1).reduce<number>((sum, value) => sum + value, 0)
          yield* sendAndWait(
            uninterrupted,
            new Add({ value: suffix[index]! }),
            (snapshot) => snapshot.state.value.value === expected
          )
        }
        const expected = yield* uninterrupted.state

        const encoded = yield* Machine.encodeSnapshot(machine, boundary)
        const decoded = yield* Machine.decodeSnapshot(machine, JSON.parse(JSON.stringify(encoded)))
        const resumed = yield* Machine.resume(machine, decoded)
        for (let index = 0; index < suffix.length; index++) {
          const next = 5 + suffix.slice(0, index + 1).reduce<number>((sum, value) => sum + value, 0)
          yield* sendAndWait(
            resumed,
            new Add({ value: suffix[index]! }),
            (snapshot) => snapshot.state.value.value === next
          )
        }
        assert.deepStrictEqual(yield* resumed.state, expected)
        assert.deepStrictEqual(
          yield* Machine.encodeSnapshot(machine, yield* resumed.state),
          yield* Machine.encodeSnapshot(machine, expected)
        )
        yield* uninterrupted.stop
        yield* resumed.stop
      }
    }))
})
