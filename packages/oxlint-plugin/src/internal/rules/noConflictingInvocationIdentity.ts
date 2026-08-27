import type { Context, ESTree, Rule, Variable } from "@oxlint/plugins"
import { resolvedVariable, unwrapExpression } from "../ast.js"
import {
  hasMachineImport,
  isMachineMemberCall,
  type MachineBindings,
  makeMachineBindings,
  recordMachineDefinition,
  recordMachineImport,
  staticMemberName
} from "../imports.js"
import { isInvokePlanningCallback, type PlanningFunction } from "../planning.js"

interface Identity {
  readonly key: string
  readonly label: string
  readonly node: ESTree.Expression
}

interface InvocationIdentity {
  readonly address?: Identity
  readonly lifecycle: Identity
}

const completionMethods = new Set(["onDone", "onElement", "onFailure", "onSnapshot"])
const sourceMethods = new Set(["effect", "logic", "stream", "timer"])

const variableKey = (variable: Variable): string | undefined => {
  const identifier = variable.identifiers[0]
  return identifier === undefined ? undefined : `binding:${identifier.range[0]}:${identifier.range[1]}`
}

const isStableVariable = (variable: Variable): boolean =>
  variable.defs.some((definition) =>
    definition.type === "ImportBinding" ||
    (definition.type === "Variable" &&
      definition.node.type === "VariableDeclarator" &&
      definition.node.parent.type === "VariableDeclaration" &&
      definition.node.parent.kind === "const")
  )

const constInitializer = (
  variable: Variable
): ESTree.Expression | undefined => {
  const definition = variable.defs.find((candidate) => candidate.type === "Variable")
  const declaration = definition?.node
  if (
    declaration?.type !== "VariableDeclarator" ||
    declaration.parent.type !== "VariableDeclaration" ||
    declaration.parent.kind !== "const" ||
    declaration.init === null
  ) return undefined
  return declaration.init
}

const staticIdentity = (
  context: Context,
  node: ESTree.Expression,
  bindings: MachineBindings,
  seen: Set<string> = new Set()
): Identity | undefined => {
  const expression = unwrapExpression(node)
  if (
    expression.type === "Literal" &&
    (typeof expression.value === "string" || typeof expression.value === "number")
  ) {
    return {
      key: `value:${String(expression.value)}`,
      label: JSON.stringify(expression.value),
      node: expression
    }
  }
  if (expression.type === "TemplateLiteral" && expression.expressions.length === 0) {
    const value = expression.quasis[0]?.value.cooked
    return value === null || value === undefined
      ? undefined
      : { key: `value:${value}`, label: JSON.stringify(value), node: expression }
  }
  if (expression.type === "Identifier") {
    const variable = resolvedVariable(context, expression)
    if (variable === undefined || !isStableVariable(variable)) return undefined
    const key = variableKey(variable)
    if (key === undefined || seen.has(key)) return undefined
    const initializer = constInitializer(variable)
    if (initializer !== undefined) {
      const nextSeen = new Set(seen)
      nextSeen.add(key)
      const initialized = staticIdentity(context, initializer, bindings, nextSeen)
      if (initialized !== undefined) return { ...initialized, node: expression }
    }
    return { key, label: expression.name, node: expression }
  }
  if (
    isMachineMemberCall(expression, "childAddress", bindings)
  ) {
    const argument = expression.arguments[0]
    if (expression.arguments.length === 1 && argument !== undefined && argument.type !== "SpreadElement") {
      return staticIdentity(context, argument, bindings, seen)
    }
  }
  return undefined
}

const descriptorIdentity = (
  context: Context,
  node: ESTree.Expression,
  bindings: MachineBindings,
  seen: Set<string> = new Set()
): Identity | undefined => {
  const expression = unwrapExpression(node)
  if (expression.type === "Identifier") {
    const variable = resolvedVariable(context, expression)
    if (variable === undefined || !isStableVariable(variable)) return undefined
    const key = variableKey(variable)
    if (key === undefined || seen.has(key)) return undefined
    const initializer = constInitializer(variable)
    if (initializer !== undefined) {
      const nextSeen = new Set(seen)
      nextSeen.add(key)
      const initialized = descriptorIdentity(context, initializer, bindings, nextSeen)
      if (initialized !== undefined) return { ...initialized, node: expression }
    }
    return { key: `descriptor:${key}`, label: expression.name, node: expression }
  }
  if (
    isMachineMemberCall(expression, "child", bindings)
  ) {
    const argument = expression.arguments[0]
    if (argument !== undefined && argument.type !== "SpreadElement") {
      return staticIdentity(context, argument, bindings)
    }
  }
  return undefined
}

