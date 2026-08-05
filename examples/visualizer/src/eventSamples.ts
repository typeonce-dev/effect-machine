import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"
import * as FastCheck from "fast-check"

export interface EventSample<Event extends { readonly _tag: PropertyKey }> {
  readonly id: string
  readonly label: string
  readonly event: Event
  readonly origin: "fixture" | "generated"
}

export interface EventFixture<Event extends { readonly _tag: PropertyKey }> {
  readonly id: string
  readonly label: string
  readonly event: Event
}

export interface EventSampleIssue {
  readonly schema: string
  readonly message: string
}

export interface GeneratedEventSamples<Event extends { readonly _tag: PropertyKey }> {
  readonly samples: ReadonlyArray<EventSample<Event>>
  readonly issues: ReadonlyArray<EventSampleIssue>
}

export const defineEventFixtures = <
  M extends Machine.Machine.Any,
  const Fixtures extends ReadonlyArray<EventFixture<Machine.Machine.InputEvent<M>>>
>(
  _machine: M,
  fixtures: Fixtures
): Fixtures => fixtures

const hasCases = (schema: unknown): schema is { readonly cases: Readonly<Record<PropertyKey, Schema.Constraint>> } =>
  (typeof schema === "object" || typeof schema === "function") && schema !== null && "cases" in schema &&
  typeof schema.cases === "object" && schema.cases !== null

const printableError = (error: unknown): string => error instanceof Error ? error.message : String(error)

const caseSchemas = (
  schemas: ReadonlyArray<Machine.Machine.TaggedSchema>
): ReadonlyArray<readonly [string, Schema.Constraint]> => {
  const cases: Array<readonly [string, Schema.Constraint]> = []

  schemas.forEach((schema, schemaIndex) => {
    if (hasCases(schema)) {
      for (const key of Reflect.ownKeys(schema.cases)) {
        const member = schema.cases[key]
        if (member !== undefined) cases.push([String(key), member])
      }
      return
    }
    cases.push([`schema-${schemaIndex + 1}`, schema as Schema.Constraint])
  })

  return cases
}

export const generateEventSamples = <M extends Machine.Machine.Any>(
  machine: M,
  options?: {
    readonly seed?: number
  }
): GeneratedEventSamples<Machine.Machine.InputEvent<M>> => {
  const samples: Array<EventSample<Machine.Machine.InputEvent<M>>> = []
  const issues: Array<EventSampleIssue> = []
  const seed = options?.seed ?? 42

  caseSchemas(machine.events).forEach(([schemaName, schema], index) => {
    try {
      const { report, value } = Schema.toArbitrary(schema, { report: true })
      const event = FastCheck.sample(value, { numRuns: 1, seed: seed + index })[0] as
        | Machine.Machine.InputEvent<M>
        | undefined
      if (event === undefined || typeof event !== "object" || !("_tag" in event)) {
        issues.push({ schema: schemaName, message: "The schema did not generate a tagged event" })
        return
      }
      samples.push({
        id: `generated-${String(event._tag)}`,
        label: String(event._tag),
        event,
        origin: "generated"
      })
      for (const warning of report.warnings) {
        issues.push({
          schema: schemaName,
          message: `${warning._tag} at ${warning.path.map(String).join(".") || "<root>"}`
        })
      }
    } catch (error) {
      issues.push({ schema: schemaName, message: printableError(error) })
    }
  })

  return { samples, issues }
}

export const mergeEventSamples = <Event extends { readonly _tag: PropertyKey }>(
  generated: ReadonlyArray<EventSample<Event>>,
  fixtures: ReadonlyArray<EventFixture<Event>>
): ReadonlyArray<EventSample<Event>> => {
  const fixtureTags = new Set(fixtures.map(({ event }) => event._tag))
  return [
    ...fixtures.map((fixture): EventSample<Event> => ({ ...fixture, origin: "fixture" })),
    ...generated.filter(({ event }) => !fixtureTags.has(event._tag))
  ]
}
