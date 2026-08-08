import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Graph from "effect/Graph"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Machine } from "../src/index.js"
import { MachineTest } from "../src/testing.js"

class Count extends Schema.TaggedClass<Count>("Count")("Count", {
  value: Schema.Int
}) {}
class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {}
class Add extends Schema.TaggedClass<Add>("Add")("Add", {
  amount: Schema.Int
}) {}
class Finish extends Schema.TaggedClass<Finish>("Finish")("Finish", {}) {}

const CounterStates = Machine.defineStates({ count: Count, done: Done })

const counterMachine = Machine.make({
  states: CounterStates.states,
  events: [Add, Finish],
  initial: () => CounterStates.initial.count(new Count({ value: 0 }))
}).handle({
  count: {
    on: {
      Add: {
        reenter: true,
        targets: ["count"],
        transition: ({ event, state, target }) => target.full.count(new Count({ value: state.value + event.amount }))
      },
      Finish: {
        targets: ["done"],
        transition: ({ target }) => target.full.done(new Done({}))
      }
    }
  },
  done: {}
})

class Opaque extends Schema.TaggedClass<Opaque>("Opaque")("Opaque", {
  payload: Schema.Any
}) {}

const OpaqueStates = Machine.defineStates({ opaque: Opaque })
const opaqueMachine = Machine.make({
  states: OpaqueStates.states,
  events: [],
  input: Schema.Any,
  initial: (payload) => OpaqueStates.initial.opaque(new Opaque({ payload }))
})

const StartupStates = Machine.defineStates({ count: Count })
const startupMachine = Machine.make({
  states: StartupStates.states,
  events: [Add],
  initial: () => StartupStates.initial.count(new Count({ value: 0 }))
}).handle({
  count: {
    always: ({ target, state }) =>
      state.value === 0
        ? target.full.count(new Count({ value: 1 }))
        : undefined,
    on: {
      Add: ({ event, state, target }) => target.full.count(new Count({ value: state.value + event.amount }))
    }
  }
})

const Tick = Symbol.for("MachineTestCoverage/Tick")
const TickEvent = Schema.Struct({ _tag: Schema.UniqueSymbol(Tick) })
const ChoiceEvent = Schema.Struct({
  _tag: Schema.Union([Schema.Literal("Alpha"), Schema.Literal("Beta")])
})
const OpenEvent = Schema.Struct({ _tag: Schema.String })
const EventStates = Machine.defineStates({ count: Count })
const finiteEventMachine = Machine.make({
  states: EventStates.states,
  events: [TickEvent, ChoiceEvent],
  initial: () => EventStates.initial.count(new Count({ value: 0 }))
}).handle({
  count: {
    on: {
      [Tick]: () => undefined,
      Alpha: () => undefined,
      Beta: () => undefined
    }
  }
})
const openEventMachine = Machine.make({
  states: EventStates.states,
  events: [OpenEvent],
  initial: () => EventStates.initial.count(new Count({ value: 0 }))
}).handle({ count: {} })

const event = (_tag: string): { readonly _tag: string } => ({ _tag })

const parallelModel: MachineTest.FiniteModel = {
  roots: [{
    _tag: "Parallel",
    key: "workflow",
    value: 0,
    output: "workflow:done",
    states: [
      {
        _tag: "Compound",
        key: "left",
        value: 1,
        initial: "idle",
        states: [
          { _tag: "Atomic", key: "idle", value: 2 },
          { _tag: "Final", key: "done", value: 3, output: "left:done" }
        ]
      },
      {
        _tag: "Compound",
        key: "right",
        value: 4,
        initial: "idle",
        states: [
          { _tag: "Atomic", key: "idle", value: 5 },
          { _tag: "Final", key: "done", value: 6, output: "right:done" }
        ]
      }
    ]
  }],
  initial: "workflow",
  events: ["Left", "Right"],
  transitions: [
    {
      source: "workflow.left.idle",
      trigger: { type: "event", event: "Left" },
      target: "workflow.left.done",
      reenter: false
    },
    {
      source: "workflow.right.idle",
      trigger: { type: "event", event: "Right" },
      target: "workflow.right.done",
      reenter: false
    }
  ]
}

const historyModel: MachineTest.FiniteModel = {
  roots: [
    {
      _tag: "Compound",
      key: "owner",
      value: 0,
      initial: "a",
      states: [
        { _tag: "Atomic", key: "a", value: 1 },
        { _tag: "Atomic", key: "b", value: 2 },
        { _tag: "History", key: "exact", history: "deep", fallback: "owner.a" }
      ]
    },
    { _tag: "Atomic", key: "outside", value: 3 }
  ],
  initial: "owner",
  events: ["Next", "Leave", "Resume"],
  transitions: [
    { source: "owner.a", trigger: { type: "event", event: "Next" }, target: "owner.b", reenter: false },
    { source: "owner.a", trigger: { type: "event", event: "Leave" }, target: "outside", reenter: false },
    { source: "owner.b", trigger: { type: "event", event: "Leave" }, target: "outside", reenter: false },
    { source: "outside", trigger: { type: "event", event: "Resume" }, target: "owner.exact", reenter: false }
  ]
}

