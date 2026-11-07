import type { ESTree, Rule } from "@oxlint/plugins"
import { resolvedVariable, staticMemberName, unwrapExpression } from "../ast.js"
import { type MachineBindings, makeMachineBindings, recordMachineDefinition, recordMachineImport } from "../imports.js"
import { isEventHandlerProperty, isPlanningCallback, type PlanningFunction } from "../planning.js"

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

/** Whether a branch list declares `key: true`, or `undefined` when an entry cannot be read statically. */
const declares = (branches: ESTree.ArrayExpression, key: string): boolean | undefined => {
  let found = false
  for (const entry of branches.elements) {
    if (entry?.type !== "ObjectExpression") return undefined
    if (isTrueLiteral(findProperty(entry, key)?.value)) found = true
  }
  return found
}

interface Selectors {
  /** Identifiers bound to the whole `select` object, or to the resolver context. */
  readonly select: ReadonlySet<ESTree.Node>
  readonly context: ReadonlySet<ESTree.Node>
  /** Identifiers bound to one destructured `select` method, by method name. */
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

/** The method selected by a returned call such as `select.stay()` or a destructured `stay()`. */
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

export const noConditionalStayBranch: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require a decline entry when a stay branch is selected conditionally.",
      recommended: true
    },
    schema: [],
    messages: {
      conditionalStayBranch:
        "A conditionally selected `stay` branch still accepts the event for `Machine.can`; add `{ decline: true }` to branches and return `select.decline()` when the event must be refused."
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
        const branches = findProperty(transition, "branches")?.value
        if (branches?.type !== "ArrayExpression") return
        if (declares(branches, "stay") !== true || declares(branches, "decline") !== false) return
        if (!isEventHandlerProperty(transition.parent, bindings) || !isPlanningCallback(callback, bindings)) return
        const selectors = resolverSelectors(callback)
        if (selectors === undefined) return

        const outcomes = resolverOutcomes(callback)
        for (const outcome of outcomes) {
          if (!outcome.conditional && outcomes.length === 1) continue
          if (selectedBranch(outcome.expression, selectors, bindings) === "stay") {
            context.report({ node: outcome.expression, messageId: "conditionalStayBranch" })
          }
        }
      },
      VariableDeclarator: (node) => recordMachineDefinition(bindings, node)
    }
  }
}
