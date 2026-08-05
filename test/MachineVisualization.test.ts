import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import { Machine } from "../src/index.js"
import { makeTextRenderer } from "./visualization/text.js"

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
class Disconnect extends Schema.TaggedClass<Disconnect>("Disconnect")("Disconnect", {}) {}
class Refresh extends Schema.TaggedClass<Refresh>("Refresh")("Refresh", {}) {}

const States = Machine.defineStates({
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

const initial = States.initial.application(
  new Application({}),
  (application) =>
    application
      .workflow(new Workflow({}), (workflow) => workflow.idle(new Idle({})))
      .connection(new Connection({}), (connection) => connection.online(new Online({})))
)

const initialWorkflow = (): Machine.Machine.SnapshotByIdentifier<typeof States.states, "application.workflow"> => ({
  path: "application.workflow",
  value: new Workflow({}),
  state: {
    path: "application.workflow.idle",
    value: new Idle({})
  }
})

const machine = Machine.make({
  id: "inspection-example",
  states: States.states,
  events: [Start, Disconnect, Refresh],
  initial: () => initial
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
              Start: {
                targets: ["application.workflow.running"],
                transition: ({ target }) =>
                  target.local.running(new Running({}), (running) => running.editing(new Editing({})))
              },
              Refresh: {
                targets: [],
                transition: () => undefined
              }
            }
          },
          running: {
            initial: () => new Editing({})
          }
        }
      },
      connection: {
        states: {
          online: {
            on: {
              Disconnect: ({ target }) => target.local.offline(new Offline({}))
            }
          }
        }
      }
    }
  }
})

const renderMachine = makeTextRenderer<typeof machine, typeof initial>(Machine)

describe("Machine structural visualization", () => {
  it("exposes every state node in definition order", () => {
    assert.deepStrictEqual(Machine.stateNodes(machine).map(({ path, type }) => ({ path, type })), [
      { path: "application", type: "parallel" },
      { path: "application.workflow", type: "compound" },
      { path: "application.workflow.idle", type: "atomic" },
      { path: "application.workflow.running", type: "compound" },
      { path: "application.workflow.running.editing", type: "atomic" },
      { path: "application.workflow.running.complete", type: "final" },
      { path: "application.workflow.recent", type: "history" },
      { path: "application.connection", type: "compound" },
      { path: "application.connection.online", type: "atomic" },
      { path: "application.connection.offline", type: "atomic" },
      { path: "disabled", type: "atomic" }
    ])
  })

  it("exposes active ancestors and parallel regions in definition order", () => {
    assert.deepStrictEqual(Machine.configuration(machine, initial).map((node) => node.path), [
      "application",
      "application.workflow",
      "application.workflow.idle",
      "application.connection",
      "application.connection.online"
    ])
  })

  it("exposes registered transition handlers without executing them", () => {
    assert.deepStrictEqual(Machine.transitionDefinitions(machine), [
      {
        source: "application.workflow.idle",
        trigger: { type: "event", event: "Start" },
        reenter: false,
        targets: { type: "declared", paths: ["application.workflow.running"] }
      },
      {
        source: "application.workflow.idle",
        trigger: { type: "event", event: "Refresh" },
        reenter: false,
        targets: { type: "declared", paths: [] }
      },
      {
        source: "application.connection.online",
        trigger: { type: "event", event: "Disconnect" },
        reenter: false,
        targets: { type: "dynamic" }
      }
    ])
  })

  it("describes reentry, eventless, and completion handlers", () => {
    const metadataMachine = Machine.make({
      states: { idle: Idle },
      events: [Refresh],
      initial: () => ({ path: "idle", value: new Idle({}) })
    }).handle({
      idle: {
        on: {
          Refresh: {
            reenter: true,
            transition: () => undefined
          }
        },
        always: () => undefined,
        onDone: () => undefined
      }
    })

    assert.deepStrictEqual(Machine.transitionDefinitions(metadataMachine), [
      {
        source: "idle",
        trigger: { type: "event", event: "Refresh" },
        reenter: true,
        targets: { type: "dynamic" }
      },
      {
        source: "idle",
        trigger: { type: "always" },
        reenter: false,
        targets: { type: "dynamic" }
      },
      {
        source: "idle",
        trigger: { type: "done" },
        reenter: false,
        targets: { type: "dynamic" }
      }
    ])
  })

  it("renders the structure and active configuration as text", () => {
    assert.strictEqual(
      renderMachine(machine, initial),
      [
        "inspection-example",
        "● active  ○ inactive  ◇ transition (→ declared, ∅ none, omitted dynamic)",
        "",
        "├─ ● application [parallel]",
        "│  ├─ ● workflow [compound, initial: idle]",
        "│  │  ├─ ● idle",
        "│  │  │  └─ ◇ on: Start → running, Refresh → ∅",
        "│  │  ├─ ○ running [compound, initial: editing]",
        "│  │  │  ├─ ○ editing",
        "│  │  │  └─ ○ complete [final]",
        "│  │  └─ ○ recent [history, shallow]",
        "│  └─ ● connection [compound, initial: online]",
        "│     ├─ ● online",
        "│     │  └─ ◇ on: Disconnect",
        "│     └─ ○ offline",
        "└─ ○ disabled",
        "",
        "Candidate events: Start, Refresh, Disconnect"
      ].join("\n")
    )
  })

  it.effect("accepts a concrete leaf beneath a declared compound target", () =>
    Effect.gen(function*() {
      const planned = yield* Machine.plan(machine, initial, new Start({}))

      assert.deepStrictEqual(Machine.configuration(machine, planned.next).map((node) => node.path), [
        "application",
        "application.workflow",
        "application.workflow.running",
        "application.workflow.running.editing",
        "application.connection",
        "application.connection.online"
      ])
    }))

  it.effect("rejects a runtime target outside its declaration", () =>
    Effect.gen(function*() {
      const unsafe = machine.handle({
        application: {
          states: {
            workflow: {
              states: {
                idle: {
                  on: {
                    Start: {
                      targets: ["application.workflow.idle"],
                      transition: ({ target }) =>
                        target.full.disabled(new Disabled({})) as unknown as Machine.Machine.Target<
                          typeof States.states,
                          "application.workflow.idle"
                        >
                    }
                  }
                }
              }
            }
          }
        }
      })
      const exit = yield* Effect.exit(Machine.plan(unsafe, initial, new Start({})))

      assert.strictEqual(exit._tag, "Failure")
      if (exit._tag === "Failure") {
        assert(Cause.hasDies(exit.cause))
        assert.include(Cause.pretty(exit.cause), "returned target \"disabled\" outside declared targets")
      }
    }))

  it("rejects a declared path that is not a machine state", () => {
    assert.throws(
      () =>
        machine.handle({
          application: {
            states: {
              workflow: {
                states: {
                  idle: {
                    on: {
                      Start: {
                        targets: ["missing"] as any,
                        transition: () => undefined
                      }
                    }
                  }
                }
              }
            }
          }
        }),
      /declares unknown target "missing"/
    )
  })
})
