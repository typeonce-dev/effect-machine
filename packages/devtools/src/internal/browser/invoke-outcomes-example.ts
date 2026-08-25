import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema, Stream } from "effect"

class ChildWorking extends Schema.TaggedClass<ChildWorking>("InvokeGalleryChildWorking")("Working", {
  task: Schema.String
}) {}
class ChildDone extends Schema.TaggedClass<ChildDone>("InvokeGalleryChildDone")("Done", {
  result: Schema.String
}) {}
class FinishChild extends Schema.TaggedClass<FinishChild>("InvokeGalleryFinishChild")("FinishChild", {}) {}

const ChildStates = Machine.states({
  Working: ChildWorking,
  Done: { schema: ChildDone, type: "final", output: Schema.String }
})

export const invokeGalleryChildMachine = Machine.make({
  id: "invoke-gallery-child",
  states: ChildStates.states,
  events: Machine.events(FinishChild),
  initial: (to) => to.Working().resolve(({ target }) => target.decoded(new ChildWorking({ task: "render-preview" })))
}).handle({
  Working: {
    on: {
      FinishChild: (to) =>
        to.full.Done().resolve(({ state, target }) =>
          target.decoded(new ChildDone({ result: `${state.task}:complete` }))
        )
    }
  },
  Done: {
    output: ({ state }) => state.result
  }
})

const InvokedChild = Machine.child("preview-worker", invokeGalleryChildMachine)

class Gallery extends Schema.TaggedClass<Gallery>("InvokeGallery")("Gallery", {
  selectedDemo: Schema.NullOr(Schema.String)
}) {}
class Choose extends Schema.TaggedClass<Choose>("InvokeGalleryChoose")("Choose", {}) {}
class LoadingDocument extends Schema.TaggedClass<LoadingDocument>("InvokeGalleryLoadingDocument")(
  "LoadingDocument",
  { request: Schema.String }
) {}
class StreamingUpdates extends Schema.TaggedClass<StreamingUpdates>("InvokeGalleryStreamingUpdates")(
  "StreamingUpdates",
  { values: Schema.Array(Schema.Number) }
) {}
class WaitingForTimeout extends Schema.TaggedClass<WaitingForTimeout>("InvokeGalleryWaitingForTimeout")(
  "WaitingForTimeout",
  { delay: Schema.Literal("2 seconds") }
) {}
class WatchingProcess extends Schema.TaggedClass<WatchingProcess>("InvokeGalleryWatchingProcess")(
  "WatchingProcess",
  { revision: Schema.Number }
) {}
class RunningChild extends Schema.TaggedClass<RunningChild>("InvokeGalleryRunningChild")("RunningChild", {}) {}
class Completed extends Schema.TaggedClass<Completed>("InvokeGalleryCompleted")("Completed", {
  source: Schema.String,
  result: Schema.String
}) {}
class Failed extends Schema.TaggedClass<Failed>("InvokeGalleryFailed")("Failed", {
  source: Schema.String,
  message: Schema.String
}) {}

class RunEffect extends Schema.TaggedClass<RunEffect>("InvokeGalleryRunEffect")("RunEffect", {
  request: Schema.String
}) {}
class RunStream extends Schema.TaggedClass<RunStream>("InvokeGalleryRunStream")("RunStream", {}) {}
class RunTimer extends Schema.TaggedClass<RunTimer>("InvokeGalleryRunTimer")("RunTimer", {}) {}
class RunProcess extends Schema.TaggedClass<RunProcess>("InvokeGalleryRunProcess")("RunProcess", {}) {}
class RunChild extends Schema.TaggedClass<RunChild>("InvokeGalleryRunChild")("RunChild", {}) {}
class Reset extends Schema.TaggedClass<Reset>("InvokeGalleryReset")("Reset", {}) {}
class StreamValue extends Schema.TaggedClass<StreamValue>("InvokeGalleryStreamValue")("StreamValue", {
  value: Schema.Number
}) {}

const GalleryEvents = Machine.events(RunEffect, RunStream, RunTimer, RunProcess, RunChild, Reset)
const GalleryInternalEvents = Machine.internalEvents(StreamValue)
const processLogic = Machine.logic({
  initial: "starting" as "starting" | "ready",
  run: () => Effect.fail("process stopped")
})

const GalleryStates = Machine.states({
  Gallery: {
    schema: Gallery,
    initial: "Choose",
    states: {
      Choose,
      LoadingDocument,
      StreamingUpdates,
      WaitingForTimeout,
      WatchingProcess,
      RunningChild
    }
  },
  Completed,
  Failed
})

