import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

const events = Machine.events({ Add: { by: Schema.Number } })
export const counter = Machine.make({
  root: Machine.state({ fields: { count: Schema.Number } }),
  events,
  initial: (root) => root.from(() => ({ count: 0 }))
}).handle({
  on: {
    Add: (to) =>
      to.self.update.guard(({ event }) => event.by > 0).from(({ current, event }) => ({
        count: current.count + event.by
      }))
  }
})
