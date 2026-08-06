import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { defineEventFixtures, generateEventSamples, mergeEventSamples } from "./eventSamples.ts"
import { Event, VisualizerMachine } from "./machine.ts"

describe("generated event samples", () => {
  it("generates one deterministic, valid value for every tagged-union case", () => {
    const first = generateEventSamples(VisualizerMachine, { seed: 123 })
    const second = generateEventSamples(VisualizerMachine, { seed: 123 })

    expect(first.issues).toEqual([])
    expect(first.samples).toEqual(second.samples)
    expect(first.samples.map(({ event }) => event._tag).sort()).toEqual([
      "Approve",
      "Disconnect",
      "Edit",
      "Reconnect",
      "Reset",
      "Start",
      "Submit"
    ])
    expect(first.samples.every(({ event }) => Schema.is(Event)(event))).toBe(true)
  })

  it("prefers named fixtures over generated values for the same tag", () => {
    const generated = generateEventSamples(VisualizerMachine, { seed: 123 })
    const fixtures = defineEventFixtures(VisualizerMachine, [
      {
        id: "start-known-task",
        label: "Start known task",
        event: Event.cases.Start.make({ task: "Known task" })
      }
    ])
    const merged = mergeEventSamples(generated.samples, fixtures)
    const starts = merged.filter(({ event }) => event._tag === "Start")

    expect(starts).toEqual([
      {
        id: "start-known-task",
        label: "Start known task",
        event: Event.cases.Start.make({ task: "Known task" }),
        origin: "fixture"
      }
    ])
  })
})
