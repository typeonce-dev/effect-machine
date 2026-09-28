/** Captures handler-owned initial edges before compiling executable topology. */
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
import type { Machine } from "../../Machine.js"
import { SnapshotBuilderStateTypeId } from "./symbols.js"
import * as Topology from "./topology.js"

const initializers = new WeakSet<object>()

export const isDataInitializer = (value: object): boolean => initializers.has(value)

type Context = Readonly<Record<string, unknown>>
type Constructor = (context: Context) => unknown
const record = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Machine ${label} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}
const evaluate = (value: unknown): Constructor => typeof value === "function" ? value as Constructor : () => value

/** Only the outer declaration is interpreted; callback results are ordinary data. */
export const construction = (value: unknown): Constructor => {
  const descriptor = typeof value === "object" && value !== null &&
    hasProperty(value, "decoded") && value.decoded === true && hasProperty(value, "data")
  if (descriptor) {
    const config = record(value, "decoded construction")
    if (Reflect.ownKeys(config).some((key) => key !== "decoded" && key !== "data")) {
      throw new Error("Machine decoded construction accepts only decoded and data")
    }
    return evaluate(config.data)
  }
  const resolve = evaluate(value)
  return (context) => Topology.makeStateInput(value === undefined ? {} : resolve(context))
}

export const edgeConstruction = (config: Readonly<Record<string, unknown>>): Constructor => {
  if (config.decoded !== undefined && typeof config.decoded !== "boolean") {
    throw new Error("Machine decoded construction flag must be a boolean")
  }
  if (config.decoded === true) {
    if (!hasProperty(config, "data")) throw new Error("Machine decoded construction requires data")
    return evaluate(config.data)
  }
  const resolve = evaluate(config.data)
  return (context) => Topology.makeStateInput(hasProperty(config, "data") ? resolve(context) : {})
}

interface Captured {
  readonly node: Machine.StateNodeConfig | Machine.TaggedSchema
  readonly handlers: Record<string, unknown>
}
export const capture = (
  root: Machine.Any["root"],
  handler: Readonly<Record<string, unknown>>
): Captured => {
  const visit = (
    node: Machine.StateNodeConfig | Machine.TaggedSchema,
    raw: Readonly<Record<string, unknown>>,
    path: string
  ): Captured => {
    if (hasProperty(raw, "initialize")) throw new Error("Machine child construction belongs in initial declarations")
    if (path !== "" && hasProperty(raw, "root")) {
      throw new Error("Machine root construction belongs at the root handler")
    }
    const { initial, root: _root, states: rawChildren, ...handlers } = raw
    if (Schema.isSchema(node) || !("states" in node)) {
      if (initial !== undefined) throw new Error(`Machine state "${path}" cannot declare initial children`)
      if (rawChildren !== undefined) throw new Error(`Machine state "${path}" has no children`)
      return { node, handlers }
    }
    const childHandlers = rawChildren === undefined ? {} : record(rawChildren, "child handlers")
    for (const key of Object.keys(childHandlers)) {
      if (!Object.prototype.hasOwnProperty.call(node.states, key)) throw new Error(`Machine unknown child "${key}"`)
    }
    const states: Record<string, Machine.StateNodeConfig | Machine.TaggedSchema> = Object.create(null)
    const children: Record<string, unknown> = Object.create(null)
    const constructors: Record<string, Constructor> = Object.create(null)
    const parallel = node.type === "parallel"
    let initialKey: string | undefined
    if (parallel) {
      const regions = initial === undefined ? {} : record(initial, "parallel initial regions")
      for (const [key, value] of Object.entries(regions)) {
        const child = node.states[key]
        if (child === undefined || (!Schema.isSchema(child) && (child.type === "history" || child.type === "choice"))) {
          throw new Error(`Machine invalid initial region "${key}"`)
        }
        if (!Schema.isSchema(child) && (!("schema" in child) || child.schema === undefined)) {
          throw new Error(`Machine schema-less region "${key}" cannot construct data`)
        }
        constructors[key] = construction(value)
      }
    } else {
      const edge = record(initial, `initial edge for "${path}"`)
      if (Reflect.ownKeys(edge).some((key) => !["target", "data", "decoded"].includes(String(key)))) {
        throw new Error("Machine initial edge accepts only target, data, and decoded")
      }
      const prefix = path === "" ? "" : `${path}.`
      const key = typeof edge.target === "string" && edge.target.startsWith(prefix)
        ? edge.target.slice(prefix.length)
        : undefined
      const selected = key === undefined || !Object.hasOwn(node.states, key) ? undefined : node.states[key]!
      const kind = selected === undefined || Schema.isSchema(selected) ? "state" : selected.type
      if (key === undefined || selected === undefined || kind === "history") {
        throw new Error(`Machine initial target must be a direct child of "${path === "" ? "root" : path}"`)
      }
      initialKey = key
      if (kind === "choice" && (hasProperty(edge, "data") || hasProperty(edge, "decoded"))) {
        throw new Error("Machine choice initial edges cannot construct data")
      }
      const construct = edgeConstruction(edge)
      const child = node.states[key]!
      if (
        hasProperty(edge, "data") && !Schema.isSchema(child) && (!("schema" in child) || child.schema === undefined)
      ) {
        throw new Error(`Machine schema-less initial child "${key}" cannot construct data`)
      }
      if (hasProperty(edge, "data")) constructors[key] = construct
    }
    for (const [key, child] of Object.entries(node.states)) {
      const childPath = path === "" ? key : `${path}.${key}`
      const captured = visit(
        child,
        childHandlers[key] === undefined ? {} : record(childHandlers[key], "state handler"),
        childPath
      )
      states[key] = captured.node
      // History configuration is owned by its parent, not a state handler.
      if (
        (Schema.isSchema(child) || child.type !== "history") &&
        (childHandlers[key] !== undefined || (!Schema.isSchema(child) && "states" in child))
      ) children[key] = captured.handlers
    }
    const compiled = Object.freeze({
      ...node,
      states: Object.freeze(states),
      ...(parallel ? {} : { initial: initialKey })
    })
    const entries = Object.entries(constructors)
    const initialize = (context: Context) => {
      const ancestors = typeof context.ancestors === "object" && context.ancestors !== null
        ? context.ancestors as Readonly<Record<string, unknown>> :
        {}
      const scoped = { ...context, root: path === "" ? context.state : ancestors[""] }
      const values = Object.fromEntries(entries.map(([key, construct]) => [key, construct(scoped)]))
      return { [SnapshotBuilderStateTypeId]: values }
    }
    initializers.add(initialize)
    return {
      node: compiled,
      handlers: { ...handlers, ...(entries.length === 0 ? {} : { initialize }), states: children }
    }
  }
  return visit(root.node, handler, "")
}
