import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const TurnstileEvent = Schema.TaggedUnion({
  CoinInserted: {},
  GatePushed: {}
})

export const TurnstileStates = Machine.defineStates({
  Locked: {},
  Unlocked: {}
})

export const TurnstileMachine = Machine.make({
  id: "Turnstile",
  states: TurnstileStates.states,
  events: [TurnstileEvent],
  initial: () => TurnstileStates.initial.Locked.from()
}).handle({
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
