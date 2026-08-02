import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const MicrowaveState = Schema.TaggedUnion({
  Oven: { elapsedSeconds: Schema.Number },
  Engine: {},
  Off: {},
  Idle: {},
  Cooking: {},
  Door: {},
  Closed: {},
  Open: {}
})

export const MicrowaveEvent = Schema.TaggedUnion({
  PowerPressed: {},
  DoorOpened: {},
  DoorClosed: {},
  SecondElapsed: {}
})

export const MicrowaveStates = Machine.defineStates({
  Oven: {
    schema: MicrowaveState.cases.Oven,
    type: "parallel",
    states: {
      engine: {
        schema: MicrowaveState.cases.Engine,
        initial: "Off",
        states: {
          Off: MicrowaveState.cases.Off,
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

const initialMicrowave = () =>
  MicrowaveStates.initial.Oven(MicrowaveState.cases.Oven.make({ elapsedSeconds: 0 }), (oven) =>
    oven
      .engine(MicrowaveState.cases.Engine.make({}), (engine) => engine.Off(MicrowaveState.cases.Off.make({})))
      .door(MicrowaveState.cases.Door.make({}), (door) => door.Closed(MicrowaveState.cases.Closed.make({}))))

/**
 * The parallel topology is ready; fill the handlers with the safety rules you
 * want to explore (for example, opening the door must interrupt cooking).
 */
export const MicrowaveMachine = Machine.make({
  id: "Microwave",
  states: MicrowaveStates.states,
  events: [MicrowaveEvent],
  initial: initialMicrowave
}).handle({
  Oven: {
    states: {
      engine: {
        states: {
          Off: {},
          Idle: {},
          Cooking: {}
        }
      },
      door: {
        states: {
          Closed: {},
          Open: {}
        }
      }
    }
  }
})
