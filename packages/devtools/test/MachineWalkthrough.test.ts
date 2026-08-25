import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import { machine } from "../src/internal/browser/example-machine.js"
import { plannerMachine } from "../src/internal/browser/planner-example.js"
import * as MachineDocument from "../src/MachineDocument.js"
import * as MachineWalkthrough from "../src/MachineWalkthrough.js"

const takeEvent = (
  session: MachineWalkthrough.Session,
  event: string
): MachineWalkthrough.Session => {
  const choice = MachineWalkthrough.choices(session).find((choice) =>
    choice.trigger.type === "event" && choice.trigger.event === event
  )
  assert.isDefined(choice)
  const result = MachineWalkthrough.take(session, choice.id)
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const historyDocument = (initial: "Workspace" | "Paused" = "Workspace"): MachineDocument.MachineDocument => ({
  schemaVersion: MachineDocument.schemaVersion,
  revision: 0,
  source: null,
  machineId: "history-walkthrough",
  initial: {
    target: initial,
    selection: { path: initial, kind: "state", scope: "full" }
  },
  roots: ["Workspace", "Paused"],
  states: [
    {
      path: "Workspace",
      key: "Workspace",
      order: 0,
      title: null,
      description: null,
      documentation: null,
      type: "compound",
      history: null,
      parent: null,
      children: ["Workspace.One", "Workspace.Two", "Workspace.recent"],
      initial: "Workspace.One",
      valueSchema: null,
      outputSchema: null,
      transitionIds: [],
      activityIds: []
    },
    {
      path: "Workspace.One",
      key: "One",
      order: 1,
      title: null,
      description: null,
      documentation: null,
      type: "atomic",
      history: null,
      parent: "Workspace",
      children: [],
      initial: null,
      valueSchema: null,
      outputSchema: null,
      transitionIds: ["next"],
      activityIds: []
    },
    {
      path: "Workspace.Two",
      key: "Two",
      order: 2,
      title: null,
      description: null,
      documentation: null,
      type: "atomic",
      history: null,
      parent: "Workspace",
      children: [],
      initial: null,
      valueSchema: null,
      outputSchema: null,
      transitionIds: ["pause"],
      activityIds: []
    },
    {
      path: "Workspace.recent",
      key: "recent",
      order: 3,
      title: null,
      description: null,
      documentation: null,
      type: "history",
      history: "shallow",
      parent: "Workspace",
      children: [],
      initial: null,
      valueSchema: null,
      outputSchema: null,
      transitionIds: [],
      activityIds: []
    },
    {
      path: "Paused",
      key: "Paused",
      order: 4,
      title: null,
      description: null,
      documentation: null,
      type: "atomic",
      history: null,
      parent: null,
      children: [],
      initial: null,
      valueSchema: null,
      outputSchema: null,
      transitionIds: ["resume"],
      activityIds: []
    }
  ],
  transitions: [
    {
      id: "next",
      source: "Workspace.One",
      trigger: { type: "event", event: "Next" },
      reenter: false,
      acceptance: "required",
      branches: [{
        id: "next:branch:0",
        type: "direct",
        target: "Workspace.Two",
        selection: { path: "Workspace.Two", kind: "state", scope: "full" },
        updates: []
      }]
    },
    {
      id: "pause",
      source: "Workspace.Two",
      trigger: { type: "event", event: "Pause" },
      reenter: false,
      acceptance: "required",
      branches: [{
        id: "pause:branch:0",
        type: "direct",
        target: "Paused",
        selection: { path: "Paused", kind: "state", scope: "full" },
        updates: []
      }]
    },
    {
      id: "resume",
      source: "Paused",
      trigger: { type: "event", event: "Resume" },
      reenter: false,
      acceptance: "required",
      branches: [{
        id: "resume:branch:0",
        type: "direct",
        target: "Workspace.recent",
        selection: { path: "Workspace.recent", kind: "history", scope: "full" },
        updates: []
      }]
    }
  ],
  activities: [],
  inputs: { machine: null, events: [] },
  snapshot: null
})

describe("MachineWalkthrough", () => {
  it("starts from compound and parallel initial topology", () => {
    const session = MachineWalkthrough.start(MachineDocument.make(machine))
    assert.deepStrictEqual(MachineWalkthrough.current(session).after.activePaths, [
      "application",
      "application.workflow",
      "application.workflow.idle",
      "application.connection",
      "application.connection.online"
    ])
    assert.deepStrictEqual(
      MachineWalkthrough.choices(session)
        .flatMap((choice) => choice.trigger.type === "event" ? [choice.trigger.event] : [])
        .sort(),
      ["Disconnect", "Refresh", "Start"]
    )
  })

  it("advances direct topology while preserving a parallel sibling", () => {
    const started = MachineWalkthrough.start(MachineDocument.make(machine))
    const advanced = takeEvent(started, "Start")
    assert.deepStrictEqual(MachineWalkthrough.current(advanced).after.activePaths, [
      "application",
      "application.workflow",
      "application.workflow.running",
      "application.workflow.running.editing",
      "application.connection",
      "application.connection.online"
    ])
  })

  it("re-enters every parallel region when a transition crosses regions", () => {
    const document = MachineDocument.make(machine)
    const crossed = MachineWalkthrough.take(
      MachineWalkthrough.start({
        ...document,
        transitions: [...document.transitions, {
          id: "cross-region",
          source: "application.workflow.idle",
          trigger: { type: "event", event: "CrossRegion" },
          reenter: false,
          acceptance: "required",
          branches: [{
            id: "cross-region:branch:0",
            type: "direct",
            target: "application.connection.offline",
            selection: { path: "application.connection.offline", kind: "state", scope: "full" },
            updates: []
          }]
        }]
      }),
      "cross-region:branch:0"
    )
    assert.isTrue(Result.isSuccess(crossed))
    if (Result.isFailure(crossed)) throw crossed.failure
    assert.deepStrictEqual(MachineWalkthrough.current(crossed.success).after.activePaths, [
      "application",
      "application.workflow",
      "application.workflow.idle",
      "application.connection",
      "application.connection.offline"
    ])
  })

  it("exposes branch decisions and event contracts without asking for values", () => {
    const session = MachineWalkthrough.start(MachineDocument.make(plannerMachine))
    const begin = MachineWalkthrough.choices(session).filter((choice) =>
      choice.trigger.type === "event" && choice.trigger.event === "Begin"
    )
    assert.strictEqual(begin.length, 2)
    assert.deepStrictEqual(begin.map(({ title }) => title), ["Finish immediately", "Wait in working"])
    assert.isTrue(begin.every(({ decisions }) => decisions.includes("conditional-branch")))
    assert.isTrue(begin.every(({ input }) => input !== null))
  })

  it("retains history and restores it when the history branch is chosen", () => {
    const started = MachineWalkthrough.start(historyDocument())
    const moved = takeEvent(started, "Next")
    const paused = takeEvent(moved, "Pause")
    const resume = MachineWalkthrough.choices(paused).find(({ id }) => id === "resume:branch:0")!
    assert.strictEqual(resume.unavailableReason, null)
    const resumed = MachineWalkthrough.take(paused, resume.id)
    assert.isTrue(Result.isSuccess(resumed))
    if (Result.isFailure(resumed)) return
    assert.deepStrictEqual(MachineWalkthrough.current(resumed.success).after.activePaths, [
      "Workspace",
      "Workspace.Two"
    ])
  })

  it("does not invent a first-use history fallback", () => {
    const session = MachineWalkthrough.start(historyDocument("Paused"))
    const resume = MachineWalkthrough.choices(session).find(({ id }) => id === "resume:branch:0")!
    assert.strictEqual(resume.unavailableReason, "history-unavailable")
    const result = MachineWalkthrough.take(session, resume.id)
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "ChoiceUnavailable")
  })

  it("seeks through retained frames and truncates the future when branching", () => {
    const started = MachineWalkthrough.start(MachineDocument.make(machine))
    const advanced = takeEvent(started, "Start")
    const past = MachineWalkthrough.seek(advanced, 0)
    assert.isTrue(Result.isSuccess(past))
    if (Result.isFailure(past)) return
    assert.strictEqual(MachineWalkthrough.timeline(past.success).length, 2)
    const branched = takeEvent(past.success, "Disconnect")
    assert.strictEqual(MachineWalkthrough.cursor(branched), 1)
    assert.strictEqual(MachineWalkthrough.timeline(branched).length, 2)
    const choice = MachineWalkthrough.current(branched).choice
    assert.strictEqual(choice?.trigger.type, "event")
    if (choice?.trigger.type === "event") assert.strictEqual(choice.trigger.event, "Disconnect")
  })
})
