import { Schema } from "effect"
import { Machine } from "../../dist/index.js"
import { Root, Saved, States } from "./transition-construction-control.js"
const machine = Machine.make({
  branches: { reset: { idle: { target: "Idle" }, same: { none: true } } },
  root: States,
  events: Machine.events({ Save: { text: Schema.String }, Retry: {}, Reset: {} })
})
const handled = machine.handle({
  initial: {
    target: "Idle"
  },
  root: () => ({ count: 0 }),
  on: { Reset: { update: "root", guard: ({ root }) => root.count > 0, data: () => ({ count: 0 }) } },
  states: {
    Idle: {
      on: {
        Save: {
          target: "Saved",
          update: "root",
          guard: ({ event }) => event.text.length > 0,
          data: ({ root, event }) => ({ target: { text: event.text }, update: { count: root.count + 1 } })
        }
      }
    },
    Saved: {
      on: {
        Save: {
          target: "Saved",
          update: "root",
          reenter: true,
          decoded: true,
          data: ({ root, event }) => ({
            target: new Saved({ text: event.text }),
            update: new Root({ count: root.count + 1 })
          })
        },
        Retry: { target: "Saved", reenter: true, data: ({ state }) => ({ text: state.text }) },
        Reset: {
          branches: "reset",
          reenter: true,
          resolve: ({ state, select }) => state.text.length === 0 ? select.idle({}) : select.same()
        }
      }
    }
  }
})
void Machine.planInitial(handled)
