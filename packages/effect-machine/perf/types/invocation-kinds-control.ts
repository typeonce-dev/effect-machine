import { Context, Effect, Schema, Stream } from "effect"
import { Machine } from "../../dist/index.js"
export class Feed extends Context.Service<Feed, number>()("perf/Feed") {}
export class Worker extends Context.Service<Worker, number>()("perf/Worker") {}
export const Reading = Schema.TaggedStruct("Reading", { value: Schema.Number })
export const root = Machine.state({ states: { Idle: {}, Reading } })
export const address = Machine.childAddress<never>("worker")
const child = Machine.make({ root: Machine.state({ states: { Idle: {} } }), events: Machine.events({}) }).handle({
  initial: { target: "Idle" }
})
export const definition = Machine.make({
  root,
  events: Machine.events({}),
  streams: { feed: Stream.fromEffect(Effect.map(Feed, (value) => ({ value }))) },
  logic: { worker: Machine.logic({ initial: Effect.succeed(0), run: () => Effect.map(Worker, String) }) },
  children: { child: Machine.child("child", child) }
})
