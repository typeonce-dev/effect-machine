import type { ESTree } from "@oxlint/plugins"
import { resolvedVariable, staticMemberName } from "./ast.js"
import { unwrapExpression } from "./ast.js"
import { isMachineHandleCall, type MachineBindings } from "./imports.js"

export type PlanningFunction = ESTree.ArrowFunctionExpression | ESTree.Function

const directPlanningMethods = new Set([
  "onDone",
  "onElement",
  "onFailure",
  "onSnapshot",
  "resolve",
  "from",
  "decoded",
  "guard"
])

const statePlanningProperties = new Set([
  "always",
  "choice",
  "entry",
  "exit",
  "root",
  "invoke",
  "onDone",
  "output"
])

const propertyName = (node: ESTree.Node): string | undefined => {
  if (node.type !== "Property" || node.computed) return undefined
  return node.key.type === "Identifier" || node.key.type === "Literal"
    ? String(node.key.type === "Identifier" ? node.key.name : node.key.value)
    : undefined
}

const isCallArgument = (
  node: ESTree.ObjectExpression,
  predicate: (call: ESTree.CallExpression) => boolean
): boolean =>
  node.parent.type === "CallExpression" &&
  node.parent.arguments.includes(node) &&
  predicate(node.parent)

const isMachineHandleConfig = (
  node: ESTree.ObjectExpression,
  bindings: MachineBindings
): boolean => isCallArgument(node, (call) => isMachineHandleCall(call, bindings))

const isStateConfig = (
  node: ESTree.ObjectExpression,
  bindings: MachineBindings
): boolean => {
  if (isMachineHandleConfig(node, bindings)) return true
  if (node.parent.type !== "Property" || node.parent.parent.type !== "ObjectExpression") {
    return false
  }

  const stateCollection = node.parent.parent
  if (
    stateCollection.parent.type !== "Property" ||
    propertyName(stateCollection.parent) !== "states" ||
    stateCollection.parent.parent.type !== "ObjectExpression"
  ) return false
  return isStateConfig(stateCollection.parent.parent, bindings)
}

const isEventHandlerProperty = (
  node: ESTree.Node,
  bindings: MachineBindings
): boolean => {
  if (node.type !== "Property" || node.parent.type !== "ObjectExpression") return false
  const onProperty = node.parent.parent
  return onProperty.type === "Property" &&
    propertyName(onProperty) === "on" &&
    onProperty.parent.type === "ObjectExpression" &&
    isStateConfig(onProperty.parent, bindings)
}

const isHistoryDefaultProperty = (
  node: ESTree.Node,
  bindings: MachineBindings
): boolean => {
  if (node.type !== "Property" || propertyName(node) !== "default") return false
  const historyEntry = node.parent
  if (
    historyEntry.type !== "ObjectExpression" ||
    historyEntry.parent.type !== "Property" ||
    historyEntry.parent.parent.type !== "ObjectExpression"
  ) return false
  const historyEntries = historyEntry.parent.parent
  if (
    historyEntries.parent.type !== "Property" ||
    propertyName(historyEntries.parent) !== "history" ||
    historyEntries.parent.parent.type !== "ObjectExpression"
  ) return false
  return isStateConfig(historyEntries.parent.parent, bindings)
}

export const isInvokeProperty = (node: ESTree.Node, bindings: MachineBindings): boolean =>
  node.type === "Property" && propertyName(node) === "invoke" && node.parent.type === "ObjectExpression" &&
  isStateConfig(node.parent, bindings)

const isInvocationConfig = (node: ESTree.ObjectExpression, bindings: MachineBindings): boolean =>
  isInvokeProperty(node.parent, bindings) ||
  (node.parent.type === "ArrayExpression" && isInvokeProperty(node.parent.parent, bindings))

