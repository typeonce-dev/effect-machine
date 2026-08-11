/**
 * Internal process-side machine command execution.
 *
 * @since 0.4.0
 */

import * as Effect from "effect/Effect"
import type { Machine, Runtime } from "../../Machine.js"
import type { RuntimeCommand } from "./command.js"
import { decodeEmit, decodeEvent } from "./protocol.js"
import type { ProcessScope } from "./runtime.js"

export const makeLiveRuntime = <Events, Emits>(
  machine: Machine.Any,
  scope: ProcessScope<Events>
): Runtime<Events, Emits> => ({
  raise: (event) =>
    decodeEvent(machine, event).pipe(
      Effect.flatMap((event) => scope.self.send(event as Events))
    ),
  sendParent: (event) =>
    decodeEmit(machine, event).pipe(
      Effect.flatMap((event) => scope.sendParent(event))
    )
})

export const runCommands = <Event>(
  commands: Iterable<RuntimeCommand>,
  scope: ProcessScope<Event>
) =>
  Effect.forEach(commands, (command) =>
    command._tag === "SendTo"
      ? scope.sendTo(command.child as never, command.event)
      : scope.stopChild(command.child as never), { discard: true })

export const runEmittedEvents = <Events, Emits>(
  events: Iterable<Emits>,
  runtime: Runtime<Events, Emits>
) =>
  Effect.all(
    Array.from(events, (event) => runtime.sendParent(event)),
    { discard: true }
  )
