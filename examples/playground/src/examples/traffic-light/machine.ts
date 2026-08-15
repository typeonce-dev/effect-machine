import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const TrafficLightEvent = Schema.TaggedUnion({
  Reset: {}
})

export const trafficLightDurations = {
  Red: 4_000,
  RedYellow: 1_000,
  Green: 4_000,
  Yellow: 1_500
} as const

export const TrafficLightStates = Machine.defineStates({
  Red: {},
  RedYellow: {},
  Green: {},
  Yellow: {}
})

const definition = Machine.make({
  id: "TrafficLight",
  states: TrafficLightStates.states,
  events: [TrafficLightEvent],
  initial: () => TrafficLightStates.initial.Red.from()
})

export const TrafficLightEvents = Machine.events(definition)
export const TrafficLightMachine = definition.handle({
  Red: {
    invoke: Machine.invoke({
      id: "red-timer",
      after: trafficLightDurations.Red,
      onDone: ({ target }) => target.full.RedYellow.from()
    }),
    on: {
      Reset: {
        reenter: true,
        transition: ({ target }) => target.full.Red.from()
      }
    }
  },
  RedYellow: {
    invoke: Machine.invoke({
      id: "red-yellow-timer",
      after: trafficLightDurations.RedYellow,
      onDone: ({ target }) => target.full.Green.from()
    }),
    on: {
      Reset: ({ target }) => target.full.Red.from()
    }
  },
  Green: {
    invoke: Machine.invoke({
      id: "green-timer",
      after: trafficLightDurations.Green,
      onDone: ({ target }) => target.full.Yellow.from()
    }),
    on: {
      Reset: ({ target }) => target.full.Red.from()
    }
  },
  Yellow: {
    invoke: Machine.invoke({
      id: "yellow-timer",
      after: trafficLightDurations.Yellow,
      onDone: ({ target }) => target.full.Red.from()
    }),
    on: {
      Reset: ({ target }) => target.full.Red.from()
    }
  }
})
