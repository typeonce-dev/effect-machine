/**
 * What one stored state knows about the invocations it owns.
 *
 * An effect without progress should run, and a timer without progress needs a due
 * time. Progress is keyed by state and id, so one invocation never has two, and
 * every function returns a new value.
 *
 * @since 0.48.0
 */
import * as Predicate from "effect/Predicate"
import type { Checkpoint } from "../../unstable/cluster/ClusterMachine.js"

/**
 * Progress by the path of the state and the id of the invocation. Names are
 * chosen by the model, so lookups go through maps and not object properties.
 *
 * @internal
 */
export type Progress = ReadonlyMap<string, ReadonlyMap<string, Checkpoint.Progress>>

/**
 * The last instant a date can name. A later due time, such as that of an
 * infinite duration, is stored as this one, so every stored due time is a date.
 *
 * @internal
 */
export const maxDueAt = 8.64e15

/** @internal */
export const empty: Progress = new Map()

/** @internal */
export const get = (progress: Progress, key: Checkpoint.InvocationKey): Checkpoint.Progress | undefined =>
  progress.get(key.path)?.get(key.id)

const set = (progress: Progress, key: Checkpoint.InvocationKey, value: Checkpoint.Progress): Progress =>
  new Map(progress).set(key.path, new Map(progress.get(key.path) ?? []).set(key.id, value))

/**
 * An invocation that ended while its state stayed active.
 *
 * @internal
 */
export const settle = (progress: Progress, key: Checkpoint.InvocationKey): Progress =>
  set(progress, key, { _tag: "Settled" })

/**
 * A timer that waits until a due time.
 *
 * @internal
 */
export const wait = (progress: Progress, key: Checkpoint.InvocationKey, dueAt: number): Progress =>
  set(progress, key, { _tag: "Waiting", dueAt })

/**
 * Removes the invocations of exited states.
 *
 * @internal
 */
export const exit = (progress: Progress, paths: ReadonlyArray<string>): Progress =>
  new Map(Array.from(progress).filter(([path]) => !paths.includes(path)))

/**
 * Removes every timer that waits.
 *
 * @internal
 */
export const cancelTimers = (progress: Progress): Progress =>
  new Map(
    Array.from(progress, ([path, invocations]) =>
      [
        path,
        new Map(Array.from(invocations).filter(([, { _tag }]) => _tag !== "Waiting"))
      ] as const)
  )

/** @internal */
export const entries = (
  progress: Progress
): ReadonlyArray<readonly [key: Checkpoint.InvocationKey, progress: Checkpoint.Progress]> =>
  Array.from(progress).flatMap(([path, invocations]) =>
    Array.from(invocations, ([id, value]) => [{ path, id }, value] as const)
  )

/** @internal */
export const toStored = (progress: Progress): Checkpoint.Invocations =>
  Object.fromEntries(
    Array.from(progress)
      .filter(([, invocations]) => invocations.size > 0)
      .map(([path, invocations]) => [path, Object.fromEntries(invocations)])
  )

const readOne = (value: unknown): Checkpoint.Progress | undefined => {
  if (!Predicate.hasProperty(value, "_tag")) return undefined
  if (value._tag === "Settled") return { _tag: "Settled" }
  return value._tag === "Waiting" && Predicate.hasProperty(value, "dueAt") && Predicate.isNumber(value.dueAt) &&
      Number.isInteger(value.dueAt) && Math.abs(value.dueAt) <= maxDueAt
    ? { _tag: "Waiting", dueAt: value.dueAt }
    : undefined
}

/**
 * Reads stored progress, whose store may hold anything. `undefined` means it is
 * not progress.
 *
 * @internal
 */
export const fromStored = (stored: unknown): Progress | undefined => {
  if (!Predicate.isObject(stored)) return undefined
  const progress = new Map<string, ReadonlyMap<string, Checkpoint.Progress>>()
  for (const [path, invocations] of Object.entries(stored)) {
    if (!Predicate.isObject(invocations)) return undefined
    const read = new Map<string, Checkpoint.Progress>()
    for (const [id, value] of Object.entries(invocations)) {
      const one = readOne(value)
      if (one === undefined) return undefined
      read.set(id, one)
    }
    progress.set(path, read)
  }
  return progress
}
