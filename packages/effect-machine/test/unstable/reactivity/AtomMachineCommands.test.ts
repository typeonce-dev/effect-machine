import { assert, describe, it } from "@effect/vitest"
import { Cause, Data, Effect, Layer, Option, Schema, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
import { Machine } from "../../../src/index.js"
import { AtomMachine } from "../../../src/unstable/reactivity/index.js"

class Count extends Schema.TaggedClass<Count>("Count")("Count", {
  value: Schema.Number
}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Push extends Schema.TaggedClass<Push>("Push")("Push", {
  digit: Schema.Number
}) {}
class Activate extends Schema.TaggedClass<Activate>("Activate")("Activate", {}) {}
class StartupFailed extends Data.TaggedError("StartupFailed")<{}> {}

// Appends digits, so the final value records the delivery order.
const makeDigits = () =>
  Machine.make({
    root: Machine.state({ states: { Count } }),
    events: Machine.eventsFromSchemas(Push)
  }).handle({
    initial: { target: "Count", decoded: true, data: new Count({ value: 0 }) },
    states: {
      Count: {
        on: {
          Push: {
            target: "Count",
            decoded: true,
            data: ({ state, event }) => new Count({ value: state.value * 10 + event.digit })
          }
        }
      }
    }
  })

const Digits = Machine.child("digits", makeDigits())

const makeParent = (initial: "Count" | "Idle") =>
  Machine.make({
    children: { digits: Digits },
    root: Machine.state({ states: { Idle, Count } }),
    events: Machine.eventsFromSchemas(Activate)
  }).handle({
    initial: initial === "Count"
      ? { target: "Count", decoded: true, data: new Count({ value: 0 }) }
      : { target: "Idle", decoded: true, data: new Idle() },
    states: {
      Idle: {
        on: {
          Activate: { target: "Count", decoded: true, data: () => new Count({ value: 0 }) }
        }
      },
      Count: {
        invoke: { src: "digits" }
      }
    }
  })

const slowRuntime = () => Atom.runtime(Layer.effectDiscard(Effect.sleep("20 millis")))

const makeRegistry = Effect.acquireRelease(
  Effect.sync(() => AtomRegistry.make()),
  (registry) => Effect.sync(() => registry.dispose())
)

const mount = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>) =>
  Effect.acquireRelease(Effect.sync(() => registry.mount(atom)), (release) => Effect.sync(release))

const waitFor = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  predicate: (value: A) => boolean
): Effect.Effect<A> =>
  AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow)
  )

const settled = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>
): Effect.Effect<AsyncResult.AsyncResult<A, E>> =>
  waitFor(registry, atom, (result) => !AsyncResult.isInitial(result) && !result.waiting)

const failureOf = <A, E>(result: AsyncResult.AsyncResult<A, E>): E => {
  assert(AsyncResult.isFailure(result))
  const error = Cause.findErrorOption(result.cause)
  assert(Option.isSome(error))
  return error.value
}

