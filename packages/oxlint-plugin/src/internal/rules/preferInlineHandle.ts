import type { Context, ESTree, Rule, Variable } from "@oxlint/plugins"
import {
  hasMachineImport,
  isMachineMakeCall,
  isMemberCall,
  makeMachineBindings,
  recordMachineDefinition,
  recordMachineImport
} from "../imports.js"

interface Candidate {
  readonly declaration: ESTree.VariableDeclarator
  readonly name: ESTree.BindingIdentifier
}

const isTopLevelPrivateDeclaration = (node: ESTree.VariableDeclarator): boolean =>
  node.parent.type === "VariableDeclaration" && node.parent.parent.type === "Program"

const declaredVariable = (
  context: Context,
  candidate: Candidate
): Variable | undefined =>
  context.sourceCode.getDeclaredVariables(candidate.declaration)
    .find((variable) => variable.name === candidate.name.name)

const isOnlyHandleReference = (variable: Variable): boolean => {
  const references = variable.references.filter((reference) => reference.isRead())
  if (references.length !== 1) return false

  const identifier = references[0]?.identifier
  if (identifier?.parent.type !== "MemberExpression") return false
  const member = identifier.parent
  if (member.object !== identifier || !isMemberCall(member.parent, "handle")) return false
  return member.parent.callee === member
}

export const preferInlineHandle: Rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Chain handle directly from one-use Machine.make definitions.",
      recommended: true
    },
    schema: [],
    messages: {
      inlineHandle:
        "Chain .handle(...) directly from Machine.make(...). This one-use definition adds no reusable model."
    }
  },
  create(context) {
    const bindings = makeMachineBindings()
    const candidates: Array<Candidate> = []
    return {
      ImportDeclaration: (node) => recordMachineImport(bindings, node),
      VariableDeclarator(node) {
        recordMachineDefinition(bindings, node)
        if (
          !hasMachineImport(bindings) ||
          node.id.type !== "Identifier" ||
          node.init?.type !== "CallExpression" ||
          !isTopLevelPrivateDeclaration(node) ||
          !isMachineMakeCall(node.init, bindings)
        ) return
        candidates.push({ declaration: node, name: node.id })
      },
      "Program:exit"() {
        for (const candidate of candidates) {
          const variable = declaredVariable(context, candidate)
          if (variable !== undefined && isOnlyHandleReference(variable)) {
            context.report({ node: candidate.name, messageId: "inlineHandle" })
          }
        }
      }
    }
  }
}
