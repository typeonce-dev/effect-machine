import type { Context, Effect, Schema, Scope, Stream } from "effect"
import { describe, expect, it } from "tstyche"
import { LocalMachine, Machine } from "../../src/index.js"

declare const service: unique symbol
interface Database {
  readonly [service]: "Database"
}
declare const load: Effect.Effect<number, "LoadFailed", Database>
declare const Input: Schema.Codec<{ readonly seed: number }, { readonly seed: number }>

const Events = Machine.events({ Load: {} })
const States = Machine.state({ states: { Idle: {}, Loading: {}, Done: { type: "final" } } })
const definition = Machine.make({ root: States, events: Events, input: Input, effects: { load } })
const machine = definition.handle({
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Load: { target: "Loading" } } },
    Loading: { invoke: { src: "load", onDone: { target: "Done" }, onFailure: { target: "Idle" } } }
  }
})

type State = Machine.Machine.Snapshot<Machine.Machine.States<typeof machine>>
type Event = Machine.Machine.EventInput<Machine.Machine.InputEvent<typeof machine>>
type RuntimeError =
  | Machine.InfiniteTransitionError
  | Machine.MachineSchemaDecodeError
  | Machine.StoppedError
type StartError = RuntimeError | Machine.StartupError
type Output = Machine.Machine.Output<typeof machine>
type Ref = Machine.MachineRef<State, Event, RuntimeError, Output>

describe("LocalMachine", () => {
  it("owns running a machine, which the model does not expose", () => {
    expect<keyof typeof Machine>().type.not.toBeAssignableFrom<"start">()
    expect<keyof typeof Machine>().type.not.toBeAssignableFrom<"prepare">()
    expect<keyof typeof Machine>().type.not.toBeAssignableFrom<"resume">()
    expect<keyof typeof LocalMachine>().type.toBe<"start" | "prepare" | "resume">()
  })

  it("infers the reference, failures, and services of a started machine", () => {
    expect(LocalMachine.start(machine, { seed: 1 })).type.toBe<
      Effect.Effect<Ref, StartError, Scope.Scope | Database>
    >()
    expect(LocalMachine.start).type.not.toBeCallableWith(machine)
    expect(LocalMachine.start).type.not.toBeCallableWith(machine, { seed: "1" })
    expect(LocalMachine.start).type.not.toBeCallableWith(definition, { seed: 1 })
  })

  it("infers the prepared machine", () => {
    expect(LocalMachine.prepare(machine, { seed: 1 })).type.toBe<
      Effect.Effect<
        LocalMachine.Prepared<State, Event, RuntimeError, Output, never, StartError, Scope.Scope | Database>
      >
    >()
    const prepared = LocalMachine.prepare(machine, { seed: 1 })
    expect<Effect.Success<typeof prepared>["inspection"]>().type.toBe<Stream.Stream<LocalMachine.Inspection.Event>>()
    expect(LocalMachine.prepare).type.not.toBeCallableWith(machine)
  })

  it("infers the resumed machine", () => {
    const snapshot = null! as State
    expect(LocalMachine.resume(machine, snapshot)).type.toBe<
      Effect.Effect<Ref, Machine.MachineSchemaDecodeError, Scope.Scope | Database>
    >()
    expect(LocalMachine.resume).type.not.toBeCallableWith(machine)
    expect(LocalMachine.resume).type.not.toBeCallableWith(machine, { path: "missing" })
  })

  it("removes only the capabilities a local machine provides", () => {
    expect<LocalMachine.RequiredServices<Machine.MachineRuntime | Database>>().type.toBe<Database>()
    expect<
      LocalMachine.RequiredServices<Machine.InvocationSupport<Machine.InvocationSupport.Kind> | Database>
    >().type.toBe<Database>()
    expect<LocalMachine.RequiredServices<Machine.Machine.Services<typeof machine>>>().type.toBe<Database>()
  })
})

describe("MachineRuntime", () => {
  it("is not in the services of a machine whose work does not use it", () => {
    expect<Machine.Machine.Services<typeof machine>>().type.toBe<Database>()
    const idle = Machine.make({ root: Machine.state({ states: { Idle: {} } }), events: Machine.events({}) })
      .handle({ initial: { target: "Idle" } })
    expect<Machine.Machine.Services<typeof idle>>().type.toBe<never>()
  })

  it("declares exactly the operations of the functions that require it", () => {
    expect<keyof Context.Service.Shape<typeof Machine.MachineRuntime>>().type.toBe<"spawn" | "sendTo" | "stopChild">()
  })

  it("is required by spawn, sendTo, and stopChild", () => {
    const Address = Machine.childAddress<number>("child")
    const logic = null! as Machine.Logic<string, number, "Failed", Database | Scope.Scope, boolean, "NotStarted">
    expect(Machine.spawn(logic)).type.toBe<
      Effect.Effect<
        Machine.MachineRef<string, number, "Failed", boolean>,
        "NotStarted",
        Machine.MachineRuntime | Database
      >
    >()
    expect(Machine.spawn(logic, { id: Address })).type.toBe<
      Effect.Effect<
        Machine.MachineRef<string, number, "Failed", boolean>,
        Machine.ChildAlreadyExistsError | "NotStarted",
        Machine.MachineRuntime | Database
      >
    >()
    expect(Machine.sendTo(Address, 1)).type.toBe<Effect.Effect<void, Machine.StoppedError, Machine.MachineRuntime>>()
    expect(Machine.stopChild(Address)).type.toBe<Effect.Effect<void, never, Machine.MachineRuntime>>()
    expect(Machine.sendTo).type.not.toBeCallableWith(Address, "1")
  })
})

describe("child descriptors", () => {
  it("declare a brand, an id, and a machine only", () => {
    const Child = Machine.child("child", machine)
    expect<keyof typeof Child>().type.toBe<"~effect/Machine/ChildMachine" | "id" | "machine">()
    expect(Machine.childFamily(machine)("child")).type.toBe<typeof Child>()
  })
})
