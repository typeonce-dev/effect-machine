import { Machine } from "../../dist/index.js"
import { Route, State, States } from "./named-branches-control.js"
const machine = Machine.make({
  branches: {
    route: {
      length1: { target: "Text" },
      length2: { target: "Count" },
      length3: { target: "Text" },
      length4: { target: "Count" },
      length5: { target: "Text" },
      length6: { none: true },
      length7: { target: "Count" },
      length8: { target: "Text" },
      length9: { target: "Count" },
      length10: { target: "Idle" },
      unchanged: { none: true }
    }
  },
  root: States,
  events: Machine.eventsFromSchemas(Route)
})
const handled = machine.handle({
  initial: { target: "Idle" },
  states: {
    Idle: {
      on: {
        Route: {
          branches: "route",
          resolve: ({ event, select }) => {
            const value = event.value
            switch (value.length) {
              case 1:
                return select.length1({ data: State.cases.Text.make({ value }) })
              case 2:
                return select.length2({ data: State.cases.Count.make({ value: value.length }) })
              case 3:
                return select.length3({ data: State.cases.Text.make({ value }) })
              case 4:
                return select.length4({ data: State.cases.Count.make({ value: value.length }) })
              case 5:
                return select.length5({ data: State.cases.Text.make({ value }) })
              case 6:
                return select.length6()
              case 7:
                return select.length7({ data: State.cases.Count.make({ value: value.length }) })
              case 8:
                return select.length8({ data: State.cases.Text.make({ value: value.toUpperCase() }) })
              case 9:
                return select.length9({ data: State.cases.Count.make({ value: value.length }) })
              case 10:
                return select.length10({ data: State.cases.Idle.make({}) })
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
