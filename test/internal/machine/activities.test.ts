import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Schema, Stream } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../../../src/index.js"
import { activityDefinitions } from "../../../src/internal/machine/activities.js"
import { makeMermaidRenderer } from "../../machine/visualization/mermaid.js"
import { makeTextRenderer } from "../../machine/visualization/text.js"

class Loading extends Schema.TaggedClass<Loading>("Loading")("Loading", {}) {}
class Dynamic extends Schema.TaggedClass<Dynamic>("Dynamic")("Dynamic", {}) {}
class ChildIdle extends Schema.TaggedClass<ChildIdle>("ChildIdle")("ChildIdle", {}) {}
class WorkSucceeded extends Schema.TaggedClass<WorkSucceeded>("WorkSucceeded")("WorkSucceeded", {}) {}
class WorkFailed extends Schema.TaggedClass<WorkFailed>("WorkFailed")("WorkFailed", {}) {}
class LoadTimedOut extends Schema.TaggedClass<LoadTimedOut>("LoadTimedOut")("LoadTimedOut", {}) {}

const childStates = Machine.states({ ChildIdle })
const childMachine = Machine.make({
  id: "document-worker",
  states: childStates.states,
  events: Machine.events(),
  initial: {
    target: (to) => to.ChildIdle(),
    resolve: ({ target }) => target(new ChildIdle({}))
  }
})
const child = Machine.child("child", childMachine)

let dynamicFactoryEvaluations = 0
const timerDuration = "10 seconds"
const activityStates = Machine.states({ Loading, Dynamic })
const activityMachine = Machine.make({
  id: "activity-inspection",
  states: activityStates.states,
  events: Machine.events(WorkSucceeded, WorkFailed, LoadTimedOut),
  initial: {
    target: (to) => to.Loading(),
    resolve: ({ target }) => target(new Loading({}))
  }
}).handle({
  Loading: {
    invoke: [
      Machine.invoke({
        id: "poll-server",
        address: Machine.childAddress("poll-server"),
        logic: Machine.logic({ initial: undefined, run: () => Effect.never })
      }),
      Machine.invoke({
        id: "load-document",
        effect: () => Effect.fail("unavailable").pipe(Effect.as(1)),
        onDone: { target: Machine.targetless },
        onFailure: { target: Machine.targetless }
      }),
      Machine.invoke({
        id: "load-timeout",
        after: timerDuration,
        onDone: { target: Machine.targetless }
      }),
      Machine.invoke({
        id: "updates",
        stream: () => Stream.empty,
        onDone: { target: Machine.targetless }
      }),
      Machine.invoke({ child })
    ]
  },
  Dynamic: {
    invoke: Machine.invoke({
      id: "context-owned",
      address: Machine.childAddress("context-owned"),
      logic: () => {
        dynamicFactoryEvaluations++
        return Machine.logic({ initial: undefined, run: () => Effect.never })
      }
    })
  }
})

const renderActivityMachine = makeTextRenderer<
  typeof activityMachine,
  Machine.Machine.Snapshot<typeof activityStates.states>
>(Machine)
const renderMermaidActivityMachine = makeMermaidRenderer<
  typeof activityMachine,
  Machine.Machine.Snapshot<typeof activityStates.states>
>(Machine)

const machine = {
  stateNodes: {
    byPath: new Map([
      ["Idle", { path: "Idle" as const }],
      ["Loading", { path: "Loading" as const }],
      ["Parent", { path: "Parent" as const }],
      ["Parent.Active", { path: "Parent.Active" as const }],
      ["Dynamic", { path: "Dynamic" as const }]
    ])
  },
  handlers: {
    Loading: {
      invoke: [
        {
          id: "load-document",
          effect: () => Effect.void,
          onFailure: () => undefined,
          type: "effect"
        },
        { id: "load-timeout", after: "10 seconds" },
        { id: "updates", stream: () => Stream.empty }
      ]
    },
    "Parent.Active": {
      invoke: { child }
    },
    Dynamic: {
      invoke: { id: "runtime-dependent", address: "runtime-dependent", logic: () => Effect.never }
    }
  }
}

