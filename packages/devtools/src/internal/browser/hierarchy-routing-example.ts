import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

const ReviewState = Schema.TaggedUnion({
  Review: { title: Schema.String },
  ReviewFailed: { message: Schema.String },
  Complete: { slug: Schema.String }
})

const ReviewStates = Machine.states({
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
})

const ReviewEvents = Machine.events(
  Schema.TaggedUnion({
    Submit: { route: Schema.Literals(["save", "invalid"]) }
  })
)

const saveReview: Effect.Effect<string, string> = Effect.succeed("deterministic-chart")
const publishReview = Effect.succeed("deterministic-chart")

export const hierarchyRoutingMachine = Machine.make({
  id: "hierarchy-routing",
  states: ReviewStates.states,
  events: ReviewEvents,
  initial: (to) =>
    to.Workflow.initial.resolve(({ target }) =>
      target.from((workflow) =>
        workflow.Review.from({ title: "A deterministic chart" }, (review) => review.Form.from())
      )
    )
}).handle({
  Workflow: {
    states: {
      Review: {
        on: {
          Submit: (to) =>
            to.branches({
              save: {
                title: "Save the review",
                target: to.branch.Workflow.Saving()
              },
              invalid: {
                title: "Show validation failure",
                target: to.local.Failed()
              }
            }).resolve(({ event, select }) =>
              event.route === "save"
                ? select.save.from()
                : select.invalid.from({ message: "Add a title before continuing." })
            )
        },
        states: {
          Form: {},
          Failed: {}
        }
      },
      Saving: {
        invoke: (from) =>
          from.effect("save-review", () => saveReview).onDone((to) => to.branch.Workflow.Publishing()).onFailure((to) =>
            to.branch.Workflow.Review.Failed().resolve(({ target }) =>
              target.from({ message: "The review could not be saved." })
            )
          )
      },
      Publishing: {
        invoke: (from) =>
          from.effect("publish-review", () => publishReview).onDone((to) =>
            to.branch.Workflow.Complete().resolve(({ output, target }) => target.from({ slug: output }))
          )
      },
      Complete: {}
    }
  }
})