const isTransitionConfig = (node: ESTree.ObjectExpression, bindings: MachineBindings): boolean => {
  const property = node.parent
  if (isEventHandlerProperty(property, bindings)) return true
  if (property.type !== "Property" || property.parent.type !== "ObjectExpression") return false
  const name = propertyName(property)
  return name !== undefined && (
    (["always", "choice", "onDone"].includes(name) && isStateConfig(property.parent, bindings)) ||
    (["onDone", "onFailure", "onElement", "onSnapshot"].includes(name) && isInvocationConfig(property.parent, bindings))
  )
}

const isPropertyPlanningCallback = (
  node: PlanningFunction,
  bindings: MachineBindings
): boolean => {
  const property = node.parent
  if (
    property.type !== "Property" ||
    property.value !== node ||
    property.parent.type !== "ObjectExpression"
  ) return false

  const name = propertyName(property)
  if (
    name !== undefined && ["resolve", "data", "guard"].includes(name) &&
    isTransitionConfig(property.parent, bindings)
  ) return true
  if (name === "input" && isInvocationConfig(property.parent, bindings)) return true
  const owner = property.parent.parent
  if (
    owner.type === "Property" && propertyName(owner) === "initial" && owner.parent.type === "ObjectExpression" &&
    isStateConfig(owner.parent, bindings)
  ) return true
  if (name === "data" && owner.type === "Property" && owner.parent.type === "ObjectExpression") {
    if (propertyName(owner) === "root" && isMachineHandleConfig(owner.parent, bindings)) return true
    const initial = owner.parent.parent
    if (
      initial.type === "Property" && propertyName(initial) === "initial" &&
      initial.parent.type === "ObjectExpression" && isStateConfig(initial.parent, bindings)
    ) return true
  }
  return (name !== undefined && statePlanningProperties.has(name) && isStateConfig(property.parent, bindings)) ||
    isEventHandlerProperty(property, bindings) || isHistoryDefaultProperty(property, bindings)
}

export const enclosingFunction = (node: ESTree.Node): PlanningFunction | undefined => {
  let current: ESTree.Node | null = node.parent
  while (current !== null && current.type !== "Program") {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression"
    ) return current
    current = current.parent
  }
  return undefined
}

const selectorRoot = (node: ESTree.Expression): ESTree.IdentifierReference | undefined => {
  let expression = unwrapExpression(node)
  while (expression.type === "CallExpression" || expression.type === "MemberExpression") {
    expression = unwrapExpression(
      expression.type === "CallExpression"
        ? expression.callee
        : expression.object
    )
  }
  return expression.type === "Identifier" ? expression : undefined
}

export const enclosingPlanningCallback = (
  node: ESTree.Node,
  bindings: MachineBindings
): PlanningFunction | undefined => {
  const callback = enclosingFunction(node)
  return callback !== undefined && isPlanningCallback(callback, bindings)
    ? callback
    : undefined
}

export const isInvokePlanningCallback = (
  node: PlanningFunction,
  bindings: MachineBindings
): boolean => {
  const property = node.parent
  return property.type === "Property" &&
    property.value === node &&
    propertyName(property) === "invoke" &&
    property.parent.type === "ObjectExpression" &&
    isStateConfig(property.parent, bindings)
}

export const isPlanningCallback = (
  node: PlanningFunction,
  bindings: MachineBindings
): boolean => {
  if (isPropertyPlanningCallback(node, bindings)) return true

  const parent = node.parent
  if (parent.type === "CallExpression" && parent.arguments.includes(node)) {
    if (parent.callee.type !== "MemberExpression") return false
    const method = staticMemberName(parent.callee)
    if (method !== undefined && directPlanningMethods.has(method)) {
      const owner = enclosingFunction(parent)
      const selector = owner?.params[0]
      const root = selectorRoot(parent.callee.object)
      return owner !== undefined &&
        selector?.type === "Identifier" &&
        root !== undefined &&
        resolvedVariable(bindings.context, root)?.identifiers.includes(selector) === true &&
        isPlanningCallback(owner, bindings)
    }
  }
  return false
}
