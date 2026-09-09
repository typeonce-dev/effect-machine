import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"
class Workspace extends Schema.TaggedClass<Workspace>("TransitionWorkspace")("Workspace", {
  revision: Schema.Number,
  preferredRoute: Schema.Literals(["draft", "review"])
}) {
}
class Draft extends Schema.TaggedClass<Draft>("TransitionDraft")("Draft", {
  text: Schema.String,
  autosaves: Schema.Number
}) {
}
class AutoSaving extends Schema.TaggedClass<AutoSaving>("TransitionAutoSaving")("AutoSaving", {}) {
}
class Review extends Schema.TaggedClass<Review>("TransitionReview")("Review", {
  requestedBy: Schema.String
}) {
}
class Checking extends Schema.TaggedClass<Checking>("TransitionChecking")("Checking", {
  checks: Schema.Array(Schema.String)
}) {
}
class ChangesRequested extends Schema.TaggedClass<ChangesRequested>("TransitionChangesRequested")("ChangesRequested", {
  reason: Schema.String
}) {
}
class Approved extends Schema.TaggedClass<Approved>("TransitionApproved")("Approved", {
  reviewer: Schema.String
}) {
}
class WorkspaceFinished
  extends Schema.TaggedClass<WorkspaceFinished>("TransitionWorkspaceFinished")("Finished", { result: Schema.String })
{
}
class Paused extends Schema.TaggedClass<Paused>("TransitionPaused")("Paused", {
  reason: Schema.String
}) {
}
class Published extends Schema.TaggedClass<Published>("TransitionPublished")("Published", {
  result: Schema.String
}) {
}
class Disabled extends Schema.TaggedClass<Disabled>("TransitionDisabled")("Disabled", {
  reason: Schema.String
}) {
}
class Create extends Schema.TaggedClass<Create>("TransitionCreate")("Create", {
  text: Schema.String,
  route: Schema.Literals(["draft", "review"])
}) {
}
class Edit extends Schema.TaggedClass<Edit>("TransitionEdit")("Edit", { text: Schema.String }) {
}
class Save extends Schema.TaggedClass<Save>("TransitionSave")("Save", {}) {
}
class Submit extends Schema.TaggedClass<Submit>("TransitionSubmit")("Submit", {
  mode: Schema.Literals(["review", "publish"]),
  requestedBy: Schema.String
}) {
}
class Approve extends Schema.TaggedClass<Approve>("TransitionApprove")("Approve", {
  reviewer: Schema.String
}) {
}
class Reject extends Schema.TaggedClass<Reject>("TransitionReject")("Reject", {
  reason: Schema.String
}) {
}
class Revise extends Schema.TaggedClass<Revise>("TransitionRevise")("Revise", {}) {
}
class Pause extends Schema.TaggedClass<Pause>("TransitionPause")("Pause", { reason: Schema.String }) {
}
class ResumeShallow extends Schema.TaggedClass<ResumeShallow>("TransitionResumeShallow")("ResumeShallow", {}) {
}
class ResumeDeep extends Schema.TaggedClass<ResumeDeep>("TransitionResumeDeep")("ResumeDeep", {}) {
}
class Restart extends Schema.TaggedClass<Restart>("TransitionRestart")("Restart", {}) {
}
class Refresh extends Schema.TaggedClass<Refresh>("TransitionRefresh")("Refresh", {}) {
}
class Ignore extends Schema.TaggedClass<Ignore>("TransitionIgnore")("Ignore", {}) {
}
class MaybeHandle extends Schema.TaggedClass<MaybeHandle>("TransitionMaybeHandle")("MaybeHandle", {
  accept: Schema.Boolean
}) {
}
class BumpWorkspace extends Schema.TaggedClass<BumpWorkspace>("TransitionBumpWorkspace")("BumpWorkspace", {}) {
}
class Archive extends Schema.TaggedClass<Archive>("TransitionArchive")("Archive", {
  reason: Schema.String
}) {
}
const TransitionStates = Machine.state({
  states: {
    Workspace: {
      schema: Workspace,
      states: {
        Routing: { type: "choice" },
        Draft,
        AutoSaving,
        Review: {
          schema: Review,
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
    Disabled,
    Published: { schema: Published, type: "final", output: Schema.String }
  }
})
const defaultWorkspaceSnapshot = () => ({
  path: "" as const,
  value: undefined,
  state: {
    path: "Workspace" as const,
    value: new Workspace({ revision: 0, preferredRoute: "draft" as const }),
    state: {
      path: "Workspace.Draft" as const,
      value: new Draft({ text: "Recovered draft", autosaves: 0 })
    }
  }
})
const targets1 = Machine.targets(TransitionStates)
export const transitionSemanticsMachine = Machine.make({
  branches: {
    transition4: {
      draft: { target: targets1.root.Workspace.Draft, title: "Preferred route is draft" },
      review: { initial: targets1.root.Workspace.Review, title: "Preferred route is review" }
    },
    transition7: {
      review: { initial: targets1.root.Workspace.Review, title: "Enter the review flow" },
      publish: { target: targets1.root.Workspace.Finished, title: "Publish without review" }
    },
    transition14: { destination: { history: targets1.root.Workspace.recent } },
    transition15: { destination: { history: targets1.root.Workspace.exact } }
  },
  id: "transition-semantics",
  root: TransitionStates,
  events: Machine.eventsFromSchemas(
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
    BumpWorkspace,
    Archive
  )
}).handle({
  initial: {
    target: Machine.targets(TransitionStates).root.Paused,
    decoded: true,
    data: new Paused({ reason: "not started" })
  },
  states: {
    Workspace: {
      initial: {
        target: Machine.targets(TransitionStates).root.Workspace.Routing
      },
      history: {
        recent: { default: defaultWorkspaceSnapshot },
        exact: { default: defaultWorkspaceSnapshot }
      },
      on: {
        Pause: {
          target: targets1.root.Paused,
          decoded: true,
          data: ({ event }) => (new Paused({ reason: event.reason }))
        },
        BumpWorkspace: {
          update: targets1.root.Workspace,
          decoded: true,
          data: ({ state: current }) => (new Workspace({
            revision: current.revision + 1,
            preferredRoute: current.preferredRoute
          }))
        }
      },
      onDone: {
        target: targets1.root.Published,
        decoded: true,
        data: () => (new Published({ result: "workspace published" }))
      },
      states: {
        Routing: {
          choice: {
            branches: "transition4",
            resolve: ({ containingState, select }) =>
              containingState.preferredRoute === "review"
                ? select.review.decoded(new Review({ requestedBy: "initial route" }))
                : select.draft.decoded(new Draft({ text: "", autosaves: 0 }))
          }
        },
        Draft: {
          on: {
            Edit: {
              target: targets1.root.Workspace.Draft,
              decoded: true,
              data: ({ event, state }) => (new Draft({ text: event.text, autosaves: state.autosaves }))
            },
            Save: { target: targets1.root.Workspace.AutoSaving, decoded: true, data: () => (new AutoSaving({})) },
            Submit: {
              branches: "transition7",
              resolve: ({ event, select }) =>
                event.mode === "publish"
                  ? select.publish.decoded(new WorkspaceFinished({ result: "published directly" }))
                  : select.review.decoded(new Review({ requestedBy: event.requestedBy }))
            },
            Refresh: { none: true, reenter: true },
            Ignore: { none: true },
            MaybeHandle: {
              none: true,
              resolve: ({ decline, event }) => event.accept ? undefined : decline(),
              declinable: true
            }
          }
        },
        AutoSaving: {
          always: {
            target: targets1.root.Workspace.Draft,
            decoded: true,
            data: () => (new Draft({ text: "Autosaved draft", autosaves: 1 }))
          }
        },
        Review: {
          initial: {
            target: Machine.targets(TransitionStates).root.Workspace.Review.Checking,
            decoded: true,
            data: ({}) => new Checking({ checks: ["types", "tests"] })
          },
          onDone: {
            target: targets1.root.Workspace.Finished,
            decoded: true,
            data: () => (new WorkspaceFinished({ result: "approved review" }))
          },
          states: {
            Checking: {
              on: {
                Approve: {
                  target: targets1.root.Workspace.Review.Approved,
                  decoded: true,
                  data: ({ event }) => (new Approved({ reviewer: event.reviewer }))
                },
                Reject: {
                  target: targets1.root.Workspace.Review.ChangesRequested,
                  decoded: true,
                  data: ({ event }) => (new ChangesRequested({ reason: event.reason }))
                }
              }
            },
            ChangesRequested: {
              on: {
                Revise: {
                  target: targets1.root.Workspace.Draft,
                  decoded: true,
                  data: () => (new Draft({ text: "Revised draft", autosaves: 0 }))
                }
              }
            },
            Approved: {}
          }
        },
        Finished: {}
      }
    },
    Paused: {
      on: {
        Create: {
          initial: targets1.root.Workspace,
          decoded: true,
          data: ({ event }) => (new Workspace({ revision: 0, preferredRoute: event.route }))
        },
        ResumeShallow: { branches: "transition14", resolve: ({ select: { destination: target } }) => target() },
        ResumeDeep: { branches: "transition15", resolve: ({ select: { destination: target } }) => target() },
        Restart: {
          initial: targets1.root.Workspace,
          decoded: true,
          data: () => (new Workspace({ revision: 0, preferredRoute: "draft" }))
        }
      }
    },
    Disabled: {},
    Published: {
      output: ({ state }) => state.result
    }
  }
})
