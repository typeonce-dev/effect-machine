/** Internal builders for schema-valued default state entry. */

import { hasProperty } from "effect/Predicate"
import type { Machine } from "../../Machine.js"
import { SnapshotBuilderStateTypeId } from "./symbols.js"
import * as Topology from "./topology.js"

const getNode = (machine: Machine.Any, path: string): Machine.StateNode => {
  const node = machine.stateNodes.byPath.get(path)
  if (node === undefined) {
    throw new Error(`Machine expected state path "${path}" to exist`)
  }
  return node
}

const withFrom = <Method extends (value: unknown) => unknown>(method: Method) => {
  Object.defineProperty(method, "from", {
    value: (...args: ReadonlyArray<unknown>) => method(Topology.makeStateInput(args.length === 0 ? {} : args[0])),
    enumerable: false
  })
  return method as Method & { readonly from: (...args: ReadonlyArray<unknown>) => unknown }
}

const makeCompletion = (values: Readonly<Record<string, unknown>>): object => {
  const completion = {}
  Object.defineProperty(completion, SnapshotBuilderStateTypeId, {
    value: values,
    enumerable: false
  })
  return completion
}

const makeParallelBuilder = (
  machine: Machine.Any,
  node: Machine.StateNode,
  values: Readonly<Record<string, unknown>>
): object => {
  const builder = makeCompletion(values) as Record<string | symbol, unknown>
  for (const childPath of node.children) {
    const child = getNode(machine, childPath)
    if (child.schema === undefined || hasProperty(values, child.key)) continue
    builder[child.key] = withFrom((value: unknown) => {
      const nextValues: Record<string, unknown> = Object.assign({}, values)
      nextValues[child.key] = value
      return makeParallelBuilder(machine, node, nextValues)
    })
  }
  return builder
}

export const makeStateInitializeBuilder = (machine: Machine.Any, path: string): object => {
  const node = getNode(machine, path)
  if (node.type === "parallel") {
    return makeParallelBuilder(machine, node, {})
  }
  if (node.type !== "compound") {
    throw new Error(`Machine state "${path}" cannot initialize child states`)
  }
  const child = getNode(machine, node.initial)
  if (child.schema === undefined) {
    throw new Error(`Machine state "${path}" has no schema-valued initial child`)
  }
  return withFrom((value: unknown) => makeCompletion({ [child.key]: value }))
}

export const getStateInitializeValues = (path: string, result: unknown): Readonly<Record<string, unknown>> => {
  if (typeof result !== "object" || result === null || !hasProperty(result, SnapshotBuilderStateTypeId)) {
    throw new Error(`Machine initialize handler for "${path}" must return its builder result`)
  }
  return (result as { readonly [SnapshotBuilderStateTypeId]: Readonly<Record<string, unknown>> })[
    SnapshotBuilderStateTypeId
  ]
}
