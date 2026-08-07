import { Machine } from "@typeonce/effect-machine"
import { Context, Data, Effect } from "effect"
import { machine } from "./handle-depth-16-control.js"

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2) ?
  true :
  false
type Expect<Value extends true> = Value

class DeepService extends Context.Service<DeepService, string>()("perf/depth-16/DeepService") {}
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
                                                                    entry: () =>
                                                                      Effect.flatMap(
                                                                        DeepService,
                                                                        () => Effect.fail(new DeepFailure())
                                                                      ),
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
})

type ErrorIsExact = Expect<Equal<Machine.Machine.Error<typeof handled>, DeepFailure>>
type ServicesAreExact = Expect<Equal<Machine.Machine.Services<typeof handled>, DeepService>>
type EveryStateIsHandled = Expect<Equal<Machine.Machine.UnhandledStates<typeof handled>, never>>

void Machine.planInitial(handled)
export type { ErrorIsExact, EveryStateIsHandled, ServicesAreExact }
