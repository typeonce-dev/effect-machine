/**
 * Causal testing access to a running statechart.
 *
 * @since 4.0.0
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type * as Machine from "../../../Machine.js"
import type { Probe, ProbePlan } from "../../../testing/MachineTest.js"
import * as Runtime from "../../machine/runtime.js"

type AnyMachine = Machine.Machine.Any

/**
 * Raised when a reference was not created by the managed statechart runtime.
 *
 * @category errors
 * @since 4.0.0
 */
export class ProbeUnavailableError extends Data.TaggedError("MachineTestProbeUnavailableError")<{
  readonly message: string
}> {}

/** @internal */
export const probe = <M extends AnyMachine, Error, Output>(
  machine: M,
  ref: Machine.MachineRef<
    Machine.Machine.Snapshot<Machine.Machine.States<M>>,
    Machine.Machine.InputEvent<M>,
    Error,
    Output
  >
): Effect.Effect<Probe<M, Error, Output>, ProbeUnavailableError> => {
  const acknowledged = (ref as Runtime.MachineRef<
    Machine.Machine.Snapshot<Machine.Machine.States<M>>,
    Machine.Machine.InputEvent<M>,
    Error,
    Output
  >)[Runtime.acknowledgedSend]
  if (acknowledged === undefined) {
    return Effect.fail(
      new ProbeUnavailableError({
        message: "MachineTest.probe requires a managed statechart reference created by Machine.start or Machine.resume"
      })
    )
  }

  return Effect.succeed(Object.freeze({
    machine,
    ref,
    sendAndAwait: (event: Machine.Machine.InputEvent<M>) =>
      acknowledged.call(ref, event).pipe(
        Effect.map(({ after, before, plan }) => {
          const eventPlan = plan as ProbePlan<M>
          return Object.freeze({
            event,
            before,
            plan: eventPlan,
            after,
            handled: eventPlan.microsteps.length > 0,
            configurationChanged: eventPlan.microsteps.some((microstep) => microstep.changed)
          })
        })
      )
  }))
}
