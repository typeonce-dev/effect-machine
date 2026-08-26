import type { ESTree } from "@oxlint/plugins"

const effectMachineModule = "@typeonce/effect-machine"

export interface MachineBindings {
  readonly definitions: Set<string>
  readonly machine: Set<string>
  readonly namespaces: Set<string>
}

export const makeMachineBindings = (): MachineBindings => ({
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
      bindings.namespaces.add(specifier.local.name)
    } else if (
      specifier.type === "ImportSpecifier" &&
      moduleExportName(specifier.imported) === "Machine"
    ) {
      bindings.machine.add(specifier.local.name)
    }
  }
}

export const hasMachineImport = (bindings: MachineBindings): boolean =>
  bindings.machine.size > 0 || bindings.namespaces.size > 0

export const staticMemberName = (node: ESTree.Node): string | undefined =>
  node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier"
    ? node.property.name
    : undefined

const isNamespaceMachine = (
  node: ESTree.Node,
  bindings: MachineBindings
): boolean =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  bindings.namespaces.has(node.object.name) &&
  node.property.type === "Identifier" &&
  node.property.name === "Machine"

export const isMachineMakeCall = (
  node: ESTree.CallExpression,
  bindings: MachineBindings
): boolean => {
  if (
    node.callee.type !== "MemberExpression" ||
    staticMemberName(node.callee) !== "make"
  ) return false

  const receiver = node.callee.object
  return receiver.type === "Identifier"
    ? bindings.machine.has(receiver.name)
    : isNamespaceMachine(receiver, bindings)
}

export const recordMachineDefinition = (
  bindings: MachineBindings,
  node: ESTree.VariableDeclarator
): void => {
  if (
    node.id.type === "Identifier" &&
    node.init?.type === "CallExpression" &&
    isMachineMakeCall(node.init, bindings)
  ) bindings.definitions.add(node.id.name)
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
    : receiver.type === "Identifier" && bindings.definitions.has(receiver.name)
}

export const isMemberCall = (
  node: ESTree.Node,
  member: string
): node is ESTree.CallExpression =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  staticMemberName(node.callee) === member
