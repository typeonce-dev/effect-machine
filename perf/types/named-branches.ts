import { Machine } from "@typeonce/effect-machine"
import { machine, State } from "./named-branches-control.js"

const handled = machine.handle({
  Idle: {
    on: {
      Route: (to) =>
        to.branches({
          length1: { target: to.full.Text() },
          length2: { target: to.full.Count() },
          length3: { target: to.full.Text() },
          length4: { target: to.full.Count() },
          length5: { target: to.full.Text() },
          length6: { target: to.none },
          length7: { target: to.full.Count() },
          length8: { target: to.full.Text() },
          length9: { target: to.full.Count() },
          length10: { target: to.full.Idle() },
          unchanged: { target: to.none }
        }).resolve(({ event, select }) => {
          const value = event.value
          switch (value.length) {
            case 1:
              return select.length1(State.cases.Text.make({ value }))
            case 2:
              return select.length2(State.cases.Count.make({ value: value.length }))
            case 3:
              return select.length3(State.cases.Text.make({ value }))
            case 4:
              return select.length4(State.cases.Count.make({ value: value.length }))
            case 5:
              return select.length5(State.cases.Text.make({ value }))
            case 6:
              return select.length6()
            case 7:
              return select.length7(State.cases.Count.make({ value: value.length }))
            case 8:
              return select.length8(State.cases.Text.make({ value: value.toUpperCase() }))
            case 9:
              return select.length9(State.cases.Count.make({ value: value.length }))
            case 10:
              return select.length10(State.cases.Idle.make({}))
            default:
              return select.unchanged()
          }
        })
    }
  },
  Text: {},
  Count: {}
})

void Machine.planInitial(handled)
