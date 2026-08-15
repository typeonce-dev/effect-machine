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
      const states = Machine.defineStates({
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
        events: [],
        initial: () => states.initial.Inactive(new Inactive({}))
      }).handle({
        Root: {
          invoke: Machine.invoke({
            id: "root",
            address: Machine.childAddress("root"),
            logic: restoredLogic("root")
          }),
          states: {
            left: {
              invoke: Machine.invoke({
                id: "left",
                address: Machine.childAddress("left"),
                logic: restoredLogic("left")
              }),
              states: {
                On: {
                  invoke: Machine.invoke({
                    id: "left-leaf",
                    address: Machine.childAddress("left-leaf"),
                    logic: restoredLogic("left-leaf")
                  })
                }
              }
            },
            right: {
              invoke: Machine.invoke({
                id: "right",
                address: Machine.childAddress("right"),
                logic: restoredLogic("right")
              }),
              states: {
                On: {
                  invoke: Machine.invoke({
                    id: "right-leaf",
                    address: Machine.childAddress("right-leaf"),
                    logic: restoredLogic("right-leaf")
                  })
                }
              }
            }
          }
        },
        Inactive: {
          invoke: Machine.invoke({
            id: "inactive",
            address: Machine.childAddress("inactive"),
            logic: restoredLogic("inactive")
          })
        }
      })
      const snapshot = states.initial.Root(new Root({}), (root) =>
        root
          .left(new Left({}), (left) => left.On(new LeftOn({})))
          .right(new Right({}), (right) => right.On(new RightOn({}))))

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
      const states = Machine.defineStates({
        Root: {
          schema: Root,
          type: "parallel",
          states: {
            left: { schema: Left, initial: "A", states: { A: LeftA, B: LeftB } },
            right: { schema: Right, initial: "A", states: { A: RightA, B: RightB } }
          }
        }
      })
      const initial = states.initial.Root(new Root({}), (root) =>
        root
          .left(new Left({}), (left) => left.A(new LeftA({})))
          .right(new Right({}), (right) => right.A(new RightA({}))))
      const machine = Machine.make({ states: states.states, events: [Advance], initial: () => initial }).handle({
        Root: {
          states: {
            left: {
              states: { A: { on: { Advance: ({ target }) => target.local.B(new LeftB({})) } } }
            },
            right: {
              states: { A: { on: { Advance: ({ target }) => target.local.B(new RightB({})) } } }
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
        path: "Root",
        value: new Root({}),
        states: {
          left: {
            path: "Root.left",
            value: new Left({}),
            state: { path: "Root.left.B", value: new LeftB({}) }
          },
          right: {
            path: "Root.right",
            value: new Right({}),
            state: { path: "Root.right.B", value: new RightB({}) }
          }
        }
      })
      yield* ref.stop
    }))

  it.effect("resumes terminal snapshots as completed refs with current output", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({
        Count,
        Done: { schema: Done, type: "final", output: Schema.Number }
      })
      const machine = Machine.make({
        states: states.states,
        events: [Finish],
        initial: () => states.initial.Count(new Count({ value: 0 }))
      }).handle({
        Count: { on: { Finish: ({ target }) => target.full.Done(new Done({ value: 9 })) } },
        Done: { output: ({ state }) => state.value }
      })
      const logical = states.initial.Done(new Done({ value: 9 }))
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
      const states = Machine.defineStates({
        Flow: {
          schema: Flow,
          initial: "Finished",
          states: { Finished: { schema: Finished, type: "final" } }
        },
        Next
      })
      const logical: Machine.Machine.Snapshot<typeof states.states> = {
        path: "Flow",
        value: new Flow({}),
        state: { path: "Flow.Finished", value: new Finished({}) },
        completed: [
          { path: "Flow.Finished", output: undefined },
          { path: "Flow", output: undefined }
        ]
      }
      const machine = Machine.make({ states: states.states, events: [Ping], initial: () => logical }).handle({
        Flow: { onDone: ({ target }) => target.full.Next(new Next({})) },
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
      const states = Machine.defineStates({ A, B })
      const machine = Machine.make({
        states: states.states,
        events: [Ping],
        initial: () => states.initial.A(new A({}))
      }).handle({
        A: { always: ({ target }) => target.full.B(new B({})) },
        B: {}
      })

      const ref = yield* Machine.resume(machine, states.initial.A(new A({})))
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
      const states = Machine.defineStates({ Waiting, Cancelled, TimedOut })
      const machine = Machine.make({
        states: states.states,
        events: [Cancel],
        internalEvents: [Timeout],
        initial: () => states.initial.Cancelled(new Cancelled({}))
      }).handle({
        Waiting: {
          invoke: Machine.invoke({
            id: "timeout",
            after: "1 second",
            onDone: ({ target }) => target.full.TimedOut(new TimedOut({}))
          }),
          on: {
            Cancel: ({ target }) => target.full.Cancelled(new Cancelled({}))
          }
        },
        Cancelled: {},
        TimedOut: {}
      })

      const first = yield* Machine.resume(machine, states.initial.Waiting(new Waiting({})))
      yield* TestClock.adjust("999 millis")
      assert.strictEqual((yield* first.state).path, "Waiting")
      yield* TestClock.adjust("1 millis")
      yield* waitFor(first, (snapshot) => snapshot.state.path === "TimedOut")
      yield* first.stop

      const second = yield* Machine.resume(machine, states.initial.Waiting(new Waiting({})))
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
      const states = Machine.defineStates({ Loading, Loaded })
      const machine = Machine.make({
        states: states.states,
        events: [],
        internalEvents: [LoadedEvent],
        initial: () => states.initial.Loaded(new Loaded({ value: "initial" }))
      }).handle({
        Loading: {
          invoke: Machine.invoke({
            id: "load",
            effect: Ref.updateAndGet(runs, (n) => n + 1).pipe(Effect.as("fresh")),
            onDone: ({ output, target }) => target.full.Loaded(new Loaded({ value: output }))
          })
        },
        Loaded: {}
      })

      const ref = yield* Machine.resume(machine, states.initial.Loading(new Loading({})))
      yield* waitFor(ref, (snapshot) => snapshot.state.path === "Loaded")
      assert.strictEqual(yield* Ref.get(runs), 1)
      assert.deepStrictEqual(yield* ref.state, states.initial.Loaded(new Loaded({ value: "fresh" })))
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
      const states = Machine.defineStates({ Loading, Failed })
      const machine = Machine.make({
        states: states.states,
        events: [],
        internalEvents: [FailedEvent],
        initial: () => states.initial.Failed(new Failed({ message: "initial" }))
      }).handle({
        Loading: {
          invoke: Machine.invoke({
            id: "load",
            effect: Ref.update(runs, (n) => n + 1).pipe(
              Effect.andThen(Effect.fail(new LoadFailure({ message: "offline" })))
            ),
            onFailure: ({ error, target }) => target.full.Failed(new Failed({ message: error.message }))
          })
        },
        Failed: {}
      })

      const ref = yield* Machine.resume(machine, states.initial.Loading(new Loading({})))
      yield* waitFor(ref, (snapshot) => snapshot.state.path === "Failed")
      assert.strictEqual(yield* Ref.get(runs), 1)
      assert.deepStrictEqual(yield* ref.state, states.initial.Failed(new Failed({ message: "offline" })))
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
      const childStates = Machine.defineStates({
        ChildIdle,
        ChildDone: { schema: ChildDone, type: "final", output: Schema.Number }
      })
      const child = Machine.make({
        states: childStates.states,
        events: [ChildFinish],
        initial: () => childStates.initial.ChildIdle(new ChildIdle({ value: 1 }))
      }).handle({
        ChildIdle: {
          on: { ChildFinish: ({ state, target }) => target.full.ChildDone(new ChildDone({ value: state.value + 1 })) }
        },
        ChildDone: { output: ({ state }) => state.value }
      })
      const Child = Machine.child("child", child)
      const states = Machine.defineStates({ Parent, ChildOutput })
      const machine = Machine.make({
        states: states.states,
        events: [ChildOutput],
        initial: () => states.initial.ChildOutput(new ChildOutput({ value: 0 }))
      }).handle({
        Parent: {
          invoke: Machine.invoke({
            child: Child,
            onDone: ({ output, target }) => target.full.ChildOutput(new ChildOutput({ value: output }))
          })
        },
        ChildOutput: {}
      })

      const ref = yield* Machine.resume(machine, states.initial.Parent(new Parent({})))
      const active = yield* ref.childChanges(Child).pipe(
        Stream.filter(Option.isSome),
        Stream.take(1),
        Stream.runCollect,
        Effect.map((values) => values[0]!.value)
      )
      assert.deepStrictEqual(yield* active.state, childStates.initial.ChildIdle(new ChildIdle({ value: 1 })))
      yield* active.send(new ChildFinish({}))
      yield* waitFor(ref, (snapshot) => snapshot.state.path === "ChildOutput")
      assert.deepStrictEqual(yield* ref.state, states.initial.ChildOutput(new ChildOutput({ value: 2 })))
      assert(Option.isNone(yield* ref.child(Child)))
      yield* ref.stop
    }))

  it.effect("rejects forged logical snapshots through typed boundary errors", () =>
    Effect.gen(function*() {
      class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
      class Region extends Schema.TaggedClass<Region>("Region")("Region", {}) {}
      class Leaf extends Schema.TaggedClass<Leaf>("Leaf")("Leaf", { value: Schema.Number }) {}
      const states = Machine.defineStates({
        Root: {
          schema: Root,
          type: "parallel",
          states: {
            left: { schema: Region, initial: "Leaf", states: { Leaf } },
            right: { schema: Region, initial: "Leaf", states: { Leaf } }
          }
        }
      })
      const valid = states.initial.Root(new Root({}), (root) =>
        root
          .left(new Region({}), (left) => left.Leaf(new Leaf({ value: 1 })))
          .right(new Region({}), (right) => right.Leaf(new Leaf({ value: 2 }))))
      const machine = Machine.make({ states: states.states, events: [], initial: () => valid })
      const forged: ReadonlyArray<unknown> = [
        { path: "Missing", value: {} },
        { path: "Root", value: new Root({}), states: { left: valid.states.left } },
        {
          ...valid,
          states: {
            ...valid.states,
            left: { path: "Root.left", value: new Region({}) }
          }
        },
        {
          ...valid,
          states: {
            ...valid.states,
            left: { ...valid.states.left, state: { ...valid.states.left.state, value: { _tag: "Leaf", value: "x" } } }
          }
        },
        { ...valid, completed: [{ path: "Root.left.Leaf", output: undefined }] },
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
      const states = Machine.defineStates({ Count })
      const machine = Machine.make({
        states: states.states,
        events: [Add],
        initial: () => states.initial.Count(new Count({ value: 0 }))
      }).handle({
        Count: {
          on: {
            Add: ({ event, state, target }) => target.full.Count(new Count({ value: state.value + event.value }))
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
