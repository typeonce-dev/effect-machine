import { assert, describe, it } from "@effect/vitest"
import { Cause, Data, Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
import { Machine } from "../../../src/index.js"
import { AtomMachine } from "../../../src/unstable/reactivity/index.js"

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

const CounterStates = Machine.states({
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
    events: Machine.events(Finish),
    initial: (to) => to.Count().resolve(({ target }) => target.decoded(new Count({ value: 0 })))
  }).handle({
    Count: {
      on: {
        Finish: (to) =>
          to.full.Count().resolve(({ state, event, target }) =>
            target.decoded(new Count({ value: state.value + event.by }))
          )
      }
    },
    Done: {}
  })

const makeInputCounterMachine = () =>
  Machine.make({
    states: CounterStates.states,
    events: Machine.events(Finish),
    input: Schema.Number,
    initial: (to) => to.Count().resolve(({ input, target }) => target.decoded(new Count({ value: input })))
  }).handle({
    Count: {
      on: {
        Finish: (to) =>
          to.full.Count().resolve(({ state, event, target }) =>
            target.decoded(new Count({ value: state.value + event.by }))
          )
      }
    },
    Done: {}
  })

const forceGc = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    globalThis.gc?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

const waitForCollection = async (ref: WeakRef<object>) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    globalThis.gc?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (ref.deref() === undefined) {
      return true
    }
  }
  return false
}

