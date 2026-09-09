import { Machine } from "../../dist/index.js"
import { Route, State, States } from "./named-branches-control.js"
const targets = Machine.targets(States)
const machine = Machine.make({
  branches: {
    route: {
      length1: { target: targets.root.Text },
      length2: { target: targets.root.Count },
      length3: { target: targets.root.Text },
      length4: { target: targets.root.Count },
      length5: { target: targets.root.Text },
      length6: { none: true },
      length7: { target: targets.root.Count },
      length8: { target: targets.root.Text },
      length9: { target: targets.root.Count },
      length10: { target: targets.root.Idle },
      unchanged: { none: true }
    }
  },
  root: States,
  events: Machine.eventsFromSchemas(Route)
})
const handled = machine.handle({
  initial: { target: targets.root.Idle },
  states: {
    Idle: {
      on: {
        Route: {
          branches: "route",
          resolve: ({ event, select }) => {
            const value = event.value
            switch (value.length) {
              case 1:
                return select.length1.from(State.cases.Text.make({ value }))
              case 2:
                return select.length2.from(State.cases.Count.make({ value: value.length }))
              case 3:
                return select.length3.from(State.cases.Text.make({ value }))
              case 4:
                return select.length4.from(State.cases.Count.make({ value: value.length }))
              case 5:
                return select.length5.from(State.cases.Text.make({ value }))
              case 6:
                return select.length6()
              case 7:
                return select.length7.from(State.cases.Count.make({ value: value.length }))
              case 8:
                return select.length8.from(State.cases.Text.make({ value: value.toUpperCase() }))
              case 9:
                return select.length9.from(State.cases.Count.make({ value: value.length }))
              case 10:
                return select.length10.from(State.cases.Idle.make({}))
              default:
                return select.unchanged()
            }
          }
        }
      }
    },
    Text: {},
    Count: {}
  }
})
void Machine.planInitial(handled)
