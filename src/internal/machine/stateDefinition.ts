import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"

export const StateNodePropertyPolicy = {
  atomic: ["schema", "type", "annotations"],
  final: ["schema", "type", "output", "annotations"],
  compound: ["schema", "type", "initial", "states", "annotations"],
  parallel: ["schema", "type", "output", "states", "annotations"],
  history: ["type", "history", "annotations"],
  choice: ["type", "annotations"]
} as const

export const PseudoStateAnnotationProperties = ["title", "description", "documentation"] as const

export type StateNodeKind = keyof typeof StateNodePropertyPolicy

export type AllowedStateNodeProperty<Kind extends StateNodeKind> = (typeof StateNodePropertyPolicy)[Kind][number]

export type AllowedPseudoStateAnnotationProperty = (typeof PseudoStateAnnotationProperties)[number]

export type StateDefinitionBoundary = "Machine.defineStates" | "Machine.make"

const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key)

const displayPath = (parent: string, key: PropertyKey): string => {
  const segment = typeof key === "symbol" ? `[${String(key)}]` : key === "" ? "<empty>" : String(key)
  return parent === "" ? segment : `${parent}.${segment}`
}

const fail = (boundary: StateDefinitionBoundary, path: string, message: string): never => {
  throw new Error(`${boundary} invalid state definition at "${path}": ${message}`)
}

const isNumericForm = (key: string): boolean => Number.isFinite(Number(key))

type TaggedSchemaEvidence = "tagged" | "untagged" | "opaque"

const unionEvidence = (evidence: ReadonlyArray<TaggedSchemaEvidence>): TaggedSchemaEvidence =>
  evidence.length === 0 || evidence.some((result) => result === "untagged")
    ? "untagged"
    : evidence.every((result) => result === "tagged")
    ? "tagged"
    : "opaque"

const propertyKeyEvidence = (
  ast: SchemaAST.AST,
  seen: ReadonlySet<SchemaAST.AST>
): TaggedSchemaEvidence => {
  if (seen.has(ast)) return "opaque"
  if (SchemaAST.isString(ast) || SchemaAST.isNumber(ast) || SchemaAST.isSymbol(ast)) return "tagged"
  if (SchemaAST.isTemplateLiteral(ast) || SchemaAST.isUniqueSymbol(ast) || SchemaAST.isEnum(ast)) return "tagged"
  if (SchemaAST.isLiteral(ast)) {
    return typeof ast.literal === "string" || typeof ast.literal === "number" ? "tagged" : "untagged"
  }
  const nextSeen = new Set(seen).add(ast)
  if (SchemaAST.isUnion(ast)) return unionEvidence(ast.types.map((member) => propertyKeyEvidence(member, nextSeen)))
  if (SchemaAST.isSuspend(ast)) return propertyKeyEvidence(ast.thunk(), nextSeen)
  if (SchemaAST.isDeclaration(ast)) return "opaque"
  return "untagged"
}

const taggedSchemaEvidence = (
  ast: SchemaAST.AST,
  seen: ReadonlySet<SchemaAST.AST> = new Set()
): TaggedSchemaEvidence => {
  if (seen.has(ast)) return "opaque"
  if (SchemaAST.isObjects(ast)) {
    const tag = ast.propertySignatures.find(({ name }) => name === "_tag")?.type
    if (tag === undefined || SchemaAST.isOptional(tag)) return "untagged"
    return propertyKeyEvidence(tag, new Set(seen).add(ast))
  }
  const nextSeen = new Set(seen).add(ast)
  if (SchemaAST.isUnion(ast)) return unionEvidence(ast.types.map((member) => taggedSchemaEvidence(member, nextSeen)))
  if (SchemaAST.isSuspend(ast)) return taggedSchemaEvidence(ast.thunk(), nextSeen)
  // A declaration's decoded Type is intentionally opaque at runtime. Its type
  // parameters describe values contained by the declaration, not its outer
  // shape, so neither they nor private sentinel metadata can prove the public
  // structural TaggedSchema contract without rejecting valid Schema.declare
  // schemas or relying on an undocumented Effect export.
  if (SchemaAST.isDeclaration(ast)) return "opaque"
  return "untagged"
}

/**
 * Rejects schemas whose decoded AST proves they cannot satisfy the structural
 * `_tag: PropertyKey` contract of `Machine.TaggedSchema`. Declarations without
 * sentinel metadata stay opaque: their Type is unavailable at runtime, so
 * rejecting them would reject valid `Schema.declare` schemas. Consequently an
 * unsafe cast or JavaScript caller can pass an opaque untagged declaration;
 * this boundary only promises to reject schemas whose mismatch is provable.
 */
const isTaggedSchema = (value: unknown): value is Schema.Top =>
  Schema.isSchema(value) && taggedSchemaEvidence(SchemaAST.toType(value.ast)) !== "untagged"

const validateStateKey = (
  boundary: StateDefinitionBoundary,
  parent: string,
  key: PropertyKey
): string => {
  const path = displayPath(parent, key)
  if (typeof key === "symbol") {
    return fail(boundary, path, "state keys must be strings, not symbols")
  }
  if (typeof key === "number") {
    return fail(boundary, path, "state keys cannot use numeric forms")
  }
  if (key === "") {
    return fail(boundary, path, "state keys cannot be empty")
  }
  if (key === "__proto__") {
    return fail(boundary, path, "the state key \"__proto__\" is not allowed")
  }
  if (key.includes(".")) {
    return fail(boundary, path, "state keys cannot contain \".\"")
  }
  if (isNumericForm(key)) {
    return fail(boundary, path, "state keys cannot use numeric forms")
  }
  return path
}

