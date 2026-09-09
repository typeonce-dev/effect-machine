import { Schema } from "effect"
import { Machine } from "../../dist/index.js"

export class Root extends Schema.TaggedClass<Root>("Root")("Root", { count: Schema.Number }) {}
export class Saved extends Schema.TaggedClass<Saved>("Saved")("Saved", { text: Schema.String }) {}

export const States = Machine.state({
  schema: Root,
  states: { Idle: {}, Saved: { schema: Saved } }
})
export const machine = Machine.make({
  root: States,
  events: Machine.events({ Save: { text: Schema.String }, Retry: {}, Reset: {} })
})
