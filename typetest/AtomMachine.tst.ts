import { Context, Effect, Layer, type Option, Schema } from "effect"
import { Machine } from "../src/index.js"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { AtomMachine } from "../src/reactivity.js"
import { describe, expect, it } from "tstyche"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}

class Tick extends Schema.TaggedClass<Tick>("Tick")("Tick", {}) {}

class InternalTick extends Schema.TaggedClass<InternalTick>("InternalTick")("InternalTick", {}) {}

class Done extends Schema.TaggedClass<Done>("Done")("Done", {
  value: Schema.String
}) {}

class Dormant extends Schema.TaggedClass<Dormant>("Dormant")("Dormant", {}) {}

class Ready extends Schema.TaggedClass<Ready>("Ready")("Ready", {}) {}

class Editor extends Schema.TaggedClass<Editor>("Editor")("Editor", {}) {}

class Editing extends Schema.TaggedClass<Editing>("Editing")("Editing", {}) {}

class Saving extends Schema.TaggedClass<Saving>("Saving")("Saving", {}) {}

class Network extends Schema.TaggedClass<Network>("Network")("Network", {}) {}

class Online extends Schema.TaggedClass<Online>("Online")("Online", {}) {}

class Offline extends Schema.TaggedClass<Offline>("Offline")("Offline", {}) {}

class Multiplier extends Context.Service<Multiplier, number>()("test/AtomMachine/Multiplier") {}

class DeepService extends Context.Service<DeepService, string>()("test/AtomMachine/DeepService") {}

class DeepInitialService extends Context.Service<DeepInitialService, string>()(
  "test/AtomMachine/DeepInitialService"
) {}

class DeepInitialFailure {
  readonly _tag = "DeepInitialFailure"
}

class DeepTransitionFailure {
  readonly _tag = "DeepTransitionFailure"
}

class DeepActionFailure {
  readonly _tag = "DeepActionFailure"
}

class DeepRuntimeFailure {
  readonly _tag = "DeepRuntimeFailure"
}

interface StartFailure {
  readonly _tag: "StartFailure"
}

interface RuntimeFailure {
  readonly _tag: "RuntimeFailure"
}

const States = Machine.defineStates({ Idle })

const NestedStates = Machine.defineStates({
  Dormant,
  Ready: {
    schema: Ready,
    type: "parallel",
    states: {
      editor: {
        schema: Editor,
        initial: "Editing",
        states: {
          Editing,
          Saving
        }
      },
      network: {
        schema: Network,
        initial: "Online",
        states: {
          Online,
          Offline
        }
      }
    }
  }
})

const makeMachine = () =>
  Machine.make({
    states: States.states,
    events: [Tick],
    initial: () => States.initial.Idle(new Idle({}))
  }).handle({
    Idle: {}
  })

