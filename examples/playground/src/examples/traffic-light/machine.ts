import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const TrafficLightState = Schema.TaggedUnion({
  Red: {},
  RedYellow: {},
  Green: {},
  Yellow: {}
})

export const TrafficLightEvent = Schema.TaggedUnion({
  Reset: {}
})

export const TrafficLightInternalEvent = Schema.TaggedUnion({
  TimerElapsed: {}
})

export const trafficLightDurations = {
  Red: 4_000,
  RedYellow: 1_000,
  Green: 4_000,
  Yellow: 1_500
} as const

export const TrafficLightStates = Machine.defineStates(TrafficLightState.cases)

const elapsed = TrafficLightInternalEvent.cases.TimerElapsed.make({})

export const TrafficLightMachine = Machine.make({
  id: "TrafficLight",
  states: TrafficLightStates.states,
  events: [TrafficLightEvent],
  internalEvents: [TrafficLightInternalEvent],
  initial: () => TrafficLightStates.initial.Red.from()
}).handle({
  Red: {
    invoke: Machine.after(trafficLightDurations.Red, elapsed),
    on: {
      Reset: {
        reenter: true,
        transition: ({ target }) => target.full.Red.from()
      },
      TimerElapsed: ({ target }) => target.full.RedYellow.from()
    }
  },
  RedYellow: {
    invoke: Machine.after(trafficLightDurations.RedYellow, elapsed),
    on: {
      Reset: ({ target }) => target.full.Red.from(),
      TimerElapsed: ({ target }) => target.full.Green.from()
    }
  },
  Green: {
    invoke: Machine.after(trafficLightDurations.Green, elapsed),
    on: {
      Reset: ({ target }) => target.full.Red.from(),
      TimerElapsed: ({ target }) => target.full.Yellow.from()
    }
  },
  Yellow: {
    invoke: Machine.after(trafficLightDurations.Yellow, elapsed),
    on: {
      Reset: ({ target }) => target.full.Red.from(),
      TimerElapsed: ({ target }) => target.full.Red.from()
    }
  }
})
