import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const implementationRoot = resolve(
  process.env.EFFECT_MACHINE_BENCHMARK_ROOT ?? fileURLToPath(new URL("../..", import.meta.url))
)
const implementationRequire = createRequire(pathToFileURL(join(implementationRoot, "package.json")))
const effectPackagePath = implementationRequire.resolve("effect/package.json")
const effectPackage = JSON.parse(readFileSync(effectPackagePath, "utf8"))
const effect = await import(pathToFileURL(resolve(dirname(effectPackagePath), effectPackage.exports["."])).href)
const { Machine } = await import(pathToFileURL(join(implementationRoot, "dist/index.js")).href)
const machineRuntime = await import(
  pathToFileURL(join(implementationRoot, "dist/internal/machineRuntime.js")).href
)
const { Effect, Fiber, Option, Schema, Stream } = effect

const CounterState = Schema.TaggedUnion({
  Count: {
    value: Schema.Number
  },
  Done: {
    value: Schema.Number
  }
})

const CounterEvent = Schema.TaggedUnion({
  Increment: {},
  Finish: {}
})

const CounterStates = Machine.defineStates({
  Count: CounterState.cases.Count,
  Done: {
    schema: CounterState.cases.Done,
    type: "final",
    output: Schema.Number
  }
})

export const counterMachine = Machine.make({
  id: "RuntimeBenchmarkCounter",
  states: CounterStates.states,
  events: [CounterEvent.cases.Increment, CounterEvent.cases.Finish],
  initial: () => CounterStates.initial.Count(CounterState.cases.Count.make({ value: 0 }))
}).handle({
  Count: {
    on: {
      Increment: ({ state, target }) =>
        target.full.Count(CounterState.cases.Count.make({ value: state.value + 1 })),
      Finish: ({ state, target }) => target.full.Done(CounterState.cases.Done.make({ value: state.value }))
    }
  },
  Done: {
    output: ({ state }) => state.value
  }
})

const ParentState = Schema.TaggedUnion({ Active: {} })
const ParentStates = Machine.defineStates({ Active: ParentState.cases.Active })
const CounterChild = Machine.child("counter", counterMachine)
const counterParentMachine = Machine.make({
  id: "RuntimeBenchmarkCounterParent",
  states: ParentStates.states,
  events: [],
  initial: () => ParentStates.initial.Active(ParentState.cases.Active.make({}))
}).handle({
  Active: {
    invoke: Machine.invokeMachine({ child: CounterChild })
  }
})

const counterSnapshotParentMachine = Machine.make({
  id: "RuntimeBenchmarkSnapshotCounterParent",
  states: ParentStates.states,
  events: [],
  initial: () => ParentStates.initial.Active(ParentState.cases.Active.make({}))
}).handle({
  Active: {
    invoke: Machine.invokeMachine({
      child: CounterChild,
      snapshot: () => undefined
    })
  }
})

export const incrementEvent = CounterEvent.cases.Increment.make({})
const finishEvent = CounterEvent.cases.Finish.make({})

export const initialCounterSnapshot = Effect.runSync(
  Machine.planInitial(counterMachine).pipe(Effect.map((planned) => planned.state))
)

export const counterValue = (snapshot) => snapshot.value.value

export const planCounterBatch = (size) => {
  return Effect.runSync(
    Effect.gen(function*() {
      let snapshot = initialCounterSnapshot
      for (let index = 0; index < size; index += 1) {
        snapshot = (yield* Machine.plan(counterMachine, snapshot, incrementEvent)).next
      }
      return counterValue(snapshot)
    })
  )
}

export const startCounter = () => Effect.runPromise(Machine.start(counterMachine))

export const stopCounter = (ref) => Effect.runPromise(ref.stop)

export const startObservedCounter = () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const ref = yield* Machine.start(counterMachine)
      const observer = yield* ref.changes.pipe(Stream.runDrain, Effect.forkDetach)
      yield* Effect.yieldNow
      return { ref, observer }
    })
  )

export const stopObservedCounter = ({ ref, observer }) =>
  Effect.runPromise(
    ref.stop.pipe(Effect.ensuring(Fiber.interrupt(observer)))
  )

export const runObservedCounterBurst = ({ ref, observer }, size) =>
  Effect.runPromise(
    Effect.gen(function*() {
      for (let index = 0; index < size; index += 1) {
        yield* ref.send(incrementEvent)
      }
      yield* ref.send(finishEvent)
      const value = yield* ref.join
      yield* Fiber.join(observer)
      return value
    })
  )

const waitForCounterChild = (parent) =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const child = yield* parent.child(CounterChild)
      if (Option.isSome(child)) {
        return child.value
      }
      yield* Effect.yieldNow
    }
    return yield* Effect.dieMessage("Effect Machine child did not become ready")
  })

export const startChildCounter = () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const parent = yield* Machine.start(counterParentMachine)
      yield* waitForCounterChild(parent)
      return parent
    })
  )

export const stopChildCounter = (parent) => Effect.runPromise(parent.stop)

