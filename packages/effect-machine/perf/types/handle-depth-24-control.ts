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
                                                                      states: {
                                                                        n17: {
                                                                          schema: NodeState,
                                                                          states: {
                                                                            n18: {
                                                                              schema: NodeState,
                                                                              states: {
                                                                                n19: {
                                                                                  schema: NodeState,
                                                                                  states: {
                                                                                    n20: {
                                                                                      schema: NodeState,
                                                                                      states: {
                                                                                        n21: {
                                                                                          schema: NodeState,
                                                                                          states: {
                                                                                            n22: {
                                                                                              schema: NodeState,
                                                                                              states: {
                                                                                                n23: {
                                                                                                  schema: NodeState,
                                                                                                  states: {
                                                                                                    n24: {
                                                                                                      schema: NodeState,
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
  }
})

export const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas()
})
