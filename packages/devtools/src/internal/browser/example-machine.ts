import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

// Shared by the live browser UI and its project-inspection fixture.

class Application extends Schema.TaggedClass<Application>("Application")("Application", {
  workspace: Schema.String,
  revision: Schema.Number
}) {}
class Workflow extends Schema.TaggedClass<Workflow>("Workflow")("Workflow", {
  document: Schema.String,
  unsavedChanges: Schema.Number
}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Running extends Schema.TaggedClass<Running>("Running")("Running", {}) {}
class Editing extends Schema.TaggedClass<Editing>("Editing")("Editing", {}) {}
class Complete extends Schema.TaggedClass<Complete>("Complete")("Complete", {}) {}
class Connection extends Schema.TaggedClass<Connection>("Connection")("Connection", {}) {}
class Online extends Schema.TaggedClass<Online>("Online")("Online", {}) {}
class Offline extends Schema.TaggedClass<Offline>("Offline")("Offline", {}) {}
class Disabled extends Schema.TaggedClass<Disabled>("Disabled")("Disabled", {}) {}
class Start extends Schema.TaggedClass<Start>("Start")("Start", {}) {}
class Finish extends Schema.TaggedClass<Finish>("Finish")("Finish", {}) {}
class Disconnect extends Schema.TaggedClass<Disconnect>("Disconnect")("Disconnect", {}) {}
class Refresh extends Schema.TaggedClass<Refresh>("Refresh")("Refresh", {}) {}

const States = Machine.state({
  initial: "application",
  states: {
    application: {
      schema: Application,
      type: "parallel",
      states: {
        workflow: {
          schema: Workflow,
          initial: "idle",
          states: {
            idle: Idle,
            running: {
              schema: Running,
              initial: "editing",
              states: {
                editing: Editing,
                complete: {
                  schema: Complete,
                  type: "final"
                }
              }
            },
            recent: {
              type: "history"
            }
          }
        },
        connection: {
          schema: Connection,
          initial: "online",
          states: {
            online: Online,
            offline: Offline
          }
        }
      }
    },
    disabled: Disabled
  }
})

export const snapshot = {
  path: "" as const,
  value: undefined,
  state: {
    path: "application" as const,
    value: new Application({ workspace: "effect-machine", revision: 7 }),
    states: {
      workflow: {
        path: "application.workflow" as const,
        value: new Workflow({ document: "Machine.ts", unsavedChanges: 2 }),
        state: { path: "application.workflow.idle" as const, value: new Idle({}) }
      },
      connection: {
        path: "application.connection" as const,
        value: new Connection({}),
        state: { path: "application.connection.online" as const, value: new Online({}) }
      }
    }
  }
}

const initialWorkflow = (): Machine.Machine.CompleteSnapshotContaining<
  { readonly "": typeof States.node },
  "application.workflow"
> => snapshot

const targets1 = Machine.targets(States)
export const machine = Machine.make({
  branches: {
    transition1: {
      destination: { target: targets1.root.application.workflow.running, update: targets1.root.application.workflow }
    }
  },

  id: "inspection-example",
  root: States,
  events: Machine.eventsFromSchemas(Start, Finish, Disconnect, Refresh),
  initialConfiguration: (to) => to.resolve(() => snapshot)
}).handle({
  states: {
    application: {
      states: {
        workflow: {
          history: {
            recent: {
              default: initialWorkflow
            }
          },
          states: {
            idle: {
              on: {
                Start: {
                  branches: "transition1",
                  resolve: ({ select: { destination: target } }) =>
                    target.decoded(
                      new Running({}),
                      (running) => running.editing.decoded(new Editing({}))
                    ).update.decoded(new Workflow({ document: "Machine.ts", unsavedChanges: 3 }))
                },
                Refresh: {
                  update: targets1.root.application.workflow,
                  decoded: () => (new Workflow({ document: "Machine.ts", unsavedChanges: 0 }))
                }
              }
            },
            running: {
              initialize: ({ builder }) => builder.decoded(new Editing({})),
              states: {
                editing: {
                  on: {
                    Finish: {
                      target: targets1.root.application.workflow.running.complete,
                      decoded: () => (new Complete({}))
                    }
                  }
                }
              }
            }
          }
        },
        connection: {
          states: {
            online: {
              on: {
                Disconnect: { target: targets1.root.application.connection.offline, decoded: () => (new Offline({})) }
              }
            }
          }
        }
      }
    }
  }
})
