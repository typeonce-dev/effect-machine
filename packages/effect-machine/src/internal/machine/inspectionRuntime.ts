/**
 * Root-scoped live inspection publication and evidence projection.
 *
 * @since 0.13.0
 */

import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"
import * as Stream from "effect/Stream"
import type { Inspection } from "../../Machine.js"

export type Draft<Event extends Inspection.Event = Inspection.Event> = Event extends Inspection.Event
  ? Omit<Event, "sequence" | "rootSessionId">
  : never

export interface Runtime {
  readonly rootSessionId: string
  readonly stream: Stream.Stream<Inspection.Event>
  readonly isActive: () => boolean
  readonly nextDeliveryId: () => number
  readonly nextMacrostepId: () => number
  readonly publishUnsafe: (event: Draft) => void
  readonly close: Effect.Effect<void>
}

export const make = (rootSessionId: string): Effect.Effect<Runtime> =>
  Effect.gen(function*() {
    const pubsub = yield* PubSub.unbounded<Inspection.Event>()
    let subscribers = 0
    let sequence = 0
    let deliveryId = 0
    let macrostepId = 0
    return {
      rootSessionId,
      stream: Stream.fromPubSub(pubsub).pipe(
        Stream.onStart(Effect.sync(() => {
          subscribers += 1
        })),
        Stream.ensuring(Effect.sync(() => {
          subscribers -= 1
        }))
      ),
      isActive: () => subscribers > 0,
      nextDeliveryId: () => deliveryId++,
      nextMacrostepId: () => macrostepId++,
      publishUnsafe: (event) => {
        if (subscribers === 0) return
        PubSub.publishUnsafe(pubsub, {
          ...event,
          sequence: sequence++,
          rootSessionId
        } as Inspection.Event)
      },
      close: PubSub.shutdown(pubsub)
    }
  })

export const endpoint = (
  target: { readonly id: string; readonly sessionId: string }
): Inspection.Endpoint => ({
  id: target.id,
  sessionId: target.sessionId
})

const commands = (values: ReadonlyArray<unknown>): ReadonlyArray<Inspection.Command> =>
  values.flatMap((command): ReadonlyArray<Inspection.Command> => {
    if (typeof command !== "object" || command === null || !("_tag" in command)) return []
    if (command._tag === "SendTo" && "target" in command && "event" in command) {
      const target = command.target
      return typeof target === "object" && target !== null && "id" in target
        ? [{
          _tag: "SendTo",
          target: "sessionId" in target ? endpoint(target as any) : { id: String(target.id) },
          event: command.event
        }]
        : []
    }
    if (command._tag === "Stop" && "child" in command) {
      const child = command.child
      if (typeof child === "string") return [{ _tag: "Stop", target: { id: child } }]
      return typeof child === "object" && child !== null && "id" in child
        ? [{ _tag: "Stop", target: "sessionId" in child ? endpoint(child as any) : { id: String(child.id) } }]
        : []
    }
    return []
  })

export const microsteps = (plan: unknown): ReadonlyArray<Inspection.Microstep> => {
  if (typeof plan !== "object" || plan === null || !("microsteps" in plan) || !Array.isArray(plan.microsteps)) {
    return []
  }
  return plan.microsteps.map((step: any) => ({
    event: step.event,
    transitions: Array.isArray(step.transitions) ? step.transitions : [],
    raisedEvents: Array.isArray(step.raisedEvents) ? step.raisedEvents : [],
    emittedEvents: Array.isArray(step.emittedEvents) ? step.emittedEvents : [],
    commands: commands(Array.isArray(step.commands) ? step.commands : []),
    exitPaths: Array.isArray(step.exitPaths) ? step.exitPaths : [],
    entryPaths: Array.isArray(step.entryPaths) ? step.entryPaths : [],
    changed: step.changed === true
  }))
}
