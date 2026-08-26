import type { Rule } from "@oxlint/plugins"
import { hasMachineImport, makeMachineBindings, recordMachineDefinition, recordMachineImport } from "../imports.js"
import { isPlanningCallback, type PlanningFunction } from "../planning.js"

export const noAsyncPlanningCallback: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Keep Effect Machine planning callbacks synchronous.",
      recommended: true
    },
    schema: [],
    messages: {
      asyncPlanning: "Planning callbacks must be synchronous. Move asynchronous work into state-owned invocation."
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
    return {
      ImportDeclaration: (node) => recordMachineImport(bindings, node),
      VariableDeclarator: (node) => recordMachineDefinition(bindings, node),
      ArrowFunctionExpression: inspect,
      FunctionExpression: inspect
    }
  }
}
