import type { ESTree, Rule } from "@oxlint/plugins"
import { browserApi } from "../ambient.js"
import { hasMachineImport, makeMachineBindings, recordMachineDefinition, recordMachineImport } from "../imports.js"
import { enclosingPlanningCallback } from "../planning.js"

const isOutermostAccess = (node: ESTree.Expression): boolean => {
  const parent = node.parent
  if (parent.type === "MemberExpression" && parent.object === node) return false
  if (
    (parent.type === "CallExpression" || parent.type === "NewExpression") &&
    parent.callee === node
  ) return false
  return true
}

export const noBrowserApiInPlanning: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Keep browser state and side effects out of Effect Machine planning.",
      recommended: true
    },
    schema: [],
    messages: {
      browserApi:
        "{{api}} reads browser state or performs a browser side effect during synchronous planning. If it affects the workflow, run it in a state-owned invocation and transition from its outcome. If it only affects presentation, keep it in the UI adapter."
    }
  },
  create(context) {
    const bindings = makeMachineBindings()
    const inspect = (node: ESTree.Expression): void => {
      if (
        !hasMachineImport(bindings) ||
        !isOutermostAccess(node) ||
        enclosingPlanningCallback(node, bindings) === undefined
      ) return
      const api = browserApi(context, node)
      if (api !== undefined) context.report({ node, messageId: "browserApi", data: { api } })
    }
    const inspectOperation = (node: ESTree.CallExpression | ESTree.NewExpression): void => {
      if (
        !hasMachineImport(bindings) ||
        enclosingPlanningCallback(node, bindings) === undefined
      ) return
      const api = browserApi(context, node.callee)
      if (api !== undefined) context.report({ node, messageId: "browserApi", data: { api } })
    }
    return {
      ImportDeclaration: (node) => recordMachineImport(bindings, node),
      Identifier: (node) => inspect(node as ESTree.IdentifierReference),
      MemberExpression: inspect,
      CallExpression: inspectOperation,
      NewExpression: inspectOperation,
      VariableDeclarator: (node) => recordMachineDefinition(bindings, node)
    }
  }
}