const objectProperty = (
  object: ESTree.ObjectExpression,
  name: string
): ESTree.Expression | undefined => {
  for (const property of object.properties) {
    if (property.type !== "Property" || property.kind !== "init") continue
    const propertyName = property.computed
      ? property.key.type === "Literal" && typeof property.key.value === "string"
        ? property.key.value
        : undefined
      : property.key.type === "Identifier" || property.key.type === "Literal"
      ? String(property.key.type === "Identifier" ? property.key.name : property.key.value)
      : undefined
    if (propertyName === name) return property.value
  }
  return undefined
}

const resolvedObject = (
  context: Context,
  node: ESTree.Expression,
  seen: Set<string> = new Set()
): ESTree.ObjectExpression | undefined => {
  const expression = unwrapExpression(node)
  if (expression.type === "ObjectExpression") return expression
  if (expression.type !== "Identifier") return undefined
  const variable = resolvedVariable(context, expression)
  if (variable === undefined) return undefined
  const key = variableKey(variable)
  if (key === undefined || seen.has(key)) return undefined
  const initializer = constInitializer(variable)
  if (initializer === undefined) return undefined
  const nextSeen = new Set(seen)
  nextSeen.add(key)
  return resolvedObject(context, initializer, nextSeen)
}

const sourceCall = (
  node: ESTree.Expression
): ESTree.CallExpression | undefined => {
  let expression = unwrapExpression(node)
  while (
    expression.type === "CallExpression" &&
    expression.callee.type === "MemberExpression" &&
    completionMethods.has(staticMemberName(expression.callee) ?? "")
  ) expression = unwrapExpression(expression.callee.object)
  return expression.type === "CallExpression" ? expression : undefined
}

const invocationIdentity = (
  context: Context,
  node: ESTree.Expression,
  from: string,
  bindings: MachineBindings
): InvocationIdentity | undefined => {
  const call = sourceCall(node)
  if (
    call?.callee.type !== "MemberExpression" ||
    call.callee.object.type !== "Identifier" ||
    call.callee.object.name !== from
  ) return undefined
  const method = staticMemberName(call.callee)
  if (method === "child") {
    const child = call.arguments[0]
    if (child === undefined || child.type === "SpreadElement") return undefined
    const identity = descriptorIdentity(context, child, bindings)
    return identity === undefined ? undefined : { lifecycle: identity, address: identity }
  }
  if (method === undefined || !sourceMethods.has(method)) return undefined
  const id = call.arguments[0]
  if (id === undefined || id.type === "SpreadElement") return undefined
  const lifecycle = staticIdentity(context, id, bindings)
  if (lifecycle === undefined) return undefined
  if (method !== "logic") return { lifecycle }
  const options = call.arguments[1]
  if (options === undefined || options.type === "SpreadElement") return { lifecycle }
  const object = resolvedObject(context, options)
  const addressNode = object === undefined ? undefined : objectProperty(object, "address")
  const address = addressNode === undefined
    ? undefined
    : staticIdentity(context, addressNode, bindings)
  return address === undefined ? { lifecycle } : { lifecycle, address }
}

const returnedExpression = (
  node: PlanningFunction
): ESTree.Expression | undefined => {
  if (node.body === null) return undefined
  if (node.body.type !== "BlockStatement") return node.body
  const returns = node.body.body.filter((statement) => statement.type === "ReturnStatement")
  if (returns.length !== 1) return undefined
  return returns[0]!.argument ?? undefined
}

const returnedEntries = (
  context: Context,
  node: PlanningFunction
): ReadonlyArray<ESTree.Expression> => {
  const returned = returnedExpression(node)
  if (returned === undefined) return []
  const array = resolvedObjectOrArray(context, returned)
  if (array?.type !== "ArrayExpression") return [returned]
  return array.elements.filter((entry): entry is ESTree.Expression => entry !== null && entry.type !== "SpreadElement")
}

