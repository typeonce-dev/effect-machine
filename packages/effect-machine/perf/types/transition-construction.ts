import { Schema } from "effect"
import { Machine } from "../../dist/index.js"
import { Root, Saved, States } from "./transition-construction-control.js"
const machine = Machine.make({
  root: States,
  events: Machine.events({ Save: { text: Schema.String }, Retry: {}, Reset: {} })
})
const handled = machine.handle({
  initial: {
    target: "Idle"
  },
  root: () => ({ count: 0 }),
  on: { Reset: { update: { root: () => ({ count: 0 }) }, guard: ({ root }) => root.count > 0 } },
  states: {
    Idle: {
      on: {
        Save: {
          target: "Saved",
          update: { root: ({ root, event }) => ({ count: root.count + 1 }) },
          guard: ({ event }) => event.text.length > 0,
          data: ({ root, event }) => ({ text: event.text })
        }
      }
    },
    Saved: {
      on: {
        Save: {
          target: "Saved",
          update: { root: { decoded: true, data: ({ root, event }) => (new Root({ count: root.count + 1 })) } },
          reenter: true,
          decoded: true,
          data: ({ root, event }) => (new Saved({ text: event.text }))
        },
        Retry: { target: "Saved", reenter: true, data: ({ state }) => ({ text: state.text }) },
        Reset: {
          branches: [{ target: "Idle" }, { stay: true }],
          reenter: true,
          resolve: ({ state, select }) => state.text.length === 0 ? select.target("Idle", {}) : select.stay()
        }
      }
    }
  }
})
void Machine.planInitial(handled)