const assertPlainRecord: (
  boundary: StateDefinitionBoundary,
  path: string,
  value: unknown,
  description: string
) => asserts value is Readonly<Record<PropertyKey, unknown>> = (boundary, path, value, description) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(boundary, path, `${description} must be a plain record`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail(
      boundary,
      displayPath(path === "<root>" ? "" : path, "__proto__"),
      `${description} must not declare an implicit "__proto__" state key`
    )
  }
}

const assertAllowedProperties = (
  boundary: StateDefinitionBoundary,
  path: string,
  node: Readonly<Record<PropertyKey, unknown>>,
  kind: StateNodeKind
): void => {
  const allowed = StateNodePropertyPolicy[kind] as ReadonlyArray<PropertyKey>
  for (const property of Reflect.ownKeys(node)) {
    if (!allowed.includes(property)) {
      fail(boundary, path, `${kind} states cannot declare property "${String(property)}"`)
    }
  }
}

const validateSchemaLessAnnotations = (
  boundary: StateDefinitionBoundary,
  path: string,
  annotations: unknown
): void => {
  assertPlainRecord(boundary, `${path}.annotations`, annotations, "schema-less state annotations")
  for (const property of Reflect.ownKeys(annotations)) {
    if (!(PseudoStateAnnotationProperties as ReadonlyArray<PropertyKey>).includes(property)) {
      fail(
        boundary,
        `${path}.annotations`,
        `schema-less state annotations cannot declare property "${String(property)}"`
      )
    }
    if (typeof annotations[property] !== "string") {
      fail(boundary, `${path}.annotations.${String(property)}`, "schema-less state annotation values must be strings")
    }
  }
}

const validateStateTree = (
  boundary: StateDefinitionBoundary,
  states: unknown,
  parent: string,
  allowPseudoStates: boolean
): void => {
  const treePath = parent === "" ? "<root>" : parent
  assertPlainRecord(boundary, treePath, states, "state trees")

  for (const key of Reflect.ownKeys(states)) {
    const path = validateStateKey(boundary, parent, key)
    const node = states[key]

    // Effect schemas have their own runtime properties. They are complete
    // atomic node definitions and must be recognized before config validation.
    if (Schema.isSchema(node)) {
      if (!isTaggedSchema(node)) {
        fail(boundary, path, "state schemas must decode to an object with a required PropertyKey _tag")
      }
      continue
    }
    assertPlainRecord(boundary, path, node, "state nodes")

    const type = node.type
    const kind: StateNodeKind = type === "history" ?
      "history"
      : type === "choice" ?
      "choice"
      : type === "parallel" ?
      "parallel"
      : type === "final" ?
      "final"
      : hasOwn(node, "states") ?
      "compound"
      : "atomic"

    assertAllowedProperties(boundary, path, node, kind)

    if (kind === "history" || kind === "choice") {
      if (!allowPseudoStates) {
        fail(boundary, path, `${kind} states must be declared below an active parent state`)
      }
      if (hasOwn(node, "annotations")) {
        validateSchemaLessAnnotations(boundary, path, node.annotations)
      }
      if (kind === "history" && hasOwn(node, "history") && node.history !== "shallow" && node.history !== "deep") {
        fail(boundary, `${path}.history`, "history must be \"shallow\" or \"deep\"")
      }
      continue
    }

    const valued = hasOwn(node, "schema")
    if (valued && !isTaggedSchema(node.schema)) {
      fail(boundary, `${path}.schema`, "state schemas must decode to an object with a required PropertyKey _tag")
    }
    if (valued && hasOwn(node, "annotations")) {
      fail(boundary, `${path}.annotations`, "schema-backed states must declare annotations on their schema")
    }
    if (!valued && hasOwn(node, "annotations")) {
      validateSchemaLessAnnotations(boundary, path, node.annotations)
    }
    if (kind === "atomic" && hasOwn(node, "type") && node.type !== "active") {
      fail(boundary, `${path}.type`, "atomic state type must be \"active\"")
    }
    if (kind === "final" && node.type !== "final") {
      fail(boundary, `${path}.type`, "final state type must be \"final\"")
    }
    if (kind === "compound" && hasOwn(node, "type") && node.type !== "active") {
      fail(boundary, `${path}.type`, "compound state type must be \"active\"")
    }
    if (kind === "parallel" && node.type !== "parallel") {
      fail(boundary, `${path}.type`, "parallel state type must be \"parallel\"")
    }
    if ((kind === "final" || kind === "parallel") && hasOwn(node, "output") && !Schema.isSchema(node.output)) {
      fail(boundary, `${path}.output`, "state output must be an Effect Schema")
    }
    if (kind === "compound") {
      if (typeof node.initial !== "string") {
        fail(boundary, `${path}.initial`, "compound states must declare an initial child key")
      }
      const initialKey = node.initial as string
      validateStateTree(boundary, node.states, path, true)
      if (!hasOwn(node.states as object, initialKey)) {
        fail(boundary, `${path}.initial`, `compound initial child "${initialKey}" does not exist`)
      }
      const initial = (node.states as Readonly<Record<PropertyKey, unknown>>)[initialKey]
      if (
        !Schema.isSchema(initial) && typeof initial === "object" && initial !== null &&
        (initial as Readonly<Record<PropertyKey, unknown>>).type === "history"
      ) {
        fail(boundary, `${path}.initial`, "compound initial children cannot be history states")
      }
      continue
    }
    if (kind === "parallel") {
      if (!hasOwn(node, "states")) {
        fail(boundary, `${path}.states`, "parallel states must declare child regions")
      }
      validateStateTree(boundary, node.states, path, true)
    }
  }
}

export const validateStateDefinitions = (
  states: unknown,
  boundary: StateDefinitionBoundary
): void => validateStateTree(boundary, states, "", false)
