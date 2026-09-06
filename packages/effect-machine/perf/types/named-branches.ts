import { Machine } from "../../dist/index.js"
import { machine, State } from "./named-branches-control.js"

const handled = machine.handle({
  states: {
    Idle: {
      on: {
        Route: (to) =>
          to.branches({
            length1: { target: to.branch.Text() },
            length2: { target: to.branch.Count() },
            length3: { target: to.branch.Text() },
            length4: { target: to.branch.Count() },
            length5: { target: to.branch.Text() },
            length6: { target: to.none },
            length7: { target: to.branch.Count() },
            length8: { target: to.branch.Text() },
            length9: { target: to.branch.Count() },
            length10: { target: to.branch.Idle() },
            unchanged: { target: to.none }
          }).resolve(({ event, select }) => {
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
          })
      }
    },
    Text: {},
    Count: {}
  }
})

void Machine.planInitial(handled)
