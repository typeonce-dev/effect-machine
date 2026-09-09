import * as Schema from "effect/Schema"
import type { Machine, State } from "../../Machine.js"

/** Reference metadata is separate from child names, including names such as `path`. */
export const TypeId: unique symbol = Symbol.for("effect/Machine/TargetReference")

export interface Reference {
  readonly [TypeId]: {
    readonly root: State<Machine.StateNodeConfig>
    readonly path: string
    readonly kind: "state" | "choice" | "history"
  }
}

/** Captures an immutable reference tree without allocating or executing a machine. */
export const make = (root: State<Machine.StateNodeConfig>): { readonly root: Reference } => {
  const nodes: Array<{ path: string; key: string; parent: string | undefined; type: string }> = []
  const visit = (
    node: Machine.StateNodeConfig | Machine.TaggedSchema,
    path: string,
    key: string,
    parent: string | undefined
  ): void => {
    const type = !Schema.isSchema(node) && "type" in node ? node.type ?? "active" : "active"
    nodes.push({ path, key, parent, type })
    if (!Schema.isSchema(node) && "states" in node) {
      for (const [childKey, child] of Object.entries(node.states)) {
        visit(child, path === "" ? childKey : `${path}.${childKey}`, childKey, path)
      }
    }
  }
  visit(root.node, "", "", undefined)
  const references = new Map<string, Reference>()
  for (const node of nodes) {
    const reference = Object.create(null)
    Object.defineProperty(reference, TypeId, {
      value: Object.freeze({
        root,
        path: node.path,
        kind: node.type === "history" || node.type === "choice" ? node.type : "state"
      })
    })
    references.set(node.path, reference)
  }
  for (const node of nodes) {
    if (node.parent !== undefined) {
      Object.defineProperty(references.get(node.parent), node.key, {
        value: references.get(node.path),
        enumerable: true
      })
    }
  }
  for (const reference of references.values()) Object.freeze(reference)
  return Object.freeze({ root: references.get("")! })
}
