/**
 * Private mailbox messages used to route invocation lifecycle changes through
 * the owning machine planner.
 *
 * @since 0.9.0
 */

/** @internal */
export const InvocationEventTypeId: unique symbol = Symbol("effect/Machine/InvocationEvent")

/** @internal */
export type InvocationEvent =
  | {
    readonly [InvocationEventTypeId]: true
    readonly path: string
    readonly id: string
    readonly type: "done"
    readonly output: unknown
  }
  | {
    readonly [InvocationEventTypeId]: true
    readonly path: string
    readonly id: string
    readonly type: "failure"
    readonly error: unknown
  }
  | {
    readonly [InvocationEventTypeId]: true
    readonly path: string
    readonly id: string
    readonly type: "snapshot"
    readonly snapshot: unknown
  }

/** @internal */
export const done = (path: string, id: string, output: unknown): InvocationEvent => ({
  [InvocationEventTypeId]: true,
  path,
  id,
  type: "done",
  output
})

/** @internal */
export const failure = (path: string, id: string, error: unknown): InvocationEvent => ({
  [InvocationEventTypeId]: true,
  path,
  id,
  type: "failure",
  error
})

/** @internal */
export const snapshot = (path: string, id: string, value: unknown): InvocationEvent => ({
  [InvocationEventTypeId]: true,
  path,
  id,
  type: "snapshot",
  snapshot: value
})

/** @internal */
export const isInvocationEvent = (value: unknown): value is InvocationEvent =>
  typeof value === "object" && value !== null && InvocationEventTypeId in value

/** @internal */
export const definitions = (invoke: unknown): ReadonlyArray<Record<PropertyKey, any>> => {
  if (invoke === undefined) return []
  return Array.isArray(invoke)
    ? invoke as ReadonlyArray<Record<PropertyKey, any>>
    : [invoke as Record<PropertyKey, any>]
}
