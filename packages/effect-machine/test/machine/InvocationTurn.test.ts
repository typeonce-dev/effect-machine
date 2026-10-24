import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"
import { openWithRuntimeStrategy } from "../internal/machine/support/strategyDifferential.js"

const WorkStates = Machine.state({ states: { Idle: {}, Working: {}, Done: {} } })
const WorkEvents = Machine.events({ Go: {}, Cancel: {} })

const makeWorkMachine = (work: Effect.Effect<void>) =>
  Machine.make({
    root: WorkStates,
    events: WorkEvents,
    effects: { work }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Go: { target: "Working" } } },
      Working: {
        invoke: { src: "work", onDone: { target: "Done" } },
        on: { Cancel: { target: "Idle" } }
      },
      Done: {}
    }
  })

const LoopStates = Machine.state({ fields: { hops: Schema.Number }, states: { Idle: {}, Ticking: {} } })

const loopMachine = Machine.make({
  root: LoopStates,
  events: Machine.events({ Go: {}, Halt: {} }),
  effects: { tick: Effect.void }
}).handle({
  root: () => ({ hops: 0 }),
  initial: { target: "Idle" },
  on: { Halt: { target: "Idle" } },
  states: {
    Idle: { on: { Go: { target: "Ticking" } } },
    Ticking: {
      invoke: {
        src: "tick",
        onDone: {
          target: "Ticking",
          reenter: true,
          update: "root",
          data: ({ root }) => ({ target: undefined, update: { hops: root.hops + 1 } })
        }
      }
    }
  }
})

const HostStates = Machine.state({ states: { Idle: {}, Hosting: {} } })

const makeHostMachine = (started: Array<string>, release: Deferred.Deferred<void>) => {
  const Worker = Machine.child(
    "worker",
    Machine.make({
      root: Machine.state({ states: { Working: {} } }),
      events: Machine.events({}),
      effects: {
        work: Effect.sync(() => {
          started.push("child work")
        }).pipe(Effect.andThen(Deferred.await(release)))
      }
    }).handle({
      initial: { target: "Working" },
      states: { Working: { invoke: { src: "work", onDone: { none: true } } } }
    })
  )
  return Machine.make({
    root: HostStates,
    events: Machine.events({ Host: {} }),
    children: { worker: Worker }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Host: { target: "Hosting" } } },
      Hosting: { invoke: { src: "worker" } }
    }
  })
}

const leafPath = (snapshot: Machine.RuntimeSnapshot<any, any, any>) => snapshot.state.state.path

describe("invocations entered by a send", () => {
  for (const strategy of ["generic", "compiled"] as const) {
    describe(`${strategy} runtime`, () => {
      it.effect("runs invoked work until it first suspends before send returns", () =>
        Effect.gen(function*() {
          const release = yield* Deferred.make<void>()
          const steps: Array<string> = []
          const ref = yield* openWithRuntimeStrategy(
            makeWorkMachine(
              Effect.sync(() => {
                steps.push("before suspension")
              }).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.sync(() => {
                  steps.push("after suspension")
                }))
              )
            ),
            strategy
          )
          Effect.runSync(ref.send(WorkEvents.Go()))
          steps.push("send returned")
          assert.deepStrictEqual(steps, ["before suspension", "send returned"])
          yield* Deferred.succeed(release, undefined)
          yield* Machine.waitFor(ref, (snapshot) => WorkStates.matches(snapshot.state, "Done"))
          assert.deepStrictEqual(steps, ["before suspension", "send returned", "after suspension"])
        }).pipe(Effect.scoped))

      it.effect("publishes the entered state before the outcome of work that completes without suspending", () =>
        Effect.gen(function*() {
          const ref = yield* openWithRuntimeStrategy(makeWorkMachine(Effect.void), strategy)
          const paths: Array<string> = []
          yield* ref.changes.pipe(
            Stream.runForEach((snapshot) => Effect.sync(() => paths.push(leafPath(snapshot)))),
            Effect.forkChild({ startImmediately: true })
          )
          Effect.runSync(ref.send(WorkEvents.Go()))
          assert.strictEqual(leafPath(Effect.runSync(ref.snapshot)), "Working")
          yield* Machine.waitFor(ref, (snapshot) => WorkStates.matches(snapshot.state, "Done"))
          yield* Effect.yieldNow
          assert.deepStrictEqual(paths, ["Idle", "Working", "Done"])
        }).pipe(Effect.scoped))

      it.effect("discards the outcome of work whose state was exited before the outcome arrived", () =>
        Effect.gen(function*() {
          const ref = yield* openWithRuntimeStrategy(makeWorkMachine(Effect.void), strategy)
          const paths: Array<string> = []
          yield* ref.changes.pipe(
            Stream.runForEach((snapshot) => Effect.sync(() => paths.push(leafPath(snapshot)))),
            Effect.forkChild({ startImmediately: true })
          )
          Effect.runSync(ref.send(WorkEvents.Go()))
          Effect.runSync(ref.send(WorkEvents.Cancel()))
          yield* Machine.waitFor(ref, (snapshot) => WorkStates.matches(snapshot.state, "Idle") && paths.length > 1)
          for (let index = 0; index < 5; index++) {
            yield* Effect.yieldNow
          }
          assert.strictEqual(leafPath(yield* ref.snapshot), "Idle")
          assert.deepStrictEqual(paths, ["Idle", "Working", "Idle"])
        }).pipe(Effect.scoped))

      it.effect("fails the machine after send returns when work dies without suspending", () =>
        Effect.gen(function*() {
          const ref = yield* openWithRuntimeStrategy(makeWorkMachine(Effect.die("boom")), strategy)
          Effect.runSync(ref.send(WorkEvents.Go()))
          const snapshot = Effect.runSync(ref.snapshot)
          assert.strictEqual(snapshot.status, "active")
          assert.strictEqual(leafPath(snapshot), "Working")
          const exit = yield* Effect.exit(ref.join)
          assert.isTrue(Exit.isFailure(exit))
        }).pipe(Effect.scoped))

      it.effect("handles each outcome of instantly completing work in a later turn", () =>
        Effect.gen(function*() {
          const ref = yield* openWithRuntimeStrategy(loopMachine, strategy)
          Effect.runSync(ref.send({ _tag: "Go" }))
          assert.strictEqual((Effect.runSync(ref.state).value as { readonly hops: number }).hops, 0)
          yield* Machine.waitFor(ref, (snapshot) => (snapshot.state.value as { readonly hops: number }).hops >= 3)
          yield* ref.send({ _tag: "Halt" })
        }).pipe(Effect.scoped))

      it.effect("starts an invoked child's initial work before send returns", () =>
        Effect.gen(function*() {
          const started: Array<string> = []
          const release = yield* Deferred.make<void>()
          const ref = yield* openWithRuntimeStrategy(makeHostMachine(started, release), strategy)
          Effect.runSync(ref.send({ _tag: "Host" }))
          assert.deepStrictEqual(started, ["child work"])
          assert.strictEqual(leafPath(Effect.runSync(ref.snapshot)), "Hosting")
        }).pipe(Effect.scoped))
    })
  }
})
