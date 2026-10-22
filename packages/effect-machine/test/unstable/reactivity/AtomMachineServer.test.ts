import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
import { Machine } from "../../../src/index.js"
import { AtomMachine } from "../../../src/unstable/reactivity/index.js"

class Loading extends Schema.TaggedClass<Loading>("Loading")("Loading", {}) {}
class Loaded extends Schema.TaggedClass<Loaded>("Loaded")("Loaded", {}) {}
class Editing extends Schema.TaggedClass<Editing>("Editing")("Editing", {
  email: Schema.String
}) {}
class Submitted extends Schema.TaggedClass<Submitted>("Submitted")("Submitted", {}) {}
class Searching extends Schema.TaggedClass<Searching>("Searching")("Searching", {
  query: Schema.String
}) {}
class Submit extends Schema.TaggedClass<Submit>("Submit")("Submit", {}) {}

class Tracker extends Context.Service<Tracker, {
  readonly track: Effect.Effect<void>
}>()("test/AtomMachineServer/Tracker") {}

const makeCounter = () => {
  const counter = { started: 0 }
  const machine = Machine.make({
    root: Machine.state({ states: { Loading, Loaded } }),
    events: Machine.eventsFromSchemas(),
    effects: {
      load: Effect.sync(() => {
        counter.started++
      }).pipe(Effect.andThen(Effect.never))
    }
  }).handle({
    initial: { target: "Loading", decoded: true, data: new Loading({}) },
    states: {
      Loading: { invoke: { src: "load" } },
      Loaded: {}
    }
  })
  return { counter, machine }
}

const SearchMachine = Machine.make({
  root: Machine.state({ states: { Searching } }),
  events: Machine.eventsFromSchemas(),
  input: Schema.String
}).handle({
  initial: {
    target: "Searching",
    decoded: true,
    data: ({ input }) => new Searching({ query: input })
  },
  states: { Searching: {} }
})
const SearchChild = Machine.child("search", SearchMachine)
const OtherSearchChild = Machine.child("other-search", SearchMachine)

const makeForm = () => {
  const counter = { started: 0 }
  const machine = Machine.make({
    root: Machine.state({ states: { Editing, Submitted } }),
    events: Machine.eventsFromSchemas(Submit),
    input: Schema.String,
    children: { search: SearchChild },
    effects: {
      track: Effect.sync(() => {
        counter.started++
      }).pipe(Effect.andThen(Effect.never))
    }
  }).handle({
    initial: {
      target: "Editing",
      decoded: true,
      data: ({ input }) => new Editing({ email: input })
    },
    states: {
      Editing: {
        invoke: [
          { src: "track" },
          { src: "search", input: ({ state }) => state.email }
        ],
        on: {
          Submit: { target: "Submitted", decoded: true, data: () => new Submitted({}) }
        }
      },
      Submitted: {}
    }
  })
  return { counter, machine }
}

const rootState = <const State>(state: State) => ({ path: "" as const, value: undefined, state })

const assertPlanned = <A, E>(result: AsyncResult.AsyncResult<A, E>, expected: A) => {
  assert(AsyncResult.isSuccess(result))
  assert.strictEqual(result.waiting, true)
  assert.deepStrictEqual(result.value, expected)
}

const serverRead = <A>(atom: Atom.Atom<A>, registry: AtomRegistry.AtomRegistry): A =>
  Atom.getServerValue(atom, registry)

