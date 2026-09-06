import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

const internalEvents = Machine.internalEvents(Schema.TaggedStruct("Loaded", {}))
const machine = Machine.make({
  states: { Idle: {} },
  events: Machine.events(),
  internalEvents,
  initial: (to) => to.Idle()
}).handle({ Idle: { on: { Loaded: (to) => to.none } } })

export const canLoad = Effect.gen(function*() {
  const initial = yield* Machine.planInitial(machine)
  return yield* Machine.can(machine, initial.state, internalEvents.Loaded())
})
