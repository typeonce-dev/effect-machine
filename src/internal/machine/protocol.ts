/**
 * Internal machine schema protocol and boundary decoders.
 *
 * @since 0.4.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { hasProperty } from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { Machine } from "../../Machine.js"
import { MachineSchemaDecodeError } from "./errors.js"
import { getStateNodeSchema, isStateInput } from "./topology.js"

export interface DecodeBoundaryOptions {
  readonly boundary: "input" | "event" | "emit" | "state" | "output" | "history" | "configuration"
  readonly state?: string
  readonly event?: string
}

interface MachineProtocolSchemas {
  readonly event: Schema.Top
  readonly emit: Schema.Top
  readonly eventConstructors: ReadonlySet<object>
  readonly trustedEvents: WeakSet<object>
}

type BoundaryDecoder = (value: unknown) => Effect.Effect<unknown, Schema.SchemaError, unknown>

type BoundaryResultDecoder = (value: unknown) => Result.Result<unknown, Schema.SchemaError>

const boundaryDecoderCache = new WeakMap<object, BoundaryDecoder>()

const boundaryResultDecoderCache = new WeakMap<object, BoundaryResultDecoder>()

const getBoundaryDecoder = (schema: Schema.Top): BoundaryDecoder => {
  const key = schema as object
  const cached = boundaryDecoderCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const decoder = Schema.decodeUnknownEffect(Schema.toType(schema)) as BoundaryDecoder
  boundaryDecoderCache.set(key, decoder)
  return decoder
}

const getBoundaryResultDecoder = (schema: Schema.Top): BoundaryResultDecoder => {
  const key = schema as object
  const cached = boundaryResultDecoderCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const decoder = Schema.decodeUnknownResult(Schema.toType(schema)) as BoundaryResultDecoder
  boundaryResultDecoderCache.set(key, decoder)
  return decoder
}

const MachineProtocolTypeId = Symbol.for("effect/Machine/protocol")

const getProtocolSchemas = (machine: Machine.Any): MachineProtocolSchemas => {
  const protocol = (machine as any)[MachineProtocolTypeId] as MachineProtocolSchemas | undefined
  if (protocol === undefined) {
    throw new Error("Machine protocol is unavailable")
  }
  return protocol
}

const setProtocolSchemas = (machine: Machine.Any, protocol: MachineProtocolSchemas): void => {
  Object.defineProperty(machine, MachineProtocolTypeId, {
    value: protocol,
    enumerable: false
  })
}

const collectEventConstructors = (
  schemas: ReadonlyArray<Machine.TaggedSchema>
): ReadonlySet<object> => {
  const constructors = new Set<object>()
  const add = (schema: Machine.TaggedSchema): void => {
    const key = schema as object
    if (constructors.has(key)) return
    constructors.add(key)
    if (!hasProperty(schema, "cases") || typeof schema.cases !== "object" || schema.cases === null) return
    for (const candidate of Object.values(schema.cases)) {
      if (
        ((typeof candidate === "object" && candidate !== null) || typeof candidate === "function") &&
        hasProperty(candidate, "make")
      ) {
        add(candidate as Machine.TaggedSchema)
      }
    }
  }
  for (const schema of schemas) add(schema)
  return constructors
}

export const setProtocol = (machine: Machine.Any): void => {
  const events = [...machine.events, ...machine.internalEvents]
  setProtocolSchemas(machine, {
    event: Schema.Union(events),
    emit: Schema.Union(machine.emits),
    eventConstructors: collectEventConstructors(events),
    trustedEvents: new WeakSet()
  })
}

export const copyProtocol = (source: Machine.Any, target: Machine.Any): void =>
  setProtocolSchemas(target, getProtocolSchemas(source))

export const getEventName = (event: unknown): string | undefined =>
  hasProperty(event, "_tag") ? String(event._tag) : undefined

export const decodeBoundary = <A>(
  machine: Machine.Any,
  schema: Schema.Top,
  value: unknown,
  options: DecodeBoundaryOptions
): Effect.Effect<A, MachineSchemaDecodeError> =>
  getBoundaryDecoder(schema)(value).pipe(
    Effect.mapError((cause) =>
      new MachineSchemaDecodeError({
        machineId: machine.id,
        boundary: options.boundary,
        cause,
        ...(options.state === undefined ? {} : { state: options.state }),
        ...(options.event === undefined ? {} : { event: options.event })
      })
    )
  ) as Effect.Effect<A, MachineSchemaDecodeError>

export const decodeBoundarySync = <A>(
  machine: Machine.Any,
  schema: Schema.Top,
  value: unknown,
  options: DecodeBoundaryOptions
): A => {
  const decoded = getBoundaryResultDecoder(schema)(value)
  if (Result.isFailure(decoded)) {
    throw new MachineSchemaDecodeError({
      machineId: machine.id,
      boundary: options.boundary,
      cause: decoded.failure,
      ...(options.state === undefined ? {} : { state: options.state }),
      ...(options.event === undefined ? {} : { event: options.event })
    })
  }
  return decoded.success as A
}

const makeBoundarySync = <A>(
  machine: Machine.Any,
  schema: Schema.Top,
  input: unknown,
  options: DecodeBoundaryOptions
): A => {
  try {
    return schema.make(input as never) as A
  } catch (cause) {
    const issue = cause instanceof Error ? cause.cause : undefined
    throw new MachineSchemaDecodeError({
      machineId: machine.id,
      boundary: options.boundary,
      cause: Schema.isSchemaError(cause)
        ? cause
        : hasProperty(issue, "~effect/SchemaIssue/Issue")
        ? new Schema.SchemaError(issue as any)
        : Cause.die(cause),
      ...(options.state === undefined ? {} : { state: options.state }),
      ...(options.event === undefined ? {} : { event: options.event })
    })
  }
}

/** Constructs an event through one of the machine protocol's own schemas and
 * records the decoded value as trusted by that protocol. Machine clones share
 * the protocol record, while unrelated machines retain independent trust. */
