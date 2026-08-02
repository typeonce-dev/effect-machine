import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const TurnstileState = Schema.TaggedUnion({
  Locked: {},
  Unlocked: {}
})

export const TurnstileEvent = Schema.TaggedUnion({
  CoinInserted: {},
  GatePushed: {}
})

export const TurnstileStates = Machine.defineStates(TurnstileState.cases)

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
