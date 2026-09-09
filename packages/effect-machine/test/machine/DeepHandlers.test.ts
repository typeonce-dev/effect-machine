import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Option, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"
class NodeState extends Schema.TaggedClass<NodeState>("DeepNode")("DeepNode", { level: Schema.Number }) {}
class DeepIdle extends Schema.TaggedClass<DeepIdle>("DeepIdle")("DeepIdle", { value: Schema.String }) {}
class DeepDone extends Schema.TaggedClass<DeepDone>("DeepDone")("DeepDone", { value: Schema.String }) {}
class Advance extends Schema.TaggedClass<Advance>("Advance")("Advance", { value: Schema.String }) {}
const States = Machine.state({
  states: {
    n0: {
      schema: NodeState,
      states: {
        n1: {
          schema: NodeState,
          states: {
            n2: {
              schema: NodeState,
              states: {
                n3: {
                  schema: NodeState,
                  states: {
                    n4: {
                      schema: NodeState,
                      states: {
                        n5: {
                          schema: NodeState,
                          states: {
                            n6: {
                              schema: NodeState,
                              states: {
                                n7: {
                                  schema: NodeState,
                                  states: {
                                    n8: {
                                      schema: NodeState,
                                      states: {
                                        n9: {
                                          schema: NodeState,
                                          states: {
                                            n10: {
                                              schema: NodeState,
                                              states: {
                                                n11: {
                                                  schema: NodeState,
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
  }
})
const targets1 = Machine.targets(States)
const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Advance)
}).handle({
  initial: { target: Machine.targets(States).root.n0, decoded: true, data: new NodeState({ level: 0 }) },
  states: {
    n0: {
      initial: { target: Machine.targets(States).root.n0.n1, decoded: true, data: new NodeState({ level: 1 }) },
      states: {
        n1: {
          initial: { target: Machine.targets(States).root.n0.n1.n2, decoded: true, data: new NodeState({ level: 2 }) },
          states: {
            n2: {
              initial: {
                target: Machine.targets(States).root.n0.n1.n2.n3,
                decoded: true,
                data: new NodeState({ level: 3 })
              },
              states: {
                n3: {
                  initial: {
                    target: Machine.targets(States).root.n0.n1.n2.n3.n4,
                    decoded: true,
                    data: new NodeState({ level: 4 })
                  },
                  states: {
                    n4: {
                      initial: {
                        target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5,
                        decoded: true,
                        data: new NodeState({ level: 5 })
                      },
                      states: {
                        n5: {
                          initial: {
                            target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6,
                            decoded: true,
                            data: new NodeState({ level: 6 })
                          },
                          states: {
                            n6: {
                              initial: {
                                target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7,
                                decoded: true,
                                data: new NodeState({ level: 7 })
                              },
                              states: {
                                n7: {
                                  initial: {
                                    target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7.n8,
                                    decoded: true,
                                    data: new NodeState({ level: 8 })
                                  },
                                  states: {
                                    n8: {
                                      initial: {
                                        target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9,
                                        decoded: true,
                                        data: new NodeState({ level: 9 })
                                      },
                                      states: {
                                        n9: {
                                          initial: {
                                            target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10,
                                            decoded: true,
                                            data: new NodeState({ level: 10 })
                                          },
                                          states: {
                                            n10: {
                                              initial: {
                                                target:
                                                  Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10.n11,
                                                decoded: true,
                                                data: new NodeState({ level: 11 })
                                              },
                                              states: {
                                                n11: {
                                                  initial: {
                                                    target:
                                                      Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10.n11
                                                        .idle,
                                                    decoded: true,
                                                    data: new DeepIdle({ value: "initial" })
                                                  },
                                                  states: {
                                                    idle: {
                                                      on: {
                                                        Advance: {
                                                          target:
                                                            targets1.root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10.n11.done,
                                                          decoded: true,
                                                          data: ({ event }) => (new DeepDone({ value: event.value }))
                                                        }
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
