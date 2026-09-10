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
const choiceStates = Machine.state({
  states: {
    Ready,
    Flow: {
      schema: Flow,
      states: {
        Route: { type: "choice" },
        Idle
      }
    }
  }
})
const choiceIncomplete = Machine.make({
  root: choiceStates,
  events: Machine.eventsFromSchemas(Tick)
}).handle({
  initial: {
    target: Machine.targets(choiceStates).root.Ready,
    decoded: true,
    data: new Ready({})
  },
  states: {
    Ready: {},
    Flow: {
      initial: {
        target: Machine.targets(choiceStates).root.Flow.Route
      },
      states: { Idle: {} }
    }
  }
})
const choiceSnapshot = { path: "" as const, value: undefined, state: { path: "Ready" as const, value: new Ready({}) } }
const historyStates = Machine.state({
  states: {
    Ready,
    Flow: {
      schema: Flow,
      states: {
        Idle,
        recent: { type: "history", history: "deep" }
      }
    }
  }
})
const historyIncomplete = Machine.make({
  root: historyStates,
  events: Machine.eventsFromSchemas(Tick)
}).handle({
  initial: {
    target: Machine.targets(historyStates).root.Ready,
    decoded: true,
    data: new Ready({})
  },
  states: {
    Ready: {},
    Flow: {
      initial: {
        target: Machine.targets(historyStates).root.Flow.Idle,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: { Idle: {} }
    }
  }
})
const historySnapshot = { path: "" as const, value: undefined, state: { path: "Ready" as const, value: new Ready({}) } }
const outputStates = Machine.state({
  states: {
    Ready,
    Done: {
      schema: Done,
      type: "final",
      output: Schema.String
    }
  }
})
const outputIncomplete = Machine.make({
  root: outputStates,
  events: Machine.eventsFromSchemas(Tick)
}).handle({
  initial: {
    target: Machine.targets(outputStates).root.Ready,
    decoded: true,
    data: new Ready({})
  },
  states: { Ready: {} }
})
const outputSnapshot = { path: "Ready" as const, value: new Ready({}) }
const parent = Machine.make({
  root: outputStates,
  events: Machine.eventsFromSchemas(Tick),
  children: {
    choice: Machine.child("choice", choiceIncomplete),
    history: Machine.child("history", historyIncomplete),
    output: Machine.child("output", outputIncomplete)
  }
})
const bound = null as unknown as AtomMachine.Bound<never>
describe("executable machine readiness", () => {
  it("rejects an unimplemented choice at every planning and execution boundary", () => {
    expect(Machine.planInitial).type.not.toBeCallableWith(choiceIncomplete)
    expect(Machine.plan).type.not.toBeCallableWith(choiceIncomplete, choiceSnapshot, new Tick({}))
    expect(Machine.can).type.not.toBeCallableWith(choiceIncomplete)
    expect(Machine.can).type.not.toBeCallableWith(choiceIncomplete, choiceSnapshot, new Tick({}))
    expect(Machine.start).type.not.toBeCallableWith(choiceIncomplete)
    expect(Machine.resume).type.not.toBeCallableWith(choiceIncomplete, choiceSnapshot)
    expect(parent.handle).type.toBeCallableWith({
      initial: {
        target: Machine.targets(outputStates).root.Ready,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(parent.handle).type.not.toBeCallableWith({
      states: { Ready: { invoke: { src: "choice", onDone: { none: true } } } },
      initial: {
        target: Machine.targets(outputStates).root.Ready,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(MachineTest.run).type.not.toBeCallableWith(choiceIncomplete, { events: [] })
    expect(AtomMachine.make).type.not.toBeCallableWith(choiceIncomplete)
    expect(AtomMachine.factory).type.not.toBeCallableWith(choiceIncomplete)
    expect(AtomMachine.resume).type.not.toBeCallableWith(choiceIncomplete, choiceSnapshot)
    expect(bound.make).type.not.toBeCallableWith(choiceIncomplete)
    expect(bound.factory).type.not.toBeCallableWith(choiceIncomplete)
    expect(bound.resume).type.not.toBeCallableWith(choiceIncomplete, choiceSnapshot)
    expect(ClusterMachine.make).type.not.toBeCallableWith("Choice", choiceIncomplete, { version: "1" })
  })
  it("rejects an unimplemented history default at every planning and execution boundary", () => {
    expect(Machine.planInitial).type.not.toBeCallableWith(historyIncomplete)
    expect(Machine.plan).type.not.toBeCallableWith(historyIncomplete, historySnapshot, new Tick({}))
    expect(Machine.can).type.not.toBeCallableWith(historyIncomplete)
    expect(Machine.can).type.not.toBeCallableWith(historyIncomplete, historySnapshot, new Tick({}))
    expect(Machine.start).type.not.toBeCallableWith(historyIncomplete)
    expect(Machine.resume).type.not.toBeCallableWith(historyIncomplete, historySnapshot)
    expect(parent.handle).type.not.toBeCallableWith({
      states: { Ready: { invoke: { src: "history", onDone: { none: true } } } },
      initial: {
        target: Machine.targets(outputStates).root.Ready,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(MachineTest.run).type.not.toBeCallableWith(historyIncomplete, { events: [] })
    expect(AtomMachine.make).type.not.toBeCallableWith(historyIncomplete)
    expect(AtomMachine.factory).type.not.toBeCallableWith(historyIncomplete)
    expect(AtomMachine.resume).type.not.toBeCallableWith(historyIncomplete, historySnapshot)
    expect(bound.make).type.not.toBeCallableWith(historyIncomplete)
    expect(bound.factory).type.not.toBeCallableWith(historyIncomplete)
    expect(bound.resume).type.not.toBeCallableWith(historyIncomplete, historySnapshot)
    expect(ClusterMachine.make).type.not.toBeCallableWith("History", historyIncomplete, { version: "1" })
  })
  it("rejects an unimplemented output at every planning and execution boundary", () => {
    expect(Machine.planInitial).type.not.toBeCallableWith(outputIncomplete)
    expect(Machine.plan).type.not.toBeCallableWith(outputIncomplete, outputSnapshot, new Tick({}))
    expect(Machine.can).type.not.toBeCallableWith(outputIncomplete)
    expect(Machine.can).type.not.toBeCallableWith(outputIncomplete, outputSnapshot, new Tick({}))
    expect(Machine.start).type.not.toBeCallableWith(outputIncomplete)
    expect(Machine.resume).type.not.toBeCallableWith(outputIncomplete, outputSnapshot)
    expect(parent.handle).type.not.toBeCallableWith({
      states: { Ready: { invoke: { src: "output", onDone: { none: true } } } },
      initial: {
        target: Machine.targets(outputStates).root.Ready,
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(MachineTest.run).type.not.toBeCallableWith(outputIncomplete, { events: [] })
    expect(AtomMachine.make).type.not.toBeCallableWith(outputIncomplete)
    expect(AtomMachine.factory).type.not.toBeCallableWith(outputIncomplete)
    expect(AtomMachine.resume).type.not.toBeCallableWith(outputIncomplete, outputSnapshot)
    expect(bound.make).type.not.toBeCallableWith(outputIncomplete)
    expect(bound.factory).type.not.toBeCallableWith(outputIncomplete)
    expect(bound.resume).type.not.toBeCallableWith(outputIncomplete, outputSnapshot)
    expect(ClusterMachine.make).type.not.toBeCallableWith("Output", outputIncomplete, { version: "1" })
  })
  it("accepts a complete machine and preserves its exact channels through every adapter", () => {
    const completeStates = Machine.state({
      states: {
        Ready,
        Flow: {
          schema: Flow,
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
      }
    })
    const targets1 = Machine.targets(completeStates)
    const complete = Machine.make({
      root: completeStates,
      events: Machine.eventsFromSchemas(Tick)
    }).handle({
      initial: {
        target: Machine.targets(completeStates).root.Ready,
        decoded: true,
        data: new Ready({})
      },
      states: {
        Flow: {
          initial: {
            target: Machine.targets(completeStates).root.Flow.Route
          },
          history: {
            recent: {
              default: ({ target }) =>
                target({
                  states: {
                    Flow: { data: new Flow({}), decoded: true, states: { Idle: { data: new Idle({}), decoded: true } } }
                  }
                })
            }
          },
          states: {
            Route: {
              choice: { target: targets1.root.Flow.Idle, decoded: true, data: () => (new Idle({})) }
            },
            Done: { output: ({ state }) => state.value }
          }
        }
      }
    })
    const completeSnapshot = {
      path: "" as const,
      value: undefined,
      state: { path: "Ready" as const, value: new Ready({}) }
    }
    const plannedInitial = Machine.planInitial(complete)
    const planned = Machine.plan(complete, completeSnapshot, new Tick({}))
    const can = Machine.can(complete, completeSnapshot, new Tick({}))
    const canComplete = Machine.can(complete)
    const started = Machine.start(complete)
    const resumed = Machine.resume(complete, completeSnapshot)
    const trace = MachineTest.run(complete, { events: [new Tick({})] })
    const atom = AtomMachine.make(complete)
    const makeAtom = AtomMachine.factory(complete)
    const resumedAtom = AtomMachine.resume(complete, completeSnapshot)
    const boundAtom = bound.make(complete)
    const makeBoundAtom = bound.factory(complete)
    const boundResumedAtom = bound.resume(complete, completeSnapshot)
    const cluster = ClusterMachine.make("Complete", complete, { version: "1" })
    type AtomChannels<A> = A extends AtomMachine.MachineAtom<infer State, infer Event, any, infer Output, any> ?
      readonly [
        State,
        Event,
        Output
      ] :
      never
    expect<Machine.Machine.UnhandledStates<typeof complete>>().type.toBe<"Ready" | "Flow.Idle">()
    expect<Machine.Machine.Output<typeof complete>>().type.toBe<string>()
    expect<Machine.Machine.InputEvent<typeof complete>>().type.toBe<Tick>()
    expect<Effect.Success<typeof plannedInitial>["state"]>().type.toBe<Machine.Snapshot<typeof completeStates>>()
    expect<Effect.Success<typeof can>>().type.toBe<boolean>()
    expect(canComplete).type.toBeCallableWith(completeSnapshot, new Tick({}))
    expect(makeAtom).type.toBeCallableWith()
    expect(makeBoundAtom).type.toBeCallableWith()
    expect<Effect.Success<typeof planned>["next"]>().type.toBe<Machine.Snapshot<typeof completeStates>>()
    expect<Effect.Success<typeof started>["send"]>().type.toBe<
      (event: Machine.Machine.EventInput<Tick>) => Effect.Effect<void, Machine.StoppedError>
    >()
    expect<Effect.Success<typeof resumed>["send"]>().type.toBe<
      (event: Machine.Machine.EventInput<Tick>) => Effect.Effect<void, Machine.StoppedError>
    >()
    expect<Effect.Success<typeof trace>>().type.toBe<MachineTest.Trace<typeof complete>>()
    expect<AtomChannels<typeof atom>>().type.toBe<
      readonly [
        Machine.Snapshot<typeof completeStates>,
        Machine.Machine.EventInput<Tick>,
        string
      ]
    >()
    expect<AtomChannels<typeof resumedAtom>>().type.toBe<
      readonly [
        Machine.Snapshot<typeof completeStates>,
        Machine.Machine.EventInput<Tick>,
        string
      ]
    >()
    expect<AtomChannels<typeof boundAtom>>().type.toBe<
      readonly [
        Machine.Snapshot<typeof completeStates>,
        Machine.Machine.EventInput<Tick>,
        string
      ]
    >()
    expect<AtomChannels<typeof boundResumedAtom>>().type.toBe<
      readonly [
        Machine.Snapshot<typeof completeStates>,
        Machine.Machine.EventInput<Tick>,
        string
      ]
    >()
    expect(cluster.machine).type.toBe<typeof complete>()
  })
})