export const invokeOutcomesMachine = Machine.make({
  id: "invoke-outcomes",
  states: GalleryStates.states,
  events: GalleryEvents,
  internalEvents: GalleryInternalEvents,
  initial: (to) =>
    to.Gallery.initial.resolve(({ target }) =>
      target.decoded(
        new Gallery({ selectedDemo: null }),
        (gallery) => gallery.Choose.decoded(new Choose({}))
      )
    )
}).handle({
  Gallery: {
    initialize: ({ builder }) => builder.decoded(new Choose({})),
    on: {
      Reset: (to) => to.local.Choose().resolve(({ target }) => target.decoded(new Choose({})))
    },
    states: {
      Choose: {
        on: {
          RunEffect: (to) =>
            to.local.LoadingDocument().resolve(({ event, target }) =>
              target.decoded(new LoadingDocument({ request: event.request }))
            ),
          RunStream: (to) =>
            to.local.StreamingUpdates().resolve(({ target }) => target.decoded(new StreamingUpdates({ values: [] }))),
          RunTimer: (to) =>
            to.local.WaitingForTimeout().resolve(({ target }) =>
              target.decoded(new WaitingForTimeout({ delay: "2 seconds" }))
            ),
          RunProcess: (to) =>
            to.local.WatchingProcess().resolve(({ target }) => target.decoded(new WatchingProcess({ revision: 1 }))),
          RunChild: (to) => to.local.RunningChild().resolve(({ target }) => target.decoded(new RunningChild({})))
        }
      },
      LoadingDocument: {
        invoke: (from) =>
          from.effect(
            "load-document",
            ({ state }) =>
              state.request === "fail" ? Effect.fail("document unavailable") : Effect.succeed("document loaded")
          ).onDone((to) =>
            to.full.Completed().resolve(({ output, target }) =>
              target.decoded(new Completed({ source: "effect", result: output }))
            )
          ).onFailure((to) =>
            to.full.Failed().resolve(({ error, target }) =>
              target.decoded(new Failed({ source: "effect", message: error }))
            )
          )
      },
      StreamingUpdates: {
        invoke: (from) =>
          from.stream(
            "document-updates",
            () => Stream.fromIterable([1, 2, 3]).pipe(Stream.concat(Stream.fail("stream disconnected")))
          ).onElement((to) =>
            to.none.resolve(({ element }, enqueue) => {
              enqueue.raise(GalleryInternalEvents.StreamValue({ value: element }))
            })
          ).onDone((to) =>
            to.full.Completed().resolve(({ state, target }) =>
              target.decoded(new Completed({ source: "stream", result: state.values.join(", ") }))
            )
          ).onFailure((to) =>
            to.full.Failed().resolve(({ error, target }) =>
              target.decoded(new Failed({ source: "stream", message: error }))
            )
          ),
        on: {
          StreamValue: (to) =>
            to.local.StreamingUpdates().resolve(({ event, state, target }) =>
              target.decoded(new StreamingUpdates({ values: [...state.values, event.value] }))
            )
        }
      },
      WaitingForTimeout: {
        invoke: (from) =>
          from.timer("request-timeout", "2 seconds").onDone((to) =>
            to.full.Completed().resolve(({ target }) =>
              target.decoded(new Completed({ source: "timer", result: "timeout elapsed" }))
            )
          )
      },
      WatchingProcess: {
        invoke: (from) =>
          from.logic("status-worker", {
            address: Machine.childAddress("status-worker"),
            logic: processLogic
          }).onFailure((to) =>
            to.full.Failed().resolve(({ error, target }) =>
              target.decoded(new Failed({ source: "process", message: String(error) }))
            )
          ).onSnapshot((to) =>
            to.branches({
              ready: { title: "Worker reports ready", target: to.full.Completed() },
              waiting: { title: "Worker is still starting", target: to.none }
            }).resolve(({ select, snapshot }) =>
              snapshot.state === "ready"
                ? select.ready.decoded(new Completed({ source: "process", result: "ready" }))
                : select.waiting()
            )
          )
      },
      RunningChild: {
        invoke: (from) =>
          from.child(InvokedChild).onDone((to) =>
            to.full.Completed().resolve(({ output, target }) =>
              target.decoded(new Completed({ source: "child machine", result: output }))
            )
          )
      }
    }
  },
  Completed: {
    on: {
      Reset: (to) =>
        to.full.Gallery.initial.resolve(({ target }) => target.decoded(new Gallery({ selectedDemo: null })))
    }
  },
  Failed: {
    on: {
      Reset: (to) =>
        to.full.Gallery.initial.resolve(({ target }) => target.decoded(new Gallery({ selectedDemo: null })))
    }
  }
})
