import { Schema } from "effect"
import { Machine } from "../../dist/index.js"
import { Root, Saved, States } from "./transition-construction-control.js"
const targets = Machine.targets(States)
const machine = Machine.make({
  branches: { reset: { idle: { target: targets.root.Idle }, same: { none: true } } },
  root: States,
  events: Machine.events({ Save: { text: Schema.String }, Retry: {}, Reset: {} })
})
const handled = machine.handle({
  initial: {
    target: Machine.targets(States).root.Idle
  },
  root: () => ({ count: 0 }),
  on: { Reset: { update: targets.root, guard: ({ root }) => root.count > 0, data: () => ({ count: 0 }) } },
  states: {
    Idle: {
      on: {
        Save: {
          target: targets.root.Saved,
          update: targets.root,
          guard: ({ event }) => event.text.length > 0,
          data: ({ root, event }) => ({ target: { text: event.text }, update: { count: root.count + 1 } })
        }
      }
    },
    Saved: {
      on: {
        Save: {
          target: targets.root.Saved,
          update: targets.root,
          reenter: true,
          decoded: true,
          data: ({ root, event }) => ({
            target: new Saved({ text: event.text }),
            update: new Root({ count: root.count + 1 })
          })
        },
        Retry: { target: targets.root.Saved, reenter: true, data: ({ state }) => ({ text: state.text }) },
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
