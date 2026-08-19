import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { makeEffectMachineBenchmarkApi } from "./effect-machine-compatibility.mjs"

const implementationRoot = resolve(
  process.env.EFFECT_MACHINE_BENCHMARK_ROOT ?? fileURLToPath(new URL("../..", import.meta.url))
)
const implementationRequire = createRequire(pathToFileURL(join(implementationRoot, "package.json")))
const effectPackagePath = implementationRequire.resolve("effect/package.json")
const effectPackage = JSON.parse(readFileSync(effectPackagePath, "utf8"))
const effect = await import(pathToFileURL(resolve(dirname(effectPackagePath), effectPackage.exports["."])).href)
const { Machine } = await import(pathToFileURL(join(implementationRoot, "dist/index.js")).href)
const benchmarkApi = makeEffectMachineBenchmarkApi(Machine)
const machineRuntimePath = [
  join(implementationRoot, "dist/internal/machine/runtime.js"),
  join(implementationRoot, "dist/internal/machineRuntime.js")
].find(existsSync)
if (machineRuntimePath === undefined) {
  throw new Error("Effect Machine benchmark could not locate the internal runtime module")
}
const machineRuntime = await import(pathToFileURL(machineRuntimePath).href)
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

const CounterStates = benchmarkApi.states({
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
  events: benchmarkApi.events(CounterEvent.cases.Increment, CounterEvent.cases.Finish),
  initial: benchmarkApi.initial({
    target: (to) => to.Count(),
    resolve: ({ target }) => target(CounterState.cases.Count.make({ value: 0 }))
  }, () => CounterStates.initial.Count.from({ value: 0 }))
}).handle({
  Count: {
    on: {
      Increment: benchmarkApi.transition({
        target: (to) => to.full.Count(),
        resolve: ({ state, target }) => target.from({ value: state.value + 1 })
      }, ({ state, target }) => target.full.Count.from({ value: state.value + 1 })),
      Finish: benchmarkApi.transition({
        target: (to) => to.full.Done(),
        resolve: ({ state, target }) => target.from({ value: state.value })
      }, ({ state, target }) => target.full.Done.from({ value: state.value }))
    }
  },
  Done: {
    output: ({ state }) => state.value
  }
})

const ParentState = Schema.TaggedUnion({ Active: {} })
const ParentStates = benchmarkApi.states({ Active: ParentState.cases.Active })
const CounterChild = Machine.child("counter", counterMachine)
const counterParentMachine = Machine.make({
  id: "RuntimeBenchmarkCounterParent",
  states: ParentStates.states,
  events: benchmarkApi.events(),
  initial: benchmarkApi.initial({
    target: (to) => to.Active(),
    resolve: ({ target }) => target.from()
  }, () => ParentStates.initial.Active.from())
}).handle({
  Active: {
    invoke: benchmarkApi.invokeChild({ child: CounterChild, onDone: benchmarkApi.targetless })
  }
})

const counterSnapshotParentMachine = Machine.make({
  id: "RuntimeBenchmarkSnapshotCounterParent",
  states: ParentStates.states,
  events: benchmarkApi.events(),
  initial: benchmarkApi.initial({
    target: (to) => to.Active(),
    resolve: ({ target }) => target.from()
  }, () => ParentStates.initial.Active.from())
}).handle({
  Active: {
    invoke: benchmarkApi.invokeChild({
      child: CounterChild,
      onDone: benchmarkApi.targetless,
      onSnapshot: benchmarkApi.targetless
    })
  }
})

const HierarchicalState = Schema.TaggedUnion({
  Active: {},
  Count: { value: Schema.Number },
  Complete: { value: Schema.Number }
})

const HierarchicalEvent = Schema.TaggedUnion({
  Increment: {},
  IncrementLeft: {},
  IncrementRight: {},
  Finish: {}
})

