import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"

/**
 * Error returned when a decoded machine snapshot cannot be encoded through its
 * declared state or output schemas.
 *
 * @category errors
 * @since 0.4.0
 */
export class MachineSchemaEncodeError extends Data.TaggedError("MachineSchemaEncodeError")<{
  readonly machineId: string | undefined
  readonly boundary: "state" | "output" | "history" | "configuration"
  readonly state?: string
  readonly cause: Schema.SchemaError | Cause.Cause<unknown>
}> {}

/**
 * Error returned when a machine contract value does not match the schema or
 * structural configuration declared for a machine boundary.
 *
 * @category errors
 * @since 0.4.0
 */
export class MachineSchemaDecodeError extends Data.TaggedError("MachineSchemaDecodeError")<{
  readonly machineId: string | undefined
  readonly boundary: "input" | "event" | "emission" | "state" | "output" | "history" | "configuration"
  readonly state?: string
  readonly event?: string
  readonly cause: Schema.SchemaError | Cause.Cause<unknown>
}> {}

/**
 * Error returned when a machine does not stabilize within the maximum
 * number of macrostep iterations.
 *
 * @category errors
 * @since 0.4.0
 */
export class InfiniteTransitionError extends Data.TaggedError("InfiniteTransitionError")<{
  readonly machineId: string | undefined
  readonly state: string
  readonly maxIterations: number
}> {}

/**
 * Error returned when a machine fails while running startup lifecycle
 * logic after the initial state has been computed.
 *
 * @category errors
 * @since 0.4.0
 */
export class StartupError extends Data.TaggedError("StartupError")<{
  readonly cause: Cause.Cause<unknown>
}> {}

/**
 * Error returned by `spawn` when a child process with the same id already
 * exists for the current machine.
 *
 * @category errors
 * @since 0.4.0
 */
export class ChildAlreadyExistsError extends Data.TaggedError("ChildAlreadyExistsError")<{
  readonly id: string
}> {}

/**
 * Error returned when standalone action execution attempts an operation that
 * requires a managed machine process.
 *
 * @category errors
 * @since 0.4.0
 */
export class ProcessLocalError extends Data.TaggedError("ProcessLocalError")<{
  readonly operation: string
}> {}

/**
 * Error returned by `join` when a running machine is stopped before
 * producing an output.
 *
 * @category errors
 * @since 0.4.0
 */
export class StoppedError extends Data.TaggedError("StoppedError") {}

/**
 * Failures that synchronous planning reports through the typed error channel.
 * Every other planning throw is a defect.
 */
export type PlanningError = InfiniteTransitionError | MachineSchemaDecodeError

export const isPlanningError = (error: unknown): error is PlanningError =>
  error instanceof InfiniteTransitionError || error instanceof MachineSchemaDecodeError

/** Converts a synchronous planning throw into a typed failure or a defect. */
export const failPlanning = (error: unknown): Effect.Effect<never, PlanningError> =>
  isPlanningError(error) ? Effect.fail(error) : Effect.die(error)

/**
 * Classifies a synchronous initial-planning throw. Planning failures stay
 * typed; any other throw is preserved as the defect cause of a `StartupError`.
 */
export const toStartupFailure = (error: unknown): PlanningError | StartupError =>
  isPlanningError(error) || error instanceof StartupError ? error : new StartupError({ cause: Cause.die(error) })
