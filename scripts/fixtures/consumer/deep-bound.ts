import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Context, Effect, Layer, Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2 ? true
  : false
type Expect<Type extends true> = Type

class ExternalService extends Context.Service<ExternalService, string>()("consumer/ExternalService") {}
class RuntimeFailure {
  readonly _tag = "RuntimeFailure"
}

const State = Schema.TaggedUnion({
  Idle: {},
  Ready: {},
  Editor: {},
  Editing: { value: Schema.String },
  Saving: { value: Schema.String },
  Done: { value: Schema.String }
})
const Event = Schema.TaggedUnion({
  Begin: {},
  Save: { value: Schema.String }
})
const Internal = Schema.TaggedUnion({
  Loaded: { value: Schema.String },
  ChildCompleted: { value: Schema.String },
  ChildNotice: { value: Schema.String }
})
const Emitted = Schema.TaggedUnion({
  Notice: { value: Schema.String }
})
const ChildState = Schema.TaggedUnion({
  Done: { value: Schema.String }
})

const ChildStates = Machine.defineStates({
  Done: {
    schema: ChildState.cases.Done,
    type: "final",
    output: Schema.String
  }
})
const childMachine = Machine.make({
  states: ChildStates.states,
  events: [],
  emits: [Internal.cases.ChildNotice],
  input: Schema.Struct({ value: Schema.String }),
  initial: ({ value }) => ChildStates.initial.Done(ChildState.cases.Done.make({ value }))
}).handle({
  Done: {
    entry: ({ state }, enqueue) => {
      enqueue.emit(Internal.cases.ChildNotice.make({ value: state.value }))
    },
    output: ({ state }) => state.value
  }
})
const Child = Machine.child("child", childMachine)

const States = Machine.defineStates({
  Idle: State.cases.Idle,
  Ready: {
    schema: State.cases.Ready,
    initial: "Editor",
    states: {
      Editor: {
        schema: State.cases.Editor,
        initial: "Editing",
        states: {
          Editing: State.cases.Editing,
          Saving: State.cases.Saving
        }
      }
    }
  },
  Done: {
    schema: State.cases.Done,
    type: "final",
    output: Schema.String
  }
})

const machine = Machine.make({
  states: States.states,
  events: [Event.cases.Begin, Event.cases.Save],
  internalEvents: [Internal.cases.Loaded, Internal.cases.ChildCompleted, ...childMachine.emits],
  emits: [Emitted.cases.Notice],
  input: Schema.Struct({ seed: Schema.String }),
  initial: ({ seed: _seed }) => States.initial.Idle(State.cases.Idle.make({}))
}).handle({
  Idle: {
    invoke: Machine.invoke({
      id: "deep-inline-invoke",
      src: () => Machine.effect(Effect.as(ExternalService, Internal.cases.Loaded.make({ value: "loaded" })))
    }),
    on: {
      Begin: ({ target }) =>
        target.full.Ready(
          State.cases.Ready.make({}),
          (ready) =>
            ready.Editor(State.cases.Editor.make({}), (editor) =>
              editor.Editing(State.cases.Editing.make({ value: "ready" })))
        )
    }
  },
  Ready: {
    states: {
      Editor: {
        states: {
          Editing: {
            on: {
              Save: ({ event, target }) => target.local.Saving(State.cases.Saving.make({ value: event.value })),
              Loaded: () => undefined
            }
          },
          Saving: {
            invoke: ({ state }) =>
              Machine.invokeMachine({
                child: Child,
                input: { value: state.value },
                onDone: ({ output }) => Internal.cases.ChildCompleted.make({ value: output })
              }),
            on: {
              ChildNotice: ({ event, target }, enqueue) => {
                enqueue.emit(Emitted.cases.Notice.make({ value: event.value }))
                return target.local.Saving(State.cases.Saving.make({ value: event.value }))
              },
              ChildCompleted: ({ event, target }) => target.full.Done(State.cases.Done.make({ value: event.value }))
            }
          }
        }
      }
    }
  },
  Done: {
    output: ({ state }) => state.value
  }
})