describe("AtomMachine", () => {
  it.effect("observes prepared live inspection before atom startup", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const bridge = AtomMachine.make(makeCounterMachine())
      const observed = yield* AtomMachine.inspection(bridge).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provideService(AtomRegistry.AtomRegistry, registry),
        Effect.forkScoped({ startImmediately: true })
      )

      const records = Array.from(yield* Fiber.join(observed))
      assert.deepStrictEqual(records.map(({ _tag }) => _tag), ["Created", "Initialized"])
      assert.ok(records.every(({ rootSessionId }) => rootSessionId === "machine:0"))
    })))

  it.effect("observes initial emissions when the emission stream starts the machine", () =>
    Effect.scoped(Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("AtomPreparedIdle")("Idle", {}) {}
      class ReadyEmission extends Schema.TaggedClass<ReadyEmission>("AtomPreparedReady")("ReadyEmission", {}) {}
      const states = Machine.states({ Idle })
      const Emissions = Machine.emittedEvents(ReadyEmission)
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        emittedEvents: Emissions,
        initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new Idle({})))
      }).handle({
        Idle: {
          entry: (_, enqueue) => {
            enqueue.emit(Emissions.ReadyEmission())
            return undefined
          }
        }
      })
      const registry = yield* makeRegistry
      const bridge = AtomMachine.make(machine)
      const selected = AtomMachine.select(bridge, "Idle")
      const selectedSnapshot = AtomMachine.selectSnapshot(bridge, "Idle")
      const matched = AtomMachine.matches(bridge, "Idle")
      assert.strictEqual(AtomMachine.select(bridge, "Idle"), selected)
      assert.strictEqual(AtomMachine.select("Idle")(bridge), selected)
      assert.strictEqual(AtomMachine.selectSnapshot(bridge, "Idle"), selectedSnapshot)
      assert.strictEqual(AtomMachine.selectSnapshot("Idle")(bridge), selectedSnapshot)
      assert.strictEqual(AtomMachine.matches(bridge, "Idle"), matched)
      assert.strictEqual(AtomMachine.matches("Idle")(bridge), matched)
      const observed = yield* AtomMachine.emissions(bridge).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.provideService(AtomRegistry.AtomRegistry, registry),
        Effect.forkScoped({ startImmediately: true })
      )

      assert.deepStrictEqual(Array.from(yield* Fiber.join(observed)), [new ReadyEmission({})])
      assert.deepStrictEqual(yield* AtomRegistry.getResult(registry, selected), Option.some(new Idle({})))
      assert.deepStrictEqual(
        yield* AtomRegistry.getResult(registry, selectedSnapshot),
        Option.some({ path: "Idle", value: new Idle({}) })
      )
      assert.strictEqual(yield* AtomRegistry.getResult(registry, matched), true)
      assert.strictEqual((yield* AtomRegistry.getResult(registry, bridge.snapshot)).status, "active")
    })))

  it.effect("resumes lazily once per registry and disposes the resumed runtime", () =>
    Effect.gen(function*() {
      let initialCalls = 0
      const invokeStarts = yield* Ref.make(0)
      const invokeStopped = yield* Deferred.make<void>()
      const machine = Machine.make({
        states: CounterStates.states,
        events: Machine.events(Finish),
        initial: (to) =>
          to.Count().resolve(({ target }) => {
            initialCalls += 1
            return target.decoded(new Count({ value: 0 }))
          })
      }).handle({
        Count: {
          invoke: (from) =>
            from.logic("active", {
              address: Machine.childAddress("active"),
              logic: Machine.logic({
                initial: () => Ref.update(invokeStarts, (n) => n + 1).pipe(Effect.as(undefined)),
                run: () => Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(invokeStopped, void 0)))
              })
            }),
          on: {
            Finish: (to) =>
              to.full.Count().resolve(({ event, state, target }) =>
                target.decoded(new Count({ value: state.value + event.by }))
              )
          }
        },
        Done: {}
      })
      const bridge = AtomMachine.resume(machine, { path: "Count" as const, value: new Count({ value: 5 }) })
      const firstRegistry = AtomRegistry.make()
      const secondRegistry = AtomRegistry.make()

      const first = yield* AtomRegistry.getResult(firstRegistry, bridge.ref)
      const firstAgain = yield* AtomRegistry.getResult(firstRegistry, bridge.ref)
      const second = yield* AtomRegistry.getResult(secondRegistry, bridge.ref)
      assert.strictEqual(first.sessionId, firstAgain.sessionId)
      assert.strictEqual(first, firstAgain)
      assert.notStrictEqual(first, second)
      assert.deepStrictEqual(yield* AtomRegistry.getResult(firstRegistry, bridge.state), {
        path: "Count" as const,
        value: new Count({ value: 5 })
      })
      assert.strictEqual(initialCalls, 0)
      assert.strictEqual(yield* Ref.get(invokeStarts), 2)

      const stopped = yield* first.changes.pipe(
        Stream.filter((snapshot) => snapshot.status === "stopped"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild
      )
      firstRegistry.dispose()
      yield* Deferred.await(invokeStopped)
      yield* Fiber.join(stopped)
      assert.strictEqual((yield* first.snapshot).status, "stopped")
      secondRegistry.dispose()
    }))

  it.effect("reactively exposes an invoked child machine", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const childMachine = makeCounterMachine()
      const Child = Machine.child("counter", childMachine)
      const parent = Machine.make({
        states: { Count, ValueRead },
        events: Machine.events(Finish, ReadValue),
        initial: (to) => to.Count().resolve(({ target }) => target.decoded(new Count({ value: 0 })))
      }).handle({
        Count: {
          on: {
            Finish: (to) =>
              to.full.ValueRead().resolve(({ target }) => target.decoded(new ValueRead({ value: "active" })))
          }
        },
        ValueRead: {
          invoke: (from) => from.child(Child).onDone((to) => to.none),
          on: {
            ReadValue: (to) => to.full.Count().resolve(({ target }) => target.decoded(new Count({ value: 0 })))
          }
        }
      })
      const parentAtoms = AtomMachine.make(parent)
      const childAtoms = parentAtoms.child(Child)
      assert.strictEqual(parentAtoms.child(Child), childAtoms)
      const Alias = Machine.child("counter", childMachine)
      assert.strictEqual(parentAtoms.child(Alias), childAtoms)
      const Impostor = Machine.child("counter", makeCounterMachine())
      const impostorAtoms = parentAtoms.child(Impostor)
      const selectedCount = AtomMachine.selectChild(childAtoms, "Count")
      const selectedCountSnapshot = AtomMachine.selectSnapshotChild(childAtoms, "Count")
      const countMatches = AtomMachine.matchesChild(childAtoms, "Count")
      assert.strictEqual(AtomMachine.selectChild(childAtoms, "Count"), selectedCount)
      assert.strictEqual(AtomMachine.selectChild("Count")(childAtoms), selectedCount)
      assert.strictEqual(AtomMachine.selectSnapshotChild(childAtoms, "Count"), selectedCountSnapshot)
      assert.strictEqual(AtomMachine.selectSnapshotChild("Count")(childAtoms), selectedCountSnapshot)
      assert.strictEqual(AtomMachine.matchesChild(childAtoms, "Count"), countMatches)
      assert.strictEqual(AtomMachine.matchesChild("Count")(childAtoms), countMatches)
      const parentRef = yield* AtomRegistry.getResult(registry, parentAtoms.ref)
      const directChild = yield* parentRef.child(Child)
      assert(Option.isNone(directChild))
      assert(Option.isNone(yield* AtomRegistry.getResult(registry, selectedCount)))
      assert(Option.isNone(yield* AtomRegistry.getResult(registry, selectedCountSnapshot)))
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
      const selectedInitialSnapshot = yield* waitForResult(registry, selectedCountSnapshot, Option.isSome)
      assert(Option.isSome(selectedInitialSnapshot))
      assert.deepStrictEqual(selectedInitialSnapshot.value, {
        path: "Count" as const,
        value: new Count({ value: 0 })
      })
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
      const selectedUpdatedSnapshot = yield* waitForResult(
        registry,
        selectedCountSnapshot,
        (state) => Option.isSome(state) && state.value.value.value === 2
      )
      assert(Option.isSome(selectedUpdatedSnapshot))
      assert.strictEqual(selectedUpdatedSnapshot.value.value.value, 2)

      yield* Effect.sync(() => registry.set(parentAtoms.send, new ReadValue({})))
      const inactive = yield* waitForResult(registry, childAtoms.ref, Option.isNone)
      assert(Option.isNone(inactive))
      assert(Option.isNone(yield* waitForResult(registry, selectedCount, Option.isNone)))
      assert(Option.isNone(yield* waitForResult(registry, selectedCountSnapshot, Option.isNone)))
      assert.strictEqual(yield* AtomRegistry.getResult(registry, countMatches), false)
    })))

  it.effect("reactively exposes a dynamically spawned child by family and runtime id", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const childMachine = makeCounterMachine()
      const Child = Machine.childFamily(childMachine)
      const parent = Machine.make({
        states: { Count },
        events: Machine.events(),
        initial: (to) => to.Count().resolve(({ target }) => target.decoded(new Count({ value: 0 })))
      }).handle({
        Count: {
          invoke: (from) =>
            from.effect("spawn-counter", ({ children }) => children.spawn(Child("dynamic"))).onDone((to) => to.none)
              .onFailure((to) => to.none)
        }
      })
      const parentAtoms = AtomMachine.make(parent)
      const childAtoms = parentAtoms.child(Child("dynamic"))
      assert.strictEqual(parentAtoms.child(Child("dynamic")), childAtoms)
      assert.strictEqual(parentAtoms.child(Machine.child("dynamic", childMachine)), childAtoms)
      const selected = AtomMachine.selectChild(childAtoms, "Count")
      const matches = AtomMachine.matchesChild(childAtoms, "Count")

      yield* mount(registry, childAtoms.state)
      const active = yield* waitForResult(registry, selected, Option.isSome)
      assert(Option.isSome(active))
      assert.strictEqual(active.value.value, 0)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, matches), true)

      yield* Effect.sync(() => registry.set(childAtoms.stop, undefined))
      assert(Option.isNone(yield* waitForResult(registry, childAtoms.ref, Option.isNone)))
      assert.strictEqual(yield* AtomRegistry.getResult(registry, matches), false)
    })))

  it.effect("creates retained atom families for dynamically spawned children", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const childMachine = makeCounterMachine()
      const Child = Machine.childFamily(childMachine)
      const parent = Machine.make({
        states: { Count },
        events: Machine.events(),
        initial: (to) => to.Count().resolve(({ target }) => target.decoded(new Count({ value: 0 })))
      }).handle({
        Count: {
          invoke: (from) =>
            from.effect("spawn-counter", ({ children }) => children.spawn(Child("dynamic"))).onDone((to) => to.none)
              .onFailure((to) => to.none)
        }
      })
      const parentAtoms = AtomMachine.make(parent)
      const children = AtomMachine.familyChild(parentAtoms, {
        child: (id: string) => Child(id),
        atoms: {
          count: AtomMachine.selectChild("Count"),
          matches: AtomMachine.matchesChild("Count"),
          send: (child) => child.send
        },
        label: (id, name) => `counter:${id}:${name}`
      })
      const count = children.count("dynamic")
      const send = children.send("dynamic")

      assert.strictEqual(children.count("dynamic"), count)
      assert.notStrictEqual(children.count("missing"), count)
      assert.strictEqual(count.label?.[0], "counter:dynamic:count")
      yield* mount(registry, count)
      const initial = yield* waitForResult(registry, count, Option.isSome)
      assert(Option.isSome(initial))
      assert.strictEqual(initial.value.value, 0)

      yield* Effect.sync(() => registry.set(send, new Finish({ by: 3 })))
      const updated = yield* waitForResult(
        registry,
        count,
        (value) => Option.isSome(value) && value.value.value === 3
      )
      assert(Option.isSome(updated))
      assert.strictEqual(updated.value.value, 3)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, children.matches("dynamic")), true)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, children.matches("missing")), false)
    })))

  it("uses Effect key equality without retaining family values permanently", async () => {
    class FamilyKey extends Data.Class<{ readonly id: string }> {}
    const machine = makeInputCounterMachine()
    const atoms = AtomMachine.family(machine, {
      atoms: {
        state: (machine) => machine.state
      }
    })
    const equalFirst = new FamilyKey({ id: "same" })
    const equalSecond = new FamilyKey({ id: "same" })
    const plainFirst = { id: "same" }
    const plainSecond = { id: "same" }
    const plainDifferent = { id: "different" }
    const anyInputMachine = Machine.make({
      states: CounterStates.states,
      events: Machine.events(),
      input: Schema.Any,
      initial: (to) => to.Count().resolve(({ target }) => target.decoded(new Count({ value: 0 })))
    }).handle({ Count: {}, Done: {} })
    const anyInputAtoms = AtomMachine.family(anyInputMachine, {
      atoms: { state: (machine) => machine.state }
    })

    assert.strictEqual(anyInputAtoms.state(equalFirst), anyInputAtoms.state(equalSecond))
    assert.strictEqual(anyInputAtoms.state(plainFirst), anyInputAtoms.state(plainSecond))
    assert.notStrictEqual(anyInputAtoms.state(plainFirst), anyInputAtoms.state(plainDifferent))
    assert.strictEqual(atoms.state(1), atoms.state(1))
    assert.notStrictEqual(atoms.state(1), atoms.state(2))

    if (globalThis.gc !== undefined) {
      const weak = (() => {
        const atom = atoms.state(99)
        return new WeakRef(atom)
      })()
      assert.strictEqual(await waitForCollection(weak), true)
    }
  })

  it("does not retain abandoned bridges through the selector cache", async () => {
    if (globalThis.gc === undefined) return

    const refs = (() => {
      const bridge = AtomMachine.make(makeCounterMachine())
      const selector = AtomMachine.selectSnapshot(bridge, "Count")
      return {
        bridge: new WeakRef(bridge),
        selector: new WeakRef(selector)
      }
    })()

    assert.strictEqual(await waitForCollection(refs.selector), true)
    assert.strictEqual(await waitForCollection(refs.bridge), true)
  })

  it.effect("retains one keyed machine owner through every public projection", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const atoms = AtomMachine.family(makeInputCounterMachine(), {
        atoms: {
          count: AtomMachine.select("Count"),
          equal: (machine) => machine.state.pipe(Atom.withEquality(() => true)),
          ref: (machine) => machine.ref,
          send: (machine) => machine.send,
          state: (machine) => machine.state
        }
      })
      const send = atoms.send(4)

      yield* Effect.promise(forceGc)
      const count = atoms.count(4)
      const state = atoms.state(4)
      assert.strictEqual(state.keepAlive, false)
      assert.strictEqual(atoms.equal(4).equals(AsyncResult.initial(), AsyncResult.success({} as never)), true)
      yield* mount(registry, state)
      yield* Effect.sync(() => registry.set(send, new Finish({ by: 5 })))

      const updated = yield* waitForResult(registry, count, (value) => Option.isSome(value) && value.value.value === 9)
      assert(Option.isSome(updated))
      assert.strictEqual(updated.value.value, 9)

      const secondRegistry = AtomRegistry.make()
      assert.strictEqual((yield* AtomRegistry.getResult(secondRegistry, state)).value.value, 4)
      secondRegistry.dispose()

      const ref = yield* AtomRegistry.getResult(registry, atoms.ref(4))
      const stopped = yield* Machine.watch(ref).pipe(
        Stream.runCollect,
        Effect.forkScoped
      )
      yield* Effect.sync(() => registry.dispose())
      const events = Array.from(yield* Fiber.join(stopped))
      assert.strictEqual(events.at(-1)?._tag, "Stopped")
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
          path: "Count" as const,
          value: new Count({ value: 0 })
        }
      })

      yield* Effect.sync(() => registry.set(bridge.send, new Finish({ by: 2 })))

      const state = yield* waitForResult(registry, bridge.state, (state) => state.value.value === 2)
      assert.deepStrictEqual(state, {
        path: "Count" as const,
        value: new Count({ value: 2 })
      })
    })))

  it.effect("creates fresh inferred bridges from reusable constructors", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const makeCounter = AtomMachine.factory(makeInputCounterMachine())
      const first = makeCounter(1)
      const second = makeCounter(2)
      assert.notStrictEqual(first, second)

      yield* mount(registry, first.state)
      yield* mount(registry, second.state)
      assert.strictEqual((yield* AtomRegistry.getResult(registry, first.state)).value.value, 1)
      assert.strictEqual((yield* AtomRegistry.getResult(registry, second.state)).value.value, 2)

      const bound = AtomMachine.bind(Atom.runtime(Layer.empty))
      const makeBoundCounter = bound.factory(makeInputCounterMachine())
      const boundCounter = makeBoundCounter(3)
      yield* mount(registry, boundCounter.state)
      assert.strictEqual((yield* AtomRegistry.getResult(registry, boundCounter.state)).value.value, 3)
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
      const states = Machine.states({
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
        events: Machine.events(),
        initial: (to) =>
          to.Ready.initial.resolve(({ target }) =>
            target.decoded(new Ready({}), (ready) =>
              ready
                .editor.decoded(new Editor({}), (editor) => editor.Editing.decoded(new Editing({})))
                .network.decoded(new Network({}), (network) => network.Online.decoded(new Online({}))))
          )
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
      const readySnapshot = AtomMachine.selectSnapshot(bridge, "Ready")
      const editor = AtomMachine.select(bridge, "Ready.editor")
      const editorSnapshot = AtomMachine.selectSnapshot(bridge, "Ready.editor")
      const editing = AtomMachine.select(bridge, "Ready.editor.Editing")
      const editingSnapshot = AtomMachine.selectSnapshot(bridge, "Ready.editor.Editing")
      const saving = AtomMachine.select(bridge, "Ready.editor.Saving")
      const savingSnapshot = AtomMachine.selectSnapshot(bridge, "Ready.editor.Saving")
      const online = AtomMachine.matches(bridge, "Ready.network.Online")
      const offline = AtomMachine.matches(bridge, "Ready.network.Offline")

      assert(Option.isSome(yield* AtomRegistry.getResult(registry, ready)))
      const selectedReadySnapshot = yield* AtomRegistry.getResult(registry, readySnapshot)
      assert(Option.isSome(selectedReadySnapshot))
      assert.strictEqual(selectedReadySnapshot.value.path, "Ready")
      assert.strictEqual(selectedReadySnapshot.value.states.editor.path, "Ready.editor")
      assert(Option.isSome(yield* AtomRegistry.getResult(registry, editor)))
      const selectedEditorSnapshot = yield* AtomRegistry.getResult(registry, editorSnapshot)
      assert(Option.isSome(selectedEditorSnapshot))
      assert.strictEqual(selectedEditorSnapshot.value.state.path, "Ready.editor.Editing")
      assert(Option.isSome(yield* AtomRegistry.getResult(registry, editing)))
      const selectedEditingSnapshot = yield* AtomRegistry.getResult(registry, editingSnapshot)
      assert(Option.isSome(selectedEditingSnapshot))
      assert.strictEqual(selectedEditingSnapshot.value.path, "Ready.editor.Editing")
      assert(Option.isNone(yield* AtomRegistry.getResult(registry, saving)))
      assert(Option.isNone(yield* AtomRegistry.getResult(registry, savingSnapshot)))
      assert.strictEqual(yield* AtomRegistry.getResult(registry, online), true)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, offline), false)
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
          path: "Count" as const,
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
        events: Machine.events(Finish),
        initial: (to) => to.Count().resolve(({ target }) => target.decoded(new Count({ value: 1 })))
      }).handle({
        Count: {
          on: {
            Finish: (to) =>
              to.full.Done().resolve(({ state, event, target }) =>
                target.decoded(new Done({ value: state.value + event.by }))
              )
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
          path: "Done" as const,
          value: new Done({ value: 4 }),
          completed: [{ path: "Done" as const, output: 4 }]
        },
        output: 4
      })
    })))
})
