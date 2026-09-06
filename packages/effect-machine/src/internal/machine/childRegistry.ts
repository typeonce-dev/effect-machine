/** Owns child reservations and ordered observer buffers for one local runtime. */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import type { MachineRef } from "./runtime.js"

export type ChildDescriptor = {
  readonly id: string
  readonly machine: object
}

export type ChildEntry =
  | {
    readonly _tag: "Starting"
    readonly token: symbol
    readonly ownerKey?: string
    readonly ownerPath?: string
    ownerActive?: boolean
  }
  | {
    readonly _tag: "Started"
    readonly token: symbol
    readonly descriptor: ChildDescriptor | undefined
    readonly ref: MachineRef<any, any, any, any>
    readonly ownerKey?: string
    readonly ownerPath?: string
    ownerActive?: boolean
  }

export type ChildSelector = string | ChildDescriptor
export type ChildKey = string | symbol

type ChildObservation = Option.Option<MachineRef<any, any, any, any>>
type ChildObservationBatch = [ChildObservation, ...Array<ChildObservation>]

export interface ChildObserver {
  readonly child: ChildSelector
  readonly id: string
  values: ChildObservationBatch | undefined
  waiter: Deferred.Deferred<void> | undefined
}

export const offerChildObservation = (
  observer: ChildObserver,
  value: ChildObservation
): void => {
  if (observer.values === undefined) {
    observer.values = [value]
  } else {
    observer.values.push(value)
  }
  if (observer.waiter !== undefined) {
    const waiter = observer.waiter
    observer.waiter = undefined
    Deferred.doneUnsafe(waiter, Effect.void)
  }
}

export const takeChildObservations = (
  observer: ChildObserver
): Effect.Effect<ChildObservationBatch> =>
  Effect.suspend(() => {
    if (observer.values !== undefined) {
      const values = observer.values
      observer.values = undefined
      return Effect.succeed(values)
    }
    const waiter = Deferred.makeUnsafe<void>()
    observer.waiter = waiter
    return Deferred.await(waiter).pipe(Effect.andThen(takeChildObservations(observer)))
  })

export interface ChildRegistry {
  closed: boolean
  readonly children: Map<ChildKey, ChildEntry>
  observers: Set<ChildObserver> | undefined
  scope: Scope.Closeable | undefined
}

export const matchesChild = (
  entry: ChildEntry,
  child: ChildSelector
): entry is Extract<ChildEntry, { readonly _tag: "Started" }> =>
  entry._tag === "Started" && (typeof child === "string" || (
    entry.descriptor !== undefined &&
    entry.descriptor.id === child.id &&
    entry.descriptor.machine === child.machine
  ))

export const selectRegistryChild = (
  registry: ChildRegistry,
  id: string,
  child: ChildSelector
): ChildObservation => {
  if (registry.closed) return Option.none()
  const entry = registry.children.get(id)
  return entry !== undefined && matchesChild(entry, child) ? Option.some(entry.ref) : Option.none()
}

export const publishRegistryChange = (registry: ChildRegistry): void => {
  if (registry.observers === undefined) return
  for (const observer of registry.observers) {
    offerChildObservation(observer, selectRegistryChild(registry, observer.id, observer.child))
  }
}

export const unregisterChild = (registry: ChildRegistry, key: ChildKey, token: symbol): void => {
  const entry = registry.children.get(key)
  if (entry === undefined || entry.token !== token) return
  registry.children.delete(key)
  if (typeof key === "string") publishRegistryChange(registry)
}

export const registerChild = (
  registry: ChildRegistry,
  key: ChildKey,
  token: symbol,
  ref: MachineRef<any, any, any, any>,
  descriptor: ChildDescriptor | undefined
): boolean => {
  const entry = registry.children.get(key)
  if (registry.closed || entry === undefined || entry._tag !== "Starting" || entry.token !== token) {
    return false
  }
  registry.children.delete(key)
  const started: ChildEntry = entry.ownerKey === undefined
    ? { _tag: "Started", token, descriptor, ref }
    : {
      _tag: "Started",
      token,
      descriptor,
      ref,
      ownerKey: entry.ownerKey,
      ownerPath: entry.ownerPath!,
      ownerActive: entry.ownerActive === true
    }
  registry.children.set(key, started)
  if (typeof key === "string") publishRegistryChange(registry)
  return true
}
