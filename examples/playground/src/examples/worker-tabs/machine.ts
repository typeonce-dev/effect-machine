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
  Stopped: {},
  Synchronized: { active: Schema.Boolean, count: Schema.Number }
})

export const SharedMachineStates = Machine.defineStates(SharedMachineState.cases)

const definition = Machine.make({
  id: "WorkerHostedMachine",
  states: SharedMachineStates.states,
  events: [SharedMachineEvent],
  initial: () => SharedMachineStates.initial.Idle.from({ count: 0 })
})

// Worker and BroadcastChannel messages need decoded, cloneable data rather
// than the opaque instructions returned by Machine.events.
export const SharedTransportEvents = {
  Started: () => Machine.event(definition, SharedMachineEvent.cases.Started),
  Incremented: () => Machine.event(definition, SharedMachineEvent.cases.Incremented),
  Reset: () => Machine.event(definition, SharedMachineEvent.cases.Reset),
  Stopped: () => Machine.event(definition, SharedMachineEvent.cases.Stopped),
  Synchronized: (fields: { readonly active: boolean; readonly count: number }) =>
    Machine.event(definition, SharedMachineEvent.cases.Synchronized, fields)
}

export const SharedMachine = definition.handle({
  Idle: {
    on: {
      Started: ({ state, target }) => target.full.Active.from({ count: state.count }),
      Reset: ({ target }) => target.full.Idle.from({ count: 0 }),
      Synchronized: ({ event, target }) =>
        event.active
          ? target.full.Active.from({ count: event.count })
          : target.full.Idle.from({ count: event.count })
    }
  },
  Active: {
    on: {
      Incremented: ({ state, target }) => target.full.Active.from({ count: state.count + 1 }),
      Reset: ({ target }) => target.full.Active.from({ count: 0 }),
      Stopped: ({ state, target }) => target.full.Idle.from({ count: state.count }),
      Synchronized: ({ event, target }) =>
        event.active
          ? target.full.Active.from({ count: event.count })
          : target.full.Idle.from({ count: event.count })
    }
  }
})

export type SharedEvent = typeof SharedMachineEvent.Type
export type SharedSnapshot = Machine.Machine.Snapshot<typeof SharedMachineStates.states>
