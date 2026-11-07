import { Machine } from "../../dist/index.js"
import { Route, State, States } from "./named-branches-control.js"
const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Route)
})
const handled = machine.handle({
  initial: { target: "Idle" },
  states: {
    Idle: {
      on: {
        Route: {
          branches: [{ target: "Text" }, { target: "Count" }, { stay: true }, { target: "Idle" }],
          resolve: ({ event, select }) => {
            const value = event.value
            switch (value.length) {
              case 1:
                return select.target("Text", { data: State.cases.Text.make({ value }) })
              case 2:
                return select.target("Count", { data: State.cases.Count.make({ value: value.length }) })
              case 3:
                return select.target("Text", { data: State.cases.Text.make({ value }) })
              case 4:
                return select.target("Count", { data: State.cases.Count.make({ value: value.length }) })
              case 5:
                return select.target("Text", { data: State.cases.Text.make({ value }) })
              case 6:
                return select.stay()
              case 7:
                return select.target("Count", { data: State.cases.Count.make({ value: value.length }) })
              case 8:
                return select.target("Text", { data: State.cases.Text.make({ value: value.toUpperCase() }) })
              case 9:
                return select.target("Count", { data: State.cases.Count.make({ value: value.length }) })
              case 10:
                return select.target("Idle", { data: State.cases.Idle.make({}) })
              default:
                return select.stay()
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
