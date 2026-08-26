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
      redundantResolver: "Remove this resolver. The selected target already applies default construction."
    }
  },
  create(context) {
    const bindings = makeMachineBindings()
    return {
      ImportDeclaration: (node) => recordMachineImport(bindings, node),
      CallExpression(node) {
        if (
          !hasMachineImport(bindings) ||
          node.arguments.length !== 1 ||
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

        const binding = targetBinding(callback)
        if (
          binding === undefined ||
          !isDefaultTargetConstruction(returnedExpression(callback), binding)
        ) return

        const receiver = node.callee.object
        if (context.sourceCode.getCommentsInside(node).length === 0) {
          context.report({
            node,
            messageId: "redundantResolver",
            fix: (fixer) => fixer.replaceText(node, context.sourceCode.getText(receiver))
          })
        } else {
          context.report({ node, messageId: "redundantResolver" })
        }
      },
      VariableDeclarator: (node) => recordMachineDefinition(bindings, node)
    }
  }
}
