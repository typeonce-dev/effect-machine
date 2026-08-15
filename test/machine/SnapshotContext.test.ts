import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Machine } from "../../src/index.js"

class System extends Schema.TaggedClass<System>("System")("System", {}) {}
class Playback extends Schema.TaggedClass<Playback>("Playback")("Playback", {}) {}
class Buffering extends Schema.TaggedClass<Buffering>("Buffering")("Buffering", {}) {}
class Playing extends Schema.TaggedClass<Playing>("Playing")("Playing", {}) {}
class Network extends Schema.TaggedClass<Network>("Network")("Network", {}) {}
class Online extends Schema.TaggedClass<Online>("Online")("Online", {}) {}
class Offline extends Schema.TaggedClass<Offline>("Offline")("Offline", {}) {}
class BufferReady extends Schema.TaggedClass<BufferReady>("BufferReady")("BufferReady", {}) {}
class Disconnect extends Schema.TaggedClass<Disconnect>("Disconnect")("Disconnect", {}) {}

const States = Machine.defineStates({
  System: {
    schema: System,
    type: "parallel",
    states: {
      Playback: {
        schema: Playback,
        initial: "Buffering",
        states: { Buffering, Playing }
      },
      Network: {
        schema: Network,
        initial: "Online",
        states: { Online, Offline }
      }
    }
  }
})

const initial = () =>
  States.initial.System(
    new System({}),
    (system) =>
      system
        .Playback(new Playback({}), (playback) => playback.Buffering(new Buffering({})))
        .Network(new Network({}), (network) => network.Online(new Online({})))
  )

describe("Machine transition snapshot context", () => {
  it.effect("lets an effectful event handler inspect a sibling region", () =>
    Effect.gen(function*() {
      let captured: Machine.Machine.Snapshot<typeof States.states> | undefined
      const machine = Machine.make({
        states: States.states,
        events: Machine.events(BufferReady),
        initial
      }).handle({
        System: {
          states: {
            Playback: {
              states: {
                Buffering: {
                  on: {
                    BufferReady: ({ snapshot, target }) => {
                      captured = snapshot
                      return States.matches(snapshot, "System.Network.Online")
                        ? target.local.Playing(new Playing({}))
                        : target.none()
                    }
                  }
                }
              }
            }
          }
        }
      })

      const plan = yield* Machine.plan(machine, initial(), new BufferReady({}))

      assert.strictEqual(States.matches(plan.next, "System.Playback.Playing"), true)
      assert.strictEqual(States.matches(captured!, "System.Playback.Buffering"), true)
      assert.strictEqual(States.matches(captured!, "System.Network.Online"), true)
      assert.deepStrictEqual(
        States.get(captured!, "System.Network.Online"),
        Option.some(new Online({}))
      )
    }))

  it.effect("shares one beginning-of-microstep snapshot across parallel transitions", () =>
    Effect.gen(function*() {
      const captured: Array<Machine.Machine.Snapshot<typeof States.states>> = []
      const machine = Machine.make({
        states: States.states,
        events: Machine.events(Disconnect),
        initial
      }).handle({
        System: {
          states: {
            Playback: {
              states: {
                Buffering: {
                  on: {
                    Disconnect: ({ snapshot, target }) => {
                      captured.push(snapshot)
                      return target.local.Playing(new Playing({}))
                    }
                  }
                }
              }
            },
            Network: {
              states: {
                Online: {
                  on: {
                    Disconnect: ({ snapshot, target }) => {
                      captured.push(snapshot)
                      return target.local.Offline(new Offline({}))
                    }
                  }
                }
              }
            }
          }
        }
      })

      const plan = yield* Machine.plan(machine, initial(), new Disconnect({}))

      assert.lengthOf(plan.microsteps[0]!.transitions, 2)
      assert.lengthOf(captured, 2)
      assert.strictEqual(captured[0], captured[1])
      assert.strictEqual(States.matches(captured[0]!, "System.Playback.Buffering"), true)
      assert.strictEqual(States.matches(captured[0]!, "System.Network.Online"), true)
      assert.strictEqual(States.matches(plan.next, "System.Playback.Playing"), true)
      assert.strictEqual(States.matches(plan.next, "System.Network.Offline"), true)
    }))

  it.effect("captures the complete configuration for an eventless transition", () =>
    Effect.gen(function*() {
      let captured: Machine.Machine.Snapshot<typeof States.states> | undefined
      const machine = Machine.make({
        states: States.states,
        events: Machine.events(),
        initial
      }).handle({
        System: {
          states: {
            Playback: {
              states: {
                Buffering: {
                  always: ({ snapshot, target }) => {
                    captured = snapshot
                    return States.matches(snapshot, "System.Network.Online")
                      ? target.local.Playing(new Playing({}))
                      : target.none()
                  }
                }
              }
            }
          }
        }
      })

      const plan = yield* Machine.planInitial(machine)

      assert.strictEqual(States.matches(captured!, "System.Playback.Buffering"), true)
      assert.strictEqual(States.matches(captured!, "System.Network.Online"), true)
      assert.strictEqual(States.matches(plan.state, "System.Playback.Playing"), true)
    }))

  it.effect("captures completed state and sibling regions for onDone", () =>
    Effect.gen(function*() {
      class Work extends Schema.TaggedClass<Work>("Work")("Work", {}) {}
      class Finished extends Schema.TaggedClass<Finished>("Finished")("Finished", {}) {}
      class Restarted extends Schema.TaggedClass<Restarted>("Restarted")("Restarted", {}) {}
      class Monitor extends Schema.TaggedClass<Monitor>("Monitor")("Monitor", {}) {}
      class Active extends Schema.TaggedClass<Active>("Active")("Active", {}) {}
      const completionStates = Machine.defineStates({
        System: {
          schema: System,
          type: "parallel",
          states: {
            Work: {
              schema: Work,
              initial: "Finished",
              states: {
                Finished: { schema: Finished, type: "final" },
                Restarted
              }
            },
            Monitor: {
              schema: Monitor,
              initial: "Active",
              states: { Active }
            }
          }
        }
      })
      let captured: Machine.Machine.Snapshot<typeof completionStates.states> | undefined
      const machine = Machine.make({
        states: completionStates.states,
        events: Machine.events(),
        initial: () =>
          completionStates.initial.System(
            new System({}),
            (system) =>
              system
                .Work(new Work({}), (work) => work.Finished(new Finished({})))
                .Monitor(new Monitor({}), (monitor) => monitor.Active(new Active({})))
          )
      }).handle({
        System: {
          states: {
            Work: {
              onDone: ({ snapshot, target }) => {
                captured = snapshot
                return target.local.Restarted(new Restarted({}))
              }
            }
          }
        }
      })

      const plan = yield* Machine.planInitial(machine)

      assert.strictEqual(completionStates.matches(captured!, "System.Work.Finished"), true)
      assert.strictEqual(completionStates.matches(captured!, "System.Monitor.Active"), true)
      assert.deepStrictEqual(captured!.completed, [{ path: "System.Work.Finished", output: undefined }, {
        path: "System.Work",
        output: undefined
      }])
      assert.strictEqual(completionStates.matches(plan.state, "System.Work.Restarted"), true)
    }))
})