describe("MachineTest trace coverage", () => {
  it.effect("turns definition-aware state, transition, and event misses into hits", () =>
    Effect.gen(function*() {
      const addTrace = yield* MachineTest.run(counterMachine, {
        events: [new Add({ amount: 1 })]
      })
      const finishTrace = yield* MachineTest.run(counterMachine, {
        events: [new Finish({})]
      })

      const partial = MachineTest.coverage(counterMachine, addTrace)
      assert.strictEqual(partial.events.available, true)
      if (!partial.events.available) return
      assert.deepStrictEqual(partial.states.activation.misses.map(({ path }) => path), ["done"])
      assert.deepStrictEqual(partial.transitions.misses.map(({ source, trigger }) => ({ source, trigger })), [{
        source: "count",
        trigger: { type: "event", event: "Finish" }
      }])
      assert.deepStrictEqual(partial.events.misses, [{ tag: "Finish", count: 0 }])
      assert.strictEqual(partial.logicalConfigurations.hit, 2)

      const combined = MachineTest.coverage(counterMachine, [addTrace, finishTrace])
      assert.strictEqual(combined.events.available, true)
      if (!combined.events.available) return
      assert.strictEqual(combined.states.activation.missing, 0)
      assert.strictEqual(combined.transitions.missing, 0)
      assert.strictEqual(combined.events.missing, 0)
      assert.ok(combined.states.exit.hits.some(({ path }) => path === "count"))
      assert.ok(combined.states.entry.hits.some(({ path }) => path === "done"))
      assert.strictEqual(combined.scenarios.traces, 2)
      assert.strictEqual(combined.scenarios.events, 2)
    }))

  it.effect("covers finite decoded symbol and union tags and diagnoses open tag spaces", () =>
    Effect.gen(function*() {
      const finiteTrace = yield* MachineTest.run(finiteEventMachine, {
        events: [{ _tag: Tick }, { _tag: "Alpha" }]
      })
      const finite = MachineTest.coverage(finiteEventMachine, finiteTrace)
      assert.strictEqual(finite.events.available, true)
      if (finite.events.available) {
        assert.strictEqual(finite.events.total, 3)
        assert.deepStrictEqual(finite.events.hits.map(({ tag }) => tag), [Tick, "Alpha"])
        assert.deepStrictEqual(finite.events.misses, [{ tag: "Beta", count: 0 }])
      }

      const openTrace = yield* MachineTest.run(openEventMachine, { events: [{ _tag: "Dynamic" }] })
      const open = MachineTest.coverage(openEventMachine, openTrace)
      assert.strictEqual(open.events.available, false)
      if (!open.events.available) {
        assert.strictEqual(open.events.total, undefined)
        assert.deepStrictEqual(open.events.observed, [{ tag: "Dynamic", count: 1 }])
        assert.strictEqual(open.events.diagnostics.length, 1)
      }
    }))

  it.effect("reports parallel completion and history evidence without inferring unobserved behavior", () =>
    Effect.gen(function*() {
      const parallelMachine = MachineTest.compileModel(parallelModel)
      const parallel = yield* MachineTest.run(parallelMachine, {
        events: [event("Left"), event("Right")]
      })
      const parallelCoverage = MachineTest.coverage(parallelMachine, parallel)
      assert.ok(parallelCoverage.completion.donePlans > 0)
      assert.ok(parallelCoverage.completion.paths.includes("workflow"))
      assert.ok(parallelCoverage.completion.paths.includes("workflow.left"))
      assert.strictEqual(parallelCoverage.microsteps.eventTriggered, 2)

      const historyMachine = MachineTest.compileModel(historyModel)
      const history = yield* MachineTest.run(historyMachine, {
        events: [event("Next"), event("Leave"), event("Resume")]
      })
      const historyCoverage = MachineTest.coverage(historyMachine, history)
      assert.ok(historyCoverage.history.recordObservations > 0)
      assert.deepStrictEqual(historyCoverage.history.recorded, [{ path: "owner.exact", modes: ["deep"] }])
      assert.strictEqual(historyCoverage.history.targets, 1)
      assert.strictEqual(historyCoverage.history.resolvedTargets, 1)
    }))
})

