/**
 * React ownership and state rendering for machine atoms.
 *
 * @since 0.29.0
 */
"use client"

import type { Machine } from "@typeonce/effect-machine"
import type { AtomMachine } from "@typeonce/effect-machine/reactivity"
import type { Layer } from "effect"
import type { AsyncResult, Atom } from "effect/reactivity"
import type * as React from "react"
import * as internal from "./internal/react.js"

/**
 * Creates one bridge per React owner and mounts its reference without subscribing
 * the owner to state changes. The factory is startup-only. Change the owner's
 * React key to start a fresh machine. Keep this owner above any Suspense boundary
 * that reads the machine.
 *
 * @category hooks
 * @since 0.29.0
 */
export const useMachineAtom: <A extends AtomMachine.MachineAtom.Any>(create: () => A) => A = internal.useMachineAtom

/**
 * Reads a result atom from the current registry without suspending, keeping the
 * last success while the atom is `Initial` again.
 *
 * **Details**
 *
 * Server rendering and hydration read the atom's server value, such as the
 * planned startup projection of `AtomMachine.select`, `selectSnapshot`,
 * `matches`, or `can`. When the live machine then starts, the atom is `Initial`
 * until its first snapshot; this hook keeps returning the last `Success`
 * instead, so the hydrated tree and its DOM nodes survive. Use it instead of
 * `useAtomValue` for custom readers of machine atoms that render during
 * hydration. Failures are returned, not thrown.
 *
 * @category hooks
 * @since 0.43.0
 */
export const useMachineResult: <A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>
) => AsyncResult.AsyncResult<A, E> = internal.useMachineResult

/** Props for a typed render of one active state path of a machine or child machine.
 * @category models
 * @since 0.32.0
 */
export interface MachineStateProps<
  A extends MachineStateProps.Bridge,
  Path extends Machine.Snapshot.Path<MachineStateProps.State<A>>
> {
  /** A machine bridge, or a child bridge from `machine.child(Descriptor)`. */
  readonly machine: A
  readonly path: Path
  /** Rendered while the machine has no snapshot yet. Defaults to null. */
  readonly pending?: React.ReactNode
  /** Rendered while the path, or the state that owns the child, is not active. Defaults to null. */
  readonly inactive?: React.ReactNode
  readonly children: (state: Machine.Snapshot.At<MachineStateProps.State<A>, NoInfer<Path>>) => React.ReactNode
}

/**
 * Type-level members associated with `MachineStateProps`.
 *
 * @category models
 * @since 0.43.0
 */
export declare namespace MachineStateProps {
  /**
   * A bridge `MachineState` can render: a machine bridge or a child bridge.
   *
   * @category utility types
   * @since 0.43.0
   */
  export type Bridge = AtomMachine.MachineAtom.Any | AtomMachine.ChildMachineAtom.Any

  /**
   * The logical snapshot type rendered from a bridge: the machine state for a
   * machine bridge and the child state for a child bridge.
   *
   * @category utility types
   * @since 0.43.0
   */
  export type State<A extends Bridge> = A extends AtomMachine.MachineAtom.Any ? AtomMachine.MachineAtom.State<A>
    : A extends AtomMachine.ChildMachineAtom.Any ? AtomMachine.ChildMachineAtom.State<A>
    : never
}

/**
 * Subscribes only this renderer to a state path without suspending. Server
 * rendering and hydration render the machine's planned startup snapshot, and
 * the same tree then receives live snapshots, so form inputs keep their DOM
 * nodes, text and focus. Once a snapshot has rendered, the renderer keeps it
 * while the machine is still starting. Before any snapshot exists it renders
 * `pending`; an inactive path renders `inactive`. Both default to null.
 * Startup and runtime failures propagate to the nearest error boundary.
 *
 * **Details**
 *
 * `machine` also accepts a child bridge from `machine.child(Descriptor)`. Paths
 * and the callback snapshot are then those of the child machine, and
 * `inactive` also renders while the state that owns the child is not active.
 *
 * **Example**
 *
 * ```tsx
 * <MachineState machine={machine.child(QuantityChild)} path="" inactive={null}>
 *   {(snapshot) => <NumberField value={snapshot.value.quantity} />}
 * </MachineState>
 * ```
 *
 * @category components
 * @since 0.32.0
 */