export const makeEvent = <Schema extends Machine.TaggedSchema>(
  machine: Machine.Any,
  schema: Schema,
  input: unknown
): Schema["Type"] => {
  const protocol = getProtocolSchemas(machine)
  if (!protocol.eventConstructors.has(schema as object)) {
    throw new Error("Machine.event expected a schema from the machine event protocol")
  }
  const inputName = getEventName(input)
  const event = makeBoundarySync<Schema["Type"]>(
    machine,
    schema,
    input,
    inputName === undefined ? { boundary: "event" } : { boundary: "event", event: inputName }
  )
  protocol.trustedEvents.add(event as object)
  return event
}

const isTrustedEvent = (protocol: MachineProtocolSchemas, event: unknown): boolean =>
  typeof event === "object" && event !== null && protocol.trustedEvents.has(event)

export const decodeInput = <Input extends Schema.Top>(
  machine: Machine.Any,
  schema: Input,
  value: unknown
): Effect.Effect<Input["Type"], MachineSchemaDecodeError> =>
  decodeBoundary<Input["Type"]>(machine, schema, value, { boundary: "input" })

export const decodeEvent = <const Events extends ReadonlyArray<Machine.TaggedSchema>>(
  machine: Machine.Any,
  event: unknown
): Effect.Effect<Machine.EventOf<Events>, MachineSchemaDecodeError> => {
  const protocol = getProtocolSchemas(machine)
  if (isTrustedEvent(protocol, event)) {
    return Effect.succeed(event as Machine.EventOf<Events>)
  }
  const eventName = getEventName(event)
  return decodeBoundary<Machine.EventOf<Events>>(
    machine,
    protocol.event,
    event,
    eventName === undefined ? { boundary: "event" } : { boundary: "event", event: eventName }
  )
}

export const decodeEventSync = <const Events extends ReadonlyArray<Machine.TaggedSchema>>(
  machine: Machine.Any,
  event: unknown
): Machine.EventOf<Events> => {
  const protocol = getProtocolSchemas(machine)
  if (isTrustedEvent(protocol, event)) {
    return event as Machine.EventOf<Events>
  }
  const eventName = getEventName(event)
  return decodeBoundarySync<Machine.EventOf<Events>>(
    machine,
    protocol.event,
    event,
    eventName === undefined ? { boundary: "event" } : { boundary: "event", event: eventName }
  )
}

export const decodeEmit = <const Emits extends ReadonlyArray<Machine.TaggedSchema>>(
  machine: Machine.Any,
  event: unknown
): Effect.Effect<Machine.EmitOf<Emits>, MachineSchemaDecodeError> => {
  const eventName = getEventName(event)
  return decodeBoundary<Machine.EmitOf<Emits>>(
    machine,
    getProtocolSchemas(machine).emit,
    event,
    eventName === undefined ? { boundary: "emit" } : { boundary: "emit", event: eventName }
  )
}

export const decodeEmitSync = <const Emits extends ReadonlyArray<Machine.TaggedSchema>>(
  machine: Machine.Any,
  event: unknown
): Machine.EmitOf<Emits> => {
  const eventName = getEventName(event)
  return decodeBoundarySync<Machine.EmitOf<Emits>>(
    machine,
    getProtocolSchemas(machine).emit,
    event,
    eventName === undefined ? { boundary: "emit" } : { boundary: "emit", event: eventName }
  )
}

export const decodeInputSync = <Input extends Schema.Top>(
  machine: Machine.Any,
  schema: Input,
  value: unknown
): Input["Type"] => decodeBoundarySync<Input["Type"]>(machine, schema, value, { boundary: "input" })

export const decodeStateValue = (
  machine: Machine.Any,
  node: Machine.StateNode,
  value: unknown
): Effect.Effect<unknown, MachineSchemaDecodeError> =>
  isStateInput(value)
    ? getStateNodeSchema(node).makeEffect(value.input).pipe(
      Effect.mapError((cause) =>
        new MachineSchemaDecodeError({
          machineId: machine.id,
          boundary: "state",
          state: node.path,
          cause: new Schema.SchemaError(cause)
        })
      )
    )
    : decodeBoundary(machine, getStateNodeSchema(node), value, { boundary: "state", state: node.path })

export const decodeStateValueSync = (
  machine: Machine.Any,
  node: Machine.StateNode,
  value: unknown
): unknown => {
  if (!isStateInput(value)) {
    return decodeBoundarySync(machine, getStateNodeSchema(node), value, { boundary: "state", state: node.path })
  }
  return makeBoundarySync(machine, getStateNodeSchema(node), value.input, {
    boundary: "state",
    state: node.path
  })
}

export const decodeOutputValue = (
  machine: Machine.Any,
  node: Machine.StateNode,
  value: unknown
): Effect.Effect<unknown, MachineSchemaDecodeError> =>
  node.output === undefined
    ? Effect.succeed(value)
    : decodeBoundary(machine, node.output, value, { boundary: "output", state: node.path })

export const decodeOutputValueSync = (
  machine: Machine.Any,
  node: Machine.StateNode,
  value: unknown
): unknown =>
  node.output === undefined
    ? value
    : decodeBoundarySync(machine, node.output, value, { boundary: "output", state: node.path })
