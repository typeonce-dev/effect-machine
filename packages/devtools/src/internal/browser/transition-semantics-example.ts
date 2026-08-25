import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

class Workspace extends Schema.TaggedClass<Workspace>("TransitionWorkspace")("Workspace", {
  revision: Schema.Number,
  preferredRoute: Schema.Literals(["draft", "review"])
}) {}
class Draft extends Schema.TaggedClass<Draft>("TransitionDraft")("Draft", {
  text: Schema.String,
  autosaves: Schema.Number
}) {}
class AutoSaving extends Schema.TaggedClass<AutoSaving>("TransitionAutoSaving")("AutoSaving", {}) {}
class Review extends Schema.TaggedClass<Review>("TransitionReview")("Review", {
  requestedBy: Schema.String
}) {}
class Checking extends Schema.TaggedClass<Checking>("TransitionChecking")("Checking", {
  checks: Schema.Array(Schema.String)
}) {}
class ChangesRequested extends Schema.TaggedClass<ChangesRequested>("TransitionChangesRequested")(
  "ChangesRequested",
  { reason: Schema.String }
) {}
class Approved extends Schema.TaggedClass<Approved>("TransitionApproved")("Approved", {
  reviewer: Schema.String
}) {}
class WorkspaceFinished extends Schema.TaggedClass<WorkspaceFinished>("TransitionWorkspaceFinished")(
  "Finished",
  { result: Schema.String }
) {}
class Paused extends Schema.TaggedClass<Paused>("TransitionPaused")("Paused", {
  reason: Schema.String
}) {}
class Published extends Schema.TaggedClass<Published>("TransitionPublished")("Published", {
  result: Schema.String
}) {}

class Create extends Schema.TaggedClass<Create>("TransitionCreate")("Create", {
  text: Schema.String,
  route: Schema.Literals(["draft", "review"])
}) {}
class Edit extends Schema.TaggedClass<Edit>("TransitionEdit")("Edit", { text: Schema.String }) {}
class Save extends Schema.TaggedClass<Save>("TransitionSave")("Save", {}) {}
class Submit extends Schema.TaggedClass<Submit>("TransitionSubmit")("Submit", {
  mode: Schema.Literals(["review", "publish"]),
  requestedBy: Schema.String
}) {}
class Approve extends Schema.TaggedClass<Approve>("TransitionApprove")("Approve", {
  reviewer: Schema.String
}) {}
class Reject extends Schema.TaggedClass<Reject>("TransitionReject")("Reject", {
  reason: Schema.String
}) {}
class Revise extends Schema.TaggedClass<Revise>("TransitionRevise")("Revise", {}) {}
class Pause extends Schema.TaggedClass<Pause>("TransitionPause")("Pause", { reason: Schema.String }) {}
class ResumeShallow extends Schema.TaggedClass<ResumeShallow>("TransitionResumeShallow")(
  "ResumeShallow",
  {}
) {}
class ResumeDeep extends Schema.TaggedClass<ResumeDeep>("TransitionResumeDeep")("ResumeDeep", {}) {}
class Restart extends Schema.TaggedClass<Restart>("TransitionRestart")("Restart", {}) {}
class Refresh extends Schema.TaggedClass<Refresh>("TransitionRefresh")("Refresh", {}) {}
class Ignore extends Schema.TaggedClass<Ignore>("TransitionIgnore")("Ignore", {}) {}
class MaybeHandle extends Schema.TaggedClass<MaybeHandle>("TransitionMaybeHandle")("MaybeHandle", {
  accept: Schema.Boolean
}) {}
class BumpWorkspace extends Schema.TaggedClass<BumpWorkspace>("TransitionBumpWorkspace")(
  "BumpWorkspace",
  {}
) {}

const TransitionStates = Machine.states({
  Workspace: {
    schema: Workspace,
    initial: "Routing",
    states: {
      Routing: { type: "choice" },
      Draft,
      AutoSaving,
      Review: {
        schema: Review,
        initial: "Checking",
        states: {
          Checking,
          ChangesRequested,
          Approved: { schema: Approved, type: "final" }
        }
      },
      Finished: { schema: WorkspaceFinished, type: "final" },
      recent: { type: "history" },
      exact: { type: "history", history: "deep" }
    }
  },
  Paused,
  Published: { schema: Published, type: "final", output: Schema.String }
})

const defaultWorkspaceSnapshot = () => ({
  path: "Workspace" as const,
  value: new Workspace({ revision: 0, preferredRoute: "draft" as const }),
  state: {
    path: "Workspace.Draft" as const,
    value: new Draft({ text: "Recovered draft", autosaves: 0 })
  }
})

