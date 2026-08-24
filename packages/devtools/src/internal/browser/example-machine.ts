import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

// Shared by the live browser UI and its project-inspection fixture.

class Application extends Schema.TaggedClass<Application>("Application")("Application", {}) {}
class Workflow extends Schema.TaggedClass<Workflow>("Workflow")("Workflow", {}) {}
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

const States = Machine.states({
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
})

export const snapshot = {
  path: "application" as const,
  value: new Application({}),
  states: {
    workflow: {
      path: "application.workflow" as const,
      value: new Workflow({}),
      state: { path: "application.workflow.idle" as const, value: new Idle({}) }
    },
    connection: {
      path: "application.connection" as const,
      value: new Connection({}),
      state: { path: "application.connection.online" as const, value: new Online({}) }
    }
  }
}

const initialWorkflow = (): Machine.Machine.CompleteSnapshotContaining<
  typeof States.states,
  "application.workflow"
> => snapshot

export const machine = Machine.make({
  id: "inspection-example",
  states: States.states,
  events: Machine.events(Start, Finish, Disconnect, Refresh),
  initial: (to) => to.application.initial.resolve(() => snapshot)
}).handle({
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
              Start: (to) =>
                to.local.running()
                  .updating(to.branch.application.workflow)
                  .resolve(({ owner, target }) =>
                    target.decoded(
                      new Running({}),
                      (running) => running.editing.decoded(new Editing({}))
                    ).update(owner.decoded(new Workflow({})))
                  ),
              Refresh: (to) => to.local.update(({ owner }) => owner.decoded(new Workflow({})))
            }
          },
          running: {
            initialize: ({ builder }) => builder.decoded(new Editing({})),
            states: {
              editing: {
                on: {
                  Finish: (to) => to.local.complete().resolve(({ target }) => target.decoded(new Complete({})))
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
              Disconnect: (to) => to.local.offline().resolve(({ target }) => target.decoded(new Offline({})))
            }
          }
        }
      }
    }
  }
})
