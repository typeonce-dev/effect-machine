import { Context, Effect, Layer, type Option, Schema, Stream } from "effect"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../../src/index.js"
import { AtomMachine } from "../../../src/unstable/reactivity/index.js"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}

class Tick extends Schema.TaggedClass<Tick>("Tick")("Tick", {}) {}

class InternalTick extends Schema.TaggedClass<InternalTick>("InternalTick")("InternalTick", {}) {}

class Published extends Schema.TaggedClass<Published>("Published")("Published", {}) {}

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

const States = Machine.states({ Idle })
const Emissions = Machine.emittedEvents(Published)

const NestedStates = Machine.states({
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

const StructuralNestedStates = Machine.states({
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
    initial: (to) => to.Idle().resolve(({ target }) => (target.decoded(new Idle({}))))
  }).handle({
    Idle: {}
  })

const makeEmittingMachine = () =>
  Machine.make({
    states: States.states,
    events: Machine.events(Tick),
    emittedEvents: Emissions,
    initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new Idle({})))
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
      initial: (to) => to.Idle().resolve(({ target }) => (target.decoded(new Idle({}))))
    }).handle({
      Idle: {
        invoke: (from) => from.child(Child)
      }
    })
    const child = AtomMachine.make(parentMachine).child(Child)

    expect<Atom.Success<typeof child.ref>>().type.toBe<Option.Option<Machine.ChildMachine.Ref<typeof Child>>>()
    expect<typeof child.send extends Atom.Writable<any, infer Event> ? Event : never>().type.toBe<
      Machine.Machine.EventInput<Tick>
    >()
  })

  it("preserves emitted protocols across root and child selectors", () => {
    const machine = makeEmittingMachine()
    const direct = AtomMachine.make(machine)
    const bound = AtomMachine.bind(Atom.runtime(Layer.empty)).make(machine)
    const directSelected = AtomMachine.select(direct, "Idle")
    const directSnapshot = AtomMachine.selectSnapshot(direct, "Idle")
    const directMatched = AtomMachine.matches(direct, "Idle")
    const boundSelected = AtomMachine.select(bound, "Idle")
    const boundSnapshot = AtomMachine.selectSnapshot(bound, "Idle")
    const boundMatched = AtomMachine.matches(bound, "Idle")

    expect<Atom.Success<typeof directSelected>>().type.toBe<Option.Option<Idle>>()
    expect<Atom.Success<typeof directSnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof States.states, "Idle">>
    >()
    expect<Atom.Success<typeof directMatched>>().type.toBe<boolean>()
    expect<Atom.Success<typeof boundSelected>>().type.toBe<Option.Option<Idle>>()
    expect<Atom.Success<typeof boundSnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof States.states, "Idle">>
    >()
    expect<Atom.Success<typeof boundMatched>>().type.toBe<boolean>()
    expect(AtomMachine.select).type.not.toBeCallableWith(direct, "Missing")
    expect(AtomMachine.selectSnapshot).type.not.toBeCallableWith(direct, "Missing")
    expect(AtomMachine.matches).type.not.toBeCallableWith(direct, "Missing")

    const Child = Machine.child("emitting-child", machine)
    const parentMachine = Machine.make({
      states: States.states,
      events: Machine.events(),
      emittedEvents: Emissions,
      initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new Idle({})))
    }).handle({
      Idle: {
        invoke: (from) => from.child(Child)
      }
    })
    const parent = AtomMachine.make(parentMachine)
    const child = parent.child(Child)
    const derivedChild = null as unknown as AtomMachine.ChildOf<typeof parent, typeof Child>
    const childSelected = AtomMachine.selectChild(child, "Idle")
    const childSnapshot = AtomMachine.selectSnapshotChild(child, "Idle")
    const childMatched = AtomMachine.matchesChild(child, "Idle")
    const childEmissions = AtomMachine.childEmissions(child)

    expect<typeof derivedChild>().type.toBe<typeof child>()
    expect<Atom.Success<typeof childSelected>>().type.toBe<Option.Option<Idle>>()
    expect<Atom.Success<typeof childSnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof States.states, "Idle">>
    >()
    expect<Atom.Success<typeof childMatched>>().type.toBe<boolean>()
    expect<Stream.Success<typeof childEmissions>>().type.toBe<Published>()
    expect(AtomMachine.selectChild).type.not.toBeCallableWith(child, "Missing")
    expect(AtomMachine.selectSnapshotChild).type.not.toBeCallableWith(child, "Missing")
    expect(AtomMachine.matchesChild).type.not.toBeCallableWith(child, "Missing")
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
    const boundLeafPath = NestedStates.path("Ready.editor.Editing")
    const boundLeaf = AtomMachine.select(parent, boundLeafPath)
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
    expect<Atom.Success<typeof boundLeaf>>().type.toBe<Option.Option<Editing>>()
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

  it("supports data-last root and child selectors", () => {
    type Snapshot = Machine.Machine.Snapshot<typeof NestedStates.states>
    type Parent = AtomMachine.MachineAtom<Snapshot, Tick, RuntimeFailure, never, StartFailure>
    const parent = null as unknown as Parent
    const selected = AtomMachine.select("Ready.editor.Editing")(parent)
    const selectedSnapshot = AtomMachine.selectSnapshot("Ready.editor")(parent)
    const matched = AtomMachine.matches("Ready.network.Online")(parent)
    const invalid = AtomMachine.select("Ready.editor.Missing")

    const Child = Machine.child(
      "nested",
      null as unknown as Machine.Machine<typeof NestedStates.states, readonly [typeof Tick]>
    )
    const child = null as unknown as AtomMachine.ChildOf<Parent, typeof Child>
    const childSelected = AtomMachine.selectChild("Ready.editor.Saving")(child)
    const childSelectedSnapshot = AtomMachine.selectSnapshotChild("Ready.editor")(child)
    const childMatched = AtomMachine.matchesChild("Ready.network.Offline")(child)
    const invalidChild = AtomMachine.matchesChild("Ready.network.Missing")

    expect<Atom.Success<typeof selected>>().type.toBe<Option.Option<Editing>>()
    expect<Atom.Success<typeof selectedSnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof NestedStates.states, "Ready.editor">>
    >()
    expect<Atom.Success<typeof matched>>().type.toBe<boolean>()
    expect(invalid).type.not.toBeCallableWith(parent)
    expect<Atom.Success<typeof childSelected>>().type.toBe<Option.Option<Saving>>()
    expect<Atom.Success<typeof childSelectedSnapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof NestedStates.states, "Ready.editor">>
    >()
    expect<Atom.Success<typeof childMatched>>().type.toBe<boolean>()
    expect(invalidChild).type.not.toBeCallableWith(child)
  })

  it("infers keyed root family inputs and exact projected atoms", () => {
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(Tick),
      input: Schema.String,
      initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new Idle({})))
    }).handle({
      Idle: {}
    })
    const atoms = AtomMachine.family(machine, {
      atoms: {
        selected: AtomMachine.select("Idle"),
        snapshot: AtomMachine.selectSnapshot("Idle"),
        matched: AtomMachine.matches("Idle"),
        state: (machine) => machine.state,
        send: (machine) => machine.send
      }
    })

    const selected = atoms.selected("one")
    const snapshot = atoms.snapshot("one")
    const matched = atoms.matched("one")
    const state = atoms.state("one")
    const send = atoms.send("one")

    expect<Atom.Success<typeof selected>>().type.toBe<Option.Option<Idle>>()
    expect<Atom.Success<typeof snapshot>>().type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof States.states, "Idle">>
    >()
    expect<Atom.Success<typeof matched>>().type.toBe<boolean>()
    expect<Atom.Success<typeof state>>().type.toBe<Machine.Machine.Snapshot<typeof States.states>>()
    expect<typeof send extends Atom.Writable<any, infer Event> ? Event : never>().type.toBe<
      Machine.Machine.EventInput<Tick>
    >()
    expect(atoms.selected).type.not.toBeCallableWith(1)
    expect(AtomMachine.family).type.not.toBeCallableWith(makeMachine(), {
      atoms: {
        state: (machine: AtomMachine.MachineAtom<any, any, any, any, any, any>) => machine.state
      }
    })
  })

  it("preserves bound runtime errors and child protocols through families", () => {
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(Tick),
      input: Schema.String,
      initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new Idle({})))
    }).handle({
      Idle: {
        invoke: (from) => from.effect("read-multiplier", () => Effect.as(Multiplier, undefined)).onDone((to) => to.none)
      }
    })
    const runtime = Atom.runtime(
      Layer.merge(
        Layer.succeed(Multiplier, 2),
        Layer.effectDiscard(Effect.fail({ _tag: "StartFailure" } as const satisfies StartFailure))
      )
    )
    const atoms = AtomMachine.bind(runtime).family(machine, {
      atoms: {
        result: (machine) => machine.result,
        send: (machine) => machine.send
      }
    })
    const makeBoundMachine = AtomMachine.bind(runtime).factory(machine)
    const boundMachine = makeBoundMachine("one")
    type FamilyFailure = Atom.Failure<ReturnType<typeof atoms.result>>
    type FactoryFailure = Atom.Failure<typeof boundMachine.result>

    const childMachine = makeMachine()
    const Child = Machine.childFamily(childMachine)
    const parent = AtomMachine.make(
      Machine.make({
        states: States.states,
        events: Machine.events(),
        initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new Idle({})))
      }).handle({ Idle: {} })
    )
    const children = AtomMachine.familyChild(parent, {
      child: (id: string) => Child(id),
      atoms: {
        selected: AtomMachine.selectChild("Idle"),
        matched: AtomMachine.matchesChild("Idle"),
        send: (child) => child.send
      }
    })

    expect<Extract<FamilyFailure, StartFailure>>().type.toBe<StartFailure>()
    expect<Extract<FactoryFailure, StartFailure>>().type.toBe<StartFailure>()
    expect(AtomMachine.factory).type.not.toBeCallableWith(machine)
    expect<unknown extends FamilyFailure ? true : false>().type.toBe<false>()
    expect(AtomMachine.family).type.not.toBeCallableWith(machine, {
      atoms: { state: (machine: AtomMachine.MachineAtom<any, any, any, any, any, any>) => machine.state }
    })
    expect<Atom.Success<ReturnType<typeof children.selected>>>().type.toBe<Option.Option<Idle>>()
    expect<Atom.Success<ReturnType<typeof children.matched>>>().type.toBe<boolean>()
    expect<ReturnType<typeof children.send> extends Atom.Writable<any, infer Event> ? Event : never>().type.toBe<
      Machine.Machine.EventInput<Tick>
    >()
    expect(children.selected).type.not.toBeCallableWith(1)
  })

  it("accepts machines without external requirements", () => {
    expect(AtomMachine.make).type.toBeCallableWith(makeMachine())
  })

  it("specializes machine definitions into inferred bridge constructors", () => {
    const makeBridge = AtomMachine.factory(makeMachine())
    const bridge = makeBridge()
    type Bridge = ReturnType<typeof makeBridge>

    expect(makeBridge).type.toBeCallableWith()
    expect(makeBridge).type.not.toBeCallableWith("input")
    expect<typeof bridge>().type.toBe<Bridge>()
    expect<Atom.Success<typeof bridge.state>>().type.toBe<Machine.Machine.Snapshot<typeof States.states>>()

    const inputMachine = Machine.make({
      states: States.states,
      events: Machine.events(Tick),
      input: Schema.String,
      initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new Idle({})))
    }).handle({ Idle: {} })
    const makeInputBridge = AtomMachine.factory(inputMachine)
    expect(makeInputBridge).type.toBeCallableWith("input")
    expect(makeInputBridge).type.not.toBeCallableWith()
    expect(makeInputBridge).type.not.toBeCallableWith(1)

    const runtime = Atom.runtime(
      Layer.effectDiscard(Effect.fail({ _tag: "StartFailure" } as const satisfies StartFailure))
    )
    const makeBoundBridge = AtomMachine.bind(runtime).factory(makeMachine())
    const boundBridge = makeBoundBridge()
    type BoundFailure = Atom.Failure<ReturnType<typeof makeBoundBridge>["result"]>

    expect<Extract<BoundFailure, StartFailure>>().type.toBe<StartFailure>()
    expect<unknown extends BoundFailure ? true : false>().type.toBe<false>()
    expect<typeof boundBridge>().type.toBe<ReturnType<typeof makeBoundBridge>>()
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
      initial: (to) => to.Idle().resolve(({ target }) => (target.decoded(new Idle({}))))
    }).handle({
      Idle: {
        on: {
          Tick: (to) => to.full.Idle().resolve(({ target }) => target.decoded(new Idle({}))),
          InternalTick: (to) => to.full.Idle().resolve(({ target }) => target.decoded(new Idle({})))
        }
      }
    })
    const bridge = AtomMachine.make(machine)

    expect<typeof bridge.send extends Atom.Writable<any, infer Event> ? Event : never>().type.toBe<
      Machine.Machine.EventInput<Tick>
    >()
  })

  it("requires output implementations and preserves exact terminal output", () => {
    const OutputStates = Machine.states({
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
      initial: (to) => to.Idle().resolve(({ target }) => (target.decoded(new Idle({}))))
    })
    const runtime = Atom.runtime(Layer.empty)
    const bound = AtomMachine.bind(runtime)

    expect(AtomMachine.make).type.not.toBeCallableWith(incomplete)
    expect(AtomMachine.factory).type.not.toBeCallableWith(incomplete)
    expect(AtomMachine.make).type.not.toBeCallableWith(runtime, incomplete)
    expect(bound.make).type.not.toBeCallableWith(incomplete)
    expect(bound.factory).type.not.toBeCallableWith(incomplete)

    const complete = incomplete.handle({
      Done: {
        output: ({ state }) => state.value
      }
    })
    const bridge = AtomMachine.make(complete)
    type Output = typeof bridge extends AtomMachine.MachineAtom<any, any, any, infer Output, any> ? Output : never

    expect<Output>().type.toBe<string>()
    expect(AtomMachine.make).type.toBeCallableWith(complete)
    expect(AtomMachine.factory).type.toBeCallableWith(complete)
    expect(AtomMachine.make).type.not.toBeCallableWith(runtime, complete)
    expect(bound.make).type.toBeCallableWith(complete)
    expect(bound.factory).type.toBeCallableWith(complete)
  })
})
