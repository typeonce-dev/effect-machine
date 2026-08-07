import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Option, Schema, Stream } from "effect"
import { Machine } from "../src/index.js"

class NodeState extends Schema.TaggedClass<NodeState>("DeepNode")("DeepNode", { level: Schema.Number }) {}
class DeepIdle extends Schema.TaggedClass<DeepIdle>("DeepIdle")("DeepIdle", { value: Schema.String }) {}
class DeepDone extends Schema.TaggedClass<DeepDone>("DeepDone")("DeepDone", { value: Schema.String }) {}
class Advance extends Schema.TaggedClass<Advance>("Advance")("Advance", { value: Schema.String }) {}

const States = Machine.defineStates({
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

const initial = States.initial.n0(
  new NodeState({ level: 0 }),
  (n0) =>
    n0.n1(
      new NodeState({ level: 1 }),
      (n1) =>
        n1.n2(new NodeState({ level: 2 }), (n2) =>
          n2.n3(new NodeState({ level: 3 }), (n3) =>
            n3.n4(new NodeState({ level: 4 }), (n4) =>
              n4.n5(new NodeState({ level: 5 }), (n5) =>
                n5.n6(new NodeState({ level: 6 }), (n6) =>
                  n6.n7(new NodeState({ level: 7 }), (n7) =>
                    n7.n8(new NodeState({ level: 8 }), (n8) =>
                      n8.n9(new NodeState({ level: 9 }), (n9) =>
                        n9.n10(new NodeState({ level: 10 }), (n10) =>
                          n10.n11(new NodeState({ level: 11 }), (n11) =>
                            n11.idle(new DeepIdle({ value: "initial" }))))))))))))
    )
)

const machine = Machine.make({
  states: States.states,
  events: [Advance],
  initial: () => initial
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
                                                      Advance: ({ event, target }) =>
                                                        target.local.done(new DeepDone({ value: event.value }))
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
