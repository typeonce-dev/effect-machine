import { Context, Data, Effect } from "effect"
import { Machine } from "../../dist/index.js"
import { machine, States } from "./handle-depth-24-control.js"

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2) ?
  true :
  false
type Expect<Value extends true> = Value

class DeepService extends Context.Service<DeepService, string>()("perf/depth-24/DeepService") {}
class DeepFailure extends Data.TaggedError("DeepFailure")<{}> {}

const targets = Machine.targets(States)
const handled = machine.handle({
  initial: { target: targets.root.n0 },
  states: {
    n0: {
      initial: { target: targets.root.n0.n1 },
      states: {
        n1: {
          initial: { target: targets.root.n0.n1.n2 },
          states: {
            n2: {
              initial: { target: targets.root.n0.n1.n2.n3 },
              states: {
                n3: {
                  initial: { target: targets.root.n0.n1.n2.n3.n4 },
                  states: {
                    n4: {
                      initial: { target: targets.root.n0.n1.n2.n3.n4.n5 },
                      states: {
                        n5: {
                          initial: { target: targets.root.n0.n1.n2.n3.n4.n5.n6 },
                          states: {
                            n6: {
                              initial: { target: targets.root.n0.n1.n2.n3.n4.n5.n6.n7 },
                              states: {
                                n7: {
                                  initial: { target: targets.root.n0.n1.n2.n3.n4.n5.n6.n7.n8 },
                                  states: {
                                    n8: {
                                      initial: { target: targets.root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9 },
                                      states: {
                                        n9: {
                                          initial: {
                                            target: targets.root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10
                                          },
                                          states: {
                                            n10: {
                                              initial: {
                                                target: targets.root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10.n11
                                              },
                                              states: {
                                                n11: {
                                                  initial: {
                                                    target: targets.root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10.n11
                                                      .n12
                                                  },
                                                  states: {
                                                    n12: {
                                                      initial: {
                                                        target: targets.root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10
                                                          .n11.n12.n13
                                                      },
                                                      states: {
                                                        n13: {
                                                          initial: {
                                                            target: targets.root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9
                                                              .n10.n11.n12.n13.n14
                                                          },
                                                          states: {
                                                            n14: {
                                                              initial: {
                                                                target: targets.root.n0.n1.n2.n3.n4.n5.n6.n7
                                                                  .n8.n9.n10.n11.n12.n13.n14.n15
                                                              },
                                                              states: {
                                                                n15: {
                                                                  initial: {
                                                                    target: targets.root.n0.n1.n2.n3.n4.n5.n6
                                                                      .n7.n8.n9.n10.n11.n12.n13.n14.n15.n16
                                                                  },
                                                                  states: {
                                                                    n16: {
                                                                      initial: {
                                                                        target: targets.root.n0.n1.n2.n3.n4.n5
                                                                          .n6.n7.n8.n9.n10.n11.n12.n13.n14.n15.n16.n17
                                                                      },
                                                                      states: {
                                                                        n17: {
                                                                          initial: {
                                                                            target: targets.root.n0.n1.n2.n3
                                                                              .n4.n5.n6.n7.n8.n9.n10.n11.n12.n13.n14
                                                                              .n15.n16.n17.n18
                                                                          },
                                                                          states: {
                                                                            n18: {
                                                                              initial: {
                                                                                target: targets.root.n0.n1.n2
                                                                                  .n3.n4.n5.n6.n7.n8.n9.n10.n11.n12
                                                                                  .n13.n14.n15.n16.n17.n18.n19
                                                                              },
                                                                              states: {
                                                                                n19: {
                                                                                  initial: {
                                                                                    target: targets.root.n0.n1
                                                                                      .n2.n3.n4.n5.n6.n7.n8.n9.n10.n11
                                                                                      .n12.n13.n14.n15.n16.n17.n18.n19
                                                                                      .n20
                                                                                  },
                                                                                  states: {
                                                                                    n20: {
                                                                                      initial: {
                                                                                        target: targets.root
                                                                                          .n0.n1.n2.n3.n4.n5.n6.n7.n8
                                                                                          .n9.n10.n11.n12.n13.n14.n15
                                                                                          .n16.n17.n18.n19.n20.n21
                                                                                      },
                                                                                      states: {
                                                                                        n21: {
                                                                                          initial: {
                                                                                            target:
                                                                                              Machine.targets(States)
                                                                                                .root.n0.n1.n2.n3.n4.n5
                                                                                                .n6.n7.n8.n9.n10.n11.n12
                                                                                                .n13.n14.n15.n16.n17.n18
                                                                                                .n19.n20.n21.n22
                                                                                          },
                                                                                          states: {
                                                                                            n22: {
                                                                                              initial: {
                                                                                                target: Machine.targets(
                                                                                                  States
                                                                                                ).root.n0.n1.n2.n3.n4
                                                                                                  .n5.n6.n7.n8.n9.n10
                                                                                                  .n11.n12.n13.n14.n15
                                                                                                  .n16.n17.n18.n19.n20
                                                                                                  .n21.n22.n23
                                                                                              },
                                                                                              states: {
                                                                                                n23: {
                                                                                                  initial: {
                                                                                                    target:
                                                                                                      Machine.targets(
                                                                                                        States
                                                                                                      ).root.n0.n1.n2.n3
                                                                                                        .n4.n5.n6.n7.n8
                                                                                                        .n9.n10.n11.n12
                                                                                                        .n13.n14.n15.n16
                                                                                                        .n17.n18.n19.n20
                                                                                                        .n21.n22.n23.n24
                                                                                                  },
                                                                                                  states: {
                                                                                                    n24: {
                                                                                                      entry: () => {},
                                                                                                      output: () =>
                                                                                                        "done"
                                                                                                    }
                                                                                                  }
                                                                                                }
                                                                                              }
                                                                                            }
                                                                                          }
                                                                                        }
                                                                                      }
                                                                                    }
                                                                                  }
                                                                                }
                                                                              }
                                                                            }
                                                                          }
                                                                        }
                                                                      }
                                                                    }
                                                                  }
                                                                }
                                                              }
                                                            }
                                                          }
                                                        }
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
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

type ErrorIsExact = Expect<Equal<Machine.Machine.Error<typeof handled>, never>>
type ServicesAreExact = Expect<Equal<Machine.Machine.Services<typeof handled>, never>>
type EveryStateIsHandled = Expect<Equal<Machine.Machine.UnhandledStates<typeof handled>, never>>

void Machine.planInitial(handled)
export type { ErrorIsExact, EveryStateIsHandled, ServicesAreExact }