const resolvedObjectOrArray = (
  context: Context,
  node: ESTree.Expression,
  seen: Set<string> = new Set()
): ESTree.ObjectExpression | ESTree.ArrayExpression | undefined => {
  const expression = unwrapExpression(node)
  if (expression.type === "ObjectExpression" || expression.type === "ArrayExpression") return expression
  if (expression.type !== "Identifier") return undefined
  const variable = resolvedVariable(context, expression)
  if (variable === undefined) return undefined
  const key = variableKey(variable)
  if (key === undefined || seen.has(key)) return undefined
  const initializer = constInitializer(variable)
  if (initializer === undefined) return undefined
  const nextSeen = new Set(seen)
  nextSeen.add(key)
  return resolvedObjectOrArray(context, initializer, nextSeen)
}

const resolvedEntry = (
  context: Context,
  node: ESTree.Expression
): ESTree.Expression => {
  const expression = unwrapExpression(node)
  if (expression.type !== "Identifier") return expression
  const variable = resolvedVariable(context, expression)
  const initializer = variable === undefined ? undefined : constInitializer(variable)
  return initializer === undefined ? expression : unwrapExpression(initializer)
}

export const noConflictingInvocationIdentity: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require unique invocation lifecycle IDs and runtime addresses within a state.",
      recommended: true
    },
    schema: [],
    messages: {
      conflictingAddress:
        "Invocation runtime address {{identity}} is reused in this state. Concurrent children cannot own the same address. Give each from.logic(...) invocation a distinct Machine.childAddress(...), or put sequential work in separate states.",
      conflictingBoth:
        "Invocation identity {{identity}} is reused as both lifecycle ID and runtime address in this state. Outcomes become ambiguous and overlapping starts fail. Give each invocation a unique ID/address, or put sequential work in separate states.",
      conflictingLifecycle:
        "Invocation lifecycle ID {{identity}} is reused in this state. Outcomes are routed by state path and ID, so duplicate IDs are ambiguous and overlapping starts fail. Give each invocation a unique ID, or put sequential work in separate states."
    }
  },
  create(context) {
    const bindings = makeMachineBindings()
    const inspect = (node: PlanningFunction): void => {
      if (!hasMachineImport(bindings) || !isInvokePlanningCallback(node, bindings)) return
      const parameter = node.params[0]
      if (parameter?.type !== "Identifier") return
      const lifecycle = new Map<string, number>()
      const addresses = new Map<string, number>()
      const entries = returnedEntries(context, node)
      entries.forEach((entry, index) => {
        const identity = invocationIdentity(context, resolvedEntry(context, entry), parameter.name, bindings)
        if (identity === undefined) return
        const lifecycleConflict = lifecycle.get(identity.lifecycle.key)
        const addressConflict = identity.address === undefined
          ? undefined
          : addresses.get(identity.address.key)
        if (
          lifecycleConflict !== undefined &&
          addressConflict !== undefined &&
          lifecycleConflict === addressConflict
        ) {
          context.report({
            node: identity.lifecycle.node,
            messageId: "conflictingBoth",
            data: { identity: identity.lifecycle.label }
          })
        } else {
          if (lifecycleConflict !== undefined) {
            context.report({
              node: identity.lifecycle.node,
              messageId: "conflictingLifecycle",
              data: { identity: identity.lifecycle.label }
            })
          }
          if (addressConflict !== undefined && identity.address !== undefined) {
            context.report({
              node: identity.address.node,
              messageId: "conflictingAddress",
              data: { identity: identity.address.label }
            })
          }
        }
        if (!lifecycle.has(identity.lifecycle.key)) lifecycle.set(identity.lifecycle.key, index)
        if (identity.address !== undefined && !addresses.has(identity.address.key)) {
          addresses.set(identity.address.key, index)
        }
      })
    }
    return {
      ImportDeclaration: (node) => recordMachineImport(bindings, node),
      VariableDeclarator: (node) => recordMachineDefinition(bindings, node),
      ArrowFunctionExpression: inspect,
      FunctionExpression: inspect
    }
  }
}
