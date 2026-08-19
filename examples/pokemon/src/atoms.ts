import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Atom } from "effect/unstable/reactivity"
import { machine, ReplaceChild, SelectionChild } from "./machine.ts"
import { PokemonService } from "./pokemon.ts"

const atomRuntime = Atom.runtime(PokemonService.layer)

export const machineAtom = AtomMachine.bind(atomRuntime).make(machine)
export const selectionMachineAtom = machineAtom.child(SelectionChild)
export const replaceMachineAtom = machineAtom.child(ReplaceChild)
