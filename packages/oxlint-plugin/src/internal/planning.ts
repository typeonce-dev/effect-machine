import type { ESTree } from "@oxlint/plugins"
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
  "invoke"
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
      isEventHandlerProperty(property, bindings)
}

const enclosingFunction = (node: ESTree.Node): PlanningFunction | undefined => {
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

export const isPlanningCallback = (
  node: PlanningFunction,
  bindings: MachineBindings
): boolean => {
  if (isPropertyPlanningCallback(node, bindings)) return true

  const parent = node.parent
  if (parent.type === "CallExpression" && parent.arguments.includes(node)) {
    const method = parent.callee.type === "MemberExpression"
      ? staticMemberName(parent.callee)
      : undefined
    if (method !== undefined && directPlanningMethods.has(method)) {
      const owner = enclosingFunction(parent)
      return owner !== undefined && isPlanningCallback(owner, bindings)
    }
  }
  return false
}
