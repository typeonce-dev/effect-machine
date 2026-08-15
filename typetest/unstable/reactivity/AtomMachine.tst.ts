import { Context, Effect, Layer, type Option, Schema } from "effect"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../../src/index.js"
import { AtomMachine } from "../../../src/unstable/reactivity/index.js"

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

const StructuralNestedStates = Machine.defineStates({
  Ready: {
    type: "parallel",
    states: {
      editor: {
        initial: "Idle",
        states: {
          Idle: {},
          Saving
        }
      },
      network: {}
    }
  }
})

const makeMachine = () =>
  Machine.make({
    states: States.states,
    events: Machine.events(Tick),
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
      events: Machine.events(),
      initial: () => States.initial.Idle(new Idle({}))
    }).handle({
      Idle: {
        invoke: Machine.invoke({ child: Child })
      }
    })
    const child = AtomMachine.make(parentMachine).child(Child)

    expect<Atom.Success<typeof child.ref>>().type.toBe<Option.Option<Machine.ChildMachine.Ref<typeof Child>>>()
    expect<typeof child.send extends Atom.Writable<any, infer Event> ? Event : never>().type.toBe<
      Machine.Machine.EventInput<Tick>
    >()
  })

  it("derives fail-aware results, selectors, and child bridge types", () => {
    const childMachine = makeMachine()
    const Child = Machine.child("child", childMachine)
    type Snapshot = Machine.Machine.Snapshot<typeof States.states>
    type Parent = AtomMachine.MachineAtom<Snapshot, Tick, RuntimeFailure, never, StartFailure>
    const parent = null as unknown as Parent
    const child = null as unknown as AtomMachine.ChildOf<Parent, typeof Child>
    const selected = AtomMachine.select(parent, "Idle")
    const selectedSnapshot = AtomMachine.selectSnapshot(parent, "Idle")
    const matched = AtomMachine.matches(parent, "Idle")
    const childSelected = AtomMachine.selectChild(child, "Idle")
    const childSelectedSnapshot = AtomMachine.selectSnapshotChild(child, "Idle")
    const childMatched = AtomMachine.matchesChild(child, "Idle")

    expect<typeof parent.result>().type.toBe<
      Atom.Atom<AsyncResult.AsyncResult<Snapshot, StartFailure | RuntimeFailure>>
    >()
    expect<typeof selected>().type.toBe<
      Atom.Atom<AsyncResult.AsyncResult<Option.Option<Idle>, StartFailure | RuntimeFailure>>
    >()
    expect<Atom.Success<typeof selectedSnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof States.states, "Idle">>
    >()
    expect<typeof matched>().type.toBe<
      Atom.Atom<AsyncResult.AsyncResult<boolean, StartFailure | RuntimeFailure>>
    >()
    expect<Atom.Success<typeof childSelected>>().type.toBe<Option.Option<Idle>>()
    expect<Atom.Success<typeof childSelectedSnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof States.states, "Idle">>
    >()
    expect<Atom.Success<typeof childMatched>>().type.toBe<boolean>()
    expect<Atom.Failure<typeof childSelected>>().type.toBe<Atom.Failure<typeof child.result>>()
    expect<Atom.Failure<typeof childSelectedSnapshot>>().type.toBe<Atom.Failure<typeof child.result>>()
    expect<Atom.Failure<typeof childMatched>>().type.toBe<Atom.Failure<typeof child.result>>()
    expect<Extract<Atom.Failure<typeof child.result>, StartFailure>>().type.toBe<StartFailure>()
    expect<AtomMachine.ChildMachineAtom<typeof Child>>().type.toBe<
      AtomMachine.ChildMachineAtom<typeof Child, unknown>
    >()
    expect(AtomMachine.select).type.not.toBeCallableWith(parent, "Missing")
    expect(AtomMachine.selectSnapshot).type.not.toBeCallableWith(parent, "Missing")
    expect(AtomMachine.matches).type.not.toBeCallableWith(parent, "Missing")
    expect(AtomMachine.selectChild).type.not.toBeCallableWith(child, "Missing")
    expect(AtomMachine.selectSnapshotChild).type.not.toBeCallableWith(child, "Missing")
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
    const regionSnapshot = AtomMachine.selectSnapshot(parent, "Ready.editor")
    const leaf = AtomMachine.select(parent, "Ready.editor.Editing")
    const leafSnapshot = AtomMachine.selectSnapshot(parent, "Ready.editor.Editing")
    const matched = AtomMachine.matches(parent, "Ready.network.Online")
    const path = null as unknown as "Dormant" | "Ready.editor.Editing"
    const selectedUnion = AtomMachine.select(parent, path)
    const widenedPath: string = "Ready"

    expect<Atom.Success<typeof root>>().type.toBe<Option.Option<Ready>>()
    expect<Atom.Success<typeof region>>().type.toBe<Option.Option<Editor>>()
    expect<Atom.Success<typeof regionSnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof NestedStates.states, "Ready.editor">>
    >()
    expect<Atom.Success<typeof leaf>>().type.toBe<Option.Option<Editing>>()
    expect<Atom.Success<typeof leafSnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof NestedStates.states, "Ready.editor.Editing">>
    >()
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
    const childSelectedSnapshot = AtomMachine.selectSnapshotChild(child, "Ready.editor.Saving")
    const childMatched = AtomMachine.matchesChild(child, "Ready.network.Offline")

    expect<Atom.Success<typeof childSelected>>().type.toBe<Option.Option<Saving>>()
    expect<Atom.Success<typeof childSelectedSnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof NestedStates.states, "Ready.editor.Saving">>
    >()
    expect<Atom.Success<typeof childMatched>>().type.toBe<boolean>()
    expect<Atom.Failure<typeof childSelected>>().type.toBe<Atom.Failure<typeof child.result>>()
    expect<Atom.Failure<typeof childMatched>>().type.toBe<Atom.Failure<typeof child.result>>()
    expect(AtomMachine.selectChild).type.not.toBeCallableWith(child, "Idle")
    expect(AtomMachine.matchesChild).type.not.toBeCallableWith(child, "Ready.editor.Missing")
  })

  it("selects values only from schema-backed paths while structural paths remain queryable", () => {
    type Snapshot = Machine.Machine.Snapshot<typeof StructuralNestedStates.states>
    type Parent = AtomMachine.MachineAtom<Snapshot, Tick, RuntimeFailure, never, StartFailure>
    const parent = null as unknown as Parent

    const readySnapshot = AtomMachine.selectSnapshot(parent, "Ready")
    const editorSnapshot = AtomMachine.selectSnapshot(parent, "Ready.editor")
    const matched = AtomMachine.matches(parent, "Ready.editor.Idle")
    const saving = AtomMachine.select(parent, "Ready.editor.Saving")

    expect<Atom.Success<typeof readySnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof StructuralNestedStates.states, "Ready">>
    >()
    expect<Atom.Success<typeof editorSnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof StructuralNestedStates.states, "Ready.editor">>
    >()
    expect<Atom.Success<typeof matched>>().type.toBe<boolean>()
    expect<Atom.Success<typeof saving>>().type.toBe<Option.Option<Saving>>()
    expect(AtomMachine.select).type.not.toBeCallableWith(parent, "Ready")
    expect(AtomMachine.select).type.not.toBeCallableWith(parent, "Ready.editor")
    expect(AtomMachine.select).type.not.toBeCallableWith(parent, "Ready.editor.Idle")
    expect(AtomMachine.select).type.not.toBeCallableWith(parent, "Ready.network")
  })

  it("accepts machines without external requirements", () => {
    expect(AtomMachine.make).type.toBeCallableWith(makeMachine())
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

  it("only exposes public input events through atom send boundaries", () => {
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(Tick),
      internalEvents: Machine.internalEvents(InternalTick),
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

    expect<typeof bridge.send extends Atom.Writable<any, infer Event> ? Event : never>().type.toBe<
      Machine.Machine.EventInput<Tick>
    >()
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
      events: Machine.events(Tick),
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
})
