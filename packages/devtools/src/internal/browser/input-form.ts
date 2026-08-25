import type { InputSchema } from "../../MachineDocument.js"

type JsonPrimitive = string | number | boolean | null

export type InputField =
  | {
    readonly _tag: "String"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly defaultValue: string | undefined
    readonly format: string | undefined
    readonly minLength: number | undefined
    readonly maxLength: number | undefined
    readonly pattern: string | undefined
  }
  | {
    readonly _tag: "Number"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly defaultValue: number | undefined
    readonly integer: boolean
    readonly minimum: number | undefined
    readonly maximum: number | undefined
  }
  | {
    readonly _tag: "Boolean"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly defaultValue: boolean | undefined
  }
  | {
    readonly _tag: "Enum"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly values: ReadonlyArray<JsonPrimitive>
    readonly defaultValue: JsonPrimitive | undefined
  }
  | {
    readonly _tag: "Literal"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly value: JsonPrimitive
  }
  | {
    readonly _tag: "Object"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly fields: ReadonlyArray<{
      readonly key: string
      readonly required: boolean
      readonly field: InputField
    }>
  }
  | {
    readonly _tag: "Array"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly item: InputField
    readonly minItems: number
    readonly maxItems: number | undefined
  }
  | {
    readonly _tag: "Union"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly alternatives: ReadonlyArray<InputField>
  }
  | {
    readonly _tag: "Unsupported"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly reason: string
  }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringValue = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const primitiveValue = (value: unknown): JsonPrimitive | undefined =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined

const resolveReference = (
  value: unknown,
  definitions: Readonly<Record<string, unknown>>,
  seen: ReadonlySet<string> = new Set()
): unknown => {
  if (!isRecord(value) || typeof value.$ref !== "string" || !value.$ref.startsWith("#/$defs/")) return value
  const name = decodeURIComponent(value.$ref.slice("#/$defs/".length))
  if (seen.has(name)) return undefined
  const next = definitions[name]
  return resolveReference(next, definitions, new Set([...seen, name]))
}

const annotations = (schema: Record<string, unknown>) => ({
  title: stringValue(schema.title),
  description: stringValue(schema.description)
})

const mergeAllOf = (
  schema: Record<string, unknown>,
  definitions: Readonly<Record<string, unknown>>
): Record<string, unknown> => {
  if (!Array.isArray(schema.allOf)) return schema
  const { allOf, ...base } = schema
  return Object.assign(
    base,
    ...allOf
      .map((part) => resolveReference(part, definitions))
      .filter(isRecord)
      .map((part) => mergeAllOf(part, definitions))
  )
}

const effectNumberAlternative = (
  alternatives: ReadonlyArray<unknown>,
  definitions: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined => {
  if (alternatives.length !== 2) return undefined
  const resolved = alternatives.map((alternative) => resolveReference(alternative, definitions))
  const number = resolved.find((alternative) => isRecord(alternative) && alternative.type === "number")
  const encodedNonFinite = resolved.find((alternative) => {
    if (!isRecord(alternative) || alternative.type !== "string" || !Array.isArray(alternative.enum)) return false
    const enumValues: ReadonlyArray<unknown> = alternative.enum
    return enumValues.length === 3 &&
      ["Infinity", "-Infinity", "NaN"].every((value) => enumValues.includes(value))
  })
  return isRecord(number) && encodedNonFinite !== undefined ? number : undefined
}

const project = (
  value: unknown,
  definitions: Readonly<Record<string, unknown>>
): InputField => {
  const referenced = resolveReference(value, definitions)
  if (!isRecord(referenced)) {
    return {
      _tag: "Unsupported",
      title: undefined,
      description: undefined,
      reason: "This input schema cannot be represented as fields."
    }
  }
  const resolved = mergeAllOf(referenced, definitions)
  const common = annotations(resolved)
  const alternatives = Array.isArray(resolved.oneOf)
    ? resolved.oneOf
    : Array.isArray(resolved.anyOf)
    ? resolved.anyOf
    : undefined
  if (alternatives !== undefined) {
    const effectNumber = effectNumberAlternative(alternatives, definitions)
    if (effectNumber !== undefined) {
      return {
        _tag: "Number",
        ...common,
        defaultValue: numberValue(resolved.default ?? effectNumber.default),
        integer: false,
        minimum: numberValue(resolved.minimum ?? effectNumber.minimum),
        maximum: numberValue(resolved.maximum ?? effectNumber.maximum)
      }
    }
    return {
      _tag: "Union",
      ...common,
      alternatives: alternatives.map((alternative) => project(alternative, definitions))
    }
  }
  const constant = primitiveValue(resolved.const)
  if (constant !== undefined || resolved.const === null) {
    return { _tag: "Literal", ...common, value: constant ?? null }
  }
  if (Array.isArray(resolved.enum)) {
    const values = resolved.enum.map(primitiveValue).filter((item): item is JsonPrimitive => item !== undefined)
    if (values.length > 0) {
      return {
        _tag: "Enum",
        ...common,
        values,
        defaultValue: primitiveValue(resolved.default)
      }
    }
  }
  switch (resolved.type) {
    case "string":
      return {
        _tag: "String",
        ...common,
        defaultValue: stringValue(resolved.default),
        format: stringValue(resolved.format),
        minLength: numberValue(resolved.minLength),
        maxLength: numberValue(resolved.maxLength),
        pattern: stringValue(resolved.pattern)
      }
    case "integer":
    case "number":
      return {
        _tag: "Number",
        ...common,
        defaultValue: numberValue(resolved.default),
        integer: resolved.type === "integer",
        minimum: numberValue(resolved.minimum),
        maximum: numberValue(resolved.maximum)
      }
    case "boolean":
      return {
        _tag: "Boolean",
        ...common,
        defaultValue: typeof resolved.default === "boolean" ? resolved.default : undefined
      }
    case "null":
      return { _tag: "Literal", ...common, value: null }
    case "object": {
      if (!isRecord(resolved.properties)) return { _tag: "Object", ...common, fields: [] }
      const required = new Set(
        Array.isArray(resolved.required)
          ? resolved.required.filter((item): item is string => typeof item === "string")
          : []
      )
      return {
        _tag: "Object",
        ...common,
        fields: Object.entries(resolved.properties).map(([key, child]) => ({
          key,
          required: required.has(key),
          field: project(child, definitions)
        }))
      }
    }
    case "array":
      return {
        _tag: "Array",
        ...common,
        item: project(resolved.items, definitions),
        minItems: numberValue(resolved.minItems) ?? 0,
        maxItems: numberValue(resolved.maxItems)
      }
    default:
      return {
        _tag: "Unsupported",
        ...common,
        reason: "This input schema has no concrete JSON shape to render."
      }
  }
}

export const projectInputSchema = (document: InputSchema): InputField => project(document.schema, document.definitions)
