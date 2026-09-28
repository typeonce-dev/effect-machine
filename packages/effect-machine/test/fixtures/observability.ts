import { Effect, Schema, Stream, Tracer } from "effect"
import { Machine } from "../../src/index.js"

export const Events = Machine.events({ Start: {}, Reenter: {}, Finish: {} })
const Root = Machine.state({ states: { Idle: {}, Active: {}, Complete: { type: "final", output: Schema.Void } } })
export const observedMachine = (work: Effect.Effect<void, "failed">, stream: Stream.Stream<number> = Stream.never) =>
  Machine.make({
    id: "Observed",
    root: Root,
    events: Events,
    effects: { work },
    streams: { updates: stream },
    timers: { timeout: "1 hour" }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Start: { target: "Active" } } },
      Active: {
        invoke: [
          { src: "work", id: "custom-work", onDone: { none: true }, onFailure: { target: "Complete" } },
          { src: "updates", onElement: { none: true }, onDone: { none: true } },
          { src: "timeout", onDone: { none: true } }
        ],
        on: {
          Reenter: { target: "Active", reenter: true },
          Finish: { target: "Complete" }
        }
      },
      Complete: { output: () => undefined }
    }
  })

export const recordingTracer = Effect.gen(function*() {
  const underlying = yield* Effect.tracer
  const spans: Array<Tracer.Span> = []
  const tracer = Tracer.make({
    span(options) {
      const span = underlying.span(options)
      spans.push(span)
      return span
    }
  })
  return { spans, tracer }
})
