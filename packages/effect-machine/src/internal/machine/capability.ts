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
 * Capability to act on the children of the running machine, required by
 * `spawn`, `sendTo`, and `stopChild`.
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
 * `Machine.Machine.Services` contains it for every machine that invokes work,
 * whether or not that work uses it. `LocalMachine.RequiredServices` removes it.
 *
 * **Gotchas**
 *
 * `ClusterMachine` does not provide it. Its types accept a machine whose work
 * uses the capability, and that work fails the machine with a missing service.
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
