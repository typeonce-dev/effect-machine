/**
 * Capabilities the model declares and a host provides to the work it runs.
 *
 * @since 0.48.0
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type {
  ChildAddress,
  ChildAlreadyExistsError,
  ChildMachine,
  Logic,
  MachineRef,
  SpawnOptions,
  StoppedError
} from "../../Machine.js"

/**
 * Capability to act on the processes of the running machine, required by
 * `spawn`, and by `sendTo` and `stopChild` with a child address.
 *
 * **When to use**
 *
 * Name this requirement when annotating a reusable helper built from those
 * operations, or when exporting a value whose inferred type includes it.
 *
 * **Details**
 *
 * The model declares this capability, and a host provides it to the work it
 * runs. `LocalMachine` provides it, also when `AtomMachine` hosts the machine.
 *
 * `Machine.Machine.Services` contains it when the Effect, Stream, or `Logic` that
 * a state invokes requires it, or when the machine of an invoked child does. A
 * host that provides it runs every process that the work spawns, whatever that
 * process invokes. `LocalMachine.RequiredServices` removes it.
 *
 * **Gotchas**
 *
 * `ClusterMachine` does not provide it, so `ClusterMachine.make` does not compile
 * for a machine whose services contain it.
 *
 * Only the type is public: hosts of this library provide the service, and it
 * cannot be constructed elsewhere.
 *
 * @category services
 * @since 0.47.0
 */
export class MachineRuntime extends Context.Service<MachineRuntime, {
  /**
   * Starts process logic as a child owned by the running machine.
   */
  readonly spawn: <State, Event, Error, Requirements, Output, InitialError>(
    logic: Logic<State, Event, Error, Requirements, Output, InitialError>,
    options?: SpawnOptions
  ) => Effect.Effect<
    MachineRef<State, Event, Error, Output>,
    ChildAlreadyExistsError | InitialError,
    Exclude<Requirements, Scope.Scope>
  >

  /**
   * Sends an event to an active child of the running machine. A missing child is
   * ignored.
   */
  readonly sendTo: (
    child: ChildMachine.Any | ChildAddress<never>,
    event: unknown
  ) => Effect.Effect<void, StoppedError>

  /**
   * Stops an active child of the running machine. A missing child is ignored.
   */
  readonly stopChild: (child: ChildMachine.Any | ChildAddress<never>) => Effect.Effect<void>
}>()("effect/Machine/MachineRuntime") {}

/**
 * Capability to act on the child machines that the states of the running
 * machine invoke, required by `sendTo` and `stopChild` with the descriptor of a
 * child machine.
 *
 * **When to use**
 *
 * Name this requirement when annotating a reusable helper built from those
 * operations, or when exporting a value whose inferred type includes it.
 *
 * **Details**
 *
 * The model declares this capability, and a host provides it to the work it
 * runs. `LocalMachine` and `ClusterMachine` provide it, also when `AtomMachine`
 * hosts the machine. Unlike {@link MachineRuntime}, it starts no process, so a
 * host that runs child machines provides it.
 *
 * `Machine.Machine.Services` contains it when the work that a state invokes
 * requires it, or when the machine of an invoked child does.
 * `LocalMachine.RequiredServices` removes it.
 *
 * **Gotchas**
 *
 * Only the type is public: hosts of this library provide the service, and it
 * cannot be constructed elsewhere.
 *
 * @category services
 * @since 0.48.0
 */
export class ChildMachineRuntime extends Context.Service<ChildMachineRuntime, {
  /**
   * Sends an event to the child that runs for a descriptor. A child that does
   * not run is ignored.
   */
  readonly sendTo: (child: ChildMachine.Any, event: unknown) => Effect.Effect<void, StoppedError>

  /** Stops the child that runs for a descriptor. A child that does not run is ignored. */
  readonly stopChild: (child: ChildMachine.Any) => Effect.Effect<void>
}>()("effect/Machine/ChildMachineRuntime") {}
