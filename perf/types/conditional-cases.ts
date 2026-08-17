import { Machine } from "@typeonce/effect-machine"
import { Option } from "effect"
import { machine, State } from "./conditional-cases-control.js"

const handled = machine.handle({
  Idle: {
    on: {
      Route: Machine.transition({
        cases: (branch) => [
          branch({
            title: "length 1",
            when: ({ event }) => event.value.length === 1 ? Option.some(event.value) : Option.none(),
            target: (to) => to.full.Text(),
            resolve: ({ match, target }) => target(State.cases.Text.make({ value: match }))
          }),
          branch({
            title: "length 2",
            when: ({ event }) => event.value.length === 2 ? Option.some(event.value.length) : Option.none(),
            target: (to) => to.full.Count(),
            resolve: ({ match, target }) => target(State.cases.Count.make({ value: match }))
          }),
          branch({
            title: "length 3",
            when: ({ event }) => event.value.length === 3 ? Option.some({ value: event.value }) : Option.none(),
            target: (to) => to.full.Text(),
            resolve: ({ match, target }) => target(State.cases.Text.make(match))
          }),
          branch({
            title: "length 4",
            when: ({ event }) => event.value.length === 4 ? Option.some([event.value.length] as const) : Option.none(),
            target: (to) => to.full.Count(),
            resolve: ({ match, target }) => target(State.cases.Count.make({ value: match[0] }))
          }),
          branch({
            title: "length 5",
            when: ({ event }) => event.value.length === 5 ? Option.some(event) : Option.none(),
            target: (to) => to.full.Text(),
            resolve: ({ match, target }) => target(State.cases.Text.make({ value: match.value }))
          }),
          branch({
            title: "length 6",
            when: ({ event }) => event.value.length === 6 ? Option.some(true) : Option.none(),
            target: (to) => to.none(),
            resolve: ({ match }) => {
              const confirmed: boolean = match
              void confirmed
              return undefined
            }
          }),
          branch({
            title: "length 7",
            when: ({ event }) => event.value.length === 7 ? Option.some({ size: event.value.length }) : Option.none(),
            target: (to) => to.full.Count(),
            resolve: ({ match, target }) => target(State.cases.Count.make({ value: match.size }))
          }),
          branch({
            title: "length 8",
            when: ({ event }) => event.value.length === 8 ? Option.some(event.value.toUpperCase()) : Option.none(),
            target: (to) => to.full.Text(),
            resolve: ({ match, target }) => target(State.cases.Text.make({ value: match }))
          }),
          branch({
            title: "length 9",
            when: ({ event }) => event.value.length === 9 ? Option.some(event.value.length as 9) : Option.none(),
            target: (to) => to.full.Count(),
            resolve: ({ match, target }) => target(State.cases.Count.make({ value: match }))
          }),
          branch({
            title: "length 10",
            when: ({ event }) => event.value.length === 10 ? Option.some(undefined) : Option.none(),
            target: (to) => to.full.Idle(),
            resolve: ({ target }) => target(State.cases.Idle.make({}))
          })
        ],
        otherwise: {
          target: (to) => to.none(),
          resolve: () => undefined
        }
      })
    }
  },
  Text: {},
  Count: {}
})

void Machine.planInitial(handled)
