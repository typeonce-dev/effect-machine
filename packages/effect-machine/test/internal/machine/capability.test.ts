import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Option, Schema, Stream } from "effect"
import { Machine } from "../../../src/index.js"
import * as Process from "../../../src/internal/machine/process.js"

const WorkerEvents = Machine.events({ Add: { by: Schema.Number } })
const worker = Machine.make({
  id: "Worker",
  root: Machine.state({ fields: { count: Schema.Number } }),
  events: WorkerEvents
}).handle({
  root: () => ({ count: 0 }),
  on: { Add: { update: { root: ({ event, root }) => ({ count: root.count + event.by }) } } }
})
const Worker = Machine.child("worker", worker)

const Counter = Machine.childAddress<number>("counter")
const counter = Machine.logic<number, number>({
  initial: 0,
  run: (context) =>
    Effect.forever(
      Effect.flatMap(context.receive, (by) => context.updateState((count) => Effect.succeed(count + by)))
    )
})

type CounterRef = Machine.MachineRef<number, number, never, void>

const startOwner = (
  work: Effect.Effect<void, Machine.ChildAlreadyExistsError | Machine.StoppedError, Machine.MachineRuntime>,
  strategy: "generic" | "compiled"
) => {
  const owner = Machine.make({
    id: "Owner",
    root: Machine.state({ states: { Working: {} } }),
    events: Machine.events({}),
    effects: { work: Effect.orDie(work) },
    children: { worker: Worker }
  }).handle({
    initial: { target: "Working" },
    states: { Working: { invoke: [{ src: "worker" }, { src: "work", onDone: { stay: true } }] } }
  })
  return Process.startWithRuntimeStrategyForTesting(owner, strategy)
}

for (const strategy of ["generic", "compiled"] as const) {
  describe(`MachineRuntime on the ${strategy} local runtime`, () => {
    it.effect("spawns, sends to, and stops process logic owned by the machine", () =>
      Effect.gen(function*() {
        const spawned = yield* Deferred.make<CounterRef>()
        const stop = yield* Deferred.make<void>()
        const owner = yield* startOwner(
          Effect.gen(function*() {
            const ref = yield* Machine.spawn(counter, { id: Counter })
            yield* Machine.sendTo(Counter, 2)
            yield* Machine.sendTo(Counter, 3)
            yield* Deferred.succeed(spawned, ref)
            yield* Deferred.await(stop)
            yield* Machine.stopChild(Counter)
          }),
          strategy
        )
        const ref = yield* Deferred.await(spawned)
        assert.strictEqual(ref.id, "counter")
        yield* Machine.waitFor(ref, (snapshot) => snapshot.state === 5)

        yield* Deferred.succeed(stop, undefined)
        const outcomes = yield* Stream.runCollect(Machine.watch(ref))
        assert.deepStrictEqual(Array.from(outcomes, (outcome) => outcome._tag), ["Stopped"])
        assert.strictEqual((yield* owner.snapshot).status, "active")
      }))

    it.effect("keeps a spawned child after the work that spawned it, and stops it with the machine", () =>
      Effect.gen(function*() {
        const spawned = yield* Deferred.make<CounterRef>()
        const owner = yield* startOwner(
          Effect.flatMap(Machine.spawn(counter), (ref) => Effect.asVoid(Deferred.succeed(spawned, ref))),
          strategy
        )
        const ref = yield* Deferred.await(spawned)
        yield* Effect.yieldNow
        assert.strictEqual((yield* ref.snapshot).status, "active")
        yield* owner.stop
        assert.strictEqual((yield* ref.snapshot).status, "stopped")
      }))

    it.effect("fails to spawn under an id that is in use", () =>
      Effect.gen(function*() {
        const failed = yield* Deferred.make<string>()
        yield* startOwner(
          Effect.gen(function*() {
            yield* Machine.spawn(counter, { id: Counter })
            yield* Machine.spawn(counter, { id: Counter }).pipe(
              Effect.catchTag("ChildAlreadyExistsError", (error) => Deferred.succeed(failed, error.id))
            )
          }),
          strategy
        )
        assert.strictEqual(yield* Deferred.await(failed), "counter")
      }))

    it.effect("addresses child machines by descriptor and ignores missing children", () =>
      Effect.gen(function*() {
        const sent = yield* Deferred.make<void>()
        const stop = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const owner = yield* startOwner(
          Effect.gen(function*() {
            // An equal descriptor, and one for another machine under the same id.
            yield* Machine.sendTo(Machine.childFamily(worker)("worker"), WorkerEvents.Add({ by: 4 }))
            yield* Machine.sendTo(Counter, 1)
            yield* Machine.stopChild(Counter)
            yield* Deferred.succeed(sent, undefined)
            yield* Deferred.await(stop)
            yield* Machine.stopChild(Machine.child("worker", worker))
            yield* Deferred.succeed(stopped, undefined)
          }),
          strategy
        )
        yield* Deferred.await(sent)
        const child: Machine.ChildMachine.Ref<typeof Worker> = Option.getOrThrow(yield* owner.child(Worker))
        yield* Machine.waitFor(child, (snapshot) => snapshot.state.value.count === 4)
        yield* Deferred.succeed(stop, undefined)
        yield* Deferred.await(stopped)
        assert.isTrue(Option.isNone(yield* owner.child(Worker)))
        assert.strictEqual((yield* child.snapshot).status, "stopped")
      }))
  })
}
