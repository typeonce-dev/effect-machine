import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

const State = Schema.TaggedUnion({
  Application: {},
  Workflow: {},
  Idle: {},
  Running: { task: Schema.String },
  Editing: { note: Schema.String },
  Reviewing: { reviewer: Schema.String },
  Complete: { result: Schema.String },
  Connection: {},
  Online: { connectedAt: Schema.Number },
  Offline: { reason: Schema.String }
})

export const Event = Schema.TaggedUnion({
  Start: {
    task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24))
  },
  Edit: {
    note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20))
  },
  Submit: {
    reviewer: Schema.Literals(["Ada", "Grace", "Linus"])
  },
  Approve: {
    result: Schema.Literals(["approved", "changes-requested"])
  },
  Reset: {},
  Disconnect: {
    reason: Schema.Literals(["manual", "server", "wifi"])
  },
  Reconnect: {
    at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))
  }
})

export const VisualizerStates = Machine.defineStates({
  application: {
    schema: State.cases.Application,
    type: "parallel",
    states: {
      workflow: {
        schema: State.cases.Workflow,
        initial: "idle",
        states: {
          idle: State.cases.Idle,
          running: {
            schema: State.cases.Running,
            initial: "editing",
            states: {
              editing: State.cases.Editing,
              reviewing: State.cases.Reviewing
            }
          },
          complete: State.cases.Complete
        }
      },
      connection: {
        schema: State.cases.Connection,
        initial: "online",
        states: {
          online: State.cases.Online,
          offline: State.cases.Offline
        }
      }
    }
  }
})

const initial = () =>
  VisualizerStates.initial.application(State.cases.Application.make({}), (application) =>
    application
      .workflow(State.cases.Workflow.make({}), (workflow) => workflow.idle(State.cases.Idle.make({})))
      .connection(State.cases.Connection.make({}), (connection) =>
        connection.online(State.cases.Online.make({ connectedAt: 0 }))))

export const VisualizerMachine = Machine.make({
  id: "planner-sandbox",
  states: VisualizerStates.states,
  events: [Event],
  initial
}).handle({
  application: {
    states: {
      workflow: {
        states: {
          idle: {
            on: {
              Start: {
                targets: ["application.workflow.running"],
                transition: ({ event, target }) =>
                  target.local.running(
                    State.cases.Running.make({ task: event.task }),
                    (running) => running.editing(State.cases.Editing.make({ note: "draft" }))
                  )
              }
            }
          },
          running: {
            states: {
              editing: {
                on: {
                  Edit: {
                    targets: ["application.workflow.running.editing"],
                    transition: ({ event, target }) =>
                      target.local.editing(State.cases.Editing.make({ note: event.note }))
                  },
                  Submit: {
                    targets: ["application.workflow.running.reviewing"],
                    transition: ({ event, target }) =>
                      target.local.reviewing(State.cases.Reviewing.make({ reviewer: event.reviewer }))
                  }
                }
              },
              reviewing: {
                on: {
                  Approve: {
                    targets: ["application.workflow.complete"],
                    transition: ({ event, target }) =>
                      target.branch.application.workflow.complete(State.cases.Complete.make({ result: event.result }))
                  },
                  Edit: {
                    targets: ["application.workflow.running.editing"],
                    transition: ({ event, target }) =>
                      target.local.editing(State.cases.Editing.make({ note: event.note }))
                  }
                }
              }
            }
          },
          complete: {
            on: {
              Reset: {
                targets: ["application.workflow.idle"],
                transition: ({ target }) => target.local.idle(State.cases.Idle.make({}))
              }
            }
          }
        }
      },
      connection: {
        states: {
          online: {
            on: {
              Disconnect: {
                targets: ["application.connection.offline"],
                transition: ({ event, target }) =>
                  target.local.offline(State.cases.Offline.make({ reason: event.reason }))
              }
            }
          },
          offline: {
            on: {
              Reconnect: {
                targets: ["application.connection.online"],
                transition: ({ event, target }) =>
                  target.local.online(State.cases.Online.make({ connectedAt: event.at }))
              }
            }
          }
        }
      }
    }
  }
})

export type VisualizerEvent = Machine.Machine.InputEvent<typeof VisualizerMachine>
export type VisualizerSnapshot = Machine.Machine.Snapshot<Machine.Machine.States<typeof VisualizerMachine>>
