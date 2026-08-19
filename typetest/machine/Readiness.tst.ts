import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"
import { ClusterMachine } from "../../src/unstable/cluster/index.js"
import { AtomMachine } from "../../src/unstable/reactivity/index.js"

class Ready extends Schema.TaggedClass<Ready>("Ready")("Ready", {}) {}
class Flow extends Schema.TaggedClass<Flow>("Flow")("Flow", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Done extends Schema.TaggedClass<Done>("Done")("Done", { value: Schema.String }) {}
class Tick extends Schema.TaggedClass<Tick>("Tick")("Tick", {}) {}

const choiceStates = Machine.states({
  Ready,
  Flow: {
    schema: Flow,
    initial: "Route",
    states: {
      Route: { type: "choice" },
      Idle
    }
  }
})

const choiceIncomplete = Machine.make({
  states: choiceStates.states,
  events: Machine.events(Tick),
  initial: (to) => to.Ready().resolve(({ target }) => (target(new Ready({}))))
})
const choiceSnapshot = { path: "Ready" as const, value: new Ready({}) }

const historyStates = Machine.states({
  Ready,
  Flow: {
    schema: Flow,
    initial: "Idle",
    states: {
      Idle,
      recent: { type: "history", history: "deep" }
    }
  }
})

const historyIncomplete = Machine.make({
  states: historyStates.states,
  events: Machine.events(Tick),
  initial: (to) => to.Ready().resolve(({ target }) => (target(new Ready({}))))
})
const historySnapshot = { path: "Ready" as const, value: new Ready({}) }

const outputStates = Machine.states({
  Ready,
  Done: {
    schema: Done,
    type: "final",
    output: Schema.String
  }
})

const outputIncomplete = Machine.make({
  states: outputStates.states,
  events: Machine.events(Tick),
  initial: (to) => to.Ready().resolve(({ target }) => (target(new Ready({}))))
})
const outputSnapshot = { path: "Ready" as const, value: new Ready({}) }
type InvokeSelector = Machine.Machine.InvokeSelector<
  typeof outputStates.states,
  readonly [typeof Tick],
  readonly [],
  "Ready"
>

const bound = null as unknown as AtomMachine.Bound<never>
const from = null as unknown as InvokeSelector

describe("executable machine readiness", () => {
  it("rejects an unimplemented choice at every planning and execution boundary", () => {
    expect(Machine.planInitial).type.not.toBeCallableWith(choiceIncomplete)
    expect(Machine.plan).type.not.toBeCallableWith(choiceIncomplete, choiceSnapshot, new Tick({}))
    expect(Machine.start).type.not.toBeCallableWith(choiceIncomplete)
    expect(Machine.resume).type.not.toBeCallableWith(choiceIncomplete, choiceSnapshot)
    expect(from.child).type.not.toBeCallableWith(Machine.child("choice", choiceIncomplete))
    expect(MachineTest.run).type.not.toBeCallableWith(choiceIncomplete, { events: [] })
    expect(AtomMachine.make).type.not.toBeCallableWith(choiceIncomplete)
    expect(AtomMachine.resume).type.not.toBeCallableWith(choiceIncomplete, choiceSnapshot)
    expect(bound.make).type.not.toBeCallableWith(choiceIncomplete)
    expect(bound.resume).type.not.toBeCallableWith(choiceIncomplete, choiceSnapshot)
    expect(ClusterMachine.make).type.not.toBeCallableWith("Choice", choiceIncomplete, { version: "1" })
  })

  it("rejects an unimplemented history default at every planning and execution boundary", () => {
    expect(Machine.planInitial).type.not.toBeCallableWith(historyIncomplete)
    expect(Machine.plan).type.not.toBeCallableWith(historyIncomplete, historySnapshot, new Tick({}))
    expect(Machine.start).type.not.toBeCallableWith(historyIncomplete)
    expect(Machine.resume).type.not.toBeCallableWith(historyIncomplete, historySnapshot)
    expect(from.child).type.not.toBeCallableWith(Machine.child("history", historyIncomplete))
    expect(MachineTest.run).type.not.toBeCallableWith(historyIncomplete, { events: [] })
    expect(AtomMachine.make).type.not.toBeCallableWith(historyIncomplete)
    expect(AtomMachine.resume).type.not.toBeCallableWith(historyIncomplete, historySnapshot)
    expect(bound.make).type.not.toBeCallableWith(historyIncomplete)
    expect(bound.resume).type.not.toBeCallableWith(historyIncomplete, historySnapshot)
    expect(ClusterMachine.make).type.not.toBeCallableWith("History", historyIncomplete, { version: "1" })
  })

  it("rejects an unimplemented output at every planning and execution boundary", () => {
    expect(Machine.planInitial).type.not.toBeCallableWith(outputIncomplete)
    expect(Machine.plan).type.not.toBeCallableWith(outputIncomplete, outputSnapshot, new Tick({}))
    expect(Machine.start).type.not.toBeCallableWith(outputIncomplete)
    expect(Machine.resume).type.not.toBeCallableWith(outputIncomplete, outputSnapshot)
    expect(from.child).type.not.toBeCallableWith(Machine.child("output", outputIncomplete))
    expect(MachineTest.run).type.not.toBeCallableWith(outputIncomplete, { events: [] })
    expect(AtomMachine.make).type.not.toBeCallableWith(outputIncomplete)
    expect(AtomMachine.resume).type.not.toBeCallableWith(outputIncomplete, outputSnapshot)
    expect(bound.make).type.not.toBeCallableWith(outputIncomplete)
    expect(bound.resume).type.not.toBeCallableWith(outputIncomplete, outputSnapshot)
    expect(ClusterMachine.make).type.not.toBeCallableWith("Output", outputIncomplete, { version: "1" })
  })

  it("accepts a complete machine and preserves its exact channels through every adapter", () => {
    const completeStates = Machine.states({
      Ready,
      Flow: {
        schema: Flow,
        initial: "Route",
        states: {
          Route: { type: "choice" },
          Idle,
          recent: { type: "history", history: "deep" },
          Done: {
            schema: Done,
            type: "final",
            output: Schema.String
          }
        }
      }
    })
    const complete = Machine.make({
      states: completeStates.states,
      events: Machine.events(Tick),
      initial: (to) => to.Ready().resolve(({ target }) => (target(new Ready({}))))
    }).handle({
      Flow: {
        history: {
          recent: {
            default: ({ target }) =>
              target.Flow(
                new Flow({}),
                (flow) => flow.Idle(new Idle({}))
              )
          }
        },
        states: {
          Route: {
            choice: (to) => to.local.Idle().resolve(({ target }) => target(new Idle({})))
          },
          Done: {
            output: ({ state }) => state.value
          }
        }
      }
    })
    const completeSnapshot = { path: "Ready" as const, value: new Ready({}) }

    const plannedInitial = Machine.planInitial(complete)
    const planned = Machine.plan(complete, completeSnapshot, new Tick({}))
    const started = Machine.start(complete)
    const resumed = Machine.resume(complete, completeSnapshot)
    const trace = MachineTest.run(complete, { events: [new Tick({})] })
    const atom = AtomMachine.make(complete)
    const resumedAtom = AtomMachine.resume(complete, completeSnapshot)
    const boundAtom = bound.make(complete)
    const boundResumedAtom = bound.resume(complete, completeSnapshot)
    const cluster = ClusterMachine.make("Complete", complete, { version: "1" })

    type AtomChannels<A> = A extends AtomMachine.MachineAtom<infer State, infer Event, any, infer Output, any> ?
      readonly [State, Event, Output]
      : never

    expect<Machine.Machine.UnhandledStates<typeof complete>>().type.toBe<"Ready" | "Flow.Idle">()
    expect<Machine.Machine.Output<typeof complete>>().type.toBe<string>()
    expect<Machine.Machine.InputEvent<typeof complete>>().type.toBe<Tick>()
    expect<Effect.Success<typeof plannedInitial>["state"]>().type.toBe<
      Machine.Machine.Snapshot<typeof completeStates.states>
    >()
    expect<Effect.Success<typeof planned>["next"]>().type.toBe<
      Machine.Machine.Snapshot<typeof completeStates.states>
    >()
    expect<Effect.Success<typeof started>["send"]>().type.toBe<
      (event: Machine.Machine.EventInput<Tick>) => Effect.Effect<void, Machine.StoppedError>
    >()
    expect<Effect.Success<typeof resumed>["send"]>().type.toBe<
      (event: Machine.Machine.EventInput<Tick>) => Effect.Effect<void, Machine.StoppedError>
    >()
    expect<Effect.Success<typeof trace>>().type.toBe<MachineTest.Trace<typeof complete>>()
    expect<AtomChannels<typeof atom>>().type.toBe<
      readonly [
        Machine.Machine.Snapshot<typeof completeStates.states>,
        Machine.Machine.EventInput<Tick>,
        string
      ]
    >()
    expect<AtomChannels<typeof resumedAtom>>().type.toBe<
      readonly [
        Machine.Machine.Snapshot<typeof completeStates.states>,
        Machine.Machine.EventInput<Tick>,
        string
      ]
    >()
    expect<AtomChannels<typeof boundAtom>>().type.toBe<
      readonly [
        Machine.Machine.Snapshot<typeof completeStates.states>,
        Machine.Machine.EventInput<Tick>,
        string
      ]
    >()
    expect<AtomChannels<typeof boundResumedAtom>>().type.toBe<
      readonly [
        Machine.Machine.Snapshot<typeof completeStates.states>,
        Machine.Machine.EventInput<Tick>,
        string
      ]
    >()
    expect(cluster.machine).type.toBe<typeof complete>()
  })
})
