import { Context, Data, Effect } from "effect"
import { Machine } from "../../dist/index.js"
import { machine, States } from "./handle-depth-wide-16-control.js"

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2) ?
  true :
  false
type Expect<Value extends true> = Value

class DeepService extends Context.Service<DeepService, string>()("perf/depth-wide-16/DeepService") {}
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
                                                                      entry: () => {},
                                                                      output: () => "done"
                                                                    },
                                                                    side15_0: {},
                                                                    side15_1: {}
                                                                  }
                                                                },
                                                                side14_0: {},
                                                                side14_1: {}
                                                              }
                                                            },
                                                            side13_0: {},
                                                            side13_1: {}
                                                          }
                                                        },
                                                        side12_0: {},
                                                        side12_1: {}
                                                      }
                                                    },
                                                    side11_0: {},
                                                    side11_1: {}
                                                  }
                                                },
                                                side10_0: {},
                                                side10_1: {}
                                              }
                                            },
                                            side9_0: {},
                                            side9_1: {}
                                          }
                                        },
                                        side8_0: {},
                                        side8_1: {}
                                      }
                                    },
                                    side7_0: {},
                                    side7_1: {}
                                  }
                                },
                                side6_0: {},
                                side6_1: {}
                              }
                            },
                            side5_0: {},
                            side5_1: {}
                          }
                        },
                        side4_0: {},
                        side4_1: {}
                      }
                    },
                    side3_0: {},
                    side3_1: {}
                  }
                },
                side2_0: {},
                side2_1: {}
              }
            },
            side1_0: {},
            side1_1: {}
          }
        },
        side0_0: {},
        side0_1: {}
      }
    }
  }
})

type ErrorIsExact = Expect<Equal<Machine.Machine.Error<typeof handled>, never>>
type ServicesAreExact = Expect<Equal<Machine.Machine.Services<typeof handled>, never>>
type EveryStateIsHandled = Expect<Equal<Machine.Machine.UnhandledStates<typeof handled>, never>>

void Machine.planInitial(handled)
export type { ErrorIsExact, EveryStateIsHandled, ServicesAreExact }
