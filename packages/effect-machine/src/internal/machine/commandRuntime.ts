/**
 * Internal process-side machine command execution.
 *
 * @since 0.4.0
 */

import * as Effect from "effect/Effect"
import type { Machine, MachineSchemaDecodeError, StoppedError } from "../../Machine.js"
import type { RuntimeCommand } from "./command.js"
import { decodeEmit } from "./protocol.js"
import type { ProcessScope } from "./runtimeProtocol.js"

/** Publishes emissions planned by a machine to its process observers. */
export interface LiveRuntime {
  readonly emit: (event: unknown) => Effect.Effect<void, MachineSchemaDecodeError | StoppedError>
}

export const makeLiveRuntime = <Events>(machine: Machine.Any, scope: ProcessScope<Events>): LiveRuntime => ({
  emit: (event) =>
    decodeEmit(machine, event).pipe(
      Effect.flatMap((event) => scope.emit(event))
    )
})

export const runCommands = <Event>(
  commands: Iterable<RuntimeCommand>,
  scope: ProcessScope<Event>
) =>
  Effect.forEach(commands, (command) =>
    command._tag === "SendTo"
      ? scope.sendTo(command.target as never, command.event)
      : scope.stopChild(command.child as never), { discard: true })

export const runEmittedEvents = (
  events: Iterable<unknown>,
  runtime: LiveRuntime
) =>
  Effect.all(
    Array.from(events, (event) => runtime.emit(event)),
    { discard: true }
  )