describe("AtomMachine commands", () => {
  it.live("delivers an event written while the bound runtime is still building", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const bridge = AtomMachine.bind(slowRuntime()).make(makeDigits())
      yield* mount(registry, bridge.result)
      registry.set(bridge.send, new Push({ digit: 7 }))
      const pending = registry.get(bridge.send)
      assert(AsyncResult.isInitial(pending) && pending.waiting)
      const state = yield* waitFor(
        registry,
        bridge.result,
        (result) => AsyncResult.isSuccess(result) && result.value.state.value.value === 7
      )
      assert(AsyncResult.isSuccess(state))
      assert(AsyncResult.isSuccess(yield* settled(registry, bridge.send)))
    })))

  it.live("delivers several early events in write order", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const bridge = AtomMachine.bind(slowRuntime()).make(makeDigits())
      yield* mount(registry, bridge.result)
      registry.set(bridge.send, new Push({ digit: 1 }))
      registry.set(bridge.send, new Push({ digit: 2 }))
      registry.set(bridge.send, new Push({ digit: 3 }))
      yield* waitFor(
        registry,
        bridge.result,
        (result) => AsyncResult.isSuccess(result) && result.value.state.value.value === 123
      )
      // Writes made right after readiness still follow the held writes.
      registry.set(bridge.send, new Push({ digit: 4 }))
      yield* waitFor(
        registry,
        bridge.result,
        (result) => AsyncResult.isSuccess(result) && result.value.state.value.value === 1234
      )
    })))

  it.live("keeps writes after readiness ordered behind held writes", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const bridge = AtomMachine.bind(slowRuntime()).make(makeDigits())
      yield* mount(registry, bridge.result)
      registry.set(bridge.send, new Push({ digit: 1 }))
      registry.set(bridge.send, new Push({ digit: 2 }))
      yield* waitFor(registry, bridge.ref, AsyncResult.isSuccess)
      registry.set(bridge.send, new Push({ digit: 3 }))
      yield* waitFor(
        registry,
        bridge.result,
        (result) => AsyncResult.isSuccess(result) && result.value.state.value.value === 123
      )
    })))

  it.live("fails a write after the machine stopped with StoppedError", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const bridge = AtomMachine.make(makeDigits())
      yield* mount(registry, bridge.snapshot)
      yield* mount(registry, bridge.send)
      registry.set(bridge.stop, undefined)
      yield* waitFor(
        registry,
        bridge.snapshot,
        (snapshot) => AsyncResult.isSuccess(snapshot) && snapshot.value.status === "stopped"
      )
      registry.set(bridge.send, new Push({ digit: 1 }))
      const result = yield* settled(registry, bridge.send)
      assert.instanceOf(failureOf(result), Machine.StoppedError)
    })))

  it.live("settles early writes with the startup failure", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const runtime = Atom.runtime(
        Layer.effectDiscard(Effect.sleep("20 millis").pipe(Effect.andThen(Effect.fail(new StartupFailed()))))
      )
      const bridge = AtomMachine.bind(runtime).make(makeDigits())
      yield* mount(registry, bridge.result)
      yield* mount(registry, bridge.send)
      registry.set(bridge.send, new Push({ digit: 1 }))
      const result = yield* settled(registry, bridge.send)
      assert.instanceOf(failureOf(result), StartupFailed)
    })))

  it.live("stops the machine after startup when stop is written early", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const bridge = AtomMachine.bind(slowRuntime()).make(makeDigits())
      yield* mount(registry, bridge.snapshot)
      yield* mount(registry, bridge.stop)
      registry.set(bridge.stop, undefined)
      const pending = registry.get(bridge.stop)
      assert(AsyncResult.isInitial(pending) && pending.waiting)
      yield* waitFor(
        registry,
        bridge.snapshot,
        (snapshot) => AsyncResult.isSuccess(snapshot) && snapshot.value.status === "stopped"
      )
      assert(AsyncResult.isSuccess(yield* settled(registry, bridge.stop)))
    })))

  it.live("delivers a child event written before the parent is ready", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const parent = AtomMachine.bind(slowRuntime()).make(makeParent("Count"))
      const child = parent.child(Digits)
      yield* mount(registry, child.result)
      yield* mount(registry, child.send)
      registry.set(child.send, new Push({ digit: 4 }))
      registry.set(child.send, new Push({ digit: 2 }))
      const pending = registry.get(child.send)
      assert(AsyncResult.isInitial(pending) && pending.waiting)
      yield* waitFor(
        registry,
        child.result,
        (result) =>
          AsyncResult.isSuccess(result) && Option.isSome(result.value) && result.value.value.state.value.value === 42
      )
      assert(AsyncResult.isSuccess(yield* settled(registry, child.send)))
    })))

  it.live("delivers a child event written while the parent starts synchronously", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const parent = AtomMachine.make(makeParent("Count"))
      const child = parent.child(Digits)
      registry.set(child.send, new Push({ digit: 9 }))
      yield* mount(registry, child.result)
      yield* waitFor(
        registry,
        child.result,
        (result) =>
          AsyncResult.isSuccess(result) && Option.isSome(result.value) && result.value.value.state.value.value === 9
      )
    })))

  it.live("fails a child write with ChildNotActiveError when its owning state is inactive", () =>
    Effect.scoped(Effect.gen(function*() {
      const registry = yield* makeRegistry
      const parent = AtomMachine.bind(slowRuntime()).make(makeParent("Idle"))
      const child = parent.child(Digits)
      yield* mount(registry, parent.result)
      yield* mount(registry, child.send)
      yield* mount(registry, child.stop)
      registry.set(child.send, new Push({ digit: 1 }))
      const early = yield* settled(registry, child.send)
      assert.instanceOf(failureOf(early), AtomMachine.ChildNotActiveError)
      registry.set(child.stop, undefined)
      assert.instanceOf(failureOf(registry.get(child.stop)), AtomMachine.ChildNotActiveError)
    })))
})
