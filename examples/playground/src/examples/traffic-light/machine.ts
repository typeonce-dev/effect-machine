import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const TrafficLightEvents = Machine.events(
  Schema.TaggedUnion({
    Reset: {}
  })
)

export const trafficLightDurations = {
  Red: 4_000,
  RedYellow: 1_000,
  Green: 4_000,
  Yellow: 1_500
} as const

export const TrafficLightStates = Machine.states({
  Red: {},
  RedYellow: {},
  Green: {},
  Yellow: {}
})

export const TrafficLightMachine = Machine.make({
  id: "TrafficLight",
  states: TrafficLightStates.states,
  events: TrafficLightEvents,
  initial: {
    target: (to) => to.Red(),
    resolve: ({ target }) => target.from()
  }
}).handle({
  Red: {
    invoke: Machine.invoke({
      id: "red-timer",
      after: trafficLightDurations.Red,
      onDone: Machine.transition({
        target: (to) => to.full.RedYellow(),
        resolve: ({ target }) => target.from()
      })
    }),
    on: {
      Reset: Machine.transition({
        target: (to) => to.full.Red(),
        resolve: ({ target }) => target.from(),
        reenter: true
      })
    }
  },
  RedYellow: {
    invoke: Machine.invoke({
      id: "red-yellow-timer",
      after: trafficLightDurations.RedYellow,
      onDone: Machine.transition({
        target: (to) => to.full.Green(),
        resolve: ({ target }) => target.from()
      })
    }),
    on: {
      Reset: Machine.transition({
        target: (to) => to.full.Red(),
        resolve: ({ target }) => target.from()
      })
    }
  },
  Green: {
    invoke: Machine.invoke({
      id: "green-timer",
      after: trafficLightDurations.Green,
      onDone: Machine.transition({
        target: (to) => to.full.Yellow(),
        resolve: ({ target }) => target.from()
      })
    }),
    on: {
      Reset: Machine.transition({
        target: (to) => to.full.Red(),
        resolve: ({ target }) => target.from()
      })
    }
  },
  Yellow: {
    invoke: Machine.invoke({
      id: "yellow-timer",
      after: trafficLightDurations.Yellow,
      onDone: Machine.transition({
        target: (to) => to.full.Red(),
        resolve: ({ target }) => target.from()
      })
    }),
    on: {
      Reset: Machine.transition({
        target: (to) => to.full.Red(),
        resolve: ({ target }) => target.from()
      })
    }
  }
})
