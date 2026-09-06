import { Machine } from "../../dist/index.js"
import { machine, Root, Saved } from "./transition-construction-control.js"

const handled = machine.handle({
  on: {
    Reset: (to) => to.self.update.guard(({ current }) => current.count > 0).from(() => ({ count: 0 }))
  },
  states: {
    Idle: {
      on: {
        Save: (to) =>
          to.local.Saved().updating(to.root).guard(({ event }) => event.text.length > 0)
            .from(({ current, event }) => ({ target: { text: event.text }, update: { count: current.count + 1 } }))
      }
    },
    Saved: {
      on: {
        Save: (to) =>
          to.local.Saved().updating(to.root).reenter().decoded(({ current, event }) => ({
            target: new Saved({ text: event.text }),
            update: new Root({ count: current.count + 1 })
          })),
        Retry: (to) => to.local.Saved().reenter().from(({ state }) => ({ text: state.text })),
        Reset: (to) =>
          to.branches({ idle: { target: to.local.Idle() }, same: { target: to.none } }).reenter()
            .resolve(({ state, select }) => state.text.length === 0 ? select.idle.from() : select.same())
      }
    }
  }
})

void Machine.planInitial(handled)
