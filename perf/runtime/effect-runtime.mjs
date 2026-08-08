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
const { Deferred, Effect, Fiber, MutableRef, Queue, Ref, SynchronizedRef } = effect

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

const makeActorFamily = () =>
  Effect.all([makeActorShell(), makeActorShell()], { concurrency: 1 }).pipe(
    Effect.map((units) => ({
      fibers: units.flatMap((unit) => unit.fibers),
      queues: units.flatMap((unit) => unit.queues),
      retained: units
    }))
  )

const runLifecycle = async (make, expectedUnits = 1) => {
  const units = await startUnits(expectedUnits, make)
  try {
    if (units.length !== expectedUnits) {
      throw new Error(`Effect runtime lifecycle started ${units.length} units, expected ${expectedUnits}`)
    }
    return 1
  } finally {
    await stopUnits(units)
  }
}

const mutableSnapshot = MutableRef.make(0)
const runMutableSnapshotBatch = (size) => {
  const before = MutableRef.get(mutableSnapshot)
  for (let index = 0; index < size; index += 1) {
    MutableRef.update(mutableSnapshot, (value) => value + 1)
  }
  return MutableRef.get(mutableSnapshot) - before
}

const synchronizedSnapshot = Effect.runSync(SynchronizedRef.make(0))
const runSynchronizedSnapshotBatch = (size) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const before = yield* SynchronizedRef.get(synchronizedSnapshot)
      for (let index = 0; index < size; index += 1) {
        yield* SynchronizedRef.update(synchronizedSnapshot, (value) => value + 1)
      }
      return (yield* SynchronizedRef.get(synchronizedSnapshot)) - before
    })
  )

const runTerminalLatchBatch = (size) =>
  Effect.runPromise(
    Effect.gen(function*() {
      for (let index = 0; index < size; index += 1) {
        const latch = yield* Deferred.make()
        yield* Deferred.succeed(latch, undefined)
        yield* Deferred.await(latch)
      }
      return size
    })
  )

export const makeEffectRuntimeAdapter = (version) => ({
  implementation: "effect-runtime",
  label: "Effect runtime primitives",
  version,
  runtimeBenchmarks: [
    {
      id: "effect-fiber-start-stop",
      label: "Start and interrupt a suspended fiber",
      unit: "fibers/s",
      async: true,
      operations: () => 1,
      run: () => runLifecycle(makeFiber)
    },
    {
      id: "effect-mailbox-start-stop",
      label: "Start and stop a queue worker",
      unit: "workers/s",
      async: true,
      operations: () => 1,
      run: () => runLifecycle(makeMailbox)
    },
    {
      id: "effect-actor-shell-start-stop",
      label: "Start and stop an actor shell",
      unit: "actors/s",
      async: true,
      operations: () => 1,
      run: () => runLifecycle(makeActorShell)
    },
    {
      id: "effect-actor-family-start-stop",
      label: "Start and stop two actor shells",
      unit: "families/s",
      async: true,
      operations: () => 1,
      run: () => runLifecycle(makeActorFamily)
    },
    {
      id: "effect-mutable-snapshot-update",
      label: "Update an owner-only mutable snapshot",
      unit: "updates/s",
      async: false,
      operations: (configuration) => configuration.primitiveBatchSize,
      run: runMutableSnapshotBatch
    },
    {
      id: "effect-synchronized-snapshot-update",
      label: "Update a synchronized snapshot",
      unit: "updates/s",
      async: true,
      operations: (configuration) => configuration.primitiveBatchSize,
      run: runSynchronizedSnapshotBatch
    },
    {
      id: "effect-terminal-latch",
      label: "Create, resolve, and await a terminal latch",
      unit: "latches/s",
      async: true,
      operations: (configuration) => configuration.primitiveBatchSize,
      run: runTerminalLatchBatch
    }
  ],
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
    },
    "effect-actor-family": {
      label: "Two Effect actor shells",
      start: (count) => startUnits(count, makeActorFamily),
      stop: stopUnits
    }
  }
})