describe("AtomMachine server values", () => {
  it("does not start a machine on a server read", () => {
    const { counter, machine } = makeCounter()
    const registry = AtomRegistry.make()
    assertPlanned(
      serverRead(AtomMachine.make(machine).result, registry),
      rootState({ path: "Loading", value: new Loading({}) })
    )
    assert.strictEqual(counter.started, 0)
    registry.dispose()
  })

  it("serves the planned startup snapshot from every bridge atom", () => {
    const { counter, machine } = makeForm()
    const registry = AtomRegistry.make()
    const bridge = AtomMachine.make(machine, "ada@example.com")
    const editing = new Editing({ email: "ada@example.com" })
    const editingNode = { path: "Editing", value: editing } as const
    const state = rootState(editingNode)

    assert.deepStrictEqual(serverRead(bridge.ref, registry), AsyncResult.initial(true))
    assertPlanned(serverRead(bridge.snapshot, registry), { status: "active", state })
    assertPlanned(serverRead(bridge.result, registry), state)
    assertPlanned(serverRead(AtomMachine.select(bridge, "Editing"), registry), Option.some(editing))
    assertPlanned(serverRead(AtomMachine.select(bridge, "Submitted"), registry), Option.none())
    assertPlanned(serverRead(AtomMachine.selectSnapshot(bridge, "Editing"), registry), Option.some(editingNode))
    assertPlanned(serverRead(AtomMachine.matches(bridge, "Editing"), registry), true)
    assertPlanned(serverRead(AtomMachine.can(new Submit({}))(bridge), registry), true)
    assertPlanned(serverRead(AtomMachine.can(Atom.make(new Submit({})))(bridge), registry), true)
    assert(AsyncResult.isInitial(serverRead(bridge.send, registry)))
    assert(AsyncResult.isInitial(serverRead(bridge.stop, registry)))

    const search = bridge.child(SearchChild)
    const searching = new Searching({ query: "ada@example.com" })
    const searchingNode = { path: "Searching", value: searching } as const
    const childState = rootState(searchingNode)
    assert.deepStrictEqual(serverRead(search.ref, registry), AsyncResult.initial(true))
    assertPlanned(serverRead(search.snapshot, registry), Option.some({ status: "active", state: childState }))
    assertPlanned(serverRead(search.result, registry), Option.some(childState))
    assertPlanned(serverRead(AtomMachine.selectChild(search, "Searching"), registry), Option.some(searching))
    assertPlanned(
      serverRead(AtomMachine.selectSnapshotChild(search, "Searching"), registry),
      Option.some(searchingNode)
    )
    assertPlanned(serverRead(AtomMachine.matchesChild(search, "Searching"), registry), true)
    assert(AsyncResult.isInitial(serverRead(search.send, registry)))
    assert(AsyncResult.isInitial(serverRead(search.stop, registry)))

    const other = bridge.child(OtherSearchChild)
    assertPlanned(serverRead(other.result, registry), Option.none())
    assertPlanned(serverRead(AtomMachine.matchesChild(other, "Searching"), registry), false)
    assertPlanned(serverRead(search.child(SearchChild).result, registry), Option.none())

    assert.strictEqual(counter.started, 0)
    registry.dispose()
  })

  it("serves planned values from family projections", () => {
    const { counter, machine } = makeForm()
    const registry = AtomRegistry.make()
    const forms = AtomMachine.family(machine, {
      atoms: {
        editing: AtomMachine.select("Editing"),
        result: (form) => form.result,
        send: (form) => form.send
      }
    })
    assertPlanned(
      serverRead(forms.editing("grace@example.com"), registry),
      Option.some(new Editing({ email: "grace@example.com" }))
    )
    assertPlanned(
      serverRead(forms.result("grace@example.com"), registry),
      rootState({ path: "Editing", value: new Editing({ email: "grace@example.com" }) })
    )
    assert(AsyncResult.isInitial(serverRead(forms.send("grace@example.com"), registry)))

    const parent = AtomMachine.make(machine, "linus@example.com")
    const searches = AtomMachine.familyChild(parent, {
      child: (id: string) => Machine.child(id, SearchMachine),
      atoms: { searching: AtomMachine.selectChild("Searching") }
    })
    assertPlanned(
      serverRead(searches.searching("search"), registry),
      Option.some(new Searching({ query: "linus@example.com" }))
    )
    assertPlanned(serverRead(searches.searching("spawned"), registry), Option.none())
    assert.strictEqual(counter.started, 0)
    registry.dispose()
  })

  it("serves referentially stable values on repeated reads", () => {
    const { counter, machine } = makeForm()
    const registry = AtomRegistry.make()
    const otherRegistry = AtomRegistry.make()
    const bridge = AtomMachine.make(machine, "ada@example.com")
    const search = bridge.child(SearchChild)
    const forms = AtomMachine.family(machine, {
      atoms: {
        editing: AtomMachine.select("Editing"),
        result: (form) => form.result
      }
    })
    const searches = AtomMachine.familyChild(bridge, {
      child: (id: string) => Machine.child(id, SearchMachine),
      atoms: {
        searching: AtomMachine.selectSnapshotChild("Searching"),
        result: (child) => child.result
      }
    })
    const atoms: Record<string, Atom.Atom<unknown>> = {
      ref: bridge.ref,
      snapshot: bridge.snapshot,
      result: bridge.result,
      select: AtomMachine.select(bridge, "Editing"),
      selectSnapshot: AtomMachine.selectSnapshot(bridge, "Editing"),
      matches: AtomMachine.matches(bridge, "Editing"),
      can: AtomMachine.can(new Submit({}))(bridge),
      canAtom: AtomMachine.can(Atom.make(new Submit({})))(bridge),
      childSnapshot: search.snapshot,
      childResult: search.result,
      selectChild: AtomMachine.selectChild(search, "Searching"),
      selectSnapshotChild: AtomMachine.selectSnapshotChild(search, "Searching"),
      matchesChild: AtomMachine.matchesChild(search, "Searching"),
      inactiveChild: search.child(SearchChild).result,
      familyEditing: forms.editing("grace@example.com"),
      familyResult: forms.result("grace@example.com"),
      familyChildSearching: searches.searching("search"),
      familyChildResult: searches.result("search")
    }
    const stable = (registry: AtomRegistry.AtomRegistry) =>
      Object.fromEntries(
        Object.entries(atoms).map((
          [name, atom]
        ) => [name, Object.is(serverRead(atom, registry), serverRead(atom, registry))])
      )
    const expected = Object.fromEntries(Object.keys(atoms).map((name) => [name, true]))

    assert.deepStrictEqual(stable(registry), expected)
    assert.deepStrictEqual(stable(otherRegistry), expected)
    assert.strictEqual(serverRead(bridge.result, registry), serverRead(bridge.result, otherRegistry))
    assert.strictEqual(counter.started, 0)
    registry.dispose()
    otherRegistry.dispose()
  })

  it("serves the planned state of a bound machine without building its layer", () => {
    let built = 0
    let tracked = 0
    const layer = Layer.effect(
      Tracker,
      Effect.sync(() => {
        built++
        return Tracker.of({ track: Effect.sync(() => tracked++) })
      })
    )
    const machine = Machine.make({
      root: Machine.state({ states: { Loading, Loaded } }),
      events: Machine.eventsFromSchemas(),
      effects: {
        load: Effect.gen(function*() {
          const tracker = yield* Tracker
          yield* tracker.track
        })
      }
    }).handle({
      initial: { target: "Loading", decoded: true, data: new Loading({}) },
      states: {
        Loading: { invoke: { src: "load", onDone: { target: "Loaded", decoded: true, data: () => new Loaded({}) } } },
        Loaded: {}
      }
    })
    const registry = AtomRegistry.make()
    const bridge = AtomMachine.bind(Atom.runtime(layer)).make(machine)
    assertPlanned(serverRead(bridge.result, registry), rootState({ path: "Loading", value: new Loading({}) }))
    assert.strictEqual(built, 0)
    assert.strictEqual(tracked, 0)
    registry.dispose()
  })

  it("serves Initial when the startup snapshot cannot be planned", () => {
    const registry = AtomRegistry.make()
    let started = 0
    const machine = Machine.make({
      root: Machine.state({ states: { Loading } }),
      events: Machine.eventsFromSchemas(Submit)
    }).handle({
      initial: {
        target: "Loading",
        decoded: true,
        data: () => {
          started++
          throw new Error("unplannable")
        }
      },
      states: { Loading: {} }
    })
    const bridge = AtomMachine.make(machine)
    assert.deepStrictEqual(serverRead(bridge.snapshot, registry), AsyncResult.initial(true))
    assert.deepStrictEqual(serverRead(bridge.result, registry), AsyncResult.initial(true))
    assert.deepStrictEqual(serverRead(AtomMachine.select(bridge, "Loading"), registry), AsyncResult.initial(true))
    assert.deepStrictEqual(serverRead(AtomMachine.can(new Submit({}))(bridge), registry), AsyncResult.initial(true))
    assert.deepStrictEqual(serverRead(bridge.child(SearchChild).result, registry), AsyncResult.initial(true))
    // The plan is computed once per bridge.
    assert.strictEqual(started, 1)
    registry.dispose()
  })

  it("serves the resumed snapshot of a resumed bridge", () => {
    const { counter, machine } = makeForm()
    const registry = AtomRegistry.make()
    const bridge = AtomMachine.resume(machine, {
      path: "" as const,
      value: undefined,
      state: { path: "Submitted" as const, value: new Submitted({}) }
    })
    assertPlanned(serverRead(bridge.result, registry), rootState({ path: "Submitted", value: new Submitted({}) }))
    assertPlanned(serverRead(AtomMachine.can(new Submit({}))(bridge), registry), false)
    assertPlanned(serverRead(bridge.child(SearchChild).result, registry), Option.none())
    assert.strictEqual(counter.started, 0)
    registry.dispose()
  })

  it.effect("starts exactly once on a client mount after a server read", () =>
    Effect.gen(function*() {
      const { counter, machine } = makeCounter()
      const registry = AtomRegistry.make()
      const bridge = AtomMachine.make(machine)
      serverRead(bridge.result, registry)
      serverRead(AtomMachine.select(bridge, "Loading"), registry)
      assert.strictEqual(counter.started, 0)
      const release = registry.mount(bridge.result)
      const state = yield* AtomRegistry.getResult(registry, bridge.result)
      assert.deepStrictEqual(state, rootState({ path: "Loading", value: new Loading({}) }))
      yield* Effect.yieldNow
      assert.strictEqual(counter.started, 1)
      serverRead(bridge.result, registry)
      assert.strictEqual(counter.started, 1)
      release()
      registry.dispose()
    }))
})
