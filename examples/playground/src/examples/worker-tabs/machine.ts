import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const SharedMachineState = Schema.TaggedUnion({
  Idle: { count: Schema.Number },
  Active: { count: Schema.Number }
})

export const SharedMachineEvent = Schema.TaggedUnion({
  Started: {},
  Incremented: {},
  Reset: {},
  Stopped: {}
})

export const SharedMachineStates = Machine.defineStates(SharedMachineState.cases)

/** Replace or extend this machine, then start it from machine.worker.ts. */
export const SharedMachine = Machine.make({
  id: "WorkerHostedMachine",
  states: SharedMachineStates.states,
  events: [SharedMachineEvent],
  initial: () => SharedMachineStates.initial.Idle(SharedMachineState.cases.Idle.make({ count: 0 }))
}).handle({
  Idle: {
    on: {
      Started: ({ state, target }) => target.full.Active(SharedMachineState.cases.Active.make({ count: state.count })),
      Reset: ({ target }) => target.full.Idle(SharedMachineState.cases.Idle.make({ count: 0 }))
    }
  },
  Active: {
    on: {
      Incremented: ({ state, target }) =>
        target.full.Active(SharedMachineState.cases.Active.make({ count: state.count + 1 })),
      Reset: ({ target }) => target.full.Active(SharedMachineState.cases.Active.make({ count: 0 })),
      Stopped: ({ state, target }) => target.full.Idle(SharedMachineState.cases.Idle.make({ count: state.count }))
    }
  }
})
