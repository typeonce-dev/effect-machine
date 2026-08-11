import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { MicrowaveMachine } from "./machine.ts"

export const microwaveAtom = AtomMachine.make(MicrowaveMachine)
