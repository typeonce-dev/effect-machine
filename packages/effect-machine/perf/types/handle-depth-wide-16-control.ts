import { Schema } from "effect"
import { Machine } from "../../dist/index.js"

export const NodeState = Schema.TaggedStruct("Node", {})

export const States = Machine.state({
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
                                                    n12: {
                                                      schema: NodeState,
                                                      states: {
                                                        n13: {
                                                          schema: NodeState,
                                                          states: {
                                                            n14: {
                                                              schema: NodeState,
                                                              states: {
                                                                n15: {
                                                                  schema: NodeState,
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
  }
})

export const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas()
})
