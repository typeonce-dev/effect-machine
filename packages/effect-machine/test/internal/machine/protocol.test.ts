import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import { decodeEvent } from "../../../src/internal/machine/protocol.js"

class ProtocolIdle extends Schema.TaggedClass<ProtocolIdle>("ProtocolIdle")("ProtocolIdle", {}) {}

const PublicEvent = Schema.TaggedStruct("PublicEvent", { value: Schema.String })
const InternalEvent = Schema.TaggedStruct("InternalEvent", { value: Schema.String })

describe("machine protocols", () => {
  it("rejects forged, misclassified, and overlapping event descriptors", () => {
    const states = Machine.state({ initial: "ProtocolIdle", states: { ProtocolIdle } })

    assert.throws(
      () => Machine.make({ root: states, events: [PublicEvent] as any }),
      /expected an event protocol/
    )
    assert.throws(
      () => Machine.make({ root: states, events: Machine.internalEventsFromSchemas(PublicEvent) as any }),
      /expected a public event protocol/
    )
    assert.throws(
      () =>
        Machine.make({
          root: states,
          events: Machine.eventsFromSchemas(PublicEvent),
          internalEvents: Machine.internalEventsFromSchemas(PublicEvent) as any
        }),
      /must be disjoint/
    )
  })

  it.effect("keeps the complete event protocol private across handler clones", () =>
    Effect.gen(function*() {
      const states = Machine.state({ initial: "ProtocolIdle", states: { ProtocolIdle } })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(PublicEvent),
        internalEvents: Machine.internalEventsFromSchemas(InternalEvent),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.ProtocolIdle.decoded(new ProtocolIdle({}))))
      }).handle({ states: {} })

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