const PackagedDeepState = Schema.TaggedStruct("PackagedDeepState", {})
const PackagedDeepStates = Machine.defineStates({
  n0: {
    schema: PackagedDeepState,
    initial: "n1",
    states: {
      n1: {
        schema: PackagedDeepState,
        initial: "n2",
        states: {
          n2: {
            schema: PackagedDeepState,
            initial: "n3",
            states: {
              n3: {
                schema: PackagedDeepState,
                initial: "n4",
                states: {
                  n4: {
                    schema: PackagedDeepState,
                    initial: "n5",
                    states: {
                      n5: {
                        schema: PackagedDeepState,
                        initial: "n6",
                        states: {
                          n6: {
                            schema: PackagedDeepState,
                            initial: "n7",
                            states: {
                              n7: {
                                schema: PackagedDeepState,
                                initial: "n8",
                                states: {
                                  n8: {
                                    schema: PackagedDeepState,
                                    initial: "n9",
                                    states: {
                                      n9: {
                                        schema: PackagedDeepState,
                                        initial: "n10",
                                        states: {
                                          n10: {
                                            schema: PackagedDeepState,
                                            initial: "n11",
                                            states: {
                                              n11: {
                                                schema: PackagedDeepState,
                                                initial: "n12",
                                                states: {
                                                  n12: {
                                                    schema: PackagedDeepState,
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
                }
              }
            }
          }
        }
      }
    }
  }
})
const packagedDeepMachine = Machine.make({
  states: PackagedDeepStates.states,
  events: [],
  initial: (): never => {
    throw new Error("type-only packaged consumer fixture")
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
                                                    entry: () => {},
                                                    output: () => "packaged"
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
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
type PackagedDeepErrorIsExact = Expect<Equal<Machine.Machine.Error<typeof packagedDeepMachine>, never>>
type PackagedDeepServicesAreExact = Expect<Equal<Machine.Machine.Services<typeof packagedDeepMachine>, never>>
type PackagedDeepUnhandledIsExact = Expect<
  Equal<Machine.Machine.UnhandledStates<typeof packagedDeepMachine>, never>
>
void Machine.planInitial(packagedDeepMachine)

const runtime = Atom.runtime(
  Layer.mergeAll(
    Layer.succeed(ExternalService, "provided"),
    Layer.effectDiscard(Effect.fail(new RuntimeFailure()))
  )
)
const Bound = AtomMachine.bind(runtime)
const machineAtom = Bound.make(machine, { seed: "initial" })

type Snapshot = Machine.Machine.Snapshot<typeof States.states>
type StateSuccess = Atom.Success<typeof machineAtom.state>
type SendEvent = typeof machineAtom.send extends Atom.Writable<any, infer InputEvent> ? InputEvent : never
type Output = typeof machineAtom extends AtomMachine.MachineAtom<any, any, any, infer Value, any> ? Value : never
type Failure = Atom.Failure<typeof machineAtom.result>

type StateIsExact = Expect<Equal<StateSuccess, Snapshot>>
type EventsArePublicOnly = Expect<Equal<SendEvent, Machine.Machine.EventInput<typeof Event.Type>>>
type OutputIsExact = Expect<Equal<Output, string>>
type RuntimeErrorIsPreserved = Expect<Equal<Extract<Failure, RuntimeFailure>, RuntimeFailure>>
type FailureIsNotUnknown = Expect<Equal<unknown extends Failure ? true : false, false>>
type MachineServicesAreNotAny = Expect<
  Equal<0 extends 1 & Machine.Machine.Services<typeof machine> ? true : false, false>
>

// @ts-expect-error Input is required.
Bound.make(machine)
// @ts-expect-error Input retains its exact decoded type.
Bound.make(machine, { seed: 1 })
// @ts-expect-error The bound runtime must provide every external service.
AtomMachine.bind(Atom.runtime(Layer.empty)).make(machine, { seed: "initial" })
const erased: Machine.Machine.Any = machine
// @ts-expect-error Machine.Any erasure cannot manufacture concrete protocol or output proof.
Bound.make(erased, { seed: "initial" })

void machineAtom
export type {
  EventsArePublicOnly,
  FailureIsNotUnknown,
  MachineServicesAreNotAny,
  OutputIsExact,
  PackagedDeepErrorIsExact,
  PackagedDeepServicesAreExact,
  PackagedDeepUnhandledIsExact,
  RuntimeErrorIsPreserved,
  StateIsExact
}
