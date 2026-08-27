import type { ESTree, Rule } from "@oxlint/plugins"
import { asyncOperation } from "../ambient.js"
import { hasMachineImport, makeMachineBindings, recordMachineDefinition, recordMachineImport } from "../imports.js"
import { enclosingPlanningCallback, isPlanningCallback, type PlanningFunction } from "../planning.js"

export const noAsyncPlanningCallback: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Keep Effect Machine planning callbacks synchronous.",
      recommended: true
    },
    schema: [],
    messages: {
      asyncOperation:
        "{{operation}} starts asynchronous work during synchronous planning. Move it into the owning state's invoke declaration using from.effect(...), from.stream(...), or from.timer(...), then handle completion or failure with onDone/onFailure.",
      asyncPlanning:
        "Planning callbacks must be synchronous. Remove async and move the asynchronous work into the owning state's invoke declaration, then transition from onDone/onFailure."
    }
  },
  create(context) {
    const bindings = makeMachineBindings()
    const inspect = (node: PlanningFunction): void => {
      if (
        hasMachineImport(bindings) &&
        node.async &&
        isPlanningCallback(node, bindings)
      ) {
        context.report({ node, messageId: "asyncPlanning" })
      }
    }
    const inspectOperation = (
      node: ESTree.CallExpression | ESTree.NewExpression
    ): void => {
      if (!hasMachineImport(bindings)) return
      const callback = enclosingPlanningCallback(node, bindings)
      if (callback === undefined || callback.async) return
      const operation = asyncOperation(context, node)
      if (operation !== undefined) {
        context.report({ node, messageId: "asyncOperation", data: { operation } })
      }
    }
    return {
      ImportDeclaration: (node) => recordMachineImport(bindings, node),
      VariableDeclarator: (node) => recordMachineDefinition(bindings, node),
      ArrowFunctionExpression: inspect,
      FunctionExpression: inspect,
      CallExpression: inspectOperation,
      NewExpression: inspectOperation
    }
  }
}
