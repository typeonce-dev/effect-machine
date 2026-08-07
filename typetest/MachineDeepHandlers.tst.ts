import { Context, Data, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../src/index.js"

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

class DeepService extends Context.Service<DeepService, string>()("types/deep/DeepService") {}
class DeepActionService extends Context.Service<DeepActionService, string>()("types/deep/DeepActionService") {}
class DeepFailure extends Data.TaggedError("DeepFailure")<{}> {}
class DeepActionFailure extends Data.TaggedError("DeepActionFailure")<{}> {}

const DeepStates = Machine.defineStates({
  Root: {
    schema: Root,
    initial: "L1",
    states: {
      L1: {
        schema: Branch,
        initial: "L2",
        states: {
          L2: {
            schema: Branch,
            initial: "L3",
            states: {
              L3: {
                schema: Branch,
                initial: "L4",
                states: {
                  L4: {
                    schema: Branch,
                    initial: "L5",
                    states: {
                      L5: {
                        schema: Branch,
                        initial: "L6",
                        states: {
                          L6: {
                            schema: Branch,
                            initial: "L7",
                            states: {
                              L7: {
                                schema: Branch,
                                initial: "L8",
                                states: {
                                  L8: {
                                    schema: Branch,
                                    initial: "L9",
                                    states: {
                                      L9: {
                                        schema: Branch,
                                        initial: "L10",
                                        states: {
                                          L10: {
                                            schema: Branch,
                                            initial: "Hub",
                                            states: {
                                              Hub: {
                                                schema: Hub,
                                                initial: "Route",
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
                                                        initial: "LeftDone",
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
                                                        initial: "RightDone",
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
})

const deepHistoryFallback = (
  target: Machine.Machine.HistoryDefaultTargetBuilder<
    typeof DeepStates.states,
    "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub"
  >
) =>
  target.Root(
    new Root({}),
    (root) =>
      root.L1(new Branch({}), (l1) =>
        l1.L2(new Branch({}), (l2) =>
          l2.L3(new Branch({}), (l3) =>
            l3.L4(new Branch({}), (l4) =>
              l4.L5(new Branch({}), (l5) =>
                l5.L6(new Branch({}), (l6) =>
                  l6.L7(new Branch({}), (l7) =>
                    l7.L8(new Branch({}), (l8) =>
                      l8.L9(new Branch({}), (l9) =>
                        l9.L10(new Branch({}), (l10) =>
                          l10.Hub(new Hub({}), (hub) =>
                            hub.Idle(new Idle({})))))))))))))
  )

const makeDeepMachine = () =>
  Machine.make({
    states: DeepStates.states,
    events: [Advance],
    initial: (): never => {
      throw new Error("type-only")
    }
  })

const atHub = <const Config>(config: Config) =>
  ({
    Root: {
      states: {
        L1: {
          states: {
            L2: {
              states: {
                L3: {
                  states: {
                    L4: {
                      states: {
                        L5: {
                          states: {
                            L6: {
                              states: {
                                L7: {
                                  states: {
                                    L8: {
                                      states: {
                                        L9: {
                                          states: {
                                            L10: {
                                              states: {
                                                Hub: config
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
  it("preserves contexts and accumulates history, choice, action, invoke, and output evidence across calls", () => {
    const afterBehavior = makeDeepMachine().handle({
      Root: {
        states: {
          L1: {
            states: {
              L2: {
                states: {
                  L3: {
                    states: {
                      L4: {
                        states: {
                          L5: {
                            states: {
                              L6: {
                                states: {
                                  L7: {
                                    states: {
                                      L8: {
                                        states: {
                                          L9: {
                                            states: {
                                              L10: {
                                                states: {
                                                  Hub: {
                                                    history: {
                                                      recent: {
                                                        default: ({ target }) => deepHistoryFallback(target)
                                                      }
                                                    },
                                                    states: {
                                                      Route: {
                                                        choice: {
                                                          targets: ["Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Idle"],
                                                          transition: ({ parent, parents, target }) => {
                                                            expect(parent).type.toBe<Hub>()
                                                            expect(parents["Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub"])
                                                              .type.toBe<Hub>()
                                                            return target.local.Idle(new Idle({}))
                                                          }
                                                        }
                                                      },
                                                      Idle: {
                                                        entry: () =>
                                                          Effect.flatMap(
                                                            DeepService,
                                                            () => Effect.fail(new DeepFailure())
                                                          ),
                                                        exit: () => undefined,
                                                        always: () => undefined,
                                                        invoke: ({ state, parent, parents, event }) => {
                                                          expect(state).type.toBe<Idle>()
                                                          expect(parent).type.toBe<Hub>()
                                                          expect(parents["Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub"])
                                                            .type.toBe<Hub>()
                                                          expect(event).type.toBe<Advance | Machine.InitialEvent>()
                                                          return Machine.invoke({
                                                            id: "deep",
                                                            src: () => Machine.effect(Effect.void)
                                                          })
                                                        },
                                                        on: {
                                                          Advance: {
                                                            targets: ["Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Done"],
                                                            transition: (
                                                              { event, parent, parents, snapshot, state, target }
                                                            ) => {
                                                              expect(event).type.toBe<Advance>()
                                                              expect(state).type.toBe<Idle>()
                                                              expect(parent).type.toBe<Hub>()
                                                              expect(parents["Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub"])
                                                                .type.toBe<Hub>()
                                                              expect(snapshot).type.toBe<
                                                                Machine.Machine.Snapshot<typeof DeepStates.states>
                                                              >()
                                                              expect(target).type.toBe<
                                                                Machine.Machine.TargetBuilder<
                                                                  typeof DeepStates.states,
                                                                  "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Idle"
                                                                >
                                                              >()
                                                              return Machine.action(
                                                                Effect.flatMap(
                                                                  DeepActionService,
                                                                  () => Effect.fail(new DeepActionFailure())
                                                                ),
                                                                target.local.Done(new Done({ value: event.value }))
                                                              )
                                                            }
                                                          }
                                                        }
                                                      },
                                                      Work: {
                                                        initial: () => ({
                                                          left: new LeftRegion({}),
                                                          right: new RightRegion({})
                                                        }),
                                                        output: ({ outputs, parent, parents, state }) => {
                                                          expect(outputs.left).type.toBe<string>()
                                                          expect(outputs.right).type.toBe<number>()
                                                          expect(state).type.toBe<Work>()
                                                          expect(parent).type.toBe<Hub>()
                                                          expect(
                                                            parents[
                                                              "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub"
                                                            ]
                                                          ).type.toBe<Hub>()
                                                          return {
                                                            left: outputs.left,
                                                            right: outputs.right
                                                          }
                                                        },
                                                        onDone: ({ output }) => {
                                                          expect(output).type.toBe<{
                                                            readonly left: string
                                                            readonly right: number
                                                          }>()
                                                        },
                                                        states: {
                                                          left: {
                                                            initial: () => new LeftDone({ value: "left" }),
                                                            states: {
                                                              LeftDone: {
                                                                output: ({ state }) => state.value
                                                              }
                                                            }
                                                          },
                                                          right: {
                                                            initial: () => new RightDone({ value: 1 }),
                                                            states: {
                                                              RightDone: {
                                                                output: ({ state }) => state.value
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

    expect<Machine.Machine.UnhandledStates<typeof afterBehavior>>().type.toBe<
      "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Done"
    >()
    expect<Machine.Machine.OutputStates<typeof afterBehavior>>().type.toBe<
      | "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Work"
      | "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Work.left.LeftDone"
      | "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Work.right.RightDone"
    >()
    expect<Machine.Machine.Error<typeof afterBehavior>>().type.toBe<
      DeepFailure | Machine.ChildAlreadyExistsError
    >()
    type AfterServices = Machine.Machine.Services<typeof afterBehavior>
    expect<Extract<AfterServices, DeepService>>().type.toBe<DeepService>()
    expect<Extract<AfterServices, Machine.ActionRequirement<any, any>>>().type.toBe<
      Machine.ActionRequirement<DeepActionFailure, DeepActionService>
    >()
    expect<0 extends 1 & AfterServices ? true : false>().type.toBe<false>()
    expect<Machine.ActionError<Machine.Machine.Services<typeof afterBehavior>>>().type.toBe<DeepActionFailure>()
    expect<Machine.ActionServices<Machine.Machine.Services<typeof afterBehavior>>>().type.toBe<DeepActionService>()
    expect(Machine.planInitial).type.not.toBeCallableWith(afterBehavior)

    const complete = afterBehavior.handle({
      Root: {
        states: {
          L1: {
            states: {
              L2: {
                states: {
                  L3: {
                    states: {
                      L4: {
                        states: {
                          L5: {
                            states: {
                              L6: {
                                states: {
                                  L7: {
                                    states: {
                                      L8: {
                                        states: {
                                          L9: {
                                            states: {
                                              L10: {
                                                states: {
                                                  Hub: {
                                                    onDone: ({ output, parent, parents, snapshot, state, target }) => {
                                                      expect(output).type.toBe<string>()
                                                      expect(state).type.toBe<Hub>()
                                                      expect(parent).type.toBe<Branch>()
                                                      expect(parents["Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10"]).type.toBe<
                                                        Branch
                                                      >()
                                                      expect(snapshot).type.toBe<
                                                        Machine.Machine.Snapshot<typeof DeepStates.states>
                                                      >()
                                                      expect(target).type.toBe<
                                                        Machine.Machine.TargetBuilder<
                                                          typeof DeepStates.states,
                                                          "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub"
                                                        >
                                                      >()
                                                    },
                                                    states: {
                                                      Done: {
                                                        output: ({ event, parent, parents, state }) => {
                                                          expect(event).type.toBe<Advance | Machine.InitialEvent>()
                                                          expect(state).type.toBe<Done>()
                                                          expect(parent).type.toBe<Hub>()
                                                          expect(parents["Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub"])
                                                            .type.toBe<Hub>()
                                                          return state.value
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

    expect<Machine.Machine.UnhandledStates<typeof complete>>().type.toBe<never>()
    expect<Machine.Machine.OutputStates<typeof complete>>().type.toBe<
      | "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Done"
      | "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Work"
      | "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Work.left.LeftDone"
      | "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Work.right.RightDone"
    >()
    expect<Machine.Machine.Error<typeof complete>>().type.toBe<
      DeepFailure | Machine.ChildAlreadyExistsError
    >()
    type CompleteServices = Machine.Machine.Services<typeof complete>
    expect<Extract<CompleteServices, DeepService>>().type.toBe<DeepService>()
    expect<Extract<CompleteServices, Machine.ActionRequirement<any, any>>>().type.toBe<
      Machine.ActionRequirement<DeepActionFailure, DeepActionService>
    >()
    expect<0 extends 1 & CompleteServices ? true : false>().type.toBe<false>()
    expect(Machine.planInitial).type.toBeCallableWith(complete)
    const planned = Machine.planInitial(complete)
    const started = Machine.start(complete)
    type PlannedServices = Effect.Services<typeof planned>
    expect<Extract<PlannedServices, DeepService>>().type.toBe<DeepService>()
    expect<0 extends 1 & PlannedServices ? true : false>().type.toBe<false>()
    expect<Effect.Services<typeof started>>().type.toBe<DeepService | DeepActionService>()
  })

  it("keeps branded validation effective at deep paths", () => {
    const machine = makeDeepMachine()

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
    expect(machine.handle).type.not.toBeCallableWith(atHub({
      states: {
        Idle: {
          on: {
            Advance: {
              targets: ["Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Idle"],
              transition: (
                { target }: Machine.Machine.HandlerContext<
                  typeof DeepStates.states,
                  readonly [typeof Advance],
                  readonly [],
                  "Root.L1.L2.L3.L4.L5.L6.L7.L8.L9.L10.Hub.Idle",
                  "Advance",
                  never,
                  never
                >
              ) => target.local.Done(new Done({ value: "invalid-bound" }))
            }
          }
        }
      }
    }))
  })

  it("retains exact evidence through a narrow depth-24 tree", () => {
    const NarrowNode = Schema.TaggedStruct("NarrowNode", {})
    class NarrowService extends Context.Service<NarrowService, string>()("types/deep/NarrowService") {}
    class NarrowFailure extends Data.TaggedError("NarrowFailure")<{}> {}

    const States = Machine.defineStates({
      n0: {
        schema: NarrowNode,
        initial: "n1",
        states: {
          n1: {
            schema: NarrowNode,
            initial: "n2",
            states: {
              n2: {
                schema: NarrowNode,
                initial: "n3",
                states: {
                  n3: {
                    schema: NarrowNode,
                    initial: "n4",
                    states: {
                      n4: {
                        schema: NarrowNode,
                        initial: "n5",
                        states: {
                          n5: {
                            schema: NarrowNode,
                            initial: "n6",
                            states: {
                              n6: {
                                schema: NarrowNode,
                                initial: "n7",
                                states: {
                                  n7: {
                                    schema: NarrowNode,
                                    initial: "n8",
                                    states: {
                                      n8: {
                                        schema: NarrowNode,
                                        initial: "n9",
                                        states: {
                                          n9: {
                                            schema: NarrowNode,
                                            initial: "n10",
                                            states: {
                                              n10: {
                                                schema: NarrowNode,
                                                initial: "n11",
                                                states: {
                                                  n11: {
                                                    schema: NarrowNode,
                                                    initial: "n12",
                                                    states: {
                                                      n12: {
                                                        schema: NarrowNode,
                                                        initial: "n13",
                                                        states: {
                                                          n13: {
                                                            schema: NarrowNode,
                                                            initial: "n14",
                                                            states: {
                                                              n14: {
                                                                schema: NarrowNode,
                                                                initial: "n15",
                                                                states: {
                                                                  n15: {
                                                                    schema: NarrowNode,
                                                                    initial: "n16",
                                                                    states: {
                                                                      n16: {
                                                                        schema: NarrowNode,
                                                                        initial: "n17",
                                                                        states: {
                                                                          n17: {
                                                                            schema: NarrowNode,
                                                                            initial: "n18",
                                                                            states: {
                                                                              n18: {
                                                                                schema: NarrowNode,
                                                                                initial: "n19",
                                                                                states: {
                                                                                  n19: {
                                                                                    schema: NarrowNode,
                                                                                    initial: "n20",
                                                                                    states: {
                                                                                      n20: {
                                                                                        schema: NarrowNode,
                                                                                        initial: "n21",
                                                                                        states: {
                                                                                          n21: {
                                                                                            schema: NarrowNode,
                                                                                            initial: "n22",
                                                                                            states: {
                                                                                              n22: {
                                                                                                schema: NarrowNode,
                                                                                                initial: "n23",
                                                                                                states: {
                                                                                                  n23: {
                                                                                                    schema: NarrowNode,
                                                                                                    initial: "n24",
                                                                                                    states: {
                                                                                                      n24: {
                                                                                                        schema:
                                                                                                          NarrowNode,
                                                                                                        type: "final",
                                                                                                        output:
                                                                                                          Schema.String
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
      states: States.states,
      events: [],
      initial: (): never => {
        throw new Error("type-only")
      }
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
                                                      n12: {
                                                        states: {
                                                          n13: {
                                                            states: {
                                                              n14: {
                                                                states: {
                                                                  n15: {
                                                                    states: {
                                                                      n16: {
                                                                        states: {
                                                                          n17: {
                                                                            states: {
                                                                              n18: {
                                                                                states: {
                                                                                  n19: {
                                                                                    states: {
                                                                                      n20: {
                                                                                        states: {
                                                                                          n21: {
                                                                                            states: {
                                                                                              n22: {
                                                                                                states: {
                                                                                                  n23: {
                                                                                                    states: {
                                                                                                      n24: {
                                                                                                        entry: () =>
                                                                                                          Effect
                                                                                                            .flatMap(
                                                                                                              NarrowService,
                                                                                                              () =>
                                                                                                                Effect
                                                                                                                  .fail(
                                                                                                                    new NarrowFailure()
                                                                                                                  )
                                                                                                            ),
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
    })

    expect<Machine.Machine.UnhandledStates<typeof machine>>().type.toBe<never>()
    expect<Machine.Machine.Error<typeof machine>>().type.toBe<NarrowFailure>()
    expect<Machine.Machine.Services<typeof machine>>().type.toBe<NarrowService>()
    expect<Machine.Machine.OutputStates<typeof machine>>().type.toBe<
      "n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10.n11.n12.n13.n14.n15.n16.n17.n18.n19.n20.n21.n22.n23.n24"
    >()
    expect(Machine.planInitial).type.toBeCallableWith(machine)
  })
})
