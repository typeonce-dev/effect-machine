import type { Context, ESTree } from "@oxlint/plugins"

import { resolvedVariable, staticMemberName } from "./ast.js"

const effectMachineModule = "@typeonce/effect-machine"

export interface MachineBindings {
  readonly context: Context
  readonly definitions: Set<ESTree.Node>
  readonly machine: Set<ESTree.Node>
  readonly namespaces: Set<ESTree.Node>
}

export const makeMachineBindings = (context: Context): MachineBindings => ({
  context,
  definitions: new Set(),
  machine: new Set(),
  namespaces: new Set()
})

const moduleExportName = (node: ESTree.ModuleExportName): string => node.type === "Identifier" ? node.name : node.value

export const recordMachineImport = (
  bindings: MachineBindings,
  node: ESTree.ImportDeclaration
): void => {
  if (node.source.value !== effectMachineModule) return

  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportNamespaceSpecifier") {
      bindings.namespaces.add(specifier.local)
    } else if (
      specifier.type === "ImportSpecifier" &&
      moduleExportName(specifier.imported) === "Machine"
    ) {
      bindings.machine.add(specifier.local)
    }
  }
}

export const hasMachineImport = (bindings: MachineBindings): boolean =>
  bindings.machine.size > 0 || bindings.namespaces.size > 0

const matchesBinding = (
  node: ESTree.IdentifierReference,
  declarations: ReadonlySet<ESTree.Node>,
  bindings: MachineBindings
): boolean =>
  resolvedVariable(bindings.context, node)?.identifiers.some((identifier) => declarations.has(identifier)) === true

const isNamespaceMachine = (
  node: ESTree.Node,
  bindings: MachineBindings
): boolean =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  matchesBinding(node.object, bindings.namespaces, bindings) &&
  node.property.type === "Identifier" &&
  node.property.name === "Machine"

const isMachineReference = (
  node: ESTree.Expression,
  bindings: MachineBindings
): boolean =>
  node.type === "Identifier"
    ? matchesBinding(node, bindings.machine, bindings)
    : isNamespaceMachine(node, bindings)

export const isMachineMemberCall = (
  node: ESTree.Node,
  member: string,
  bindings: MachineBindings
): node is ESTree.CallExpression =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  staticMemberName(node.callee) === member &&
  isMachineReference(node.callee.object, bindings)

export const isMachineMakeCall = (
  node: ESTree.CallExpression,
  bindings: MachineBindings
): boolean => {
  if (
    node.callee.type !== "MemberExpression" ||
    staticMemberName(node.callee) !== "make"
  ) return false

  return isMachineReference(node.callee.object, bindings)
}

export const recordMachineDefinition = (
  bindings: MachineBindings,
  node: ESTree.VariableDeclarator
): void => {
  if (
    node.id.type === "Identifier" &&
    node.init?.type === "CallExpression" &&
    isMachineMakeCall(node.init, bindings)
  ) bindings.definitions.add(node.id)
}

export const isMachineHandleCall = (
  node: ESTree.CallExpression,
  bindings: MachineBindings
): boolean => {
  if (
    node.callee.type !== "MemberExpression" ||
    staticMemberName(node.callee) !== "handle"
  ) return false

  const receiver = node.callee.object
  return receiver.type === "CallExpression"
    ? isMachineMakeCall(receiver, bindings)
    : receiver.type === "Identifier" && matchesBinding(receiver, bindings.definitions, bindings)
}

export const isMemberCall = (
  node: ESTree.Node,
  member: string
): node is ESTree.CallExpression =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  staticMemberName(node.callee) === member
