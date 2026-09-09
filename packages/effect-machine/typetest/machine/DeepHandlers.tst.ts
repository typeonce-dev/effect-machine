import { Context, Data, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
class Branch extends Schema.TaggedClass<Branch>("Branch")("Branch", {}) {}
class Hub extends Schema.TaggedClass<Hub>("Hub")("Hub", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Done extends Schema.TaggedClass<Done>("Done")("Done", { value: Schema.String }) {}
class Work extends Schema.TaggedClass<Work>("Work")("Work", {}) {}
class LeftRegion extends Schema.TaggedClass<LeftRegion>("LeftRegion")("LeftRegion", {}) {}
class RightRegion extends Schema.TaggedClass<RightRegion>("RightRegion")("RightRegion", {}) {}
class LeftDone extends Schema.TaggedClass<LeftDone>("LeftDone")("LeftDone", { value: Schema.String }) {}
class RightDone extends Schema.TaggedClass<RightDone>("RightDone")("RightDone", { value: Schema.Number }) {}
class Advance extends Schema.TaggedClass<Advance>("Advance")("Advance", { value: Schema.String }) {}
class DeepService extends Context.Service<DeepService, string>()("types/deep/DeepService") {
}
class DeepActionService extends Context.Service<DeepActionService, string>()("types/deep/DeepActionService") {
}
class DeepFailure extends Data.TaggedError("DeepFailure")<{}> {
}
class DeepActionFailure extends Data.TaggedError("DeepActionFailure")<{}> {
}
const DeepStates = Machine.state({
  states: {
    Root: {
      schema: Root,
      states: {
        L1: {
          schema: Branch,
          states: {
            L2: {
              schema: Branch,
              states: {
                L3: {
                  schema: Branch,
                  states: {
                    L4: {
                      schema: Branch,
                      states: {
                        L5: {
                          schema: Branch,
                          states: {
                            L6: {
                              schema: Branch,
                              states: {
                                L7: {
                                  schema: Branch,
                                  states: {
                                    L8: {
                                      schema: Branch,
                                      states: {
                                        L9: {
                                          schema: Branch,
                                          states: {
                                            L10: {
                                              schema: Branch,
                                              states: {
                                                Hub: {
                                                  schema: Hub,

                                                  states: {
                                                    Route: { type: "choice" },
                                                    Idle,
                                                    Done: {
                                                      schema: Done,
                                                      type: "final",
                                                      output: Schema.String
                                                    },
                                                    Work: {
                                                      schema: Work,
                                                      type: "parallel",
                                                      output: Schema.Struct({
                                                        left: Schema.String,
                                                        right: Schema.Number
                                                      }),
                                                      states: {
                                                        left: {
                                                          schema: LeftRegion,
                                                          states: {
                                                            LeftDone: {
                                                              schema: LeftDone,
                                                              type: "final",
                                                              output: Schema.String
                                                            }
                                                          }
                                                        },
                                                        right: {
                                                          schema: RightRegion,
                                                          states: {
                                                            RightDone: {
                                                              schema: RightDone,
                                                              type: "final",
                                                              output: Schema.Number
                                                            }
                                                          }
                                                        }
                                                      }
                                                    },
                                                    recent: { type: "history" }
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
const deepHistoryFallback = (
  target: Machine.Machine.HistoryDefaultTargetBuilder<{
    readonly "": typeof DeepStates.node
  }, "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub">
) =>
  target.from((tree) =>
    tree.Root.decoded(
      new Root({}),
      (root) =>
        root.L1.decoded(new Branch({}), (l1) =>
          l1.L2.decoded(new Branch({}), (l2) =>
            l2.L3.decoded(new Branch({}), (l3) =>
              l3.L4.decoded(new Branch({}), (l4) =>
                l4.L5.decoded(new Branch({}), (l5) =>
                  l5.L6.decoded(new Branch({}), (l6) =>
                    l6.L7.decoded(new Branch({}), (l7) =>
                      l7.L8.decoded(new Branch({}), (l8) =>
                        l8.L9.decoded(new Branch({}), (l9) =>
                          l9.L10.decoded(new Branch({}), (l10) =>
                            l10.Hub.decoded(new Hub({}), (hub) => hub.Idle.decoded(new Idle({})))))))))))))
    )
  )
const makeDeepMachine = () =>
  Machine.make({
    root: DeepStates,
    events: Machine.eventsFromSchemas(Advance)
  })
const atHub = <const Config extends object>(config: Config) =>
  ({
    initial: { target: Machine.targets(DeepStates).root.Root },
    states: {
      Root: {
        initial: { target: Machine.targets(DeepStates).root.Root.L1 },
        states: {
          L1: {
            initial: { target: Machine.targets(DeepStates).root.Root.L1.L2 },
            states: {
              L2: {
                initial: { target: Machine.targets(DeepStates).root.Root.L1.L2.L3 },
                states: {
                  L3: {
                    initial: { target: Machine.targets(DeepStates).root.Root.L1.L2.L3.L4 },
                    states: {
                      L4: {
                        initial: { target: Machine.targets(DeepStates).root.Root.L1.L2.L3.L4.L5 },
                        states: {
                          L5: {
                            initial: { target: Machine.targets(DeepStates).root.Root.L1.L2.L3.L4.L5.L6 },
                            states: {
                              L6: {
                                initial: { target: Machine.targets(DeepStates).root.Root.L1.L2.L3.L4.L5.L6.L7 },
                                states: {
                                  L7: {
                                    initial: { target: Machine.targets(DeepStates).root.Root.L1.L2.L3.L4.L5.L6.L7.L8 },
                                    states: {
                                      L8: {
                                        initial: {
                                          target: Machine.targets(DeepStates).root.Root.L1.L2.L3.L4.L5.L6.L7.L8.L9
                                        },
                                        states: {
                                          L9: {
                                            initial: {
                                              target:
                                                Machine.targets(DeepStates).root.Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10
                                            },
                                            states: {
                                              L10: {
                                                initial: {
                                                  target:
                                                    Machine.targets(DeepStates).root.Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10
                                                      .Hub
                                                },
                                                states: {
                                                  Hub: {
                                                    initial: {
                                                      target:
                                                        Machine.targets(DeepStates).root.Root.L1.L2.L3.L4.L5.L6.L7.L8.L9
                                                          .L10.Hub.Idle
                                                    },
                                                    history: {
                                                      recent: {
                                                        default: (
                                                          { target }: {
                                                            target: Parameters<typeof deepHistoryFallback>[0]
                                                          }
                                                        ) => deepHistoryFallback(target)
                                                      }
                                                    },
                                                    states: {
                                                      Route: {
                                                        choice: {
                                                          target:
                                                            Machine.targets(DeepStates).root.Root.L1.L2.L3.L4.L5.L6.L7
                                                              .L8.L9.L10.Hub.Idle
                                                        }
                                                      },
                                                      Idle: {},
                                                      Done: { output: ({ state }: { state: Done }) => state.value },
                                                      Work: {
                                                        output: () => ({ left: "", right: 0 }),
                                                        states: {
                                                          left: {
                                                            initial: {
                                                              target:
                                                                Machine.targets(DeepStates).root.Root.L1.L2.L3.L4.L5.L6
                                                                  .L7.L8.L9.L10.Hub.Work.left.LeftDone,
                                                              data: { value: "" }
                                                            },
                                                            states: {
                                                              LeftDone: {
                                                                output: ({ state }: { state: LeftDone }) => state.value
                                                              }
                                                            }
                                                          },
                                                          right: {
                                                            initial: {
                                                              target:
                                                                Machine.targets(DeepStates).root.Root.L1.L2.L3.L4.L5.L6
                                                                  .L7.L8.L9.L10.Hub.Work.right.RightDone,
                                                              data: { value: 0 }
                                                            },
                                                            states: {
                                                              RightDone: {
                                                                output: ({ state }: { state: RightDone }) => state.value
                                                              }
                                                            }
                                                          }
                                                        }
                                                      }
                                                    },
                                                    ...config
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
  }) as const

describe("deep handler trees", () => {
  it("keeps branded validation effective at deep paths", () => {
    const machine = makeDeepMachine()
    machine.handle(atHub({}))
    expect(machine.handle).type.not.toBeCallableWith(atHub({
      states: {
        Missing: {}
      }
    }))
    expect(machine.handle).type.not.toBeCallableWith(atHub({
      states: {
        Idle: {
          on: {
            Missing: () => undefined
          }
        }
      }
    }))
    expect(machine.handle).type.not.toBeCallableWith(atHub({
      states: {
        Idle: {
          unsupported: true
        }
      }
    }))
    expect(machine.handle).type.not.toBeCallableWith(atHub({
      onDone: () => undefined
    }))
  })
  it("retains exact evidence through a narrow depth-24 tree", () => {
    const NarrowNode = Schema.TaggedStruct("NarrowNode", {})
    class NarrowService extends Context.Service<NarrowService, string>()("types/deep/NarrowService") {
    }
    class NarrowFailure extends Data.TaggedError("NarrowFailure")<{}> {
    }
    const States = Machine.state({
      states: {
        n0: {
          schema: NarrowNode,
          states: {
            n1: {
              schema: NarrowNode,
              states: {
                n2: {
                  schema: NarrowNode,
                  states: {
                    n3: {
                      schema: NarrowNode,
                      states: {
                        n4: {
                          schema: NarrowNode,
                          states: {
                            n5: {
                              schema: NarrowNode,
                              states: {
                                n6: {
                                  schema: NarrowNode,
                                  states: {
                                    n7: {
                                      schema: NarrowNode,
                                      states: {
                                        n8: {
                                          schema: NarrowNode,
                                          states: {
                                            n9: {
                                              schema: NarrowNode,
                                              states: {
                                                n10: {
                                                  schema: NarrowNode,
                                                  states: {
                                                    n11: {
                                                      schema: NarrowNode,
                                                      states: {
                                                        n12: {
                                                          schema: NarrowNode,
                                                          states: {
                                                            n13: {
                                                              schema: NarrowNode,
                                                              states: {
                                                                n14: {
                                                                  schema: NarrowNode,
                                                                  states: {
                                                                    n15: {
                                                                      schema: NarrowNode,
                                                                      states: {
                                                                        n16: {
                                                                          schema: NarrowNode,
                                                                          states: {
                                                                            n17: {
                                                                              schema: NarrowNode,
                                                                              states: {
                                                                                n18: {
                                                                                  schema: NarrowNode,
                                                                                  states: {
                                                                                    n19: {
                                                                                      schema: NarrowNode,
                                                                                      states: {
                                                                                        n20: {
                                                                                          schema: NarrowNode,
                                                                                          states: {
                                                                                            n21: {
                                                                                              schema: NarrowNode,
                                                                                              states: {
                                                                                                n22: {
                                                                                                  schema: NarrowNode,
                                                                                                  states: {
                                                                                                    n23: {
                                                                                                      schema:
                                                                                                        NarrowNode,
                                                                                                      states: {
                                                                                                        n24: {
                                                                                                          schema:
                                                                                                            NarrowNode,
                                                                                                          type: "final",
                                                                                                          output: Schema
                                                                                                            .String
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
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas()
    }).handle({
      initial: {
        target: Machine.targets(States).root.n0,
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        n0: {
          initial: {
            target: Machine.targets(States).root.n0.n1,
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            n1: {
              initial: {
                target: Machine.targets(States).root.n0.n1.n2,
                data: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                n2: {
                  initial: {
                    target: Machine.targets(States).root.n0.n1.n2.n3,
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  },
                  states: {
                    n3: {
                      initial: {
                        target: Machine.targets(States).root.n0.n1.n2.n3.n4,
                        data: () => {
                          throw new Error("type-only constructor")
                        }
                      },
                      states: {
                        n4: {
                          initial: {
                            target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5,
                            data: () => {
                              throw new Error("type-only constructor")
                            }
                          },
                          states: {
                            n5: {
                              initial: {
                                target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6,
                                data: () => {
                                  throw new Error("type-only constructor")
                                }
                              },
                              states: {
                                n6: {
                                  initial: {
                                    target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7,
                                    data: () => {
                                      throw new Error("type-only constructor")
                                    }
                                  },
                                  states: {
                                    n7: {
                                      initial: {
                                        target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7.n8,
                                        data: () => {
                                          throw new Error("type-only constructor")
                                        }
                                      },
                                      states: {
                                        n8: {
                                          initial: {
                                            target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9,
                                            data: () => {
                                              throw new Error("type-only constructor")
                                            }
                                          },
                                          states: {
                                            n9: {
                                              initial: {
                                                target: Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10,
                                                data: () => {
                                                  throw new Error("type-only constructor")
                                                }
                                              },
                                              states: {
                                                n10: {
                                                  initial: {
                                                    target:
                                                      Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10
                                                        .n11,
                                                    data: () => {
                                                      throw new Error("type-only constructor")
                                                    }
                                                  },
                                                  states: {
                                                    n11: {
                                                      initial: {
                                                        target:
                                                          Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10
                                                            .n11.n12,
                                                        data: () => {
                                                          throw new Error("type-only constructor")
                                                        }
                                                      },
                                                      states: {
                                                        n12: {
                                                          initial: {
                                                            target:
                                                              Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9
                                                                .n10.n11.n12.n13,
                                                            data: () => {
                                                              throw new Error("type-only constructor")
                                                            }
                                                          },
                                                          states: {
                                                            n13: {
                                                              initial: {
                                                                target:
                                                                  Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6.n7
                                                                    .n8.n9.n10.n11.n12.n13.n14,
                                                                data: () => {
                                                                  throw new Error("type-only constructor")
                                                                }
                                                              },
                                                              states: {
                                                                n14: {
                                                                  initial: {
                                                                    target:
                                                                      Machine.targets(States).root.n0.n1.n2.n3.n4.n5.n6
                                                                        .n7.n8.n9.n10.n11.n12.n13.n14.n15,
                                                                    data: () => {
                                                                      throw new Error("type-only constructor")
                                                                    }
                                                                  },
                                                                  states: {
                                                                    n15: {
                                                                      initial: {
                                                                        target:
                                                                          Machine.targets(States).root.n0.n1.n2.n3.n4.n5
                                                                            .n6.n7.n8.n9.n10.n11.n12.n13.n14.n15.n16,
                                                                        data: () => {
                                                                          throw new Error("type-only constructor")
                                                                        }
                                                                      },
                                                                      states: {
                                                                        n16: {
                                                                          initial: {
                                                                            target:
                                                                              Machine.targets(States).root.n0.n1.n2.n3
                                                                                .n4.n5.n6.n7.n8.n9.n10.n11.n12.n13.n14
                                                                                .n15.n16.n17,
                                                                            data: () => {
                                                                              throw new Error("type-only constructor")
                                                                            }
                                                                          },
                                                                          states: {
                                                                            n17: {
                                                                              initial: {
                                                                                target:
                                                                                  Machine.targets(States).root.n0.n1.n2
                                                                                    .n3.n4.n5.n6.n7.n8.n9.n10.n11.n12
                                                                                    .n13.n14.n15.n16.n17.n18,
                                                                                data: () => {
                                                                                  throw new Error(
                                                                                    "type-only constructor"
                                                                                  )
                                                                                }
                                                                              },
                                                                              states: {
                                                                                n18: {
                                                                                  initial: {
                                                                                    target:
                                                                                      Machine.targets(States).root.n0.n1
                                                                                        .n2.n3.n4.n5.n6.n7.n8.n9.n10.n11
                                                                                        .n12.n13.n14.n15.n16.n17.n18
                                                                                        .n19,
                                                                                    data: () => {
                                                                                      throw new Error(
                                                                                        "type-only constructor"
                                                                                      )
                                                                                    }
                                                                                  },
                                                                                  states: {
                                                                                    n19: {
                                                                                      initial: {
                                                                                        target:
                                                                                          Machine.targets(States).root
                                                                                            .n0.n1.n2.n3.n4.n5.n6.n7.n8
                                                                                            .n9.n10.n11.n12.n13.n14.n15
                                                                                            .n16.n17.n18.n19.n20,
                                                                                        data: () => {
                                                                                          throw new Error(
                                                                                            "type-only constructor"
                                                                                          )
                                                                                        }
                                                                                      },
                                                                                      states: {
                                                                                        n20: {
                                                                                          initial: {
                                                                                            target:
                                                                                              Machine.targets(States)
                                                                                                .root.n0.n1.n2.n3.n4.n5
                                                                                                .n6.n7.n8.n9.n10.n11.n12
                                                                                                .n13.n14.n15.n16.n17.n18
                                                                                                .n19.n20.n21,
                                                                                            data: () => {
                                                                                              throw new Error(
                                                                                                "type-only constructor"
                                                                                              )
                                                                                            }
                                                                                          },
                                                                                          states: {
                                                                                            n21: {
                                                                                              initial: {
                                                                                                target: Machine.targets(
                                                                                                  States
                                                                                                ).root.n0.n1.n2.n3.n4
                                                                                                  .n5.n6.n7.n8.n9.n10
                                                                                                  .n11.n12.n13.n14.n15
                                                                                                  .n16.n17.n18.n19.n20
                                                                                                  .n21.n22,
                                                                                                data: () => {
                                                                                                  throw new Error(
                                                                                                    "type-only constructor"
                                                                                                  )
                                                                                                }
                                                                                              },
                                                                                              states: {
                                                                                                n22: {
                                                                                                  initial: {
                                                                                                    target:
                                                                                                      Machine.targets(
                                                                                                        States
                                                                                                      ).root.n0.n1.n2.n3
                                                                                                        .n4.n5.n6.n7.n8
                                                                                                        .n9.n10.n11.n12
                                                                                                        .n13.n14.n15.n16
                                                                                                        .n17.n18.n19.n20
                                                                                                        .n21.n22.n23,
                                                                                                    data: () => {
                                                                                                      throw new Error(
                                                                                                        "type-only constructor"
                                                                                                      )
                                                                                                    }
                                                                                                  },
                                                                                                  states: {
                                                                                                    n23: {
                                                                                                      initial: {
                                                                                                        target: Machine
                                                                                                          .targets(
                                                                                                            States
                                                                                                          ).root.n0.n1
                                                                                                          .n2.n3.n4.n5
                                                                                                          .n6.n7.n8.n9
                                                                                                          .n10.n11.n12
                                                                                                          .n13.n14.n15
                                                                                                          .n16.n17.n18
                                                                                                          .n19.n20.n21
                                                                                                          .n22.n23
                                                                                                          .n24,
                                                                                                        data: () => {
                                                                                                          throw new Error(
                                                                                                            "type-only constructor"
                                                                                                          )
                                                                                                        }
                                                                                                      },
                                                                                                      states: {
                                                                                                        n24: {
                                                                                                          entry:
                                                                                                            () => {},
                                                                                                          output: () =>
                                                                                                            "complete"
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
    expect<Machine.Machine.UnhandledStates<typeof machine>>().type.toBe<never>()
    expect<Machine.Machine.Error<typeof machine>>().type.toBe<never>()
    expect<Machine.Machine.Services<typeof machine>>().type.toBe<never>()
    expect<Machine.Machine.OutputStates<typeof machine>>().type.toBe<
      "n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10.n11.n12.n13.n14.n15.n16.n17.n18.n19.n20.n21.n22.n23.n24"
    >()
    expect(Machine.planInitial).type.toBeCallableWith(machine)
  })
})
