import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const implementationRoot = resolve(
  process.env.EFFECT_MACHINE_BENCHMARK_ROOT ?? fileURLToPath(new URL("../..", import.meta.url))
)
const implementationRequire = createRequire(pathToFileURL(join(implementationRoot, "package.json")))
const effectPackagePath = implementationRequire.resolve("effect/package.json")
const effectPackage = JSON.parse(readFileSync(effectPackagePath, "utf8"))
const effect = await import(pathToFileURL(resolve(dirname(effectPackagePath), effectPackage.exports["."])).href)
const { Deferred, Effect, Fiber, Queue, Ref } = effect

const startUnits = (count, make) =>
  Effect.runPromise(
    Effect.forEach(Array.from({ length: count }), make, { concurrency: 1 })
  )

const stopUnits = (units) =>
  Effect.runPromise(
    Effect.forEach(
      units,
      (unit) =>
        Fiber.interruptAll(unit.fibers).pipe(
          Effect.andThen(Effect.forEach(unit.queues, Queue.shutdown, { discard: true }))
        ),
      { concurrency: "unbounded", discard: true }
    )
  )

const makeFiber = () =>
  Effect.map(Effect.forkDetach(Effect.never), (fiber) => ({
    fibers: [fiber],
    queues: []
  }))

const makeMailbox = () =>
  Effect.gen(function*() {
    const queue = yield* Queue.unbounded()
    const fiber = yield* Effect.forkDetach(Effect.forever(Queue.take(queue)))
    return { fibers: [fiber], queues: [queue] }
  })

const makeActorShell = () =>
  Effect.gen(function*() {
    const queue = yield* Queue.unbounded()
    const state = yield* Ref.make(0)
    const done = yield* Deferred.make()
    const fiber = yield* Effect.forkDetach(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((update) => Ref.update(state, update))
        )
      )
    )
    return { fibers: [fiber], queues: [queue], retained: [state, done] }
  })

export const makeEffectMemoryAdapter = (version) => ({
  implementation: "effect-runtime",
  label: "Effect runtime primitives",
  version,
  memoryProfiles: {
    "effect-fiber": {
      label: "Suspended Effect fiber",
      start: (count) => startUnits(count, makeFiber),
      stop: stopUnits
    },
    "effect-mailbox": {
      label: "Effect queue with waiting fiber",
      start: (count) => startUnits(count, makeMailbox),
      stop: stopUnits
    },
    "effect-actor-shell": {
      label: "Effect mailbox actor shell",
      start: (count) => startUnits(count, makeActorShell),
      stop: stopUnits
    }
  }
})
