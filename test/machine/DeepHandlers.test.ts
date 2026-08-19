import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Option, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"

class NodeState extends Schema.TaggedClass<NodeState>("DeepNode")("DeepNode", { level: Schema.Number }) {}
class DeepIdle extends Schema.TaggedClass<DeepIdle>("DeepIdle")("DeepIdle", { value: Schema.String }) {}
class DeepDone extends Schema.TaggedClass<DeepDone>("DeepDone")("DeepDone", { value: Schema.String }) {}
class Advance extends Schema.TaggedClass<Advance>("Advance")("Advance", { value: Schema.String }) {}

const States = Machine.states({
  n0: {
    schema: NodeState,
    initial: "n1",
    states: {
      n1: {
        schema: NodeState,
        initial: "n2",
        states: {
          n2: {
            schema: NodeState,
            initial: "n3",
            states: {
              n3: {
                schema: NodeState,
                initial: "n4",
                states: {
                  n4: {
                    schema: NodeState,
                    initial: "n5",
                    states: {
                      n5: {
                        schema: NodeState,
                        initial: "n6",
                        states: {
                          n6: {
                            schema: NodeState,
                            initial: "n7",
                            states: {
                              n7: {
                                schema: NodeState,
                                initial: "n8",
                                states: {
                                  n8: {
                                    schema: NodeState,
                                    initial: "n9",
                                    states: {
                                      n9: {
                                        schema: NodeState,
                                        initial: "n10",
                                        states: {
                                          n10: {
                                            schema: NodeState,
                                            initial: "n11",
                                            states: {
                                              n11: {
                                                schema: NodeState,
                                                initial: "idle",
                                                states: {
                                                  idle: DeepIdle,
                                                  done: {
                                                    schema: DeepDone,
                                                    type: "final"
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
})

const initial = (() => {
  let state: any = {
    path: "n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10.n11.idle",
    value: new DeepIdle({ value: "initial" })
  }
  for (let level = 11; level >= 0; level--) {
    state = {
      path: Array.from({ length: level + 1 }, (_, index) => `n${index}`).join("."),
      value: new NodeState({ level }),
      state
    }
  }
  return state as Machine.Machine.Snapshot<typeof States.states>
})()

const machine = Machine.make({
  states: States.states,
  events: Machine.events(Advance),
  initial: (to) => to.n0.initial.resolve(() => initial)
}).handle({
  n0: {
    states: {
      n1: {
        states: {
          n2: {
            states: {
              n3: {
                states: {
                  n4: {
                    states: {
                      n5: {
                        states: {
                          n6: {
                            states: {
                              n7: {
                                states: {
                                  n8: {
                                    states: {
                                      n9: {
                                        states: {
                                          n10: {
                                            states: {
                                              n11: {
                                                states: {
                                                  idle: {
                                                    on: {
                                                      Advance: (to) =>
                                                        to.local.done().resolve(({ event, target }) =>
                                                          target(new DeepDone({ value: event.value }))
                                                        )
                                                    }
                                                  },
                                                  done: {}
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
})

it.effect("runs handlers below the former depth ceiling", () =>
  Effect.gen(function*() {
    const actor = yield* Machine.start(machine)

    assert.deepStrictEqual(
      States.get(yield* actor.state, "n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10.n11.idle"),
      Option.some(new DeepIdle({ value: "initial" }))
    )

    const observer = yield* actor.changes.pipe(
      Stream.filter((snapshot) =>
        snapshot.status === "active" &&
        States.matches(snapshot.state, "n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10.n11.done")
      ),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild
    )
    yield* actor.send(new Advance({ value: "complete" }))
    yield* Fiber.join(observer)

    assert.deepStrictEqual(
      States.get(yield* actor.state, "n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10.n11.done"),
      Option.some(new DeepDone({ value: "complete" }))
    )
  }))
