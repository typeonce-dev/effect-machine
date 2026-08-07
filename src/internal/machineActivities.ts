/**
 * Serializable structural metadata for state-owned machine activities.
 *
 * @since 4.0.0
 */

/** @internal */
export const ActivityMetadataTypeId: unique symbol = Symbol.for("effect/Machine/ActivityMetadata")

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
    readonly duration: string
    readonly event: string
  }
  | {
    readonly type: "machine"
    readonly child: {
      readonly id: string
      readonly machineId: string | null
    }
  }

/** @internal */
export type ActivityDefinition<Source extends string = string> =
  | ({
    readonly source: Source
    readonly id: string
  } & StaticActivityMetadata)
  | {
    readonly source: Source
    readonly type: "dynamic"
  }

interface ActivityDescriptor {
  readonly id: string
  readonly [ActivityMetadataTypeId]: StaticActivityMetadata
}

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

const hasActivityMetadata = (value: unknown): value is ActivityDescriptor =>
  isObject(value) && typeof getProperty(value, "id") === "string" &&
  isObject(getProperty(value, ActivityMetadataTypeId))

const appendStaticDefinition = (
  definitions: Array<ActivityDefinition>,
  source: string,
  descriptor: unknown
): void => {
  if (!hasActivityMetadata(descriptor)) {
    return
  }
  definitions.push({
    source,
    id: descriptor.id,
    ...descriptor[ActivityMetadataTypeId]
  })
}

/**
 * Collects state-owned activity descriptions without executing user code.
 *
 * Function-valued invoke definitions depend on an entry context and are
 * therefore represented as dynamic. Static descriptors are returned in state
 * definition order and descriptor array order.
 *
 * @internal
 */
export const activityDefinitions = (machine: InspectableMachine): ReadonlyArray<ActivityDefinition> => {
  const definitions: Array<ActivityDefinition> = []
  for (const node of machine.stateNodes.byPath.values()) {
    const invoke = getProperty(getProperty(machine.handlers, node.path), "invoke")
    if (typeof invoke === "function") {
      definitions.push({ source: node.path, type: "dynamic" })
    } else if (Array.isArray(invoke)) {
      for (const descriptor of invoke) {
        appendStaticDefinition(definitions, node.path, descriptor)
      }
    } else {
      appendStaticDefinition(definitions, node.path, invoke)
    }
  }
  return definitions
}
