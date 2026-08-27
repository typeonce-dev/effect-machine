import type { ESTree, Rule } from "@oxlint/plugins"
import { nondeterministicOperation, nondeterministicProperty } from "../ambient.js"
import { hasMachineImport, makeMachineBindings, recordMachineDefinition, recordMachineImport } from "../imports.js"
import { enclosingPlanningCallback } from "../planning.js"

export const noNondeterministicPlanning: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Keep ambient time and randomness out of Effect Machine planning.",
      recommended: true
    },
    schema: [],
    messages: {
      nondeterministic:
        "{{operation}} produces a different result without a machine event or state change. Pass the value through machine input or an event, or produce it in a state-owned invocation and transition from its outcome."
    }
  },
  create(context) {
    const bindings = makeMachineBindings()
    const report = (
      node: ESTree.CallExpression | ESTree.MemberExpression | ESTree.NewExpression,
      operation: string | undefined
    ): void => {
      if (
        operation !== undefined &&
        hasMachineImport(bindings) &&
        enclosingPlanningCallback(node, bindings) !== undefined
      ) context.report({ node, messageId: "nondeterministic", data: { operation } })
    }
    return {
      ImportDeclaration: (node) => recordMachineImport(bindings, node),
      CallExpression: (node) => report(node, nondeterministicOperation(context, node)),
      MemberExpression: (node) => report(node, nondeterministicProperty(context, node)),
      NewExpression: (node) => report(node, nondeterministicOperation(context, node)),
      VariableDeclarator: (node) => recordMachineDefinition(bindings, node)
    }
  }
}
