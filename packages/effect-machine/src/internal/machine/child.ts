/**
 * Child machine descriptors and typed child addresses.
 *
 * A descriptor names a child by id and machine definition. It carries nothing a
 * host needs to run the child: each host starts the machine in its own way.
 *
 * @since 0.48.0
 */

import { hasProperty } from "effect/Predicate"
import type { ChildAddress, ChildMachine, Machine } from "../../Machine.js"

const TypeId = "~effect/Machine/ChildMachine"

export const child = <const Id extends string, M extends Machine.Any>(id: Id, machine: M): ChildMachine<Id, M> => ({
  [TypeId]: TypeId,
  id,
  machine
})

export const childFamily = <M extends Machine.Any>(machine: M): ChildMachine.Family<M> => (id) => child(id, machine)

export const childAddress = <Event = never>(id: string): ChildAddress<Event> => id as ChildAddress<Event>

export const isChildMachine = (u: unknown): u is ChildMachine.Any => hasProperty(u, TypeId)