describe("machine activity metadata", () => {
  it("inspects all public helper descriptors without retaining runtime values", () => {
    const expected: ReadonlyArray<
      Machine.Machine.ActivityDefinition<Machine.Machine.StateIdentifier<typeof activityStates.states>>
    > = [
      {
        source: "Loading",
        id: "poll-server",
        type: "process"
      },
      {
        source: "Loading",
        id: "load-document",
        type: "effect",
        outcomes: { success: "dynamic", failure: "dynamic" }
      },
      {
        source: "Loading",
        id: "load-timeout",
        type: "timer",
        duration: "10s"
      },
      {
        source: "Loading",
        id: "updates",
        type: "stream"
      },
      {
        source: "Loading",
        id: "child",
        type: "machine",
        child: { id: "child", machineId: "document-worker" }
      },
      {
        source: "Dynamic",
        id: "context-owned",
        type: "process"
      }
    ]

    assert.deepStrictEqual(Machine.activityDefinitions(activityMachine), expected)
    assert.deepStrictEqual(Machine.activityDefinitions(activityMachine), expected)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(Machine.activityDefinitions(activityMachine))), expected)
    const timer = Machine.activityDefinitions(activityMachine).find(({ type }) => type === "timer")
    assert(timer?.type === "timer")
    assert.strictEqual(timer.duration, Duration.format(Duration.fromInputUnsafe(timerDuration)))
    assert.strictEqual(dynamicFactoryEvaluations, 0)
  })

  it("only reports public definitions owned by real active state nodes", () => {
    const paths = new Set(Machine.stateNodes(activityMachine).map(({ path }) => path))
    assert(Machine.activityDefinitions(activityMachine).every(({ source }) => paths.has(source)))
  })

  it.effect.prop(
    "keeps generated timer ids, durations, events, and owners aligned with helper declarations",
    {
      durationMillis: FastCheck.integer({ min: 0, max: 604_800_000 }),
      idSuffix: FastCheck.nat({ max: 1_000_000 })
    },
    ({ durationMillis, idSuffix }) =>
      Effect.sync(() => {
        const id = `generated-timer-${idSuffix}`
        const generated = Machine.make({
          states: activityStates.states,
          events: Machine.events(LoadTimedOut),
          initial: {
            target: (to) => to.Loading(),
            resolve: ({ target }) => target(new Loading({}))
          }
        }).handle({
          Loading: {
            invoke: Machine.invoke({
              id,
              after: durationMillis,
              onDone: { target: Machine.targetless }
            })
          }
        })
        const definition = Machine.activityDefinitions(generated)[0]

        assert.deepStrictEqual(definition, {
          source: "Loading",
          id,
          type: "timer",
          duration: Duration.format(Duration.fromInputUnsafe(durationMillis))
        })
        assert(Machine.stateNodes(generated).some(({ path }) => path === definition?.source))
      }),
    { fastCheck: { numRuns: 100, seed: 68_241 } }
  )

  it("collects static descriptors in topology and declaration order", () => {
    assert.deepStrictEqual(activityDefinitions(machine), [
      {
        source: "Loading",
        id: "load-document",
        type: "effect",
        outcomes: { success: "dynamic", failure: "dynamic" }
      },
      {
        source: "Loading",
        id: "load-timeout",
        type: "timer",
        duration: "10s"
      },
      { source: "Loading", id: "updates", type: "stream" },
      {
        source: "Parent.Active",
        id: "child",
        type: "machine",
        child: { id: "child", machineId: "document-worker" }
      },
      { source: "Dynamic", id: "runtime-dependent", type: "process" }
    ])
  })

  it("does not evaluate source factories while inspecting", () => {
    let evaluations = 0
    const dynamic = {
      stateNodes: { byPath: new Map([["Active", { path: "Active" as const }]]) },
      handlers: {
        Active: {
          invoke: {
            id: "runtime-dependent",
            address: "runtime-dependent",
            logic: () => {
              evaluations++
              return Effect.never
            }
          }
        }
      }
    }

    assert.deepStrictEqual(activityDefinitions(dynamic), [{
      source: "Active",
      id: "runtime-dependent",
      type: "process"
    }])
    assert.deepStrictEqual(activityDefinitions(dynamic), [{
      source: "Active",
      id: "runtime-dependent",
      type: "process"
    }])
    assert.strictEqual(evaluations, 0)
  })

  it("only reports definitions owned by compiled state nodes", () => {
    const withUnknownHandler = {
      ...machine,
      handlers: {
        ...machine.handlers,
        Missing: {
          invoke: { id: "orphan", address: "orphan", logic: Effect.never }
        }
      }
    }

    const definitions = activityDefinitions(withUnknownHandler)
    const paths = new Set<string>(Array.from(withUnknownHandler.stateNodes.byPath.values(), ({ path }) => path))

    assert(definitions.every(({ source }) => paths.has(source)))
    assert.notInclude(definitions.map((definition) => "id" in definition ? definition.id : undefined), "orphan")
  })

  it("renders activities beneath their owning state", () => {
    assert.strictEqual(
      renderActivityMachine(activityMachine, { path: "Loading" as const, value: new Loading({}) }),
      [
        "activity-inspection",
        "● active  ○ inactive  ◇ transition  ┄ branch → target  ◆ activity",
        "",
        "├─ ● Loading",
        "│  ├─ ◆ process: poll-server",
        "│  ├─ ◆ effect: load-document [success: dynamic, failure: dynamic]",
        "│  ├─ ◆ timer: load-timeout [10s]",
        "│  ├─ ◆ stream: updates",
        "│  └─ ◆ machine: child → document-worker",
        "└─ ○ Dynamic",
        "   └─ ◆ process: context-owned",
        "",
        "Candidate events: none"
      ].join("\n")
    )
  })

  it("renders state-owned activities inside their Mermaid state", () => {
    const rendered = renderMermaidActivityMachine(activityMachine, {
      path: "Loading" as const,
      value: new Loading({})
    })

    assert.include(
      rendered,
      "state_0: process / poll-server · effect / load-document · timer / load-timeout (10s) · stream / updates · machine / child → document-worker"
    )
    assert.notInclude(rendered, "success: dynamic")
    assert.notInclude(rendered, "note right of")
  })
})
