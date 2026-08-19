import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"

class SchedulingActive extends Schema.TaggedClass<SchedulingActive>("SchedulingActive")(
  "SchedulingActive",
  { count: Schema.Number }
) {}

class StartBurst extends Schema.TaggedClass<StartBurst>("StartBurst")("StartBurst", {}) {}

class Burst extends Schema.TaggedClass<Burst>("Burst")("Burst", {}) {}

const burstSize = 512

describe("machine scheduling", () => {
  it.effect("drains a large synchronous raised-event burst without growing the stack", () =>
    Effect.gen(function*() {
      const states = Machine.states({ SchedulingActive })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(StartBurst),
        internalEvents: Machine.internalEvents(Burst),
        initial: {
          target: (to) => to.SchedulingActive(),
          resolve: ({ target }) => target(new SchedulingActive({ count: 0 }))
        }
      }).handle({
        SchedulingActive: {
          on: {
            StartBurst: (to) =>
              to.full.SchedulingActive().resolve(({ state, target }, enqueue) => {
                enqueue.raise(new Burst({}))
                return target(state)
              }),
            Burst: (to) =>
              to.full.SchedulingActive().resolve(({ state, target }, enqueue) => {
                const count = state.count + 1
                if (count < burstSize) enqueue.raise(new Burst({}))
                return target(new SchedulingActive({ count }))
              })
          }
        }
      })
      const actor = yield* Machine.start(machine)

      yield* actor.send(new StartBurst({}))
      yield* Effect.yieldNow

      assert.strictEqual((yield* actor.state).value.count, burstSize)
    }))
})
