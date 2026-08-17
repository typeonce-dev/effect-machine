import { Machine } from "@typeonce/effect-machine"
import { Option, Schema } from "effect"

export const MicrowaveState = Schema.TaggedUnion({
  Cooking: { elapsedSeconds: Schema.Number }
})

const MicrowaveEvent = Schema.TaggedUnion({
  PowerPressed: {},
  DoorOpened: {},
  DoorClosed: {}
})

export const MicrowaveEvents = Machine.events(MicrowaveEvent)

export const MicrowaveStates = Machine.defineStates({
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

const definition = Machine.make({
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
})

export const MicrowaveMachine = definition.handle({
  Oven: {
    states: {
      engine: {
        states: {
          Idle: {
            on: {
              PowerPressed: Machine.transition({
                cases: [{
                  title: "door closed",
                  when: ({ snapshot }) =>
                    MicrowaveStates.matches(snapshot, "Oven.door.Closed")
                      ? Option.some(undefined)
                      : Option.none(),
                  target: (to) => to.local.Cooking(),
                  resolve: ({ target }) => target.from({ elapsedSeconds: 0 })
                }],
                otherwise: { target: (to) => to.none(), resolve: () => undefined }
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
