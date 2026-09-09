import { Schema } from "effect"
import { Machine } from "../../dist/index.js"
import { Root, Saved, States } from "./transition-construction-control.js"

const targets = Machine.targets(States)
const machine = Machine.make({
  branches: { reset: { idle: { target: targets.root.Idle }, same: { none: true } } },

  root: States,
  events: Machine.events({ Save: { text: Schema.String }, Retry: {}, Reset: {} }),
  initial: (root) => root.from(() => ({ count: 0 }))
})

const handled = machine.handle({
  on: { Reset: { update: targets.root, guard: ({ root }) => root.count > 0, from: () => ({ count: 0 }) } },
  states: {
    Idle: {
      on: {
        Save: {
          target: targets.root.Saved,
          update: targets.root,
          guard: ({ event }) => event.text.length > 0,
          from: ({ root, event }) => ({ target: { text: event.text }, update: { count: root.count + 1 } })
        }
      }
    },
    Saved: {
      on: {
        Save: {
          target: targets.root.Saved,
          update: targets.root,
          reenter: true,
          decoded: ({ root, event }) => ({
            target: new Saved({ text: event.text }),
            update: new Root({ count: root.count + 1 })
          })
        },
        Retry: { target: targets.root.Saved, reenter: true, from: ({ state }) => ({ text: state.text }) },
        Reset: {
          branches: "reset",
          reenter: true,
          resolve: ({ state, select }) => state.text.length === 0 ? select.idle.from() : select.same()
        }
      }
    }
  }
})
void Machine.planInitial(handled)
