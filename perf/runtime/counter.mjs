import { Effect, Schema } from "effect"
import { Machine } from "../../dist/index.js"

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

export const effectMachineAdapter = {
  implementation: "effect-machine",
  label: "Effect Machine",
  version: undefined,
  async: true,
  planCounterBatch,
  runCounterBurst,
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
  startCounter,
  startCounters,
  stopCounter,
  stopCounters
}
