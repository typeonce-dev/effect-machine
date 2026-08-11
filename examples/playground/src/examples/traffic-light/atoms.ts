import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { TrafficLightMachine } from "./machine.ts"

export const trafficLightAtom = AtomMachine.make(TrafficLightMachine)