export const transitionSemanticsMachine = Machine.make({
  id: "transition-semantics",
  states: TransitionStates.states,
  events: Machine.events(
    Create,
    Edit,
    Save,
    Submit,
    Approve,
    Reject,
    Revise,
    Pause,
    ResumeShallow,
    ResumeDeep,
    Restart,
    Refresh,
    Ignore,
    MaybeHandle,
    BumpWorkspace
  ),
  initial: (to) => to.Paused().resolve(({ target }) => target.decoded(new Paused({ reason: "not started" })))
}).handle({
  Workspace: {
    history: {
      recent: { default: defaultWorkspaceSnapshot },
      exact: { default: defaultWorkspaceSnapshot }
    },
    on: {
      Pause: (to) =>
        to.full.Paused().resolve(({ event, target }) => target.decoded(new Paused({ reason: event.reason }))),
      BumpWorkspace: (to) =>
        to.branch.Workspace.update(({ current, owner }) =>
          owner.decoded(
            new Workspace({
              revision: current.revision + 1,
              preferredRoute: current.preferredRoute
            })
          )
        )
    },
    onDone: (to) =>
      to.full.Published().resolve(({ target }) => target.decoded(new Published({ result: "workspace published" }))),
    states: {
      Routing: {
        choice: (to) =>
          to.branches({
            draft: { title: "Preferred route is draft", target: to.local.Draft() },
            review: { title: "Preferred route is review", target: to.local.Review.initial }
          }).resolve(({ containingState, select }) =>
            containingState.preferredRoute === "review"
              ? select.review.decoded(new Review({ requestedBy: "initial route" }))
              : select.draft.decoded(new Draft({ text: "", autosaves: 0 }))
          )
      },
      Draft: {
        on: {
          Edit: (to) =>
            to.local.Draft().resolve(({ event, state, target }) =>
              target.decoded(new Draft({ text: event.text, autosaves: state.autosaves }))
            ),
          Save: (to) => to.local.AutoSaving().resolve(({ target }) => target.decoded(new AutoSaving({}))),
          Submit: (to) =>
            to.branches({
              review: { title: "Enter the review flow", target: to.local.Review.initial },
              publish: { title: "Publish without review", target: to.local.Finished() }
            }).resolve(({ event, select }) =>
              event.mode === "publish"
                ? select.publish.decoded(new WorkspaceFinished({ result: "published directly" }))
                : select.review.decoded(new Review({ requestedBy: event.requestedBy }))
            ),
          Refresh: (to) => to.none.resolve(() => undefined, { reenter: true }),
          Ignore: (to) => to.none,
          MaybeHandle: (to) =>
            to.none.resolve(({ decline, event }) => event.accept ? undefined : decline(), {
              declinable: true
            })
        }
      },
      AutoSaving: {
        always: (to) =>
          to.local.Draft().resolve(({ target }) => target.decoded(new Draft({ text: "Autosaved draft", autosaves: 1 })))
      },
      Review: {
        initialize: ({ builder }) => builder.decoded(new Checking({ checks: ["types", "tests"] })),
        onDone: (to) =>
          to.branch.Workspace.Finished().resolve(({ target }) =>
            target.decoded(new WorkspaceFinished({ result: "approved review" }))
          ),
        states: {
          Checking: {
            on: {
              Approve: (to) =>
                to.local.Approved().resolve(({ event, target }) =>
                  target.decoded(new Approved({ reviewer: event.reviewer }))
                ),
              Reject: (to) =>
                to.local.ChangesRequested().resolve(({ event, target }) =>
                  target.decoded(new ChangesRequested({ reason: event.reason }))
                )
            }
          },
          ChangesRequested: {
            on: {
              Revise: (to) =>
                to.branch.Workspace.Draft().resolve(({ target }) =>
                  target.decoded(new Draft({ text: "Revised draft", autosaves: 0 }))
                )
            }
          }
        }
      }
    }
  },
  Paused: {
    on: {
      Create: (to) =>
        to.full.Workspace.initial.resolve(({ event, target }) =>
          target.decoded(new Workspace({ revision: 0, preferredRoute: event.route }))
        ),
      ResumeShallow: (to) => to.history.Workspace.recent.resolve(({ target }) => target()),
      ResumeDeep: (to) => to.history.Workspace.exact.resolve(({ target }) => target()),
      Restart: (to) =>
        to.full.Workspace.initial.resolve(({ target }) =>
          target.decoded(new Workspace({ revision: 0, preferredRoute: "draft" }))
        )
    }
  },
  Published: {
    output: ({ state }) => state.result
  }
})
