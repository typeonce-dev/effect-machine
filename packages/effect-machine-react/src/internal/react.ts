import { useAtomMount, useAtomSuspense } from "@effect/atom-react"
import type { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Option } from "effect"
import * as React from "react"
import type { MachineContext, MachineStateProps } from "../MachineAtom.js"

type AnyMachineAtom = AtomMachine.MachineAtom<any, never, any, any, any, any>

export const useMachineAtom = <A extends AnyMachineAtom>(create: () => A): A => {
  const [machine] = React.useState(create)
  useAtomMount(machine.ref)
  return machine
}

export const MachineState = <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Event,
  Error,
  Output,
  StartError,
  Emitted,
  const Path extends Machine.Snapshot.Path<State>
>(
  props: MachineStateProps<State, Event, Error, Output, StartError, Emitted, Path>
): React.ReactNode => {
  const selected = React.useMemo(() => AtomMachine.selectSnapshot(props.machine, props.path), [
    props.machine,
    props.path
  ])
  const snapshot = useAtomSuspense(selected).value
  return Option.isSome(snapshot) ? props.children(snapshot.value) : props.inactive ?? null
}

export const createMachineContext = <Args extends [] | [unknown], A extends AnyMachineAtom>(
  create: (...args: Args) => A
): MachineContext<Args, A> => {
  const Context = React.createContext<A | undefined>(undefined)
  const Provider = (props: { readonly input?: unknown; readonly children?: React.ReactNode }): React.ReactNode => {
    // Input belongs to this committed owner. A new React key creates a new owner.
    const machine = useMachineAtom(() => create(...("input" in props ? [props.input] : []) as Args))
    return React.createElement(Context.Provider, { value: machine }, props.children)
  }
  const useMachine = (): A => {
    const machine = React.useContext(Context)
    if (machine === undefined) throw new Error("Machine context must be read inside its Provider")
    return machine
  }
  return Object.freeze({ Provider, useMachine }) as MachineContext<Args, A>
}
