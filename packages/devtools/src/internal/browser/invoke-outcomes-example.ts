import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema, Stream } from "effect"
class ChildWorking extends Schema.TaggedClass<ChildWorking>("InvokeGalleryChildWorking")("Working", {
  task: Schema.String
}) {
}
class ChildDone extends Schema.TaggedClass<ChildDone>("InvokeGalleryChildDone")("Done", {
  result: Schema.String
}) {
}
class FinishChild extends Schema.TaggedClass<FinishChild>("InvokeGalleryFinishChild")("FinishChild", {}) {
}
const ChildStates = Machine.state({
  states: {
    Working: ChildWorking,
    Done: { schema: ChildDone, type: "final", output: Schema.String }
  }
})
const targets1 = Machine.targets(ChildStates)
export const invokeGalleryChildMachine = Machine.make({
  id: "invoke-gallery-child",
  root: ChildStates,
  events: Machine.eventsFromSchemas(FinishChild)
}).handle({
  initial: {
    target: Machine.targets(ChildStates).root.Working,
    decoded: true,
    data: new ChildWorking({ task: "render-preview" })
  },
  states: {
    Working: {
      on: {
        FinishChild: {
          target: targets1.root.Done,
          decoded: true,
          data: ({ state }) => (new ChildDone({ result: `${state.task}:complete` }))
        }
      }
    },
    Done: {
      output: ({ state }) => state.result
    }
  }
})
const InvokedChild = Machine.child("preview-worker", invokeGalleryChildMachine)
class Gallery extends Schema.TaggedClass<Gallery>("InvokeGallery")("Gallery", {
  selectedDemo: Schema.NullOr(Schema.String)
}) {
}
class Choose extends Schema.TaggedClass<Choose>("InvokeGalleryChoose")("Choose", {}) {
}
class LoadingDocument extends Schema.TaggedClass<LoadingDocument>("InvokeGalleryLoadingDocument")("LoadingDocument", {
  request: Schema.String
}) {
}
class StreamingUpdates
  extends Schema.TaggedClass<StreamingUpdates>("InvokeGalleryStreamingUpdates")("StreamingUpdates", {
    values: Schema.Array(Schema.Number)
  })
{
}
class WaitingForTimeout
  extends Schema.TaggedClass<WaitingForTimeout>("InvokeGalleryWaitingForTimeout")("WaitingForTimeout", {
    delay: Schema.Literal("2 seconds")
  })
{
}
class WatchingProcess extends Schema.TaggedClass<WatchingProcess>("InvokeGalleryWatchingProcess")("WatchingProcess", {
  revision: Schema.Number
}) {
}
class RunningChild extends Schema.TaggedClass<RunningChild>("InvokeGalleryRunningChild")("RunningChild", {}) {
}
class Completed extends Schema.TaggedClass<Completed>("InvokeGalleryCompleted")("Completed", {
  source: Schema.String,
  result: Schema.String
}) {
}
class Failed extends Schema.TaggedClass<Failed>("InvokeGalleryFailed")("Failed", {
  source: Schema.String,
  message: Schema.String
}) {
}
class RunEffect extends Schema.TaggedClass<RunEffect>("InvokeGalleryRunEffect")("RunEffect", {
  request: Schema.String
}) {
}
class RunStream extends Schema.TaggedClass<RunStream>("InvokeGalleryRunStream")("RunStream", {}) {
}
class RunTimer extends Schema.TaggedClass<RunTimer>("InvokeGalleryRunTimer")("RunTimer", {}) {
}
class RunProcess extends Schema.TaggedClass<RunProcess>("InvokeGalleryRunProcess")("RunProcess", {}) {
}
class RunChild extends Schema.TaggedClass<RunChild>("InvokeGalleryRunChild")("RunChild", {}) {
}
class Reset extends Schema.TaggedClass<Reset>("InvokeGalleryReset")("Reset", {}) {
}
class StreamValue extends Schema.TaggedClass<StreamValue>("InvokeGalleryStreamValue")("StreamValue", {
  value: Schema.Number
}) {
}
const GalleryEvents = Machine.eventsFromSchemas(RunEffect, RunStream, RunTimer, RunProcess, RunChild, Reset)
const GalleryInternalEvents = Machine.internalEventsFromSchemas(StreamValue)
const processLogic = Machine.logic({
  initial: "starting" as "starting" | "ready",
  run: () => Effect.fail("process stopped")
})
const GalleryStates = Machine.state({
  states: {
    Gallery: {
      schema: Gallery,
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
  }
})
const targets2 = Machine.targets(GalleryStates)
export const invokeOutcomesMachine = Machine.make({
  branches: {
    transition13: {
      ready: { target: targets2.root.Completed, title: "Worker reports ready" },
      waiting: { none: true, title: "Worker is still starting" }
    }
  },
  effects: {
    source1: ({ state }: {
      readonly state: LoadingDocument
    }) => state.request === "fail" ? Effect.fail("document unavailable") : Effect.succeed("document loaded")
  },
  streams: {
    source2: Stream.suspend(() =>
      Stream.fromIterable([1, 2, 3]).pipe(Stream.concat(Stream.fail("stream disconnected")))
    )
  },
  timers: { source3: "2 seconds" },
  logic: { source4: processLogic },
  children: { source5: InvokedChild },
  id: "invoke-outcomes",
  root: GalleryStates,
  events: GalleryEvents,
  internalEvents: GalleryInternalEvents
}).handle({
  initial: {
    target: Machine.targets(GalleryStates).root.Gallery,
    decoded: true,
    data: new Gallery({ selectedDemo: null })
  },
  states: {
    Gallery: {
      initial: {
        target: Machine.targets(GalleryStates).root.Gallery.Choose,
        decoded: true,
        data: ({}) => new Choose({})
      },
      on: {
        Reset: { target: targets2.root.Gallery.Choose, decoded: true, data: () => (new Choose({})) }
      },
      states: {
        Choose: {
          on: {
            RunEffect: {
              target: targets2.root.Gallery.LoadingDocument,
              decoded: true,
              data: ({ event }) => (new LoadingDocument({ request: event.request }))
            },
            RunStream: {
              target: targets2.root.Gallery.StreamingUpdates,
              decoded: true,
              data: () => (new StreamingUpdates({ values: [] }))
            },
            RunTimer: {
              target: targets2.root.Gallery.WaitingForTimeout,
              decoded: true,
              data: () => (new WaitingForTimeout({ delay: "2 seconds" }))
            },
            RunProcess: {
              target: targets2.root.Gallery.WatchingProcess,
              decoded: true,
              data: () => (new WatchingProcess({ revision: 1 }))
            },
            RunChild: { target: targets2.root.Gallery.RunningChild, decoded: true, data: () => (new RunningChild({})) }
          }
        },
        LoadingDocument: {
          invoke: {
            src: "source1",
            id: "load-document",
            input: (context) => context,
            onDone: {
              target: targets2.root.Completed,
              decoded: true,
              data: ({ output }) => (new Completed({ source: "effect", result: output }))
            },
            onFailure: {
              target: targets2.root.Failed,
              decoded: true,
              data: ({ error }) => (new Failed({ source: "effect", message: error }))
            }
          }
        },
        StreamingUpdates: {
          invoke: {
            src: "source2",
            id: "document-updates",
            onElement: {
              none: true,
              resolve: ({ element }, enqueue) => {
                enqueue.raise(GalleryInternalEvents.StreamValue({ value: element }))
              }
            },
            onDone: {
              target: targets2.root.Completed,
              decoded: true,
              data: ({ state }) => (new Completed({ source: "stream", result: state.values.join(", ") }))
            },
            onFailure: {
              target: targets2.root.Failed,
              decoded: true,
              data: ({ error }) => (new Failed({ source: "stream", message: error }))
            }
          },
          on: {
            StreamValue: {
              target: targets2.root.Gallery.StreamingUpdates,
              decoded: true,
              data: ({ event, state }) => (new StreamingUpdates({ values: [...state.values, event.value] }))
            }
          }
        },
        WaitingForTimeout: {
          invoke: {
            src: "source3",
            id: "request-timeout",
            onDone: {
              target: targets2.root.Completed,
              decoded: true,
              data: () => (new Completed({ source: "timer", result: "timeout elapsed" }))
            }
          }
        },
        WatchingProcess: {
          invoke: {
            src: "source4",
            id: "status-worker",
            address: Machine.childAddress("status-worker"),
            onFailure: {
              target: targets2.root.Failed,
              decoded: true,
              data: ({ error }) => (new Failed({ source: "process", message: String(error) }))
            },
            onSnapshot: {
              branches: "transition13",
              resolve: ({ select, snapshot }) =>
                snapshot.state === "ready"
                  ? select.ready({ data: new Completed({ source: "process", result: "ready" }), decoded: true })
                  : select.waiting()
            }
          }
        },
        RunningChild: {
          invoke: {
            src: "source5",
            onDone: {
              target: targets2.root.Completed,
              decoded: true,
              data: ({ output }) => (new Completed({ source: "child machine", result: output }))
            }
          }
        }
      }
    },
    Completed: {
      on: {
        Reset: { target: targets2.root.Gallery, decoded: true, data: () => (new Gallery({ selectedDemo: null })) }
      }
    },
    Failed: {
      on: {
        Reset: { target: targets2.root.Gallery, decoded: true, data: () => (new Gallery({ selectedDemo: null })) }
      }
    }
  }
})