export const MachineState: <
  A extends MachineStateProps.Bridge,
  const Path extends Machine.Snapshot.Path<MachineStateProps.State<A>>
>(
  props: MachineStateProps<A, Path>
) => React.ReactNode = internal.MachineState

/** An isolated React owner and accessor for a bridge factory.
 * @category models
 * @since 0.32.0
 */
export interface MachineContext<Args extends MachineContext.Args, A extends AtomMachine.MachineAtom.Any> {
  readonly Provider: React.ComponentType<MachineContext.ProviderProps<Args>>
  readonly useMachine: () => A
}

/**
 * Type-level members associated with `MachineContext`.
 *
 * @category models
 * @since 0.43.0
 */
export declare namespace MachineContext {
  /**
   * Values a Provider passes to its bridge factory: the machine's startup
   * `input` and a per-owner capability `layer`. A factory declares only the
   * values it uses.
   *
   * @category models
   * @since 0.44.0
   */
  export interface Options {
    readonly input?: unknown
    readonly layer?: Layer.Layer<any, any, any>
  }

  /**
   * Parameters a bridge factory may declare: none, or one `Options` object.
   *
   * @category utility types
   * @since 0.43.0
   */
  export type Args = [] | [options: Options]

  /**
   * Provider props mirror the factory's options: each declared option is a
   * required prop of the same type, and undeclared options are rejected.
   *
   * @category utility types
   * @since 0.43.0
   */
  export type ProviderProps<Args extends MachineContext.Args> =
    & { readonly children?: React.ReactNode }
    & (Args extends [infer O] ? O & { readonly [K in Exclude<keyof Options, keyof O>]?: never }
      : { readonly [K in keyof Options]?: never })

  /**
   * Rejects factory options other than `input` and `layer`, so a capability
   * cannot be passed under another name.
   *
   * @category utility types
   * @since 0.44.0
   */
  export type EnsureOptions<Args extends MachineContext.Args> = Args extends [infer O]
    ? [Exclude<keyof O, keyof Options>] extends [never] ? unknown
    : { readonly "createMachineContext options accept only input and layer": Exclude<keyof O, keyof Options> }
    : unknown
}

/**
 * Creates a context from an AtomMachine factory. Each Provider owns a fresh
 * bridge in its current registry. The Provider does not subscribe to machine
 * state.
 *
 * **Details**
 *
 * The factory takes no parameters or one options object. Each option it
 * declares is a Provider prop of the same name and type: `input` is the
 * machine's startup input, and `layer` is a per-owner capability, such as a
 * router-bound service, that the factory provides to the machine through
 * `AtomMachine.bind(Atom.runtime(...))`. Binding rejects a machine whose
 * services the runtime does not provide.
 *
 * Input and layer are read once, when the Provider mounts. Send an event to
 * update a running workflow, or change the Provider's React `key` to create a
 * new owner with new input and layer.
 *
 * **Example**
 *
 * ```tsx
 * const Auth = createMachineContext(AtomMachine.factory(AuthMachine))
 *
 * const Profile = createMachineContext(({ input }: { input: ProfileInput }) =>
 *   AtomMachine.make(ProfileMachine, input)
 * )
 *
 * const SignIn = createMachineContext(
 *   ({ input, layer }: { input: SignInInput; layer: Layer.Layer<Navigation> }) =>
 *     AtomMachine.bind(Atom.runtime(Layer.provideMerge(layer, AppLayer))).make(SignInMachine, input)
 * )
 *
 * <SignIn.Provider input={input} layer={navigationLayer(router)}>...</SignIn.Provider>
 * ```
 *
 * @category constructors
 * @since 0.32.0
 */
export const createMachineContext: <Args extends MachineContext.Args, A extends AtomMachine.MachineAtom.Any>(
  create: ((...args: Args) => A) & MachineContext.EnsureOptions<NoInfer<Args>>
) => MachineContext<Args, A> = internal.createMachineContext
