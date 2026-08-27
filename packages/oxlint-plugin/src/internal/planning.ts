import type { ESTree } from "@oxlint/plugins"
import { unwrapExpression } from "./ast.js"
import { isMachineHandleCall, isMachineMakeCall, type MachineBindings, staticMemberName } from "./imports.js"

export type PlanningFunction = ESTree.ArrowFunctionExpression | ESTree.Function

const directPlanningMethods = new Set([
  "onDone",
  "onElement",
  "onFailure",
  "onSnapshot",
  "resolve"
])

const statePlanningProperties = new Set([
  "always",
  "choice",
  "entry",
  "exit",
  "initialize",
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

const isMachineMakeConfig = (
  node: ESTree.ObjectExpression,
  bindings: MachineBindings
): boolean => isCallArgument(node, (call) => isMachineMakeCall(call, bindings))

const isMachineHandleConfig = (
  node: ESTree.ObjectExpression,
  bindings: MachineBindings
): boolean => isCallArgument(node, (call) => isMachineHandleCall(call, bindings))

const isStateConfig = (
  node: ESTree.ObjectExpression,
  bindings: MachineBindings
): boolean => {
  if (node.parent.type !== "Property" || node.parent.parent.type !== "ObjectExpression") {
    return false
  }

  const stateCollection = node.parent.parent
  if (isMachineHandleConfig(stateCollection, bindings)) return true
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
  return name === "initial"
    ? isMachineMakeConfig(property.parent, bindings)
    : (name !== undefined && statePlanningProperties.has(name) && isStateConfig(property.parent, bindings)) ||
      isEventHandlerProperty(property, bindings) ||
      isHistoryDefaultProperty(property, bindings)
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

const selectorRoot = (node: ESTree.Expression): string | undefined => {
  let expression = unwrapExpression(node)
  while (expression.type === "CallExpression" || expression.type === "MemberExpression") {
    expression = unwrapExpression(
      expression.type === "CallExpression"
        ? expression.callee
        : expression.object
    )
  }
  return expression.type === "Identifier" ? expression.name : undefined
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
      return owner !== undefined &&
        selector?.type === "Identifier" &&
        selectorRoot(parent.callee.object) === selector.name &&
        isPlanningCallback(owner, bindings)
    }
  }
  return false
}
