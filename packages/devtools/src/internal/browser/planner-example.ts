import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"
import * as Effect from "effect/Effect"
class Idle extends Schema.TaggedClass<Idle>("PlannerIdle")("Idle", { owner: Schema.String }) {
}
class Working extends Schema.TaggedClass<Working>("PlannerWorking")("Working", {
  owner: Schema.String,
  job: Schema.String
}) {
}
class Finished extends Schema.TaggedClass<Finished>("PlannerFinished")("Finished", { job: Schema.String }) {
}
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
}) {
}
class Cancel extends Schema.TaggedClass<Cancel>("PlannerCancel")("Cancel", { reason: Schema.String }) {
}
class AutoFinish extends Schema.TaggedClass<AutoFinish>("PlannerAutoFinish")("AutoFinish", {}) {
}
class Planned extends Schema.TaggedClass<Planned>("PlannerPlanned")("Planned", { job: Schema.String }) {
}
const Events = Machine.eventsFromSchemas(Begin, Cancel)
const InternalEvents = Machine.internalEventsFromSchemas(AutoFinish)
const Emissions = Machine.emittedEventsFromSchemas(Planned)
const States = Machine.state({
  fields: {
    input: Schema.toType(Schema.Struct({
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
    }))
  },
  states: {
    Idle,
    Working,
    Finished: { schema: Finished, type: "final", output: Schema.String }
  }
})
const targets1 = Machine.targets(States)
export const plannerMachine = Machine.make({
  branches: {
    transition1: {
      urgent: { target: targets1.root.Working, title: "Finish immediately" },
      normal: { target: targets1.root.Working, title: "Wait in working" }
    }
  },
  effects: { source1: Effect.suspend(() => Effect.never) },
  id: "planner-example",
  root: States,
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
  })
}).handle({
  initial: {
    target: Machine.targets(States).root.Idle,
    decoded: true,
    data: ({ root: { input: input } }) => new Idle({ owner: input.owner })
  },
  root: ({ input }) => ({ input }),
  states: {
    Idle: {
      on: {
        Begin: {
          branches: "transition1",
          resolve: ({ event, self, select, state }, enqueue) => {
            enqueue.emit(new Planned({ job: event.job }))
            enqueue.sendTo(self, Events.Cancel({ reason: "planner command example" }))
            if (event.priority === "urgent") {
              enqueue.raise(InternalEvents.AutoFinish())
            }
            const working = new Working({ owner: state.owner, job: event.job })
            return event.priority === "urgent"
              ? select.urgent.decoded(working)
              : select.normal.decoded(working)
          }
        }
      }
    },
    Working: {
      invoke: { src: "source1", id: "monitor-job" },
      on: {
        AutoFinish: {
          target: targets1.root.Finished,
          decoded: true,
          data: ({ state }) => (new Finished({ job: state.job }))
        },
        Cancel: {
          target: targets1.root.Idle,
          decoded: true,
          data: ({ event, state }) => (new Idle({ owner: `${state.owner} · ${event.reason}` }))
        }
      }
    },
    Finished: {
      output: ({ state }) => state.job
    }
  }
})
