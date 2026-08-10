import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import { decodeEvent } from "../../../src/internal/machine/protocol.js"

class ProtocolIdle extends Schema.TaggedClass<ProtocolIdle>("ProtocolIdle")("ProtocolIdle", {}) {}

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
})
