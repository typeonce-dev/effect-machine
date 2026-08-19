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
  initial: (to) => to.Locked().resolve(({ target }) => target.from())
}).handle({
  Locked: {
    on: {
      CoinInserted: (to) => to.full.Unlocked().resolve(({ target }) => target.from())
    }
  },
  Unlocked: {
    on: {
      GatePushed: (to) => to.full.Locked().resolve(({ target }) => target.from())
    }
  }
})
