/**
 * React ownership and state rendering for machine atoms.
 *
 * @since 0.29.0
 */
"use client"

import type { Machine } from "@typeonce/effect-machine"
import type { AtomMachine } from "@typeonce/effect-machine/reactivity"
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

/** Props for a typed render of one active state path.
 * @category models
 * @since 0.32.0
 */
export interface MachineStateProps<
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Event,
  Error,
  Output,
  StartError,
  Emitted,
  Path extends Machine.Snapshot.Path<State>
> {
  readonly machine: AtomMachine.MachineAtom<State, Event, Error, Output, StartError, Emitted>
  readonly path: Path
  /** Rendered while the machine has no snapshot yet. Defaults to null. */
  readonly pending?: React.ReactNode
  /** Rendered while the path is not active. Defaults to null. */
  readonly inactive?: React.ReactNode
  readonly children: (state: Machine.Snapshot.At<State, NoInfer<Path>>) => React.ReactNode
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
 * @category components
 * @since 0.32.0
 */
export const MachineState: <
  State extends Machine.Machine.AtomicSnapshot<string, unknown>,
  Event,
  Error,
  Output,
  StartError,
  Emitted,
  const Path extends Machine.Snapshot.Path<State>
>(
  props: MachineStateProps<State, Event, Error, Output, StartError, Emitted, Path>
) => React.ReactNode = internal.MachineState

/** An isolated React owner and accessor for a bridge factory.
 * @category models
 * @since 0.32.0
 */
export interface MachineContext<Args extends [] | [unknown], A extends AtomMachine.MachineAtom.Any> {
  readonly Provider: React.ComponentType<
    & { readonly children?: React.ReactNode }
    & (Args extends [] ? { readonly input?: never } : { readonly input: Args[0] })
  >
  readonly useMachine: () => A
}

/**
 * Creates a context from an AtomMachine factory. Each Provider owns a fresh
 * bridge in its current registry. Input is read once at startup; use a new React
 * key for a new owner. The Provider does not subscribe to machine state.
 *
 * @category constructors
 * @since 0.32.0
 */
export const createMachineContext: <Args extends [] | [unknown], A extends AtomMachine.MachineAtom.Any>(
  create: (...args: Args) => A
) => MachineContext<Args, A> = internal.createMachineContext
