/**
 * Private mailbox messages used to route invocation lifecycle changes through
 * the owning machine planner.
 *
 * @since 0.9.0
 */

/** @internal */
export const InvocationEventTypeId: unique symbol = Symbol("effect/Machine/InvocationEvent")

/** @internal */
export const GenerationId: unique symbol = Symbol("effect/Machine/InvocationEvent/Generation")

/**
 * One activation of an invoking state.
 *
 * The owned child runtime begins a generation when the state is entered and
 * retires it when the state exits, so `current` is mutable by contract. Every
 * outcome of an invocation started during that activation carries the
 * generation, which lets the planner discard outcomes that were queued before
 * the state exited, even after the same path and id are entered again.
 *
 * @internal
 */
export interface Generation {
  current: boolean
}

interface Base {
  readonly [InvocationEventTypeId]: true
  // Keyed by a symbol so the runtime handle stays out of inspection payloads,
  // JSON, and canonical value formatting, like the type id above.
  readonly [GenerationId]: Generation
  readonly path: string
  readonly id: string
}

/** @internal */
export type InvocationEvent =
  | Base & {
    readonly type: "element"
    readonly element: unknown
  }
  | Base & {
    readonly type: "done"
    readonly output: unknown
  }
  | Base & {
    readonly type: "failure"
    readonly error: unknown
  }
  | Base & {
    readonly type: "snapshot"
    readonly snapshot: unknown
  }

/** @internal */
export const done = (path: string, id: string, generation: Generation, output: unknown): InvocationEvent => ({
  [InvocationEventTypeId]: true,
  [GenerationId]: generation,
  path,
  id,
  type: "done",
  output
})

/** @internal */
export const element = (path: string, id: string, generation: Generation, value: unknown): InvocationEvent => ({
  [InvocationEventTypeId]: true,
  [GenerationId]: generation,
  path,
  id,
  type: "element",
  element: value
})

/** @internal */
export const failure = (path: string, id: string, generation: Generation, error: unknown): InvocationEvent => ({
  [InvocationEventTypeId]: true,
  [GenerationId]: generation,
  path,
  id,
  type: "failure",
  error
})

/** @internal */
export const snapshot = (path: string, id: string, generation: Generation, value: unknown): InvocationEvent => ({
  [InvocationEventTypeId]: true,
  [GenerationId]: generation,
  path,
  id,
  type: "snapshot",
  snapshot: value
})

/**
 * Whether the state activation that started the invocation is still active.
 *
 * @internal
 */
export const isCurrent = (event: InvocationEvent): boolean => event[GenerationId].current

/** @internal */
export const isInvocationEvent = (value: unknown): value is InvocationEvent =>
  typeof value === "object" && value !== null && InvocationEventTypeId in value
