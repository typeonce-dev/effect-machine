import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../src/index.js"
import { decodeEvent } from "../src/internal/machineModel.js"

class ProtocolIdle extends Schema.TaggedClass<ProtocolIdle>("ProtocolIdle")("ProtocolIdle", {}) {}

class ProtocolDone extends Schema.TaggedClass<ProtocolDone>("ProtocolDone")("ProtocolDone", {}) {}

const PublicEvent = Schema.TaggedStruct("PublicEvent", { value: Schema.String })
const InternalEvent = Schema.TaggedStruct("InternalEvent", { value: Schema.String })

describe("machine protocols", () => {
  it.effect("keeps the complete event protocol private across handler clones", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({ ProtocolIdle })
      const machine = Machine.make({
        states: states.states,
        events: [PublicEvent],
        internalEvents: [InternalEvent],
        initial: () => states.initial.ProtocolIdle(new ProtocolIdle({}))
      }).handle({})

      assert.strictEqual(Object.hasOwn(machine, "eventSchemas"), false)
      assert.deepStrictEqual(
        yield* decodeEvent<readonly [typeof PublicEvent, typeof InternalEvent]>(
          machine,
          { _tag: "PublicEvent", value: "public" }
        ),
        { _tag: "PublicEvent", value: "public" }
      )
      assert.deepStrictEqual(
        yield* decodeEvent<readonly [typeof PublicEvent, typeof InternalEvent]>(
          machine,
          { _tag: "InternalEvent", value: "internal" }
        ),
        { _tag: "InternalEvent", value: "internal" }
      )
    }))

  it.effect("validates a raised event once before processing it", () =>
    Effect.gen(function*() {
      let raisedEventValidations = 0
      const Trigger = Schema.TaggedStruct("Trigger", {})
      const Raised = Schema.TaggedStruct("Raised", {
        value: Schema.Number.check(
          Schema.makeFilter(() => {
            raisedEventValidations += 1
            return undefined
          })
        )
      })
      const states = Machine.defineStates({ ProtocolIdle, ProtocolDone })
      const machine = Machine.make({
        states: states.states,
        events: [Trigger, Raised],
        initial: () => states.initial.ProtocolIdle(new ProtocolIdle({}))
      }).handle({
        ProtocolIdle: {
          on: {
            Trigger: Effect.fn(function*({ runtime }) {
              const machine = yield* runtime
              yield* machine.raise({ _tag: "Raised", value: 1 })
            }),
            Raised: () => states.initial.ProtocolDone(new ProtocolDone({}))
          }
        }
      })

      const planned = yield* Machine.plan(
        machine,
        states.initial.ProtocolIdle(new ProtocolIdle({})),
        { _tag: "Trigger" }
      )

      assert.strictEqual(raisedEventValidations, 1)
      assert.deepStrictEqual(planned.next, states.initial.ProtocolDone(new ProtocolDone({})))
    }))
})
