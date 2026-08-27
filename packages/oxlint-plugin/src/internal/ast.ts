import type { Context, ESTree, Scope, Variable } from "@oxlint/plugins"
import { staticMemberName } from "./imports.js"

export const unwrapExpression = (node: ESTree.Expression): ESTree.Expression => {
  let current = node
  while (
    current.type === "ChainExpression" ||
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSTypeAssertion"
  ) current = current.expression
  return current
}

const referenceIn = (
  scope: Scope,
  node: ESTree.IdentifierReference
) =>
  scope.references.find((reference) => reference.identifier === node) ??
    scope.through.find((reference) => reference.identifier === node)

export const resolvedVariable = (
  context: Context,
  node: ESTree.IdentifierReference
): Variable | undefined => {
  let scope: Scope | null = context.sourceCode.getScope(node)
  while (scope !== null) {
    const reference = referenceIn(scope, node)
    if (reference !== undefined) return reference.resolved ?? undefined
    scope = scope.upper
  }
  return undefined
}

export const isUnshadowedGlobal = (
  context: Context,
  node: ESTree.Expression,
  name: string
): node is ESTree.IdentifierReference => {
  const expression = unwrapExpression(node)
  if (expression.type !== "Identifier" || expression.name !== name) return false
  if (context.sourceCode.isGlobalReference(expression)) return true

  let scope: Scope | null = context.sourceCode.getScope(expression)
  while (scope !== null) {
    const reference = referenceIn(scope, expression)
    if (reference !== undefined) return reference.resolved === null
    scope = scope.upper
  }
  return false
}

export const globalPath = (
  context: Context,
  node: ESTree.Expression
): ReadonlyArray<string> | undefined => {
  const expression = unwrapExpression(node)
  if (expression.type === "Identifier") {
    return isUnshadowedGlobal(context, expression, expression.name)
      ? [expression.name]
      : undefined
  }
  if (expression.type !== "MemberExpression") return undefined

  const member = staticMemberName(expression)
  if (member === undefined) return undefined
  const owner = globalPath(context, expression.object)
  return owner === undefined ? undefined : [...owner, member]
}

const ambientQualifiers = new Set(["globalThis", "self", "window"])

export const canonicalGlobalPath = (
  context: Context,
  node: ESTree.Expression
): ReadonlyArray<string> | undefined => {
  const path = globalPath(context, node)
  return path !== undefined && path.length > 1 && ambientQualifiers.has(path[0]!)
    ? path.slice(1)
    : path
}
