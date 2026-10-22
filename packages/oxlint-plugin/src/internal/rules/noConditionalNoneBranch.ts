import type { ESTree, Rule } from "@oxlint/plugins"
import { resolvedVariable, staticMemberName, unwrapExpression } from "../ast.js"
import {
  isMachineHandleCall,
  isMachineMakeCall,
  type MachineBindings,
  makeMachineBindings,
  recordMachineDefinition,
  recordMachineImport
} from "../imports.js"
import { isPlanningCallback, type PlanningFunction } from "../planning.js"

const propertyKey = (node: ESTree.Node): string | undefined => {
  if (node.type !== "Property" || node.computed) return undefined
  if (node.key.type === "Identifier") return node.key.name
  return node.key.type === "Literal" && typeof node.key.value === "string" ? node.key.value : undefined
}

const findProperty = (
  node: ESTree.ObjectExpression,
  name: string
): ESTree.ObjectProperty | undefined =>
  node.properties.find((property): property is ESTree.ObjectProperty => propertyKey(property) === name)

const isTrueLiteral = (node: ESTree.Node | undefined): boolean => node?.type === "Literal" && node.value === true

/** The `make` configuration that a `.handle(...)` call implements, when it is declared in this module. */
const makeConfiguration = (
  handle: ESTree.CallExpression,
  bindings: MachineBindings
): ESTree.ObjectExpression | undefined => {
  if (handle.callee.type !== "MemberExpression") return undefined
  const callee = unwrapExpression(handle.callee.object)
  let receiver: ESTree.Node | null | undefined = callee
  if (callee.type === "Identifier") {
    const declaration = resolvedVariable(bindings.context, callee)?.identifiers[0]?.parent
    receiver = declaration?.type === "VariableDeclarator" ? declaration.init : undefined
  }
  if (receiver?.type !== "CallExpression" || !isMachineMakeCall(receiver, bindings)) return undefined
  const configuration = receiver.arguments[0]
  return configuration?.type === "ObjectExpression" ? configuration : undefined
}

const enclosingHandleCall = (
  node: ESTree.Node,
  bindings: MachineBindings
): ESTree.CallExpression | undefined => {
  let current: ESTree.Node | null = node.parent
  while (current !== null && current.type !== "Program") {
    if (current.type === "CallExpression" && isMachineHandleCall(current, bindings)) return current
    current = current.parent
  }
  return undefined
}

/** Keys of the branches declared as `{ none: true }` in one named group. */
const noneBranches = (
  configuration: ESTree.ObjectExpression,
  group: string
): ReadonlySet<string> => {
  const keys = new Set<string>()
  const groups = findProperty(configuration, "branches")?.value
  if (groups?.type !== "ObjectExpression") return keys
  const branches = findProperty(groups, group)?.value
  if (branches?.type !== "ObjectExpression") return keys
  for (const branch of branches.properties) {
    const key = propertyKey(branch)
    if (
      key !== undefined && branch.type === "Property" && branch.value.type === "ObjectExpression" &&
      isTrueLiteral(findProperty(branch.value, "none")?.value)
    ) keys.add(key)
  }
  return keys
}

interface Selectors {
  /** Identifiers bound to the whole `select` object, or to the resolver context. */
  readonly select: ReadonlySet<ESTree.Node>
  readonly context: ReadonlySet<ESTree.Node>
  /** Identifiers bound to one destructured selector, by branch key. */
  readonly aliases: ReadonlyMap<ESTree.Node, string>
}

const resolverSelectors = (callback: PlanningFunction): Selectors | undefined => {
  const parameter = callback.params[0]
  if (parameter?.type === "Identifier") {
    return { select: new Set(), context: new Set([parameter]), aliases: new Map() }
  }
  if (parameter?.type !== "ObjectPattern") return undefined
  const selectProperty = parameter.properties.find((property): property is ESTree.BindingProperty =>
    property.type === "Property" && propertyKey(property) === "select"
  )
  const value = selectProperty?.value
  if (value?.type === "Identifier") {
    return { select: new Set([value]), context: new Set(), aliases: new Map() }
  }
  if (value?.type !== "ObjectPattern") return undefined
  const aliases = new Map<ESTree.Node, string>()
  for (const property of value.properties) {
    const key = property.type === "Property" ? propertyKey(property) : undefined
    if (key !== undefined && property.type === "Property" && property.value.type === "Identifier") {
      aliases.set(property.value, key)
    }
  }
  return { select: new Set(), context: new Set(), aliases }
}

const bindsTo = (
  node: ESTree.Expression,
  declarations: ReadonlySet<ESTree.Node> | ReadonlyMap<ESTree.Node, string>,
  bindings: MachineBindings
): ESTree.Node | undefined =>
  node.type === "Identifier"
    ? resolvedVariable(bindings.context, node)?.identifiers.find((identifier) => declarations.has(identifier))
    : undefined

