/**
 * Startup snapshots planned without running a machine.
 *
 * Server reads of atom bridges render these snapshots instead of starting the
 * runtime. Every function here is synchronous, executes no machine command and
 * reports a plan that cannot be produced synchronously as `undefined`.
 *
 * @internal
 */

import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { ChildMachine, ChildOwner, Machine, RuntimeSnapshot } from "../../Machine.js"
import * as Configuration from "./configuration.js"
import { StoppedError } from "./errors.js"
import * as InvocationDefinition from "./invocationDefinition.js"
import * as Planner from "./planner.js"
import * as Serialization from "./serialization.js"

/** A machine paired with the runtime snapshot it is planned to start with. */
export interface PlannedSnapshot {
  readonly machine: Machine.Any
  readonly snapshot: RuntimeSnapshot<Machine.Snapshot<any>, never, unknown>
}

/**
 * Plans the snapshot a fresh start settles into, following the generic
 * planner. Startup commands are planned and discarded.
 */
export const planStart = (machine: Machine.Any, args: ReadonlyArray<unknown>): PlannedSnapshot | undefined => {
  try {
    const planned = Planner.planInitialSync(machine, ...args)
    return {
      machine,
      snapshot: planned.done
        ? { status: "done", state: planned.state, output: planned.output }
        : { status: "active", state: planned.state }
    }
  } catch {
    return undefined
  }
}

/** Plans the snapshot a resumed machine starts from. */
export const planResume = (machine: Machine.Any, snapshot: Machine.Snapshot<any>): PlannedSnapshot | undefined => {
  try {
    const normalized = Effect.runSyncExit(Serialization.normalizeSnapshotEffect(machine, snapshot))
    if (normalized._tag === "Failure") return undefined
    const state = normalized.value
    if (!Planner.isFinalState(machine, state)) {
      return { machine, snapshot: { status: "active", state } }
    }
    const output = Effect.runSyncExit(Planner.getFinalOutputEffect(machine, state, Planner.InitialEvent))
    return output._tag === "Success"
      ? { machine, snapshot: { status: "done", state, output: output.value } }
      : undefined
  } catch {
    return undefined
  }
}

// Input mappers are synchronous. Child operations they capture only run inside
// a live runtime, so a planned read exposes an owner that refuses them.
const unavailableChildren: ChildOwner<unknown> = {
  spawn: () => Effect.die(new Error("Child operations are unavailable in a planned snapshot")),
  sendTo: () => Effect.fail(new StoppedError()),
  stop: () => Effect.void
}

/**
 * Plans the start of a fixed child descriptor invoked by the parent's planned
 * configuration, mirroring the runtime's initial invocation order and entry
 * context. `Option.none()` means the planned parent does not invoke it.
 */
export const planInvokedChild = (
  parent: PlannedSnapshot,
  descriptor: ChildMachine.Any
): Option.Option<PlannedSnapshot> | undefined => {
  if (parent.snapshot.status !== "active") return Option.none()
  try {
    const machine = parent.machine
    const configuration = Configuration.normalizeConfigurationSync(machine, parent.snapshot.state)
    for (const path of Configuration.getInitialEntryPaths(machine, configuration)) {
      const handlers = Configuration.getStateConfigByPath(machine, path)
      for (const definition of InvocationDefinition.definitions(handlers?.invoke)) {
        if (
          !("child" in definition) || definition.child.id !== descriptor.id ||
          definition.child.machine !== descriptor.machine
        ) continue
        const child = descriptor.machine
        let input: unknown = undefined
        if ("input" in definition) {
          input = typeof definition.input === "function"
            ? definition.input({
              ...(Configuration.getMachineReferences(configuration) ??
                Planner.resolveMachineReferences(machine, configuration)),
              children: unavailableChildren,
              state: configuration.values.get(path),
              containingState: Configuration.getParentValue(machine, configuration, path),
              ancestors: Configuration.getParentValues(machine, configuration, path),
              event: Planner.InitialEvent
            })
            : definition.input
        }
        const planned = planStart(child, child.input === undefined ? [] : [input])
        return planned === undefined ? undefined : Option.some(planned)
      }
    }
    return Option.none()
  } catch {
    return undefined
  }
}
