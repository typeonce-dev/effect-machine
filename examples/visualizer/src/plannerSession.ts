import { Machine } from "@typeonce/effect-machine"
import type { EventSample } from "./eventSamples.ts"

type SnapshotOf<M extends Machine.Machine.Any> = Machine.Machine.Snapshot<Machine.Machine.States<M>>
type InputEventOf<M extends Machine.Machine.Any> = Machine.Machine.InputEvent<M>

export interface PlannedMicrostep {
  readonly event: unknown
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly raisedEvents: ReadonlyArray<unknown>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly changed: boolean
}

export interface PlannerResult<M extends Machine.Machine.Any> {
  readonly next: SnapshotOf<M>
  readonly microsteps: ReadonlyArray<PlannedMicrostep>
  readonly actions: ReadonlyArray<unknown>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly done: boolean
}

export interface PlannerDriver<M extends Machine.Machine.Any> {
  readonly machine: M
  readonly initial: () => Promise<SnapshotOf<M>>
  readonly enabled: (snapshot: SnapshotOf<M>) => ReadonlyArray<PropertyKey>
  readonly plan: (snapshot: SnapshotOf<M>, event: InputEventOf<M>) => Promise<PlannerResult<M>>
}

export type StepClassification = "done" | "ignored" | "handled" | "transitioned"

export interface StepSummary<Event extends { readonly _tag: PropertyKey }> {
  readonly sampleId: string
  readonly event: Event
  readonly classification: StepClassification
  readonly actionCount: number
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly microsteps: ReadonlyArray<PlannedMicrostep>
}

export interface PlannerView<M extends Machine.Machine.Any> {
  readonly snapshot: SnapshotOf<M>
  readonly activePaths: ReadonlyArray<string>
  readonly enabledTags: ReadonlySet<PropertyKey>
  readonly availableSamples: ReadonlyArray<EventSample<InputEventOf<M>>>
  readonly lastStep: StepSummary<InputEventOf<M>> | undefined
}

export interface PlannerSession<M extends Machine.Machine.Any> {
  readonly inspect: () => PlannerView<M>
  readonly send: (sampleId: string) => Promise<PlannerView<M>>
  readonly reset: () => Promise<PlannerView<M>>
}

const classify = <M extends Machine.Machine.Any>(result: PlannerResult<M>): StepClassification =>
  result.done ?
    "done"
    : result.microsteps.length === 0 ?
    "ignored"
    : result.microsteps.some(({ changed }) => changed) ?
    "transitioned"
    : "handled"

export const createPlannerSession = async <M extends Machine.Machine.Any>(
  driver: PlannerDriver<M>,
  samples: ReadonlyArray<EventSample<InputEventOf<M>>>
): Promise<PlannerSession<M>> => {
  let snapshot = await driver.initial()
  let lastStep: StepSummary<InputEventOf<M>> | undefined

  const inspect = (): PlannerView<M> => {
    const enabledTags = new Set<PropertyKey>(driver.enabled(snapshot))
    return {
      snapshot,
      activePaths: Machine.configuration(driver.machine, snapshot).map(({ path }) => path),
      enabledTags,
      availableSamples: samples.filter(({ event }) => enabledTags.has(event._tag)),
      lastStep
    }
  }

  const send = async (sampleId: string): Promise<PlannerView<M>> => {
    const sample = samples.find(({ id }) => id === sampleId)
    if (sample === undefined) throw new Error(`Unknown event sample: ${sampleId}`)
    if (!inspect().enabledTags.has(sample.event._tag)) {
      throw new Error(`Event sample is not enabled: ${sampleId}`)
    }

    const result = await driver.plan(snapshot, sample.event)
    snapshot = result.next
    lastStep = {
      sampleId,
      event: sample.event,
      classification: classify(result),
      actionCount: result.actions.length,
      emittedEvents: result.emittedEvents,
      microsteps: result.microsteps
    }
    return inspect()
  }

  const reset = async (): Promise<PlannerView<M>> => {
    snapshot = await driver.initial()
    lastStep = undefined
    return inspect()
  }

  return { inspect, send, reset }
}
