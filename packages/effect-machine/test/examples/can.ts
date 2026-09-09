import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

const internalEvents = Machine.internalEventsFromSchemas(Schema.TaggedStruct("Loaded", {}))
const machine = Machine.make({
  root: Machine.state({ initial: "Idle", states: { Idle: {} } }),
  events: Machine.eventsFromSchemas(),
  internalEvents,
  initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.from()))
}).handle({ states: { Idle: { on: { Loaded: { none: true } } } } })

export const canLoad = Effect.gen(function*() {
  const initial = yield* Machine.planInitial(machine)
  return yield* Machine.can(machine, initial.state, internalEvents.Loaded())
})
