/**
 * Serializable structural metadata for state-owned machine activities.
 *
 * @since 0.4.0
 */

import * as Duration from "effect/Duration"

/** @internal */
export type StaticActivityMetadata =
  | {
    readonly type: "process"
  }
  | {
    readonly type: "effect"
    readonly outcomes: {
      readonly success: "dynamic"
      readonly failure: "dynamic" | "none"
    }
  }
  | {
    readonly type: "timer"
    readonly duration: string | "dynamic"
  }
  | {
    readonly type: "stream"
  }
  | {
    readonly type: "machine"
    readonly child: {
      readonly id: string
      readonly machineId: string | null
    }
  }

/** @internal */
export type ActivityDefinition<Source extends string = string> = {
  readonly source: Source
  readonly id: string
} & StaticActivityMetadata

interface InspectableMachine {
  readonly handlers: unknown
  readonly stateNodes: {
    readonly byPath: {
      values(): Iterable<{ readonly path: string }>
    }
  }
}

const isObject = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function"

const getProperty = (value: unknown, key: PropertyKey): unknown => isObject(value) ? Reflect.get(value, key) : undefined

const appendStaticDefinition = (
  definitions: Array<ActivityDefinition>,
  source: string,
  descriptor: unknown
): void => {
  if (!isObject(descriptor)) return
  const child = getProperty(descriptor, "child")
  if (isObject(child)) {
    const id = getProperty(child, "id")
    if (typeof id !== "string") return
    const machine = getProperty(child, "machine")
    const machineId = getProperty(machine, "id")
    definitions.push({
      source,
      id,
      type: "machine",
      child: { id, machineId: typeof machineId === "string" ? machineId : null }
    })
    return
  }
  const id = getProperty(descriptor, "id")
  if (typeof id !== "string") return
  if (Reflect.has(descriptor, "effect")) {
    definitions.push({
      source,
      id,
      type: "effect",
      outcomes: {
        success: "dynamic",
        failure: Reflect.has(descriptor, "onFailure") ? "dynamic" : "none"
      }
    })
    return
  }
  if (Reflect.has(descriptor, "after")) {
    const after = getProperty(descriptor, "after")
    definitions.push({
      source,
      id,
      type: "timer",
      duration: typeof after === "function" ? "dynamic" : Duration.format(Duration.fromInputUnsafe(after as any))
    })
    return
  }
  if (Reflect.has(descriptor, "stream")) {
    definitions.push({ source, id, type: "stream" })
    return
  }
  if (Reflect.has(descriptor, "logic")) {
    definitions.push({ source, id, type: "process" })
  }
}

/**
 * Collects state-owned activity descriptions without executing user code.
 *
 * Source factories are inspected without execution. Static descriptors are
 * returned in state definition order and descriptor array order.
 *
 * @internal
 */
export const activityDefinitions = (machine: InspectableMachine): ReadonlyArray<ActivityDefinition> => {
  const definitions: Array<ActivityDefinition> = []
  for (const node of machine.stateNodes.byPath.values()) {
    const invoke = getProperty(getProperty(machine.handlers, node.path), "invoke")
    if (Array.isArray(invoke)) {
      for (const descriptor of invoke) {
        appendStaticDefinition(definitions, node.path, descriptor)
      }
    } else {
      appendStaticDefinition(definitions, node.path, invoke)
    }
  }
  return definitions
}
