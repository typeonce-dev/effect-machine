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
const States = Machine.state({
  states: {
    System: {
      schema: System,
      type: "parallel",
      states: {
        Playback: {
          schema: Playback,
          states: { Buffering, Playing }
        },
        Network: {
          schema: Network,
          states: { Online, Offline }
        }
      }
    }
  }
})
const initial = {
  path: "" as const,
  value: undefined,
  state: {
    path: "System" as const,
    value: new System({}),
    states: {
      Playback: {
        path: "System.Playback" as const,
        value: new Playback({}),
        state: { path: "System.Playback.Buffering" as const, value: new Buffering({}) }
      },
      Network: {
        path: "System.Network" as const,
        value: new Network({}),
        state: { path: "System.Network.Online" as const, value: new Online({}) }
      }
    }
  }
}
describe("Machine transition snapshot context", () => {
  it.effect("lets an effectful event handler inspect a sibling region", () =>
    Effect.gen(function*() {
      let captured: Machine.Snapshot<typeof States> | undefined
      const targets1 = Machine.targets(States)
      const machine = Machine.make({
        branches: {
          transition1: {
            online: { target: targets1.root.System.Playback.Playing, title: "Network is online" },
            unchanged: { none: true }
          }
        },
        root: States,
        events: Machine.eventsFromSchemas(BufferReady)
      }).handle({
        initial: {
          target: Machine.targets(States).root.System,
          decoded: true,
          data: new System({})
        },
        states: {
          System: {
            initial: {
              Playback: {
                decoded: true,
                data: new Playback({})
              },
              Network: {
                decoded: true,
                data: new Network({})
              }
            },
            states: {
              Playback: {
                initial: {
                  target: Machine.targets(States).root.System.Playback.Buffering,
                  decoded: true,
                  data: new Buffering({})
                },
                states: {
                  Buffering: {
                    on: {
                      BufferReady: {
                        branches: "transition1",
                        resolve: ({ snapshot, select }) => {
                          captured = snapshot
                          return States.matches(snapshot, "System.Network.Online")
                            ? select.online({ data: new Playing({}), decoded: true })
                            : select.unchanged()
                        }
                      }
                    }
                  },
                  Playing: {}
                }
              },
              Network: {
                initial: {
                  target: Machine.targets(States).root.System.Network.Online,
                  decoded: true,
                  data: new Online({})
                },
                states: {
                  Online: {},
                  Offline: {}
                }
              }
            }
          }
        }
      })
      const plan = yield* Machine.plan(machine, initial, new BufferReady({}))
      assert.strictEqual(States.matches(plan.next, "System.Playback.Playing"), true)
      assert.strictEqual(States.matches(captured!, "System.Playback.Buffering"), true)
      assert.strictEqual(States.matches(captured!, "System.Network.Online"), true)
      assert.deepStrictEqual(States.get(captured!, "System.Network.Online"), Option.some(new Online({})))
    }))
  it.effect("shares one beginning-of-microstep snapshot across parallel transitions", () =>
    Effect.gen(function*() {
      const captured: Array<Machine.Snapshot<typeof States>> = []
      const targets2 = Machine.targets(States)
      const machine = Machine.make({
        branches: {
          transition1: { destination: { target: targets2.root.System.Playback.Playing } },
          transition2: { destination: { target: targets2.root.System.Network.Offline } }
        },
        root: States,
        events: Machine.eventsFromSchemas(Disconnect)
      }).handle({
        initial: {
          target: Machine.targets(States).root.System,
          decoded: true,
          data: new System({})
        },
        states: {
          System: {
            initial: {
              Playback: {
                decoded: true,
                data: new Playback({})
              },
              Network: {
                decoded: true,
                data: new Network({})
              }
            },
            states: {
              Playback: {
                initial: {
                  target: Machine.targets(States).root.System.Playback.Buffering,
                  decoded: true,
                  data: new Buffering({})
                },
                states: {
                  Buffering: {
                    on: {
                      Disconnect: {
                        branches: "transition1",
                        resolve: ({ snapshot, select: { destination: target } }) => {
                          captured.push(snapshot)
                          return target({ data: new Playing({}), decoded: true })
                        }
                      }
                    }
                  },
                  Playing: {}
                }
              },
              Network: {
                initial: {
                  target: Machine.targets(States).root.System.Network.Online,
                  decoded: true,
                  data: new Online({})
                },
                states: {
                  Online: {
                    on: {
                      Disconnect: {
                        branches: "transition2",
                        resolve: ({ snapshot, select: { destination: target } }) => {
                          captured.push(snapshot)
                          return target({ data: new Offline({}), decoded: true })
                        }
                      }
                    }
                  },
                  Offline: {}
                }
              }
            }
          }
        }
      })
      const plan = yield* Machine.plan(machine, initial, new Disconnect({}))
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
      let captured: Machine.Snapshot<typeof States> | undefined
      const targets3 = Machine.targets(States)
      const machine = Machine.make({
        branches: {
          transition1: {
            online: { target: targets3.root.System.Playback.Playing, title: "Network is online" },
            unchanged: { none: true }
          }
        },
        root: States,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(States).root.System,
          decoded: true,
          data: new System({})
        },
        states: {
          System: {
            initial: {
              Playback: {
                decoded: true,
                data: new Playback({})
              },
              Network: {
                decoded: true,
                data: new Network({})
              }
            },
            states: {
              Playback: {
                initial: {
                  target: Machine.targets(States).root.System.Playback.Buffering,
                  decoded: true,
                  data: new Buffering({})
                },
                states: {
                  Buffering: {
                    always: {
                      branches: "transition1",
                      resolve: ({ snapshot, select }) => {
                        captured = snapshot
                        return States.matches(snapshot, "System.Network.Online")
                          ? select.online({ data: new Playing({}), decoded: true })
                          : select.unchanged()
                      }
                    }
                  },
                  Playing: {}
                }
              },
              Network: {
                initial: {
                  target: Machine.targets(States).root.System.Network.Online,
                  decoded: true,
                  data: new Online({})
                },
                states: {
                  Online: {},
                  Offline: {}
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
      class Work extends Schema.TaggedClass<Work>("Work")("Work", {}) {
      }
      class Finished extends Schema.TaggedClass<Finished>("Finished")("Finished", {}) {
      }
      class Restarted extends Schema.TaggedClass<Restarted>("Restarted")("Restarted", {}) {
      }
      class Monitor extends Schema.TaggedClass<Monitor>("Monitor")("Monitor", {}) {
      }
      class Active extends Schema.TaggedClass<Active>("Active")("Active", {}) {
      }
      const completionStates = Machine.state({
        states: {
          System: {
            schema: System,
            type: "parallel",
            states: {
              Work: {
                schema: Work,
                states: {
                  Finished: { schema: Finished, type: "final" },
                  Restarted
                }
              },
              Monitor: {
                schema: Monitor,
                states: { Active }
              }
            }
          }
        }
      })
      let captured: Machine.Snapshot<typeof completionStates> | undefined
      const targets4 = Machine.targets(completionStates)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets4.root.System.Work.Restarted } } },
        root: completionStates,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(completionStates).root.System,
          decoded: true,
          data: new System({})
        },
        states: {
          System: {
            initial: { Work: { decoded: true, data: new Work({}) }, Monitor: { decoded: true, data: new Monitor({}) } },
            states: {
              Work: {
                initial: {
                  decoded: true,
                  data: new Finished({}),
                  target: Machine.targets(completionStates).root.System.Work.Finished
                },
                onDone: {
                  branches: "transition1",
                  resolve: ({ snapshot, select: { destination: target } }) => {
                    captured = snapshot
                    return target({ data: new Restarted({}), decoded: true })
                  }
                },
                states: {
                  Finished: {},
                  Restarted: {}
                }
              },
              Monitor: {
                initial: {
                  target: Machine.targets(completionStates).root.System.Monitor.Active,
                  decoded: true,
                  data: new Active({})
                },
                states: {
                  Active: {}
                }
              }
            }
          }
        }
      })
      const plan = yield* Machine.planInitial(machine)
      assert.strictEqual(completionStates.matches(captured!, "System.Work.Finished"), true)
      assert.strictEqual(completionStates.matches(captured!, "System.Monitor.Active"), true)
      assert.deepStrictEqual(captured!.completed, [{ path: "System.Work.Finished" as const, output: undefined }, {
        path: "System.Work" as const,
        output: undefined
      }])
      assert.strictEqual(completionStates.matches(plan.state, "System.Work.Restarted"), true)
    }))
})
