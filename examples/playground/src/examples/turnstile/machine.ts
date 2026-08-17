import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const TurnstileEvents = Machine.events(
  Schema.TaggedUnion({
    CoinInserted: {},
    GatePushed: {}
  })
)

export const TurnstileStates = Machine.defineStates({
  Locked: {},
  Unlocked: {}
})

export const TurnstileMachine = Machine.make({
  id: "Turnstile",
  states: TurnstileStates.states,
  events: TurnstileEvents,
  initial: {
    target: (to) => to.Locked(),
    resolve: ({ target }) => target.from()
  }
}).handle({
  Locked: {
    on: {
      CoinInserted: Machine.transition({
        target: (to) => to.full.Unlocked(),
        resolve: ({ target }) => target.from()
      })
    }
  },
  Unlocked: {
    on: {
      GatePushed: Machine.transition({
        target: (to) => to.full.Locked(),
        resolve: ({ target }) => target.from()
      })
    }
  }
})
