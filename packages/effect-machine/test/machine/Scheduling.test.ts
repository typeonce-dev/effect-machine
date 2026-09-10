import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
class SchedulingActive
  extends Schema.TaggedClass<SchedulingActive>("SchedulingActive")("SchedulingActive", { count: Schema.Number })
{
}
class StartBurst extends Schema.TaggedClass<StartBurst>("StartBurst")("StartBurst", {}) {}
class Burst extends Schema.TaggedClass<Burst>("Burst")("Burst", {}) {}
const burstSize = 512
describe("machine scheduling", () => {
  it.effect("drains a large synchronous raised-event burst without growing the stack", () =>
    Effect.gen(function*() {
      const states = Machine.state({ states: { SchedulingActive } })
      const targets1 = Machine.targets(states)
      const machine = Machine.make({
        branches: {
          transition1: { destination: { target: targets1.root.SchedulingActive } },
          transition2: { destination: { target: targets1.root.SchedulingActive } }
        },
        root: states,
        events: Machine.eventsFromSchemas(StartBurst),
        internalEvents: Machine.internalEventsFromSchemas(Burst)
      }).handle({
        initial: {
          target: Machine.targets(states).root.SchedulingActive,
          decoded: true,
          data: new SchedulingActive({ count: 0 })
        },
        states: {
          SchedulingActive: {
            on: {
              StartBurst: {
                branches: "transition1",
                resolve: ({ state, select: { destination: target } }, enqueue) => {
                  enqueue.raise(new Burst({}))
                  return target({ data: state, decoded: true })
                }
              },
              Burst: {
                branches: "transition2",
                resolve: ({ state, select: { destination: target } }, enqueue) => {
                  const count = state.count + 1
                  if (count < burstSize) {
                    enqueue.raise(new Burst({}))
                  }
                  return target({ data: new SchedulingActive({ count }), decoded: true })
                }
              }
            }
          }
        }
      })
      const actor = yield* Machine.start(machine)
      yield* actor.send(new StartBurst({}))
      yield* Effect.yieldNow
      assert.strictEqual((yield* actor.state).state.value.count, burstSize)
    }))
})
