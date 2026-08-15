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
import * as SchemaAST from "effect/SchemaAST"
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

interface EventProtocolDefinition {
  readonly kind: Machine.EventProtocolKind
  readonly schemas: ReadonlyArray<Machine.TaggedSchema>
}

const eventProtocolDefinitions = new WeakMap<object, EventProtocolDefinition>()

export const EventConstructionTypeId: unique symbol = Symbol("effect/Machine/EventConstruction")

interface EventConstruction {
  readonly [EventConstructionTypeId]: typeof EventConstructionTypeId
  readonly _tag: PropertyKey
}

interface EventConstructionDefinition {
  readonly schema: Machine.TaggedSchema
  readonly input: unknown
  readonly inputError?: unknown
}

const eventConstructionDefinitions = new WeakMap<object, EventConstructionDefinition>()

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

const getEventProtocolDefinition = (
  protocol: Machine.EventProtocol.Any,
  expectedKind?: Machine.EventProtocolKind
): EventProtocolDefinition => {
  const definition = eventProtocolDefinitions.get(protocol as object)
  if (definition === undefined) {
    throw new Error("Machine expected an event protocol created with Machine.events or Machine.internalEvents")
  }
  if (expectedKind !== undefined && definition.kind !== expectedKind) {
    throw new Error(`Machine expected a ${expectedKind} event protocol`)
  }
  return definition
}

export const eventProtocolSchemas = <Schemas extends ReadonlyArray<Machine.TaggedSchema>>(
  protocol: Machine.EventProtocol<Machine.EventProtocolKind, Schemas>
): Schemas => getEventProtocolDefinition(protocol).schemas as Schemas

export const inputEventSchemas = (machine: Machine.Any): ReadonlyArray<Machine.TaggedSchema> =>
  getEventProtocolDefinition(machine.events, "public").schemas

export const internalEventSchemas = (machine: Machine.Any): ReadonlyArray<Machine.TaggedSchema> =>
  getEventProtocolDefinition(machine.internalEvents, "internal").schemas

