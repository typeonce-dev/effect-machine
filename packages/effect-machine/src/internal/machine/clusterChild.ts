/**
 * Child machines that run as Cluster entities of their own.
 *
 * A state that invokes a child machine starts it as an entity whose type is
 * derived from the parent's type and the child's id, and whose id is derived
 * from the parent's id, the child's id, and the revision of the step that
 * entered the state. Each activation of the state has a child of its own, so a
 * child knows nothing of the one before it, and a message of a child that ended
 * names an activation the parent no longer runs.
 *
 * Everything between a parent and its child is a persisted request saved in the
 * transaction of a checkpoint: the parent starts and stops the child, and sends
 * to it, and the child tells the parent that it ended and sends to it.
 *
 * @since 0.48.0
 */
import { ClusterSchema } from "effect/cluster"
import { Rpc } from "effect/rpc"
import * as Schema from "effect/Schema"
import type { ChildMachine } from "../../Machine.js"
import * as CapturedInvocation from "./capturedInvocation.js"

/** @internal */
export const entityTypeOf = (parentType: string, childId: string): string => `${parentType}/${childId}`

/** @internal */
export const entityIdOf = (parentEntityId: string, childId: string, revision: number): string =>
  `${parentEntityId}/${childId}/${revision}`

/**
 * The entity id of the parent of a child entity, or `undefined` when the id is
 * not one that `entityIdOf` made for this child.
 *
 * @internal
 */
export const parentEntityIdOf = (entityId: string, childId: string): string | undefined => {
  const last = entityId.lastIndexOf("/")
  if (last < 0 || !/^\d+$/.test(entityId.slice(last + 1))) return undefined
  const head = entityId.slice(0, last)
  const suffix = `/${childId}`
  return head.endsWith(suffix) && head.length > suffix.length ? head.slice(0, -suffix.length) : undefined
}

/**
 * The child machines that the states of a machine invoke, by their ids.
 *
 * @internal
 */
export const childrenOf = (
  handlers: Readonly<Record<string, { readonly invoke?: unknown } | undefined>>
): ReadonlyMap<string, ChildMachine.Any> => {
  const children = new Map<string, ChildMachine.Any>()
  for (const path of Object.keys(handlers)) {
    for (const definition of CapturedInvocation.list(handlers[path]?.invoke)) {
      if ("child" in definition) children.set(definition.child.id, definition.child)
    }
  }
  return children
}

/**
 * The ids of the child machines that an invocation of a machine takes the
 * snapshots of. Only such a child sends them.
 *
 * @internal
 */
export const snapshotsOf = (
  handlers: Readonly<Record<string, { readonly invoke?: unknown } | undefined>>
): ReadonlySet<string> => {
  const ids = new Set<string>()
  for (const path of Object.keys(handlers)) {
    for (const definition of CapturedInvocation.list(handlers[path]?.invoke)) {
      if ("child" in definition && definition.onSnapshot !== undefined) ids.add(definition.child.id)
    }
  }
  return ids
}

/**
 * Starts a child with its input. A child that has started already ignores it.
 *
 * @internal
 */
export const makeStartRpc = <Input extends Schema.Top>(input: Input) =>
  Rpc.make("start", { payload: { input } }).annotate(ClusterSchema.Persisted, true)

/**
 * Stops a child, which then rejects every later request.
 *
 * @internal
 */
export const StopRpc = Rpc.make("stop").annotate(ClusterSchema.Persisted, true)

/**
 * Tells a parent that its child `entityId` ended, which the parent reads from
 * `Storage`.
 *
 * @internal
 */
export const EndedRpc = Rpc.make("ended", { payload: { entityId: Schema.String } })
  .annotate(ClusterSchema.Persisted, true)

/**
 * Gives a parent the encoded snapshot of its child `entityId` after a step that
 * changed it.
 *
 * @internal
 */
export const SnapshotRpc = Rpc.make("snapshot", { payload: { entityId: Schema.String, snapshot: Schema.Unknown } })
  .annotate(ClusterSchema.Persisted, true)
