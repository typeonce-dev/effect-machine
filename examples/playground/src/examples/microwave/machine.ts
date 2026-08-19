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
  initial: (to) =>
    to.Oven.initial.resolve(({ target }) =>
      target.from((oven) =>
        oven
          .engine.from((engine) => engine.Idle.from())
          .door.from((door) => door.Closed.from())
      )
    )
}).handle({
  Oven: {
    states: {
      engine: {
        states: {
          Idle: {
            on: {
              PowerPressed: (to) =>
                to.branches({
                  doorClosed: { title: "Door closed", target: to.local.Cooking() },
                  unchanged: { target: to.none }
                }).resolve(({ snapshot, select }) =>
                  MicrowaveStates.matches(snapshot, "Oven.door.Closed")
                    ? select.doorClosed.from({ elapsedSeconds: 0 })
                    : select.unchanged()
                )
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
              PowerPressed: (to) => to.local.Idle().resolve(({ target }) => target.from()),
              DoorOpened: (to) => to.local.Idle().resolve(({ target }) => target.from())
            }
          }
        }
      },
      door: {
        states: {
          Closed: {
            on: {
              DoorOpened: (to) => to.local.Open().resolve(({ target }) => target.from())
            }
          },
          Open: {
            on: {
              DoorClosed: (to) => to.local.Closed().resolve(({ target }) => target.from())
            }
          }
        }
      }
    }
  }
})
