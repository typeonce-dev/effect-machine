/**
 * React ownership for machine atoms.
 *
 * @since 0.29.0
 */
"use client"

import { useAtomMount } from "@effect/atom-react"
import type { AtomMachine } from "@typeonce/effect-machine/reactivity"
import * as React from "react"

type AnyMachineAtom = AtomMachine.MachineAtom<any, never, any, any, any, any>

/**
 * Creates one machine atom for a committed React owner and mounts its machine
 * reference without subscribing the owner to machine state.
 *
 * The factory is startup-only. Later changes to values captured by the factory
 * do not replace the machine. Send an event to change a running workflow, or
 * change the owner's React `key` to create a new machine.
 *
 * @category hooks
 * @since 0.29.0
 */
export const useMachineAtom = <A extends AnyMachineAtom>(create: () => A): A => {
  const [machine] = React.useState(create)
  useAtomMount(machine.ref)
  return machine
}
