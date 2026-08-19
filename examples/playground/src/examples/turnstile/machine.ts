import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const TurnstileEvents = Machine.events(
  Schema.TaggedUnion({
    CoinInserted: {},
    GatePushed: {}
  })
)

export const TurnstileStates = Machine.states({
  Locked: {},
  Unlocked: {}
})

export const TurnstileMachine = Machine.make({
  id: "Turnstile",
  states: TurnstileStates.states,
  events: TurnstileEvents,
  initial: (to) => to.Locked()
}).handle({
  Locked: {
    on: {
      CoinInserted: (to) => to.full.Unlocked()
    }
  },
  Unlocked: {
    on: {
      GatePushed: (to) => to.full.Locked()
    }
  }
})
