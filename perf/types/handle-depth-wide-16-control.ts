import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const NodeState = Schema.TaggedStruct("Node", {})

export const States = Machine.defineStates({
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
                                                initial: "n12",
                                                states: {
                                                  n12: {
                                                    schema: NodeState,
                                                    initial: "n13",
                                                    states: {
                                                      n13: {
                                                        schema: NodeState,
                                                        initial: "n14",
                                                        states: {
                                                          n14: {
                                                            schema: NodeState,
                                                            initial: "n15",
                                                            states: {
                                                              n15: {
                                                                schema: NodeState,
                                                                initial: "n16",
                                                                states: {
                                                                  n16: {
                                                                    schema: NodeState,
                                                                    type: "final",
                                                                    output: Schema.String
                                                                  },
                                                                  side15_0: NodeState,
                                                                  side15_1: NodeState
                                                                }
                                                              },
                                                              side14_0: NodeState,
                                                              side14_1: NodeState
                                                            }
                                                          },
                                                          side13_0: NodeState,
                                                          side13_1: NodeState
                                                        }
                                                      },
                                                      side12_0: NodeState,
                                                      side12_1: NodeState
                                                    }
                                                  },
                                                  side11_0: NodeState,
                                                  side11_1: NodeState
                                                }
                                              },
                                              side10_0: NodeState,
                                              side10_1: NodeState
                                            }
                                          },
                                          side9_0: NodeState,
                                          side9_1: NodeState
                                        }
                                      },
                                      side8_0: NodeState,
                                      side8_1: NodeState
                                    }
                                  },
                                  side7_0: NodeState,
                                  side7_1: NodeState
                                }
                              },
                              side6_0: NodeState,
                              side6_1: NodeState
                            }
                          },
                          side5_0: NodeState,
                          side5_1: NodeState
                        }
                      },
                      side4_0: NodeState,
                      side4_1: NodeState
                    }
                  },
                  side3_0: NodeState,
                  side3_1: NodeState
                }
              },
              side2_0: NodeState,
              side2_1: NodeState
            }
          },
          side1_0: NodeState,
          side1_1: NodeState
        }
      },
      side0_0: NodeState,
      side0_1: NodeState
    }
  }
})

export const machine = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: (): never => {
    throw new Error("type-performance fixture")
  }
})
