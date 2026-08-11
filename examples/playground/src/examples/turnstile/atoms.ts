import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { TurnstileMachine } from "./machine.ts"

export const turnstileAtom = AtomMachine.make(TurnstileMachine)