export const runChildCounterBurst = (parent, size) =>
  Effect.runPromise(
    Effect.gen(function*() {
      for (let index = 0; index < size; index += 1) {
        const child = yield* parent.child(CounterChild)
        if (Option.isNone(child)) {
          return yield* Effect.dieMessage("Effect Machine child disappeared during the benchmark")
        }
        yield* child.value.send(incrementEvent)
      }
      const child = yield* parent.child(CounterChild)
      if (Option.isNone(child)) {
        return yield* Effect.dieMessage("Effect Machine child disappeared before the terminal fence")
      }
      yield* child.value.send(finishEvent)
      return yield* child.value.join
    })
  )

export const runCounterBurst = (ref, size) =>
  Effect.runPromise(
    Effect.gen(function*() {
      for (let index = 0; index < size; index += 1) {
        yield* ref.send(incrementEvent)
      }
      yield* ref.send(finishEvent)
      return yield* ref.join
    })
  )

export const startCounters = (count) =>
  Effect.runPromise(
    Effect.forEach(
      Array.from({ length: count }),
      () => Machine.start(counterMachine),
      { concurrency: 1 }
    )
  )

export const stopCounters = (refs) =>
  Effect.runPromise(
    Effect.forEach(refs, (ref) => ref.stop, {
      concurrency: "unbounded",
      discard: true
    })
  )

export const startChildCounters = (count) =>
  Effect.runPromise(
    Effect.forEach(
      Array.from({ length: count }),
      () =>
        Effect.gen(function*() {
          const parent = yield* Machine.start(counterParentMachine)
          yield* waitForCounterChild(parent)
          return parent
        }),
      { concurrency: 1 }
    )
  )

export const stopChildCounters = stopCounters

const rawProcessLogic = {
  initial: () => Effect.succeed(0),
  run: () => Effect.never
}

const startRawProcesses = (count) =>
  Effect.runPromise(
    Effect.forEach(
      Array.from({ length: count }),
      () => machineRuntime.startProcess(rawProcessLogic),
      { concurrency: 1 }
    )
  )

const startIndependentCounterPairs = (count) =>
  Effect.runPromise(
    Effect.forEach(
      Array.from({ length: count }),
      () => Effect.all([Machine.start(counterMachine), Machine.start(counterMachine)], { concurrency: 1 }),
      { concurrency: 1 }
    )
  )

const stopIndependentCounterPairs = (pairs) => stopCounters(pairs.flat())

const startObservedChildCounters = (count) =>
  Effect.runPromise(
    Effect.forEach(
      Array.from({ length: count }),
      () =>
        Effect.gen(function*() {
          const parent = yield* Machine.start(counterParentMachine)
          yield* waitForCounterChild(parent)
          const observer = yield* parent.childChanges(CounterChild).pipe(
            Stream.runDrain,
            Effect.forkDetach
          )
          yield* Effect.yieldNow
          return { parent, observer }
        }),
      { concurrency: 1 }
    )
  )

const startSnapshotObservedChildCounters = (count) =>
  Effect.runPromise(
    Effect.forEach(
      Array.from({ length: count }),
      () =>
        Effect.gen(function*() {
          const parent = yield* Machine.start(counterSnapshotParentMachine)
          yield* waitForCounterChild(parent)
          return parent
        }),
      { concurrency: 1 }
    )
  )

const stopObservedChildCounters = (units) =>
  Effect.runPromise(
    Effect.forEach(
      units,
      ({ parent, observer }) => parent.stop.pipe(Effect.ensuring(Fiber.interrupt(observer))),
      { concurrency: "unbounded", discard: true }
    )
  )

export const effectMachineAdapter = {
  implementation: "effect-machine",
  label: "Effect Machine",
  version: undefined,
  async: true,
  planCounterBatch,
  runCounterBurst,
  runObservedCounterBurst,
  runChildCounterBurst,
  runLifecycle: async () => {
    const ref = await startCounter()
    try {
      if (!ref.sessionId.startsWith("machine:")) {
        throw new Error(`Lifecycle benchmark produced invalid session id ${ref.sessionId}`)
      }
    } finally {
      await stopCounter(ref)
    }
  },
  runChildLifecycle: async () => {
    const parent = await startChildCounter()
    try {
      if (!parent.sessionId.startsWith("machine:")) {
        throw new Error(`Child lifecycle benchmark produced invalid session id ${parent.sessionId}`)
      }
    } finally {
      await stopChildCounter(parent)
    }
  },
  startCounter,
  startObservedCounter,
  startChildCounter,
  startCounters,
  startChildCounters,
  stopCounter,
  stopChildCounter,
  stopChildCounters,
  stopObservedCounter,
  stopCounters,
  memoryProfiles: {
    idle: {
      label: "Idle machine",
      start: startCounters,
      stop: stopCounters
    },
    "raw-process": {
      label: "Raw managed process",
      start: startRawProcesses,
      stop: stopCounters
    },
    "two-independent": {
      label: "Two independent idle machines",
      start: startIndependentCounterPairs,
      stop: stopIndependentCounterPairs
    },
    "parent-with-child": {
      label: "Idle parent with one child",
      start: startChildCounters,
      stop: stopChildCounters
    },
    "observed-parent-with-child": {
      label: "Parent with observed child registry",
      start: startObservedChildCounters,
      stop: stopObservedChildCounters
    },
    "snapshot-observed-parent-with-child": {
      label: "Parent with invoked child snapshot watcher",
      start: startSnapshotObservedChildCounters,
      stop: stopChildCounters
    }
  }
}
