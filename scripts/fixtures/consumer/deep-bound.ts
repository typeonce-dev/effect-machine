import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Context, Effect, Layer, Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2 ? true
  : false
type Expect<Type extends true> = Type
class ExternalService extends Context.Service<ExternalService, string>()("consumer/ExternalService") {
}
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
const ChildStates = Machine.state({
  fields: {
    input: Schema.toType(Schema.Struct({ value: Schema.String }))
  },
  states: {
    Done: {
      schema: ChildState.cases.Done,
      type: "final",
      output: Schema.String
    }
  }
})
const ChildParentEvents = Machine.eventsFromSchemas(Internal.cases.ChildNotice)
const childMachine = Machine.make({
  root: ChildStates,
  events: Machine.eventsFromSchemas(),
  parent: Machine.parent(ChildParentEvents),
  input: Schema.Struct({ value: Schema.String })
}).handle({
  initial: {
    target: Machine.targets(ChildStates).root.Done,
    decoded: true,
    data: ({ root: { input: input } }) => ChildState.cases.Done.make({ value: input.value })
  },
  root: ({ input }) => ({ input }),
  states: {
    Done: {
      entry: ({ parent, state }, enqueue) => {
        enqueue.sendTo(parent, ChildParentEvents.ChildNotice({ value: state.value }))
      },
      output: ({ state }) => state.value
    }
  }
})
const Child = Machine.child("child", childMachine)
const States = Machine.state({
  states: {
    Idle: State.cases.Idle,
    Ready: {
      schema: State.cases.Ready,
      states: {
        Editor: {
          schema: State.cases.Editor,
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
  }
})
const Emissions = Machine.emittedEventsFromSchemas(Emitted.cases.Notice)
const targets = Machine.targets(States)
const definition = Machine.make({
  effects: { load: Effect.asVoid(ExternalService) },
  children: { child: Child },
  branches: {
    ready: { ready: { target: targets.root.Ready } },
    notice: { saved: { target: targets.root.Ready.Editor.Saving } }
  },
  root: States,
  events: Machine.eventsFromSchemas(Event.cases.Begin, Event.cases.Save, ChildParentEvents),
  internalEvents: Machine.internalEventsFromSchemas(Internal.cases.Loaded, Internal.cases.ChildCompleted),
  emittedEvents: Emissions,
  input: Schema.Struct({ seed: Schema.String })
})
const machine = definition.handle({
  initial: {
    target: Machine.targets(States).root.Idle,
    decoded: true,
    data: State.cases.Idle.make({})
  },
  states: {
    Idle: {
      invoke: { src: "load", id: "deep-inline-invoke", onDone: { none: true } },
      on: {
        Begin: {
          branches: "ready",
          resolve: ({ select: { ready: target } }) =>
            target.decoded(
              State.cases.Ready.make({}),
              (ready) =>
                ready.Editor.decoded(State.cases.Editor.make({}), (editor) =>
                  editor.Editing.decoded(State.cases.Editing.make({ value: "ready" })))
            )
        }
      }
    },
    Ready: {
      initial: {
        target: Machine.targets(States).root.Ready.Editor
      },
      states: {
        Editor: {
          initial: {
            target: Machine.targets(States).root.Ready.Editor.Editing,
            data: { value: "ready" }
          },
          states: {
            Editing: {
              on: {
                Save: {
                  target: targets.root.Ready.Editor.Saving,
                  decoded: true,
                  data: ({ event }) => State.cases.Saving.make({ value: event.value })
                },
                Loaded: { none: true }
              }
            },
            Saving: {
              invoke: { src: "child", input: ({ state }) => ({ value: state.value }), onDone: { none: true } },
              on: {
                ChildNotice: {
                  branches: "notice",
                  resolve: ({ event, select }, enqueue) => {
                    enqueue.emit(Emissions.Notice({ value: event.value }))
                    return select.saved.decoded(State.cases.Saving.make({ value: event.value }))
                  }
                },
                ChildCompleted: {
                  target: targets.root.Done,
                  decoded: true,
                  data: ({ event }) => State.cases.Done.make({ value: event.value })
                }
              }
            }
          }
        }
      }
    },
    Done: {
      output: ({ state }) => state.value
    }
  }
})
const PackagedDeepState = Schema.TaggedStruct("PackagedDeepState", {})
const PackagedDeepStates = Machine.state({
  states: {
    n0: {
      schema: PackagedDeepState,
      states: {
        n1: {
          schema: PackagedDeepState,
          states: {
            n2: {
              schema: PackagedDeepState,
              states: {
                n3: {
                  schema: PackagedDeepState,
                  states: {
                    n4: {
                      schema: PackagedDeepState,
                      states: {
                        n5: {
                          schema: PackagedDeepState,
                          states: {
                            n6: {
                              schema: PackagedDeepState,
                              states: {
                                n7: {
                                  schema: PackagedDeepState,
                                  states: {
                                    n8: {
                                      schema: PackagedDeepState,
                                      states: {
                                        n9: {
                                          schema: PackagedDeepState,
                                          states: {
                                            n10: {
                                              schema: PackagedDeepState,
                                              states: {
                                                n11: {
                                                  schema: PackagedDeepState,
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
  }
})
const packagedDeepMachine = Machine.make({
  root: PackagedDeepStates,
  events: Machine.eventsFromSchemas()
}).handle({
  initial: { target: Machine.targets(PackagedDeepStates).root.n0 },
  states: {
    n0: {
      initial: { target: Machine.targets(PackagedDeepStates).root.n0.n1 },
      states: {
        n1: {
          initial: { target: Machine.targets(PackagedDeepStates).root.n0.n1.n2 },
          states: {
            n2: {
              initial: { target: Machine.targets(PackagedDeepStates).root.n0.n1.n2.n3 },
              states: {
                n3: {
                  initial: { target: Machine.targets(PackagedDeepStates).root.n0.n1.n2.n3.n4 },
                  states: {
                    n4: {
                      initial: { target: Machine.targets(PackagedDeepStates).root.n0.n1.n2.n3.n4.n5 },
                      states: {
                        n5: {
                          initial: { target: Machine.targets(PackagedDeepStates).root.n0.n1.n2.n3.n4.n5.n6 },
                          states: {
                            n6: {
                              initial: { target: Machine.targets(PackagedDeepStates).root.n0.n1.n2.n3.n4.n5.n6.n7 },
                              states: {
                                n7: {
                                  initial: {
                                    target: Machine.targets(PackagedDeepStates).root.n0.n1.n2.n3.n4.n5.n6.n7.n8
                                  },
                                  states: {
                                    n8: {
                                      initial: {
                                        target: Machine.targets(PackagedDeepStates).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9
                                      },
                                      states: {
                                        n9: {
                                          initial: {
                                            target:
                                              Machine.targets(PackagedDeepStates).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9.n10
                                          },
                                          states: {
                                            n10: {
                                              initial: {
                                                target:
                                                  Machine.targets(PackagedDeepStates).root.n0.n1.n2.n3.n4.n5.n6.n7.n8.n9
                                                    .n10.n11
                                              },
                                              states: {
                                                n11: {
                                                  initial: {
                                                    target:
                                                      Machine.targets(PackagedDeepStates).root.n0.n1.n2.n3.n4.n5.n6.n7
                                                        .n8.n9.n10.n11
                                                        .n12
                                                  },
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
  }
})
type PackagedDeepErrorIsExact = Expect<Equal<Machine.Machine.Error<typeof packagedDeepMachine>, never>>
type PackagedDeepServicesAreExact = Expect<Equal<Machine.Machine.Services<typeof packagedDeepMachine>, never>>
type PackagedDeepUnhandledIsExact = Expect<Equal<Machine.Machine.UnhandledStates<typeof packagedDeepMachine>, never>>
void Machine.planInitial(packagedDeepMachine)
const runtime = Atom.runtime(
  Layer.mergeAll(Layer.succeed(ExternalService, "provided"), Layer.effectDiscard(Effect.fail(new RuntimeFailure())))
)
const Bound = AtomMachine.bind(runtime)
const machineAtom = Bound.make(machine, { seed: "initial" })
type Snapshot = Machine.Snapshot<typeof States>
type StateSuccess = Atom.Success<typeof machineAtom.result>
type SendEvent = typeof machineAtom.send extends Atom.Writable<any, infer InputEvent> ? InputEvent : never
type Output = typeof machineAtom extends AtomMachine.MachineAtom<any, any, any, infer Value, any, any> ? Value : never
type Failure = Atom.Failure<typeof machineAtom.result>
type StateIsExact = Expect<Equal<StateSuccess, Snapshot>>
type EventsArePublicOnly = Expect<
  Equal<SendEvent, Machine.Machine.EventInput<Machine.Machine.InputEvent<typeof machine>>>
>
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
