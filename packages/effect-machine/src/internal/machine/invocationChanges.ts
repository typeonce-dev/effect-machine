/**
 * Host-neutral reading of what a step changed for the work owned by states.
 *
 * @since 0.48.0
 */

import type { Machine } from "../../Machine.js"

/** The part of a planned microstep that decides which work stops and starts. */
interface Microstep {
  readonly event: Machine.LifecycleEvent<any>
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly changed: boolean
}

/**
 * The states a step exited and entered. A path that was exited and entered again
 * is in both.
 *
 * @internal
 */
export interface InvocationChanges {
  /** Paths whose work a host stops, in exit order. */
  readonly exited: ReadonlyArray<string>

  /**
   * Paths whose work a host starts through `InvocationResolution.resolve`, in
   * entry order, with the lifecycle event that last entered each. A path that a
   * later microstep exited is included, and is dropped by the resolver.
   */
  readonly entered: ReadonlyMap<string, Machine.LifecycleEvent<any>>
}

/**
 * Reads the changes of a step from its microsteps. `undefined` means the step
 * neither exited nor entered a state.
 *
 * @internal
 */
export const fromMicrosteps = (microsteps: ReadonlyArray<Microstep>): InvocationChanges | undefined => {
  let exited: Array<string> | undefined
  let entered: Map<string, Machine.LifecycleEvent<any>> | undefined
  for (const step of microsteps) {
    if (!step.changed) continue
    exited ??= []
    entered ??= new Map()
    for (const path of step.exitPaths) exited.push(path)
    for (const path of step.entryPaths) entered.set(path, step.event)
  }
  return exited === undefined || entered === undefined ? undefined : { exited, entered }
}
