import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { LocalMachine, Machine } from "../../src/index.js"

const makeWorker = () =>
  Machine.make({
    root: Machine.state({ fields: { seed: Schema.Number } }),
    events: Machine.events({}),
    input: Schema.Number
  }).handle({ root: ({ input }) => ({ seed: input }) })

const worker = makeWorker()

const makeOwner = (child: Machine.ChildMachine<"worker", typeof worker>) =>
  Machine.make({
    root: Machine.state({ states: { Working: {} } }),
    events: Machine.events({}),
    children: { worker: child }
  }).handle({
    initial: { target: "Working" },
    states: { Working: { invoke: { src: "worker", input: () => 1 } } }
  })

describe("Child machine descriptors", () => {
  it("hold only a brand, an id, and a machine", () => {
    for (const descriptor of [Machine.child("worker", worker), Machine.childFamily(worker)("worker")]) {
      assert.deepStrictEqual(Reflect.ownKeys(descriptor), ["~effect/Machine/ChildMachine", "id", "machine"])
      assert.strictEqual(descriptor.id, "worker")
      assert.strictEqual(descriptor.machine, worker)
    }
  })

  it("are equal values for the same id and machine", () => {
    assert.deepStrictEqual(Machine.child("worker", worker), Machine.childFamily(worker)("worker"))
  })

  it.effect("address the same child when they name the same id and machine", () =>
    Effect.gen(function*() {
      const owner = yield* LocalMachine.start(makeOwner(Machine.child("worker", worker)))
      const first = Option.getOrThrow(yield* owner.child(Machine.child("worker", worker)))
      const second = Option.getOrThrow(yield* owner.child(Machine.childFamily(worker)("worker")))
      assert.strictEqual(first, second)
      assert.strictEqual((yield* first.state).value.seed, 1)

      // The same id with another machine addresses nothing.
      assert.isTrue(Option.isNone(yield* owner.child(Machine.child("worker", makeWorker()))))
      assert.isTrue(Option.isNone(yield* owner.child(Machine.child("other", worker))))
    }))

  it.effect("start an independent child with its own input each time", () =>
    Effect.gen(function*() {
      const Worker = Machine.childFamily(worker)
      const spawner = Machine.make({
        root: Machine.state({ states: { Working: {} } }),
        events: Machine.events({}),
        effects: {
          spawn: (children: Machine.ChildOwner<never>) =>
            Effect.gen(function*() {
              yield* children.spawn(Worker("a"), { input: 1 })
              yield* children.spawn(Worker("b"), { input: 2 })
            }).pipe(Effect.orDie)
        }
      }).handle({
        initial: { target: "Working" },
        states: { Working: { invoke: { src: "spawn", input: ({ children }) => children, onDone: { stay: true } } } }
      })
      const owner = yield* LocalMachine.start(spawner)
      const seeds = yield* Effect.forEach(["a", "b"], (id) =>
        owner.child(Worker(id)).pipe(
          Effect.flatMap((child) => Option.getOrThrow(child).state),
          Effect.map((state) => state.value.seed)
        ))
      assert.deepStrictEqual(seeds, [1, 2])
    }))
})
