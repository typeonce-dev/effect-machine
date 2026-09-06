import { Schema } from "effect"
import { Machine } from "../../dist/index.js"

export class Root extends Schema.TaggedClass<Root>("Root")("Root", { count: Schema.Number }) {}
export class Saved extends Schema.TaggedClass<Saved>("Saved")("Saved", { text: Schema.String }) {}

export const machine = Machine.make({
  root: Machine.state({
    schema: Root,
    initial: "Idle",
    states: { Idle: {}, Saved: { schema: Saved } }
  }),
  events: Machine.events({ Save: { text: Schema.String }, Retry: {}, Reset: {} }),
  initial: (root) => root.from(() => ({ count: 0 }))
})