/** The branch key selected by a returned selector call such as `select.key()` or `alias.from()`. */
const selectedBranch = (
  node: ESTree.Expression,
  selectors: Selectors,
  bindings: MachineBindings
): string | undefined => {
  let current = unwrapExpression(node)
  if (current.type !== "CallExpression") return undefined
  while (current.type === "CallExpression" || current.type === "MemberExpression") {
    if (current.type === "MemberExpression") {
      const object = unwrapExpression(current.object)
      if (bindsTo(object, selectors.select, bindings) !== undefined) return staticMemberName(current)
      if (
        object.type === "MemberExpression" && staticMemberName(object) === "select" &&
        bindsTo(unwrapExpression(object.object), selectors.context, bindings) !== undefined
      ) return staticMemberName(current)
    }
    current = unwrapExpression(current.type === "CallExpression" ? current.callee : current.object)
  }
  const alias = bindsTo(current, selectors.aliases, bindings)
  return alias === undefined ? undefined : selectors.aliases.get(alias)
}

interface Outcome {
  readonly expression: ESTree.Expression
  /** Whether a condition decides if this expression becomes the result. */
  readonly conditional: boolean
}

const expressionOutcomes = (
  node: ESTree.Expression,
  conditional: boolean,
  outcomes: Array<Outcome>
): void => {
  const expression = unwrapExpression(node)
  if (expression.type === "ConditionalExpression") {
    expressionOutcomes(expression.consequent, true, outcomes)
    expressionOutcomes(expression.alternate, true, outcomes)
  } else if (expression.type === "LogicalExpression") {
    expressionOutcomes(expression.left, true, outcomes)
    expressionOutcomes(expression.right, true, outcomes)
  } else if (expression.type === "SequenceExpression") {
    const last = expression.expressions.at(-1)
    if (last !== undefined) expressionOutcomes(last, conditional, outcomes)
  } else {
    outcomes.push({ expression, conditional })
  }
}

const statementOutcomes = (
  node: ESTree.Node,
  conditional: boolean,
  outcomes: Array<Outcome>
): void => {
  if (node.type === "ReturnStatement") {
    if (node.argument !== null) expressionOutcomes(node.argument, conditional, outcomes)
    return
  }
  if (node.type === "BlockStatement") {
    for (const statement of node.body) statementOutcomes(statement, conditional, outcomes)
    return
  }
  if (node.type === "IfStatement") {
    statementOutcomes(node.consequent, true, outcomes)
    if (node.alternate !== null) statementOutcomes(node.alternate, true, outcomes)
    return
  }
  if (node.type === "SwitchStatement") {
    for (const branch of node.cases) {
      for (const statement of branch.consequent) statementOutcomes(statement, true, outcomes)
    }
    return
  }
  if (node.type === "TryStatement") {
    statementOutcomes(node.block, true, outcomes)
    if (node.handler !== null) statementOutcomes(node.handler.body, true, outcomes)
    if (node.finalizer !== null) statementOutcomes(node.finalizer, true, outcomes)
    return
  }
  if (
    node.type === "LabeledStatement" || node.type === "ForStatement" || node.type === "ForInStatement" ||
    node.type === "ForOfStatement" || node.type === "WhileStatement" || node.type === "DoWhileStatement"
  ) {
    statementOutcomes(node.body, true, outcomes)
  }
}

/** Every expression the resolver can return, excluding nested functions. */
const resolverOutcomes = (callback: PlanningFunction): ReadonlyArray<Outcome> => {
  const outcomes: Array<Outcome> = []
  if (callback.body === null) return outcomes
  if (callback.body.type === "BlockStatement") statementOutcomes(callback.body, false, outcomes)
  else expressionOutcomes(callback.body, false, outcomes)
  return outcomes
}

export const noConditionalNoneBranch: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require declinable resolvers when a none branch is selected conditionally.",
      recommended: true
    },
    schema: [],
    messages: {
      conditionalNoneBranch:
        "A conditionally selected `none` branch still accepts the event for `Machine.can`; declare `declinable: true` and return `decline()` when the event must be refused."
    }
  },
  create(context) {
    const bindings = makeMachineBindings(context)
    return {
      ImportDeclaration: (node) => recordMachineImport(bindings, node),
      Property(node) {
        if (propertyKey(node) !== "resolve" || node.parent.type !== "ObjectExpression") return
        const callback = node.value
        if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") return
        const transition = node.parent
        const group = findProperty(transition, "branches")?.value
        if (group?.type !== "Literal" || typeof group.value !== "string") return
        const declinable = findProperty(transition, "declinable")
        if (declinable !== undefined && (isTrueLiteral(declinable.value) || declinable.value.type !== "Literal")) {
          return
        }
        if (!isPlanningCallback(callback, bindings)) return

        const handle = enclosingHandleCall(transition, bindings)
        const configuration = handle === undefined ? undefined : makeConfiguration(handle, bindings)
        if (configuration === undefined) return
        const none = noneBranches(configuration, group.value)
        if (none.size === 0) return
        const selectors = resolverSelectors(callback)
        if (selectors === undefined) return

        const outcomes = resolverOutcomes(callback)
        for (const outcome of outcomes) {
          if (!outcome.conditional && outcomes.length === 1) continue
          const branch = selectedBranch(outcome.expression, selectors, bindings)
          if (branch !== undefined && none.has(branch)) {
            context.report({ node: outcome.expression, messageId: "conditionalNoneBranch" })
          }
        }
      },
      VariableDeclarator: (node) => recordMachineDefinition(bindings, node)
    }
  }
}
