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
    type: "parallel",
    states: {
      engine: {
        initial: "Idle",
        states: {
          Idle: {},
          Cooking: MicrowaveState.cases.Cooking
        }
      },
      door: {
        initial: "Closed",
        states: {
          Closed: {},
          Open: {}
        }
      }
    }
  }
})

export const MicrowaveMachine = Machine.make({
  id: "Microwave",
  states: MicrowaveStates.states,
  events: MicrowaveEvents,
  initial: {
    target: (to) => to.Oven.initial(),
    resolve: ({ target }) =>
      target.from((oven) =>
        oven
          .engine.from((engine) => engine.Idle.from())
          .door.from((door) => door.Closed.from())
      )
  }
}).handle({
  Oven: {
    states: {
      engine: {
        states: {
          Idle: {
            on: {
              PowerPressed: Machine.transition({
                branches: (to) => ({
                  doorClosed: { title: "Door closed", target: to.local.Cooking() },
                  unchanged: { target: to.none() }
                }),
                resolve: ({ snapshot, select }) =>
                  MicrowaveStates.matches(snapshot, "Oven.door.Closed")
                    ? select.doorClosed.from({ elapsedSeconds: 0 })
                    : select.unchanged()
              })
            }
          },
          Cooking: {
            invoke: Machine.invoke({
              id: "cooking-second",
              after: "1 second",
              onDone: Machine.transition({
                target: (to) => to.local.Cooking(),
                resolve: ({ state, target }) => target.from({ elapsedSeconds: state.elapsedSeconds + 1 })
              })
            }),
            on: {
              PowerPressed: Machine.transition({
                target: (to) => to.local.Idle(),
                resolve: ({ target }) => target.from()
              }),
              DoorOpened: Machine.transition({
                target: (to) => to.local.Idle(),
                resolve: ({ target }) => target.from()
              })
            }
          }
        }
      },
      door: {
        states: {
          Closed: {
            on: {
              DoorOpened: Machine.transition({
                target: (to) => to.local.Open(),
                resolve: ({ target }) => target.from()
              })
            }
          },
          Open: {
            on: {
              DoorClosed: Machine.transition({
                target: (to) => to.local.Closed(),
                resolve: ({ target }) => target.from()
              })
            }
          }
        }
      }
    }
  }
})
