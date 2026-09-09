import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

const ReviewState = Schema.TaggedUnion({
  Review: { title: Schema.String },
  ReviewFailed: { message: Schema.String },
  Complete: { slug: Schema.String }
})

const ReviewStates = Machine.state({
  initial: "Workflow",
  states: {
    Workflow: {
      initial: "Review",
      states: {
        Review: {
          schema: ReviewState.cases.Review,
          initial: "Form",
          states: {
            Form: {},
            Failed: ReviewState.cases.ReviewFailed
          }
        },
        Saving: {},
        Publishing: {},
        Complete: ReviewState.cases.Complete
      }
    }
  }
})

const ReviewEvents = Machine.eventsFromSchemas(
  Schema.TaggedUnion({
    Submit: { route: Schema.Literals(["save", "invalid"]) }
  })
)

const saveReview: Effect.Effect<string, string> = Effect.succeed("deterministic-chart")
const publishReview = Effect.succeed("deterministic-chart")

const targets1 = Machine.targets(ReviewStates)
export const hierarchyRoutingMachine = Machine.make({
  branches: {
    transition1: {
      save: { target: targets1.root.Workflow.Saving, title: "Save the review" },
      invalid: { target: targets1.root.Workflow.Review.Failed, title: "Show validation failure" }
    }
  },
  effects: { source1: Effect.suspend(() => saveReview), source2: Effect.suspend(() => publishReview) },

  id: "hierarchy-routing",
  root: ReviewStates,
  events: ReviewEvents,
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) =>
        to.Workflow.from((workflow) =>
          workflow.Review.from({ title: "A deterministic chart" }, (review) => review.Form.from())
        )
      )
    )
}).handle({
  states: {
    Workflow: {
      states: {
        Review: {
          on: {
            Submit: {
              branches: "transition1",
              resolve: ({ event, select }) =>
                event.route === "save"
                  ? select.save.from()
                  : select.invalid.from({ message: "Add a title before continuing." })
            }
          },
          states: {
            Form: {},
            Failed: {}
          }
        },
        Saving: {
          invoke: {
            src: "source1",
            id: "save-review",
            onDone: { target: targets1.root.Workflow.Publishing },
            onFailure: {
              target: targets1.root.Workflow.Review.Failed,
              from: () => ({ message: "The review could not be saved." })
            }
          }
        },
        Publishing: {
          invoke: {
            src: "source2",
            id: "publish-review",
            onDone: { target: targets1.root.Workflow.Complete, from: ({ output }) => ({ slug: output }) }
          }
        },
        Complete: {}
      }
    }
  }
})
