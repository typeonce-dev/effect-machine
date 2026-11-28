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

/**
 * Splits running work into the work a step stops, in exit order, and the work
 * it keeps, in start order. Work is stopped when its owning path was exited.
 *
 * @internal
 */
export const partition = <Work extends { readonly path: string }>(
  running: ReadonlyArray<Work>,
  changes: InvocationChanges | undefined
): { readonly stop: ReadonlyArray<Work>; readonly kept: ReadonlyArray<Work> } => {
  if (changes === undefined || running.length === 0) return { stop: noWork, kept: running }
  const stop: Array<Work> = []
  for (const path of new Set(changes.exited)) {
    for (const work of running) if (work.path === path) stop.push(work)
  }
  return stop.length === 0
    ? { stop: noWork, kept: running }
    : { stop, kept: running.filter((work) => !stop.includes(work)) }
}

const noWork: ReadonlyArray<never> = []

/**
 * The entries of a step, one per entered path, as `InvocationResolution.resolveEntries`
 * reads them.
 *
 * @internal
 */
export const entries = (
  changes: InvocationChanges | undefined
): ReadonlyArray<readonly [ReadonlyArray<string>, Machine.LifecycleEvent<any>]> =>
  changes === undefined ? noWork : Array.from(changes.entered, ([path, event]) => [[path], event] as const)
