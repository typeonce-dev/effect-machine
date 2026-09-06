import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema, SchemaGetter } from "effect"
import { Machine } from "../../src/index.js"

describe("protocol ownership", () => {
  it.effect("validates a constructed event again after it escapes a resolver", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedStruct("State", {})
      const Set = Schema.TaggedStruct("Set", { value: Schema.Int })
      const events = Machine.eventsFromSchemas(Set)
      let retained: unknown
      const machine = Machine.make({
        root: Machine.state({ initial: "State", states: { State } }),
        events,
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.State.decoded({ _tag: "State" })))
      }).handle({
        states: {
          State: {
            on: {
              Set: (to) =>
                to.none.resolve(({ event }) => {
                  retained = event
                })
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      yield* Machine.plan(machine, initial.state, events.Set({ value: 1 }))
      // An untyped caller can mutate decoded values retained by application code.
      Object.assign(retained as object, { value: "invalid" })
      const exit = yield* Effect.exit(Machine.plan(machine, initial.state, retained as Schema.Schema.Type<typeof Set>))
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasFails(exit.cause))
    }))

  it.effect("queries internal events without sending them", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedStruct("State", {})
      const Internal = Schema.TaggedStruct("Internal", {})
      const internalEvents = Machine.internalEventsFromSchemas(Internal)
      const machine = Machine.make({
        root: Machine.state({ initial: "State", states: { State } }),
        events: Machine.eventsFromSchemas(),
        internalEvents,
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.State.decoded({ _tag: "State" })))
      })
        .handle({ states: { State: { on: { Internal: (to) => to.none } } } })
      const initial = yield* Machine.planInitial(machine)
      assert.isTrue(yield* Machine.can(machine, initial.state, { _tag: "Internal" }))
      assert.isTrue(yield* Machine.can(machine)(initial.state, internalEvents.Internal()))
    }))

  for (const boundary of ["encode", "decode"] as const) {
    it.effect(`preserves ${boundary} codec interruption`, () =>
      Effect.gen(function*() {
        const Value = boundary === "encode"
          ? Schema.Number.pipe(
            Schema.encode({ decode: SchemaGetter.passthrough(), encode: SchemaGetter.onSome(() => Effect.interrupt) })
          )
          : Schema.Number.pipe(
            Schema.decode({ decode: SchemaGetter.onSome(() => Effect.interrupt), encode: SchemaGetter.passthrough() })
          )
        const State = Schema.TaggedStruct("State", { value: Value })
        const machine = Machine.make({
          root: Machine.state({ initial: "State", states: { State } }),
          events: Machine.eventsFromSchemas(),
          initialConfiguration: (root) =>
            root.resolve(({ target }) => target.from((to) => to.State.decoded({ _tag: "State", value: 1 })))
        })
        const initial = yield* Machine.planInitial(machine)
        const operation: Effect.Effect<unknown, Machine.MachineSchemaDecodeError | Machine.MachineSchemaEncodeError> =
          boundary === "encode" ?
            Machine.encodeSnapshot(machine, initial.state)
            : Machine.decodeSnapshot(machine, yield* Machine.encodeSnapshot(machine, initial.state))
        const exit = yield* Effect.exit(operation)
        assert.isTrue(Exit.isFailure(exit))
        if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause))
      }))
  }
})