export const setProtocol = (machine: Machine.Any): void => {
  const inputEvents = inputEventSchemas(machine)
  const localEvents = internalEventSchemas(machine)
  const publicTags = new Set(Reflect.ownKeys(machine.events))
  for (const tag of Reflect.ownKeys(machine.internalEvents)) {
    if (publicTags.has(tag)) {
      throw new Error(`Public and internal machine event tags must be disjoint: ${String(tag)}`)
    }
  }
  const events = [...inputEvents, ...localEvents]
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

const makeEventConstruction = (
  schema: Machine.TaggedSchema,
  tag: PropertyKey,
  input: unknown
): EventConstruction => {
  let ownedInput = input
  let inputError: unknown
  if (typeof input === "object" && input !== null) {
    try {
      ownedInput = { ...input }
    } catch (cause) {
      ownedInput = undefined
      inputError = cause
    }
  }
  const construction: EventConstruction = {
    [EventConstructionTypeId]: EventConstructionTypeId,
    _tag: tag
  }
  eventConstructionDefinitions.set(construction, {
    schema,
    input: ownedInput,
    ...(inputError === undefined ? {} : { inputError })
  })
  return Object.freeze(construction)
}

const isEventConstruction = (value: unknown): value is EventConstruction =>
  typeof value === "object" && value !== null && eventConstructionDefinitions.has(value)

const eventConstructors = (
  schemas: ReadonlyArray<Machine.TaggedSchema>
): Readonly<Record<PropertyKey, (...args: ReadonlyArray<unknown>) => EventConstruction>> => {
  const leaves: Array<Machine.TaggedSchema> = []
  const collect = (schema: Machine.TaggedSchema): void => {
    if (hasProperty(schema, "cases") && typeof schema.cases === "object" && schema.cases !== null) {
      for (const candidate of Reflect.ownKeys(schema.cases)) {
        collect(Reflect.get(schema.cases, candidate) as Machine.TaggedSchema)
      }
      return
    }
    if (hasProperty(schema, "members") && Array.isArray(schema.members)) {
      for (const member of schema.members) collect(member as Machine.TaggedSchema)
      return
    }
    leaves.push(schema)
  }
  for (const schema of schemas) collect(schema)
  const constructors = Object.create(null) as Record<
    PropertyKey,
    (...args: ReadonlyArray<unknown>) => EventConstruction
  >
  const tags = (ast: SchemaAST.AST): ReadonlyArray<PropertyKey> => {
    if (SchemaAST.isLiteral(ast)) {
      return typeof ast.literal === "string" || typeof ast.literal === "number" ? [ast.literal] : []
    }
    if (SchemaAST.isUniqueSymbol(ast)) return [ast.symbol]
    if (SchemaAST.isEnum(ast)) return ast.enums.map(([, value]) => value)
    if (SchemaAST.isUnion(ast)) return ast.types.flatMap(tags)
    if (SchemaAST.isSuspend(ast)) return tags(ast.thunk())
    return []
  }
  const schemaTags = (schema: Machine.TaggedSchema): ReadonlyArray<PropertyKey> => {
    const ast = SchemaAST.toType(schema.ast)
    if (SchemaAST.isObjects(ast)) {
      const tag = ast.propertySignatures.find(({ name }) => name === "_tag")
      const discriminants = tag === undefined ? [] : tags(tag.type)
      if (discriminants.length > 0) return discriminants
    }
    try {
      return Schema.Union([schema]).pipe(Schema.toTaggedUnion("_tag")).discriminants
    } catch {
      return []
    }
  }
  for (const schema of leaves) {
    const discriminants = schemaTags(schema)
    if (discriminants.length === 0) {
      continue
    }
    for (const tag of discriminants) {
      if (hasProperty(constructors, tag)) {
        throw new Error(`Duplicate machine event constructor tag: ${String(tag)}`)
      }
      Object.defineProperty(constructors, tag, {
        value: (...args: ReadonlyArray<unknown>) =>
          makeEventConstruction(schema, tag, args.length === 0 ? {} : args[0]),
        enumerable: true
      })
    }
  }
  return constructors
}

export const makeEventProtocol = <
  Kind extends Machine.EventProtocolKind,
  Schemas extends ReadonlyArray<Machine.TaggedSchema>
>(
  kind: Kind,
  schemas: Schemas
): Machine.EventProtocol<Kind, Schemas> => {
  const ownedSchemas = Object.freeze(Array.from(schemas)) as unknown as Schemas
  const protocol = eventConstructors(ownedSchemas) as Machine.EventProtocol<Kind, Schemas>
  eventProtocolDefinitions.set(protocol as object, { kind, schemas: ownedSchemas })
  return Object.freeze(protocol) as Machine.EventProtocol<Kind, Schemas>
}

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

const eventConstructionProtocolError = (
  machine: Machine.Any,
  construction: EventConstruction
): MachineSchemaDecodeError =>
  new MachineSchemaDecodeError({
    machineId: machine.id,
    boundary: "event",
    event: String(construction._tag),
    cause: Cause.die(new Error("Constructed event schema does not belong to the machine event protocol"))
  })

const eventConstructionInput = (
  construction: EventConstruction,
  definition: EventConstructionDefinition
): unknown => {
  if (definition.inputError !== undefined) throw definition.inputError
  return typeof definition.input === "object" && definition.input !== null
    ? { ...definition.input, _tag: construction._tag }
    : { _tag: construction._tag }
}

const eventConstructionInputError = (
  machine: Machine.Any,
  construction: EventConstruction,
  cause: unknown
): MachineSchemaDecodeError =>
  new MachineSchemaDecodeError({
    machineId: machine.id,
    boundary: "event",
    event: String(construction._tag),
    cause: Cause.die(cause)
  })

const decodeEventConstruction = (
  machine: Machine.Any,
  protocol: MachineProtocolSchemas,
  construction: EventConstruction
): Effect.Effect<unknown, MachineSchemaDecodeError> => {
  const definition = eventConstructionDefinitions.get(construction)
  if (definition === undefined || !protocol.eventConstructors.has(definition.schema as object)) {
    return Effect.fail(eventConstructionProtocolError(machine, construction))
  }
  return Effect.try({
    try: () => eventConstructionInput(construction, definition),
    catch: (cause) => eventConstructionInputError(machine, construction, cause)
  }).pipe(
    Effect.flatMap((input) =>
      definition.schema.makeEffect(input as never).pipe(
        Effect.mapError((cause) =>
          new MachineSchemaDecodeError({
            machineId: machine.id,
            boundary: "event",
            event: String(construction._tag),
            cause: new Schema.SchemaError(cause)
          })
        )
      )
    ),
    Effect.tap((event) => Effect.sync(() => protocol.trustedEvents.add(event as object)))
  )
}

const decodeEventConstructionSync = (
  machine: Machine.Any,
  protocol: MachineProtocolSchemas,
  construction: EventConstruction
): unknown => {
  const definition = eventConstructionDefinitions.get(construction)
  if (definition === undefined || !protocol.eventConstructors.has(definition.schema as object)) {
    throw eventConstructionProtocolError(machine, construction)
  }
  let input: unknown
  try {
    input = eventConstructionInput(construction, definition)
  } catch (cause) {
    throw eventConstructionInputError(machine, construction, cause)
  }
  const event = makeBoundarySync(machine, definition.schema, input, {
    boundary: "event",
    event: String(construction._tag)
  })
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
  if (isEventConstruction(event)) {
    return decodeEventConstruction(machine, protocol, event) as Effect.Effect<
      Machine.EventOf<Events>,
      MachineSchemaDecodeError
    >
  }
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
  if (isEventConstruction(event)) {
    return decodeEventConstructionSync(machine, protocol, event) as Machine.EventOf<Events>
  }
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
