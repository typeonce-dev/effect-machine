import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

class ChildProgress extends Schema.TaggedClass<ChildProgress>("ProtocolChildProgress")("ChildProgress", {
  percent: Schema.Number
}) {}
class ChildFinished extends Schema.TaggedClass<ChildFinished>("ProtocolChildFinished")("ChildFinished", {
  result: Schema.String
}) {}
class ChildProblem extends Schema.TaggedClass<ChildProblem>("ProtocolChildProblem")("ChildProblem", {
  message: Schema.String
}) {}

const ParentEvents = Machine.events(ChildProgress, ChildFinished, ChildProblem)

class ChildIdle extends Schema.TaggedClass<ChildIdle>("ProtocolChildIdle")("Idle", {}) {}
class ChildWorking extends Schema.TaggedClass<ChildWorking>("ProtocolChildWorking")("Working", {
  job: Schema.String,
  progress: Schema.Number
}) {}
class ChildDone extends Schema.TaggedClass<ChildDone>("ProtocolChildDone")("Done", {
  result: Schema.String
}) {}
class ChildCancelled extends Schema.TaggedClass<ChildCancelled>("ProtocolChildCancelled")("Cancelled", {
  reason: Schema.String
}) {}

class BeginChildWork extends Schema.TaggedClass<BeginChildWork>("ProtocolBeginChildWork")("BeginChildWork", {
  job: Schema.String
}) {}
class CancelChildWork extends Schema.TaggedClass<CancelChildWork>("ProtocolCancelChildWork")(
  "CancelChildWork",
  { reason: Schema.String }
) {}
class Heartbeat extends Schema.TaggedClass<Heartbeat>("ProtocolHeartbeat")("Heartbeat", {
  percent: Schema.Number
}) {}
class CommitChildWork extends Schema.TaggedClass<CommitChildWork>("ProtocolCommitChildWork")(
  "CommitChildWork",
  {}
) {}
class ChildTrace extends Schema.TaggedClass<ChildTrace>("ProtocolChildTrace")("ChildTrace", {
  message: Schema.String
}) {}

const ChildEvents = Machine.events(BeginChildWork, CancelChildWork)
const ChildInternalEvents = Machine.internalEvents(Heartbeat, CommitChildWork)
const ChildEmissions = Machine.emittedEvents(ChildTrace)
const ChildStates = Machine.states({
  Idle: ChildIdle,
  Working: ChildWorking,
  Done: { schema: ChildDone, type: "final", output: Schema.String },
  Cancelled: { schema: ChildCancelled, type: "final", output: Schema.String }
})

export const requiredParentChildMachine = Machine.make({
  id: "required-parent-child",
  states: ChildStates.states,
  events: ChildEvents,
  internalEvents: ChildInternalEvents,
  emittedEvents: ChildEmissions,
  parent: Machine.parent(ParentEvents),
  initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new ChildIdle({})))
}).handle({
  Idle: {
    on: {
      BeginChildWork: (to) =>
        to.full.Working().resolve(({ event, target }, enqueue) => {
          enqueue.raise(ChildInternalEvents.Heartbeat({ percent: 25 }))
          enqueue.emit(ChildEmissions.ChildTrace({ message: `started ${event.job}` }))
          return target.decoded(new ChildWorking({ job: event.job, progress: 0 }))
        })
    }
  },
  Working: {
    invoke: (from) =>
      from.effect(
        "report-progress-to-parent",
        ({ parent, state }) => parent.send(ParentEvents.ChildProgress({ percent: state.progress }))
      ).onDone((to) => to.none).onFailure((to) =>
        to.full.Cancelled().resolve(({ error, target }) =>
          target.decoded(new ChildCancelled({ reason: String(error) }))
        )
      ),
    on: {
      Heartbeat: (to) =>
        to.full.Working().resolve(({ event, state, target }, enqueue) => {
          enqueue.raise(ChildInternalEvents.CommitChildWork())
          return target.decoded(new ChildWorking({ job: state.job, progress: event.percent }))
        }),
      CommitChildWork: (to) =>
        to.full.Done().resolve(({ state, target }) =>
          target.decoded(new ChildDone({ result: `${state.job}:complete` }))
        ),
      CancelChildWork: (to) =>
        to.full.Cancelled().resolve(({ event, target }) => target.decoded(new ChildCancelled({ reason: event.reason })))
    }
  },
  Done: {
    output: ({ state }) => state.result
  },
  Cancelled: {
    output: ({ state }) => state.reason
  }
})

