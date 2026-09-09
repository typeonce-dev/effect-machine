import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

const internalEvents = Machine.internalEventsFromSchemas(Schema.TaggedStruct("Loaded", {}))
const Root = Machine.state({ states: { Idle: {} } })
const machine = Machine.make({
  root: Root,
  events: Machine.eventsFromSchemas(),
  internalEvents
}).handle({
  initial: { target: Machine.targets(Root).root.Idle },
  states: { Idle: { on: { Loaded: { none: true } } } }
})

export const canLoad = Effect.gen(function*() {
  const initial = yield* Machine.planInitial(machine)
  return yield* Machine.can(machine, initial.state, internalEvents.Loaded())
})
