import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Data, Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
import { Machine } from "../src/index.js"
import { AtomMachine } from "../src/reactivity.js"

class Count extends Schema.TaggedClass<Count>("Count")("Count", {
  value: Schema.Number
}) {}

class Done extends Schema.TaggedClass<Done>("Done")("Done", {
  value: Schema.Number
}) {}

class Finish extends Schema.TaggedClass<Finish>("Finish")("Finish", {
  by: Schema.Number
}) {}

class ReadValue extends Schema.TaggedClass<ReadValue>("ReadValue")("ReadValue", {}) {}

class ValueRead extends Schema.TaggedClass<ValueRead>("ValueRead")("ValueRead", {
  value: Schema.String
}) {}

class Ready extends Schema.TaggedClass<Ready>("Ready")("Ready", {}) {}

class Editor extends Schema.TaggedClass<Editor>("Editor")("Editor", {}) {}

class Editing extends Schema.TaggedClass<Editing>("Editing")("Editing", {}) {}

class Saving extends Schema.TaggedClass<Saving>("Saving")("Saving", {}) {}

class Network extends Schema.TaggedClass<Network>("Network")("Network", {}) {}

class Online extends Schema.TaggedClass<Online>("Online")("Online", {}) {}

class Offline extends Schema.TaggedClass<Offline>("Offline")("Offline", {}) {}

class StartError extends Data.TaggedError("StartError")<{
  readonly reason: string
}> {}

class RuntimeError extends Data.TaggedError("RuntimeError")<{
  readonly reason: string
}> {}

class Multiplier extends Context.Service<Multiplier, {
  readonly multiply: (value: number) => number
}>()("test/AtomMachine/Multiplier") {}

const MachineInitial = Machine.defineStates({
  Count,
  Done: { schema: Done, type: "final" },
  ValueRead: { schema: ValueRead, type: "final" }
}).initial
const CounterStates = Machine.defineStates({
  Count,
  Done: { schema: Done, type: "final" }
})

const makeRegistry = Effect.acquireRelease(
  Effect.sync(() => AtomRegistry.make()),
  (registry) => Effect.sync(() => registry.dispose())
)

const mount = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>) =>
  Effect.acquireRelease(
    Effect.sync(() => registry.mount(atom)),
    (release) => Effect.sync(release)
  )

const waitForResult = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  predicate: (value: A) => boolean
) =>
  AtomRegistry.toStreamResult(registry, atom).pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((values) => Array.from(values)[0]!)
  )

const makeCounterMachine = () =>
  Machine.make({
    states: CounterStates.states,
    events: [Finish],
    initial: () => CounterStates.initial.Count(new Count({ value: 0 }))
  }).handle({
    Count: {
      on: {
        Finish: ({ state, event }) => MachineInitial.Count(new Count({ value: state.value + event.by }))
      }
    },
    Done: {}
  })

const makeFailingCounterMachine = () =>
  Machine.make({
    states: CounterStates.states,
    events: [Finish],
    initial: () => CounterStates.initial.Count(new Count({ value: 0 }))
  }).handle({
    Count: {
      on: {
        Finish: () => Effect.fail(new RuntimeError({ reason: "transition" }))
      }
    },
    Done: {}
  })

const makeDelayedCounterMachine = (release: Deferred.Deferred<void>) =>
  Machine.make({
    states: CounterStates.states,
    events: [Finish],
    initial: () =>
      Deferred.await(release).pipe(
        Effect.as(MachineInitial.Count(new Count({ value: 0 })))
      )
  }).handle({
    Count: {
      on: {
        Finish: ({ state, event }) => MachineInitial.Count(new Count({ value: state.value + event.by }))
      }
    },
    Done: {}
  })

