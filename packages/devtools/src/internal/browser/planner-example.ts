import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

class Idle extends Schema.TaggedClass<Idle>("PlannerIdle")("Idle", { owner: Schema.String }) {}
class Working extends Schema.TaggedClass<Working>("PlannerWorking")("Working", {
  owner: Schema.String,
  job: Schema.String
}) {}
class Finished extends Schema.TaggedClass<Finished>("PlannerFinished")("Finished", { job: Schema.String }) {}

class Begin extends Schema.TaggedClass<Begin>("PlannerBegin")("Begin", {
  job: Schema.String,
  priority: Schema.Literals(["normal", "urgent"])
}) {}
class Cancel extends Schema.TaggedClass<Cancel>("PlannerCancel")("Cancel", { reason: Schema.String }) {}
class AutoFinish extends Schema.TaggedClass<AutoFinish>("PlannerAutoFinish")("AutoFinish", {}) {}
class Planned extends Schema.TaggedClass<Planned>("PlannerPlanned")("Planned", { job: Schema.String }) {}

const Events = Machine.events(Begin, Cancel)
const InternalEvents = Machine.internalEvents(AutoFinish)
const Emissions = Machine.emittedEvents(Planned)
const States = Machine.states({
  Idle,
  Working,
  Finished: { schema: Finished, type: "final", output: Schema.String }
})

export const plannerMachine = Machine.make({
  id: "planner-example",
  states: States.states,
  events: Events,
  internalEvents: InternalEvents,
  emittedEvents: Emissions,
  input: Schema.Struct({ owner: Schema.String }),
  initial: (to) => to.Idle().resolve(({ input, target }) => target.decoded(new Idle({ owner: input.owner })))
}).handle({
  Idle: {
    on: {
      Begin: (to) =>
        to.branches({
          urgent: { title: "Finish immediately", target: to.full.Working() },
          normal: { title: "Wait in working", target: to.full.Working() }
        }).resolve(({ event, self, select, state }, enqueue) => {
          enqueue.emit(new Planned({ job: event.job }))
          enqueue.sendTo(self, Events.Cancel({ reason: "planner command example" }))
          if (event.priority === "urgent") enqueue.raise(InternalEvents.AutoFinish())
          const working = new Working({ owner: state.owner, job: event.job })
          return event.priority === "urgent"
            ? select.urgent.decoded(working)
            : select.normal.decoded(working)
        })
    }
  },
  Working: {
    on: {
      AutoFinish: (to) =>
        to.full.Finished().resolve(({ state, target }) => target.decoded(new Finished({ job: state.job }))),
      Cancel: (to) =>
        to.full.Idle().resolve(({ event, state, target }) =>
          target.decoded(new Idle({ owner: `${state.owner} · ${event.reason}` }))
        )
    }
  },
  Finished: {
    output: ({ state }) => state.job
  }
})
