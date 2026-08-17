import { Machine } from "@typeonce/effect-machine"
import { Option, Schema } from "effect"
import { type SharedEvent, SharedMachineEvents } from "./protocol.ts"

export type { SharedEvent } from "./protocol.ts"

export const SharedMachineState = Schema.TaggedUnion({
  Idle: { count: Schema.Number },
  Active: { count: Schema.Number }
})

export const SharedMachineStates = Machine.defineStates(SharedMachineState.cases)

const definition = Machine.make({
  id: "WorkerHostedMachine",
  states: SharedMachineStates.states,
  events: SharedMachineEvents,
  initial: {
    target: (to) => to.Idle(),
    resolve: ({ target }) => target.from({ count: 0 })
  }
})

// Worker and BroadcastChannel messages need decoded, cloneable data rather
// than the opaque instructions returned by Machine.events.
export const SharedTransportEvents = {
  Started: (): SharedEvent => ({ _tag: "Started" }),
  Incremented: (): SharedEvent => ({ _tag: "Incremented" }),
  Reset: (): SharedEvent => ({ _tag: "Reset" }),
  Stopped: (): SharedEvent => ({ _tag: "Stopped" }),
  Synchronized: (fields: { readonly active: boolean; readonly count: number }): SharedEvent => ({
    _tag: "Synchronized",
    ...fields
  })
}

export const SharedMachine = definition.handle({
  Idle: {
    on: {
      Started: Machine.transition({
        target: (to) => to.full.Active(),
        resolve: ({ state, target }) => target.from({ count: state.count })
      }),
      Reset: Machine.transition({
        target: (to) => to.full.Idle(),
        resolve: ({ target }) => target.from({ count: 0 })
      }),
      Synchronized: Machine.transition({
        cases: [{
          title: "active",
          when: ({ event }) => event.active ? Option.some(event.count) : Option.none(),
          target: (to) => to.full.Active(),
          resolve: ({ match, target }) => target.from({ count: match })
        }],
        otherwise: {
          target: (to) => to.full.Idle(),
          resolve: ({ event, target }) => target.from({ count: event.count })
        }
      })
    }
  },
  Active: {
    on: {
      Incremented: Machine.transition({
        target: (to) => to.full.Active(),
        resolve: ({ state, target }) => target.from({ count: state.count + 1 })
      }),
      Reset: Machine.transition({
        target: (to) => to.full.Active(),
        resolve: ({ target }) => target.from({ count: 0 })
      }),
      Stopped: Machine.transition({
        target: (to) => to.full.Idle(),
        resolve: ({ state, target }) => target.from({ count: state.count })
      }),
      Synchronized: Machine.transition({
        cases: [{
          title: "active",
          when: ({ event }) => event.active ? Option.some(event.count) : Option.none(),
          target: (to) => to.full.Active(),
          resolve: ({ match, target }) => target.from({ count: match })
        }],
        otherwise: {
          target: (to) => to.full.Idle(),
          resolve: ({ event, target }) => target.from({ count: event.count })
        }
      })
    }
  }
})

export type SharedSnapshot = Machine.Machine.Snapshot<typeof SharedMachineStates.states>