describe("MachineTest observed graph", () => {
  it.effect("deduplicates encoded snapshots while preserving concrete startup and event edges", () =>
    Effect.gen(function*() {
      const first = yield* MachineTest.run(counterMachine, {
        events: [new Add({ amount: 1 })]
      })
      const second = yield* MachineTest.run(counterMachine, {
        events: [new Add({ amount: 1 })]
      })
      const observed = yield* MachineTest.observedGraph(counterMachine, [first, second])

      assert.strictEqual(Graph.nodeCount(observed.graph), 2)
      assert.strictEqual(Graph.edgeCount(observed.graph), 4)
      const edges = Array.from(Graph.edges(observed.graph), ([, edge]) => edge.data)
      assert.strictEqual(edges.filter(({ _tag }) => _tag === "Startup").length, 2)
      assert.strictEqual(edges.filter(({ _tag }) => _tag === "Event").length, 2)
      assert.ok(edges.filter(({ _tag }) => _tag === "Event").every((edge) => edge.microsteps.length === 1))
      assert.ok(
        edges.flatMap(({ microsteps }) => microsteps).every(({ next }) => observed.nodesById.has(next))
      )

      const nodes = Array.from(observed.graph)
      const zero = nodes.find(([, node]) =>
        node.encoded.active.some(({ value }) => (value as { readonly value?: number }).value === 0)
      )!
      const one = nodes.find(([, node]) =>
        node.encoded.active.some(({ value }) => (value as { readonly value?: number }).value === 1)
      )!
      assert.notStrictEqual(zero[1].id, one[1].id)
      const shortest = Graph.dijkstra(observed.graph, {
        source: zero[0],
        target: one[0],
        cost: () => 1
      })
      assert.ok(Option.isSome(shortest))
      if (Option.isSome(shortest)) assert.strictEqual(shortest.value.distance, 1)
    }))

  it.effect("separates pre-settled startup sources from post-startup path starts", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(startupMachine, { events: [] })
      const observed = yield* MachineTest.observedGraph(startupMachine, trace)

      assert.strictEqual(observed.startupSources.length, 1)
      assert.strictEqual(observed.starts.length, 1)
      assert.notStrictEqual(observed.startupSources[0], observed.starts[0])
      const startup = Array.from(Graph.edges(observed.graph), ([, edge]) => edge.data)[0]!
      assert.strictEqual(startup._tag, "Startup")
      assert.strictEqual(startup.microsteps.length, 1)
    }))

  it.effect("retains complete parallel configurations and completion on macrostep edges", () =>
    Effect.gen(function*() {
      const machine = MachineTest.compileModel(parallelModel)
      const trace = yield* MachineTest.run(machine, {
        events: [event("Left"), event("Right")]
      })
      const observed = yield* MachineTest.observedGraph(machine, trace)
      const nodes = Array.from(observed.graph, ([, node]) => node)

      assert.ok(nodes.some(({ configuration }) =>
        configuration.includes("workflow.left.done") && configuration.includes("workflow.right.idle")
      ))
      const eventEdges = Array.from(Graph.edges(observed.graph), ([, edge]) =>
        edge.data).filter(
          (edge): edge is Extract<typeof edge, { readonly _tag: "Event" }> => edge._tag === "Event"
        )
      assert.strictEqual(eventEdges.length, 2)
      assert.strictEqual(eventEdges[0]!.completion.done, false)
      assert.strictEqual(eventEdges[1]!.completion.done, true)
    }))

  it.effect("keeps equal active paths with different history records as distinct logical nodes", () =>
    Effect.gen(function*() {
      const machine = MachineTest.compileModel(historyModel)
      const rememberedA = yield* MachineTest.run(machine, { events: [event("Leave")] })
      const rememberedB = yield* MachineTest.run(machine, {
        events: [event("Next"), event("Leave")]
      })
      const observed = yield* MachineTest.observedGraph(machine, [rememberedA, rememberedB])
      const outside = Array.from(observed.graph, ([, node]) => node).filter(
        ({ configuration }) => configuration.length === 1 && configuration[0] === "outside"
      )

      assert.strictEqual(outside.length, 2)
      assert.notStrictEqual(
        JSON.stringify(outside[0]!.encoded.history),
        JSON.stringify(outside[1]!.encoded.history)
      )
      assert.notStrictEqual(outside[0]!.id, outside[1]!.id)
    }))

  it.effect("does not merge colliding non-JSON encoded values", () =>
    Effect.gen(function*() {
      const makePayload = () => function collision() {}
      const first = yield* MachineTest.run(opaqueMachine, { input: makePayload(), events: [] })
      const second = yield* MachineTest.run(opaqueMachine, { input: makePayload(), events: [] })
      const observed = yield* MachineTest.observedGraph(opaqueMachine, [first, second])

      assert.strictEqual(Graph.nodeCount(observed.graph), 2)
      assert.strictEqual(MachineTest.coverage(opaqueMachine, [first, second]).logicalConfigurations.hit, 2)

      const firstBuffer = yield* MachineTest.run(opaqueMachine, {
        input: new Uint8Array([1]).buffer,
        events: []
      })
      const secondBuffer = yield* MachineTest.run(opaqueMachine, {
        input: new Uint8Array([2]).buffer,
        events: []
      })
      const buffers = yield* MachineTest.observedGraph(opaqueMachine, [firstBuffer, secondBuffer])
      assert.strictEqual(Graph.nodeCount(buffers.graph), 2)
      assert.strictEqual(
        MachineTest.coverage(opaqueMachine, [firstBuffer, secondBuffer]).logicalConfigurations.hit,
        2
      )
    }))
})