const HierarchicalStates = benchmarkApi.states({
  Active: {
    schema: HierarchicalState.cases.Active,
    initial: "Count",
    states: {
      Count: HierarchicalState.cases.Count
    }
  },
  Complete: {
    schema: HierarchicalState.cases.Complete,
    type: "final",
    output: Schema.Number
  }
})

const hierarchicalCounterMachine = Machine.make({
  id: "RuntimeBenchmarkHierarchicalCounter",
  states: HierarchicalStates.states,
  events: benchmarkApi.events(HierarchicalEvent.cases.Increment, HierarchicalEvent.cases.Finish),
  initial: benchmarkApi.initial({
    target: (to) => to.Active.initial,
    resolve: ({ target }) => target.from((active) => active.Count.from({ value: 0 }))
  }, () =>
    HierarchicalStates.initial.Active.from(
      (active) => active.Count.from({ value: 0 })
    ))
}).handle({
  Active: {
    states: {
      Count: {
        on: {
          Increment: benchmarkApi.transition({
            target: (to) => to.local.Count(),
            resolve: ({ state, target }) => target.from({ value: state.value + 1 })
          }, ({ state, target }) => target.local.Count.from({ value: state.value + 1 })),
          Finish: benchmarkApi.transition({
            target: (to) => to.full.Complete(),
            resolve: ({ state, target }) => target.from({ value: state.value })
          }, ({ state, target }) => target.full.Complete.from({ value: state.value }))
        }
      }
    }
  },
  Complete: {
    output: ({ state }) => state.value
  }
})

const ParallelState = Schema.TaggedUnion({
  Active: {},
  Left: { value: Schema.Number },
  Right: { value: Schema.Number },
  Complete: { value: Schema.Number }
})

const ParallelStates = benchmarkApi.states({
  Active: {
    schema: ParallelState.cases.Active,
    type: "parallel",
    states: {
      Left: ParallelState.cases.Left,
      Right: ParallelState.cases.Right
    }
  },
  Complete: {
    schema: ParallelState.cases.Complete,
    type: "final",
    output: Schema.Number
  }
})

const parallelCounterMachine = Machine.make({
  id: "RuntimeBenchmarkParallelCounter",
  states: ParallelStates.states,
  events: benchmarkApi.events(HierarchicalEvent.cases.IncrementLeft, HierarchicalEvent.cases.IncrementRight, HierarchicalEvent.cases.Finish),
  initial: benchmarkApi.initial({
    target: (to) => to.Active.initial,
    resolve: ({ target }) =>
      target.from((active) =>
        active
          .Left.from({ value: 0 })
          .Right.from({ value: 0 }))
  }, () =>
    ParallelStates.initial.Active.from(
      (active) =>
        active
          .Left.from({ value: 0 })
          .Right.from({ value: 0 })
    ))
}).handle({
  Active: {
    on: {
      Finish: benchmarkApi.transition({
        target: (to) => to.full.Complete(),
        resolve: ({ snapshot, target }) => target.from({
          value: snapshot.states.Left.value.value + snapshot.states.Right.value.value
        })
      }, ({ snapshot, target }) =>
        target.full.Complete.from({
          value: snapshot.states.Left.value.value + snapshot.states.Right.value.value
        }))
    },
    states: {
      Left: {
        on: {
          IncrementLeft: benchmarkApi.transition({
            target: (to) => to.branch.Active.Left(),
            resolve: ({ state, target }) => target.from({ value: state.value + 1 })
          }, ({ state, target }) => target.branch.Active.Left.from({ value: state.value + 1 }))
        }
      },
      Right: {
        on: {
          IncrementRight: benchmarkApi.transition({
            target: (to) => to.branch.Active.Right(),
            resolve: ({ state, target }) => target.from({ value: state.value + 1 })
          }, ({ state, target }) => target.branch.Active.Right.from({ value: state.value + 1 }))
        }
      }
    }
  },
  Complete: {
    output: ({ state }) => state.value
  }
})

