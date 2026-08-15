import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

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
  initial: () =>
    MicrowaveStates.initial.Oven.from((oven) =>
      oven
        .engine.from((engine) => engine.Idle.from())
        .door.from((door) => door.Closed.from())
    )
})

export const MicrowaveMachine = definition.handle({
  Oven: {
    states: {
      engine: {
        states: {
          Idle: {
            on: {
              PowerPressed: ({ snapshot, target }) =>
                MicrowaveStates.matches(snapshot, "Oven.door.Closed")
                  ? target.local.Cooking.from({ elapsedSeconds: 0 })
                  : target.none()
            }
          },
          Cooking: {
            invoke: Machine.invoke({
              id: "cooking-second",
              after: "1 second",
              onDone: ({ state, target }) => target.local.Cooking.from({ elapsedSeconds: state.elapsedSeconds + 1 })
            }),
            on: {
              PowerPressed: ({ target }) => target.local.Idle.from(),
              DoorOpened: ({ target }) => target.local.Idle.from()
            }
          }
        }
      },
      door: {
        states: {
          Closed: {
            on: {
              DoorOpened: ({ target }) => target.local.Open.from()
            }
          },
          Open: {
            on: {
              DoorClosed: ({ target }) => target.local.Closed.from()
            }
          }
        }
      }
    }
  }
})