const ProtocolChild = Machine.child("protocol-child", requiredParentChildMachine)

class ParentIdle extends Schema.TaggedClass<ParentIdle>("ProtocolParentIdle")("Idle", {}) {}
class Supervising extends Schema.TaggedClass<Supervising>("ProtocolSupervising")("Supervising", {
  latestProgress: Schema.Number
}) {}
class ParentComplete extends Schema.TaggedClass<ParentComplete>("ProtocolParentComplete")("Complete", {
  result: Schema.String
}) {}
class ParentFailed extends Schema.TaggedClass<ParentFailed>("ProtocolParentFailed")("Failed", {
  message: Schema.String
}) {}
class LaunchChild extends Schema.TaggedClass<LaunchChild>("ProtocolLaunchChild")("LaunchChild", {}) {}
class ResetParent extends Schema.TaggedClass<ResetParent>("ProtocolResetParent")("ResetParent", {}) {}

const ParentStates = Machine.states({
  Idle: ParentIdle,
  Supervising,
  Complete: { schema: ParentComplete, type: "final", output: Schema.String },
  Failed: ParentFailed
})

export const parentProtocolMachine = Machine.make({
  id: "parent-child-protocol",
  states: ParentStates.states,
  events: Machine.events(LaunchChild, ResetParent, ParentEvents),
  initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new ParentIdle({})))
}).handle({
  Idle: {
    on: {
      LaunchChild: (to) =>
        to.full.Supervising().resolve(({ target }) => target.decoded(new Supervising({ latestProgress: 0 })))
    }
  },
  Supervising: {
    invoke: (from) =>
      from.child(ProtocolChild).onDone((to) =>
        to.full.Complete().resolve(({ output, target }) => target.decoded(new ParentComplete({ result: output })))
      ).onFailure((to) =>
        to.full.Failed().resolve(({ error, target }) => target.decoded(new ParentFailed({ message: String(error) })))
      ),
    on: {
      ChildProgress: (to) =>
        to.full.Supervising().resolve(({ event, target }) =>
          target.decoded(new Supervising({ latestProgress: event.percent }))
        ),
      ChildFinished: (to) =>
        to.full.Complete().resolve(({ event, target }) => target.decoded(new ParentComplete({ result: event.result }))),
      ChildProblem: (to) =>
        to.full.Failed().resolve(({ event, target }) => target.decoded(new ParentFailed({ message: event.message }))),
      ResetParent: (to) => to.full.Idle().resolve(({ target }) => target.decoded(new ParentIdle({})))
    }
  },
  Complete: {
    output: ({ state }) => state.result
  },
  Failed: {
    on: {
      ResetParent: (to) => to.full.Idle().resolve(({ target }) => target.decoded(new ParentIdle({})))
    }
  }
})

class Detached extends Schema.TaggedClass<Detached>("OptionalParentDetached")("Detached", {}) {}
class Published extends Schema.TaggedClass<Published>("OptionalParentPublished")("Published", {
  deliveredToParent: Schema.Boolean
}) {}
class PublishOutside extends Schema.TaggedClass<PublishOutside>("OptionalParentPublishOutside")(
  "PublishOutside",
  { result: Schema.String }
) {}

const OptionalParentStates = Machine.states({ Detached, Published })

export const optionalParentMachine = Machine.make({
  id: "optional-parent-protocol",
  states: OptionalParentStates.states,
  events: Machine.events(PublishOutside),
  parent: Machine.optionalParent(ParentEvents),
  initial: (to) => to.Detached().resolve(({ target }) => target.decoded(new Detached({})))
}).handle({
  Detached: {
    on: {
      PublishOutside: (to) =>
        to.full.Published().resolve(({ event, parent, target }, enqueue) => {
          if (parent !== undefined) {
            enqueue.sendTo(parent, ParentEvents.ChildFinished({ result: event.result }))
          }
          return target.decoded(new Published({ deliveredToParent: parent !== undefined }))
        })
    }
  },
  Published: {}
})
