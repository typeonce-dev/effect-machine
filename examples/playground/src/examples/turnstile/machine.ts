import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

const TurnstileEvent = Schema.TaggedUnion({
  CoinInserted: {},
  GatePushed: {}
})

export const TurnstileEvents = Machine.events(TurnstileEvent)

export const TurnstileStates = Machine.defineStates({
  Locked: {},
  Unlocked: {}
})

const definition = Machine.make({
  id: "Turnstile",
  states: TurnstileStates.states,
  events: TurnstileEvents,
  initial: () => TurnstileStates.initial.Locked.from()
})

export const TurnstileMachine = definition.handle({
  Locked: {
    on: {
      CoinInserted: ({ target }) => target.full.Unlocked.from()
    }
  },
  Unlocked: {
    on: {
      GatePushed: ({ target }) => target.full.Locked.from()
    }
  }
})
