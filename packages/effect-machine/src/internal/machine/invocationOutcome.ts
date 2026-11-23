/**
 * Host-neutral meaning of what invoked work reports.
 *
 * Every function is synchronous and decides for the moment it is called, so a
 * host asks in the turn that would deliver the result and then performs the
 * decision: it plans a delivered event through its own mailbox, fails its
 * machine, or does nothing.
 *
 * @since 0.47.2
 */

import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import { InfiniteTransitionError, MachineSchemaDecodeError, StoppedError } from "./errors.js"
import * as InvocationEvent from "./invocationEvent.js"
import type { ResolvedInvocation, StreamInvocation } from "./invocationResolution.js"

/**
 * How invoked work ended. `Stopped` means its host stopped it.
 *
 * @internal
 */
export type Outcome =
  | { readonly _tag: "Done"; readonly output: unknown }
  | { readonly _tag: "Failure"; readonly error: unknown; readonly cause: Cause.Cause<unknown> }
  | { readonly _tag: "Defect" | "Interrupted" | "Cause"; readonly cause: Cause.Cause<unknown> }
  | { readonly _tag: "Stopped" }

/**
 * Plan this event on the owning machine.
 *
 * @internal
 */
export interface Deliver {
  readonly _tag: "Deliver"
  readonly event: InvocationEvent.InvocationEvent
}

/**
 * Fail the owning machine with this cause.
 *
 * @internal
 */
export interface Fail {
  readonly _tag: "Fail"
  readonly cause: Cause.Cause<unknown>
}

/**
 * Discard the report.
 *
 * @internal
 */
export interface Ignore {
  readonly _tag: "Ignore"
}

/** @internal */
export type Decision = Deliver | Fail | Ignore

const ignore: Ignore = Object.freeze({ _tag: "Ignore" })

const deliver = (event: InvocationEvent.InvocationEvent): Deliver => ({ _tag: "Deliver", event })

const fail = (cause: Cause.Cause<unknown>): Fail => ({ _tag: "Fail", cause })

// A framework failure of a child machine is not one of its declared errors.
const isFrameworkFailure = (error: unknown): boolean =>
  error instanceof InfiniteTransitionError || error instanceof MachineSchemaDecodeError || error instanceof StoppedError

/**
 * The outcome of work a host ran as an effect. A typed failure takes precedence
 * over the other reasons of its cause, as it does for a local process. A host
 * that interrupts the work itself reports `Stopped` instead.
 *
 * @internal
 */
export const fromExit = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { _tag: "Done", output: exit.value }
  const failure = exit.cause.reasons.find(Cause.isFailReason)
  return failure === undefined
    ? { _tag: "Cause", cause: exit.cause }
    : { _tag: "Failure", error: failure.error, cause: exit.cause }
}

/**
 * Decides what the end of invoked work means to the machine that owns it.
 *
 * @internal
 */
export const decide = (
  invocation: ResolvedInvocation,
  generation: InvocationEvent.Generation,
  outcome: Outcome
): Decision => {
  if (outcome._tag === "Stopped" || !generation.current) return ignore
  switch (outcome._tag) {
    case "Done":
      return invocation.channels.done
        ? deliver(InvocationEvent.done(invocation.path, invocation.id, generation, outcome.output))
        : fail(Cause.die(
          new Error(
            `Invocation "${invocation.id}" completed without the required onDone handler`
          )
        ))
    case "Failure":
      return invocation.channels.failure && (invocation._tag !== "Child" || !isFrameworkFailure(outcome.error))
        ? deliver(InvocationEvent.failure(invocation.path, invocation.id, generation, outcome.error))
        : fail(outcome.cause)
    case "Defect":
    case "Interrupted":
    case "Cause":
      return fail(outcome.cause)
  }
}

/**
 * Decides what an active snapshot of invoked work means to its owner.
 *
 * @internal
 */
export const decideSnapshot = (
  invocation: ResolvedInvocation,
  generation: InvocationEvent.Generation,
  snapshot: unknown
): Deliver | Ignore =>
  invocation.channels.snapshot && generation.current
    ? deliver(InvocationEvent.snapshot(invocation.path, invocation.id, generation, snapshot))
    : ignore

/**
 * Decides what a stream element means to the owner of its stream. An element is
 * delivered even when `onElement` is not declared: the owner's acknowledgement
 * paces the stream. A host stops pulling a stream whose element is ignored.
 *
 * @internal
 */
export const decideElement = (
  invocation: StreamInvocation,
  generation: InvocationEvent.Generation,
  element: unknown
): Deliver | Ignore =>
  generation.current
    ? deliver(InvocationEvent.element(invocation.path, invocation.id, generation, element))
    : ignore
