import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../../../src/index.js"
import {
  activityDefinitions,
  ActivityMetadataTypeId,
  type StaticActivityMetadata
} from "../../../src/internal/machine/activities.js"
import { makeTextRenderer } from "../../machine/visualization/text.js"

class Loading extends Schema.TaggedClass<Loading>("Loading")("Loading", {}) {}
class Dynamic extends Schema.TaggedClass<Dynamic>("Dynamic")("Dynamic", {}) {}
class ChildIdle extends Schema.TaggedClass<ChildIdle>("ChildIdle")("ChildIdle", {}) {}
class WorkSucceeded extends Schema.TaggedClass<WorkSucceeded>("WorkSucceeded")("WorkSucceeded", {}) {}
class WorkFailed extends Schema.TaggedClass<WorkFailed>("WorkFailed")("WorkFailed", {}) {}
class LoadTimedOut extends Schema.TaggedClass<LoadTimedOut>("LoadTimedOut")("LoadTimedOut", {}) {}

const childStates = Machine.defineStates({ ChildIdle })
const childMachine = Machine.make({
  id: "document-worker",
  states: childStates.states,
  events: [],
  initial: () => childStates.initial.ChildIdle(new ChildIdle({}))
})
const child = Machine.child("child", childMachine)

let dynamicFactoryEvaluations = 0
const timerDuration = "10 seconds"
const timerEvent = new LoadTimedOut({})
const activityStates = Machine.defineStates({ Loading, Dynamic })
const activityMachine = Machine.make({
  id: "activity-inspection",
  states: activityStates.states,
  events: [WorkSucceeded, WorkFailed, LoadTimedOut],
  initial: () => activityStates.initial.Loading(new Loading({}))
}).handle({
  Loading: {
    invoke: [
      Machine.invoke({
        id: "poll-server",
        src: () => Machine.effect(Effect.void)
      }),
      Machine.invokeEffect({
        id: "load-document",
        effect: Effect.fail("unavailable").pipe(Effect.as(1)),
        onSuccess: () => new WorkSucceeded({}),
        onFailure: () => new WorkFailed({})
      }),
      Machine.after(timerDuration, timerEvent, { id: "load-timeout" }),
      Machine.invokeMachine({ child })
    ]
  },
  Dynamic: {
    invoke: () => {
      dynamicFactoryEvaluations++
      return Machine.invoke({
        id: "context-owned",
        src: () => Machine.effect(Effect.void)
      })
    }
  }
})

const renderActivityMachine = makeTextRenderer<
  typeof activityMachine,
  Machine.Machine.Snapshot<typeof activityStates.states>
>(Machine)

const descriptor = (id: string, metadata: StaticActivityMetadata) => ({
  id,
  [ActivityMetadataTypeId]: metadata
})

const machine = {
  stateNodes: {
    byPath: new Map([
      ["Idle", { path: "Idle" }],
      ["Loading", { path: "Loading" }],
      ["Parent", { path: "Parent" }],
      ["Parent.Active", { path: "Parent.Active" }],
      ["Dynamic", { path: "Dynamic" }]
    ])
  },
  handlers: {
    Loading: {
      invoke: [
        descriptor("load-document", {
          type: "effect",
          outcomes: { success: "dynamic", failure: "dynamic" }
        }),
        descriptor("load-timeout", {
          type: "timer",
          duration: "10s",
          event: "LoadTimedOut"
        })
      ]
    },
    "Parent.Active": {
      invoke: descriptor("child", {
        type: "machine",
        child: { id: "child", machineId: "document-worker" }
      })
    },
    Dynamic: {
      invoke: () => descriptor("runtime-dependent", { type: "process" })
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
        duration: "10s",
        event: "LoadTimedOut"
      },
      {
        source: "Loading",
        id: "child",
        type: "machine",
        child: { id: "child", machineId: "document-worker" }
      },
      {
        source: "Dynamic",
        type: "dynamic"
      }
    ]

    assert.deepStrictEqual(Machine.activityDefinitions(activityMachine), expected)
    assert.deepStrictEqual(Machine.activityDefinitions(activityMachine), expected)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(Machine.activityDefinitions(activityMachine))), expected)
    const timer = Machine.activityDefinitions(activityMachine).find(({ type }) => type === "timer")
    assert(timer?.type === "timer")
    assert.strictEqual(timer.duration, Duration.format(Duration.fromInputUnsafe(timerDuration)))
    assert.strictEqual(timer.event, String(timerEvent._tag))
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
          events: [LoadTimedOut],
          initial: () => activityStates.initial.Loading(new Loading({}))
        }).handle({
          Loading: {
            invoke: Machine.after(durationMillis, timerEvent, { id })
          }
        })
        const definition = Machine.activityDefinitions(generated)[0]

        assert.deepStrictEqual(definition, {
          source: "Loading",
          id,
          type: "timer",
          duration: Duration.format(Duration.fromInputUnsafe(durationMillis)),
          event: "LoadTimedOut"
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
        duration: "10s",
        event: "LoadTimedOut"
      },
      {
        source: "Parent.Active",
        id: "child",
        type: "machine",
        child: { id: "child", machineId: "document-worker" }
      },
      {
        source: "Dynamic",
        type: "dynamic"
      }
    ])
  })

  it("does not evaluate dynamic factories while inspecting", () => {
    let evaluations = 0
    const dynamic = {
      stateNodes: { byPath: new Map([["Active", { path: "Active" }]]) },
      handlers: {
        Active: {
          invoke: () => {
            evaluations++
            return descriptor("runtime-dependent", { type: "process" })
          }
        }
      }
    }

    assert.deepStrictEqual(activityDefinitions(dynamic), [{ source: "Active", type: "dynamic" }])
    assert.deepStrictEqual(activityDefinitions(dynamic), [{ source: "Active", type: "dynamic" }])
    assert.strictEqual(evaluations, 0)
  })

  it("only reports definitions owned by compiled state nodes", () => {
    const withUnknownHandler = {
      ...machine,
      handlers: {
        ...machine.handlers,
        Missing: {
          invoke: descriptor("orphan", { type: "process" })
        }
      }
    }

    const definitions = activityDefinitions(withUnknownHandler)
    const paths = new Set(Array.from(withUnknownHandler.stateNodes.byPath.values(), ({ path }) => path))

    assert(definitions.every(({ source }) => paths.has(source)))
    assert.notInclude(definitions.map((definition) => "id" in definition ? definition.id : undefined), "orphan")
  })

  it("renders activities beneath their owning state", () => {
    assert.strictEqual(
      renderActivityMachine(activityMachine, activityStates.initial.Loading(new Loading({}))),
      [
        "activity-inspection",
        "● active  ○ inactive  ◇ transition (→ declared, ∅ none, omitted dynamic)  ◆ activity",
        "",
        "├─ ● Loading",
        "│  ├─ ◆ process: poll-server",
        "│  ├─ ◆ effect: load-document [success: dynamic, failure: dynamic]",
        "│  ├─ ◆ timer: load-timeout [10s] → LoadTimedOut",
        "│  └─ ◆ machine: child → document-worker",
        "└─ ○ Dynamic",
        "   └─ ◆ activity: dynamic",
        "",
        "Candidate events: none"
      ].join("\n")
    )
  })
})
