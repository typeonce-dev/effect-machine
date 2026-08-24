import { Context, Data, Effect } from "effect"
import { Machine } from "../../dist/index.js"
import { machine } from "./handle-depth-24-control.js"

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2) ?
  true :
  false
type Expect<Value extends true> = Value

class DeepService extends Context.Service<DeepService, string>()("perf/depth-24/DeepService") {}
class DeepFailure extends Data.TaggedError("DeepFailure")<{}> {}

const handled = machine.handle({
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
                                                                                                    entry: () => {},
                                                                                                    output: () => "done"
                                                                                                  }
                                                                                                }
                                                                                              }
                                                                                            }
                                                                                          }
                                                                                        }
                                                                                      }
                                                                                    }
                                                                                  }
                                                                                }
                                                                              }
                                                                            }
                                                                          }
                                                                        }
                                                                      }
                                                                    }
                                                                  }
                                                                }
                                                              }
                                                            }
                                                          }
                                                        }
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
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
