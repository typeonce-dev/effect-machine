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

const initial = {
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
> => initial

const machineDefinition = Machine.make({
  id: "inspection-example",
  states: States.states,
  events: Machine.events(Start, Disconnect, Refresh),
  initial: { target: (to) => to.application.initial(), resolve: () => initial }
})

const makeMachine = (unsafeStart = false) =>
  machineDefinition.handle({
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
                Start: unsafeStart ?
                  (to) =>
                    to.full.disabled().resolve(({ target }) =>
                      ({ ...target(new Disabled({})), path: "application.workflow.idle" }) as any
                    ) :
                  (to) =>
                    to.local.running().resolve(({ target }) =>
                      target(new Running({}), (running) => running.editing(new Editing({})))
                    ),
                Refresh: { target: Machine.targetless }
              }
            },
            running: {
              initialize: ({ builder }) => builder(new Editing({}))
            }
          }
        },
        connection: {
          states: {
            online: {
              on: {
                Disconnect: (to) => to.local.offline().resolve(({ target }) => target(new Offline({})))
              }
            }
          }
        }
      }
    }
  })

const machine = makeMachine()

const renderMachine = makeTextRenderer<typeof machine, typeof initial>(Machine)
const renderMermaidMachine = makeMermaidRenderer<typeof machine, typeof initial>(Machine)

const LifecycleStates = Machine.states({
  idle: Idle,
  workflow: {
    schema: Workflow,
    initial: "complete",
    states: {
      complete: {
        schema: Complete,
        type: "final"
      }
    }
  },
  disabled: Disabled
})

const lifecycleDefinition = Machine.make({
  id: "lifecycle-inspection",
  states: LifecycleStates.states,
  events: Machine.events(),
  initial: {
    target: (to) => to.idle(),
    resolve: ({ target }) => target(new Idle({}))
  }
})

const makeLifecycleMachine = (unsafe: "always" | "done" | undefined = undefined) =>
  lifecycleDefinition.handle({
    idle: {
      always: (to) =>
        to.full.workflow().resolve(({ target }) => {
          const selected = target(new Workflow({}), (workflow) => workflow.complete(new Complete({})))
          return unsafe === "always" ? ({ ...selected, path: "idle" } as any) : selected
        })
    },
    workflow: {
      onDone: (to) =>
        to.full.disabled().resolve(({ target }) => {
          const selected = target(new Disabled({}))
          return unsafe === "done" ? ({ ...selected, path: "workflow" } as any) : selected
        })
    }
  })

const lifecycleMachine = makeLifecycleMachine()

const renderLifecycleMachine = makeTextRenderer<
  typeof lifecycleMachine,
  Machine.Machine.Snapshot<typeof LifecycleStates.states>
>(Machine)

describe("Machine structural visualization", () => {
  it("exposes the static root initial selection without executing the resolver", () => {
    const inspectOnly = Machine.make({
      states: States.states,
      events: Machine.events(),
      input: Schema.String,
      initial: {
        target: (to) => to.application.initial(),
        resolve: () => {
          throw new Error("initial resolver unexpectedly executed during inspection")
        }
      }
    })

    assert.deepStrictEqual(Machine.initialDefinition(inspectOnly), {
      target: "application",
      selection: { path: "application", kind: "initial", scope: "initial" }
    })
  })

  it("exposes every state node in definition order", () => {
    assert.deepStrictEqual(Machine.stateNodes(machine).map(({ path, type }) => ({ path, type })), [
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
          type: "direct",
          target: "application.workflow.running",
          selection: { path: "application.workflow.running", kind: "state", scope: "local" }
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
          selection: { path: undefined, kind: "none", scope: "local" }
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
          selection: { path: "application.connection.offline", kind: "state", scope: "local" }
        }]
      }
    ])
  })

  it("describes reentry, eventless, and completion handlers", () => {
    const metadataMachine = Machine.make({
      states: { idle: Idle },
      events: Machine.events(Refresh),
      initial: {
        target: (to) => to.idle(),
        resolve: () => ({ path: "idle" as const, value: new Idle({}) })
      }
    }).handle({
      idle: {
        on: {
          Refresh: (to) => to.none().resolve(() => undefined, { reenter: true })
        },
        always: { target: Machine.targetless },
        onDone: { target: Machine.targetless }
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
          selection: { path: undefined, kind: "none", scope: "local" }
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
          selection: { path: undefined, kind: "none", scope: "local" }
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
          selection: { path: undefined, kind: "none", scope: "local" }
        }]
      }
    ])
  })

  it.effect("plans declared eventless and completion transitions", () =>
    Effect.gen(function*() {
      const planned = yield* Machine.planInitial(lifecycleMachine)

      assert.deepStrictEqual(Machine.configuration(lifecycleMachine, planned.state).map(({ path }) => path), [
        "disabled"
      ])
      assert.deepStrictEqual(Machine.transitionDefinitions(lifecycleMachine), [
        {
          source: "idle",
          trigger: { type: "always" },
          reenter: false,
          acceptance: "required",
          branches: [{
            type: "direct",
            target: "workflow",
            selection: { path: "workflow", kind: "state", scope: "full" }
          }]
        },
        {
          source: "workflow",
          trigger: { type: "done" },
          reenter: false,
          acceptance: "required",
          branches: [{
            type: "direct",
            target: "disabled",
            selection: { path: "disabled", kind: "state", scope: "full" }
          }]
        }
      ])
      assert.strictEqual(
        renderLifecycleMachine(lifecycleMachine, planned.state),
        [
          "lifecycle-inspection",
          "● active  ○ inactive  ◇ transition  ┄ branch → target",
          "",
          "├─ ○ idle",
          "│  └─ ◇ always",
          "│     └┄ → workflow",
          "├─ ○ workflow [compound, initial: complete]",
          "│  ├─ ◇ done",
          "│  │  └┄ → disabled",
          "│  └─ ○ complete [final]",
          "└─ ● disabled",
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
        "├─ ● application [parallel]",
        "│  ├─ ● workflow [compound, initial: idle]",
        "│  │  ├─ ● idle",
        "│  │  │  └─ ◇ on: Start",
        "│  │  │     └┄ → running",
        "│  │  ├─ ○ running [compound, initial: editing]",
        "│  │  │  ├─ ○ editing",
        "│  │  │  └─ ○ complete [final]",
        "│  │  └─ ○ recent [history, shallow]",
        "│  └─ ● connection [compound, initial: online]",
        "│     ├─ ● online",
        "│     │  └─ ◇ on: Disconnect",
        "│     │     └┄ → offline",
        "│     └─ ○ offline",
        "└─ ○ disabled",
        "",
        "Candidate events: Start, Refresh, Disconnect"
      ].join("\n")
    )
  })

  it("renders the full structure and concrete transitions as Mermaid", () => {
    const rendered = renderMermaidMachine(machine, initial)

    assert.isTrue(rendered.startsWith("stateDiagram-v2\n  direction LR"))
    assert.include(rendered, "state \"● application [parallel]\" as state_0")
    assert.include(rendered, "state \"● workflow\" as state_1")
    assert.include(rendered, "[*] --> state_2")
    assert.include(rendered, "state_5 --> [*]")
    assert.include(rendered, "state \"○ recent [history: shallow]\" as state_6")
    assert.include(rendered, "[*] --> state_0")
    assert.include(rendered, "state_2 --> state_3: Start")
    assert.include(rendered, "state_8 --> state_9: Disconnect")
    assert.notMatch(rendered, /state_\d+ --> state_\d+: Refresh/)
    assert.notInclude(rendered, "Candidate events")
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
