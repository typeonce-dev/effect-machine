import { RegistryContext, useAtomMount } from "@effect/atom-react"
import type { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Cause, Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import type { AtomRegistry } from "effect/reactivity"
import * as React from "react"
import type { MachineContext, MachineStateProps } from "../MachineAtom.js"

export const useMachineAtom = <A extends AtomMachine.MachineAtom.Any>(create: () => A): A => {
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
  const result = useRetainedResult(React.useContext(RegistryContext), selected)
  if (AsyncResult.isFailure(result)) throw Cause.squash(result.cause)
  if (AsyncResult.isInitial(result)) return props.pending ?? null
  return Option.isSome(result.value) ? props.children(result.value.value) : props.inactive ?? null
}

/**
 * Reads a result atom through `useSyncExternalStore`, so server renders and
 * hydration use the atom's server value. Once a renderer has a successful
 * result, it keeps that result while the atom is `Initial` again, for example
 * while the live machine starts after hydrating its planned snapshot. The
 * rendered tree, and every DOM node in it, survives that switch.
 */
const useRetainedResult = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>
): AsyncResult.AsyncResult<A, E> => {
  const store = React.useMemo(() => {
    let retained: AsyncResult.Success<A, E> | undefined
    const retain = (result: AsyncResult.AsyncResult<A, E>): AsyncResult.AsyncResult<A, E> => {
      if (AsyncResult.isSuccess(result)) {
        retained = result
        return result
      }
      return AsyncResult.isInitial(result) && retained !== undefined ? retained : result
    }
    return {
      subscribe: (onChange: () => void) => registry.subscribe(atom, onChange),
      snapshot: () => retain(registry.get(atom)),
      serverSnapshot: () => retain(Atom.getServerValue(atom, registry))
    }
  }, [registry, atom])
  return React.useSyncExternalStore(store.subscribe, store.snapshot, store.serverSnapshot)
}

export const createMachineContext = <Args extends [] | [unknown], A extends AtomMachine.MachineAtom.Any>(
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
