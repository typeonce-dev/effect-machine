import { type Duration, Effect, type Exit, Schema, type Scope, Stream } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import type { Rebuilt } from "../support/rebuilt.js"

declare const service: unique symbol
interface Database {
  readonly [service]: "Database"
}

class LoadError extends Schema.TaggedClass<LoadError>()("LoadError", {}) {}

const Events = Machine.events({ Load: { id: Schema.String } })
const Emitted = Machine.emittedEvents({ Loaded: { id: Schema.String } })

const machine = Machine.make({
  root: Machine.state({
    states: {
      Idle: {},
      Loading: { fields: { id: Schema.String } },
      Done: { fields: { total: Schema.Number }, type: "final", output: Schema.Number }
    }
  }),
  events: Events,
  emittedEvents: Emitted,
  input: Schema.Struct({ owner: Schema.String }),
  effects: { load: (_: string) => null! as Effect.Effect<number, LoadError, Database> },
  streams: { ticks: Stream.make(1, 2) }
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id }) } } },
    Loading: {
      invoke: [
        {
          src: "load",
          input: ({ state }) => state.id,
          onDone: { target: "Done", data: ({ output }) => ({ total: output }) },
          onFailure: { target: "Idle" }
        },
        { src: "ticks", onElement: { stay: true }, onDone: { stay: true } }
      ]
    },
    Done: { output: ({ state }) => state.total }
  }
})

// `toStep` rebuilds the machine type from its parameters.
type M = Rebuilt<typeof machine>
const self = null! as Machine.MachineTarget<Machine.Machine.EventInputOf<Machine.Machine.InputEvents<M>>>
const step = Machine.toStep(machine, { self })

