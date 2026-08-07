import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../src/index.js"

class Workspace extends Schema.TaggedClass<Workspace>("WhenWorkspace")("WhenWorkspace", {}) {}
class Editing extends Schema.TaggedClass<Editing>("WhenEditing")("WhenEditing", {
  dirty: Schema.Boolean
}) {}
class ConfirmClose extends Schema.TaggedClass<ConfirmClose>("WhenConfirmClose")("WhenConfirmClose", {}) {}
class Closed extends Schema.TaggedClass<Closed>("WhenClosed")("WhenClosed", {}) {}
class Close extends Schema.TaggedClass<Close>("WhenClose")("Close", {}) {}
class BlockClose extends Schema.TaggedClass<BlockClose>("WhenBlockClose")("BlockClose", {}) {}

const States = Machine.defineStates({
  Workspace: {
    schema: Workspace,
    initial: "Editing",
    states: {
      Editing,
      ConfirmClose
    }
  },
  Closed
})

const snapshot = (dirty: boolean) =>
  States.initial.Workspace(
    new Workspace({}),
    (workspace) => workspace.Editing(new Editing({ dirty }))
  )

const machine = Machine.make({
  states: States.states,
  events: [Close, BlockClose],
  initial: () => snapshot(false)
}).handle({
  Workspace: {
    on: {
      Close: ({ target }) => target.full.Closed(new Closed({})),
      BlockClose: ({ target }) => target.full.Closed(new Closed({}))
    },
    states: {
      Editing: {
        on: {
          Close: {
            when: ({ state }) => state.dirty,
            targets: ["Workspace.ConfirmClose"],
            transition: ({ target }) => target.local.ConfirmClose(new ConfirmClose({}))
          },
          BlockClose: {
            when: ({ state }) => state.dirty,
            targets: [],
            transition: () => undefined
          }
        }
      }
    }
  }
})

describe("Machine transition conditions", () => {
  it.effect.prop(
    "selects the child when true and otherwise continues at its ancestor",
    { dirty: FastCheck.boolean() },
    ({ dirty }) =>
      Effect.gen(function*() {
        const planned = yield* Machine.plan(machine, snapshot(dirty), new Close({}))
        assert.strictEqual(planned.microsteps[0]?.transitions[0]?.source, dirty ? "Workspace.Editing" : "Workspace")
        assert.strictEqual(
          planned.next.path === "Closed" ? "Closed" : planned.next.state.path,
          dirty ? "Workspace.ConfirmClose" : "Closed"
        )
      }),
    { fastCheck: { numRuns: 100, seed: 84_031 } }
  )

  it.effect("keeps a selected targetless child transition distinct from a rejected condition", () =>
    Effect.gen(function*() {
      const consumed = yield* Machine.plan(machine, snapshot(true), new BlockClose({}))
      assert.strictEqual(consumed.next.path, "Workspace")
      if (consumed.next.path === "Workspace") {
        assert.strictEqual(consumed.next.state.path, "Workspace.Editing")
      }
      assert.deepStrictEqual(consumed.microsteps[0]?.transitions, [{
        source: "Workspace.Editing",
        trigger: { type: "event", event: "BlockClose" },
        reenter: false,
        target: undefined,
        resolvedTarget: undefined
      }])

      const delegated = yield* Machine.plan(machine, snapshot(false), new BlockClose({}))
      assert.strictEqual(delegated.next.path, "Closed")
      assert.strictEqual(delegated.microsteps[0]?.transitions[0]?.source, "Workspace")
    }))

  it.effect("evaluates an Effect condition and preserves its service requirement", () => {
    class MayIntercept extends Context.Service<MayIntercept, boolean>()("test/MachineWhen/MayIntercept") {}
    const effectful = Machine.make({
      states: States.states,
      events: [Close],
      initial: () => snapshot(true)
    }).handle({
      Workspace: {
        on: {
          Close: ({ target }) => target.full.Closed(new Closed({}))
        },
        states: {
          Editing: {
            on: {
              Close: {
                when: () =>
                  Effect.gen(function*() {
                    return yield* MayIntercept
                  }),
                transition: ({ target }) => target.local.ConfirmClose(new ConfirmClose({}))
              }
            }
          }
        }
      }
    })

    return Effect.gen(function*() {
      const intercepted = yield* Machine.plan(effectful, snapshot(true), new Close({})).pipe(
        Effect.provideService(MayIntercept, true)
      )
      assert.strictEqual(intercepted.next.path, "Workspace")
      if (intercepted.next.path === "Workspace") {
        assert.strictEqual(intercepted.next.state.path, "Workspace.ConfirmClose")
      }

      const delegated = yield* Machine.plan(effectful, snapshot(true), new Close({})).pipe(
        Effect.provideService(MayIntercept, false)
      )
      assert.strictEqual(delegated.next.path, "Closed")
    })
  })

  it("reports conditional transitions without evaluating them", () => {
    assert.deepStrictEqual(
      Machine.transitionDefinitions(machine).filter(({ conditional }) => conditional === true),
      [
        {
          source: "Workspace.Editing",
          trigger: { type: "event", event: "Close" },
          reenter: false,
          conditional: true,
          targets: { type: "declared", paths: ["Workspace.ConfirmClose"] }
        },
        {
          source: "Workspace.Editing",
          trigger: { type: "event", event: "BlockClose" },
          reenter: false,
          conditional: true,
          targets: { type: "declared", paths: [] }
        }
      ]
    )
  })

  it("rejects malformed conditions at the handler boundary", () => {
    assert.throws(
      () =>
        Machine.make({
          states: States.states,
          events: [Close],
          initial: () => snapshot(false)
        }).handle({
          Workspace: {
            states: {
              Editing: {
                on: {
                  Close: {
                    when: "not-a-function",
                    transition: () => undefined
                  }
                }
              }
            }
          }
        } as any),
      /expected transition condition.*to be a function/
    )
  })
})