export const incrementEvent = { _tag: "Increment" }
const finishEvent = { _tag: "Finish" }
const hierarchicalIncrementEvent = { _tag: "Increment" }
const hierarchicalFinishEvent = { _tag: "Finish" }
const parallelIncrementLeftEvent = { _tag: "IncrementLeft" }
const parallelIncrementRightEvent = { _tag: "IncrementRight" }
const parallelFinishEvent = { _tag: "Finish" }

export const initialCounterSnapshot = Effect.runSync(
  Machine.planInitial(counterMachine).pipe(Effect.map((planned) => planned.state))
)
const initialHierarchicalSnapshot = Effect.runSync(
  Machine.planInitial(hierarchicalCounterMachine).pipe(Effect.map((planned) => planned.state))
)
const initialParallelSnapshot = Effect.runSync(
  Machine.planInitial(parallelCounterMachine).pipe(Effect.map((planned) => planned.state))
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

const planHierarchicalCounterBatch = (size) =>
  Effect.runSync(
    Effect.gen(function*() {
      let snapshot = initialHierarchicalSnapshot
      for (let index = 0; index < size; index += 1) {
        snapshot = (yield* Machine.plan(hierarchicalCounterMachine, snapshot, hierarchicalIncrementEvent)).next
      }
      return snapshot.state.value.value
    })
  )

const planParallelCounterBatch = (size) =>
  Effect.runSync(
    Effect.gen(function*() {
      let snapshot = initialParallelSnapshot
      for (let index = 0; index < size; index += 1) {
        snapshot = (yield* Machine.plan(
          parallelCounterMachine,
          snapshot,
          index % 2 === 0 ? parallelIncrementLeftEvent : parallelIncrementRightEvent
        )).next
      }
      return snapshot.states.Left.value.value + snapshot.states.Right.value.value
    })
  )

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
    return yield* Effect.die(new Error("Effect Machine child did not become ready"))
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
          return yield* Effect.die(new Error("Effect Machine child disappeared during the benchmark"))
        }
        yield* child.value.send(incrementEvent)
      }
      const child = yield* parent.child(CounterChild)
      if (Option.isNone(child)) {
        return yield* Effect.die(new Error("Effect Machine child disappeared before the terminal fence"))
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

const startHierarchicalCounter = () => Effect.runPromise(Machine.start(hierarchicalCounterMachine))
const startParallelCounter = () => Effect.runPromise(Machine.start(parallelCounterMachine))

const startObservedHierarchicalCounter = () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const ref = yield* Machine.start(hierarchicalCounterMachine)
      const observer = yield* ref.changes.pipe(Stream.runDrain, Effect.forkDetach)
      yield* Effect.yieldNow
      return { ref, observer }
    })
  )

const runHierarchicalCounterBurst = (ref, size) =>
  Effect.runPromise(
    Effect.gen(function*() {
      for (let index = 0; index < size; index += 1) {
        yield* ref.send(hierarchicalIncrementEvent)
      }
      yield* ref.send(hierarchicalFinishEvent)
      return yield* ref.join
    })
  )

const runParallelCounterBurst = (ref, size) =>
  Effect.runPromise(
    Effect.gen(function*() {
      for (let index = 0; index < size; index += 1) {
        yield* ref.send(index % 2 === 0 ? parallelIncrementLeftEvent : parallelIncrementRightEvent)
      }
      yield* ref.send(parallelFinishEvent)
      return yield* ref.join
    })
  )

