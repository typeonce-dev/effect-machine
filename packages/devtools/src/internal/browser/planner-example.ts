import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"
import * as Effect from "effect/Effect"

class Idle extends Schema.TaggedClass<Idle>("PlannerIdle")("Idle", { owner: Schema.String }) {}
class Working extends Schema.TaggedClass<Working>("PlannerWorking")("Working", {
  owner: Schema.String,
  job: Schema.String
}) {}
class Finished extends Schema.TaggedClass<Finished>("PlannerFinished")("Finished", { job: Schema.String }) {}

const Owner = Schema.NonEmptyString.annotate({
  title: "Owner",
  description: "A non-empty name carried into the initial Idle state."
})
const Attempts = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })).annotate({
  title: "Attempts",
  description: "An integer between one and five."
})
const Labels = Schema.Array(Schema.NonEmptyString).check(Schema.isLengthBetween(1, 3)).annotate({
  title: "Labels",
  description: "One to three non-empty labels."
})
const Route = Schema.Union([
  Schema.Literal("direct").annotate({ title: "Direct" }),
  Schema.Struct({
    queue: Schema.NonEmptyString.annotate({
      title: "Queue",
      description: "The queue used by the queued route."
    })
  }).annotate({ title: "Queued" })
]).annotate({
  title: "Route",
  description: "Choose a literal direct route or provide a queue."
})

class Begin extends Schema.TaggedClass<Begin>("PlannerBegin")("Begin", {
  job: Schema.NonEmptyString.annotate({
    title: "Job",
    description: "A non-empty job name used as the final output."
  }),
  priority: Schema.Literals(["normal", "urgent"]).annotate({
    title: "Priority",
    description: "Urgent jobs raise AutoFinish during the same macrostep."
  }),
  estimate: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })).annotate({
    title: "Estimate",
    description: "A numeric estimate between zero and one hundred."
  }),
  approved: Schema.Boolean.annotate({
    title: "Approved",
    description: "A boolean checkbox included in the event payload."
  }),
  notes: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(80)).annotate({
      title: "Notes",
      description: "Optional text limited to eighty characters."
    })
  ),
  labels: Schema.optionalKey(Labels),
  route: Schema.optionalKey(Route)
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
  input: Schema.Struct({
    owner: Owner,
    attempts: Attempts,
    notifications: Schema.Boolean.annotate({
      title: "Notifications",
      description: "A required boolean with false as a valid value."
    }),
    mode: Schema.Literals(["guided", "automatic"]).annotate({
      title: "Mode",
      description: "A fixed set of startup modes."
    }),
    note: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(40)).annotate({
        title: "Note",
        description: "Optional startup text limited to forty characters."
      })
    ),
    labels: Schema.optionalKey(Labels),
    preferences: Schema.optionalKey(
      Schema.Struct({
        retries: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })).annotate({
          title: "Retries"
        }),
        dryRun: Schema.Boolean.annotate({ title: "Dry run" })
      }).annotate({
        title: "Preferences",
        description: "An optional nested object."
      })
    )
  }),
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
    invoke: (from) => from.effect("monitor-job", () => Effect.never),
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
