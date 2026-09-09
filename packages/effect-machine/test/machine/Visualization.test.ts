import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { makeMermaidRenderer } from "./visualization/mermaid.js"
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
class InternalRefresh extends Schema.TaggedClass<InternalRefresh>("InternalRefresh")("InternalRefresh", {}) {}
const States = Machine.state({
  states: {
    application: {
      schema: Application,
      type: "parallel",
      states: {
        workflow: {
          schema: Workflow,
          states: {
            idle: Idle,
            running: {
              schema: Running,
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
const initial = {
  path: "" as const,
  value: undefined,
  state: {
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
}
const initialWorkflow = (): Machine.Machine.CompleteSnapshotContaining<{
  readonly "": typeof States.node
}, "application.workflow"> => initial
const targets1 = Machine.targets(States)
const machineDefinition = Machine.make({
  branches: {
    start: {
      running: { target: targets1.root.application.workflow.running, update: targets1.root.application.workflow }
    },
    unsafe: { disabled: { target: targets1.root.disabled } },
    transition1: { destination: { update: targets1.root.application.workflow } },
    transition2: { destination: { target: targets1.root.application.connection.offline } }
  },
  id: "inspection-example",
  root: States,
  events: Machine.eventsFromSchemas(Start, Disconnect, Refresh),
  internalEvents: Machine.internalEventsFromSchemas(InternalRefresh)
})
const makeMachine = (unsafeStart = false) =>
  machineDefinition.handle({
    initial: {
      target: Machine.targets(States).root.application,
      decoded: true,
      data: new Application({})
    },
    states: {
      application: {
        initial: {
          workflow: { decoded: true, data: new Workflow({}) },
          connection: { decoded: true, data: new Connection({}) }
        },
        states: {
          workflow: {
            initial: {
              target: Machine.targets(States).root.application.workflow.idle,
              decoded: true,
              data: new Idle({})
            },
            history: {
              recent: {
                default: initialWorkflow
              }
            },
            states: {
              idle: {
                on: {
                  Start: unsafeStart ?
                    {
                      branches: "unsafe",
                      resolve: ({ select }) =>
                        ({
                          ...select.disabled.decoded(new Disabled({})),
                          result: { path: "application.workflow.idle", value: new Disabled({}) }
                        }) as any
                    } :
                    {
                      branches: "start",
                      resolve: ({ select }) =>
                        select.running.decoded(new Running({}), (running) => running.editing.decoded(new Editing({})))
                          .update.decoded(new Workflow({}))
                    },
                  Refresh: { update: targets1.root.application.workflow, decoded: true, data: () => (new Workflow({})) }
                }
              },
              running: {
                initial: {
                  target: Machine.targets(States).root.application.workflow.running.editing,
                  decoded: true,
                  data: ({}) => new Editing({})
                },
                states: {
                  editing: {},
                  complete: {}
                }
              }
            }
          },
          connection: {
            initial: {
              target: Machine.targets(States).root.application.connection.online,
              decoded: true,
              data: new Online({})
            },
            states: {
              online: {
                on: {
                  Disconnect: {
                    target: targets1.root.application.connection.offline,
                    decoded: true,
                    data: () => (new Offline({}))
                  }
                }
              },
              offline: {}
            }
          }
        }
      },
      disabled: {}
    }
  })
const machine = makeMachine()
const renderMachine = makeTextRenderer<typeof machine, typeof initial>(Machine)
const renderMermaidMachine = makeMermaidRenderer<typeof machine, typeof initial>(Machine)
const LifecycleStates = Machine.state({
  states: {
    idle: Idle,
    workflow: {
      schema: Workflow,
      states: {
        complete: {
          schema: Complete,
          type: "final"
        }
      }
    },
    disabled: Disabled
  }
})
const targets2 = Machine.targets(LifecycleStates)
const lifecycleDefinition = Machine.make({
  branches: {
    transition1: { destination: { target: targets2.root.workflow } },
    transition2: { destination: { target: targets2.root.disabled } }
  },
  id: "lifecycle-inspection",
  root: LifecycleStates,
  events: Machine.eventsFromSchemas()
})
const makeLifecycleMachine = (unsafe: "always" | "done" | undefined = undefined) =>
  lifecycleDefinition.handle({
    initial: {
      target: Machine.targets(LifecycleStates).root.idle,
      decoded: true,
      data: new Idle({})
    },
    states: {
      idle: {
        always: {
          branches: "transition1",
          resolve: ({ select: { destination: target } }) => {
            const selected = target.decoded(new Workflow({}), (workflow) => workflow.complete.decoded(new Complete({})))
            return unsafe === "always"
              ? ({ ...selected, result: { path: "idle", value: new Running({}) } } as unknown as typeof selected)
              : selected
          }
        }
      },
      workflow: {
        initial: {
          target: Machine.targets(LifecycleStates).root.workflow.complete
        },
        onDone: {
          branches: "transition2",
          resolve: ({ select: { destination: target } }) => {
            const selected = target.decoded(new Disabled({}))
            return unsafe === "done"
              ? ({ ...selected, result: { path: "workflow", value: new Disabled({}) } } as unknown as typeof selected)
              : selected
          }
        },
        states: {
          complete: {}
        }
      },
      disabled: {}
    }
  })
const lifecycleMachine = makeLifecycleMachine()
const renderLifecycleMachine = makeTextRenderer<typeof lifecycleMachine, Machine.Snapshot<typeof LifecycleStates>>(
  Machine
)
describe("Machine structural visualization", () => {
  it("exposes only the public input event schemas", () => {
    assert.deepStrictEqual(Machine.inputEventSchemas(machine), [Start, Disconnect, Refresh])
  })
  it("exposes the static root initial selection without executing the resolver", () => {
    const root = Machine.state({ states: { Idle: { fields: { count: Schema.Number } } } })
    const inspectOnly = Machine.make({ root, events: Machine.eventsFromSchemas() }).handle({
      initial: {
        target: Machine.targets(root).root.Idle,
        data: () => {
          throw new Error("initial constructor unexpectedly executed during inspection")
        }
      }
    })
    assert.deepStrictEqual(Machine.initialDefinition(inspectOnly), {
      target: "",
      selection: { path: "", kind: "initial", scope: "initial" }
    })
  })
  it("exposes every state node in definition order", () => {
    assert.deepStrictEqual(Machine.stateNodes(machine).map(({ path, type }) => ({ path, type })), [
      { path: "" as const, type: "compound" },
      { path: "application" as const, type: "parallel" },
      { path: "application.workflow" as const, type: "compound" },
      { path: "application.workflow.idle" as const, type: "atomic" },
      { path: "application.workflow.running" as const, type: "compound" },
      { path: "application.workflow.running.editing" as const, type: "atomic" },
      { path: "application.workflow.running.complete" as const, type: "final" },
      { path: "application.workflow.recent" as const, type: "history" },
      { path: "application.connection" as const, type: "compound" },
      { path: "application.connection.online" as const, type: "atomic" },
      { path: "application.connection.offline" as const, type: "atomic" },
      { path: "disabled" as const, type: "atomic" }
    ])
  })
  it("exposes active ancestors and parallel regions in definition order", () => {
    assert.deepStrictEqual(Machine.configuration(machine, initial).map((node) => node.path), [
      "",
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
        acceptance: "required",
        branches: [{
          type: "branch",
          key: "running",
          title: "running",
          target: "application.workflow.running",
          selection: { path: "application.workflow.running", kind: "state", scope: "branch" },
          updates: ["application.workflow"]
        }]
      },
      {
        source: "application.workflow.idle",
        trigger: { type: "event", event: "Refresh" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: undefined,
          selection: { path: "application.workflow", kind: "update", scope: "branch" },
          updates: ["application.workflow"]
        }]
      },
      {
        source: "application.connection.online",
        trigger: { type: "event", event: "Disconnect" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: "application.connection.offline",
          selection: { path: "application.connection.offline", kind: "state", scope: "branch" },
          updates: []
        }]
      }
    ])
  })
  it("describes reentry, eventless, and completion handlers", () => {
    const root3 = Machine.state({ states: { idle: Idle } })
    const metadataMachine = Machine.make({
      root: root3,
      events: Machine.eventsFromSchemas(Refresh)
    }).handle({
      initial: {
        target: Machine.targets(root3).root.idle,
        decoded: true,
        data: new Idle({})
      },
      states: {
        idle: {
          on: {
            Refresh: { none: true, reenter: true, resolve: () => undefined }
          },
          always: { none: true },
          onDone: { none: true }
        }
      }
    })
    assert.deepStrictEqual(Machine.transitionDefinitions(metadataMachine), [
      {
        source: "idle",
        trigger: { type: "event", event: "Refresh" },
        reenter: true,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: undefined,
          selection: { path: undefined, kind: "none", scope: "local" },
          updates: []
        }]
      },
      {
        source: "idle",
        trigger: { type: "always" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: undefined,
          selection: { path: undefined, kind: "none", scope: "local" },
          updates: []
        }]
      },
      {
        source: "idle",
        trigger: { type: "done" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: undefined,
          selection: { path: undefined, kind: "none", scope: "local" },
          updates: []
        }]
      }
    ])
  })
  it.effect("plans declared eventless and completion transitions", () =>
    Effect.gen(function*() {
      const planned = yield* Machine.planInitial(lifecycleMachine)
      assert.deepStrictEqual(Machine.configuration(lifecycleMachine, planned.state).map(({ path }) => path), [
        "",
        "disabled"
      ])
      assert.deepStrictEqual(Machine.transitionDefinitions(lifecycleMachine), [
        {
          source: "idle",
          trigger: { type: "always" },
          reenter: false,
          acceptance: "required",
          branches: [{
            type: "branch",
            key: "destination",
            title: "destination",
            target: "workflow",
            selection: { path: "workflow", kind: "state", scope: "branch" },
            updates: []
          }]
        },
        {
          source: "workflow",
          trigger: { type: "done" },
          reenter: false,
          acceptance: "required",
          branches: [{
            type: "branch",
            key: "destination",
            title: "destination",
            target: "disabled",
            selection: { path: "disabled", kind: "state", scope: "branch" },
            updates: []
          }]
        }
      ])
      assert.strictEqual(
        renderLifecycleMachine(lifecycleMachine, planned.state),
        [
          "lifecycle-inspection",
          "● active  ○ inactive  ◇ transition  ┄ branch → target",
          "",
          "└─ ● (root) [compound, initial: idle]",
          "   ├─ ○ idle",
          "   │  └─ ◇ always",
          "   │     └┄ [destination] → workflow",
          "   ├─ ○ workflow [compound, initial: complete]",
          "   │  ├─ ◇ done",
          "   │  │  └┄ [destination] → disabled",
          "   │  └─ ○ complete [final]",
          "   └─ ● disabled",
          "",
          "Candidate events: none"
        ].join("\n")
      )
    }))
  it("renders the structure and active configuration as text", () => {
    assert.strictEqual(
      renderMachine(machine, initial),
      [
        "inspection-example",
        "● active  ○ inactive  ◇ transition  ┄ branch → target",
        "",
        "└─ ● (root) [compound, initial: application]",
        "   ├─ ● application [parallel]",
        "   │  ├─ ● workflow [compound, initial: idle]",
        "   │  │  ├─ ● idle",
        "   │  │  │  ├─ ◇ on: Start",
        "   │  │  │  │  └┄ [running] → running / update application.workflow",
        "   │  │  │  └─ ◇ on: Refresh",
        "   │  │  │     └┄ update application.workflow",
        "   │  │  ├─ ○ running [compound, initial: editing]",
        "   │  │  │  ├─ ○ editing",
        "   │  │  │  └─ ○ complete [final]",
        "   │  │  └─ ○ recent [history, shallow]",
        "   │  └─ ● connection [compound, initial: online]",
        "   │     ├─ ● online",
        "   │     │  └─ ◇ on: Disconnect",
        "   │     │     └┄ → offline",
        "   │     └─ ○ offline",
        "   └─ ○ disabled",
        "",
        "Candidate events: Start, Refresh, Disconnect"
      ].join("\n")
    )
  })
  it("renders the full structure and concrete transitions as Mermaid", () => {
    const rendered = renderMermaidMachine(machine, initial)
    assert.isTrue(rendered.startsWith("stateDiagram-v2\n  direction LR"))
    assert.include(rendered, "state \"● application [parallel]\" as state_1")
    assert.include(rendered, "state \"● workflow\" as state_2")
    assert.include(rendered, "[*] --> state_3")
    assert.include(rendered, "state_6 --> [*]")
    assert.include(rendered, "state \"○ recent [history: shallow]\" as state_7")
    assert.include(rendered, "[*] --> state_1")
    assert.include(rendered, "state_3 --> state_4: Start [running] / update application.workflow")
    assert.include(rendered, "state_3: Refresh / update application.workflow")
    assert.include(rendered, "state_9 --> state_10: Disconnect")
    assert.notMatch(rendered, /state_\d+ --> state_\d+: Refresh/)
    assert.notInclude(rendered, "Candidate events")
  })
  it.effect("accepts a concrete leaf beneath a declared compound target", () =>
    Effect.gen(function*() {
      const planned = yield* Machine.plan(machine, initial, new Start({}))
      assert.deepStrictEqual(Machine.configuration(machine, planned.next).map((node) => node.path), [
        "",
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
      const unsafe = makeMachine(true)
      const exit = yield* Effect.exit(Machine.plan(unsafe, initial, new Start({})))
      assert.strictEqual(exit._tag, "Failure")
      if (exit._tag === "Failure") {
        assert(Cause.hasDies(exit.cause))
        assert.include(Cause.pretty(exit.cause), "selected \"disabled\" but constructed \"application.workflow.idle\"")
      }
    }))
  it.effect("rejects runtime targets outside always and onDone declarations", () =>
    Effect.gen(function*() {
      const unsafeAlways = makeLifecycleMachine("always")
      const alwaysExit = yield* Effect.exit(Machine.planInitial(unsafeAlways))
      assert.strictEqual(alwaysExit._tag, "Failure")
      if (alwaysExit._tag === "Failure") {
        assert.include(Cause.pretty(alwaysExit.cause), "selected \"workflow\" but constructed \"idle\"")
      }
      const unsafeDone = makeLifecycleMachine("done")
      const doneExit = yield* Effect.exit(Machine.planInitial(unsafeDone))
      assert.strictEqual(doneExit._tag, "Failure")
      if (doneExit._tag === "Failure") {
        assert.include(Cause.pretty(doneExit.cause), "selected \"disabled\" but constructed \"workflow\"")
      }
    }))
})
