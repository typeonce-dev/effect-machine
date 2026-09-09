import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"
const events = Machine.events({ Add: { by: Schema.Number } })
const Root = Machine.state({ fields: { count: Schema.Number } })
const targets = Machine.targets(Root)
export const counter = Machine.make({
  root: Root,
  events
}).handle({
  root: () => ({ count: 0 }),
  on: {
    Add: {
      update: targets.root,
      guard: ({ event }) => event.by > 0,
      data: ({ root, event }) => ({ count: root.count + event.by })
    }
  }
})
