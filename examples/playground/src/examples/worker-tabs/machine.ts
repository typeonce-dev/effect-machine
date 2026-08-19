import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"
import { type SharedEvent, SharedMachineEvents } from "./protocol.ts"

export type { SharedEvent } from "./protocol.ts"

export const SharedMachineState = Schema.TaggedUnion({
  Idle: { count: Schema.Number },
  Active: { count: Schema.Number }
})

export const SharedMachineStates = Machine.states(SharedMachineState.cases)

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

export const SharedMachine = Machine.make({
  id: "WorkerHostedMachine",
  states: SharedMachineStates.states,
  events: SharedMachineEvents,
  initial: {
    target: (to) => to.Idle(),
    resolve: ({ target }) => target.from({ count: 0 })
  }
}).handle({
  Idle: {
    on: {
      Started: (to) => to.full.Active().resolve(({ state, target }) => target.from({ count: state.count })),
      Reset: (to) => to.full.Idle().resolve(({ target }) => target.from({ count: 0 })),
      Synchronized: (to) =>
        to.branches({ active: { target: to.full.Active() }, idle: { target: to.full.Idle() } }).resolve((
          { event, select }
        ) =>
          event.active
            ? select.active.from({ count: event.count })
            : select.idle.from({ count: event.count })
        )
    }
  },
  Active: {
    on: {
      Incremented: (to) => to.full.Active().resolve(({ state, target }) => target.from({ count: state.count + 1 })),
      Reset: (to) => to.full.Active().resolve(({ target }) => target.from({ count: 0 })),
      Stopped: (to) => to.full.Idle().resolve(({ state, target }) => target.from({ count: state.count })),
      Synchronized: (to) =>
        to.branches({ active: { target: to.full.Active() }, idle: { target: to.full.Idle() } }).resolve((
          { event, select }
        ) =>
          event.active
            ? select.active.from({ count: event.count })
            : select.idle.from({ count: event.count })
        )
    }
  }
})

export type SharedSnapshot = Machine.Machine.Snapshot<typeof SharedMachineStates.states>
