import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const MicrowaveState = Schema.TaggedUnion({
  Cooking: { elapsedSeconds: Schema.Number }
})

export const MicrowaveEvents = Machine.events(
  Schema.TaggedUnion({
    PowerPressed: {},
    DoorOpened: {},
    DoorClosed: {}
  })
)

export const MicrowaveStates = Machine.states({
  Oven: {
    initial: "Closed",
    states: {
      Closed: {
        initial: "Idle",
        states: {
          Idle: {},
          Cooking: MicrowaveState.cases.Cooking
        }
      },
      Open: {}
    }
  }
})

export const MicrowaveMachine = Machine.make({
  id: "Microwave",
  states: MicrowaveStates.states,
  events: MicrowaveEvents,
  initial: (to) =>
    to.Oven.initial.resolve(({ target }) => target.from((oven) => oven.Closed.from((closed) => closed.Idle.from())))
}).handle({
  Oven: {
    states: {
      Closed: {
        on: {
          DoorOpened: (to) => to.branch.Oven.Open().resolve(({ target }) => target.from())
        },
        states: {
          Idle: {
            on: {
              PowerPressed: (to) => to.local.Cooking().resolve(({ target }) => target.from({ elapsedSeconds: 0 }))
            }
          },
          Cooking: {
            invoke: (from) =>
              from.timer("cooking-second", "1 second").onDone((to) =>
                to.local.Cooking().resolve(({ state, target }) =>
                  target.from({ elapsedSeconds: state.elapsedSeconds + 1 })
                )
              ),
            on: {
              PowerPressed: (to) => to.local.Idle().resolve(({ target }) => target.from())
            }
          }
        }
      },
      Open: {
        on: {
          DoorClosed: (to) => to.local.Closed.initial
        }
      }
    }
  }
})
