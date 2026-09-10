/** Converts public construction objects into owned planner instructions. */
import type { Machine } from "../../Machine.js"
import * as Topology from "./topology.js"

export const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Machine construction must be an object")
  }
  return value as Readonly<Record<string, unknown>>
}

const nodeValue = (node: Machine.StateNode, config: Readonly<Record<string, unknown>>): unknown => {
  if (config.decoded !== undefined && typeof config.decoded !== "boolean") {
    throw new Error("Machine decoded construction flag must be a boolean")
  }
  if (node.schema === undefined) {
    if (Object.hasOwn(config, "data") || Object.hasOwn(config, "decoded")) {
      throw new Error(`Machine structural state "${node.path}" cannot construct data`)
    }
    return undefined
  }
  if (config.decoded === true) {
    if (!Object.hasOwn(config, "data")) throw new Error("Machine decoded construction requires data")
    return config.data
  }
  return Topology.makeStateInput(Object.hasOwn(config, "data") ? config.data : {})
}

export const target = (
  nodes: Machine.StateNodes,
  path: string,
  raw: unknown = {},
  source?: string
): unknown => {
  const selectedNode = nodes.byPath.get(path)
  if (selectedNode?.type === "atomic" || selectedNode?.type === "final") {
    const config = record(raw)
    if (Reflect.ownKeys(config).some((key) => key !== "data" && key !== "decoded")) {
      throw new Error("Machine leaf construction accepts only data and decoded")
    }
    return Topology.makeTarget(path, nodeValue(selectedNode, config) as { readonly _tag: PropertyKey })
  }
  const children = new Map<string, unknown>()
  const visit = (path: string, raw: unknown): unknown => {
    const config = record(raw)
    if (Reflect.ownKeys(config).some((key) => key !== "data" && key !== "decoded" && key !== "states")) {
      throw new Error("Machine state construction accepts only data, decoded, and states")
    }
    const node = nodes.byPath.get(path)
    if (node === undefined || node.type === "history") throw new Error(`Machine invalid construction state "${path}"`)
    const value = nodeValue(node, config)
    if (Object.hasOwn(config, "states")) {
      if (node.type !== "compound" && node.type !== "parallel") {
        throw new Error(`Machine state "${path}" has no child construction`)
      }
      const states = record(config.states)
      const keys = Reflect.ownKeys(states)
      const active = node.children.filter((child) => nodes.byPath.get(child)?.type !== "history")
      if (
        node.type === "compound"
          ? keys.length !== 1
          : keys.length !== active.length &&
            !(keys.length === 1 && source !== undefined && (source === path || source.startsWith(`${path}.`)))
      ) {
        throw new Error(
          `Machine explicit states for "${path}" must select ${node.type === "compound" ? "one child" : "every region"}`
        )
      }
      for (const key of keys) {
        const child = path === "" ? String(key) : `${path}.${String(key)}`
        if (
          typeof key !== "string" ||
          !(nodes.byPath.get(child)?.parent === path && nodes.byPath.get(child)?.type !== "history")
        ) throw new Error(`Machine unknown child "${String(key)}"`)
        children.set(child, visit(child, states[key]))
      }
    }
    return value
  }
  const value = visit(path, raw)
  const values = new Map(children)
  values.set(path, value)
  let selected = path
  let config = record(raw)
  while (config.states !== undefined) {
    const node = nodes.byPath.get(selected)!
    const states = record(config.states)
    const keys = Object.keys(states)
    if (
      keys.length !== 1 ||
      (node.type === "parallel" &&
        !(source !== undefined && (source === selected || source.startsWith(`${selected}.`))))
    ) break
    const key = keys[0]!
    selected = selected === "" ? key : `${selected}.${key}`
    config = record(states[key])
  }
  const node = nodes.byPath.get(selected)!
  const selectedValue = values.get(selected)
  const ancestors = Object.fromEntries(
    [...values].filter(([p, v]) => v !== undefined && p !== selected && !p.startsWith(`${selected}.`))
  )
  if (node.type === "choice") return Topology.makeChoiceTarget(selected, node.parent ?? "", ancestors)
  if (node.type === "atomic" || node.type === "final") {
    return Topology.makeTarget(selected, selectedValue as { readonly _tag: PropertyKey }, {
      values: ancestors as Readonly<Record<string, { readonly _tag: PropertyKey }>>
    })
  }
  const descendants = new Map([...children].filter(([p]) => p.startsWith(`${selected}.`)))
  return {
    ...Topology.makeInitialTarget(selected, selectedValue, ancestors),
    ...(descendants.size === 0 ? {} : { children: descendants })
  }
}

export const update = (nodes: Machine.StateNodes, path: string, raw: unknown): Topology.StateUpdate => {
  const config = record(raw)
  if (Reflect.ownKeys(config).some((key) => key !== "data" && key !== "decoded")) {
    throw new Error("Machine update construction accepts only data and decoded")
  }
  const node = nodes.byPath.get(path)
  if (node?.schema === undefined) throw new Error("Machine update requires a valued state")
  return Topology.makeStateUpdate(path, nodeValue(node, config))
}

/** History fallbacks construct a complete tree, including the history owner. */
export const snapshot = (nodes: Machine.StateNodes, raw: unknown, path = ""): unknown => {
  const config = record(raw)
  const node = nodes.byPath.get(path)!
  target(nodes, path, config)
  const value = nodeValue(node, config)
  if (node.type === "choice") return Topology.makeChoiceTarget(path, node.parent!)
  if (node.type === "atomic" || node.type === "final") return { path, value }
  if (config.states === undefined) {
    throw new Error("Machine history fallback requires a complete explicit tree")
  }
  const states = record(config.states)
  const children = Object.fromEntries(
    Object.entries(states).map(([key, child]) => [
      key,
      snapshot(nodes, child, path === "" ? key : `${path}.${key}`)
    ])
  )
  return node.type === "parallel" ?
    { path, value, states: children }
    : { path, value, state: Object.values(children)[0] }
}
