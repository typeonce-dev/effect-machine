import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const MicrowaveState = Schema.TaggedUnion({
  Oven: {},
  Engine: {},
  Idle: {},
  Cooking: { elapsedSeconds: Schema.Number },
  Door: {},
  Closed: {},
  Open: {}
})

export const MicrowaveEvent = Schema.TaggedUnion({
  PowerPressed: {},
  DoorOpened: {},
  DoorClosed: {}
})

export const MicrowaveInternalEvent = Schema.TaggedUnion({
  SecondElapsed: {}
})

export const MicrowaveStates = Machine.defineStates({
  Oven: {
    schema: MicrowaveState.cases.Oven,
    type: "parallel",
    states: {
      engine: {
        schema: MicrowaveState.cases.Engine,
        initial: "Idle",
        states: {
          Idle: MicrowaveState.cases.Idle,
          Cooking: MicrowaveState.cases.Cooking
        }
      },
      door: {
        schema: MicrowaveState.cases.Door,
        initial: "Closed",
        states: {
          Closed: MicrowaveState.cases.Closed,
          Open: MicrowaveState.cases.Open
        }
      }
    }
  }
})

const secondElapsed = MicrowaveInternalEvent.cases.SecondElapsed.make({})

export const MicrowaveMachine = Machine.make({
  id: "Microwave",
  states: MicrowaveStates.states,
  events: [MicrowaveEvent],
  internalEvents: [MicrowaveInternalEvent],
  initial: () =>
    MicrowaveStates.initial.Oven.from((oven) =>
      oven
        .engine.from((engine) => engine.Idle.from())
        .door.from((door) => door.Closed.from())
    )
}).handle({
  Oven: {
    states: {
      engine: {
        states: {
          Idle: {
            on: {
              PowerPressed: ({ snapshot, target }) =>
                MicrowaveStates.matches(snapshot, "Oven.door.Closed")
                  ? target.local.Cooking.from({ elapsedSeconds: 0 })
                  : undefined
            }
          },
          Cooking: {
            invoke: Machine.after("1 second", secondElapsed, { id: "cooking-second" }),
            on: {
              PowerPressed: ({ target }) => target.local.Idle.from(),
              DoorOpened: ({ target }) => target.local.Idle.from(),
              SecondElapsed: {
                reenter: true,
                transition: ({ state, target }) =>
                  target.local.Cooking.from({ elapsedSeconds: state.elapsedSeconds + 1 })
              }
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