const runObservedHierarchicalCounterBurst = ({ ref, observer }, size) =>
  Effect.runPromise(
    Effect.gen(function*() {
      for (let index = 0; index < size; index += 1) {
        yield* ref.send(hierarchicalIncrementEvent)
      }
      yield* ref.send(hierarchicalFinishEvent)
      const value = yield* ref.join
      yield* Fiber.join(observer)
      return value
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

// The head harness benchmarks both the base and head builds. Keep the fixture
// bilingual across the protocol migration so both sides are forced through
// their compact runtime rather than silently comparing different strategies.
const rawCompiledProcessLogic = machineRuntime.compiledProcess === undefined
  ? {
    execution: {
      _tag: "Compiled",
      childless: false,
      drain: {
        _tag: "Process",
        run: () => Effect.succeed(Option.none())
      }
    },
    initial: () => Effect.succeed(0),
    run: () => Effect.never
  }
  : {
    [machineRuntime.compiledProcess]: true,
    initial: () => Effect.succeed(0),
    run: () => Effect.never,
    drain: () => Effect.succeed(Option.none())
  }

const startRawProcesses = (count) =>
  Effect.runPromise(
    Effect.forEach(
      Array.from({ length: count }),
      () => machineRuntime.startProcess(rawProcessLogic),
      { concurrency: 1 }
    )
  )

const startCompiledRawProcesses = (count) =>
  Effect.runPromise(
    Effect.forEach(
      Array.from({ length: count }),
      () => machineRuntime.startProcessWithStrategyForTesting(rawCompiledProcessLogic, "compiled"),
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
  additionalMachineBenchmarks: [
    {
      id: "hierarchical-plan-counter",
      label: "Plan transitions through a compound state",
      unit: "transitions/s",
      operations: ({ planningBatchSize }) => planningBatchSize,
      expected: (operations) => operations,
      start: () => undefined,
      run: (_, operations) => planHierarchicalCounterBatch(operations),
      stop: () => undefined
    },
    {
      id: "parallel-plan-counter",
      label: "Plan transitions through parallel regions",
      unit: "transitions/s",
      operations: ({ planningBatchSize }) => planningBatchSize,
      expected: (operations) => operations,
      start: () => undefined,
      run: (_, operations) => planParallelCounterBatch(operations),
      stop: () => undefined
    },
    {
      id: "hierarchical-runtime-burst",
      label: "Drain burst through a compound state",
      unit: "events/s",
      operations: ({ burstBatchSize }) => burstBatchSize,
      expected: (operations) => operations,
      start: startHierarchicalCounter,
      run: runHierarchicalCounterBurst,
      stop: stopCounter
    },
    {
      id: "parallel-runtime-burst",
      label: "Drain burst through two parallel regions",
      unit: "events/s",
      operations: ({ burstBatchSize }) => burstBatchSize,
      expected: (operations) => operations,
      start: startParallelCounter,
      run: runParallelCounterBurst,
      stop: stopCounter
    },
    {
      id: "observed-hierarchical-runtime-burst",
      label: "Drain a compound-state burst with a change observer",
      unit: "events/s",
      operations: ({ burstBatchSize }) => burstBatchSize,
      expected: (operations) => operations,
      start: startObservedHierarchicalCounter,
      run: runObservedHierarchicalCounterBurst,
      stop: stopObservedCounter
    }
  ],
  runtimeBenchmarks: [
    {
      id: "generic-process-start-stop",
      label: "Start and stop a raw generic process",
      unit: "processes/s",
      async: true,
      operations: () => 1,
      run: async () => {
        const refs = await startRawProcesses(1)
        try {
          return refs.length
        } finally {
          await stopCounters(refs)
        }
      }
    },
    {
      id: "compiled-process-start-stop",
      label: "Start and stop a raw compiled process",
      unit: "processes/s",
      async: true,
      operations: () => 1,
      run: async () => {
        const refs = await startCompiledRawProcesses(1)
        try {
          return refs.length
        } finally {
          await stopCounters(refs)
        }
      }
    }
  ],
  memoryProfiles: {
    idle: {
      label: "Idle machine",
      start: startCounters,
      stop: stopCounters
    },
    "raw-process": {
      label: "Raw generic managed process",
      start: startRawProcesses,
      stop: stopCounters
    },
    "compiled-raw-process": {
      label: "Raw compiled process",
      start: startCompiledRawProcesses,
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
      label: "Parent with observed invoked child snapshots",
      start: startSnapshotObservedChildCounters,
      stop: stopChildCounters
    }
  }
}
