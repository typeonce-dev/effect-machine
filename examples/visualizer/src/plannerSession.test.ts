import { Machine } from "@typeonce/effect-machine"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { generateEventSamples } from "./eventSamples.ts"
import { VisualizerMachine } from "./machine.ts"
import { createPlannerSession } from "./plannerSession.ts"

const makeSession = () =>
  createPlannerSession(
    {
      machine: VisualizerMachine,
      initial: () => Effect.runPromise(Machine.planInitial(VisualizerMachine)).then(({ state }) => state),
      enabled: (snapshot) => Machine.enabled(VisualizerMachine, snapshot),
      plan: (snapshot, event) => Effect.runPromise(Machine.plan(VisualizerMachine, snapshot, event))
    },
    generateEventSamples(VisualizerMachine, { seed: 123 }).samples
  )

describe("planner session", () => {
  it("steps concrete public events and recomputes active states and enabled inputs", async () => {
    const session = await makeSession()
    const initial = session.inspect()

    expect(initial.activePaths).toEqual([
      "application",
      "application.workflow",
      "application.workflow.idle",
      "application.connection",
      "application.connection.online"
    ])
    expect(initial.availableSamples.map(({ event }) => event._tag).sort()).toEqual(["Disconnect", "Start"])

    const started = await session.send("generated-Start")
    expect(started.activePaths).toContain("application.workflow.running.editing")
    expect(started.activePaths).toContain("application.connection.online")
    expect(started.lastStep?.classification).toBe("transitioned")
    expect(started.availableSamples.map(({ event }) => event._tag).sort()).toEqual([
      "Disconnect",
      "Edit",
      "Submit"
    ])
  })

  it("retains value-only same-path plans even when topology is unchanged", async () => {
    const session = await makeSession()
    await session.send("generated-Start")
    const edited = await session.send("generated-Edit")

    expect(edited.activePaths).toContain("application.workflow.running.editing")
    expect(edited.lastStep?.classification).toBe("handled")
    expect(edited.lastStep?.microsteps).toHaveLength(1)
    expect(edited.lastStep?.microsteps[0]?.changed).toBe(false)
  })

  it("updates one parallel region without disturbing the other", async () => {
    const session = await makeSession()
    const disconnected = await session.send("generated-Disconnect")

    expect(disconnected.activePaths).toContain("application.workflow.idle")
    expect(disconnected.activePaths).toContain("application.connection.offline")
    expect(disconnected.lastStep?.classification).toBe("transitioned")
  })

  it("rejects disabled fixtures and can restart from the initial snapshot", async () => {
    const session = await makeSession()

    await expect(session.send("generated-Approve")).rejects.toThrow("Event sample is not enabled")
    await session.send("generated-Start")
    const reset = await session.reset()

    expect(reset.activePaths).toContain("application.workflow.idle")
    expect(reset.lastStep).toBeUndefined()
  })
})
