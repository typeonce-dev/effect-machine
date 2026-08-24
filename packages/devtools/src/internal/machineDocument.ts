import { Machine } from "@typeonce/effect-machine"
import * as Schema from "effect/Schema"
import type * as Public from "../MachineDocument.js"

const enabled = Machine.enabled as (
  machine: Machine.Machine.Any,
  snapshot: unknown
) => ReadonlyArray<PropertyKey>

const inputEventSchemas = Machine.inputEventSchemas as (
  machine: Machine.Machine.Any
) => ReadonlyArray<Machine.Machine.TaggedSchema>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const resolveReference = (
  value: unknown,
  definitions: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.$ref !== "string" || !value.$ref.startsWith("#/$defs/")) return value
  const name = decodeURIComponent(value.$ref.slice("#/$defs/".length))
  const target = definitions[name]
  return isRecord(target) ? target : undefined
}

const tagsOf = (
  value: unknown,
  definitions: Readonly<Record<string, unknown>>
): ReadonlyArray<string> => {
  const schema = resolveReference(value, definitions)
  if (schema === undefined || !isRecord(schema.properties)) return []
  const tag = resolveReference(schema.properties._tag, definitions)
  if (tag === undefined) return []
  if (typeof tag.const === "string" || typeof tag.const === "number") return [String(tag.const)]
  return Array.isArray(tag.enum)
    ? tag.enum.filter((item): item is string | number => typeof item === "string" || typeof item === "number").map(
      String
    )
    : []
}

const inputSchema = (schema: Schema.Top): Public.InputSchema => {
  const document = Schema.toJsonSchemaDocument(schema)
  return {
    dialect: document.dialect,
    schema: document.schema as Schema.Json,
    definitions: document.definitions as Record<string, Schema.Json>
  }
}

const eventInputs = (machine: Machine.Machine.Any): ReadonlyArray<Public.EventInput> => {
  const inputs: Array<Public.EventInput> = []
  for (const eventSchema of inputEventSchemas(machine)) {
    const document = inputSchema(eventSchema)
    const root = document.schema
    const record = isRecord(root) ? root : undefined
    const variants = record !== undefined && Array.isArray(record.anyOf)
      ? record.anyOf
      : record !== undefined && Array.isArray(record.oneOf)
      ? record.oneOf
      : [root]
    for (const variant of variants) {
      for (const event of tagsOf(variant, document.definitions)) {
        inputs.push({
          event,
          schema: { ...document, schema: variant as Schema.Json }
        })
      }
    }
  }
  return inputs
}

const selection = (value: Machine.Machine.TransitionTargetSelection): Public.Selection => ({
  path: value.path ?? null,
  kind: value.kind,
  scope: value.scope ?? null
})

const trigger = (value: Machine.Machine.TransitionTrigger): Public.Trigger => {
  switch (value.type) {
    case "event":
      return { type: "event", event: String(value.event) }
    case "always":
      return { type: "always" }
    case "done":
      return { type: "done" }
    case "choice":
      return { type: "choice" }
    case "invoke":
      return { type: "invoke", id: value.id, outcome: value.outcome }
  }
}

const activity = (value: Machine.Machine.ActivityDefinition, id: string): Public.Activity => {
  const common = { id, source: value.source, lifecycleId: value.id }
  switch (value.type) {
    case "process":
      return { ...common, type: "process" }
    case "effect":
      return { ...common, type: "effect", outcomes: { ...value.outcomes } }
    case "timer":
      return { ...common, type: "timer", duration: value.duration }
    case "stream":
      return { ...common, type: "stream" }
    case "machine":
      return { ...common, type: "machine", child: { ...value.child } }
  }
}

const appendReference = (index: Map<string, Array<string>>, owner: string, id: string): void => {
  const references = index.get(owner) ?? []
  references.push(id)
  index.set(owner, references)
}

export const make = <M extends Machine.Machine.Any>(
  machine: M,
  options: Public.MakeOptions<M> = {}
): Public.MachineDocument => {
  const nodes = Machine.stateNodes(machine)
  const transitionIds = new Map<string, Array<string>>()
  const activityIds = new Map<string, Array<string>>()
  const transitionOffsets = new Map<string, number>()
  const activityOffsets = new Map<string, number>()
  const childPaths = new Map<string | null, Array<string>>()

  for (const node of nodes) {
    const parent = node.parent ?? null
    const siblings = childPaths.get(parent) ?? []
    siblings.push(node.path)
    childPaths.set(parent, siblings)
  }

  const transitions = Machine.transitionDefinitions(machine).map((definition): Public.Transition => {
    const offset = transitionOffsets.get(definition.source) ?? 0
    transitionOffsets.set(definition.source, offset + 1)
    const id = `${definition.source}:transition:${offset}`
    appendReference(transitionIds, definition.source, id)
    return {
      id,
      source: definition.source,
      trigger: trigger(definition.trigger),
      reenter: definition.reenter,
      acceptance: definition.acceptance,
      branches: definition.branches.map((branch, branchIndex): Public.Branch => {
        const common = {
          id: `${id}:branch:${branchIndex}`,
          target: branch.target ?? null,
          selection: selection(branch.selection),
          updates: [...branch.updates]
        }
        return branch.type === "direct"
          ? { ...common, type: "direct" }
          : { ...common, type: "branch", key: branch.key, title: branch.title }
      })
    }
  })

  const activities = Machine.activityDefinitions(machine).map((definition): Public.Activity => {
    const offset = activityOffsets.get(definition.source) ?? 0
    activityOffsets.set(definition.source, offset + 1)
    const id = `${definition.source}:activity:${offset}`
    appendReference(activityIds, definition.source, id)
    return activity(definition, id)
  })

  const initial = Machine.initialDefinition(machine)
  return {
    schemaVersion: 2,
    revision: options.revision ?? 0,
    source: options.source ?? null,
    machineId: machine.id ?? "Machine",
    initial: {
      target: initial.target,
      selection: selection(initial.selection)
    },
    roots: [...childPaths.get(null) ?? []],
    states: nodes.map((node): Public.State => ({
      path: node.path,
      key: node.key,
      order: node.order,
      title: node.annotations?.title ?? null,
      description: node.annotations?.description ?? null,
      documentation: node.annotations?.documentation ?? null,
      type: node.type,
      history: node.history ?? null,
      parent: node.parent ?? null,
      children: [...childPaths.get(node.path) ?? []],
      initial: node.initial ?? null,
      transitionIds: [...transitionIds.get(node.path) ?? []],
      activityIds: [...activityIds.get(node.path) ?? []]
    })),
    transitions,
    activities,
    inputs: {
      machine: machine.input === undefined ? null : inputSchema(machine.input),
      events: eventInputs(machine)
    },
    snapshot: options.snapshot === undefined
      ? null
      : {
        activePaths: Machine.configuration(machine, options.snapshot).map((node) => node.path),
        candidateEvents: enabled(machine, options.snapshot)
          .map(String)
          .filter((event) => Object.hasOwn(machine.events, event))
      }
  }
}
