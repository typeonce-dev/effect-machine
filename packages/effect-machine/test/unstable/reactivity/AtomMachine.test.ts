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

const CounterStates = Machine.state({
  initial: "Count",
  states: {
    Count,
    Done: { schema: Done, type: "final" }
  }
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

const makeCounterMachine = () => {
  const targets1 = Machine.targets(CounterStates)
  return Machine.make({
    root: CounterStates,
    events: Machine.eventsFromSchemas(Finish),
    initialConfiguration: (root) =>
      root.resolve(({ target }) => target.from((to) => to.Count.decoded(new Count({ value: 0 }))))
  }).handle({
    states: {
      Count: {
        on: {
          Finish: {
            target: targets1.root.Count,
            decoded: ({ state, event }) => (new Count({ value: state.value + event.by }))
          }
        }
      },
      Done: {}
    }
  })
}

const makeInputCounterMachine = () => {
  const targets2 = Machine.targets(CounterStates)
  return Machine.make({
    root: CounterStates,
    events: Machine.eventsFromSchemas(Finish),
    input: Schema.Number,
    initialConfiguration: (root) =>
      root.resolve(({ input, target }) => target.from((to) => to.Count.decoded(new Count({ value: input }))))
  }).handle({
    states: {
      Count: {
        on: {
          Finish: {
            target: targets2.root.Count,
            decoded: ({ state, event }) => (new Count({ value: state.value + event.by }))
          }
        }
      },
      Done: {}
    }
  })
}

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
      const states = Machine.state({ initial: "Idle", states: { Idle } })
      const Emissions = Machine.emittedEventsFromSchemas(ReadyEmission)
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(),
        emittedEvents: Emissions,
        initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new Idle({}))))
      }).handle({
        states: {
          Idle: {
            entry: (_, enqueue) => {
              enqueue.emit(Emissions.ReadyEmission())
              return undefined
            }
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
      const targets3 = Machine.targets(CounterStates)
      const machine = Machine.make({
        logic: {
          source1: Machine.logic({
            initial: () => Ref.update(invokeStarts, (n) => n + 1).pipe(Effect.as(undefined)),
            run: () => Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(invokeStopped, void 0)))
          })
        },

        root: CounterStates,
        events: Machine.eventsFromSchemas(Finish),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => {
            initialCalls += 1
            return target.from((to) => to.Count.decoded(new Count({ value: 0 })))
          })
      }).handle({
        states: {
          Count: {
            invoke: { src: "source1", id: "active", address: Machine.childAddress("active") },
            on: {
              Finish: {
                target: targets3.root.Count,
                decoded: ({ event, state }) => (new Count({ value: state.value + event.by }))
              }
            }
          },
          Done: {}
        }
      })
      const bridge = AtomMachine.resume(machine, {
        path: "" as const,
        value: undefined,
        state: { path: "Count" as const, value: new Count({ value: 5 }) }
      })
      const canFinish = AtomMachine.can(new Finish({ by: 1 }))(bridge)
      const firstRegistry = AtomRegistry.make()
      const secondRegistry = AtomRegistry.make()

      assert.strictEqual(yield* AtomRegistry.getResult(firstRegistry, canFinish), true)
      const first = yield* AtomRegistry.getResult(firstRegistry, bridge.ref)
      const firstAgain = yield* AtomRegistry.getResult(firstRegistry, bridge.ref)
      const second = yield* AtomRegistry.getResult(secondRegistry, bridge.ref)
      assert.strictEqual(first.sessionId, firstAgain.sessionId)
      assert.strictEqual(first, firstAgain)
      assert.notStrictEqual(first, second)
      assert.deepStrictEqual((yield* AtomRegistry.getResult(firstRegistry, bridge.result)).state, {
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
      const root4 = Machine.state({ initial: "Count", states: { Count, ValueRead } })
      const targets4 = Machine.targets(root4)
      const parent = Machine.make({
        children: { source1: Child },

        root: root4,
        events: Machine.eventsFromSchemas(Finish, ReadValue),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.Count.decoded(new Count({ value: 0 }))))
      }).handle({
        states: {
          Count: {
            on: {
              Finish: { target: targets4.root.ValueRead, decoded: () => (new ValueRead({ value: "active" })) }
            }
          },
          ValueRead: {
            invoke: { src: "source1", onDone: { none: true } },
            on: {
              ReadValue: { target: targets4.root.Count, decoded: () => (new Count({ value: 0 })) }
            }
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
      yield* mount(registry, childAtoms.result)
      yield* Effect.sync(() => registry.set(parentAtoms.send, new Finish({ by: 0 })))
      yield* waitForResult(registry, parentAtoms.result, (state) => state.state.path === "ValueRead")
      yield* Fiber.join(childChange)
      assert(Option.isSome(yield* parentRef.child(Child)))
      assert(Option.isSome(yield* parentRef.child(Alias)))
      assert(Option.isNone(yield* parentRef.child(Impostor)))
      assert(Option.isNone(yield* AtomRegistry.getResult(registry, impostorAtoms.result)))

      const initial = yield* waitForResult(registry, childAtoms.result, Option.isSome)
      assert(Option.isSome(initial))
      assert.strictEqual(initial.value.state.value.value, 0)
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
        childAtoms.result,
        (state) => Option.isSome(state) && state.value.state.value.value === 2
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
      const root5 = Machine.state({ initial: "Count", states: { Count } })
      const parent = Machine.make({
        effects: {
          source1: (
            { children }: Machine.Machine.InvokeContext<
              {
                readonly "": { readonly initial: "Count"; readonly states: { readonly Count: typeof Count } } & {
                  readonly "~effect/Machine/ExplicitInitial": true
                }
              },
              readonly [],
              readonly [],
              "Count",
              readonly [],
              readonly []
            >
          ) => children.spawn(Child("dynamic"))
        },

        root: root5,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.Count.decoded(new Count({ value: 0 }))))
      }).handle({
        states: {
          Count: {
            invoke: {
              src: "source1",
              id: "spawn-counter",
              input: (context) => context,
              onDone: { none: true },
              onFailure: { none: true }
            }
          }
        }
      })
      const parentAtoms = AtomMachine.make(parent)
      const childAtoms = parentAtoms.child(Child("dynamic"))
      assert.strictEqual(parentAtoms.child(Child("dynamic")), childAtoms)
      assert.strictEqual(parentAtoms.child(Machine.child("dynamic", childMachine)), childAtoms)
      const selected = AtomMachine.selectChild(childAtoms, "Count")
      const matches = AtomMachine.matchesChild(childAtoms, "Count")

      yield* mount(registry, childAtoms.result)
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
      const root6 = Machine.state({ initial: "Count", states: { Count } })
      const parent = Machine.make({
        effects: {
          source1: (
            { children }: Machine.Machine.InvokeContext<
              {
                readonly "": { readonly initial: "Count"; readonly states: { readonly Count: typeof Count } } & {
                  readonly "~effect/Machine/ExplicitInitial": true
                }
              },
              readonly [],
              readonly [],
              "Count",
              readonly [],
              readonly []
            >
          ) => children.spawn(Child("dynamic"))
        },

        root: root6,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.Count.decoded(new Count({ value: 0 }))))
      }).handle({
        states: {
          Count: {
            invoke: {
              src: "source1",
              id: "spawn-counter",
              input: (context) => context,
              onDone: { none: true },
              onFailure: { none: true }
            }
          }
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
        state: (machine) => machine.result
      }
    })
    const equalFirst = new FamilyKey({ id: "same" })
    const equalSecond = new FamilyKey({ id: "same" })
    const plainFirst = { id: "same" }
    const plainSecond = { id: "same" }
    const plainDifferent = { id: "different" }
    const anyInputMachine = Machine.make({
      root: CounterStates,
      events: Machine.eventsFromSchemas(),
      input: Schema.Any,
      initialConfiguration: (root) =>
        root.resolve(({ target }) => target.from((to) => to.Count.decoded(new Count({ value: 0 }))))
    }).handle({ states: { Count: {}, Done: {} } })
    const anyInputAtoms = AtomMachine.family(anyInputMachine, {
      atoms: { state: (machine) => machine.result }
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

  it("does not retain abandoned bridges through projection caches", async () => {
    if (globalThis.gc === undefined) return

    const canFinish = AtomMachine.can(new Finish({ by: 1 }))
    const refs = (() => {
      const bridge = AtomMachine.make(makeCounterMachine())
      const selector = AtomMachine.selectSnapshot(bridge, "Count")
      const acceptance = canFinish(bridge)
      return {
        acceptance: new WeakRef(acceptance),
        bridge: new WeakRef(bridge),
        selector: new WeakRef(selector)
      }
    })()

    assert.strictEqual(await waitForCollection(refs.acceptance), true)
    assert.strictEqual(await waitForCollection(refs.selector), true)
    assert.strictEqual(await waitForCollection(refs.bridge), true)
  })

  it.effect("retains one keyed machine owner through every public projection", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const atoms = AtomMachine.family(makeInputCounterMachine(), {
        atoms: {
          canFinish: AtomMachine.can(new Finish({ by: 1 })),
          count: AtomMachine.select("Count"),
          equal: (machine) => machine.result.pipe(Atom.withEquality(() => true)),
          ref: (machine) => machine.ref,
          send: (machine) => machine.send,
          state: (machine) => machine.result
        }
      })
      const send = atoms.send(4)

      yield* Effect.promise(forceGc)
      const count = atoms.count(4)
      const state = atoms.state(4)
      assert.strictEqual(state.keepAlive, false)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, atoms.canFinish(4)), true)
      assert.strictEqual(atoms.equal(4).equals(AsyncResult.initial(), AsyncResult.success({} as never)), true)
      yield* mount(registry, state)
      yield* Effect.sync(() => registry.set(send, new Finish({ by: 5 })))

      const updated = yield* waitForResult(registry, count, (value) => Option.isSome(value) && value.value.value === 9)
      assert(Option.isSome(updated))
      assert.strictEqual(updated.value.value, 9)

      const secondRegistry = AtomRegistry.make()
      assert.strictEqual((yield* AtomRegistry.getResult(secondRegistry, state)).state.value.value, 4)
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
          path: "" as const,
          value: undefined,
          state: {
            path: "Count" as const,
            value: new Count({ value: 0 })
          }
        }
      })

      yield* Effect.sync(() => registry.set(bridge.send, new Finish({ by: 2 })))

      const state = yield* waitForResult(registry, bridge.result, (state) => state.state.value.value === 2)
      assert.deepStrictEqual(state.state, {
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

      yield* mount(registry, first.result)
      yield* mount(registry, second.result)
      assert.strictEqual((yield* AtomRegistry.getResult(registry, first.result)).state.value.value, 1)
      assert.strictEqual((yield* AtomRegistry.getResult(registry, second.result)).state.value.value, 2)

      const bound = AtomMachine.bind(Atom.runtime(Layer.empty))
      const makeBoundCounter = bound.factory(makeInputCounterMachine())
      const boundCounter = makeBoundCounter(3)
      yield* mount(registry, boundCounter.result)
      assert.strictEqual((yield* AtomRegistry.getResult(registry, boundCounter.result)).state.value.value, 3)
      assert.strictEqual(
        yield* AtomRegistry.getResult(registry, AtomMachine.can(new Finish({ by: 1 }))(boundCounter)),
        true
      )
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

  it.effect("projects static and reactive event acceptance across runtime lifecycles", () =>
    Effect.scoped(Effect.gen(function*() {
      class CanIdle extends Schema.TaggedClass<CanIdle>("AtomCanIdle")("CanIdle", {}) {}
      class CanDone extends Schema.TaggedClass<CanDone>("AtomCanDone")("CanDone", {}) {}
      class Check extends Schema.TaggedClass<Check>("AtomCanCheck")("Check", {
        accept: Schema.Boolean
      }) {}
      class Complete extends Schema.TaggedClass<Complete>("AtomCanComplete")("Complete", {}) {}
      const events = Machine.eventsFromSchemas(Check, Complete)
      const states = Machine.state({
        initial: "CanIdle",
        states: {
          CanIdle,
          CanDone: { schema: CanDone, type: "final" }
        }
      })
      let requiredResolverCalls = 0
      let declinableResolverCalls = 0
      const targets7 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets7.root.CanDone } } },

        root: states,
        events,
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.CanIdle.decoded(new CanIdle({}))))
      }).handle({
        states: {
          CanIdle: {
            on: {
              Check: {
                none: true,
                resolve: ({ event, decline }) => {
                  declinableResolverCalls++
                  return event.accept ? undefined : decline()
                },
                declinable: true
              },
              Complete: {
                branches: "transition1",
                resolve: ({ select: { destination: target } }) => {
                  requiredResolverCalls++
                  return target.decoded(new CanDone({}))
                }
              }
            }
          },
          CanDone: {}
        }
      })
      const registry = yield* makeRegistry
      const bridge = AtomMachine.make(machine)
      const checkEvent = Atom.make(events.Check({ accept: false }))
      const checkAllowed = AtomMachine.can(checkEvent)
      const completeAllowed = AtomMachine.can(events.Complete())
      const canCheck = checkAllowed(bridge)
      const canComplete = completeAllowed(bridge)
      let canCheckNotifications = 0

      assert.strictEqual(checkAllowed(bridge), canCheck)
      assert.strictEqual(completeAllowed(bridge), canComplete)
      assert.notStrictEqual(AtomMachine.can(events.Complete())(bridge), canComplete)
      yield* mount(registry, canCheck)
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registry.subscribe(canCheck, () => {
            canCheckNotifications++
          }, { immediate: true })
        ),
        (release) => Effect.sync(release)
      )
      assert.strictEqual(yield* AtomRegistry.getResult(registry, canCheck), false)
      assert.strictEqual(declinableResolverCalls, 1)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, canComplete), true)
      assert.strictEqual(requiredResolverCalls, 0)

      yield* Effect.sync(() => registry.set(checkEvent, events.Check({ accept: false })))
      assert.strictEqual(yield* AtomRegistry.getResult(registry, canCheck), false)
      assert.strictEqual(canCheckNotifications, 1)
      yield* Effect.sync(() => registry.set(checkEvent, events.Check({ accept: true })))
      assert.strictEqual(yield* waitForResult(registry, canCheck, (accepted) => accepted), true)
      assert.strictEqual(declinableResolverCalls, 3)
      assert.strictEqual(canCheckNotifications, 2)

      const invalid = AtomMachine.can({ _tag: "Check", accept: "invalid" } as any)(bridge)
      const invalidError = yield* AtomRegistry.getResult(registry, invalid).pipe(Effect.flip)
      assert.instanceOf(invalidError, Machine.MachineSchemaDecodeError)

      yield* Effect.sync(() => registry.set(bridge.send, events.Complete()))
      yield* waitForResult(registry, bridge.snapshot, (snapshot) => snapshot.status === "done")
      assert.strictEqual(yield* waitForResult(registry, canCheck, (accepted) => !accepted), false)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, canComplete), false)
      assert.strictEqual(requiredResolverCalls, 1)

      const stoppedBridge = AtomMachine.make(machine)
      const stoppedCanComplete = completeAllowed(stoppedBridge)
      yield* mount(registry, stoppedCanComplete)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, stoppedCanComplete), true)
      yield* Effect.sync(() => registry.set(stoppedBridge.stop, undefined))
      yield* waitForResult(registry, stoppedBridge.snapshot, (snapshot) => snapshot.status === "stopped")
      assert.strictEqual(
        yield* waitForResult(registry, stoppedCanComplete, (accepted) => !accepted),
        false
      )
    })))

  it.effect("propagates machine startup and runtime failures through acceptance projections", () =>
    Effect.scoped(Effect.gen(function*() {
      class Published extends Schema.TaggedClass<Published>("AtomCanPublished")("Published", {
        value: Schema.Number
      }) {}
      const emissions = Machine.emittedEventsFromSchemas(Published)
      const startupMachine = Machine.make({
        root: CounterStates,
        events: Machine.eventsFromSchemas(Finish),
        emittedEvents: emissions,
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.Count.decoded(new Count({ value: 0 }))))
      }).handle({
        states: {
          Count: {
            entry: (_, enqueue) => {
              enqueue.emit(emissions.Published({ value: "invalid" } as never))
            }
          },
          Done: {}
        }
      })
      const registry = yield* makeRegistry
      const startupBridge = AtomMachine.make(startupMachine)
      const startupCanFinish = AtomMachine.can(new Finish({ by: 1 }))(startupBridge)
      const startupError = yield* AtomRegistry.getResult(registry, startupCanFinish).pipe(Effect.flip)
      assert.instanceOf(startupError, Machine.MachineSchemaDecodeError)

      class FaultIdle extends Schema.TaggedClass<FaultIdle>("AtomCanFaultIdle")("FaultIdle", {}) {}
      class FaultLoading extends Schema.TaggedClass<FaultLoading>("AtomCanFaultLoading")("FaultLoading", {}) {}
      class Begin extends Schema.TaggedClass<Begin>("AtomCanBegin")("Begin", {}) {}
      const failure = new Error("runtime failed")
      const root8 = Machine.state({ initial: "FaultIdle", states: { FaultIdle, FaultLoading } })
      const targets8 = Machine.targets(root8)
      const faultMachine = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.die(failure)) },

        root: root8,
        events: Machine.eventsFromSchemas(Begin),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.FaultIdle.decoded(new FaultIdle({}))))
      }).handle({
        states: {
          FaultIdle: {
            on: {
              Begin: { target: targets8.root.FaultLoading, decoded: () => (new FaultLoading({})) }
            }
          },
          FaultLoading: {
            invoke: { src: "source1", id: "fail" }
          }
        }
      })
      const faultBridge = AtomMachine.make(faultMachine)
      const canBegin = AtomMachine.can(new Begin({}))(faultBridge)
      yield* mount(registry, canBegin)
      assert.strictEqual(yield* AtomRegistry.getResult(registry, canBegin), true)
      yield* Effect.sync(() => registry.set(faultBridge.send, new Begin({})))
      yield* waitForResult(registry, faultBridge.snapshot, (snapshot) => snapshot.status === "error")

      const result = registry.get(canBegin)
      assert(AsyncResult.isFailure(result))
      assert.strictEqual(Cause.squash(result.cause), failure)
      assert(Option.isSome(result.previousSuccess))
      assert.strictEqual(result.previousSuccess.value.value, false)
    })))

  it.effect("selects compound and parallel state paths from the bridge snapshot", () =>
    Effect.scoped(Effect.gen(function*() {
      const states = Machine.state({
        initial: "Ready",
        states: {
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
        }
      })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) =>
            target.from((to) =>
              to.Ready.decoded(new Ready({}), (ready) =>
                ready
                  .editor.decoded(new Editor({}), (editor) => editor.Editing.decoded(new Editing({})))
                  .network.decoded(new Network({}), (network) => network.Online.decoded(new Online({}))))
            )
          )
      }).handle({
        states: {
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
          path: "" as const,
          value: undefined,
          state: {
            path: "Count" as const,
            value: new Count({ value: 0 })
          }
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
      const root9 = Machine.state({
        initial: "Count",
        states: {
          Count,
          Done: {
            schema: Done,
            type: "final",
            output: Schema.Number
          }
        }
      })
      const targets9 = Machine.targets(root9)
      const machine = Machine.make({
        root: root9,
        events: Machine.eventsFromSchemas(Finish),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.Count.decoded(new Count({ value: 1 }))))
      }).handle({
        states: {
          Count: {
            on: {
              Finish: {
                target: targets9.root.Done,
                decoded: ({ state, event }) => (new Done({ value: state.value + event.by }))
              }
            }
          },
          Done: {
            output: ({ state }) => state.value
          }
        }
      })
      const bridge = AtomMachine.make(machine)
      yield* mount(registry, bridge.snapshot)

      yield* Effect.sync(() => registry.set(bridge.send, new Finish({ by: 3 })))

      const snapshot = yield* waitForResult(registry, bridge.snapshot, (snapshot) => snapshot.status === "done")
      assert.deepStrictEqual(snapshot, {
        status: "done",
        state: {
          path: "" as const,
          value: undefined,
          state: {
            path: "Done" as const,
            value: new Done({ value: 4 })
          },
          completed: [{ path: "Done" as const, output: 4 }, { path: "" as const, output: 4 }]
        },
        output: 4
      })
    })))
})
