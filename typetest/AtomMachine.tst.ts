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
