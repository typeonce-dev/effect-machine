import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import { decodeEvent } from "../../../src/internal/machine/protocol.js"

class ProtocolIdle extends Schema.TaggedClass<ProtocolIdle>("ProtocolIdle")("ProtocolIdle", {}) {}

const PublicEvent = Schema.TaggedStruct("PublicEvent", { value: Schema.String })
const InternalEvent = Schema.TaggedStruct("InternalEvent", { value: Schema.String })

describe("machine protocols", () => {
  it("rejects forged, misclassified, and overlapping event descriptors", () => {
    const states = Machine.states({ ProtocolIdle })
    const initial = {
      target: (to: Machine.Machine.InitialSelector<typeof states.states>) => to.ProtocolIdle(),
      resolve: () => ({ path: "ProtocolIdle" as const, value: new ProtocolIdle({}) })
    }

    assert.throws(
      () => Machine.make({ states: states.states, events: [PublicEvent] as any, initial }),
      /expected an event protocol/
    )
    assert.throws(
      () => Machine.make({ states: states.states, events: Machine.internalEvents(PublicEvent) as any, initial }),
      /expected a public event protocol/
    )
    assert.throws(
      () =>
        Machine.make({
          states: states.states,
          events: Machine.events(PublicEvent),
          internalEvents: Machine.internalEvents(PublicEvent) as any,
          initial
        }),
      /must be disjoint/
    )
  })

  it.effect("keeps the complete event protocol private across handler clones", () =>
    Effect.gen(function*() {
      const states = Machine.states({ ProtocolIdle })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(PublicEvent),
        internalEvents: Machine.internalEvents(InternalEvent),
        initial: {
          target: (to) => to.ProtocolIdle(),
          resolve: ({ target }) => target(new ProtocolIdle({}))
        }
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
