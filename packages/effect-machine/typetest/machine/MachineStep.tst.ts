import { type Duration, Effect, type Exit, Schema, Stream } from "effect"
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
    expect<Extract<Work, { readonly _tag: "Effect" }>["effect"]>().type.toBe<
      Effect.Effect<unknown, unknown, Database>
    >()
    expect<Extract<Work, { readonly _tag: "Stream" }>["stream"]>().type.toBe<
      Stream.Stream<unknown, unknown, Database>
    >()
    expect<Extract<Work, { readonly _tag: "Timer" }>["duration"]>().type.toBe<Duration.Duration>()
    expect<Work["path"]>().type.toBe<"" | "Idle" | "Loading" | "Done">()
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
})