describe("Machine.toStep", () => {
  it("infers the input, the events, and the snapshot of the machine", () => {
    expect(step.start).type.toBeCallableWith({ owner: "ada" })
    expect(step.start).type.not.toBeCallableWith()
    expect(step.start({ owner: "ada" })).type.toBe<
      Exit.Exit<Machine.MachineStep.Step<M>, Machine.MachineStep.StartError>
    >()
    const state = null! as Machine.MachineStep.State<M>
    expect(step.send).type.toBeCallableWith(state, Events.Load({ id: "a" }))
    expect(step.send).type.toBeCallableWith(state, { _tag: "Load", id: "a" })
    expect(step.send).type.not.toBeCallableWith(state, { _tag: "Other" })
    expect(step.send(state, Events.Load({ id: "a" }))).type.toBe<
      Exit.Exit<Machine.MachineStep.Step<M>, Machine.MachineSchemaDecodeError | Machine.StoppedError>
    >()
    expect(step.resume).type.toBeCallableWith(null! as Machine.Snapshot<M>)
  })

  it("types what a step publishes, and how the machine ended", () => {
    type Step = Machine.MachineStep.Step<M>
    expect<Step["snapshot"]>().type.toBe<Machine.Snapshot<M>>()
    expect<Step["emitted"]>().type.toBe<ReadonlyArray<Machine.Machine.EmittedEvent<M>>>()
    expect<Step["exit"]>().type.toBe<Exit.Exit<number, Machine.MachineStep.Error<M>> | undefined>()
    // The failure of the work is handled, so the machine adds no error of its own.
    expect<Machine.MachineStep.Error<M>>().type.toBe<
      Machine.InfiniteTransitionError | Machine.MachineSchemaDecodeError | Machine.StoppedError
    >()
  })

  it("types the work by its kind, with the services it requires", () => {
    type Work = Machine.MachineStep.Work<M>
    // Work is evaluated by its host, and a failure to evaluate it is a defect.
    expect<Extract<Work, { readonly _tag: "Effect" }>["effect"]>().type.toBe<
      () => Exit.Exit<Effect.Effect<unknown, unknown, Database>>
    >()
    expect<Extract<Work, { readonly _tag: "Stream" }>["stream"]>().type.toBe<
      () => Exit.Exit<Stream.Stream<unknown, unknown, Database>>
    >()
    expect<Extract<Work, { readonly _tag: "Timer" }>["duration"]>().type.toBe<
      () => Exit.Exit<Duration.Duration>
    >()
    expect<Extract<Work, { readonly _tag: "Timer" }>["effect"]>().type.toBe<
      () => Exit.Exit<Effect.Effect<void, unknown>>
    >()
    expect<Work["path"]>().type.toBe<"" | "Idle" | "Loading" | "Done">()
    expect<Work["_tag"]>().type.toBe<"Effect" | "Timer" | "Stream" | "Logic" | "Child">()
  })

  it("types the work of process logic and of child machines, with the services of the host", () => {
    type Logic = Machine.MachineStep.Work.Logic<M>
    expect<Logic["address"]>().type.toBe<Machine.ChildAddress<never>>()
    expect<Logic["logic"]>().type.toBe<
      () => Exit.Exit<Machine.Logic<unknown, unknown, unknown, Database | Scope.Scope, unknown, unknown>>
    >()
    type Child = Machine.MachineStep.Work.Child<M>
    expect<Child["child"]>().type.toBe<Machine.ChildMachine.Any>()
    expect<Child["input"]>().type.toBe<() => Exit.Exit<ReadonlyArray<unknown>>>()
    expect(step.report).type.not.toBeCallableWith(
      null! as Machine.MachineStep.State<M>,
      null! as Machine.MachineStep.Work.Effect<M>,
      1
    )
    expect(step.element).type.not.toBeCallableWith(
      null! as Machine.MachineStep.State<M>,
      null! as Machine.MachineStep.Work.Logic<M>,
      1
    )
  })

  it("types the commands, the microsteps, and the progress of a resume", () => {
    type Step = Machine.MachineStep.Step<M>
    expect<Step["commands"][number]["_tag"]>().type.toBe<"Send" | "SendToChild" | "StopChild">()
    expect<Extract<Step["commands"][number], { readonly _tag: "StopChild" }>["work"]>().type.toBe<
      Machine.MachineStep.Work.Logic<M> | Machine.MachineStep.Work.Child<M> | undefined
    >()
    expect<Step["microsteps"][number]["next"]>().type.toBe<Machine.Snapshot<M>>()
    expect<Step["event"]>().type.toBe<
      Machine.Machine.LifecycleEvent<Machine.Machine.Events<M>> | undefined
    >()
    expect(step.resume).type.toBeCallableWith(null! as Machine.Snapshot<M>, [
      { path: "Loading", id: "load", status: "Running" }
    ])
    expect(step.resume).type.not.toBeCallableWith(null! as Machine.Snapshot<M>, [
      { path: "Missing", id: "load", status: "Running" }
    ])
    expect(step.resume).type.not.toBeCallableWith(null! as Machine.Snapshot<M>, [
      { path: "Loading", id: "load", status: "Waiting" }
    ])
  })

  it("keeps the state of one machine apart from the state of another", () => {
    const other = Machine.make({ root: Machine.state({ states: { Idle: {} } }), events: Events }).handle({
      initial: { target: "Idle" }
    })
    expect<Machine.MachineStep.State<typeof other>>().type.not.toBeAssignableTo<Machine.MachineStep.State<M>>()
    expect(step.settle).type.not.toBeCallableWith(
      null! as Machine.MachineStep.State<typeof other>,
      null! as Machine.MachineStep.Work<M>,
      null! as Exit.Exit<unknown>
    )
  })

  it("requires the target of the machine itself", () => {
    expect(Machine.toStep).type.not.toBeCallableWith(machine)
    expect(Machine.toStep).type.not.toBeCallableWith(machine, {
      self: null! as Machine.MachineTarget<{ readonly _tag: "Other" }>
    })
    expect(Effect.succeed(step)).type.toBe<Effect.Effect<Machine.MachineStep<M>>>()
  })

  describe("parent", () => {
    const Reports = Machine.events({ Reported: { count: Schema.Number } })
    const required = Machine.make({
      root: Machine.state({ states: { Idle: {} } }),
      events: Events,
      parent: Machine.parent(Reports)
    }).handle({ initial: { target: "Idle" } })
    const optional = Machine.make({
      root: Machine.state({ states: { Idle: {} } }),
      events: Events,
      parent: Machine.optionalParent(Reports)
    }).handle({ initial: { target: "Idle" } })
    // A target that takes every event, as the target of a host that routes them.
    const parent = null! as Machine.MachineTarget<unknown>
    const childSelf = null! as Machine.MachineTarget<
      Machine.Machine.EventInputOf<Machine.Machine.InputEvents<Rebuilt<typeof required>>>
    >

    it("requires the parent of a machine that requires one, and takes it as an option otherwise", () => {
      expect(Machine.toStep).type.toBeCallableWith(required, { self: childSelf, parent })
      expect(Machine.toStep).type.not.toBeCallableWith(required, { self: childSelf })
      expect(Machine.toStep).type.toBeCallableWith(optional, { self: childSelf, parent })
      expect(Machine.toStep).type.toBeCallableWith(optional, { self: childSelf })
      expect(Machine.toStep).type.not.toBeCallableWith(machine, { self, parent })
    })

    it("requires a parent that takes the events of its protocol", () => {
      expect(Machine.toStep).type.not.toBeCallableWith(required, {
        self: childSelf,
        parent: null! as Machine.MachineTarget<{ readonly _tag: "Other" }>
      })
    })
  })
})
