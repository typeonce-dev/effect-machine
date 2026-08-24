import { Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

describe("Machine inspection", () => {
  class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
  class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
  class Running extends Schema.TaggedClass<Running>("Running")("Running", {}) {}
  class Reset extends Schema.TaggedClass<Reset>("Reset")("Reset", {}) {}

  const States = Machine.states({
    root: {
      schema: Root,
      initial: "idle",
      states: {
        idle: Idle,
        recent: { type: "history" }
      }
    }
  })
  const initial: Machine.Machine.Snapshot<typeof States.states> = {
    path: "root",
    value: new Root({}),
    state: { path: "root.idle", value: new Idle({}) }
  }
  const machine = Machine.make({
    states: States.states,
    events: Machine.events(Reset),
    initial: (to) =>
      to.root.initial.resolve(({ target }) => target.decoded(new Root({}), (root) => root.idle.decoded(new Idle({}))))
  }).handle({
    root: {
      on: {
        Reset: (to) => to.none
      }
    }
  })

  it("exposes one closed operational protocol from prepared machines", () => {
    const FlatStates = Machine.states({ Idle })
    const executable = Machine.make({
      states: FlatStates.states,
      events: Machine.events(Reset),
      initial: (to) => to.Idle().resolve(({ target }) => (target.decoded(new Idle({}))))
    }).handle({
      Idle: {
        on: {
          Reset: (to) => to.none
        }
      }
    })
    Effect.gen(function*() {
      const prepared = yield* Machine.prepare(executable)
      expect(prepared.inspection).type.toBe<Stream.Stream<Machine.Inspection.Event>>()
      const event = yield* prepared.inspection.pipe(Stream.runHead)
      if (event._tag === "Some") {
        switch (event.value._tag) {
          case "Created":
            expect(event.value.definition).type.toBe<Machine.Machine.Any | undefined>()
            break
          case "EventProcessed":
            expect(event.value.microsteps).type.toBe<ReadonlyArray<Machine.Inspection.Microstep>>()
            break
        }
      }
    })
  })

  it("preserves state paths for structural inspection", () => {
    expect(Machine.inputEventSchemas(machine)).type.toBe<readonly [typeof Reset]>()
    const nodes = Machine.stateNodes(machine)
    expect(nodes[0]!.path).type.toBe<"root" | "root.idle" | "root.recent">()
    expect(nodes.find((node) => node.type === "history")!.path).type.toBe<"root.recent">()
    expect(nodes.find((node) => node.type === "history")!.parent).type.toBe<"root" | "root.idle">()
    expect(nodes.find((node) => node.type === "atomic")!.path).type.toBe<"root" | "root.idle">()
    expect(Machine.configuration(machine, initial)[0]!.path).type.toBe<"root" | "root.idle">()
  })

  it("narrows every compiled state-node property from its type", () => {
    const inspect = (node: Machine.Machine.StateNode<"state">) => {
      switch (node.type) {
        case "atomic":
          expect(node.schema).type.toBe<Machine.Machine.TaggedSchema | undefined>()
          expect(node.output).type.toBe<undefined>()
          expect(node.history).type.toBe<undefined>()
          expect(node.children).type.toBe<readonly []>()
          expect(node.initial).type.toBe<undefined>()
          expect(node.parent).type.toBe<"state" | undefined>()
          break
        case "compound":
          expect(node.schema).type.toBe<Machine.Machine.TaggedSchema | undefined>()
          expect(node.output).type.toBe<undefined>()
          expect(node.history).type.toBe<undefined>()
          expect(node.children).type.toBe<ReadonlyArray<"state">>()
          expect(node.initial).type.toBe<"state">()
          expect(node.parent).type.toBe<"state" | undefined>()
          break
        case "parallel":
          expect(node.schema).type.toBe<Machine.Machine.TaggedSchema | undefined>()
          expect(node.output).type.toBe<Schema.Top | undefined>()
          expect(node.history).type.toBe<undefined>()
          expect(node.children).type.toBe<ReadonlyArray<"state">>()
          expect(node.initial).type.toBe<undefined>()
          expect(node.parent).type.toBe<"state" | undefined>()
          break
        case "final":
          expect(node.schema).type.toBe<Machine.Machine.TaggedSchema | undefined>()
          expect(node.output).type.toBe<Schema.Top | undefined>()
          expect(node.history).type.toBe<undefined>()
          expect(node.children).type.toBe<readonly []>()
          expect(node.initial).type.toBe<undefined>()
          expect(node.parent).type.toBe<"state" | undefined>()
          break
        case "history":
          expect(node.schema).type.toBe<undefined>()
          expect(node.output).type.toBe<undefined>()
          expect(node.history).type.toBe<"shallow" | "deep">()
          expect(node.children).type.toBe<readonly []>()
          expect(node.initial).type.toBe<undefined>()
          expect(node.parent).type.toBe<"state">()
          break
        case "choice":
          expect(node.schema).type.toBe<undefined>()
          expect(node.output).type.toBe<undefined>()
          expect(node.history).type.toBe<undefined>()
          expect(node.children).type.toBe<readonly []>()
          expect(node.initial).type.toBe<undefined>()
          expect(node.parent).type.toBe<"state">()
          break
        default:
          expect(node).type.toBe<never>()
      }
    }

    expect(inspect).type.toBe<(node: Machine.Machine.StateNode<"state">) => void>()
  })

  it("keeps choice initial paths while configuration remains active-only", () => {
    const ChoiceStates = Machine.states({
      Flow: {
        schema: Root,
        initial: "Routing",
        states: {
          Routing: { type: "choice" },
          Ready: Idle
        }
      }
    })
    const choiceMachine = Machine.make({
      states: ChoiceStates.states,
      events: Machine.events(),
      initial: (to) => to.Flow.initial.resolve(({ target }) => (target.decoded(new Root({}), (flow) => flow.Routing())))
    })
    const flow = Machine.stateNodes(choiceMachine).find((node) => node.type === "compound")!
    const routing = Machine.stateNodes(choiceMachine).find((node) => node.type === "choice")!

    expect(flow.path).type.toBe<"Flow" | "Flow.Ready">()
    expect(flow.initial).type.toBe<"Flow" | "Flow.Ready" | "Flow.Routing">()
    expect<"Flow.Routing">().type.toBeAssignableTo<typeof flow.initial>()
    expect(routing.path).type.toBe<"Flow.Routing">()
    expect(routing.parent).type.toBe<"Flow" | "Flow.Ready">()

    const settled: Machine.Machine.Snapshot<typeof ChoiceStates.states> = {
      path: "Flow",
      value: new Root({}),
      state: { path: "Flow.Ready", value: new Idle({}) }
    }
    const configuration = Machine.configuration(choiceMachine, settled)
    expect<(typeof configuration)[number]["path"]>().type.toBe<"Flow" | "Flow.Ready">()
    expect<(typeof configuration)[number]["type"]>().type.toBe<"atomic" | "compound" | "parallel" | "final">()
    expect<Extract<(typeof configuration)[number], { readonly type: "history" | "choice" }>>().type.toBe<never>()
  })

  it("preserves source paths and event tags for transition inspection", () => {
    const initialDefinition = Machine.initialDefinition(machine)
    expect(initialDefinition.target).type.toBe<"root">()
    expect(initialDefinition.selection.path).type.toBe<"root">()
    expect(initialDefinition.selection.kind).type.toBe<"state" | "initial">()
    expect(initialDefinition.selection.scope).type.toBe<"initial">()

    const definition = Machine.transitionDefinitions(machine)[0]!
    expect(definition.source).type.toBe<"root" | "root.idle" | "root.recent">()
    expect(definition.acceptance).type.toBe<Machine.Machine.TransitionAcceptance>()
    if (definition.trigger.type === "event") {
      expect(definition.trigger.event).type.toBe<"Reset">()
    }
    expect(definition.branches).type.toBe<
      ReadonlyArray<Machine.Machine.TransitionBranch<"root" | "root.idle" | "root.recent">>
    >()
    expect(definition.branches[0]!.selection.path).type.toBe<"root" | "root.idle" | "root.recent" | undefined>()
  })

  it("requires statically selected transitions", () => {
    const FlatStates = Machine.states({ idle: Idle, running: Running })
    const flat = Machine.make({
      states: FlatStates.states,
      events: Machine.events(Reset),
      initial: (to) => to.idle().resolve(({ target }) => (target.decoded(new Idle({}))))
    })
    flat.handle({
      idle: {
        on: {
          Reset: (to) => to.full.running().resolve(({ target }) => target.decoded(new Running({})))
        }
      }
    })

    expect(flat.handle).type.not.toBeCallableWith({ idle: { on: { Reset: () => undefined } } })
    expect(flat.handle).type.not.toBeCallableWith({
      idle: { on: { Reset: { target: () => undefined, resolve: () => undefined } } }
    })
  })
})
