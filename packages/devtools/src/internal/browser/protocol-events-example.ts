import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"
class ChildProgress extends Schema.TaggedClass<ChildProgress>("ProtocolChildProgress")("ChildProgress", {
  percent: Schema.Number
}) {
}
class ChildFinished extends Schema.TaggedClass<ChildFinished>("ProtocolChildFinished")("ChildFinished", {
  result: Schema.String
}) {
}
class ChildProblem extends Schema.TaggedClass<ChildProblem>("ProtocolChildProblem")("ChildProblem", {
  message: Schema.String
}) {
}
const ParentEvents = Machine.eventsFromSchemas(ChildProgress, ChildFinished, ChildProblem)
class ChildIdle extends Schema.TaggedClass<ChildIdle>("ProtocolChildIdle")("Idle", {}) {
}
class ChildWorking extends Schema.TaggedClass<ChildWorking>("ProtocolChildWorking")("Working", {
  job: Schema.String,
  progress: Schema.Number
}) {
}
class ChildDone extends Schema.TaggedClass<ChildDone>("ProtocolChildDone")("Done", {
  result: Schema.String
}) {
}
class ChildCancelled extends Schema.TaggedClass<ChildCancelled>("ProtocolChildCancelled")("Cancelled", {
  reason: Schema.String
}) {
}
class BeginChildWork extends Schema.TaggedClass<BeginChildWork>("ProtocolBeginChildWork")("BeginChildWork", {
  job: Schema.String
}) {
}
class CancelChildWork
  extends Schema.TaggedClass<CancelChildWork>("ProtocolCancelChildWork")("CancelChildWork", { reason: Schema.String })
{
}
class Heartbeat extends Schema.TaggedClass<Heartbeat>("ProtocolHeartbeat")("Heartbeat", {
  percent: Schema.Number
}) {
}
class CommitChildWork extends Schema.TaggedClass<CommitChildWork>("ProtocolCommitChildWork")("CommitChildWork", {}) {
}
class ChildTrace extends Schema.TaggedClass<ChildTrace>("ProtocolChildTrace")("ChildTrace", {
  message: Schema.String
}) {
}
const ChildEvents = Machine.eventsFromSchemas(BeginChildWork, CancelChildWork)
const ChildInternalEvents = Machine.internalEventsFromSchemas(Heartbeat, CommitChildWork)
const ChildEmissions = Machine.emittedEventsFromSchemas(ChildTrace)
const ChildStates = Machine.state({
  states: {
    Idle: ChildIdle,
    Working: ChildWorking,
    Done: { schema: ChildDone, type: "final", output: Schema.String },
    Cancelled: { schema: ChildCancelled, type: "final", output: Schema.String }
  }
})
const targets1 = Machine.targets(ChildStates)
export const requiredParentChildMachine = Machine.make({
  branches: {
    transition1: { destination: { target: targets1.root.Working } },
    transition3: { destination: { target: targets1.root.Working } }
  },
  effects: {
    source1: ({ parent, state }: {
      readonly parent: Machine.MachineTarget<Machine.Machine.EventInput<ChildProgress | ChildFinished | ChildProblem>>
      readonly state: ChildWorking
    }) => parent.send(ParentEvents.ChildProgress({ percent: state.progress }))
  },
  id: "required-parent-child",
  root: ChildStates,
  events: ChildEvents,
  internalEvents: ChildInternalEvents,
  emittedEvents: ChildEmissions,
  parent: Machine.parent(ParentEvents)
}).handle({
  initial: {
    target: Machine.targets(ChildStates).root.Idle,
    decoded: true,
    data: new ChildIdle({})
  },
  states: {
    Idle: {
      on: {
        BeginChildWork: {
          branches: "transition1",
          resolve: ({ event, select: { destination: target } }, enqueue) => {
            enqueue.raise(ChildInternalEvents.Heartbeat({ percent: 25 }))
            enqueue.emit(ChildEmissions.ChildTrace({ message: `started ${event.job}` }))
            return target.decoded(new ChildWorking({ job: event.job, progress: 0 }))
          }
        }
      }
    },
    Working: {
      invoke: {
        src: "source1",
        id: "report-progress-to-parent",
        input: (context) => context,
        onDone: { none: true },
        onFailure: {
          target: targets1.root.Cancelled,
          decoded: true,
          data: ({ error }) => (new ChildCancelled({ reason: String(error) }))
        }
      },
      on: {
        Heartbeat: {
          branches: "transition3",
          resolve: ({ event, state, select: { destination: target } }, enqueue) => {
            enqueue.raise(ChildInternalEvents.CommitChildWork())
            return target.decoded(new ChildWorking({ job: state.job, progress: event.percent }))
          }
        },
        CommitChildWork: {
          target: targets1.root.Done,
          decoded: true,
          data: ({ state }) => (new ChildDone({ result: `${state.job}:complete` }))
        },
        CancelChildWork: {
          target: targets1.root.Cancelled,
          decoded: true,
          data: ({ event }) => (new ChildCancelled({ reason: event.reason }))
        }
      }
    },
    Done: {
      output: ({ state }) => state.result
    },
    Cancelled: {
      output: ({ state }) => state.reason
    }
  }
})
const ProtocolChild = Machine.child("protocol-child", requiredParentChildMachine)
class ParentIdle extends Schema.TaggedClass<ParentIdle>("ProtocolParentIdle")("Idle", {}) {
}
class Supervising extends Schema.TaggedClass<Supervising>("ProtocolSupervising")("Supervising", {
  latestProgress: Schema.Number
}) {
}
class ParentComplete extends Schema.TaggedClass<ParentComplete>("ProtocolParentComplete")("Complete", {
  result: Schema.String
}) {
}
class ParentFailed extends Schema.TaggedClass<ParentFailed>("ProtocolParentFailed")("Failed", {
  message: Schema.String
}) {
}
class LaunchChild extends Schema.TaggedClass<LaunchChild>("ProtocolLaunchChild")("LaunchChild", {}) {
}
class ResetParent extends Schema.TaggedClass<ResetParent>("ProtocolResetParent")("ResetParent", {}) {
}
const ParentStates = Machine.state({
  states: {
    Idle: ParentIdle,
    Supervising,
    Complete: { schema: ParentComplete, type: "final", output: Schema.String },
    Failed: ParentFailed
  }
})
const targets2 = Machine.targets(ParentStates)
export const parentProtocolMachine = Machine.make({
  branches: {
    transition1: { destination: { target: targets2.root.Supervising } },
    transition3: { destination: { target: targets2.root.Complete } }
  },
  children: { source1: ProtocolChild },
  id: "parent-child-protocol",
  root: ParentStates,
  events: Machine.eventsFromSchemas(LaunchChild, ResetParent, ParentEvents)
}).handle({
  initial: {
    target: Machine.targets(ParentStates).root.Idle,
    decoded: true,
    data: new ParentIdle({})
  },
  states: {
    Idle: {
      on: {
        LaunchChild: {
          target: targets2.root.Supervising,
          decoded: true,
          data: () => (new Supervising({ latestProgress: 0 }))
        }
      }
    },
    Supervising: {
      invoke: {
        src: "source1",
        onDone: {
          target: targets2.root.Complete,
          decoded: true,
          data: ({ output }) => (new ParentComplete({ result: output }))
        },
        onFailure: {
          target: targets2.root.Failed,
          decoded: true,
          data: ({ error }) => (new ParentFailed({ message: String(error) }))
        }
      },
      on: {
        ChildProgress: {
          target: targets2.root.Supervising,
          decoded: true,
          data: ({ event }) => (new Supervising({ latestProgress: event.percent }))
        },
        ChildFinished: {
          target: targets2.root.Complete,
          decoded: true,
          data: ({ event }) => (new ParentComplete({ result: event.result }))
        },
        ChildProblem: {
          target: targets2.root.Failed,
          decoded: true,
          data: ({ event }) => (new ParentFailed({ message: event.message }))
        },
        ResetParent: { target: targets2.root.Idle, decoded: true, data: () => (new ParentIdle({})) }
      }
    },
    Complete: {
      output: ({ state }) => state.result
    },
    Failed: {
      on: {
        ResetParent: { target: targets2.root.Idle, decoded: true, data: () => (new ParentIdle({})) }
      }
    }
  }
})
class Detached extends Schema.TaggedClass<Detached>("OptionalParentDetached")("Detached", {}) {
}
class Published extends Schema.TaggedClass<Published>("OptionalParentPublished")("Published", {
  deliveredToParent: Schema.Boolean
}) {
}
class PublishOutside extends Schema.TaggedClass<PublishOutside>("OptionalParentPublishOutside")("PublishOutside", {
  result: Schema.String
}) {
}
const OptionalParentStates = Machine.state({ states: { Detached, Published } })
const targets3 = Machine.targets(OptionalParentStates)
export const optionalParentMachine = Machine.make({
  branches: { transition1: { destination: { target: targets3.root.Published } } },
  id: "optional-parent-protocol",
  root: OptionalParentStates,
  events: Machine.eventsFromSchemas(PublishOutside),
  parent: Machine.optionalParent(ParentEvents)
}).handle({
  initial: {
    target: Machine.targets(OptionalParentStates).root.Detached,
    decoded: true,
    data: new Detached({})
  },
  states: {
    Detached: {
      on: {
        PublishOutside: {
          branches: "transition1",
          resolve: ({ event, parent, select: { destination: target } }, enqueue) => {
            if (parent !== undefined) {
              enqueue.sendTo(parent, ParentEvents.ChildFinished({ result: event.result }))
            }
            return target.decoded(new Published({ deliveredToParent: parent !== undefined }))
          }
        }
      }
    },
    Published: {}
  }
})
