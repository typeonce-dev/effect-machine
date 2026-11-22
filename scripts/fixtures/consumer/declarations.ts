import { Machine } from "@typeonce/effect-machine"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect } from "effect"

// Exported values must emit declarations that name only public types, whether
// the type is inferred or written by hand.

export const stopInferred = <Event>(child: Machine.ChildAddress<Event>) => Machine.stopChild(child)

export const stopAnnotated = <Event>(
  child: Machine.ChildAddress<Event>
): Effect.Effect<void, never, Machine.MachineRuntime> => Machine.stopChild(child)

export const sendInferred = (child: Machine.ChildAddress<number>, event: number) => Machine.sendTo(child, event)

export const sendAnnotated = (
  child: Machine.ChildAddress<number>,
  event: number
): Effect.Effect<void, Machine.StoppedError, Machine.MachineRuntime> => Machine.sendTo(child, event)

export const spawnInferred = Machine.spawn(Machine.logic({ initial: 0, run: () => Effect.never }), { id: "worker" })

export const choiceState = (state: MachineTest.FiniteState) => state._tag === "Choice" ? state : undefined

export const attemptedCommand = (failure: MachineTest.CausalRuntimeCommandFailure) => failure.attempted
