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
                                    type: "final",
                                    output: Schema.String
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
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
  states: States.states,
  events: [],
  initial: (): never => {
    throw new Error("type-performance fixture")
  }
})
