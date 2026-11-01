/**
 * Internal machine command collection.
 *
 * @since 0.4.0
 */

import type { Command, Enqueue, Machine } from "../../Machine.js"
import { decodeEmitSync, decodeEventSync } from "./protocol.js"

export type RuntimeCommand = Command

/** Destination accepted by `Enqueue.sendTo`, erased over the child's event type. */
export type SendToTarget = Extract<RuntimeCommand, { readonly _tag: "SendTo" }>["target"]

/** Child accepted by `Enqueue.stop`, erased over the child's event type. */
export type StopTarget = Extract<RuntimeCommand, { readonly _tag: "Stop" }>["child"]

export interface Collected<Event> {
  readonly enqueue: Enqueue<Event, unknown>
  readonly commands: Array<RuntimeCommand>
  readonly raisedEvents: Array<Event>
  readonly emittedEvents: Array<unknown>
}

export const makeCollector = <Event>(machine: Machine.Any): Collected<Event> => {
  const commands: Array<RuntimeCommand> = []
  const raisedEvents: Array<Event> = []
  const emittedEvents: Array<unknown> = []
  return {
    commands,
    raisedEvents,
    emittedEvents,
    enqueue: {
      raise: (event) => {
        raisedEvents.push(decodeEventSync(machine, event) as Event)
      },
      emit: (event) => {
        emittedEvents.push(decodeEmitSync(machine, event))
      },
      sendTo: (target: SendToTarget, event: unknown) => {
        commands.push({ _tag: "SendTo", target, event })
      },
      stop: (child: StopTarget) => {
        commands.push({ _tag: "Stop", child })
      }
    }
  }
}
