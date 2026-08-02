import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const TrafficLightState = Schema.TaggedUnion({
  Red: {},
  RedYellow: {},
  Green: {},
  Yellow: {}
})

export const TrafficLightEvent = Schema.TaggedUnion({
  TimerElapsed: {}
})

export const TrafficLightStates = Machine.defineStates(TrafficLightState.cases)

export const TrafficLightMachine = Machine.make({
  id: "TrafficLight",
  states: TrafficLightStates.states,
  events: [TrafficLightEvent],
  initial: () => TrafficLightStates.initial.Red(TrafficLightState.cases.Red.make({}))
}).handle({
  Red: {
    on: {
      TimerElapsed: ({ target }) => target.full.RedYellow(TrafficLightState.cases.RedYellow.make({}))
    }
  },
  RedYellow: {
    on: {
      TimerElapsed: ({ target }) => target.full.Green(TrafficLightState.cases.Green.make({}))
    }
  },
  Green: {
    on: {
      TimerElapsed: ({ target }) => target.full.Yellow(TrafficLightState.cases.Yellow.make({}))
    }
  },
  Yellow: {
    on: {
      TimerElapsed: ({ target }) => target.full.Red(TrafficLightState.cases.Red.make({}))
    }
  }
})
