import type { ESTree, Rule } from "@oxlint/plugins"
import {
  hasMachineImport,
  makeMachineBindings,
  recordMachineDefinition,
  recordMachineImport,
  staticMemberName
} from "../imports.js"
import { isPlanningCallback } from "../planning.js"

const returnedExpression = (
  node: ESTree.ArrowFunctionExpression | ESTree.Function
): ESTree.Expression | null | undefined => {
  if (node.body === null) return undefined
  if (node.body.type !== "BlockStatement") return node.body
  if (node.body.body.length !== 1 || node.body.body[0]?.type !== "ReturnStatement") {
    return undefined
  }
  return node.body.body[0].argument
}

const targetBinding = (
  node: ESTree.ArrowFunctionExpression | ESTree.Function
): string | undefined => {
  if (node.params.length !== 1) return undefined
  const parameter = node.params[0]
  if (parameter?.type !== "ObjectPattern" || parameter.properties.length !== 1) {
    return undefined
  }
  const property = parameter.properties[0]
  if (
    property?.type !== "Property" ||
    property.computed ||
    property.key.type !== "Identifier" ||
    property.key.name !== "target" ||
    property.value.type !== "Identifier"
  ) return undefined
  return property.value.name
}

const isDefaultTargetConstruction = (
  node: ESTree.Expression | null | undefined,
  binding: string
): boolean =>
  node?.type === "CallExpression" &&
  node.arguments.length === 0 &&
  node.callee.type === "MemberExpression" &&
  staticMemberName(node.callee) === "from" &&
  node.callee.object.type === "Identifier" &&
  node.callee.object.name === binding

const isEmptyResolver = (
  node: ESTree.ArrowFunctionExpression | ESTree.Function
): boolean => node.body?.type === "BlockStatement" && node.body.body.length === 0

const isTargetlessReceiver = (node: ESTree.Expression): boolean =>
  node.type === "MemberExpression" && staticMemberName(node) === "none"

const isReenterOnlyOptions = (node: ESTree.Expression | undefined): boolean => {
  if (node?.type !== "ObjectExpression" || node.properties.length !== 1) return false
  const property = node.properties[0]
  return property?.type === "Property" &&
    !property.computed &&
    property.key.type === "Identifier" &&
    property.key.name === "reenter" &&
    property.value.type === "Literal" &&
    property.value.value === true
}

export const noRedundantResolve: Rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Remove resolvers that only apply default target construction.",
      recommended: true
    },
    fixable: "code",
    schema: [],
    messages: {
      redundantResolver:
        "Remove this resolver. The selected target already applies default construction, so use the target selector directly.",
      redundantReenterResolver:
        "Replace this resolver with .reenter(). It applies the same default construction while explicitly reentering the selected state.",
      redundantTargetlessResolver:
        "Remove this empty resolver. A targetless transition performs the same work as to.none; use to.none directly."
    }
  },
  create(context) {
    const bindings = makeMachineBindings()
    return {
      ImportDeclaration: (node) => recordMachineImport(bindings, node),
      CallExpression(node) {
        if (
          !hasMachineImport(bindings) ||
          (node.arguments.length !== 1 && node.arguments.length !== 2) ||
          node.callee.type !== "MemberExpression" ||
          staticMemberName(node.callee) !== "resolve"
        ) return

        const callback = node.arguments[0]
        if (
          callback?.type !== "ArrowFunctionExpression" &&
          callback?.type !== "FunctionExpression"
        ) return
        if (callback.async || callback.generator) return
        if (!isPlanningCallback(callback, bindings)) return

        const receiver = node.callee.object
        const binding = targetBinding(callback)
        const defaultConstruction = binding !== undefined &&
          isDefaultTargetConstruction(returnedExpression(callback), binding)
        const targetless = isTargetlessReceiver(receiver) && isEmptyResolver(callback)
        if (!defaultConstruction && !targetless) return

        const options = node.arguments[1]
        if (options?.type === "SpreadElement") return
        const reenter = options === undefined ? false : isReenterOnlyOptions(options)
        if (options !== undefined && !reenter) return

        const messageId = reenter
          ? "redundantReenterResolver"
          : targetless
          ? "redundantTargetlessResolver"
          : "redundantResolver"
        const replacement = `${context.sourceCode.getText(receiver)}${reenter ? ".reenter()" : ""}`
        context.report({
          node,
          messageId,
          ...(context.sourceCode.getCommentsInside(node).length === 0
            ? { fix: (fixer) => fixer.replaceText(node, replacement) }
            : undefined)
        })
      },
      VariableDeclarator: (node) => recordMachineDefinition(bindings, node)
    }
  }
}