describe("AtomMachine", () => {
  it("derives invoked child protocols from the child descriptor", () => {
    const childMachine = makeMachine()
    const Child = Machine.child("child", childMachine)
    const parentMachine = Machine.make({
      states: States.states,
      events: [],
      initial: () => States.initial.Idle(new Idle({}))
    }).handle({
      Idle: {
        invoke: Machine.invokeMachine({ child: Child })
      }
    })
    const child = AtomMachine.make(parentMachine).child(Child)

    expect<Atom.Success<typeof child.ref>>().type.toBe<Option.Option<Machine.ChildMachine.Ref<typeof Child>>>()
    expect<typeof child.send extends Atom.Writable<any, infer Event> ? Event : never>().type.toBe<Tick>()
  })

  it("derives fail-aware results, selectors, and child bridge types", () => {
    const childMachine = makeMachine()
    const Child = Machine.child("child", childMachine)
    type Snapshot = Machine.Machine.Snapshot<typeof States.states>
    type Parent = AtomMachine.MachineAtom<Snapshot, Tick, RuntimeFailure, never, StartFailure>
    const parent = null as unknown as Parent
    const child = null as unknown as AtomMachine.ChildOf<Parent, typeof Child>
    const selected = AtomMachine.select(parent, "Idle")
    const matched = AtomMachine.matches(parent, "Idle")
    const childSelected = AtomMachine.selectChild(child, "Idle")
    const childMatched = AtomMachine.matchesChild(child, "Idle")

    expect<typeof parent.result>().type.toBe<
      Atom.Atom<AsyncResult.AsyncResult<Snapshot, StartFailure | RuntimeFailure>>
    >()
    expect<typeof selected>().type.toBe<
      Atom.Atom<AsyncResult.AsyncResult<Option.Option<Idle>, StartFailure | RuntimeFailure>>
    >()
    expect<typeof matched>().type.toBe<
      Atom.Atom<AsyncResult.AsyncResult<boolean, StartFailure | RuntimeFailure>>
    >()
    expect<Atom.Success<typeof childSelected>>().type.toBe<Option.Option<Idle>>()
    expect<Atom.Success<typeof childMatched>>().type.toBe<boolean>()
    expect<Atom.Failure<typeof childSelected>>().type.toBe<Atom.Failure<typeof child.result>>()
    expect<Atom.Failure<typeof childMatched>>().type.toBe<Atom.Failure<typeof child.result>>()
    expect<Extract<Atom.Failure<typeof child.result>, StartFailure>>().type.toBe<StartFailure>()
    expect<AtomMachine.ChildMachineAtom<typeof Child>>().type.toBe<
      AtomMachine.ChildMachineAtom<typeof Child, unknown>
    >()
    expect(AtomMachine.select).type.not.toBeCallableWith(parent, "Missing")
    expect(AtomMachine.matches).type.not.toBeCallableWith(parent, "Missing")
    expect(AtomMachine.selectChild).type.not.toBeCallableWith(child, "Missing")
    expect(AtomMachine.matchesChild).type.not.toBeCallableWith(child, "Missing")
    expect(AtomMachine.select).type.not.toBeCallableWith(parent, States, "Idle")
    expect(AtomMachine.matches).type.not.toBeCallableWith(parent, States, "Idle")
    expect(AtomMachine.selectChild).type.not.toBeCallableWith(child, States, "Idle")
    expect(AtomMachine.matchesChild).type.not.toBeCallableWith(child, States, "Idle")
  })

  it("infers exact compound and parallel paths from bridge snapshots", () => {
    type Snapshot = Machine.Machine.Snapshot<typeof NestedStates.states>
    type Parent = AtomMachine.MachineAtom<Snapshot, Tick, RuntimeFailure, never, StartFailure>
    const parent = null as unknown as Parent
    const root = AtomMachine.select(parent, "Ready")
    const region = AtomMachine.select(parent, "Ready.editor")
    const leaf = AtomMachine.select(parent, "Ready.editor.Editing")
    const matched = AtomMachine.matches(parent, "Ready.network.Online")
    const path = null as unknown as "Dormant" | "Ready.editor.Editing"
    const selectedUnion = AtomMachine.select(parent, path)
    const widenedPath: string = "Ready"

    expect<Atom.Success<typeof root>>().type.toBe<Option.Option<Ready>>()
    expect<Atom.Success<typeof region>>().type.toBe<Option.Option<Editor>>()
    expect<Atom.Success<typeof leaf>>().type.toBe<Option.Option<Editing>>()
    expect<Atom.Success<typeof matched>>().type.toBe<boolean>()
    expect<Atom.Success<typeof selectedUnion>>().type.toBe<Option.Option<Dormant | Editing>>()
    expect<Atom.Failure<typeof leaf>>().type.toBe<StartFailure | RuntimeFailure>()
    expect(AtomMachine.select).type.not.toBeCallableWith(parent, "Ready.editor.Missing")
    expect(AtomMachine.matches).type.not.toBeCallableWith(parent, "Ready.network.Missing")
    expect(AtomMachine.select).type.not.toBeCallableWith(parent, widenedPath)

    type NestedMachine = Machine.Machine<typeof NestedStates.states, readonly [typeof Tick]>
    const NestedChild = Machine.child("nested", null as unknown as NestedMachine)
    const child = null as unknown as AtomMachine.ChildOf<Parent, typeof NestedChild>
    const childSelected = AtomMachine.selectChild(child, "Ready.editor.Saving")
    const childMatched = AtomMachine.matchesChild(child, "Ready.network.Offline")

    expect<Atom.Success<typeof childSelected>>().type.toBe<Option.Option<Saving>>()
    expect<Atom.Success<typeof childMatched>>().type.toBe<boolean>()
    expect<Atom.Failure<typeof childSelected>>().type.toBe<Atom.Failure<typeof child.result>>()
    expect<Atom.Failure<typeof childMatched>>().type.toBe<Atom.Failure<typeof child.result>>()
    expect(AtomMachine.selectChild).type.not.toBeCallableWith(child, "Idle")
    expect(AtomMachine.matchesChild).type.not.toBeCallableWith(child, "Ready.editor.Missing")
  })

  it("accepts machines without external requirements", () => {
    expect(AtomMachine.make).type.toBeCallableWith(makeMachine())
  })

  it("accepts compatible machine runtime requirements", () => {
    const machine = Machine.make({
      states: States.states,
      events: [Tick],
      initial: Effect.fn(function*() {
        const runtime = yield* Machine.runtime<{ readonly events: Tick }>()
        yield* runtime.raise(new Tick({}))
        return States.initial.Idle(new Idle({}))
      })
    }).handle({
      Idle: {}
    })

    expect(AtomMachine.make).type.toBeCallableWith(machine)
  })

  it("requires an AtomRuntime for external requirements", () => {
    const machine = Machine.make({
      states: States.states,
      events: [Tick],
      initial: () => States.initial.Idle(new Idle({}))
    }).handle({
      Idle: {
        on: {
          Tick: Effect.fn(function*() {
            yield* Multiplier
            return States.initial.Idle(new Idle({}))
          })
        }
      }
    })
    const runtime = Atom.runtime(Layer.succeed(Multiplier, 2))

    expect(AtomMachine.make).type.not.toBeCallableWith(machine)
    expect(AtomMachine.make).type.not.toBeCallableWith(runtime, machine)
    const bound = AtomMachine.bind(runtime)
    const unprovided = AtomMachine.bind(Atom.runtime(Layer.empty))
    expect(bound.make).type.toBeCallableWith(machine)
    expect(unprovided.make).type.not.toBeCallableWith(machine)
  })

  it("preserves every channel for deeply composed bound machines", () => {
    const DeepState = Schema.TaggedUnion({
      Idle: {},
      Ready: {},
      Editor: {},
      Editing: { value: Schema.String },
      Saving: { value: Schema.String },
      Done: { value: Schema.String }
    })
    const DeepEvent = Schema.TaggedUnion({
      Begin: {},
      Save: { value: Schema.String }
    })
    const DeepInternalEvent = Schema.TaggedUnion({
      Loaded: { value: Schema.String },
      ChildCompleted: { value: Schema.String },
      ChildNotice: { value: Schema.String }
    })
    const DeepEmit = Schema.TaggedUnion({
      ParentNotice: { value: Schema.String }
    })
    const ChildState = Schema.TaggedUnion({
      Done: { value: Schema.String }
    })
    const ChildEvent = Schema.TaggedUnion({
      Refresh: {}
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
      events: [ChildEvent.cases.Refresh],
      emits: [DeepInternalEvent.cases.ChildNotice],
      input: Schema.Struct({ value: Schema.String }),
      initial: ({ value }) => ChildStates.initial.Done(ChildState.cases.Done.make({ value }))
    }).handle({
      Done: {
        entry: ({ state }) =>
          Machine.action(
            Effect.gen(function*() {
              const runtime = yield* Machine.runtime<{
                readonly emits: typeof DeepInternalEvent.cases.ChildNotice.Type
              }>()
              yield* runtime.sendParent(DeepInternalEvent.cases.ChildNotice.make({ value: state.value }))
            })
          ),
        output: ({ state }) => state.value
      }
    })
    const Child = Machine.child("deep-child", childMachine)
    const DeepStates = Machine.defineStates({
      Idle: DeepState.cases.Idle,
      Ready: {
        schema: DeepState.cases.Ready,
        initial: "Editor",
        states: {
          Editor: {
            schema: DeepState.cases.Editor,
            initial: "Editing",
            states: {
              Editing: DeepState.cases.Editing,
              Saving: DeepState.cases.Saving
            }
          }
        }
      },
      Done: {
        schema: DeepState.cases.Done,
        type: "final",
        output: Schema.String
      }
    })
    const deepMachine = Machine.make({
      states: DeepStates.states,
      events: [DeepEvent.cases.Begin, DeepEvent.cases.Save],
      internalEvents: [
        DeepInternalEvent.cases.Loaded,
        DeepInternalEvent.cases.ChildCompleted,
        ...childMachine.emits
      ],
      emits: [DeepEmit.cases.ParentNotice],
      input: Schema.Struct({ seed: Schema.String }),
      initial: ({ seed }) =>
        Effect.gen(function*() {
          yield* DeepInitialService
          if (seed.length < 0) {
            return yield* Effect.fail(new DeepInitialFailure())
          }
          return DeepStates.initial.Idle(DeepState.cases.Idle.make({}))
        })
    }).handle({
      Idle: {
        invoke: Machine.invoke({
          id: "deep-inline-invoke",
          src: () =>
            Machine.effect(
              Effect.as(
                DeepService,
                DeepInternalEvent.cases.Loaded.make({ value: "loaded" })
              )
            )
        }),
        on: {
          Begin: ({ target }) =>
            target.full.Ready(DeepState.cases.Ready.make({}), (ready) =>
              ready.Editor(DeepState.cases.Editor.make({}), (editor) =>
                editor.Editing(DeepState.cases.Editing.make({ value: "ready" }))
              )
            )
        }
      },
      Ready: {
        states: {
          Editor: {
            states: {
              Editing: {
                on: {
                  Save: ({ event, target }) =>
                    Machine.action(
                      Effect.gen(function*() {
                        yield* DeepService
                        return yield* Effect.fail(new DeepActionFailure())
                      }),
                      target.local.Saving(DeepState.cases.Saving.make({ value: event.value }))
                    ),
                  Loaded: () => Effect.fail(new DeepTransitionFailure())
                }
              },
              Saving: {
                invoke: ({ state }) =>
                  Machine.invokeMachine({
                    child: Child,
                    input: { value: state.value },
                    onDone: ({ output }) => DeepInternalEvent.cases.ChildCompleted.make({ value: output })
                  }),
                on: {
                  ChildNotice: ({ event, target }) =>
                    Machine.action(
                      Effect.gen(function*() {
                        const runtime = yield* Machine.runtime<{
                          readonly emits: typeof DeepEmit.cases.ParentNotice.Type
                        }>()
                        yield* runtime.sendParent(DeepEmit.cases.ParentNotice.make({ value: event.value }))
                      }),
                      target.local.Saving(DeepState.cases.Saving.make({ value: event.value }))
                    ),
                  ChildCompleted: ({ event, target }) =>
                    target.full.Done(DeepState.cases.Done.make({ value: event.value }))
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
    const runtime = Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(DeepService, "provided"),
        Layer.succeed(DeepInitialService, "provided"),
        Layer.effectDiscard(Effect.fail(new DeepRuntimeFailure()))
      )
    )
    const bound = AtomMachine.bind(runtime)
    const bridge = bound.make(deepMachine, { seed: "initial" })
    const unprovided = AtomMachine.bind(Atom.runtime(Layer.empty))
    const erased: Machine.Machine.Any = deepMachine
    type ResultFailure = Atom.Failure<typeof bridge.result>
    type BridgeOutput = typeof bridge extends AtomMachine.MachineAtom<any, any, any, infer Output, any> ? Output
      : never
    type SendEvent = typeof bridge.send extends Atom.Writable<any, infer Event> ? Event : never

    expect<Atom.Success<typeof bridge.state>>().type.toBe<Machine.Machine.Snapshot<typeof DeepStates.states>>()
    expect<SendEvent>().type.toBe<typeof DeepEvent.Type>()
    expect<BridgeOutput>().type.toBe<string>()
    expect<Extract<ResultFailure, DeepInitialFailure>>().type.toBe<DeepInitialFailure>()
    expect<Extract<ResultFailure, DeepTransitionFailure>>().type.toBe<DeepTransitionFailure>()
    expect<Extract<ResultFailure, DeepActionFailure>>().type.toBe<DeepActionFailure>()
    expect<Extract<ResultFailure, DeepRuntimeFailure>>().type.toBe<DeepRuntimeFailure>()
    expect<unknown extends ResultFailure ? true : false>().type.toBe<false>()
    expect<0 extends 1 & Machine.Machine.Services<typeof deepMachine> ? true : false>().type.toBe<false>()
    expect(bound.make).type.toBeCallableWith(deepMachine, { seed: "initial" })
    expect(bound.make).type.not.toBeCallableWith(deepMachine)
    expect(bound.make).type.not.toBeCallableWith(deepMachine, { seed: 1 })
    expect(unprovided.make).type.not.toBeCallableWith(deepMachine, { seed: "initial" })
    expect(bound.make).type.not.toBeCallableWith(erased, { seed: "initial" })
  })

  it("preserves bound runtime errors in the result failure channel", () => {
    const runtime = Atom.runtime(
      Layer.effectDiscard(Effect.fail({ _tag: "StartFailure" } as const satisfies StartFailure))
    )
    const bridge = AtomMachine.bind(runtime).make(makeMachine())
    type Failure = Atom.Failure<typeof bridge.result>

    expect<Extract<Failure, StartFailure>>().type.toBe<StartFailure>()
    expect<unknown extends Failure ? true : false>().type.toBe<false>()
  })

  it("separates startup failures from the running ref failure channel", () => {
    const machine = Machine.make({
      states: States.states,
      events: [Tick],
      initial: () =>
        Effect.succeed(States.initial.Idle(new Idle({}))) as Effect.Effect<
          Machine.Machine.Snapshot<typeof States.states>,
          "initial-failed"
        >
    }).handle({
      Idle: {
        on: {
          Tick: () => Effect.fail("runtime-failed" as const)
        }
      }
    })
    const bridge = AtomMachine.make(machine)
    type Ref = Atom.Success<typeof bridge.ref>
    type RefError = Effect.Error<Ref["join"]>
    type StartError = Atom.Failure<typeof bridge.ref>

    expect<RefError>().type.toBe<
      | "runtime-failed"
      | Machine.InfiniteTransitionError
      | Machine.MachineSchemaDecodeError
      | Machine.StoppedError
    >()
    expect<"initial-failed">().type.not.toBeAssignableTo<RefError>()
    expect<Machine.StartupError>().type.not.toBeAssignableTo<RefError>()
    expect<"initial-failed">().type.toBeAssignableTo<StartError>()
    expect<Machine.StartupError>().type.toBeAssignableTo<StartError>()
    expect<"runtime-failed">().type.toBeAssignableTo<Atom.Failure<typeof bridge.result>>()
  })

  it("only exposes public input events through atom send boundaries", () => {
    const machine = Machine.make({
      states: States.states,
      events: [Tick],
      internalEvents: [InternalTick],
      initial: () => States.initial.Idle(new Idle({}))
    }).handle({
      Idle: {
        on: {
          Tick: () => States.initial.Idle(new Idle({})),
          InternalTick: () => States.initial.Idle(new Idle({}))
        }
      }
    })
    const bridge = AtomMachine.make(machine)

    expect<typeof bridge.send extends Atom.Writable<any, infer Event> ? Event : never>().type.toBe<Tick>()
  })

  it("requires output implementations and preserves exact terminal output", () => {
    const OutputStates = Machine.defineStates({
      Idle,
      Done: {
        schema: Done,
        type: "final",
        output: Schema.String
      }
    })
    const incomplete = Machine.make({
      states: OutputStates.states,
      events: [Tick],
      initial: () => OutputStates.initial.Idle(new Idle({}))
    })
    const runtime = Atom.runtime(Layer.empty)
    const bound = AtomMachine.bind(runtime)

    expect(AtomMachine.make).type.not.toBeCallableWith(incomplete)
    expect(AtomMachine.make).type.not.toBeCallableWith(runtime, incomplete)
    expect(bound.make).type.not.toBeCallableWith(incomplete)

    const complete = incomplete.handle({
      Done: {
        output: ({ state }) => state.value
      }
    })
    const bridge = AtomMachine.make(complete)
    type Output = typeof bridge extends AtomMachine.MachineAtom<any, any, any, infer Output, any> ? Output : never

    expect<Output>().type.toBe<string>()
    expect(AtomMachine.make).type.toBeCallableWith(complete)
    expect(AtomMachine.make).type.not.toBeCallableWith(runtime, complete)
    expect(bound.make).type.toBeCallableWith(complete)
  })

  it("rejects unknown and any requirements without an AtomRuntime", () => {
    const unknownRequirement = Effect.void as Effect.Effect<void, never, unknown>
    const anyRequirement = Effect.void as Effect.Effect<void, never, any>
    const unknownMachine = Machine.make({
      states: States.states,
      events: [Tick],
      initial: () => unknownRequirement.pipe(Effect.as(States.initial.Idle(new Idle({}))))
    }).handle({
      Idle: {}
    })
    const anyMachine = Machine.make({
      states: States.states,
      events: [Tick],
      initial: () => anyRequirement.pipe(Effect.as(States.initial.Idle(new Idle({}))))
    }).handle({
      Idle: {}
    })

    expect(AtomMachine.make).type.not.toBeCallableWith(unknownMachine)
    expect(AtomMachine.make).type.not.toBeCallableWith(anyMachine)
  })
})
