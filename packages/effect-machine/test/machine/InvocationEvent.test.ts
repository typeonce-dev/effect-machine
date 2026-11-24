import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { LocalMachine, Machine } from "../../src/index.js"

const describeEvent = (event: Machine.Machine.LifecycleEvent<any>): unknown =>
  Machine.isInitialEvent(event) ? "initial" : Machine.isInvocationEvent(event) ? { ...event } : event._tag

const makeMachine = (seen: Array<unknown>) =>
  Machine.make({
    root: Machine.state({
      states: {
        Loading: {},
        Loaded: { fields: { result: Schema.String } },
        Saving: {},
        Failed: {}
      }
    }),
    events: Machine.events({}),
    effects: {
      load: Effect.succeed("document"),
      save: (result: string) => Effect.fail({ reason: result })
    }
  }).handle({
    initial: { target: "Loading" },
    states: {
      Loading: {
        invoke: { src: "load", onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) } }
      },
      Loaded: {
        entry: ({ event }) => {
          seen.push(["entry Loaded", describeEvent(event)])
        },
        always: { target: "Saving" },
        exit: ({ event }) => {
          seen.push(["exit Loaded", describeEvent(event)])
        }
      },
      Saving: {
        invoke: {
          src: "save",
          input: ({ event }) => {
            seen.push(["input save", describeEvent(event)])
            return "nope"
          },
          onFailure: { target: "Failed" }
        }
      },
      Failed: {
        entry: ({ event }) => {
          seen.push(["entry Failed", describeEvent(event)])
        }
      }
    }
  })

describe("Machine.InvocationEvent", () => {
  it("identifies the lifecycle event of a step caused by invoked work", () => {
    assert.isFalse(Machine.isInvocationEvent(Machine.InitialEvent))
    assert.isFalse(Machine.isInvocationEvent({ _tag: "Done" }))
    assert.isFalse(Machine.isInitialEvent({ _tag: Machine.InvocationEventTypeId }))
    assert.isTrue(Machine.isInvocationEvent({ _tag: Machine.InvocationEventTypeId }))
  })

  it.effect("reaches entry, exit, and input callbacks with the invocation and what it reported", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      const ref = yield* LocalMachine.start(makeMachine(seen))
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      assert.strictEqual((yield* ref.snapshot).status, "active")
      const done = { _tag: Machine.InvocationEventTypeId, path: "Loading", id: "load", kind: "Done" }
      const failure = { _tag: Machine.InvocationEventTypeId, path: "Saving", id: "save", kind: "Failure" }
      assert.deepStrictEqual(seen, [
        ["entry Loaded", done],
        ["exit Loaded", done],
        ["input save", done],
        ["entry Failed", failure]
      ])
    }).pipe(Effect.scoped))

  it.effect("carries no generation handle or reported value", () =>
    Effect.gen(function*() {
      const events: Array<Machine.Machine.LifecycleEvent<any>> = []
      const machine = Machine.make({
        root: Machine.state({ states: { Loading: {}, Loaded: {} } }),
        events: Machine.events({}),
        effects: { load: Effect.succeed("document") }
      }).handle({
        initial: { target: "Loading" },
        states: {
          Loading: { invoke: { src: "load", onDone: { target: "Loaded" } } },
          Loaded: {
            entry: ({ event }) => {
              events.push(event)
            }
          }
        }
      })
      yield* LocalMachine.start(machine)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      assert.strictEqual(events.length, 1)
      const event = events[0]!
      assert.deepStrictEqual(Reflect.ownKeys(event), ["_tag", "path", "id", "kind"])
    }).pipe(Effect.scoped))
})