describe("AtomMachine", () => {
  it.effect("reactively exposes an invoked child machine", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const childMachine = makeCounterMachine()
      const Child = Machine.child("counter", childMachine)
      const parent = Machine.make({
        states: { Count, ValueRead },
        events: [Finish, ReadValue],
        initial: () => MachineInitial.Count(new Count({ value: 0 }))
      }).handle({
        Count: {
          on: {
            Finish: () => MachineInitial.ValueRead(new ValueRead({ value: "active" }))
          }
        },
        ValueRead: {
          invoke: Machine.invokeMachine({ child: Child }),
          on: {
            ReadValue: () => MachineInitial.Count(new Count({ value: 0 }))
          }
        }
      })
      const parentAtoms = AtomMachine.make(parent)
      const childAtoms = parentAtoms.child(Child)
      assert.strictEqual(parentAtoms.child(Child), childAtoms)
      const Alias = Machine.child("counter", childMachine)
      const Impostor = Machine.child("counter", makeCounterMachine())
      const impostorAtoms = parentAtoms.child(Impostor)
      const selectedCount = AtomMachine.selectChild(childAtoms, "Count")
      const countMatches = AtomMachine.matchesChild(childAtoms, "Count")
      const parentRef = yield* AtomRegistry.getResult(registry, parentAtoms.ref)
      const directChild = yield* parentRef.child(Child)
      assert(Option.isNone(directChild))
      assert(Option.isNone(yield* AtomRegistry.getResult(registry, selectedCount)))
      assert.strictEqual(yield* AtomRegistry.getResult(registry, countMatches), false)
      yield* Effect.sync(() => registry.set(childAtoms.send, new Finish({ by: 1 })))
      const inactiveSend = yield* Effect.sync(() => registry.get(childAtoms.send))
      assert(AsyncResult.isFailure(inactiveSend))
      const inactiveSendError = Cause.findErrorOption(inactiveSend.cause)
      assert(Option.isSome(inactiveSendError))
      assert.instanceOf(inactiveSendError.value, AtomMachine.ChildNotActiveError)
      const childChange = yield* parentRef.childChanges(Child).pipe(
        Stream.filter(Option.isSome),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped
      )
      yield* mount(registry, childAtoms.state)
      yield* Effect.sync(() => registry.set(parentAtoms.send, new Finish({ by: 0 })))
      yield* waitForResult(registry, parentAtoms.state, (state) => state.path === "ValueRead")
      yield* Fiber.join(childChange)
      assert(Option.isSome(yield* parentRef.child(Child)))
      assert(Option.isSome(yield* parentRef.child(Alias)))
      assert(Option.isNone(yield* parentRef.child(Impostor)))
      assert(Option.isNone(yield* AtomRegistry.getResult(registry, impostorAtoms.state)))

      const initial = yield* waitForResult(registry, childAtoms.state, Option.isSome)
      assert(Option.isSome(initial))
      assert.strictEqual(initial.value.value.value, 0)
      const selectedInitial = yield* waitForResult(registry, selectedCount, Option.isSome)
      assert(Option.isSome(selectedInitial))
      assert.strictEqual(selectedInitial.value.value, 0)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, countMatches), true)

      yield* Effect.sync(() => registry.set(childAtoms.send, new Finish({ by: 2 })))
      const updated = yield* waitForResult(
        registry,
        childAtoms.state,
        (state) => Option.isSome(state) && state.value.value.value === 2
      )
      assert(Option.isSome(updated))
      const selectedUpdated = yield* waitForResult(
        registry,
        selectedCount,
        (state) => Option.isSome(state) && state.value.value === 2
      )
      assert(Option.isSome(selectedUpdated))
      assert.strictEqual(selectedUpdated.value.value, 2)

      yield* Effect.sync(() => registry.set(parentAtoms.send, new ReadValue({})))
      const inactive = yield* waitForResult(registry, childAtoms.ref, Option.isNone)
      assert(Option.isNone(inactive))
      assert(Option.isNone(yield* waitForResult(registry, selectedCount, Option.isNone)))
      assert.strictEqual(yield* AtomRegistry.getResult(registry, countMatches), false)
    })))

  it.effect("exposes invoked child runtime failures through result", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const Child = Machine.child("failing-counter", makeFailingCounterMachine())
      const parent = Machine.make({
        states: { Count, ValueRead },
        events: [Finish],
        initial: () => MachineInitial.Count(new Count({ value: 0 }))
      }).handle({
        Count: {
          on: {
            Finish: () => MachineInitial.ValueRead(new ValueRead({ value: "active" }))
          }
        },
        ValueRead: {
          invoke: Machine.invokeMachine({ child: Child })
        }
      })
      const parentAtoms = AtomMachine.make(parent)
      const childAtoms = parentAtoms.child(Child)
      yield* mount(registry, childAtoms.result)
      yield* AtomRegistry.getResult(registry, parentAtoms.ref)

      yield* Effect.sync(() => registry.set(parentAtoms.send, new Finish({ by: 0 })))
      const initial = yield* waitForResult(registry, childAtoms.result, Option.isSome)
      assert(Option.isSome(initial))
      assert.strictEqual(initial.value.value.value, 0)

      const failureFiber = yield* AtomRegistry.toStream(registry, childAtoms.result).pipe(
        Stream.filter(AsyncResult.isFailure),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.sync(() => registry.set(childAtoms.send, new Finish({ by: 1 })))

      const failed = Array.from(yield* Fiber.join(failureFiber))[0]!
      assert(AsyncResult.isFailure(failed))
      const error = Cause.findErrorOption(failed.cause)
      assert(Option.isSome(error))
      assert.instanceOf(error.value, RuntimeError)
      const previous = AsyncResult.value(failed)
      assert(Option.isSome(previous))
      assert.deepStrictEqual(previous.value, Option.some(initial.value))
    })))

  it.effect("exposes snapshots and sends events", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const bridge = AtomMachine.make(makeCounterMachine())
      yield* mount(registry, bridge.snapshot)

      const initial = yield* AtomRegistry.getResult(registry, bridge.snapshot)
      assert.deepStrictEqual(initial, {
        status: "active",
        state: {
          path: "Count",
          value: new Count({ value: 0 })
        }
      })

      yield* Effect.sync(() => registry.set(bridge.send, new Finish({ by: 2 })))

      const state = yield* waitForResult(registry, bridge.state, (state) => state.value.value === 2)
      assert.deepStrictEqual(state, {
        path: "Count",
        value: new Count({ value: 2 })
      })
    })))

  it.effect("exposes runtime failures without changing the legacy state atom", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const bridge = AtomMachine.make(makeFailingCounterMachine())
      yield* mount(registry, bridge.result)
      yield* mount(registry, bridge.state)

      const initial = yield* AtomRegistry.getResult(registry, bridge.result)
      assert.deepStrictEqual(initial, {
        path: "Count",
        value: new Count({ value: 0 })
      })

      const failureFiber = yield* AtomRegistry.toStream(registry, bridge.result).pipe(
        Stream.filter(AsyncResult.isFailure),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.sync(() => registry.set(bridge.send, new Finish({ by: 1 })))

      const failed = Array.from(yield* Fiber.join(failureFiber))[0]!
      assert(AsyncResult.isFailure(failed))
      const error = Cause.findErrorOption(failed.cause)
      assert(Option.isSome(error))
      assert.instanceOf(error.value, RuntimeError)
      const previous = AsyncResult.value(failed)
      assert(Option.isSome(previous))
      assert.deepStrictEqual(previous.value, initial)

      const state = yield* Effect.sync(() => registry.get(bridge.state))
      assert(AsyncResult.isSuccess(state))
      assert.deepStrictEqual(state.value, initial)
    })))

  it.effect("provides equality-aware typed state selectors", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const bridge = AtomMachine.make(makeCounterMachine())
      const selected = AtomMachine.select(bridge, "Count")
      const countMatches = AtomMachine.matches(bridge, "Count")
      const doneMatches = AtomMachine.matches(bridge, "Done")
      let doneMatchNotifications = 0

      yield* mount(registry, selected)
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registry.subscribe(doneMatches, () => {
            doneMatchNotifications++
          }, { immediate: true })
        ),
        (release) => Effect.sync(release)
      )
      const count = yield* AtomRegistry.getResult(registry, selected)
      assert(Option.isSome(count))
      assert.strictEqual(count.value.value, 0)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, countMatches), true)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, doneMatches), false)

      yield* Effect.sync(() => registry.set(bridge.send, new Finish({ by: 2 })))
      const updated = yield* waitForResult(
        registry,
        selected,
        (value) => Option.isSome(value) && value.value.value === 2
      )
      assert(Option.isSome(updated))
      assert.strictEqual(updated.value.value, 2)
      assert.strictEqual(doneMatchNotifications, 1)
    })))

  it.effect("selects compound and parallel state paths from the bridge snapshot", () =>
    Effect.scoped(Effect.gen(function*() {
      const states = Machine.defineStates({
        Ready: {
          schema: Ready,
          type: "parallel",
          states: {
            editor: {
              schema: Editor,
              initial: "Editing",
              states: {
                Editing,
                Saving
              }
            },
            network: {
              schema: Network,
              initial: "Online",
              states: {
                Online,
                Offline
              }
            }
          }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: [],
        initial: () =>
          states.initial.Ready(new Ready({}), (ready) =>
            ready
              .editor(new Editor({}), (editor) => editor.Editing(new Editing({})))
              .network(new Network({}), (network) => network.Online(new Online({}))))
      }).handle({
        Ready: {
          states: {
            editor: {
              states: {
                Editing: {},
                Saving: {}
              }
            },
            network: {
              states: {
                Online: {},
                Offline: {}
              }
            }
          }
        }
      })
      const registry = yield* makeRegistry
      const bridge = AtomMachine.make(machine)
      const ready = AtomMachine.select(bridge, "Ready")
      const editor = AtomMachine.select(bridge, "Ready.editor")
      const editing = AtomMachine.select(bridge, "Ready.editor.Editing")
      const saving = AtomMachine.select(bridge, "Ready.editor.Saving")
      const online = AtomMachine.matches(bridge, "Ready.network.Online")
      const offline = AtomMachine.matches(bridge, "Ready.network.Offline")

      assert(Option.isSome(yield* AtomRegistry.getResult(registry, ready)))
      assert(Option.isSome(yield* AtomRegistry.getResult(registry, editor)))
      assert(Option.isSome(yield* AtomRegistry.getResult(registry, editing)))
      assert(Option.isNone(yield* AtomRegistry.getResult(registry, saving)))
      assert.strictEqual(yield* AtomRegistry.getResult(registry, online), true)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, offline), false)
    })))

  it.effect("rejects sends while the machine is starting", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const release = yield* Deferred.make<void>()
      const bridge = AtomMachine.make(makeDelayedCounterMachine(release))
      yield* mount(registry, bridge.send)

      yield* Effect.sync(() => registry.set(bridge.send, new Finish({ by: 2 })))

      const result = yield* Effect.sync(() => registry.get(bridge.send))
      assert(AsyncResult.isFailure(result))
      const error = Cause.findErrorOption(result.cause)
      assert(Option.isSome(error))
      assert.instanceOf(error.value, AtomMachine.NotReadyError)

      yield* Deferred.succeed(release, void 0)
      const snapshot = yield* AtomRegistry.getResult(registry, bridge.snapshot)
      assert.deepStrictEqual(snapshot, {
        status: "active",
        state: {
          path: "Count",
          value: new Count({ value: 0 })
        }
      })
    })))

  it.effect("rejects stops while the machine is starting", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const release = yield* Deferred.make<void>()
      const bridge = AtomMachine.make(makeDelayedCounterMachine(release))
      yield* mount(registry, bridge.stop)

      yield* Effect.sync(() => registry.set(bridge.stop, undefined))

      const result = yield* Effect.sync(() => registry.get(bridge.stop))
      assert(AsyncResult.isFailure(result))
      const error = Cause.findErrorOption(result.cause)
      assert(Option.isSome(error))
      assert.instanceOf(error.value, AtomMachine.NotReadyError)

      yield* Deferred.succeed(release, void 0)
      const snapshot = yield* AtomRegistry.getResult(registry, bridge.snapshot)
      assert.deepStrictEqual(snapshot, {
        status: "active",
        state: {
          path: "Count",
          value: new Count({ value: 0 })
        }
      })
    })))

  it.effect("stops the machine when the registry is disposed", () =>
    Effect.gen(function*() {
      const registry = AtomRegistry.make()
      const bridge = AtomMachine.make(makeCounterMachine())
      const ref = yield* AtomRegistry.getResult(registry, bridge.ref)
      const watcher = yield* Machine.watch(ref).pipe(
        Stream.runCollect,
        Effect.forkScoped
      )

      yield* Effect.sync(() => registry.dispose())

      const events = Array.from(yield* Fiber.join(watcher))
      assert.strictEqual(events.length, 1)
      assert.strictEqual(events[0]?._tag, "Stopped")
    }))

  it.effect("stops the machine through the writable stop atom", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const bridge = AtomMachine.make(makeCounterMachine())
      yield* mount(registry, bridge.snapshot)
      yield* mount(registry, bridge.send)

      yield* AtomRegistry.getResult(registry, bridge.snapshot)
      yield* Effect.sync(() => registry.set(bridge.stop, undefined))

      const snapshot = yield* waitForResult(registry, bridge.snapshot, (snapshot) => snapshot.status === "stopped")
      assert.deepStrictEqual(snapshot, {
        status: "stopped",
        state: {
          path: "Count",
          value: new Count({ value: 0 })
        }
      })
    })))

  it.effect("keeps snapshot previous success when refresh startup fails", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const failOnStart = Atom.make(false)
      const machine = Machine.make({
        states: { Count },
        events: [Finish],
        initial: Effect.fn(function*() {
          const fail = yield* Atom.get(failOnStart)
          if (fail) {
            return yield* Effect.fail(new StartError({ reason: "refresh" }))
          }
          return MachineInitial.Count(new Count({ value: 0 }))
        })
      }).handle({
        Count: {}
      })
      const bridge = AtomMachine.make(machine)
      yield* mount(registry, bridge.snapshot)

      const initial = yield* AtomRegistry.getResult(registry, bridge.snapshot)
      assert.deepStrictEqual(initial, {
        status: "active",
        state: {
          path: "Count",
          value: new Count({ value: 0 })
        }
      })

      yield* Effect.sync(() => {
        registry.set(failOnStart, true)
        registry.refresh(bridge.ref)
      })

      const failed = yield* Effect.sync(() => registry.get(bridge.snapshot))
      assert(AsyncResult.isFailure(failed))
      const previous = AsyncResult.value(failed)
      assert(Option.isSome(previous))
      assert.deepStrictEqual(previous.value, {
        status: "stopped",
        state: {
          path: "Count",
          value: new Count({ value: 0 })
        }
      })
    })))

  it.effect("exposes stopped send failures through the writable send atom", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const bridge = AtomMachine.make(makeCounterMachine())
      yield* mount(registry, bridge.snapshot)

      yield* AtomRegistry.getResult(registry, bridge.snapshot)
      yield* Effect.sync(() => registry.set(bridge.stop, undefined))
      yield* waitForResult(registry, bridge.snapshot, (snapshot) => snapshot.status === "stopped")
      const failureFiber = yield* AtomRegistry.toStream(registry, bridge.send).pipe(
        Stream.filter(AsyncResult.isFailure),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.sync(() => registry.set(bridge.send, new Finish({ by: 1 })))

      const result = Array.from(yield* Fiber.join(failureFiber))[0]!
      assert.strictEqual(AsyncResult.isFailure(result), true)
      if (AsyncResult.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause)
        assert.strictEqual(Option.isSome(error), true)
        if (Option.isSome(error)) {
          assert.instanceOf(error.value, Machine.StoppedError)
        }
      }
    })))

  it.effect("runs a machine and exposes the final snapshot", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const machine = Machine.make({
        states: {
          Count,
          Done: {
            schema: Done,
            type: "final",
            output: Schema.Number
          }
        },
        events: [Finish],
        initial: () => MachineInitial.Count(new Count({ value: 1 }))
      }).handle({
        Count: {
          on: {
            Finish: ({ state, event }) => MachineInitial.Done(new Done({ value: state.value + event.by }))
          }
        },
        Done: {
          output: ({ state }) => state.value
        }
      })
      const bridge = AtomMachine.make(machine)
      yield* mount(registry, bridge.snapshot)

      yield* Effect.sync(() => registry.set(bridge.send, new Finish({ by: 3 })))

      const snapshot = yield* waitForResult(registry, bridge.snapshot, (snapshot) => snapshot.status === "done")
      assert.deepStrictEqual(snapshot, {
        status: "done",
        state: {
          path: "Done",
          value: new Done({ value: 4 }),
          completed: [{ path: "Done", output: 4 }]
        },
        output: 4
      })
    })))

  it.effect("provides AtomRegistry to machine effects", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const valueAtom = Atom.make("from-atom")
      const machine = Machine.make({
        states: {
          Count,
          ValueRead: { schema: ValueRead, type: "final" }
        },
        events: [ReadValue],
        initial: () => MachineInitial.Count(new Count({ value: 0 }))
      }).handle({
        Count: {
          on: {
            ReadValue: Effect.fn(function*() {
              const value = yield* Atom.get(valueAtom)
              return MachineInitial.ValueRead(new ValueRead({ value }))
            })
          }
        },
        ValueRead: {}
      })
      const bridge = AtomMachine.make(machine)
      yield* mount(registry, bridge.snapshot)

      yield* Effect.sync(() => registry.set(bridge.send, new ReadValue({})))

      const state = yield* waitForResult(registry, bridge.state, (state) => state.value._tag === "ValueRead")
      assert.deepStrictEqual(state, {
        path: "ValueRead",
        value: new ValueRead({ value: "from-atom" }),
        completed: [{ path: "ValueRead", output: undefined }]
      })
    })))

  it.effect("uses AtomRuntime services when starting a machine", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const runtime = Atom.runtime(Layer.succeed(
        Multiplier,
        Multiplier.of({
          multiply: (value) => value * 2
        })
      ))
      const machine = Machine.make({
        states: { Count },
        events: [Finish],
        initial: () => MachineInitial.Count(new Count({ value: 0 }))
      }).handle({
        Count: {
          on: {
            Finish: Effect.fn(function*({ event }) {
              const multiplier = yield* Multiplier
              return MachineInitial.Count(new Count({ value: multiplier.multiply(event.by) }))
            })
          }
        }
      })
      const bridge = AtomMachine.bind(runtime).make(machine)
      yield* mount(registry, bridge.state)

      yield* Effect.sync(() => registry.set(bridge.send, new Finish({ by: 3 })))

      const state = yield* waitForResult(registry, bridge.state, (state) => state.value.value === 6)
      assert.deepStrictEqual(state, {
        path: "Count",
        value: new Count({ value: 6 })
      })
    })))
})
